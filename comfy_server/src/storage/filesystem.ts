import { accessSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync, constants } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { httpError } from '../http/errors.js';

/**
 * Windows 路径安全与目录操作（S6 / SERVER §10.2）：
 * 浏览接口只列驱动器与目录；规范化后拒绝 traversal（.. 段）、无效盘符形状、UNC 与 junction 组件跳转。
 */

/** 绝对 Windows 路径（形如 C:\Users）：拒绝相对路径、UNC、无盘符与 ".." 段（上跳由 App 用 parentPath 完成）。 */
export function normalizeWindowsDirectoryPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供 Windows 目录路径。');
  }
  const rawPath = raw.trim();
  if (rawPath.startsWith('\\\\') || rawPath.startsWith('//')) {
    throw httpError('INVALID_REQUEST', '不支持 UNC 网络路径，请选择本地盘符目录。');
  }
  if (!/^[A-Za-z]:[\\/]/.test(rawPath)) {
    throw httpError('INVALID_REQUEST', '路径必须是带盘符的 Windows 绝对路径（如 I:\\comfyUI）。');
  }
  if (/[<>"|\u0000-\u001f]/.test(rawPath)) {
    throw httpError('INVALID_REQUEST', '路径包含非法字符。');
  }
  // traversal 检查必须在 resolve() 之前——resolve 会把 ".." 段消化掉，事后看不到。
  const rawSegments = rawPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (rawSegments.slice(1).some((segment) => segment === '..' || segment === '.')) {
    throw httpError('INVALID_REQUEST', '路径不允许包含 "." 或 ".." 段。');
  }
  return resolve(rawPath);
}

/**
 * 逐级校验目标路径（含全部祖先）：不存在 → PATH_NOT_FOUND；组件是文件 → PATH_NOT_DIRECTORY；
 * 任一组件是 symlink/junction → 拒绝（SERVER §10.2 junction 逃逸）。逐级 lstat 而非 realpath，
 * 避免 8.3 短名与大小写差异造成的误判。
 */
export function assertRealDirectoryTree(target: string): void {
  let current = parseDriveRoot(target);
  const segments = target.slice(current.length).split(sep).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    current = resolve(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw httpError('PATH_NOT_FOUND', `路径不存在：${current}`);
      }
      throw httpError('INVALID_REQUEST', `路径不可访问：${current}`);
    }
    if (stats.isSymbolicLink()) {
      throw httpError('INVALID_REQUEST', `路径包含 junction/symlink 跳转，已拒绝：${current}`);
    }
    if (!stats.isDirectory()) {
      throw httpError('PATH_NOT_DIRECTORY', `路径不是目录：${current}`);
    }
  }
}

/** 目标目录必须可读（浏览/列举前校验）。 */
export function assertDirectoryReadable(target: string): void {
  try {
    accessSync(target, constants.R_OK);
  } catch {
    throw httpError('FORBIDDEN', `目录不可读：${target}`);
  }
}

/** 列出目标目录下一级真实子目录（symlink/junction 跳过，不作为可进入项——SERVER §10.2）。 */
export function listSubdirectories(target: string): Array<{ name: string; path: string }> {
  const entries = readdirSync(target, { withFileTypes: true });
  const result: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = resolve(target, entry.name);
    try {
      if (lstatSync(childPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    result.push({ name: entry.name, path: childPath });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 一级子目录名合法性（图库子目录与新建目录共用；API §7 INVALID_FOLDER_NAME）。
 * 保留原始大小写与首部空白（NTFS 合法）；拒绝尾部点/空格（Windows 文件系统会剥离，导致名称漂移）。 */
export function validateChildDirectoryName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw httpError('INVALID_FOLDER_NAME', '目录名必须是字符串。');
  }
  if (raw.length === 0 || raw.trim().length === 0 || raw.length > 100) {
    throw httpError('INVALID_FOLDER_NAME', '目录名长度需在 1-100 字符之间。');
  }
  if (raw === '.' || raw === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(raw) ||
    /[. ]$/.test(raw) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(raw)) {
    throw httpError('INVALID_FOLDER_NAME', '目录名包含非法字符、尾部点/空格或为 Windows 保留名。');
  }
  return raw;
}

/** 在父目录下新建子目录（已存在 → 409；新建目录自身不会被父级校验穿透）。 */
export function createChildDirectory(parent: string, name: string): string {
  const target = resolve(parent, name);
  try {
    mkdirSync(target, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw httpError('CONFLICT', `目录已存在：${target}`);
    }
    throw httpError('FORBIDDEN', `无法创建目录：${target}（${(error as Error).message}）`);
  }
  return target;
}

/** 写探针：真实写入+删除临时文件验证可写（Windows 上 accessSync(W_OK) 对目录不可靠）。 */
export function assertPathWritable(target: string): void {
  const probe = resolve(target, `.comfy-write-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    writeFileSync(probe, 'probe', { flag: 'wx' });
  } catch {
    throw httpError('PATH_NOT_WRITABLE', `目录不可写：${target}`);
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      // 探针删除失败不改变判定；文件名带随机后缀，不会覆盖用户数据。
    }
  }
}

function parseDriveRoot(target: string): string {
  // resolve() 已保证绝对盘符路径；根为 "X:\"（win32）。
  const root = target.slice(0, isAbsolute(target) && /^[A-Za-z]:[\\/]/.test(target) ? 3 : 0);
  return root.endsWith('\\') ? root : `${root}\\`;
}

export function parentDirectoryPath(target: string): string {
  const parent = dirname(target);
  return parent.endsWith('\\') ? parent : `${parent}\\`;
}
