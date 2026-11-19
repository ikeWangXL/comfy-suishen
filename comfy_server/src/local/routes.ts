import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess } from '../http/envelope.js';
import { httpError } from '../http/errors.js';
import { authenticateBearer, isLoopbackRequest, readJsonBody } from '../http/middleware.js';
import { loadConfig, saveConfig } from '../config.js';
import { setWindowsAutoStart } from '../autoStart.js';
import { lanIpv4Addresses } from '../lanAddresses.js';
import type { ComfyClient } from '../comfy/ComfyClient.js';
import type { GalleryStore } from '../galleryStore.js';
import { BackupStore } from '../backup.js';
import {
  assertPathWritable,
  assertRealDirectoryTree,
  normalizeWindowsDirectoryPath
} from '../storage/filesystem.js';

export interface LocalRoutesDeps {
  verifyToken: (token: string) => Promise<boolean>;
  gallery: GalleryStore;
  comfy: ComfyClient;
  backup: BackupStore;
  startedAt: string;
  serverVersion: string;
  apiVersion: string;
  consolePort: number;
  apiPort: number;
}

/**
 * 本机网页控制台接口域（S8 / API §10）：仅绑定 127.0.0.1:8787 的控制台调用，App 不调用。
 * 双重校验门（方案 §3.3）：回环显式校验 + 强制 Bearer（与 /api/v1 同一 owner 会话）。
 * 页面视觉/内容归 app-UI 线程；本文件只提供契约端点与诊断摘要。
 */
export async function handleLocalRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  requestId: string,
  deps: LocalRoutesDeps
): Promise<void> {
  if (!isLoopbackRequest(request)) {
    throw httpError('FORBIDDEN', '本机控制台接口仅限本机访问。');
  }
  await authenticateBearer(request, url.pathname, { verifyToken: deps.verifyToken });

  const pathname = url.pathname;
  const method = request.method ?? '';

  if (pathname === '/local/api/config') {
    if (method === 'GET') return getLocalConfig(response, requestId, deps);
    if (method === 'PUT') return putLocalConfig(request, response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === '/local/api/config/comfy') {
    if (method === 'PUT') return putComfyConfig(request, response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === '/local/api/config/comfy/test') {
    if (method === 'POST') return testComfyConfig(request, response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === '/local/api/service') {
    if (method === 'GET') return getServiceStatus(response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === '/local/api/service/autostart') {
    if (method === 'GET') return getAutostart(response, requestId, deps);
    if (method === 'PUT') return putAutostart(request, response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === '/local/api/backups') {
    if (method === 'POST') return createBackup(response, requestId, deps);
    if (method === 'GET') return listBackups(response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === '/local/api/backups/restore') {
    if (method === 'POST') return restoreBackup(request, response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === '/local/api/logs/diagnostics') {
    if (method === 'GET') return getDiagnostics(response, requestId);
    throw httpError('NOT_FOUND', '接口不存在。');
  }

  throw httpError('NOT_FOUND', '接口不存在。');
}

// ---------- 诊断摘要（脱敏环缓冲；SERVER §12：不记录密码、token、AI key、完整 prompt） ----------

export type DiagnosticLevel = 'info' | 'warn' | 'error';

export interface DiagnosticEntry {
  at: string;
  level: DiagnosticLevel;
  kind: 'server' | 'database' | 'comfy' | 'config' | 'autostart' | 'backup';
  message: string;
}

const MAX_DIAGNOSTIC_ENTRIES = 200;
const diagnostics: DiagnosticEntry[] = [];

/** 供 main.ts 与本域各端点写入；只收非敏感文本，环形上限 200 条。 */
export function recordDiagnostic(kind: DiagnosticEntry['kind'], level: DiagnosticLevel, message: string): void {
  diagnostics.push({ at: new Date().toISOString(), level, kind, message });
  if (diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTIC_ENTRIES);
}

function getDiagnostics(response: ServerResponse, requestId: string): void {
  sendSuccess(response, { generatedAt: new Date().toISOString(), entries: [...diagnostics] }, requestId);
}

// ---------- config / config/comfy（API §10：读取或保存本机服务配置） ----------

/** 控制台拥有字段 = ComfyUI 地址、图库根目录、自启（SERVER §12：App 不可改的三项即控制台可改项）。 */
function localConfigPayload(config: { comfyBaseUrl: string; galleryRoot: string; autoStart: boolean }): Record<string, unknown> {
  return { config: { comfyBaseUrl: config.comfyBaseUrl, galleryRoot: config.galleryRoot, autoStart: config.autoStart } };
}

async function getLocalConfig(response: ServerResponse, requestId: string, deps: LocalRoutesDeps): Promise<void> {
  const config = await loadConfig();
  sendSuccess(response, localConfigPayload(config), requestId);
}

async function putLocalConfig(request: IncomingMessage, response: ServerResponse, requestId: string, deps: LocalRoutesDeps): Promise<void> {
  const body = await readJsonBody(request);
  const patch = readConfigPatch(body, ['comfyBaseUrl', 'galleryRoot', 'autoStart']);
  const config = await applyLocalConfig(patch, deps);
  sendSuccess(response, localConfigPayload(config), requestId);
}

async function putComfyConfig(request: IncomingMessage, response: ServerResponse, requestId: string, deps: LocalRoutesDeps): Promise<void> {
  const body = await readJsonBody(request);
  const patch = readConfigPatch(body, ['comfyBaseUrl']);
  const config = await applyLocalConfig(patch, deps);
  sendSuccess(response, localConfigPayload(config), requestId);
}

function readConfigPatch(body: unknown, allowedKeys: readonly string[]): Partial<{ comfyBaseUrl: string; galleryRoot: string; autoStart: boolean }> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw httpError('INVALID_REQUEST', '请求体必须是 JSON 对象。');
  }
  const record = body as Record<string, unknown>;
  const patch: Partial<{ comfyBaseUrl: string; galleryRoot: string; autoStart: boolean }> = {};
  if (allowedKeys.includes('comfyBaseUrl') && record.comfyBaseUrl !== undefined) {
    if (typeof record.comfyBaseUrl !== 'string') throw httpError('INVALID_REQUEST', 'comfyBaseUrl 必须是字符串。');
    patch.comfyBaseUrl = validateComfyBaseUrl(record.comfyBaseUrl);
  }
  if (allowedKeys.includes('galleryRoot') && record.galleryRoot !== undefined) {
    if (typeof record.galleryRoot !== 'string') throw httpError('INVALID_REQUEST', 'galleryRoot 必须是字符串。');
    patch.galleryRoot = record.galleryRoot.trim().length === 0 ? '' : validateGalleryRoot(record.galleryRoot);
  }
  if (allowedKeys.includes('autoStart') && record.autoStart !== undefined) {
    if (typeof record.autoStart !== 'boolean') throw httpError('INVALID_REQUEST', 'autoStart 必须是布尔值。');
    patch.autoStart = record.autoStart;
  }
  return patch;
}

/** ComfyUI 地址形状校验（控制台改地址）：http(s) URL、无账号信息；本地与局域网 http 均允许（App 不直连 ComfyUI）。 */
function validateComfyBaseUrl(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw httpError('INVALID_REQUEST', 'ComfyUI 地址不是合法 URL（示例 http://127.0.0.1:8188）。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError('INVALID_REQUEST', 'ComfyUI 地址需以 http:// 或 https:// 开头。');
  }
  if (url.username || url.password) {
    throw httpError('INVALID_REQUEST', 'ComfyUI 地址不应包含账号信息。');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw httpError('INVALID_REQUEST', 'ComfyUI 地址只到根路径（示例 http://127.0.0.1:8188），不要带子路径。');
  }
  return value;
}

/** 图库根目录校验与 PUT /api/v1/storage/root 同口径（存在+逐级真实目录+可写，S6 助手）。 */
function validateGalleryRoot(raw: string): string {
  const target = normalizeWindowsDirectoryPath(raw);
  assertRealDirectoryTree(target);
  assertPathWritable(target);
  return target;
}

/** 配置落定（持久化 + 运行态同步：Comfy 地址换实例缓存失效、图库根即时切换、自启落 Startup 文件）。 */
async function applyLocalConfig(
  patch: Partial<{ comfyBaseUrl: string; galleryRoot: string; autoStart: boolean }>,
  deps: LocalRoutesDeps
): Promise<{ comfyBaseUrl: string; galleryRoot: string; autoStart: boolean }> {
  const config = await loadConfig();
  const changes: string[] = [];
  if (patch.comfyBaseUrl !== undefined && patch.comfyBaseUrl !== config.comfyBaseUrl) {
    config.comfyBaseUrl = patch.comfyBaseUrl;
    deps.comfy.setBaseUrl(config.comfyBaseUrl);
    changes.push(`ComfyUI 地址 → ${config.comfyBaseUrl}`);
  }
  if (patch.galleryRoot !== undefined && patch.galleryRoot !== config.galleryRoot) {
    config.galleryRoot = patch.galleryRoot;
    deps.gallery.setRoot(config.galleryRoot);
    changes.push(`图库根目录 → ${config.galleryRoot === '' ? '（未配置）' : config.galleryRoot}`);
  }
  if (patch.autoStart !== undefined && patch.autoStart !== config.autoStart) {
    try {
      await setWindowsAutoStart(patch.autoStart);
    } catch (error) {
      throw httpError('INTERNAL_ERROR', `设置 Windows 自启失败：${(error as Error).message}`);
    }
    config.autoStart = patch.autoStart;
    changes.push(`开机自启 → ${config.autoStart ? '开' : '关'}`);
  }
  await saveConfig(config);
  if (changes.length > 0) {
    recordDiagnostic('config', 'info', `本机配置已保存：${changes.join('；')}。`);
  }
  return { comfyBaseUrl: config.comfyBaseUrl, galleryRoot: config.galleryRoot, autoStart: config.autoStart };
}

// ---------- config/comfy/test（API §10：测试 ComfyUI 并返回可读结果，含耗时） ----------

const COMFY_TEST_TIMEOUT_MS = 5_000;

async function testComfyConfig(request: IncomingMessage, response: ServerResponse, requestId: string, deps: LocalRoutesDeps): Promise<void> {
  const body = await readJsonBody(request);
  let testedUrl: string;
  if (isRecord(body) && typeof body.comfyBaseUrl === 'string' && body.comfyBaseUrl.trim().length > 0) {
    // 测试不落盘：输入地址可先测后存（控制台"地址→测试→保存"动线）。
    testedUrl = validateComfyBaseUrl(body.comfyBaseUrl);
  } else {
    testedUrl = (await loadConfig()).comfyBaseUrl;
  }
  const result = await probeComfy(testedUrl);
  recordDiagnostic('comfy', result.connected ? 'info' : 'warn', `ComfyUI 测试 ${testedUrl}：${result.message}`);
  sendSuccess(response, { ...result, testedUrl }, requestId);
}

interface ComfyTestResult {
  connected: boolean;
  elapsedMs: number;
  version: string | null;
  message: string;
}

/** 测试 = GET /system_stats（连通+版本判定的最轻量端点），5s 超时，失败给用户可读原因。 */
async function probeComfy(testedUrl: string): Promise<ComfyTestResult> {
  const started = performance.now();
  let url: URL;
  try {
    url = new URL(`${testedUrl.replace(/\/$/, '')}/system_stats`);
  } catch {
    return { connected: false, elapsedMs: 0, version: null, message: 'ComfyUI 地址不是合法 URL。' };
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(COMFY_TEST_TIMEOUT_MS) });
    const elapsedMs = Math.round(performance.now() - started);
    if (!response.ok) {
      return {
        connected: false,
        elapsedMs,
        version: null,
        message: `ComfyUI 返回了 HTTP ${response.status}：该地址可能是其他服务，或不是 ComfyUI 根地址。`
      };
    }
    let version: string | null = null;
    try {
      const stats = (await response.json()) as { system?: { comfyui_version?: unknown } };
      version = typeof stats.system?.comfyui_version === 'string' ? stats.system.comfyui_version : null;
    } catch {
      version = null;
    }
    return {
      connected: true,
      elapsedMs,
      version,
      message: `已连接 ComfyUI${version ? `（版本 ${version}）` : ''}，耗时 ${elapsedMs} ms。`
    };
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - started);
    return { connected: false, elapsedMs, version: null, message: describeComfyFailure(error) };
  }
}

function describeComfyFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `连接超时（${COMFY_TEST_TIMEOUT_MS / 1000} 秒）：ComfyUI 未响应，请确认已启动、地址和端口正确。`;
  }
  // Node fetch 失败的根因在 cause（可能直接带 code，或包在 AggregateError.errors 里）。
  const cause = (error as { cause?: { code?: string; errors?: Array<{ code?: string }> } }).cause;
  const codes = new Set<string>([
    ...(typeof cause?.code === 'string' ? [cause.code] : []),
    ...(Array.isArray(cause?.errors) ? cause.errors.flatMap((entry) => typeof entry?.code === 'string' ? [entry.code] : []) : [])
  ]);
  if (codes.has('ECONNREFUSED')) {
    return '连接被拒绝：该地址端口上没有服务在监听，请确认 ComfyUI 已启动、端口正确。';
  }
  if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
    return '无法解析主机名：请检查 ComfyUI 地址拼写。';
  }
  if (codes.has('EHOSTUNREACH') || codes.has('ENETUNREACH')) {
    return '网络不可达：请确认目标电脑与本机在同一网络。';
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `无法连接到 ComfyUI：${detail}`;
}

// ---------- service（API §10：服务状态、版本、LAN 地址和诊断） ----------

async function getServiceStatus(response: ServerResponse, requestId: string, deps: LocalRoutesDeps): Promise<void> {
  const startedMs = Date.parse(deps.startedAt);
  const [comfyProbe, storage] = await Promise.all([
    deps.comfy.probeSystemStats(),
    deps.gallery.getStorageStatus()
  ]);
  sendSuccess(response, {
    server: {
      running: true,
      version: deps.serverVersion,
      apiVersion: deps.apiVersion,
      startedAt: deps.startedAt,
      uptimeSeconds: Number.isFinite(startedMs) ? Math.max(0, Math.round((Date.now() - startedMs) / 1000)) : null
    },
    lan: {
      addresses: lanIpv4Addresses().map((address) => `http://${address}:${deps.apiPort}`),
      apiPort: deps.apiPort,
      consolePort: deps.consolePort,
      consoleUrl: `http://127.0.0.1:${deps.consolePort}/`
    },
    comfy: {
      connected: comfyProbe.connected,
      baseUrl: deps.comfy.baseUrlText,
      version: comfyProbe.version,
      lastCheckedAt: new Date().toISOString()
    },
    storage
  }, requestId);
}

// ---------- service/autostart（API §10：读写当前 Windows 用户登录自启） ----------

async function getAutostart(response: ServerResponse, requestId: string, deps: LocalRoutesDeps): Promise<void> {
  const config = await loadConfig();
  sendSuccess(response, { enabled: config.autoStart }, requestId);
}

async function putAutostart(request: IncomingMessage, response: ServerResponse, requestId: string, deps: LocalRoutesDeps): Promise<void> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || typeof body.enabled !== 'boolean') {
    throw httpError('INVALID_REQUEST', '请求需提供布尔值 enabled。');
  }
  const config = await applyLocalConfig({ autoStart: body.enabled }, deps);
  recordDiagnostic('autostart', 'info', `开机自启已${config.autoStart ? '开启' : '关闭'}。`);
  sendSuccess(response, { enabled: config.autoStart }, requestId);
}

// ---------- backups（API §10：创建 / 列出 / 校验并恢复；SERVER §11） ----------

async function createBackup(response: ServerResponse, requestId: string, deps: LocalRoutesDeps): Promise<void> {
  const summary = await deps.backup.createBackup();
  recordDiagnostic('backup', 'info',
    `已创建备份 ${summary.fileName}（档案 ${summary.profileCount} 条、偏好 ${summary.preferenceCount} 条、${summary.sizeBytes} 字节）。`);
  sendSuccess(response, summary, requestId);
}

function listBackups(response: ServerResponse, requestId: string, deps: LocalRoutesDeps): void {
  sendSuccess(response, { items: deps.backup.listBackups() }, requestId);
}

async function restoreBackup(request: IncomingMessage, response: ServerResponse, requestId: string, deps: LocalRoutesDeps): Promise<void> {
  const body = await readJsonBody(request);
  if (!isRecord(body) || typeof body.fileName !== 'string' || body.fileName.trim().length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供 fileName（备份文件名）。');
  }
  const result = await deps.backup.restoreBackup(body.fileName.trim());
  recordDiagnostic('backup', 'info',
    `已恢复备份 ${result.fileName}（档案 ${result.profileCount} 条、偏好 ${result.preferenceCount} 条）。`);
  sendSuccess(response, result, requestId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
