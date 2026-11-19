import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { sendSuccess } from '../http/envelope.js';
import { httpError, normalizeError } from '../http/errors.js';
import { readJsonBody } from '../http/middleware.js';
import type { EventsChannel } from '../http/events.js';
import type { AppDatabase, ImageRecord } from '../database.js';
import { loadConfig, saveConfig } from '../config.js';
import { GalleryStore, type StorageStatusSnapshot } from '../galleryStore.js';
import { listWindowsDrives } from '../powerShell.js';
import type { WorkflowCatalog } from '../workflows/catalog.js';
import { availableProfileModes } from '../workflows/profileStore.js';
import {
  assertDirectoryReadable,
  assertPathWritable,
  assertRealDirectoryTree,
  createChildDirectory,
  listSubdirectories,
  normalizeWindowsDirectoryPath,
  parentDirectoryPath,
  validateChildDirectoryName
} from './filesystem.js';
import { ModelsRootStore } from './modelsRoot.js';

const API_PREFIX = '/api/v1';
const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;
const PROMPT_SUMMARY_LENGTH = 100;

export interface StorageRoutesDeps {
  database: AppDatabase;
  gallery: GalleryStore;
  events: EventsChannel;
  catalog: WorkflowCatalog;
}

/**
 * 存储与图库域（S6 / API §7）：存储状态、盘符/目录浏览、图库根目录、ComfyUI 模型目录指向、
 * 图库目录与图片（列表/详情/二进制直出/再生成草稿）。thumbnail/file 免 Bearer 豁免在 main.ts（Q3）。
 */
export async function handleStorageRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  requestId: string,
  deps: StorageRoutesDeps
): Promise<void> {
  const modelsRoot = new ModelsRootStore(deps.database);
  const pathname = url.pathname;
  const method = request.method ?? '';

  if (pathname === `${API_PREFIX}/storage`) {
    if (method === 'GET') return getStorageStatus(response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === `${API_PREFIX}/storage/root`) {
    if (method === 'PUT') return putStorageRoot(request, response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === `${API_PREFIX}/filesystem/drives`) {
    if (method === 'GET') return getDrives(response, requestId);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === `${API_PREFIX}/filesystem/directories`) {
    if (method === 'GET') return listDirectories(url, response, requestId);
    if (method === 'POST') return createDirectory(request, response, requestId);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === `${API_PREFIX}/models/root`) {
    if (method === 'GET') return getModelsRoot(response, requestId, modelsRoot);
    if (method === 'PUT') return putModelsRoot(request, response, requestId, modelsRoot);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === `${API_PREFIX}/gallery/folders`) {
    if (method === 'GET') return listGalleryFolders(response, requestId, deps);
    if (method === 'POST') return createGalleryFolder(request, response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }
  if (pathname === `${API_PREFIX}/gallery/images`) {
    if (method === 'GET') return listGalleryImages(url, response, requestId, deps);
    throw httpError('NOT_FOUND', '接口不存在。');
  }

  if (pathname === `${API_PREFIX}/gallery/images/delete` && method === 'POST') {
    const body = await readJsonBody(request) as { imageIds?: unknown } | null;
    const ids = body?.imageIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_LIST_LIMIT ||
      ids.some((id) => typeof id !== 'string' || !id.trim())) {
      throw httpError('INVALID_REQUEST', 'imageIds 需包含 1–100 个图片 ID。');
    }
    const deletedImageIds: string[] = [];
    const failures: Array<{ imageId: string; message: string }> = [];
    for (const imageId of new Set<string>(ids)) {
      try {
        deps.gallery.deleteImage(imageId);
        deletedImageIds.push(imageId);
      } catch (error) {
        failures.push({ imageId, message: normalizeError(error).message });
      }
    }
    if (deletedImageIds.length > 0) deps.events.emit('gallery.images_deleted', {});
    sendSuccess(response, { deletedImageIds, failures }, requestId);
    return;
  }

  const imageMatch = /^\/api\/v1\/gallery\/images\/([^/]+)$/.exec(pathname);
  if (imageMatch && method === 'GET') {
    return getImageDetail(response, requestId, deps, decodeURIComponent(imageMatch[1]));
  }
  const draftMatch = /^\/api\/v1\/gallery\/images\/([^/]+)\/regeneration-draft$/.exec(pathname);
  if (draftMatch && method === 'GET') {
    return getRegenerationDraft(response, requestId, deps, decodeURIComponent(draftMatch[1]));
  }
  const assetMatch = /^\/api\/v1\/gallery\/images\/([^/]+)\/(thumbnail|file)$/.exec(pathname);
  if (assetMatch && method === 'GET') {
    const assetKind = assetMatch[2] === 'thumbnail' ? 'thumbnail' : 'file';
    return serveImageAsset(response, deps, decodeURIComponent(assetMatch[1]), assetKind);
  }

  throw httpError('NOT_FOUND', '接口不存在。');
}

// ---------- 存储状态与图库根目录 ----------

async function getStorageStatus(response: ServerResponse, requestId: string, deps: StorageRoutesDeps): Promise<void> {
  sendSuccess(response, await deps.gallery.getStorageStatus(), requestId);
}

async function putStorageRoot(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: StorageRoutesDeps
): Promise<void> {
  const body = await readJsonBody(request);
  const rawPath = recordField(body, 'path');
  const target = normalizeWindowsDirectoryPath(rawPath);
  assertRealDirectoryTree(target);
  assertPathWritable(target);

  // 先落盘持久化再切运行态（SERVER §10.1：检查通过才切换）。
  const config = await loadConfig();
  config.galleryRoot = target;
  await saveConfig(config);
  deps.gallery.setRoot(target);

  deps.events.emit('storage.updated', { rootDisplay: target });
  sendSuccess(response, await deps.gallery.getStorageStatus(), requestId);
}

// ---------- 盘符与目录浏览 ----------

async function getDrives(response: ServerResponse, requestId: string): Promise<void> {
  let drives;
  try {
    drives = await listWindowsDrives();
  } catch (error) {
    throw httpError('INTERNAL_ERROR', (error as Error).message);
  }
  const payload = drives.map((drive) => {
    const rootPath = `${drive.letter}\\`;
    let readable = false;
    try {
      const stats = statSync(rootPath);
      readable = stats.isDirectory();
    } catch {
      readable = false;
    }
    return { path: rootPath, label: drive.label, readable };
  });
  sendSuccess(response, { drives: payload }, requestId);
}

function listDirectories(url: URL, response: ServerResponse, requestId: string): void {
  const target = normalizeWindowsDirectoryPath(url.searchParams.get('path'));
  assertRealDirectoryTree(target);
  assertDirectoryReadable(target);
  sendSuccess(response, {
    path: target,
    parentPath: parentDirectoryPath(target),
    directories: listSubdirectories(target)
  }, requestId);
}

async function createDirectory(request: IncomingMessage, response: ServerResponse, requestId: string): Promise<void> {
  const body = await readJsonBody(request);
  const parentPath = normalizeWindowsDirectoryPath(recordField(body, 'parentPath'));
  assertRealDirectoryTree(parentPath);
  assertDirectoryReadable(parentPath);
  const name = validateChildDirectoryName(recordField(body, 'name'));
  const created = createChildDirectory(parentPath, name);
  sendSuccess(response, { path: created }, requestId);
}

// ---------- ComfyUI 模型目录 ----------

function getModelsRoot(response: ServerResponse, requestId: string, modelsRoot: ModelsRootStore): void {
  sendSuccess(response, modelsRoot.getModelsRoot(), requestId);
}

async function putModelsRoot(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  modelsRoot: ModelsRootStore
): Promise<void> {
  const body = await readJsonBody(request);
  sendSuccess(response, await modelsRoot.setModelsRoot(recordField(body, 'path')), requestId);
}

// ---------- 图库目录 ----------

function requireGalleryRoot(deps: StorageRoutesDeps): string {
  if (!deps.gallery.isConfigured()) {
    throw httpError('GALLERY_UNAVAILABLE', '尚未配置图库根目录，请先在设置中选择图库目录。');
  }
  return deps.gallery.root;
}

function listGalleryFolders(response: ServerResponse, requestId: string, deps: StorageRoutesDeps): void {
  const root = requireGalleryRoot(deps);
  sendSuccess(response, { folders: listSubdirectories(root).map((entry) => entry.name) }, requestId);
}

async function createGalleryFolder(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  deps: StorageRoutesDeps
): Promise<void> {
  const root = requireGalleryRoot(deps);
  const body = await readJsonBody(request);
  const name = validateChildDirectoryName(recordField(body, 'name'));
  createChildDirectory(root, name);
  sendSuccess(response, { folders: listSubdirectories(root).map((entry) => entry.name) }, requestId);
}

// ---------- 图库图片 ----------

function listGalleryImages(url: URL, response: ServerResponse, requestId: string, deps: StorageRoutesDeps): void {
  const folderName = url.searchParams.get('folderName') ?? '';
  if (folderName.length > 0) validateChildDirectoryName(folderName);
  const cursorRaw = url.searchParams.get('cursor') ?? '';
  if (cursorRaw.length > 0 && !/^\d+$/.test(cursorRaw)) {
    throw httpError('INVALID_REQUEST', 'cursor 不合法。');
  }
  const offset = cursorRaw.length > 0 ? Number(cursorRaw) : 0;
  const limitRaw = url.searchParams.get('limit') ?? String(DEFAULT_LIST_LIMIT);
  if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIST_LIMIT) {
    throw httpError('INVALID_REQUEST', `limit 需在 1-${MAX_LIST_LIMIT} 之间。`);
  }
  const limit = Number(limitRaw);
  const page = deps.gallery.listOffset(offset, limit, folderName);
  const hasMore = offset + page.items.length < page.total;
  sendSuccess(response, {
    items: page.items.map(imageListItem),
    total: page.total,
    nextCursor: hasMore ? String(offset + limit) : ''
  }, requestId);
}

function imageListItem(item: ImageRecord): Record<string, unknown> {
  const meta = recordMetadata(item);
  return {
    imageId: item.id,
    aiExpansionMode: stringOrNull(meta.aiExpansionMode) ?? 'none',
    thumbnailUrl: `${API_PREFIX}/gallery/images/${item.id}/thumbnail`,
    promptSummary: typeof item.prompt === 'string' ? item.prompt.slice(0, PROMPT_SUMMARY_LENGTH) : '',
    createdAt: item.createdAt ?? '',
    width: numberOrNull(meta.width) ?? 0,
    height: numberOrNull(meta.height) ?? 0,
    folderName: item.folderName,
    workflowName: stringOrNull(meta.workflowName)
  };
}

function getImageDetail(
  response: ServerResponse,
  requestId: string,
  deps: StorageRoutesDeps,
  imageId: string
): void {
  const item = deps.gallery.getDetail(imageId);
  if (!item) throw httpError('NOT_FOUND', '图片不存在或已被删除。');
  sendSuccess(response, imageDetailPayload(item), requestId);
}

/** SERVER §10.3 全字段；LoRA 结构化（nodeId/loraName/enabled/strength），禁止 [object Object]。 */
function imageDetailPayload(item: ImageRecord & { originalPath: string; thumbnailPath: string }): Record<string, unknown> {
  const meta = recordMetadata(item);
  return {
    imageId: item.id,
    originalPrompt: stringOrNull(meta.originalPrompt) ?? stringOrNull(item.prompt) ?? null,
    finalPrompt: stringOrNull(meta.finalPrompt) ?? stringOrNull(item.prompt) ?? null,
    // V1 元数据只存 aiExpansionUsed 布尔；S5 起存原生模式（none/comfyui_clip/custom_llm）。
    aiExpansionMode: meta.aiExpansionMode === 'none' || meta.aiExpansionMode === 'comfyui_clip' || meta.aiExpansionMode === 'custom_llm'
      ? meta.aiExpansionMode
      : (meta.aiExpansionUsed === true ? 'custom_llm' : 'none'),
    jobId: stringOrNull(meta.jobId) ?? null,
    workflowId: stringOrNull(meta.workflowId) ?? null,
    workflowName: stringOrNull(meta.workflowName) ?? null,
    workflowMode: stringOrNull(meta.workflowMode) ?? null,
    workflowFingerprint: stringOrNull(meta.workflowFingerprint) ?? null,
    aspectRatio: stringOrNull(meta.aspectRatio) ?? null,
    megapixels: numberOrNull(meta.megapixels) ?? null,
    seed: numberOrNull(meta.seed),
    width: numberOrNull(meta.width) ?? null,
    height: numberOrNull(meta.height) ?? null,
    model: stringOrNull(meta.model) ?? null,
    loras: normalizeStoredLoras(meta.loras),
    sampler: stringOrNull(meta.sampler) ?? null,
    steps: numberOrNull(meta.steps) ?? null,
    cfg: numberOrNull(meta.cfg) ?? null,
    scheduler: stringOrNull(meta.scheduler) ?? null,
    denoise: numberOrNull(meta.denoise) ?? null,
    createdAt: item.createdAt ?? '',
    fileAvailable: existsSync(item.originalPath) && existsSync(item.thumbnailPath),
    paramSnapshot: meta.paramSnapshot ?? null
  };
}

/** V1 元数据 LoRA 形状 {name, strengthModel, strengthClip} → 结构化；无法解析的项如实保留为占位。 */
function normalizeStoredLoras(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      result.push({ nodeId: null, loraName: entry, enabled: true, strength: 0 });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    result.push({
      nodeId: numberOrNull(record.nodeId) ?? null,
      loraName: stringOrNull(record.loraName) ?? stringOrNull(record.name) ?? '',
      enabled: record.enabled === undefined ? true : record.enabled === true,
      strength: numberOrNull(record.strength) ?? numberOrNull(record.strengthModel) ?? 0
    });
  }
  return result;
}

// ---------- 再生成草稿 ----------

/**
 * 再生成草稿（API §7 / OQ #6 提案形状，待主控冻结）：workflowAvailable 按"默认档案可生成"判定
 * （档案存在且带参数；V1 迁移档案无参数 → false + 引导，SERVER §8-S8）；restorableParams 为
 * 元数据中可映射进当前默认档案的键；无法映射的进 incompatibleFields。
 */
async function getRegenerationDraft(
  response: ServerResponse,
  requestId: string,
  deps: StorageRoutesDeps,
  imageId: string
): Promise<void> {
  const item = deps.gallery.getDetail(imageId);
  if (!item) throw httpError('NOT_FOUND', '图片不存在或已被删除。');
  const meta = recordMetadata(item);
  await deps.catalog.refresh();
  const profile = deps.catalog.store.getDefaultProfile();
  const hasParameters = profile !== null && availableProfileModes(profile).length > 0;

  const restorable: Record<string, unknown> = {};
  const incompatible: Array<{ field: string; value: unknown; reason: string }> = [];
  if (typeof meta.originalPrompt === 'string') restorable.originalPrompt = meta.originalPrompt;
  if (typeof meta.finalPrompt === 'string') restorable.finalPrompt = meta.finalPrompt;

  const ratioParam = profile?.analysis.parameters.find((parameter) => parameter.role === 'aspectRatio');
  if (typeof meta.aspectRatio === 'string' && meta.aspectRatio.length > 0) {
    const mappable = ratioParam?.options?.some((option) => option.label === meta.aspectRatio || option.value === meta.aspectRatio);
    if (mappable) {
      restorable.aspectRatio = meta.aspectRatio;
    } else {
      incompatible.push({ field: 'aspectRatio', value: meta.aspectRatio, reason: '当前默认档案的比例枚举不包含该值' });
    }
  }
  const megapixelsParam = profile?.analysis.parameters.find((parameter) => parameter.role === 'megapixels');
  if (typeof meta.megapixels === 'number' && Number.isFinite(meta.megapixels)) {
    const constraints = megapixelsParam?.constraints;
    const mappable = !constraints ||
      ((constraints.min === undefined || meta.megapixels >= constraints.min) &&
        (constraints.max === undefined || meta.megapixels <= constraints.max));
    if (mappable) {
      restorable.megapixels = meta.megapixels;
    } else {
      incompatible.push({ field: 'megapixels', value: meta.megapixels, reason: '超出当前默认档案的 MP 范围' });
    }
  }
  if (typeof meta.seed === 'number' && Number.isSafeInteger(meta.seed)) restorable.seed = meta.seed;

  sendSuccess(response, {
    workflowAvailable: hasParameters,
    workflowId: hasParameters ? profile?.id ?? null : null,
    restorableParams: restorable,
    incompatibleFields: incompatible,
    ...(hasParameters ? {} : { message: profile === null
      ? '尚未配置可用工作流档案，请上传 V1.1 模板后再试。'
      : '当前默认档案无可注入参数（V1 迁移档案），请重新上传 V1.1 模板。' })
  }, requestId);
}

// ---------- 二进制直出（Q3：免 Bearer，main.ts 豁免） ----------

function serveImageAsset(
  response: ServerResponse,
  deps: StorageRoutesDeps,
  imageId: string,
  kind: 'thumbnail' | 'file'
): void {
  const item = deps.gallery.getDetail(imageId);
  if (!item) throw httpError('NOT_FOUND', '图片不存在或已被删除。');
  const filePath = kind === 'thumbnail' ? item.thumbnailPath : item.originalPath;
  if (!existsSync(filePath)) {
    throw httpError('NOT_FOUND', kind === 'thumbnail' ? '缩略图文件已不存在。' : '原图文件已不存在。');
  }
  const size = statSync(filePath).size;
  response.writeHead(200, {
    'content-type': assetContentType(item, kind),
    'content-length': size,
    'cache-control': 'private, max-age=86400, immutable',
    ...(kind === 'file' ? { 'content-disposition': `attachment; filename="${assetFileName(item.fileName)}"` } : {})
  });
  void pipeline(createReadStream(filePath), response).catch(() => {
    response.destroy();
  });
}

function assetContentType(item: ImageRecord & { originalPath: string; thumbnailPath: string }, kind: 'thumbnail' | 'file'): string {
  const mime = kind === 'thumbnail' ? 'image/webp' : stringOrNull(item.mimeType);
  if (mime !== null && /^[a-z]+\/[a-z0-9.+-]+$/i.test(mime)) return mime;
  const extension = item.fileName.slice(item.fileName.lastIndexOf('.') + 1).toLowerCase();
  const byExtension: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif'
  };
  return byExtension[extension] ?? 'application/octet-stream';
}

function assetFileName(fileName: string): string {
  return fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
}

// ---------- 辅助 ----------

function recordMetadata(item: ImageRecord): Record<string, unknown> {
  return item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
    ? item.metadata as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  // ComfyUI 元数据里连线输入可能是 [nodeId, outputIndex] 数组——按不可读值处理为 null。
  if (Array.isArray(value)) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordField(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

export type { StorageStatusSnapshot };
