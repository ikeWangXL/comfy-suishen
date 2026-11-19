import type { AppDatabase, WorkflowProfileRecord } from '../database.js';
import { httpError } from '../http/errors.js';
import type { ParameterType, ParsedLora, ParsedParameter } from './profileStore.js';

/**
 * 工作流参数偏好与 AI system prompt 存取（方案 §6 / API §5 / SERVER §7.3）。
 * 隔离维度 = workflowId + workflowRevision + nodeId + inputName（LoRA 按 nodeId）；
 * GET 只返回当前 revision schema 中仍存在且类型兼容的项，其余静默忽略（回到工作流有效默认值）。
 */

/** LoRA model strength 校验边界：ComfyUI core LoraLoader strength_model ±100；S5 提交时仍按 object_info 复核。 */
const LORA_STRENGTH_MIN = -100;
const LORA_STRENGTH_MAX = 100;

const AI_SYSTEM_PROMPT_KEY = 'aiSystemPrompt';
const PARAM_KEY_PREFIX = 'param:';
const LORA_KEY_PREFIX = 'lora:';

export interface PreferencesResponse {
  workflowRevision: string;
  aiSystemPrompt: string;
  parameters: Array<{ nodeId: number | string; inputName: string; value: unknown }>;
  loras: ParsedLora[];
}

interface StoredPreferenceValue {
  nodeId: number | string;
  inputName?: string;
  value?: unknown;
  loraName?: unknown;
  enabled?: unknown;
  strength?: unknown;
}

export class PreferencesStore {
  constructor(private readonly database: AppDatabase) {}

  getPreferences(profile: WorkflowProfileRecord): PreferencesResponse {
    const rows = this.database.getWorkflowPreferenceRows(profile.id, profile.revision);
    let aiSystemPrompt = '';
    const parameters: PreferencesResponse['parameters'] = [];
    const loras: ParsedLora[] = [];
    for (const row of rows) {
      if (row.prefKey === AI_SYSTEM_PROMPT_KEY) {
        if (typeof row.value === 'string') aiSystemPrompt = row.value;
        continue;
      }
      if (typeof row.value !== 'object' || row.value === null) continue;
      const stored = row.value as StoredPreferenceValue;
      if (row.prefKey.startsWith(PARAM_KEY_PREFIX)) {
        const param = findSchemaParam(profile.analysis.parameters, stored.nodeId, stored.inputName);
        // 类型兼容 + enum 实际值仍在当前 options 中才回传（§6.2：无法映射的项不返回）。
        if (param && isValueCompatible(stored.value, param)) {
          parameters.push({ nodeId: param.nodeId, inputName: param.inputName, value: stored.value });
        }
      } else if (row.prefKey.startsWith(LORA_KEY_PREFIX)) {
        const lora = findSchemaLora(profile.analysis.loras, stored.nodeId);
        if (lora && typeof stored.enabled === 'boolean' && typeof stored.strength === 'number') {
          loras.push({ nodeId: lora.nodeId, loraName: lora.loraName, strength: stored.strength, enabled: stored.enabled });
        }
      }
    }
    return { workflowRevision: profile.revision, aiSystemPrompt, parameters, loras };
  }

  /** PUT 全量替换（§6.3 last-write-wins）；域校验失败抛 400/409/422，写入后返回与 GET 对称的响应。 */
  putPreferences(profile: WorkflowProfileRecord, body: unknown): PreferencesResponse {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw httpError('INVALID_REQUEST', '请求体必须是 JSON 对象。');
    }
    const record = body as Record<string, unknown>;
    const revision = record.workflowRevision;
    if (typeof revision !== 'string' || revision.length === 0) {
      throw httpError('INVALID_REQUEST', '请求需提供 workflowRevision。');
    }
    if (revision !== profile.revision) {
      throw httpError('CONFLICT', 'workflowRevision 与档案当前 revision 不一致，请重新拉取 schema。');
    }

    let aiSystemPrompt = '';
    if (record.aiSystemPrompt !== undefined) {
      if (typeof record.aiSystemPrompt !== 'string') {
        throw httpError('INVALID_REQUEST', 'aiSystemPrompt 必须是字符串。');
      }
      aiSystemPrompt = record.aiSystemPrompt;
    }

    const entries: Array<{ prefKey: string; value: unknown }> = [];
    const parametersRaw = record.parameters ?? [];
    if (!Array.isArray(parametersRaw)) throw httpError('INVALID_REQUEST', 'parameters 必须是数组。');
    for (const item of parametersRaw) {
      entries.push(...parameterEntries(profile, item));
    }
    const lorasRaw = record.loras ?? [];
    if (!Array.isArray(lorasRaw)) throw httpError('INVALID_REQUEST', 'loras 必须是数组。');
    for (const item of lorasRaw) {
      entries.push(loraEntry(profile, item));
    }
    entries.push({ prefKey: AI_SYSTEM_PROMPT_KEY, value: aiSystemPrompt });

    this.database.replaceWorkflowPreferences(profile.id, profile.revision, entries);
    return this.getPreferences(profile);
  }
}

function parameterEntries(profile: WorkflowProfileRecord, item: unknown): Array<{ prefKey: string; value: unknown }> {
  if (typeof item !== 'object' || item === null) {
    throw httpError('INVALID_REQUEST', 'parameters 项必须是对象。');
  }
  const record = item as Record<string, unknown>;
  const param = findSchemaParam(profile.analysis.parameters, record.nodeId, record.inputName);
  if (!param) {
    throw httpError('INVALID_REQUEST', `参数 nodeId=${stringifyId(record.nodeId)} inputName=${stringifyId(record.inputName)} 不在当前 revision schema 中，请重新拉取 schema。`);
  }
  const value = validateParamValue(param, record.value);
  return [{
    prefKey: `${PARAM_KEY_PREFIX}${param.nodeId}:${param.inputName}`,
    value: { nodeId: param.nodeId, inputName: param.inputName, value }
  }];
}

function loraEntry(profile: WorkflowProfileRecord, item: unknown): { prefKey: string; value: unknown } {
  if (typeof item !== 'object' || item === null) {
    throw httpError('INVALID_REQUEST', 'loras 项必须是对象。');
  }
  const record = item as Record<string, unknown>;
  const lora = findSchemaLora(profile.analysis.loras, record.nodeId);
  if (!lora) {
    throw httpError('INVALID_REQUEST', `LoRA nodeId=${stringifyId(record.nodeId)} 不在当前 revision schema 中，请重新拉取 schema。`);
  }
  if (typeof record.enabled !== 'boolean') {
    throw httpError('INVALID_REQUEST', `LoRA ${lora.loraName} 需要布尔 enabled。`);
  }
  // 关闭时保留 model strength（Q4）；禁用注入为 0 是提交时（S5）的图内处理，偏好只存声明值。
  if (typeof record.strength !== 'number' || !Number.isFinite(record.strength)) {
    throw httpError('INVALID_GENERATION_PARAMS', `LoRA ${lora.loraName} 的 strength 必须是有限数值。`);
  }
  if (record.strength < LORA_STRENGTH_MIN || record.strength > LORA_STRENGTH_MAX) {
    throw httpError('INVALID_GENERATION_PARAMS', `LoRA ${lora.loraName} 的 strength 超出允许范围 [${LORA_STRENGTH_MIN}, ${LORA_STRENGTH_MAX}]。`);
  }
  if (record.loraName !== undefined && (typeof record.loraName !== 'string' || record.loraName !== lora.loraName)) {
    throw httpError('INVALID_REQUEST', `LoRA nodeId=${lora.nodeId} 与 loraName 不匹配。`);
  }
  return {
    prefKey: `${LORA_KEY_PREFIX}${lora.nodeId}`,
    value: { nodeId: lora.nodeId, loraName: lora.loraName, enabled: record.enabled, strength: record.strength }
  };
}

function validateParamValue(param: ParsedParameter, rawValue: unknown): unknown {
  assertSchemaParameterValue(param, rawValue);
  return rawValue;
}

/** schema 值校验的唯一实现（preferences PUT 与 S5 jobs gate 共用）：类型/整型/min/max/step/enum 实际值。 */
export function assertSchemaParameterValue(param: ParsedParameter, rawValue: unknown): void {
  if (rawValue === undefined) {
    throw httpError('INVALID_GENERATION_PARAMS', `参数 ${param.name}（${param.nodeId}.${param.inputName}）缺少 value。`);
  }
  const expectsNumber = param.type === 'int' || param.type === 'float';
  const typeInvalid =
    (typeof rawValue === 'string') ? !(['string', 'enum', 'model', 'clip', 'vae'] as ParameterType[]).includes(param.type) :
    (typeof rawValue === 'number') ? !expectsNumber :
    (typeof rawValue === 'boolean') ? param.type !== 'boolean' : true;
  if (typeInvalid) {
    throw httpError('INVALID_GENERATION_PARAMS', `参数 ${param.name} 的值类型与 schema（${param.type}）不符。`);
  }
  if (expectsNumber && typeof rawValue === 'number') {
    if (param.type === 'int' && !Number.isInteger(rawValue)) {
      throw httpError('INVALID_GENERATION_PARAMS', `参数 ${param.name} 需要整数值。`);
    }
    const constraints = param.constraints;
    if (constraints) {
      if (constraints.min !== undefined && rawValue < constraints.min) {
        throw httpError('INVALID_GENERATION_PARAMS', `参数 ${param.name} 的值低于下限 ${constraints.min}。`);
      }
      if (constraints.max !== undefined && rawValue > constraints.max) {
        throw httpError('INVALID_GENERATION_PARAMS', `参数 ${param.name} 的值超过上限 ${constraints.max}。`);
      }
      if (constraints.step !== undefined && constraints.min !== undefined &&
        Math.abs((rawValue - constraints.min) / constraints.step - Math.round((rawValue - constraints.min) / constraints.step)) > 1e-6) {
        throw httpError('INVALID_GENERATION_PARAMS', `参数 ${param.name} 的值不符合步长 ${constraints.step}。`);
      }
    }
  }
  const modelChoice = param.type === 'model' || param.type === 'clip' || param.type === 'vae';
  const hasOptions = param.options !== undefined && (modelChoice || param.options.length > 0);
  if (hasOptions && typeof rawValue === 'string') {
    if (!param.options?.some((option) => option.value === rawValue)) {
      throw httpError('INVALID_GENERATION_PARAMS', `参数 ${param.name} 的值不在可选列表中。`);
    }
  }
}

/** GET 侧宽松判定：类型可写即视为可映射（enum 附加当前 options 实际值成员校验）。 */
function isValueCompatible(value: unknown, param: ParsedParameter): boolean {
  if (value === undefined) return false;
  switch (param.type) {
    case 'string': case 'model': case 'clip': case 'vae': case 'enum':
      if (typeof value !== 'string') return false;
      return param.type === 'string' || param.options === undefined || param.options.some((option) => option.value === value);
    case 'int': return typeof value === 'number' && Number.isInteger(value);
    case 'float': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
}

function findSchemaParam(params: ParsedParameter[], nodeId: unknown, inputName: unknown): ParsedParameter | null {
  if (typeof inputName !== 'string' || inputName.length === 0) return null;
  if (typeof nodeId !== 'number' && typeof nodeId !== 'string') return null;
  return params.find((param) => String(param.nodeId) === String(nodeId) && param.inputName === inputName) ?? null;
}

function findSchemaLora(loras: ParsedLora[], nodeId: unknown): ParsedLora | null {
  if (typeof nodeId !== 'number' && typeof nodeId !== 'string') return null;
  return loras.find((lora) => String(lora.nodeId) === String(nodeId)) ?? null;
}

function stringifyId(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '(缺失)';
}
