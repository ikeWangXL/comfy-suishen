import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AppDatabase } from './database.js';
import { getDatabasePath, loadConfig, saveConfig, type ServerConfig } from './config.js';
import { protectSecret, unprotectSecret } from './secretStore.js';
import { AiModelListError, aiBaseUrl, listAiModels, savedHeaders } from './aiExpansion.js';
import { lanIpv4Addresses } from './lanAddresses.js';
import { consoleCss, consoleJs, consolePage } from './consolePage.js';
import { newRequestId, sendError, sendSuccess } from './http/envelope.js';
import { HttpError, httpError, normalizeError } from './http/errors.js';
import { authenticateBearer, isPrivateLanAddress, readJsonBody } from './http/middleware.js';
import { createEventsChannel, type EventsChannel } from './http/events.js';
import { AccountStore } from './auth/accountStore.js';
import { handleAuthRoutes } from './auth/routes.js';
import { ComfyClient } from './comfy/ComfyClient.js';
import { handleLocalRoutes, recordDiagnostic } from './local/routes.js';
import { BackupStore } from './backup.js';
import { GalleryStore } from './galleryStore.js';
import { handleStorageRoutes } from './storage/routes.js';
import { handleWorkflowRoutes } from './workflows/routes.js';
import { WorkflowProfileStore } from './workflows/profileStore.js';
import { WorkflowCatalog } from './workflows/catalog.js';
import { initializeLegacyWorkflowFiles } from './workflows/workflowFiles.js';
import { JobQueue } from './jobQueue.js';
import { handleJobsRoutes, type JobsRoutesDeps } from './jobs/routes.js';

const API_PREFIX = '/api/v1';
const SERVER_VERSION = '1.1.0';
const API_VERSION = '1.1';

/** S8 接线：本机控制台域路由依赖（backup 持有 database；运行态切换经 gallery/comfy 引用生效）。 */
interface LocalRoutesContext {
  gallery: GalleryStore;
  comfy: ComfyClient;
  backup: BackupStore;
  startedAt: string;
  serverVersion: string;
  apiVersion: string;
  consolePort: number;
  apiPort: number;
}

interface RequestContext {
  accountStore: AccountStore;
  serverId: string;
  workflows: WorkflowRoutesContext;
  storage: StorageRoutesContext;
  jobs: JobsRoutesDeps;
  local: LocalRoutesContext;
  buildStatusSnapshot: () => Promise<Record<string, unknown>>;
}

/** S4 接线：工作流域路由依赖（路由挂载在 main，ComfyClient/事件通道/数据库在此注入）。 */
interface WorkflowRoutesContext {
  database: AppDatabase;
  comfy: ComfyClient;
  catalog: WorkflowCatalog;
}

/** S6 接线：存储/图库域路由依赖（gallery 根目录随 config.galleryRoot 初始化，PUT /storage/root 时同步切换）。 */
interface StorageRoutesContext {
  database: AppDatabase;
  gallery: GalleryStore;
  events: EventsChannel;
  catalog: WorkflowCatalog;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const config = await loadConfig();
  validatePorts(config);
  const database = new AppDatabase(getDatabasePath());
  initializeLegacyWorkflowFiles(database);
  for (const migration of database.getAppliedMigrations()) {
    recordDiagnostic('database', 'info', `数据库迁移版本 v${migration.version}（${migration.name}）已应用。`);
  }
  if (database.preMigrationBackupFile) {
    recordDiagnostic('database', 'info', `本轮启动应用了新迁移，迁移前数据库备份：${database.preMigrationBackupFile}。`);
  }
  const accountStore = new AccountStore(database);
  await accountStore.ensureOwnerAccount();

  // serverId 沿用 settings 既有值（V1 已持久化），缺失时生成，保证升级后稳定（方案 §3.2）。
  let serverId = database.getSetting<string>('serverId');
  if (!serverId) {
    serverId = randomUUID();
    database.setSetting('serverId', serverId);
  }

  const events = createEventsChannel(async (token) => accountStore.verifyToken(token));
  const comfy = new ComfyClient(config.comfyBaseUrl);
  const catalog = new WorkflowCatalog(database, comfy, events.emit);
  const stopWatchingWorkflows = catalog.watch();
  void catalog.refresh().catch((error: unknown) => console.error('[workflows] 初始化同步失败：', error));
  const gallery = new GalleryStore(database, config.galleryRoot);
  const backup = new BackupStore({ database, gallery, comfy });
  const jobQueue = new JobQueue(database, gallery, comfy, events.emit);
  const context: RequestContext = {
    accountStore,
    serverId,
    workflows: { database, comfy, catalog },
    storage: { database, gallery, events, catalog },
    jobs: { queue: jobQueue, database, gallery, comfy, catalog },
    local: {
      gallery,
      comfy,
      backup,
      startedAt,
      serverVersion: SERVER_VERSION,
      apiVersion: API_VERSION,
      consolePort: config.port,
      apiPort: config.apiPort
    },
    buildStatusSnapshot: buildStatusSnapshotBuilder({ gallery, comfy, database, jobQueue })
  };

  const apiServer = createServer((request, response) => {
    void handleRequest(request, response, false, context);
  });
  apiServer.on('upgrade', (request, socket, head) => {
    events.handleUpgrade(request, socket, head);
  });
  const consoleServer = createServer((request, response) => {
    void handleRequest(request, response, true, context);
  });

  consoleServer.listen(config.port, '127.0.0.1', () => {
    console.log(`Local console: http://127.0.0.1:${config.port}/`);
  });
  apiServer.listen(config.apiPort, config.host, () => {
    console.log(`Comfy App HTTP API listening on ${config.host}:${config.apiPort} (API ${API_VERSION}, server ${SERVER_VERSION})`);
    for (const address of lanIpv4Addresses()) {
      console.log(`Comfy App LAN address: http://${address}:${config.apiPort}`);
    }
    console.log('若 App 无法连接：确认同一局域网、地址与端口正确，并检查 Windows 防火墙允许规则。');
    recordDiagnostic('server', 'info', `服务已启动：API ${config.host}:${config.apiPort}，控制台 http://127.0.0.1:${config.port}/。`);
  });

  // 重启恢复（SERVER §9.2）：queued 重提交、running/cancelling 先对账。
  void jobQueue.enqueueForRecovery();

  // 30s 状态广播（API §4/§9）：server.status 快照；防重叠单飞广播。
  let snapshotInFlight = false;
  const statusTimer = setInterval(() => {
    if (snapshotInFlight) return;
    snapshotInFlight = true;
    void catalog.refresh()
      .then(() => context.buildStatusSnapshot())
      .then((snapshot) => events.emit('server.status', snapshot))
      .catch((error: unknown) => console.error('[status] 状态快照广播失败：', error))
      .finally(() => { snapshotInFlight = false; });
  }, 30_000);

  const shutdown = (): void => {
    clearInterval(statusTimer);
    stopWatchingWorkflows();
    events.close();
    let closedServers = 0;
    const onClosed = (): void => {
      if (++closedServers < 2) return;
      database.close();
      process.exit(0);
    };
    apiServer.close(onClosed);
    consoleServer.close(onClosed);
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/** /status 快照（API §4 六组字段）：comfy 用 system_stats 尽力探测、storage 复用 S6 快照、queue 取内存汇总。 */
function buildStatusSnapshotBuilder(deps: {
  gallery: GalleryStore;
  comfy: ComfyClient;
  database: AppDatabase;
  jobQueue: JobQueue;
}): () => Promise<Record<string, unknown>> {
  const profileStore = new WorkflowProfileStore(deps.database);
  return async () => {
    const [comfyProbe, storage, { ai }] = await Promise.all([
      deps.comfy.probeSystemStats(),
      deps.gallery.getStorageStatus(),
      loadConfig()
    ]);
    const endpoint = ai.endpoint.trim();
    return {
      server: { running: true, version: SERVER_VERSION, apiVersion: API_VERSION },
      comfy: {
        connected: comfyProbe.connected,
        baseUrl: deps.comfy.baseUrlText,
        version: comfyProbe.version,
        lastCheckedAt: new Date().toISOString(),
        errorCode: comfyProbe.connected ? null : 'COMFY_UNREACHABLE',
        message: comfyProbe.connected ? null : '无法连接到 ComfyUI，请检查地址和服务状态。'
      },
      storage,
      workflows: {
        count: profileStore.listProfiles().length,
        defaultWorkflowId: profileStore.getDefaultProfile()?.id ?? null
      },
      queue: deps.jobQueue.summary(),
      ai: {
        enabled: ai.enabled,
        configured: endpoint.length > 0 && ai.model.trim().length > 0,
        providerName: endpoint.length > 0 ? endpointHost(endpoint) : null,
        model: ai.model.trim().length > 0 ? ai.model.trim() : null,
        hasApiKey: ai.apiKeyProtected !== null
      }
    };
  };
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

// ---------- ai/settings（S7 / API §6：自定义 LLM 配置；密钥只进不出） ----------

/** 非敏感回显形状：密钥永不回显，仅 hasApiKey（= apiKeyProtected 是否存在）。 */
function aiSettingsPayload(ai: ServerConfig['ai']): Record<string, unknown> {
  const endpoint = ai.endpoint.trim();
  return {
    enabled: ai.enabled,
    endpoint: ai.endpoint,
    model: ai.model,
    providerName: endpoint.length > 0 ? endpointHost(endpoint) : null,
    hasApiKey: ai.apiKeyProtected !== null,
    headerNames: ai.headerNames,
    reasoningEffort: ai.reasoningEffort,
    maxTokens: ai.maxTokens
  };
}

async function getAiSettings(response: ServerResponse, requestId: string): Promise<void> {
  const config = await loadConfig();
  sendSuccess(response, aiSettingsPayload(config.ai), requestId);
}

/**
 * PUT /ai/settings（API §6）：enabled/endpoint/model 直写；apiKey 仅在传入时经 DPAPI 保护落盘，
 * 省略表示保留旧密钥；clearApiKey=true 清除。endpoint 需 https 或本机 http（密钥不走出网明文链路）。
 */
async function putAiSettings(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
  const record = aiRequestRecord(await readJsonBody(request));
  const config = await loadConfig();
  const ai = { ...config.ai };
  const endpoint = readAiEndpoint(record.endpoint, ai.endpoint);
  if (endpoint !== readAiEndpoint(undefined, ai.endpoint)) {
    ai.apiKeyProtected = null;
    ai.headerNames = [];
    ai.headersProtected = null;
    ai.model = '';
  }
  ai.endpoint = endpoint;

  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') throw httpError('INVALID_REQUEST', 'enabled 必须是布尔值。');
    ai.enabled = record.enabled;
  }
  if (record.model !== undefined) {
    if (typeof record.model !== 'string') throw httpError('INVALID_REQUEST', 'model 必须是字符串。');
    ai.model = record.model.trim();
  }
  if (record.clearApiKey === true) {
    ai.apiKeyProtected = null;
  }
  if (record.apiKey !== undefined) {
    if (typeof record.apiKey !== 'string' || record.apiKey.length === 0) {
      throw httpError('INVALID_REQUEST', 'apiKey 需为非空字符串（清除密钥请使用 clearApiKey）。');
    }
    ai.apiKeyProtected = await protectSecret(record.apiKey);
  }
  if (record.headers !== undefined) {
    const headers = readCustomHeaders(record.headers);
    ai.headerNames = Object.keys(headers);
    ai.headersProtected = ai.headerNames.length > 0 ? await protectSecret(JSON.stringify(headers)) : null;
  }
  if (record.reasoningEffort !== undefined) {
    if (typeof record.reasoningEffort !== 'string' ||
        !['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(record.reasoningEffort)) {
      throw httpError('INVALID_REQUEST', '思考强度无效。');
    }
    ai.reasoningEffort = record.reasoningEffort;
  }
  if (record.maxTokens !== undefined) {
    const max = record.maxTokens;
    if (max !== null && (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1)) {
      throw httpError('INVALID_REQUEST', '最大 Token 数须为正整数。');
    }
    ai.maxTokens = max;
  }

  config.ai = ai;
  await saveConfig(config);
  sendSuccess(response, aiSettingsPayload(ai), requestId);
}

function aiRequestRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw httpError('INVALID_REQUEST', '请求体必须是 JSON 对象。');
  }
  return body as Record<string, unknown>;
}

function readAiEndpoint(value: unknown, fallback: string): string {
  const endpoint = value === undefined ? fallback : value;
  if (typeof endpoint === 'string') {
    if (!endpoint.trim()) return '';
    try { return aiBaseUrl(endpoint.trim()); } catch {
      throw httpError('INVALID_REQUEST', 'Base URL 需为 HTTPS 或本机回环 HTTP 地址，且不包含账号、查询或片段。');
    }
  }
  throw httpError('INVALID_REQUEST', 'Base URL 必须是字符串。');
}

function readCustomHeaders(value: unknown): Record<string, string> {
  const headers = new Headers();
  for (const [name, content] of Object.entries(aiRequestRecord(value))) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof content !== 'string' ||
      /[^\x20-\x7e]/.test(content) ||
      /^(authorization|proxy-.*|cookie|content-.*|host|connection|transfer-encoding|upgrade|te|trailer|expect|keep-alive)$/i.test(name)) {
      throw httpError('INVALID_REQUEST', '自定义请求头名称或值不受支持。');
    }
    try { headers.set(name, content); } catch {
      throw httpError('INVALID_REQUEST', '自定义请求头的格式无效。');
    }
  }
  return Object.fromEntries(headers);
}

async function probeAiModels(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
  const record = aiRequestRecord(await readJsonBody(request));
  const { ai } = await loadConfig();
  const endpoint = readAiEndpoint(record.endpoint, ai.endpoint);
  const sameProvider = endpoint === readAiEndpoint(undefined, ai.endpoint);
  const proposedHeaders = record.headers === undefined ? undefined : readCustomHeaders(record.headers);
  if (record.apiKey !== undefined && (typeof record.apiKey !== 'string' || !record.apiKey.trim())) {
    throw httpError('INVALID_REQUEST', 'API Key 必须是非空字符串。');
  }
  const hasSavedKey = sameProvider && ai.apiKeyProtected !== null;
  if (!endpoint || (!record.apiKey && !hasSavedKey)) {
    throw httpError('AI_NOT_CONFIGURED', '请先填写 Base URL 和 API Key。');
  }
  try {
    const key = typeof record.apiKey === 'string' ? record.apiKey :
      await unprotectSecret(ai.apiKeyProtected!);
    const headers = proposedHeaders ?? (sameProvider ? await savedHeaders(ai) : {});
    sendSuccess(response, { models: await listAiModels(endpoint, key, headers) }, requestId);
  } catch (error) {
    if (error instanceof AiModelListError) {
      throw httpError('AI_PROVIDER_ERROR', error.message);
    }
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw httpError('AI_TIMEOUT', '读取供应商模型列表超时，请稍后重试。');
    }
    throw httpError('AI_PROVIDER_ERROR', '无法获取供应商模型列表，请检查 Base URL、API Key 和自定义请求头。');
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, isConsolePort: boolean, context: RequestContext): Promise<void> {
  const requestId = newRequestId();
  try {
    await dispatch(request, response, isConsolePort, requestId, context);
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error(`[${requestId}] 未分类错误：`, error);
    }
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendError(response, normalizeError(error), requestId);
  }
}

async function dispatch(request: IncomingMessage, response: ServerResponse, isConsolePort: boolean, requestId: string, context: RequestContext): Promise<void> {
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    throw httpError('INVALID_REQUEST', '请求地址无效。');
  }
  const pathname = url.pathname;

  if (isConsolePort) {
    if (request.method === 'GET' && pathname === '/') {
      sendConsolePage(response);
      return;
    }
    if (request.method === 'GET' && pathname === '/console.css') {
      sendConsoleAsset(response, consoleCss, 'text/css; charset=utf-8');
      return;
    }
    if (request.method === 'GET' && pathname === '/console.js') {
      sendConsoleAsset(response, consoleJs, 'text/javascript; charset=utf-8');
      return;
    }
    if (pathname === '/local/api' || pathname.startsWith('/local/api/')) {
      await handleLocalRoutes(request, response, url, requestId, {
        verifyToken: async (token) => context.accountStore.verifyToken(token),
        ...context.local
      });
      return;
    }
  } else if (!isPrivateLanAddress(request.socket.remoteAddress ?? '')) {
    // API 层局域网准入（保留资产，方案 §3.3）；控制台端口只绑回环，不适用此门。
    throw httpError('FORBIDDEN', '此服务只接受局域网连接。');
  }

  if (request.method === 'GET' && pathname === `${API_PREFIX}/health`) {
    sendSuccess(response, { reachable: true, serverVersion: SERVER_VERSION, apiVersion: API_VERSION }, requestId);
    return;
  }
  if (request.method === 'POST' && pathname === `${API_PREFIX}/auth/login`) {
    await handleAuthRoutes(request, response, url, requestId, authDeps(context));
    return;
  }
  const isApiPath = pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
  if (!isApiPath) {
    throw httpError('NOT_FOUND', '接口不存在。');
  }

  // 非豁免 /api/v1/* 一律先过 Bearer（无效/缺失 401，先于 404，不泄露端点存在性）。
  // 鉴权豁免面（裁决 Q3）：GET /health、POST /auth/login，以及 gallery/images/:id/thumbnail 与 /file
  // 两端点（静态资源直出，App Image 无法携带 header）——仅此两端点，其他端点不得复用豁免。
  const isGalleryAssetPath = /^\/api\/v1\/gallery\/images\/[^/]+\/(?:thumbnail|file)$/.test(pathname);
  await authenticateBearer(request, pathname, {
    exemptPaths: isGalleryAssetPath ? [pathname] : undefined,
    verifyToken: async (token) => context.accountStore.verifyToken(token)
  });

  if (pathname.startsWith(`${API_PREFIX}/auth/`)) {
    await handleAuthRoutes(request, response, url, requestId, authDeps(context));
    return;
  }
  if (pathname.startsWith(`${API_PREFIX}/workflows`)) {
    await handleWorkflowRoutes(request, response, url, requestId, context.workflows);
    return;
  }
  if (request.method === 'GET' && pathname === `${API_PREFIX}/status`) {
    sendSuccess(response, await context.buildStatusSnapshot(), requestId);
    return;
  }
  if (pathname === `${API_PREFIX}/ai/settings`) {
    if (request.method === 'GET') return getAiSettings(response, requestId);
    if (request.method === 'PUT') return putAiSettings(request, response, requestId);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (request.method === 'POST' && pathname === `${API_PREFIX}/ai/models`) {
    return probeAiModels(request, response, requestId);
  }
  if (pathname.startsWith(`${API_PREFIX}/jobs`)) {
    await handleJobsRoutes(request, response, url, requestId, context.jobs);
    return;
  }
  if (pathname.startsWith(`${API_PREFIX}/storage`) || pathname.startsWith(`${API_PREFIX}/filesystem`) ||
    pathname.startsWith(`${API_PREFIX}/models`) || pathname.startsWith(`${API_PREFIX}/gallery`)) {
    await handleStorageRoutes(request, response, url, requestId, context.storage);
    return;
  }
  throw httpError('NOT_FOUND', '接口不存在。');
}

function authDeps(context: RequestContext) {
  return {
    accountStore: context.accountStore,
    serverId: context.serverId,
    serverVersion: SERVER_VERSION,
    apiVersion: API_VERSION
  };
}

function sendConsolePage(response: ServerResponse): void {
  if (response.headersSent) return;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(consolePage);
}

function sendConsoleAsset(response: ServerResponse, content: string, contentType: string): void {
  if (response.headersSent) return;
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
  response.end(content);
}

function validatePorts(config: ServerConfig): void {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
    !Number.isInteger(config.apiPort) || config.apiPort < 1 || config.apiPort > 65535 || config.port === config.apiPort) {
    throw new Error('本机控制台端口与 API 端口配置无效。');
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Server startup failed');
  process.exitCode = 1;
});
