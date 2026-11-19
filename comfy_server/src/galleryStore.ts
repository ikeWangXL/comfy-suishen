import { createWriteStream, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { open, statfs } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppDatabase, ImageRecord } from './database.js';
import { assertPathWritable, assertRealDirectoryTree } from './storage/filesystem.js';
import { httpError } from './http/errors.js';

/**
 * 生成图元数据（SERVER §10.3，S5 起记录完整形状）：存入 images.metadata_json，
 * 详情端点按原字段结构化返回（LoRA 结构化，不拼接字符串）。
 */
export interface GalleryImageMetadata {
  jobId: string;
  createdAt: string;
  /** 1-based 序号（§8 逐张执行）。 */
  imageIndex: number;
  originalPrompt: string;
  finalPrompt: string;
  aiExpansionMode: 'none' | 'comfyui_clip' | 'custom_llm';
  workflowId: string;
  workflowName: string;
  workflowMode: 'quick' | 'professional';
  workflowRevision: string;
  workflowFingerprint: string;
  paramSnapshot: {
    workflowRevision: string;
    parameters: Array<{ nodeId: number | string; inputName: string; value: unknown }>;
    loras: Array<{ nodeId: number | string; loraName: string; enabled: boolean; strength: number }>;
  };
  seed: number | null;
  aspectRatio: string | null;
  megapixels: number | null;
  width: number | null;
  height: number | null;
  model: string | null;
  loras: Array<{ nodeId: number | string | null; loraName: string; enabled: boolean; strength: number }>;
  sampler: string | null;
  steps: number | null;
  cfg: number | null;
  scheduler: string | null;
  denoise: number | null;
  promptId: string | null;
  galleryRoot: string | null;
  folderName: string;
}

/** 空间告警阈值（§8-S6 定案 P8）：剩余 <10GiB 或 <5% 取先触发。 */
const FREE_BYTES_THRESHOLD = 10 * 1024 ** 3;
const FREE_RATIO_THRESHOLD = 0.05;

export interface StorageVolumeStats {
  freeBytes: number;
  totalBytes: number;
}

export interface StorageStatusSnapshot {
  configured: boolean;
  writable: boolean;
  rootDisplay: string;
  freeBytes: number;
  totalBytes: number;
  warning: boolean;
}

export interface SaveImageInput {
  folderName: string;
  original: Uint8Array | Readable;
  thumbnail: Uint8Array | Readable;
  fileName?: string;
  extension?: string;
  thumbnailExtension?: string;
  mimeType?: string;
  prompt?: string;
  metadata?: unknown;
}

export interface GalleryImage extends ImageRecord {
  originalPath: string;
  thumbnailPath: string;
}

export class GalleryStore {
  root: string;

  /** root 为空串 = 未配置（S1 口径：新装默认无图库目录，未配置时禁止生成——S5 阻断）。 */
  constructor(private readonly database: AppDatabase, root = '') {
    this.root = root.length === 0 ? '' : resolve(root);
  }

  setRoot(root: string): void {
    this.root = root.length === 0 ? '' : resolve(root);
  }

  isConfigured(): boolean {
    return this.root.length > 0;
  }

  /** GET /storage 六字段快照（API §7/§4）：未配置不探测盘；目录缺失/不可写如实降级 writable=false。 */
  async getStorageStatus(): Promise<StorageStatusSnapshot> {
    if (this.root.length === 0) {
      return { configured: false, writable: false, rootDisplay: '', freeBytes: 0, totalBytes: 0, warning: false };
    }
    let writable = false;
    try {
      assertPathWritable(this.root);
      writable = true;
    } catch {
      writable = false;
    }
    let freeBytes = 0;
    let totalBytes = 0;
    try {
      const volume = await getVolumeStats(this.root);
      freeBytes = volume.freeBytes;
      totalBytes = volume.totalBytes;
    } catch {
      freeBytes = 0;
      totalBytes = 0;
    }
    return {
      configured: true,
      writable,
      rootDisplay: this.root,
      freeBytes,
      totalBytes,
      warning: writable && isGallerySpaceLow(freeBytes, totalBytes)
    };
  }

  /** 生成前空间检查接口（S5 阻断执行点调用）：未配置/不可读/空间不足都返回 null 供调用方落错误码。 */
  async getVolumeStatsIfConfigured(): Promise<StorageVolumeStats | null> {
    if (this.root.length === 0) return null;
    try {
      return await getVolumeStats(this.root);
    } catch {
      return null;
    }
  }

  /** Create and return a safe first-level gallery folder. */
  ensureFolder(folderName: string): string {
    const directory = this.resolveFolder(folderName);
    try {
      const existing = lstatSync(directory);
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('Gallery folder must be a real directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(directory, { recursive: true });
    const created = lstatSync(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('Gallery folder must be a real directory');
    return directory;
  }

  validateFolderName(folderName: string): void {
    this.resolveFolder(folderName);
  }

  async save(input: SaveImageInput): Promise<GalleryImage> {
    const folder = this.ensureFolder(input.folderName);
    const ext = normalizeExtension(input.extension ?? (extname(input.fileName ?? '') || '.png'));
    const thumbExt = normalizeExtension(input.thumbnailExtension ?? ext);
    const stem = safeStem(input.fileName ? basename(input.fileName, extname(input.fileName)) : 'image');
    let fileName = `${stem}${ext}`;
    let thumbnailName = `${stem}_thumb${thumbExt}`;
    for (let suffix = 1; this.database.hasImageName(input.folderName, fileName) || existsSync(resolve(folder, fileName)) || existsSync(resolve(folder, thumbnailName)); suffix++) {
      fileName = `${stem}_${suffix}${ext}`;
      thumbnailName = `${stem}_${suffix}_thumb${thumbExt}`;
    }

    const originalPath = this.resolveChild(folder, fileName);
    const thumbnailPath = this.resolveChild(folder, thumbnailName);
    try {
      await writeExclusive(originalPath, input.original);
      await writeExclusive(thumbnailPath, input.thumbnail);
      const record: ImageRecord = {
        id: randomUUID(), folderName: input.folderName, galleryRoot: this.root, fileName, thumbnailName,
        mimeType: input.mimeType ?? null, prompt: input.prompt ?? null, metadata: input.metadata,
        createdAt: new Date().toISOString(),
      };
      this.database.saveImage(record);
      return { ...record, originalPath, thumbnailPath };
    } catch (error) {
      // Do not remove files automatically; a failed metadata write can be reconciled by an operator.
      throw error;
    }
  }

  list(page = 1, pageSize = 30, folderName?: string): { items: GalleryImage[]; page: number; pageSize: number; total: number } {
    if (!this.isConfigured()) return { items: [], page, pageSize, total: 0 };
    const result = this.database.listImages(page, pageSize, folderName, undefined, this.root);
    return { ...result, items: result.items.map(item => this.withPaths(item)) };
  }

  listOffset(offset: number, pageSize = 30, folderName?: string): { items: GalleryImage[]; page: number; pageSize: number; total: number } {
    if (!this.isConfigured()) return { items: [], page: 1, pageSize, total: 0 };
    const result = this.database.listImages(1, pageSize, folderName, offset, this.root);
    return { ...result, items: result.items.map(item => this.withPaths(item)) };
  }

  getDetail(id: string): GalleryImage | null {
    const item = this.database.getImage(id);
    return item && this.belongsToCurrentRoot(item) ? this.withPaths(item) : null;
  }

  deleteImage(id: string): void {
    const record = this.database.getImage(id);
    if (!record || !this.belongsToCurrentRoot(record)) {
      throw httpError('NOT_FOUND', '图片已不存在，或不在当前图库目录。');
    }
    assertRealDirectoryTree(this.resolveFolder(record.folderName));
    const item = this.withPaths(record);
    const jobId = this.database.getImageJobId(item);
    const job = jobId ? this.database.getJob(jobId) : null;
    if (job && ['queued', 'running', 'cancelling'].includes(job.status)) {
      throw httpError('CONFLICT', '这张图片的生成任务还未结束，请稍后删除。');
    }
    for (const path of [item.thumbnailPath, item.originalPath]) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw httpError('PATH_NOT_WRITABLE', '无法删除图片文件，请检查目录权限或文件是否被占用。');
        }
      }
    }
    this.database.deleteGalleryImage(id, job);
  }

  getOriginalPath(id: string): string | null {
    const item = this.getDetail(id);
    if (!item) return null;
    const folder = this.resolveFolder(item.folderName);
    return this.resolveChild(folder, item.fileName);
  }

  getThumbnailPath(id: string): string | null {
    const item = this.getDetail(id);
    if (!item) return null;
    const folder = this.resolveFolder(item.folderName);
    return this.resolveChild(folder, item.thumbnailName);
  }

  private withPaths(item: ImageRecord): GalleryImage {
    const folder = this.resolveFolder(item.folderName);
    return { ...item, originalPath: this.resolveChild(folder, item.fileName), thumbnailPath: this.resolveChild(folder, item.thumbnailName) };
  }

  private belongsToCurrentRoot(item: ImageRecord): boolean {
    return this.root.length > 0 && (item.galleryRoot == null || resolve(item.galleryRoot).toLowerCase() === this.root.toLowerCase());
  }

  private resolveFolder(folderName: string, root = this.root): string {
    if (folderName === '') return root;
    if (typeof folderName !== 'string' || folderName === '.' || folderName === '..' ||
      /[\\/:*?"<>|]/.test(folderName) || /[. ]$/.test(folderName) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(folderName)) {
      throw new Error('folderName must be one safe child directory name');
    }
    const target = resolve(root, folderName);
    const rel = relative(root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) {
      throw new Error('folderName must resolve to a direct child of the gallery root');
    }
    return target;
  }

  private resolveChild(folder: string, fileName: string): string {
    if (basename(fileName) !== fileName || fileName === '.' || fileName === '..' || /[\\/:*?"<>|]/.test(fileName)) {
      throw new Error('Invalid gallery file name');
    }
    const target = resolve(folder, fileName);
    const rel = relative(folder, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) {
      throw new Error('Gallery file path escapes its folder');
    }
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error('Gallery image path cannot be a symbolic link');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return target;
  }
}

async function writeExclusive(path: string, data: Uint8Array | Readable): Promise<void> {
  if (data instanceof Uint8Array) {
    const handle = await open(path, 'wx');
    try { await handle.writeFile(data); } finally { await handle.close(); }
    return;
  }
  await pipeline(data, createWriteStream(path, { flags: 'wx' }));
}

function normalizeExtension(value: string): string {
  const cleaned = value.startsWith('.') ? value : `.${value}`;
  if (!/^\.[a-zA-Z0-9]{1,12}$/.test(cleaned)) throw new Error('Invalid image extension');
  return cleaned.toLowerCase();
}

function safeStem(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  return cleaned || 'image';
}

/** statfs 卷空间（Node 原生，Windows 等价 GetDiskFreeSpaceExW 语义）：free 取 unprivileged bavail。 */
export async function getVolumeStats(targetPath: string): Promise<StorageVolumeStats> {
  const stats = await statfs(targetPath);
  return {
    freeBytes: Number(stats.bavail) * Number(stats.bsize),
    totalBytes: Number(stats.blocks) * Number(stats.bsize)
  };
}

export function isGallerySpaceLow(freeBytes: number, totalBytes: number): boolean {
  if (freeBytes < FREE_BYTES_THRESHOLD) return true;
  return totalBytes > 0 && freeBytes / totalBytes < FREE_RATIO_THRESHOLD;
}
