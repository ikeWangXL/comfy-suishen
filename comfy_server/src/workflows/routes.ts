import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess } from '../http/envelope.js';
import { httpError } from '../http/errors.js';
import { readJsonBody } from '../http/middleware.js';
import type { AppDatabase, WorkflowProfileRecord } from '../database.js';
import type { WorkflowCatalog } from './catalog.js';
import { ComfyClient, ComfyHttpError, type DependencyReport } from '../comfy/ComfyClient.js';
import {
  findSystemPromptParameters, imageOutputNodeIds, IMAGE_OUTPUT_REQUIRED, normalizeObjectInfo,
  parseWorkflow, withCurrentModelOptions, type ObjectInfoNodeSpec
} from './schemaParser.js';
import { ResolutionUnsupportedError, resolveResolution } from './resolution.js';
import {
  buildInspectionRecord,
  availableProfileModes,
  scrubWorkflowSecrets,
  WorkflowProfileStore,
  type GenerationMode
} from './profileStore.js';
import { PreferencesStore } from './preferencesStore.js';
import { expandPrompt } from '../aiExpansion.js';
import { loadConfig, type AiConfig } from '../config.js';
import { isApiWorkflow } from './workflowFiles.js';

const API_PREFIX = '/api/v1';
const LIST_MODES: readonly string[] = ['quick', 'professional'];

export interface WorkflowRoutesDeps {
  database: AppDatabase;
  comfy: ComfyClient;
  catalog: WorkflowCatalog;
}

/**
 * 工作流配置档域（S4 / API §5 + S7 / API §6）：inspect→确认→保存流程 + 档案 CRUD/默认位 + preferences +
 * resolution-preview + dependency-check + ai/expand（custom_llm 文本扩写，不建任务）。
 * 鉴权由 main.ts 的 Bearer 中间件统一前置。
 */
export async function handleWorkflowRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  requestId: string,
  deps: WorkflowRoutesDeps
): Promise<void> {
  const store = deps.catalog.store;
  const preferences = new PreferencesStore(deps.database);
  const pathname = url.pathname;
  const method = request.method ?? '';

  if (method === 'POST' && pathname === `${API_PREFIX}/workflows/inspect`) {
    return inspectWorkflow(request, response, requestId, deps, store);
  }
  if (method === 'POST' && pathname === `${API_PREFIX}/workflows`) {
    return saveProfile(request, response, requestId, deps, store);
  }
  if (method === 'GET' && pathname === `${API_PREFIX}/workflows`) {
    return listProfiles(url, response, requestId, deps, store);
  }
  if (method === 'PUT' && pathname === `${API_PREFIX}/workflows/default`) {
    return setDefaultProfile(request, response, requestId, deps, store);
  }

  const profileMatch = /^\/api\/v1\/workflows\/([^/]+)$/.exec(pathname);
  if (profileMatch) {
    const workflowId = decodeURIComponent(profileMatch[1]);
    if (method === 'GET') return getProfileDetail(response, requestId, deps, workflowId);
    if (method === 'PATCH') return renameProfile(request, response, requestId, deps, store, workflowId);
    if (method === 'DELETE') return deleteProfile(response, requestId, deps, store, workflowId);
    throw httpError('NOT_FOUND', '接口不存在。');
  }

  const preferencesMatch = /^\/api\/v1\/workflows\/([^/]+)\/preferences$/.exec(pathname);
  if (preferencesMatch) {
    const workflowId = decodeURIComponent(preferencesMatch[1]);
    if (method === 'GET') return getPreferences(response, requestId, deps, preferences, workflowId);
    if (method === 'PUT') return putPreferences(request, response, requestId, deps, preferences, workflowId);
    throw httpError('NOT_FOUND', '接口不存在。');
  }

  const previewMatch = /^\/api\/v1\/workflows\/([^/]+)\/resolution-preview$/.exec(pathname);
  if (previewMatch && method === 'POST') {
    return resolutionPreview(request, response, requestId, deps, decodeURIComponent(previewMatch[1]));
  }

  const dependencyMatch = /^\/api\/v1\/workflows\/([^/]+)\/dependency-check$/.exec(pathname);
  if (dependencyMatch && method === 'POST') {
    return dependencyCheck(response, requestId, deps, decodeURIComponent(dependencyMatch[1]));
  }

  const expandMatch = /^\/api\/v1\/workflows\/([^/]+)\/ai\/expand$/.exec(pathname);
  if (expandMatch && method === 'POST') {
    return aiExpand(request, response, requestId, deps, preferences, decodeURIComponent(expandMatch[1]));
  }

  throw httpError('NOT_FOUND', '接口不存在。');
}

// ---------- inspect / save ----------

/** POST /workflows/inspect：请求体即 API prompt JSON 本体（契约 §5）；确认前只落 workflow_inspections 暂存。 */
async function inspectWorkflow(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  store: WorkflowProfileStore
): Promise<void> {
  const body = await readJsonBody(request);
  if (!isApiWorkflow(body)) {
    throw httpError('INVALID_REQUEST', '请在 ComfyUI 中使用“导出（API 格式）”，再上传该 JSON。');
  }
  // 先剥离密钥再解析入库（SERVER §11：密钥不进运行图/响应/日志）。
  const workflow = scrubWorkflowSecrets(body);
  const specs = await loadObjectInfoSpecs(deps.comfy);
  const analysis = parseWorkflow(workflow, specs);
  const record = buildInspectionRecord(analysis, workflow);
  store.saveInspection(record);
  sendSuccess(response, {
    inspectionId: record.inspectionId,
    revision: analysis.revision,
    fingerprint: analysis.fingerprint,
    parameters: analysis.parameters,
    loras: analysis.loras,
    aiExpansionModes: analysis.aiExpansionModes,
    suggestedModes: analysis.suggestedModes,
    issues: analysis.issues
  }, requestId);
}

async function saveProfile(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  store: WorkflowProfileStore
): Promise<void> {
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw httpError('INVALID_REQUEST', '请求体必须是 JSON 对象。');
  }
  const record = body as Record<string, unknown>;
  const inspectionId = record.inspectionId;
  if (typeof inspectionId !== 'string' || inspectionId.length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供 inspectionId。');
  }
  const rawName = record.name;
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供非空 name。');
  }
  const name = rawName.trim();
  const confirmedModes = record.confirmedModes;
  if (!Array.isArray(confirmedModes) || confirmedModes.some((mode) => typeof mode !== 'string')) {
    throw httpError('INVALID_REQUEST', 'confirmedModes 必须是字符串数组。');
  }
  const modes = [...new Set(confirmedModes as string[])];
  for (const mode of modes) {
    if (!LIST_MODES.includes(mode)) throw httpError('INVALID_REQUEST', `未知模式 ${mode}。`);
  }
  const inspection = store.getInspection(inspectionId);
  if (!inspection) {
    throw httpError('NOT_FOUND', '检查结果不存在或已过期，请重新上传并检查工作流。');
  }
  if (inspection.analysis.imageOutputAvailable === false || imageOutputNodeIds(inspection.originalWorkflow).length === 0) {
    throw httpError('WORKFLOW_INVALID', IMAGE_OUTPUT_REQUIRED);
  }
  const unavailable = modes.filter((mode) => !inspection.analysis.suggestedModes.includes(mode as GenerationMode));
  if (unavailable.length > 0) {
    const available = inspection.analysis.suggestedModes.join('、') || '无';
    throw httpError('WORKFLOW_MODE_UNSUPPORTED', `工作流不支持所选模式：${unavailable.join('、')}（可用：${available}）。`);
  }
  const profile = store.createProfile({
    name,
    confirmedModes: modes,
    setAsDefault: record.setAsDefault === true,
    analysis: inspection.analysis,
    workflow: inspection.originalWorkflow
  });
  const workflowChange = deps.catalog.publish('catalog', [profile.id]);
  sendSuccess(response, { ...profileSummary(profile), workflowChange }, requestId);
}

// ---------- list / detail / rename / delete / default ----------

async function listProfiles(
  url: URL,
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  store: WorkflowProfileStore
): Promise<void> {
  const mode = url.searchParams.get('mode') ?? undefined;
  if (mode !== undefined && !LIST_MODES.includes(mode)) {
    throw httpError('INVALID_REQUEST', `mode 仅支持 ${LIST_MODES.join('、')}。`);
  }
  await deps.catalog.refresh();
  sendSuccess(response, { items: store.listProfiles(mode).map(profileSummary) }, requestId);
}

async function getProfileDetail(
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  workflowId: string
): Promise<void> {
  const profile = await deps.catalog.requireCurrent(workflowId);
  // 详情带依赖检查快照（尽力而为；ComfyUI 不可达时 connected=false，不阻塞表单生成）。
  const dependencies = await deps.comfy.inspectDependencies(profile.workflow);
  const specs = await loadObjectInfoSpecs(deps.comfy, true).catch(() => undefined);
  const analysis = withCurrentModelOptions(profile.workflow, profile.analysis, specs ?? new Map());
  const outputAvailable = !specs || (specs.has('PreviewImage') && imageOutputNodeIds(profile.workflow, specs).length > 0);
  sendSuccess(response, {
    workflowId: profile.id,
    name: profile.name,
    supportedModes: outputAvailable ? availableProfileModes(profile) : [],
    aiExpansionModes: profile.analysis.aiExpansionModes,
    revision: profile.revision,
    fingerprint: profile.fingerprint,
    parameters: analysis.parameters,
    loras: profile.analysis.loras,
    dependencies: dependencyPayload(dependencies)
  }, requestId);
}

async function renameProfile(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  store: WorkflowProfileStore,
  workflowId: string
): Promise<void> {
  const body = await readJsonBody(request);
  const name = recordField(body, 'name');
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供非空 name。');
  }
  const profile = store.renameProfile(workflowId, name.trim());
  const workflowChange = deps.catalog.publish('catalog', [profile.id]);
  sendSuccess(response, { ...profileSummary(profile), workflowChange }, requestId);
}

function deleteProfile(
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  store: WorkflowProfileStore,
  workflowId: string
): void {
  store.deleteProfile(workflowId);
  const workflowChange = deps.catalog.publish('catalog', [workflowId]);
  sendSuccess(response, { deleted: true, workflowChange }, requestId);
}

async function setDefaultProfile(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  store: WorkflowProfileStore
): Promise<void> {
  const body = await readJsonBody(request);
  const workflowId = recordField(body, 'workflowId');
  if (typeof workflowId !== 'string' || workflowId.length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供 workflowId。');
  }
  const profile = store.setDefaultProfile(workflowId);
  const workflowChange = deps.catalog.publish('catalog', [profile.id]);
  sendSuccess(response, { ...profileSummary(profile), workflowChange }, requestId);
}

// ---------- preferences ----------

async function getPreferences(
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  preferences: PreferencesStore,
  workflowId: string
): Promise<void> {
  const profile = await deps.catalog.requireCurrent(workflowId);
  const specs = await loadObjectInfoSpecs(deps.comfy, true).catch(() => undefined);
  const analysis = specs ? withCurrentModelOptions(profile.workflow, profile.analysis, specs) : profile.analysis;
  sendSuccess(response, preferences.getPreferences({ ...profile, analysis }), requestId);
}

async function putPreferences(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  preferences: PreferencesStore,
  workflowId: string
): Promise<void> {
  const body = await readJsonBody(request);
  const profile = await deps.catalog.requireCurrent(workflowId);
  const specs = await loadObjectInfoSpecs(deps.comfy, true);
  const analysis = withCurrentModelOptions(profile.workflow, profile.analysis, specs);
  const result = preferences.putPreferences({ ...profile, analysis }, body);
  const clientChangeId = recordField(body, 'clientChangeId');
  const workflowChange = deps.catalog.publish('preferences', [profile.id],
    typeof clientChangeId === 'string' && clientChangeId.length > 0 ? clientChangeId : undefined);
  sendSuccess(response, { ...result, workflowChange }, requestId);
}

// ---------- resolution-preview / dependency-check ----------

async function resolutionPreview(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  workflowId: string
): Promise<void> {
  const body = await readJsonBody(request);
  const profile = await deps.catalog.requireCurrent(workflowId);
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
  const aspectRatio = record.aspectRatio;
  if (typeof aspectRatio !== 'string' || aspectRatio.length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供 aspectRatio 短标签。');
  }
  const megapixels = record.megapixels;
  if (typeof megapixels !== 'number' || !Number.isFinite(megapixels) || megapixels <= 0) {
    throw httpError('INVALID_REQUEST', '请求需提供正数 megapixels。');
  }
  const ratioParam = profile.analysis.parameters.find((parameter) => parameter.role === 'aspectRatio');
  if (!ratioParam) {
    throw httpError('INVALID_GENERATION_PARAMS', '该档案没有比例参数，无法预览分辨率。');
  }
  const enumValue = ratioParam.options?.find((option) => option.label === aspectRatio)?.value;
  if (enumValue === undefined) {
    throw httpError('INVALID_GENERATION_PARAMS', `短比例标签 ${aspectRatio} 不在该档案的比例枚举中。`);
  }
  const ratioNode = profile.workflow[String(ratioParam.nodeId)];
  if (!ratioNode) {
    throw httpError('WORKFLOW_INVALID', `比例参数节点 ${ratioParam.nodeId} 不在档案工作流内。`);
  }
  const specs = await loadObjectInfoSpecs(deps.comfy);
  try {
    const result = resolveResolution(
      { classType: ratioNode.class_type, inputs: ratioNode.inputs },
      specs.get(ratioNode.class_type),
      enumValue,
      megapixels,
      profile.workflow
    );
    sendSuccess(response, result, requestId);
  } catch (error) {
    if (error instanceof ResolutionUnsupportedError) {
      throw httpError('INVALID_GENERATION_PARAMS', error.message);
    }
    throw error;
  }
}

async function dependencyCheck(
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  workflowId: string
): Promise<void> {
  const profile = await deps.catalog.requireCurrent(workflowId);
  const report = await deps.comfy.inspectDependencies(profile.workflow);
  if (!report.connected) {
    throw httpError('COMFY_UNREACHABLE', '无法连接到 ComfyUI，请检查地址和服务状态。', { retryable: true });
  }
  sendSuccess(response, dependencyPayload(report), requestId);
}

// ---------- ai/expand（S7 / API §6：custom_llm 文本扩写，只扩写不建任务） ----------

/**
 * POST /workflows/:id/ai/expand：comfyui_clip 模式由 App 侧约束不调用本端点（server 保持通用）；
 * 建任务时的 aiExpansionMode 保证图内不重复扩写（SERVER §8）。
 * system prompt 回退链：档案 preferences.aiSystemPrompt → 档案内 [params{string}-ai扩写提示词] 参数值 → 内置兜底（aiExpansion.ts）。
 */
async function aiExpand(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: WorkflowRoutesDeps,
  preferences: PreferencesStore,
  workflowId: string
): Promise<void> {
  const body = await readJsonBody(request);
  const profile = await deps.catalog.requireCurrent(workflowId);
  const prompt = recordField(body, 'prompt');
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供非空 prompt（原始提示词）。');
  }
  const hasSystemPrompt = typeof body === 'object' && body !== null && !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, 'aiSystemPrompt');
  const requestedSystemPrompt = recordField(body, 'aiSystemPrompt');
  if (hasSystemPrompt && typeof requestedSystemPrompt !== 'string') {
    throw httpError('INVALID_REQUEST', 'aiSystemPrompt 必须是字符串。');
  }
  const config: AiConfig = (await loadConfig()).ai;
  const saved = preferences.getPreferences(profile);
  const systemPrompt = typeof requestedSystemPrompt === 'string'
    ? requestedSystemPrompt
    : resolveSavedSystemPrompt(profile, saved);
  try {
    const result = await expandPrompt(config, prompt, systemPrompt);
    sendSuccess(response, {
      expandedPrompt: result.expandedPrompt,
      providerName: result.providerName,
      model: result.model
    }, requestId);
  } catch (error) {
    // 领域错误码 → HTTP 契约（API §2/§6）；不回显 provider 响应体与密钥材料。
    if (error instanceof Error && error.message === 'AI_NOT_CONFIGURED') {
      throw httpError('AI_NOT_CONFIGURED', '自定义 LLM 未配置完整（需开启开关并填好 endpoint、model 与密钥）。');
    }
    if (error instanceof Error && error.message === 'AI_TIMEOUT') {
      throw httpError('AI_TIMEOUT', '扩写请求超时，可重试或改用原提示词。');
    }
    if (error instanceof Error && error.message === 'AI_RESPONSE_INVALID') {
      throw httpError('AI_RESPONSE_INVALID', 'LLM 响应格式无法解析，请稍后重试或更换模型。');
    }
    if (error instanceof Error && error.message === 'AI_PROVIDER_ERROR') {
      throw httpError('AI_PROVIDER_ERROR', 'LLM 服务返回错误，请稍后重试或检查服务状态。');
    }
    throw error;
  }
}

// ---------- 共用辅助 ----------

/** ComfyUI object_info 规格加载；网络级失败（无 HTTP status）→ 503，HTTP 级失败 → 502（结构化返回，API §2）。 */
async function loadObjectInfoSpecs(comfy: ComfyClient, force = false): Promise<Map<string, ObjectInfoNodeSpec>> {
  try {
    return normalizeObjectInfo(await comfy.getObjectInfo(force));
  } catch (error) {
    if (error instanceof ComfyHttpError && error.status !== undefined) {
      throw httpError('COMFY_ERROR', `ComfyUI 请求失败：${error.message}`);
    }
    throw httpError('COMFY_UNREACHABLE', '无法连接到 ComfyUI，请检查地址和服务状态。', { retryable: true });
  }
}

function dependencyPayload(report: DependencyReport): Record<string, unknown> {
  return {
    connected: report.connected,
    missingNodes: report.missingNodes,
    missingModels: report.missingModels,
    missingLoras: report.missingLoras.map((loraName) => {
      const lora = report.loras.find((entry) => entry.loraName === loraName);
      return { nodeId: lora?.nodeId ?? null, loraName, enabled: lora?.enabled ?? true };
    }),
    mappingErrors: report.mappingErrors
  };
}

/** 列表项（API §5 文字字段 + 能力摘要提案形状 {parameterCount, loraCount}，OQ #2 待主控冻结）。 */
function profileSummary(profile: WorkflowProfileRecord): Record<string, unknown> {
  return {
    workflowId: profile.id,
    name: profile.name,
    supportedModes: availableProfileModes(profile),
    isDefault: profile.isDefault,
    fingerprint: profile.fingerprint,
    updatedAt: profile.updatedAt,
    capabilitySummary: {
      parameterCount: profile.analysis.parameters.length,
      loraCount: profile.analysis.loras.length
    }
  };
}

function recordField(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

function resolveSavedSystemPrompt(
  profile: WorkflowProfileRecord,
  saved: ReturnType<PreferencesStore['getPreferences']>
): string | undefined {
  if (saved.aiSystemPrompt.trim().length > 0) return saved.aiSystemPrompt;
  const parameters = findSystemPromptParameters(profile.workflow, profile.analysis.parameters);
  for (const parameter of parameters) {
    const preference = saved.parameters.find((candidate) =>
      String(candidate.nodeId) === String(parameter.nodeId) && candidate.inputName === parameter.inputName);
    if (typeof preference?.value === 'string' && preference.value.trim().length > 0) return preference.value;
  }
  for (const parameter of parameters) {
    if (typeof parameter.value === 'string' && parameter.value.trim().length > 0) return parameter.value;
  }
  return undefined;
}
