import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiWorkflow } from './profileStore.js';
import type { AppDatabase } from '../database.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_ROOT = join(SERVER_ROOT, 'data', 'workflow');
const PROFILE_FILE_PREFIX = 'profile-';

export type WorkflowDirectory = 'upload' | 'create';

export interface DiscoveredWorkflowFile {
  relativePath: string;
  directory: WorkflowDirectory;
  fileName: string;
  name: string;
  workflow: ApiWorkflow;
}

export function ensureWorkflowDirectories(): void {
  for (const directory of ['upload', 'create', 'backup']) {
    mkdirSync(join(WORKFLOW_ROOT, directory), { recursive: true });
  }
}

/** One-time materialization of pre-file profile snapshots into their relative legacy paths. */
export function initializeLegacyWorkflowFiles(database: AppDatabase): void {
  ensureWorkflowDirectories();
  if (database.getSetting<boolean>('workflowFilesMigrated') === true) return;
  for (const profile of database.listWorkflowProfiles()) {
    const filePath = workflowFilePath(profile.workflowFile);
    if (!existsSync(filePath)) saveWorkflowFile(profile.workflowFile, profile.workflow);
  }
  database.setSetting('workflowFilesMigrated', true);
}

export function workflowFilePath(relativePath: string): string {
  const normalized = relativePath.replace(/[\\]/g, '/');
  const parts = normalized.split('/');
  if (parts.length < 2 || !['upload', 'create'].includes(parts[0]) || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`无效的工作流相对路径：${relativePath}`);
  }
  const filePath = resolve(WORKFLOW_ROOT, ...parts);
  const rootPrefix = `${resolve(WORKFLOW_ROOT)}${sep}`;
  if (!filePath.startsWith(rootPrefix)) throw new Error(`工作流路径超出数据目录：${relativePath}`);
  return filePath;
}

export function saveWorkflowFile(relativePath: string, workflow: ApiWorkflow): void {
  const filePath = workflowFilePath(relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(workflow, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function loadWorkflowFile(relativePath: string): ApiWorkflow {
  return JSON.parse(readFileSync(workflowFilePath(relativePath), 'utf8').replace(/^\uFEFF/, '')) as ApiWorkflow;
}

export function deleteWorkflowFile(relativePath: string): void {
  const filePath = workflowFilePath(relativePath);
  if (existsSync(filePath)) unlinkSync(filePath);
}

export function hasWorkflowFile(relativePath: string): boolean {
  const filePath = workflowFilePath(relativePath);
  if (!existsSync(filePath)) return false;
  try {
    return isApiWorkflow(JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as unknown);
  } catch {
    return false;
  }
}

export function archiveGeneratedWorkflowFilesExcept(relativePaths: Set<string>): void {
  for (const directory of ['upload', 'create'] as const) {
    const directoryPath = join(WORKFLOW_ROOT, directory);
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isFile() || !/^profile-wf_[0-9a-f-]{36}\.json$/i.test(entry.name)) continue;
      const relativePath = `${directory}/${entry.name}`;
      if (relativePaths.has(relativePath)) continue;
      const archivePath = join(WORKFLOW_ROOT, 'backup', `archived-${Date.now()}-${randomUUID()}-${entry.name}`);
      renameSync(workflowFilePath(relativePath), archivePath);
    }
  }
}

export function uploadProfilePath(profileId: string): string {
  return `upload/${PROFILE_FILE_PREFIX}${profileId}.json`;
}

export function legacyProfilePath(profileId: string): string {
  return `create/${PROFILE_FILE_PREFIX}${profileId}.json`;
}

export function discoverWorkflowFiles(): DiscoveredWorkflowFile[] {
  const discovered: DiscoveredWorkflowFile[] = [];
  for (const directory of ['upload', 'create'] as const) {
    const directoryPath = join(WORKFLOW_ROOT, directory);
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.json') continue;
      const relativePath = `${directory}/${entry.name}`;
      let workflow: ApiWorkflow;
      try {
        const raw = readFileSync(workflowFilePath(relativePath), 'utf8').replace(/^\uFEFF/, '');
        const parsed: unknown = JSON.parse(raw);
        if (!isApiWorkflow(parsed)) continue;
        workflow = parsed;
      } catch {
        continue;
      }
      discovered.push({
        relativePath,
        directory,
        fileName: entry.name,
        name: entry.name.slice(0, -extname(entry.name).length),
        workflow
      });
    }
  }
  return discovered;
}

export function isApiWorkflow(value: unknown): value is ApiWorkflow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([, node]) =>
    typeof node === 'object' && node !== null && !Array.isArray(node) &&
    typeof (node as Record<string, unknown>).class_type === 'string' &&
    typeof (node as Record<string, unknown>).inputs === 'object' &&
    (node as Record<string, unknown>).inputs !== null &&
    !Array.isArray((node as Record<string, unknown>).inputs));
}

export function workflowFileProfileId(relativePath: string): string {
  const normalized = relativePath.replace(/[\\]/g, '/');
  return `wf_file_${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32)}`;
}

export function workflowDataDirectory(): string {
  return WORKFLOW_ROOT;
}
