import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess } from '../http/envelope.js';
import { httpError } from '../http/errors.js';
import { readJsonBody } from '../http/middleware.js';
import type { AppDatabase, JobStatus } from '../database.js';
import { isGallerySpaceLow, type GalleryStore } from '../galleryStore.js';
import { ComfyClient, type DependencyReport } from '../comfy/ComfyClient.js';
import {
  findSystemPromptParameters, imageOutputNodeIds, IMAGE_OUTPUT_REQUIRED, normalizeObjectInfo, resolvePrimitiveNumber,
  withCurrentModelOptions, type ObjectInfoNodeSpec
} from '../workflows/schemaParser.js';
import { assertSchemaParameterValue } from '../workflows/preferencesStore.js';
import { validateChildDirectoryName } from '../storage/filesystem.js';
import type { ApiWorkflow, WorkflowAnalysis } from '../workflows/profileStore.js';
import { availableProfileModes } from '../workflows/profileStore.js';
import type { WorkflowCatalog } from '../workflows/catalog.js';
import { JobQueue, jobState, type AiExpansionMode, type JobLoraSetting, type JobParameterRef, type JobPayload, type SamplerMetadata } from '../jobQueue.js';

const API_PREFIX = '/api/v1';
const JOB_STATUSES: readonly string[] = ['queued', 'running', 'cancelling', 'completed', 'cancelled', 'failed'];
const AI_EXPANSION_MODES: readonly string[] = ['none', 'comfyui_clip', 'custom_llm'];
const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;
/** LoRA strength 兜底边界：object_info 无 LoraLoader.strength_model min/max 时使用（comfy core ±100）。 */
const LORA_STRENGTH_FALLBACK = { min: -100, max: 100 };

export interface JobsRoutesDeps {
  queue: JobQueue;
  database: AppDatabase;
  gallery: GalleryStore;
  comfy: ComfyClient;
  catalog: WorkflowCatalog;
}

/**
 * 生成任务域（S5 / API §8）：POST（Idempotency-Key）/ list / detail / DELETE。
 * F3 gate 在入队前执行（主控裁决 2026-11-15）：mappingErrors → 422 WORKFLOW_INVALID；
 * 节点/模型/LoRA 缺失 → 422 DEPENDENCIES_MISSING；ComfyUI 不可达 → 503。
 */
export async function handleJobsRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  requestId: string,
  deps: JobsRoutesDeps
): Promise<void> {
  const pathname = url.pathname;
  const method = request.method ?? '';

  if (pathname === `${API_PREFIX}/jobs`) {
    if (method === 'POST') return createJob(request, response, requestId, deps);
    if (method === 'GET') return listJobs(url, response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  const jobMatch = /^\/api\/v1\/jobs\/([^/]+)$/.exec(pathname);
  if (jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1]);
    if (method === 'GET') return getJobDetail(response, requestId, deps, jobId);
    if (method === 'DELETE') return cancelJob(response, requestId, deps, jobId);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  throw httpError('NOT_FOUND', '接口不存在。');
}

// ---------- POST /jobs ----------

async function createJob(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: JobsRoutesDeps
): Promise<void> {
  // 幂等（SERVER §9.2）：同键重放返回首次创建的 jobId 当前状态。
  const idempotencyKey = typeof request.headers['idempotency-key'] === 'string'
    ? request.headers['idempotency-key'].trim()
    : '';
  if (idempotencyKey.length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供 Idempotency-Key 头。');
  }
  if (sendPriorJob(idempotencyKey, response, requestId, deps)) return;

  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw httpError('INVALID_REQUEST', '请求体必须是 JSON 对象。');
  }
  const record = body as Record<string, unknown>;

  const workflowId = requireString(record, 'workflowId');
  const profile = await deps.catalog.requireCurrent(workflowId);
  const workflowRevision = requireString(record, 'workflowRevision');
  if (workflowRevision !== profile.revision) {
    throw httpError('CONFLICT', '工作流已更新，请刷新档案参数后重新提交。');
  }
  // 无可注入参数的档案不可生成（S8 迁移语义：V1 迁移档案仅保留与图库/历史的关联，API §7 draft
  // 侧 workflowAvailable:false 的建任务侧对应）；先于 ComfyUI 依赖段，离线即可确定性拒绝。
  if (profile.analysis.parameters.length === 0) {
    throw httpError('WORKFLOW_MODE_UNSUPPORTED', '该档案无可注入参数（如 V1 迁移档案），不支持生成；请重新上传 V1.1 模板。');
  }

  const mode = requireString(record, 'mode');
  if (mode !== 'quick' && mode !== 'professional') {
    throw httpError('INVALID_REQUEST', 'mode 仅支持 quick、professional。');
  }
  if (imageOutputNodeIds(profile.workflow).length === 0) throw httpError('WORKFLOW_INVALID', IMAGE_OUTPUT_REQUIRED);
  if (!availableProfileModes(profile).includes(mode)) {
    throw httpError('WORKFLOW_MODE_UNSUPPORTED', '该档案未启用所选生成模式。');
  }
  const originalPrompt = requireString(record, 'originalPrompt');
  const finalPrompt = requireString(record, 'finalPrompt');
  const aiExpansionMode = requireString(record, 'aiExpansionMode');
  if (!AI_EXPANSION_MODES.includes(aiExpansionMode)) {
    throw httpError('INVALID_REQUEST', 'aiExpansionMode 仅支持 none、comfyui_clip、custom_llm。');
  }
  const hasAiSystemPrompt = Object.prototype.hasOwnProperty.call(record, 'aiSystemPrompt');
  if (hasAiSystemPrompt && typeof record.aiSystemPrompt !== 'string') {
    throw httpError('INVALID_REQUEST', 'aiSystemPrompt 必须是字符串。');
  }
  const count = record.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    throw httpError('INVALID_REQUEST', 'count 必须是正整数。');
  }
  const seedBase = record.seedBase;
  if (seedBase !== null && (typeof seedBase !== 'number' || !Number.isSafeInteger(seedBase) || seedBase < 0)) {
    throw httpError('INVALID_REQUEST', 'seedBase 必须是非负安全整数或 null。');
  }
  const folderName = record.folderName;
  if (typeof folderName !== 'string') {
    throw httpError('INVALID_REQUEST', 'folderName 必须是字符串（空串代表根目录）。');
  }
  if (folderName.length > 0) validateChildDirectoryName(folderName);
  if (mode === 'quick') {
    // Quick 固定 count=1、seed 随机、根目录（API §8）——显式拒绝而非静默钳制（422，主控裁决）。
    if (count !== 1 || seedBase !== null || folderName !== '') {
      throw httpError('INVALID_GENERATION_PARAMS', 'quick 模式固定 count=1、seedBase=null、folderName=""。');
    }
  }

  let specs: Map<string, ObjectInfoNodeSpec>;
  try {
    specs = normalizeObjectInfo(await deps.comfy.getObjectInfo(true));
  } catch {
    throw httpError('COMFY_UNREACHABLE', '无法连接到 ComfyUI，请检查地址和服务状态。', { retryable: true });
  }
  if (!specs.has('PreviewImage') || imageOutputNodeIds(profile.workflow, specs).length === 0) {
    throw httpError('WORKFLOW_INVALID', IMAGE_OUTPUT_REQUIRED);
  }
  const analysis = withCurrentModelOptions(profile.workflow, profile.analysis, specs);
  const parameters = parseParameterRefs(record.parameters, analysis);
  const promptParam = profile.analysis.parameters.find((parameter) => parameter.role === 'prompt');
  if (promptParam && !parameters.some((parameter) =>
    String(parameter.nodeId) === String(promptParam.nodeId) && parameter.inputName === promptParam.inputName)) {
    throw httpError('INVALID_GENERATION_PARAMS', 'parameters 缺少提示词参数（§8：包含本次使用的全部动态值）。');
  }
  if (promptParam) {
    const promptRef = parameters.find((parameter) =>
      String(parameter.nodeId) === String(promptParam.nodeId) && parameter.inputName === promptParam.inputName);
    if (promptRef?.value !== finalPrompt) {
      throw httpError('INVALID_GENERATION_PARAMS', 'finalPrompt 与提示词参数值不一致（§8）。');
    }
  }
  const loras = parseLoraSettings(record.loras, profile.analysis);
  assertGalleryReady(deps.gallery);
  const expansion = aiExpansionMode === 'comfyui_clip'
    ? inspectClipExpansion(profile.workflow, profile.analysis, specs)
    : null;
  const effectiveAiMode = expansion?.warning ? 'none' : aiExpansionMode as AiExpansionMode;
  let aiSystemPromptApplied: boolean | undefined;
  if (effectiveAiMode === 'comfyui_clip' && hasAiSystemPrompt) {
    const systemPromptParameters = findSystemPromptParameters(profile.workflow, profile.analysis.parameters);
    for (const parameter of systemPromptParameters) {
      const existing = parameters.find((candidate) =>
        String(candidate.nodeId) === String(parameter.nodeId) && candidate.inputName === parameter.inputName);
      if (existing) {
        existing.value = record.aiSystemPrompt;
      } else {
        parameters.push({
          nodeId: parameter.nodeId,
          inputName: parameter.inputName,
          value: record.aiSystemPrompt,
          role: parameter.role ?? undefined
        });
      }
    }
    aiSystemPromptApplied = systemPromptParameters.length > 0;
  }
  // ComfyUI 依赖段：object_info（LoRA 强度边界复核 + F3 gate 预检）。
  const template = buildJobTemplate(profile.workflow, parameters, loras, expansion?.source ?? null, profile.analysis);
  assertLoraStrengthBounds(specs, loras);

  const report = await deps.comfy.inspectDependencies(template.workflow);
  if (!report.connected) {
    throw httpError('COMFY_UNREACHABLE', '无法连接到 ComfyUI，请检查地址和服务状态。', { retryable: true });
  }
  if (report.mappingErrors.length > 0) {
    throw httpError('WORKFLOW_INVALID', '工作流节点映射校验未通过。', { mappingErrors: report.mappingErrors });
  }
  if (report.missingNodes.length > 0 || report.missingModels.length > 0 || report.missingLoras.length > 0) {
    throw httpError('DEPENDENCIES_MISSING', '缺少节点、模型或 LoRA 文件。', {
      missingNodes: report.missingNodes,
      missingModels: report.missingModels,
      missingLoras: report.loras
        .filter((lora) => report.missingLoras.includes(lora.loraName))
        .map((lora) => ({ nodeId: lora.nodeId, loraName: lora.loraName, enabled: lora.enabled }))
    });
  }

  const payload: JobPayload = {
    workflowId: profile.id,
    workflowRevision: profile.revision,
    workflowFingerprint: profile.fingerprint,
    workflowName: profile.name,
    mode,
    originalPrompt,
    finalPrompt,
    aiExpansionMode: effectiveAiMode,
    clipExpansionWarning: expansion?.warning,
    count,
    seedBase,
    folderName,
    parameters,
    loras,
    jobTemplate: template.workflow,
    previewOutputNodeIds: template.previewOutputNodeIds,
    expansionOutputNodeId: template.expansionOutputNodeId,
    aiSystemPromptApplied,
    seedTarget: template.seedTarget,
    samplerMetadata: template.samplerMetadata
  };
  // An overlapping retry can pass the first check while this request awaits validation.
  if (sendPriorJob(idempotencyKey, response, requestId, deps)) return;
  const job = deps.queue.create(payload, idempotencyKey);
  sendSuccess(response, jobCreateResult(job), requestId);
}

function sendPriorJob(key: string, response: ServerResponse, requestId: string, deps: JobsRoutesDeps): boolean {
  const id = deps.database.getIdempotencyJobId(key);
  if (!id) return false;
  const job = deps.queue.get(id);
  if (!job) throw httpError('JOB_NOT_FOUND', '此请求对应的生成任务已删除。');
  sendSuccess(response, jobCreateResult(job), requestId);
  return true;
}

// ---------- GET /jobs、/jobs/:id、DELETE ----------

function listJobs(url: URL, response: ServerResponse, requestId: string, deps: JobsRoutesDeps): void {
  const status = url.searchParams.get('status') ?? '';
  if (status.length > 0 && !JOB_STATUSES.includes(status)) {
    throw httpError('INVALID_REQUEST', `status 仅支持 ${JOB_STATUSES.join('、')}。`);
  }
  const cursorRaw = url.searchParams.get('cursor') ?? '';
  if (cursorRaw.length > 0 && !/^\d+$/.test(cursorRaw)) {
    throw httpError('INVALID_REQUEST', 'cursor 不合法。');
  }
  const limitRaw = url.searchParams.get('limit') ?? String(DEFAULT_LIST_LIMIT);
  if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIST_LIMIT) {
    throw httpError('INVALID_REQUEST', `limit 需在 1-${MAX_LIST_LIMIT} 之间。`);
  }
  const page = deps.queue.list(
    status.length > 0 ? status as JobStatus : undefined,
    Number(limitRaw),
    cursorRaw.length > 0 ? Number(cursorRaw) : 0,
    url.searchParams.get('order') === 'oldest'
  );
  sendSuccess(response, { items: page.items.map(jobState), nextCursor: page.nextCursor }, requestId);
}

function getJobDetail(
  response: ServerResponse,
  requestId: string,
  deps: JobsRoutesDeps,
  jobId: string
): void {
  const job = deps.queue.get(jobId);
  if (!job) throw httpError('JOB_NOT_FOUND', '任务不存在。');
  const state = jobState(job);
  const payload = job.payload as JobPayload;
  const savedState = job.result as { startedAt?: string } | undefined;
  const endedAt = ['completed', 'failed', 'cancelled'].includes(job.status) ? job.updatedAt ?? '' : '';
  const firstImageId = deps.database.listJobImages(jobId).find((image) => image.imageId)?.imageId;
  const firstImage = firstImageId ? deps.database.getImage(firstImageId) : null;
  const metadata = firstImage?.metadata as { width?: number; height?: number } | undefined;
  sendSuccess(response, {
    ...state,
    prompt: payload.originalPrompt,
    startedAt: savedState?.startedAt ?? '',
    endedAt,
    durationSeconds: savedState?.startedAt && endedAt ? Math.max(0, (Date.parse(endedAt) - Date.parse(savedState.startedAt)) / 1000) : null,
    width: metadata?.width ?? 0,
    height: metadata?.height ?? 0,
    mode: (job.payload as JobPayload).mode,
    images: deps.database.listJobImages(jobId).map((image) => ({
      index: image.imageIndex,
      status: image.status,
      imageId: image.imageId ?? '',
      error: image.error ?? ''
    }))
  }, requestId);
}

function cancelJob(
  response: ServerResponse,
  requestId: string,
  deps: JobsRoutesDeps,
  jobId: string
): Promise<void> {
  return (async () => {
    const job = deps.queue.get(jobId);
    if (!job) throw httpError('JOB_NOT_FOUND', '任务不存在。');
    const result = await deps.queue.cancel(jobId);
    const state = jobState(result.job);
    sendSuccess(response, {
      cancelPolicy: result.cancelPolicy,
      statusDetail: {
        currentIndex: state.currentIndex,
        count: state.count,
        completedCount: state.completedCount
      }
    }, requestId);
  })();
}

// ---------- 校验与模板构建 ----------

function parseParameterRefs(raw: unknown, analysis: WorkflowAnalysis): JobParameterRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw httpError('INVALID_REQUEST', 'parameters 必须是数组。');
  const refs: JobParameterRef[] = [];
  const seen = new Set<WorkflowAnalysis['parameters'][number]>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw httpError('INVALID_REQUEST', 'parameters 项必须是对象。');
    }
    const entry = item as Record<string, unknown>;
    const param = analysis.parameters.find((candidate) =>
      String(candidate.nodeId) === String(entry.nodeId) && candidate.inputName === entry.inputName);
    if (!param || (typeof entry.nodeId !== 'number' && typeof entry.nodeId !== 'string')) {
      throw httpError('INVALID_REQUEST', `参数 nodeId=${JSON.stringify(entry.nodeId ?? null)} inputName=${JSON.stringify(entry.inputName ?? null)} 不在该 revision schema 中。`);
    }
    if (seen.has(param)) {
      throw httpError('INVALID_GENERATION_PARAMS', `参数 ${param.name} 在同一请求中只能提交一次。`);
    }
    seen.add(param);
    assertSchemaParameterValue(param, entry.value);
    refs.push({ nodeId: param.nodeId, inputName: param.inputName, value: entry.value, role: param.role ?? undefined });
  }
  return refs;
}

function parseLoraSettings(raw: unknown, analysis: WorkflowAnalysis): JobLoraSetting[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw httpError('INVALID_REQUEST', 'loras 必须是数组。');
  const settings: JobLoraSetting[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw httpError('INVALID_REQUEST', 'loras 项必须是对象。');
    }
    const entry = item as Record<string, unknown>;
    const lora = analysis.loras.find((candidate) => String(candidate.nodeId) === String(entry.nodeId));
    if (!lora || (typeof entry.nodeId !== 'number' && typeof entry.nodeId !== 'string')) {
      throw httpError('INVALID_REQUEST', `LoRA nodeId=${JSON.stringify(entry.nodeId ?? null)} 不在该 revision schema 中。`);
    }
    if (typeof entry.loraName === 'string' && entry.loraName !== lora.loraName) {
      throw httpError('INVALID_REQUEST', `LoRA nodeId=${lora.nodeId} 与 loraName 不匹配。`);
    }
    if (typeof entry.enabled !== 'boolean') {
      throw httpError('INVALID_REQUEST', `LoRA ${lora.loraName} 需要布尔 enabled。`);
    }
    if (typeof entry.strength !== 'number' || !Number.isFinite(entry.strength)) {
      throw httpError('INVALID_GENERATION_PARAMS', `LoRA ${lora.loraName} 的 strength 必须是有限数值。`);
    }
    settings.push({ nodeId: lora.nodeId, loraName: lora.loraName, enabled: entry.enabled, strength: entry.strength });
  }
  return settings;
}

/** LoRA strength 边界以 object_info LoraLoader.strength_model min/max 为准（裁决备忘；缺省回退 ±100）。 */
function assertLoraStrengthBounds(specs: Map<string, ObjectInfoNodeSpec>, loras: JobLoraSetting[]): void {
  const spec = specs.get('LoraLoader') ?? specs.get('LoraLoaderModelOnly');
  const strengthSpec = spec ? [...spec.required, ...spec.optional].find((input) => input.name === 'strength_model') : undefined;
  const min = typeof strengthSpec?.min === 'number' ? strengthSpec.min : LORA_STRENGTH_FALLBACK.min;
  const max = typeof strengthSpec?.max === 'number' ? strengthSpec.max : LORA_STRENGTH_FALLBACK.max;
  for (const lora of loras) {
    if (lora.strength < min || lora.strength > max) {
      throw httpError('INVALID_GENERATION_PARAMS', `LoRA ${lora.loraName} 的 strength 超出允许范围 [${min}, ${max}]。`);
    }
  }
}

function assertGalleryReady(gallery: GalleryStore): void {
  if (!gallery.isConfigured()) {
    throw httpError('GALLERY_UNAVAILABLE', '尚未配置图库根目录，无法生成。');
  }
}

interface BuiltTemplate {
  workflow: ApiWorkflow;
  seedTarget: { nodeId: string; inputName: string } | null;
  samplerMetadata: SamplerMetadata;
  previewOutputNodeIds: string[];
  expansionOutputNodeId: string | null;
}

/**
 * 冻结模板构建（SERVER §9.1"复制可变图对象"）：参数精确写入（analysis 已解析绑定节点）、
 * LoRA 禁用 strength_model/strength_clip 同写 0 且节点保留（Q4）、AI 开关由 aiExpansionMode 推导、
 * 保留工作流的 batch_size；种子写入点定位留给每次执行时覆盖。
 */
function buildJobTemplate(
  workflow: ApiWorkflow,
  parameters: JobParameterRef[],
  loras: JobLoraSetting[],
  expansionSource: [string, number] | null,
  analysis: WorkflowAnalysis
): BuiltTemplate {
  const instance = structuredClone(workflow);

  for (const parameter of parameters) {
    const node = instance[String(parameter.nodeId)];
    if (!node) {
      throw httpError('WORKFLOW_INVALID', `参数节点 ${parameter.nodeId} 不在档案工作流内。`);
    }
    node.inputs[parameter.inputName] = parameter.value;
  }
  for (const lora of loras) {
    const node = instance[String(lora.nodeId)];
    if (!node || (node.class_type !== 'LoraLoader' && node.class_type !== 'LoraLoaderModelOnly')) {
      throw httpError('WORKFLOW_INVALID', `LoRA 节点 ${lora.nodeId} 不在档案工作流内。`);
    }
    const original = analysis.loras.find((entry) => String(entry.nodeId) === String(lora.nodeId));
    if (!lora.enabled || !isWorkflowLink(node.inputs.strength_model) || original?.strength !== lora.strength) {
      node.inputs.strength_model = lora.enabled ? lora.strength : 0;
    }
    if (node.class_type === 'LoraLoader' && !lora.enabled) node.inputs.strength_clip = 0;
  }
  const aiParam = analysis.parameters.find((parameter) => parameter.role === 'aiExpansion');
  if (aiParam) {
    const node = instance[String(aiParam.nodeId)];
    if (node) node.inputs[aiParam.inputName] = expansionSource !== null;
  }
  const previewOutputNodeIds: string[] = [];
  for (const [nodeId, node] of Object.entries(instance)) {
    if (node.class_type !== 'SaveImage') continue;
    previewOutputNodeIds.push(nodeId);
    node.class_type = 'PreviewImage';
    node.inputs = { images: node.inputs.images };
  }

  let expansionOutputNodeId: string | null = null;
  if (expansionSource) {
    expansionOutputNodeId = String(Math.max(0, ...Object.keys(instance).map(Number).filter(Number.isSafeInteger)) + 1);
    instance[expansionOutputNodeId] = {
      class_type: 'PreviewAny',
      inputs: { source: expansionSource },
      _meta: { title: 'Comfy App 扩写文本输出' }
    };
  }

  return {
    workflow: instance,
    seedTarget: locateSeedTarget(instance),
    samplerMetadata: extractSamplerMetadata(instance, loras),
    previewOutputNodeIds,
    expansionOutputNodeId
  };
}

/** 识别由标记开关控制、确实接到文本编码器的扩写分支。 */
function inspectClipExpansion(
  workflow: ApiWorkflow,
  analysis: WorkflowAnalysis,
  specs: Map<string, ObjectInfoNodeSpec>
): { source: [string, number] | null; warning?: string } {
  const encoders = Object.values(workflow).filter((node) => node.class_type === 'CLIPTextEncode');
  const missing = (message: string) => ({ source: null, warning: `已跳过 CLIP 扩写，继续出图。${message}` });
  if (encoders.length === 0) return missing('请在 ComfyUI 中添加 CLIP 文本编码（CLIPTextEncode）。');
  const aiParam = analysis.parameters.find((parameter) => parameter.role === 'aiExpansion');
  for (const encoder of encoders) {
    const text = encoder.inputs.text;
    if (!isWorkflowLink(text)) continue;
    const switchNode = workflow[text[0]];
    if (switchNode?.class_type !== 'ComfySwitchNode') continue;
    const toggle = switchNode.inputs.switch;
    if (!isWorkflowLink(toggle) || toggle[0] !== String(aiParam?.nodeId)) continue;
    const branch = switchNode.inputs.on_true;
    if (!isWorkflowLink(branch) || workflow[branch[0]]?.class_type !== 'TextGenerateV2') continue;
    if (!specs.has('PreviewAny')) return missing('当前 ComfyUI 缺少预览任意数据（PreviewAny），无法读取扩写文本。');
    return { source: text };
  }
  return missing('请将生成文本（TextGenerateV2）通过带 AI 扩写标记的切换（ComfySwitchNode）接到 CLIP 文本编码（CLIPTextEncode）。');
}

function isWorkflowLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'number';
}

/** 种子写入点：KSampler.seed 经连线 → 来源节点 value 输入；字面量 → KSampler.seed 本身。 */
function locateSeedTarget(instance: ApiWorkflow): { nodeId: string; inputName: string } | null {
  const samplerEntry = Object.entries(instance).find(([, node]) => node.class_type === 'KSampler');
  if (!samplerEntry) return null;
  const seed = samplerEntry[1].inputs.seed;
  if (Array.isArray(seed) && typeof seed[0] === 'string') {
    const source = instance[seed[0]];
    if (source && 'value' in source.inputs) return { nodeId: seed[0], inputName: 'value' };
  }
  if (typeof seed === 'number') return { nodeId: samplerEntry[0], inputName: 'seed' };
  if (Array.isArray(seed) && typeof seed[0] === 'string') return { nodeId: samplerEntry[0], inputName: 'seed' };
  return null;
}

/** §10.3 采样元数据：sampler 输入字面量取值；连线（如 steps/cfg/denoise → Primitive 节点）沿连线读 value。 */
function extractSamplerMetadata(instance: ApiWorkflow, loras: JobLoraSetting[]): SamplerMetadata {
  let model: string | null = null;
  for (const node of Object.values(instance)) {
    if (node.class_type === 'UNETLoader' && typeof node.inputs.unet_name === 'string') {
      model = node.inputs.unet_name;
      break;
    }
    if (node.class_type === 'CheckpointLoaderSimple' && typeof node.inputs.ckpt_name === 'string') {
      model = node.inputs.ckpt_name;
      break;
    }
  }
  const templateLoras = Object.entries(instance)
    .filter(([, node]) => node.class_type === 'LoraLoader' || node.class_type === 'LoraLoaderModelOnly')
    .map(([nodeId, node]) => {
      const requested = loras.find((lora) => String(lora.nodeId) === nodeId);
      const templateStrength = resolvePrimitiveNumber(instance, node.inputs.strength_model) ?? 0;
      return {
        nodeId: parseNodeIdSafe(nodeId),
        loraName: typeof node.inputs.lora_name === 'string' ? node.inputs.lora_name : '',
        enabled: requested ? requested.enabled : true,
        strength: requested ? requested.strength : templateStrength
      };
    });
  const sampler = Object.values(instance).find((node) => node.class_type === 'KSampler');
  return {
    model,
    loras: templateLoras,
    sampler: typeof sampler?.inputs.sampler_name === 'string' ? sampler.inputs.sampler_name : null,
    steps: samplerNumber(instance, sampler?.inputs.steps),
    cfg: samplerNumber(instance, sampler?.inputs.cfg),
    scheduler: typeof sampler?.inputs.scheduler === 'string' ? sampler.inputs.scheduler : null,
    denoise: samplerNumber(instance, sampler?.inputs.denoise)
  };
}

function samplerNumber(instance: ApiWorkflow, value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && typeof value[0] === 'string') {
    const source = instance[value[0]];
    if (source && typeof source.inputs.value === 'number' && Number.isFinite(source.inputs.value)) {
      return source.inputs.value;
    }
  }
  return null;
}

function parseNodeIdSafe(rawId: string): number | string {
  return /^\d+$/.test(rawId) ? Number(rawId) : rawId;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw httpError('INVALID_REQUEST', `请求需提供非空 ${key}。`);
  }
  return value;
}

function jobCreateResult(job: NonNullable<ReturnType<JobQueue['get']>>): Record<string, unknown> {
  const state = jobState(job);
  const aiSystemPromptApplied = (job.payload as JobPayload).aiSystemPromptApplied;
  return {
    jobId: state.jobId,
    status: state.status,
    count: state.count,
    completedCount: state.completedCount,
    createdAt: state.createdAt,
    ...(typeof (job.payload as JobPayload).clipExpansionWarning === 'string'
      ? { clipExpansionWarning: (job.payload as JobPayload).clipExpansionWarning } : {}),
    ...(typeof aiSystemPromptApplied === 'boolean' ? { aiSystemPromptApplied } : {})
  };
}
