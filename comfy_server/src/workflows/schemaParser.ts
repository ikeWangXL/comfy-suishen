import type {
  AiExpansionMode,
  ApiWorkflow,
  ApiWorkflowNode,
  EnumOption,
  GenerationMode,
  InspectionIssue,
  ParameterConstraints,
  ParameterRole,
  ParameterType,
  ParsedLora,
  ParsedParameter,
  WorkflowAnalysis,
  WorkflowReadonlyInfo
} from './profileStore.js';
import { computeWorkflowIdentity, parseNodeId } from './profileStore.js';

// ---------- object_info 规格归一化 ----------

export type InputKind =
  | 'COMBO' | 'INT' | 'FLOAT' | 'STRING' | 'BOOLEAN'
  | 'IMAGE' | 'MODEL' | 'CLIP' | 'VAE' | 'CONDITIONING' | 'LATENT' | 'MASK' | 'AUDIO' | 'VIDEO'
  | 'OTHER';

export interface ObjectInfoInputSpec {
  name: string;
  kind: InputKind;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  /** 原始类型名（COMFY_*_V3 等动态类型保留原样，供预检判定扁平子键/autogrow 语义）。 */
  rawKind?: string;
  /** COMFY_AUTOGROW_V3 的 template.min：0 表示零个子输入也合法。 */
  autogrowMin?: number;
}

export interface ObjectInfoNodeSpec {
  classType: string;
  required: ObjectInfoInputSpec[];
  optional: ObjectInfoInputSpec[];
  outputNode: boolean;
  outputs: string[];
}

const LINK_KINDS: ReadonlySet<string> = new Set([
  'IMAGE', 'MODEL', 'CLIP', 'VAE', 'CONDITIONING', 'LATENT', 'MASK', 'AUDIO', 'VIDEO'
]);

/** object_info（legacy 与 io.Schema 桥接同形）→ Map<classType, spec>。 */
export function normalizeObjectInfo(raw: Record<string, unknown>): Map<string, ObjectInfoNodeSpec> {
  const specs = new Map<string, ObjectInfoNodeSpec>();
  for (const [classType, entryValue] of Object.entries(raw)) {
    const entry = (entryValue ?? {}) as Record<string, unknown>;
    const inputGroups = (entry.input ?? entry.inputs ?? {}) as Record<string, unknown>;
    specs.set(classType, {
      classType,
      required: normalizeInputGroup(inputGroups.required),
      optional: normalizeInputGroup(inputGroups.optional),
      outputNode: entry.output_node === true,
      outputs: Array.isArray(entry.output) ? entry.output.map(String) : []
    });
  }
  return specs;
}

function normalizeInputGroup(group: unknown): ObjectInfoInputSpec[] {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return [];
  return Object.entries(group as Record<string, unknown>).map(([name, rawSpec]) => normalizeInputSpec(name, rawSpec));
}

function normalizeInputSpec(name: string, rawSpec: unknown): ObjectInfoInputSpec {
  let type: unknown = rawSpec;
  let config: Record<string, unknown> = {};
  if (Array.isArray(rawSpec)) {
    type = rawSpec[0];
    const second = rawSpec[1];
    if (second !== null && typeof second === 'object' && !Array.isArray(second)) {
      config = second as Record<string, unknown>;
    }
  }
  if (Array.isArray(type)) {
    return { name, kind: 'COMBO', options: type.map(String), default: pickDefault(config) };
  }
  const kindName = typeof type === 'string' ? type.toUpperCase() : '';
  if (kindName === 'COMBO') {
    const options = Array.isArray(config.options) ? config.options.map(String) : undefined;
    return { name, kind: 'COMBO', options, default: pickDefault(config) };
  }
  if (kindName === 'INT' || kindName === 'FLOAT') {
    const spec: ObjectInfoInputSpec = { name, kind: kindName, default: pickDefault(config) };
    if (typeof config.min === 'number') spec.min = config.min;
    if (typeof config.max === 'number') spec.max = config.max;
    if (typeof config.step === 'number') spec.step = config.step;
    return spec;
  }
  if (kindName === 'STRING' || kindName === 'BOOLEAN') {
    return { name, kind: kindName, default: pickDefault(config) };
  }
  if (LINK_KINDS.has(kindName)) {
    return { name, kind: kindName as InputKind };
  }
  if (kindName.startsWith('COMFY_')) {
    const spec: ObjectInfoInputSpec = { name, kind: 'OTHER', rawKind: kindName };
    const template = config.template;
    const templateRecord = template !== null && typeof template === 'object' ? template as Record<string, unknown> : null;
    const minCandidate = typeof config.min === 'number' ? config.min
      : templateRecord && typeof templateRecord.min === 'number' ? templateRecord.min
      : undefined;
    if (minCandidate !== undefined) spec.autogrowMin = minCandidate;
    return spec;
  }
  return { name, kind: 'OTHER' };
}

function pickDefault(config: Record<string, unknown>): unknown {
  return 'default' in config ? config.default : undefined;
}

// ---------- 解析 ----------

const MARK_PATTERN = /\[params\{([a-zA-Z]+)\}-([^\]]+)\]/g;
const MARK_TYPES: ReadonlySet<string> = new Set(['string', 'int', 'float', 'boolean', 'enum', 'unknown', 'model', 'clip', 'vae']);
/** ComfyUI 标准比例 8 项短标签（API §2/§12）。 */
export const ASPECT_SHORT_LABELS = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'] as const;
const LORA_CLASS_TYPES: ReadonlySet<string> = new Set(['LoraLoader', 'LoraLoaderModelOnly']);
const QUICK_ROLES: ReadonlyArray<{ role: ParameterRole; label: string }> = [
  { role: 'prompt', label: '提示词' },
  { role: 'aspectRatio', label: '比例' },
  { role: 'megapixels', label: '像素/分辨率' }
];

interface MarkedNode {
  nodeId: string;
  node: ApiWorkflowNode;
  markType: string;
  name: string;
}

interface BoundInput {
  nodeId: number | string;
  rawNodeId: string;
  inputName: string;
  node: ApiWorkflowNode;
  spec: ObjectInfoNodeSpec;
}

/** 解析 API prompt JSON → 统一参数 schema + LoRA + 支持模式候选 + 问题清单（§4.1，普通/专业一套解析）。 */
export function parseWorkflow(workflow: ApiWorkflow, specs: Map<string, ObjectInfoNodeSpec>): WorkflowAnalysis {
  const issues: InspectionIssue[] = [];
  const identity = computeWorkflowIdentity(workflow);
  const marks = collectMarks(workflow, issues);

  const parameters: ParsedParameter[] = [];
  const boundKeys = new Map<string, string>();
  for (const mark of marks) {
    const spec = specs.get(mark.node.class_type);
    if (!spec) {
      issues.push({
        nodeId: parseNodeId(mark.nodeId),
        severity: 'error',
        message: `节点 ${mark.nodeId}（${mark.node.class_type}）在 ComfyUI schema 中不存在，参数 ${mark.name} 无法绑定`
      });
      continue;
    }
    const bound = bindMarkedInput(workflow, specs, mark, spec, issues);
    if (!bound) continue;
    const bindingKey = `${String(bound.nodeId)}|${bound.inputName}`;
    const previous = boundKeys.get(bindingKey);
    if (previous !== undefined) {
      issues.push({
        nodeId: bound.nodeId,
        severity: 'error',
        message: `绑定重复：节点 ${bound.nodeId} 的输入 ${bound.inputName} 同时被参数 ${previous} 与 ${mark.name} 供值；被标记节点供值的消费节点同名控件不生成（Q2）`
      });
      continue;
    }
    boundKeys.set(bindingKey, mark.name);
    buildParameter(mark, bound, parameters, issues);
  }

  const loras = scanLoras(workflow);
  const readonlyInfo = collectReadonlyInfo(workflow, issues);
  const suggestedModes = deriveSupportedModes(parameters, issues);
  const imageOutputAvailable = specs.has('PreviewImage') && imageOutputNodeIds(workflow, specs).length > 0;
  if (!imageOutputAvailable) {
    issues.push({ nodeId: null, severity: 'error', message: IMAGE_OUTPUT_REQUIRED });
    suggestedModes.length = 0;
  }
  const aiExpansionModes = deriveAiExpansionModes(parameters);

  return {
    revision: identity.revision,
    fingerprint: identity.fingerprint,
    imageOutputAvailable,
    parameters,
    loras,
    aiExpansionModes,
    suggestedModes,
    issues,
    readonlyInfo
  };
}

export const IMAGE_OUTPUT_REQUIRED = '工作流不可用于生成：请添加并连接保存图像（SaveImage）或预览图像（PreviewImage）。';

export function imageOutputNodeIds(workflow: ApiWorkflow, specs?: Map<string, ObjectInfoNodeSpec>): string[] {
  return Object.entries(workflow).filter(([, node]) => {
    const images = node.inputs.images;
    if ((node.class_type !== 'SaveImage' && node.class_type !== 'PreviewImage') ||
      !Array.isArray(images) || typeof images[0] !== 'string' || !Number.isInteger(images[1]) || images[1] < 0) return false;
    const source = workflow[images[0]];
    if (!source || (specs && !specs.has(source.class_type))) return false;
    const types = specs?.get(source.class_type)?.outputs;
    return !types?.length || types[images[1]] === 'IMAGE' || types[images[1]] === '*';
  }).map(([id]) => id);
}

/** Primitive 数值可直接从图读取，不执行计算型节点。 */
export function resolvePrimitiveNumber(workflow: ApiWorkflow, value: unknown): number | undefined {
  if (Array.isArray(value) && typeof value[0] === 'string' && value[1] === 0) {
    const source = workflow[value[0]];
    value = source && (source.class_type === 'PrimitiveInt' || source.class_type === 'PrimitiveFloat')
      ? source.inputs.value : undefined;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function withCurrentModelOptions(
  workflow: ApiWorkflow, analysis: WorkflowAnalysis, specs: Map<string, ObjectInfoNodeSpec>
): WorkflowAnalysis {
  const parameters = analysis.parameters.map((param) => {
    const current = { ...param, defaultValue: param.value ?? param.defaultValue };
    if (param.type !== 'model' && param.type !== 'clip' && param.type !== 'vae') return current;
    const node = workflow[String(param.nodeId)];
    const spec = node && specs.get(node.class_type);
    const input = spec && [...spec.required, ...spec.optional].find((entry) => entry.name === param.inputName);
    return input?.kind === 'COMBO' ? {
      ...current, options: (input.options ?? []).map((value) => ({ label: value, value }))
    } : current;
  });
  return { ...analysis, parameters };
}

function collectMarks(workflow: ApiWorkflow, issues: InspectionIssue[]): MarkedNode[] {
  const marks: MarkedNode[] = [];
  const seenNames = new Map<string, string>();
  for (const [nodeId, node] of Object.entries(workflow)) {
    const title = node._meta?.title ?? '';
    for (const match of title.matchAll(MARK_PATTERN)) {
      const markType = match[1].toLowerCase();
      const name = match[2].trim();
      if (!MARK_TYPES.has(markType)) {
        issues.push({ nodeId: parseNodeId(nodeId), severity: 'error', message: `节点 ${nodeId}（${node.class_type}）标记类型 {${markType}} 不受支持` });
        continue;
      }
      const firstNode = seenNames.get(name);
      if (firstNode !== undefined) {
        issues.push({ nodeId: parseNodeId(nodeId), severity: 'error', message: `参数名重复：${name} 同时出现在节点 ${firstNode} 与 ${nodeId}，同一 revision 内参数名必须唯一` });
        continue;
      }
      seenNames.set(name, nodeId);
      marks.push({ nodeId, node, markType, name });
    }
  }
  return marks;
}

/** 类型匹配候选输入；标记节点目标输入为连线时沿连接定位真实写入节点（§4.1-3，SERVER §7.2）。 */
function bindMarkedInput(
  workflow: ApiWorkflow,
  specs: Map<string, ObjectInfoNodeSpec>,
  mark: MarkedNode,
  startSpec: ObjectInfoNodeSpec,
  issues: InspectionIssue[]
): BoundInput | null {
  let rawNodeId = mark.nodeId;
  let node = mark.node;
  let spec = startSpec;
  for (let hop = 0; hop < 8; hop += 1) {
    const inputName = chooseInputName(rawNodeId, node, mark.markType, spec, issues);
    if (inputName === null) return null;
    const rawValue = node.inputs[inputName];
    if (Array.isArray(rawValue) && typeof rawValue[0] === 'string') {
      const sourceId = rawValue[0];
      const sourceNode = workflow[sourceId];
      if (!sourceNode) {
        issues.push({ nodeId: parseNodeId(sourceId), severity: 'error', message: `无法沿连线定位写入节点：节点 ${sourceId} 不在工作流内` });
        return null;
      }
      const sourceSpec = specs.get(sourceNode.class_type);
      if (!sourceSpec) {
        issues.push({ nodeId: parseNodeId(sourceId), severity: 'error', message: `无法沿连线定位写入节点：节点 ${sourceId}（${sourceNode.class_type}）schema 不可用` });
        return null;
      }
      rawNodeId = sourceId;
      node = sourceNode;
      spec = sourceSpec;
      continue;
    }
    return { nodeId: parseNodeId(rawNodeId), rawNodeId, inputName, node, spec };
  }
  issues.push({ nodeId: parseNodeId(mark.nodeId), severity: 'error', message: `参数 ${mark.name} 绑定连线层级过深，无法定位真实写入节点` });
  return null;
}

function chooseInputName(contextNodeId: string, node: ApiWorkflowNode, markType: string, spec: ObjectInfoNodeSpec, issues: InspectionIssue[]): string | null {
  const inputs = [...spec.required, ...spec.optional];
  let candidates: ObjectInfoInputSpec[];
  switch (markType) {
    case 'string':
      candidates = inputs.filter((s) => s.kind === 'STRING');
      break;
    case 'int':
      candidates = inputs.filter((s) => s.kind === 'INT');
      break;
    case 'float':
      candidates = inputs.filter((s) => s.kind === 'FLOAT');
      break;
    case 'boolean':
      candidates = inputs.filter((s) => s.kind === 'BOOLEAN');
      break;
    case 'enum':
      candidates = inputs.filter((s) => s.kind === 'COMBO');
      break;
    case 'model':
    case 'clip':
    case 'vae': {
      const fileInputs = inputs.filter((s) => s.kind === 'COMBO' && s.name.endsWith('_name'));
      if (fileInputs.length === 1) {
        candidates = fileInputs;
      } else {
        const prefix = markType === 'model' ? /^(unet|ckpt|checkpoint|diffusion|model)/ : markType === 'clip' ? /^clip/ : /^vae/;
        candidates = fileInputs.filter((s) => prefix.test(s.name));
      }
      break;
    }
    case 'unknown': {
      // COMBO→enum 优先，其次 INT/FLOAT/STRING/BOOLEAN（§4.1-2）
      const byKind = (kind: InputKind) => inputs.filter((s) => s.kind === kind);
      candidates = byKind('COMBO').length > 0 ? byKind('COMBO')
        : byKind('INT').length > 0 ? byKind('INT')
        : byKind('FLOAT').length > 0 ? byKind('FLOAT')
        : byKind('STRING').length > 0 ? byKind('STRING')
        : byKind('BOOLEAN');
      break;
    }
    default:
      return null;
  }
  if (candidates.length === 0) {
    issues.push({ nodeId: parseNodeId(contextNodeId), severity: 'error', message: `无法唯一绑定：节点 ${contextNodeId}（${node.class_type}）没有与类型 {${markType}} 匹配的可写输入` });
    return null;
  }
  if (candidates.length > 1) {
    issues.push({
      nodeId: parseNodeId(contextNodeId),
      severity: 'error',
      message: `绑定歧义：节点 ${contextNodeId}（${node.class_type}）有多个匹配类型 {${markType}} 的输入（${candidates.map((s) => s.name).join('、')}），返回 mapping issue`
    });
    return null;
  }
  return candidates[0].name;
}

function buildParameter(mark: MarkedNode, bound: BoundInput, parameters: ParsedParameter[], issues: InspectionIssue[]): void {
  const specOfInput = [...bound.spec.required, ...bound.spec.optional].find((s) => s.name === bound.inputName) ?? null;
  const inferred = inferParameterType(mark.markType, specOfInput);
  if (inferred === null) {
    issues.push({
      nodeId: bound.nodeId,
      severity: 'error',
      message: `参数 ${mark.name}（节点 ${bound.nodeId}）类型无法从 ComfyUI schema 推断（输入 ${bound.inputName}），返回 mapping issue`
    });
    return;
  }
  const value = bound.node.inputs[bound.inputName] === undefined ? null : bound.node.inputs[bound.inputName];
  const defaultValue = bound.node.inputs[bound.inputName] ?? specOfInput?.default ?? null;
  const role = detectRole(mark.name, inferred);
  const param: ParsedParameter = {
    key: mark.name,
    name: mark.name,
    type: inferred,
    role,
    nodeId: bound.nodeId,
    inputName: bound.inputName,
    value,
    defaultValue,
    mode: role === null ? 'professional' : 'quick'
  };

  if (specOfInput?.kind === 'COMBO') {
    const options = specOfInput.options ?? [];
    if (role === 'aspectRatio') {
      // §4.2：比例短标签 ↔ 实际枚举值映射在 schema 产出时完成；无对应枚举值的短标签不进 options
      param.options = buildAspectOptions(options);
      param.displayValue = shortLabelForValue(String(value), param.options) ?? String(value);
    } else {
      param.options = options.map((o) => ({ label: o, value: o }));
      param.displayValue = String(value);
    }
  }
  if (specOfInput?.kind === 'INT' || specOfInput?.kind === 'FLOAT') {
    const constraints: ParameterConstraints = {};
    if (specOfInput.min !== undefined) constraints.min = specOfInput.min;
    if (specOfInput.max !== undefined) constraints.max = specOfInput.max;
    if (specOfInput.step !== undefined) constraints.step = specOfInput.step;
    if (Object.keys(constraints).length > 0) param.constraints = constraints;
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(num)) {
      const belowMin = constraints.min !== undefined && num < constraints.min;
      const aboveMax = constraints.max !== undefined && num > constraints.max;
      if (belowMin || aboveMax) {
        issues.push({
          nodeId: bound.nodeId,
          severity: 'error',
          message: `参数 ${mark.name}（节点 ${bound.nodeId}）默认值 ${num} 超出范围 [${constraints.min ?? '-∞'}, ${constraints.max ?? '+∞'}]`
        });
      }
    }
  }
  parameters.push(param);
}

function inferParameterType(markType: string, spec: ObjectInfoInputSpec | null): ParameterType | null {
  if (markType !== 'unknown') return markType as ParameterType;
  switch (spec?.kind) {
    case 'COMBO': return 'enum';
    case 'INT': return 'int';
    case 'FLOAT': return 'float';
    case 'STRING': return 'string';
    case 'BOOLEAN': return 'boolean';
    default: return null;
  }
}

/** 普通模式角色按名称+类型识别（§4.1-4）；识别顺序：ai扩写 → 比例 → 像素/分辨率 → 提示词。 */
function detectRole(name: string, type: ParameterType): ParameterRole | null {
  const lower = name.toLowerCase();
  const isAiNamed = lower.includes('ai扩写') || name.includes('AI扩写') || lower.includes('ai 扩写');
  if (type === 'boolean' && (isAiNamed || lower.includes('扩写'))) return 'aiExpansion';
  if (type === 'enum' && (name.includes('比例') || /aspect|ratio/i.test(name))) return 'aspectRatio';
  if (type === 'float' && (name.includes('像素') || name.includes('分辨率') || /(^|[^a-z])mp([^a-z]|$)/i.test(name))) return 'megapixels';
  if (type === 'string' && !isAiNamed && (name.includes('提示词') || /prompt/i.test(name))) return 'prompt';
  return null;
}

/** §4.2 匹配规则（按序）：① option 值即短标签；② 显示名（去括号取首段）等于短标签。 */
export function buildAspectOptions(comboOptions: Array<string | number>): EnumOption[] {
  const result: EnumOption[] = [];
  for (const label of ASPECT_SHORT_LABELS) {
    const matched = comboOptions.find((option) => {
      const value = String(option);
      return value === label || firstDisplaySegment(value) === label;
    });
    if (matched !== undefined) result.push({ label, value: String(matched) });
  }
  return result;
}

function firstDisplaySegment(value: string): string {
  const head = value.split('(')[0].trim();
  return head.length > 0 ? head : value.trim();
}

export function shortLabelForValue(value: string, options: EnumOption[]): string | null {
  return options.find((option) => option.value === value)?.label ?? null;
}

/** 短标签 → 实际枚举值；不在档案 options 中的短标签返回 null（§4.2）。 */
export function resolveAspectEnumValue(param: ParsedParameter, shortLabel: string): string | null {
  return param.options?.find((option) => option.label === shortLabel)?.value ?? null;
}

/** LoRA 扫描不依赖标题标记（SERVER §7.3）；enabled 恒可用，禁用采用 strength 归 0（Q4），由 preferences 承载。 */
export function scanLoras(workflow: ApiWorkflow): ParsedLora[] {
  const loras: ParsedLora[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!LORA_CLASS_TYPES.has(node.class_type)) continue;
    const loraName = node.inputs.lora_name;
    if (typeof loraName !== 'string' || loraName.length === 0) continue;
    const strength = resolvePrimitiveNumber(workflow, node.inputs.strength_model) ?? 1;
    loras.push({ nodeId: parseNodeId(nodeId), loraName, strength, enabled: true });
  }
  return loras;
}

/** sampler/scheduler 固定 euler/beta，解析为只读信息，不进 parameters（§4.1-8 / 宪章 §4.3）。 */
function collectReadonlyInfo(workflow: ApiWorkflow, issues: InspectionIssue[]): WorkflowReadonlyInfo {
  for (const node of Object.values(workflow)) {
    const sampler = typeof node.inputs.sampler_name === 'string' ? node.inputs.sampler_name : null;
    const scheduler = typeof node.inputs.scheduler === 'string' ? node.inputs.scheduler : null;
    if (sampler !== null && scheduler !== null) {
      if (sampler !== 'euler' || scheduler !== 'beta') {
        issues.push({ nodeId: null, severity: 'warning', message: `节点 ${node.class_type} 使用 sampler=${sampler}/scheduler=${scheduler}；平台首发固定 euler/beta，模板建议改用固定值` });
      }
      return { sampler, scheduler };
    }
  }
  return { sampler: null, scheduler: null };
}

/** 支持模式按 role 完备性推导（§4.1-7，Q2）：普通模式要求提示词/比例/像素角色齐备且不重复；ai扩写缺失不阻塞。 */
function deriveSupportedModes(parameters: ParsedParameter[], issues: InspectionIssue[]): GenerationMode[] {
  const byRole = new Map<ParameterRole, ParsedParameter[]>();
  for (const param of parameters) {
    if (param.role === null) continue;
    const list = byRole.get(param.role) ?? [];
    list.push(param);
    byRole.set(param.role, list);
  }
  let quickSupported = true;
  for (const { role, label } of QUICK_ROLES) {
    const list = byRole.get(role) ?? [];
    if (list.length === 0) {
      issues.push({ nodeId: null, severity: 'warning', message: `缺少普通模式角色 ${label}（${role}），普通模式不可用` });
      quickSupported = false;
    } else if (list.length > 1) {
      for (const extra of list.slice(1)) {
        issues.push({ nodeId: extra.nodeId, severity: 'error', message: `节点 ${extra.nodeId}（${extra.name}）：角色 ${role} 重复出现，普通模式不可用` });
      }
      quickSupported = false;
    }
  }
  if ((byRole.get('aiExpansion') ?? []).length === 0) {
    issues.push({ nodeId: null, severity: 'warning', message: '缺少 ai扩写 角色：普通模式 AI 开关按不可用呈现（不阻塞普通模式）' });
  }
  const suggestedModes: GenerationMode[] = [];
  if (quickSupported) suggestedModes.push('quick');
  if (parameters.length >= 1) suggestedModes.push('professional');
  return suggestedModes;
}

function deriveAiExpansionModes(parameters: ParsedParameter[]): AiExpansionMode[] {
  const hasAiRole = parameters.some((param) => param.role === 'aiExpansion');
  return hasAiRole ? ['none', 'comfyui_clip', 'custom_llm'] : ['none', 'custom_llm'];
}

// ---------- 可达图与依赖预检（F2，通用图论操作） ----------

const OUTPUT_CLASS_FALLBACK = /^(SaveImage|SaveImageWebsocket|SaveWEBM|SaveVideo|SaveAudio|SaveAnimatedWEBP|SaveAnimatedPNG|VHS_VideoCombine)/i;

/** 从输出节点反向遍历得到实际运行子图（§4.4 可达性裁剪思路，实现为新代码）。 */
export function reachableNodeIds(workflow: ApiWorkflow, specs: Map<string, ObjectInfoNodeSpec>): Set<string> {
  const outputIds = new Set<string>();
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (specs.get(node.class_type)?.outputNode === true || OUTPUT_CLASS_FALLBACK.test(node.class_type)) {
      outputIds.add(nodeId);
    }
  }
  const seeds = outputIds.size > 0 ? [...outputIds] : Object.keys(workflow);
  const reachable = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const nodeId = stack.pop() as string;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    const node = workflow[nodeId];
    if (!node) continue;
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string' && value[0] in workflow && !reachable.has(value[0])) {
        stack.push(value[0]);
      }
    }
  }
  return reachable;
}

/** F2 预检：可达图各节点 required 输入 diff 实际 inputs，缺失精确到 nodeId（§7.2 格式）。
 * V3 动态输入（AUTOGROW/DYNAMICCOMBO）按 ComfyUI 校验语义放行：基础键或 `name.` 扁平子键存在即视为已供值；
 * AUTOGROW 的 template.min=0 时允许整体缺省。 */
export function requiredInputGaps(workflow: ApiWorkflow, specs: Map<string, ObjectInfoNodeSpec>, reachable?: Set<string>): string[] {
  const gaps: string[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (reachable && !reachable.has(nodeId)) continue;
    const spec = specs.get(node.class_type);
    if (!spec) continue;
    for (const required of spec.required) {
      if (required.name in node.inputs) continue;
      if (hasFlattenedChild(node.inputs, required.name)) continue;
      if (required.autogrowMin === 0) continue;
      gaps.push(`节点 ${nodeId}（${node.class_type}）缺少必填输入 ${required.name}`);
    }
  }
  return gaps;
}

function hasFlattenedChild(inputs: Record<string, unknown>, name: string): boolean {
  const prefix = `${name}.`;
  return Object.keys(inputs).some((key) => key.startsWith(prefix));
}

export interface ModelFileReference {
  name: string;
  kind: 'lora' | 'model';
  folders: string[];
}

/** Parameters whose node output is connected to an expansion node's system_prompt input. */
export function findSystemPromptParameters(workflow: ApiWorkflow, parameters: ParsedParameter[]): ParsedParameter[] {
  const sourceNodeIds = new Set<string>();
  for (const node of Object.values(workflow)) {
    const link = node.inputs.system_prompt;
    if (Array.isArray(link) && typeof link[0] === 'string' && typeof link[1] === 'number') {
      sourceNodeIds.add(link[0]);
    }
  }
  return parameters.filter((parameter) => parameter.type === 'string' && sourceNodeIds.has(String(parameter.nodeId)));
}

const MODEL_FOLDER_BY_INPUT: Record<string, string[]> = {
  unet_name: ['diffusion_models'],
  ckpt_name: ['checkpoints'],
  clip_name: ['text_encoders', 'clip'],
  vae_name: ['vae'],
  lora_name: ['loras']
};

/** 工作流内按输入名识别的模型文件引用（字符串值才计入；连线不算）。 */
export function collectModelReferences(workflow: ApiWorkflow): ModelFileReference[] {
  const refs = new Map<string, ModelFileReference>();
  for (const node of Object.values(workflow)) {
    for (const [inputName, folders] of Object.entries(MODEL_FOLDER_BY_INPUT)) {
      const value = node.inputs[inputName];
      if (typeof value !== 'string' || value.length === 0) continue;
      const key = `${folders.join(',')}|${value}`;
      if (!refs.has(key)) {
        refs.set(key, { name: value, kind: inputName === 'lora_name' ? 'lora' : 'model', folders });
      }
    }
  }
  return [...refs.values()];
}
