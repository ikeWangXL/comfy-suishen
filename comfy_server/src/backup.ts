import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppDatabase, WorkflowPreferenceDumpRow } from './database.js';
import { httpError } from './http/errors.js';
import { canonicalJson, type ApiWorkflow, type WorkflowAnalysis } from './workflows/profileStore.js';
import { loadConfig, saveConfig, getDataDirectory, type ServerConfig } from './config.js';
import { setWindowsAutoStart } from './autoStart.js';
import {
  legacyProfilePath,
  loadWorkflowFile,
  archiveGeneratedWorkflowFilesExcept,
  saveWorkflowFile,
  workflowDataDirectory
} from './workflows/workflowFiles.js';
import type { GalleryStore } from './galleryStore.js';
import type { ComfyClient } from './comfy/ComfyClient.js';

/** 备份格式版本（SERVER §11"备份文件有格式版本、时间、档案数量及完整性校验"）。 */
export const BACKUP_FORMAT_VERSION = 1;

/** 备份文件名前缀；pre-migration 数据库快照用 db-pre-migration-* 前缀，不进本索引（GET /local/api/backups 只列档案备份）。 */
const BACKUP_FILE_PREFIX = 'profile-backup-';

export interface BackupContent {
  formatVersion: number;
  kind: 'settings-and-profiles';
  createdAt: string;
  counts: { profiles: number; preferences: number };
  config: ServerConfig;
  profiles: Array<{
    id: string; name: string; revision: string; fingerprint: string;
    confirmedModes: string[]; isDefault: boolean;
    workflowFile: string;
    workflow: ApiWorkflow; analysis: WorkflowAnalysis;
    createdAt: string; updatedAt: string;
  }>;
  preferences: WorkflowPreferenceDumpRow[];
}

interface BackupFilePayload extends BackupContent {
  checksum: string;
}

export interface BackupSummary {
  backupId: string;
  fileName: string;
  createdAt: string;
  formatVersion: number;
  profileCount: number;
  preferenceCount: number;
  sizeBytes: number;
  /** 索引在库但文件已被外部删除时为 false（列表如实标注，不静默清索引）。 */
  available: boolean;
}

export interface RestoreResult {
  restored: true;
  fileName: string;
  profileCount: number;
  preferenceCount: number;
  restoredAt: string;
  /** 恢复后的图库根目录（供控制台刷新显示）。 */
  galleryRoot: string;
}

export interface BackupStoreDeps {
  database: AppDatabase;
  gallery: GalleryStore;
  comfy: ComfyClient;
  /** 恢复/自启配置落定后的可观察动作（S8 诊断记录），可选。 */
  onRestoreApplied?: (result: RestoreResult) => void;
}

/**
 * 设置 + 工作流档案备份域（S8 / SERVER §11 / API §10）：
 * - 备份 = config.json 内容 + workflow_profiles + workflow_preferences，不含图库大图/任务历史/账号凭据；
 *   AI 密钥以 DPAPI 保护串原样随设置保存（跨 Windows 用户恢复时无法解密 → App 显示未配置并重新录入）；
 * - 文件落 backups/ 目录，元数据进 backup_index 表；校验和覆盖除 checksum 外的全部内容；
 * - 恢复前先完整校验（文件存在 → JSON → 版本 → 校验和 → 结构），全部通过才在单事务内替换，
 *   失败不触碰现数据；恢复成功后运行态（图库根/Comfy 地址/自启）同步切到恢复值。
 */
export class BackupStore {
  constructor(private readonly deps: BackupStoreDeps) {}

  private get backupsDirectory(): string {
    return join(workflowDataDirectory(), 'backup');
  }

  /** 创建备份并登记索引；写文件失败（盘满/权限）直接抛错，不写半截索引。 */
  async createBackup(): Promise<BackupSummary> {
    const config = await loadConfig();
    const profiles = this.deps.database.listWorkflowProfiles().map((profile) => ({
      id: profile.id,
      name: profile.name,
      revision: profile.revision,
      fingerprint: profile.fingerprint,
      confirmedModes: profile.confirmedModes,
      isDefault: profile.isDefault,
      workflowFile: profile.workflowFile,
      workflow: loadWorkflowFile(profile.workflowFile),
      analysis: profile.analysis,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    }));
    const preferences = this.deps.database.listAllWorkflowPreferenceRows();
    const content: BackupContent = {
      formatVersion: BACKUP_FORMAT_VERSION,
      kind: 'settings-and-profiles',
      createdAt: new Date().toISOString(),
      counts: { profiles: profiles.length, preferences: preferences.length },
      config,
      profiles,
      preferences
    };
    const payload: BackupFilePayload = { ...content, checksum: computeChecksum(content) };
    const serialized = JSON.stringify(payload, null, 2);

    mkdirSync(this.backupsDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${BACKUP_FILE_PREFIX}${stamp}.json`;
    const filePath = join(this.backupsDirectory, fileName);
    writeFileSync(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
    const sizeBytes = statSync(filePath).size;

    const backupId = `backup_${randomUUID()}`;
    this.deps.database.saveBackupIndexEntry({
      id: backupId,
      fileName,
      createdAt: content.createdAt,
      formatVersion: BACKUP_FORMAT_VERSION,
      profileCount: profiles.length,
      preferenceCount: preferences.length,
      sizeBytes,
      checksum: payload.checksum
    });
    return {
      backupId,
      fileName,
      createdAt: content.createdAt,
      formatVersion: BACKUP_FORMAT_VERSION,
      profileCount: profiles.length,
      preferenceCount: preferences.length,
      sizeBytes,
      available: true
    };
  }

  /** 列表 = backup_index 全量 + 磁盘文件在位性核对（文件缺失如实 available:false）。 */
  listBackups(): BackupSummary[] {
    return this.deps.database.listBackupIndexEntries().map((entry) => ({
      backupId: entry.id,
      fileName: entry.fileName,
      createdAt: entry.createdAt,
      formatVersion: entry.formatVersion,
      profileCount: entry.profileCount,
      preferenceCount: entry.preferenceCount,
      sizeBytes: entry.sizeBytes,
      available: existsSync(join(this.backupsDirectory, entry.fileName)) ||
        existsSync(join(getDataDirectory(), 'backups', entry.fileName))
    }));
  }

  /** 恢复（API §10"校验并恢复备份"）：任何校验失败都在改动现数据之前抛出。 */
  async restoreBackup(fileName: string): Promise<RestoreResult> {
    const indexed = this.deps.database.getBackupIndexEntry(fileName);
    if (!indexed || !fileName.startsWith(BACKUP_FILE_PREFIX)) {
      throw httpError('NOT_FOUND', '备份不存在或不在备份索引中。');
    }
    const newFilePath = join(this.backupsDirectory, fileName);
    const legacyFilePath = join(getDataDirectory(), 'backups', fileName);
    const filePath = existsSync(newFilePath) ? newFilePath : legacyFilePath;
    if (!existsSync(filePath)) {
      throw httpError('NOT_FOUND', '备份文件已不存在于 backups 目录。');
    }

    // ---- 校验段（全部通过前不触碰任何现数据）----
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      throw httpError('BACKUP_INVALID', '备份文件不是合法 JSON。');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw httpError('BACKUP_INVALID', '备份文件结构无效。');
    }
    const payload = raw as Partial<BackupFilePayload>;
    if (payload.formatVersion === undefined) {
      throw httpError('BACKUP_INVALID', '备份文件缺少格式版本。');
    }
    if (payload.formatVersion !== BACKUP_FORMAT_VERSION) {
      throw httpError('BACKUP_VERSION_UNSUPPORTED', `备份格式版本 ${String(payload.formatVersion)} 不受支持（当前支持 ${BACKUP_FORMAT_VERSION}）。`);
    }
    if (typeof payload.checksum !== 'string' || payload.checksum.length === 0) {
      throw httpError('BACKUP_INVALID', '备份文件缺少完整性校验和。');
    }
    const { checksum, ...contentFields } = payload;
    const content = contentFields as unknown as BackupContent;
    const computed = computeChecksum(content);
    if (computed !== checksum) {
      throw httpError('BACKUP_INVALID', '备份完整性校验未通过：文件内容与校验和不一致（可能已损坏或被篡改）。');
    }
    const validated = validateBackupContent(content);

    for (const profile of validated.profiles) {
      saveWorkflowFile(profile.workflowFile, profile.workflow);
    }

    // ---- 应用段（校验全部通过后才开始改动；顺序＝配置文件→运行态→数据库事务→自启，
    //      把唯一可能因 IO 失败的配置写放在数据替换之前，保证失败窗口内档案/偏好零改动）----
    await saveConfig(validated.config);
    this.deps.gallery.setRoot(validated.config.galleryRoot);
    this.deps.comfy.setBaseUrl(validated.config.comfyBaseUrl);
    try {
      this.deps.database.replaceProfilesAndPreferences(validated.profiles, validated.preferences);
    } catch (error) {
      // 校验已覆盖 name/id 唯一性与偏好外键引用，事务替换实际不应失败；兜底转领域错误码。
      throw httpError('BACKUP_INVALID', `恢复档案数据未通过：${(error as Error).message}`);
    }
    archiveGeneratedWorkflowFilesExcept(new Set(validated.profiles.map((profile) => profile.workflowFile)));
    try {
      const currentConfig = await loadConfig();
      if (currentConfig.autoStart !== validated.config.autoStart) {
        await setWindowsAutoStart(validated.config.autoStart);
      }
    } catch (error) {
      // 自启为 OS 侧尽力而为项：设置已随 config.json 恢复，Startup 文件落定失败只记诊断，不回滚恢复。
      console.error('[backup] 自启设置恢复失败（设置本体已恢复）：', error);
    }

    const result: RestoreResult = {
      restored: true,
      fileName,
      profileCount: validated.profiles.length,
      preferenceCount: validated.preferences.length,
      restoredAt: new Date().toISOString(),
      galleryRoot: validated.config.galleryRoot
    };
    this.deps.onRestoreApplied?.(result);
    return result;
  }
}

/** sha256(canonicalJson(content))：键序无关的内容完整性校验（SERVER §11）。 */
function computeChecksum(content: BackupContent): string {
  return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
}

/** 恢复前的结构校验（类型逐项核对，不含语义级依赖检查）；失败 → BACKUP_INVALID。 */
function validateBackupContent(content: BackupContent): { config: ServerConfig; profiles: BackupContent['profiles']; preferences: WorkflowPreferenceDumpRow[] } {
  const invalid = (reason: string): never => {
    throw httpError('BACKUP_INVALID', `备份内容结构无效：${reason}`);
  };
  const config = content.config;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) invalid('config 缺失。');
  for (const field of ['host', 'comfyBaseUrl', 'galleryRoot'] as const) {
    if (typeof config[field] !== 'string') invalid(`config.${field} 必须是字符串。`);
  }
  for (const field of ['port', 'apiPort'] as const) {
    if (typeof config[field] !== 'number' || !Number.isInteger(config[field])) invalid(`config.${field} 必须是整数。`);
  }
  if (typeof config.autoStart !== 'boolean') invalid('config.autoStart 必须是布尔值。');
  if (typeof config.ai !== 'object' || config.ai === null) invalid('config.ai 缺失。');
  const ai = config.ai;
  if (typeof ai.enabled !== 'boolean' || typeof ai.endpoint !== 'string' || typeof ai.model !== 'string') {
    invalid('config.ai 字段类型无效。');
  }
  if (ai.apiKeyProtected !== null && typeof ai.apiKeyProtected !== 'string') invalid('config.ai.apiKeyProtected 必须是字符串或 null。');

  if (!Array.isArray(content.profiles)) invalid('profiles 必须是数组。');
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const profile of content.profiles) {
    if (typeof profile !== 'object' || profile === null) invalid('profiles 项必须是对象。');
    for (const field of ['id', 'name', 'revision', 'fingerprint'] as const) {
      if (typeof profile[field] !== 'string' || profile[field].length === 0) invalid(`profiles 项 ${field} 必须是非空字符串。`);
    }
    if (!Array.isArray(profile.confirmedModes) || profile.confirmedModes.some((mode) => typeof mode !== 'string')) {
      invalid(`profiles 项 ${profile.id} confirmedModes 必须是字符串数组。`);
    }
    if (typeof profile.isDefault !== 'boolean') invalid(`profiles 项 ${profile.id} isDefault 必须是布尔值。`);
    if (typeof profile.workflow !== 'object' || profile.workflow === null || Array.isArray(profile.workflow)) {
      invalid(`profiles 项 ${profile.id} workflow 必须是对象。`);
    }
    const analysis = profile.analysis;
    if (typeof analysis !== 'object' || analysis === null) invalid(`profiles 项 ${profile.id} analysis 必须是对象。`);
    if (!Array.isArray(analysis.parameters) || !Array.isArray(analysis.loras)) {
      invalid(`profiles 项 ${profile.id} analysis.parameters/loras 必须是数组。`);
    }
    if (seenIds.has(profile.id) || seenNames.has(profile.name)) invalid(`profiles 项 id/name 重复：${profile.id} / ${profile.name}。`);
    seenIds.add(profile.id);
    seenNames.add(profile.name);
  }
  // is_default 单例不变量：备份内多个 default 时只保留首个（校验从宽，落库由 replace 语义保证单例）。
  let defaultSeen = false;
  for (const profile of content.profiles) {
    if (profile.isDefault && defaultSeen) profile.isDefault = false;
    if (profile.isDefault) defaultSeen = true;
  }

  if (!Array.isArray(content.preferences)) invalid('preferences 必须是数组。');
  for (const preference of content.preferences) {
    if (typeof preference !== 'object' || preference === null) invalid('preferences 项必须是对象。');
    if (typeof preference.workflowId !== 'string' || typeof preference.workflowRevision !== 'string' || typeof preference.prefKey !== 'string') {
      invalid('preferences 项 workflowId/workflowRevision/prefKey 必须是字符串。');
    }
    if (!seenIds.has(preference.workflowId)) invalid(`preferences 项引用了备份外的档案：${preference.workflowId}。`);
  }
  return {
    config,
    profiles: content.profiles.map((profile) => ({
      ...profile,
      workflowFile: typeof profile.workflowFile === 'string' && profile.workflowFile.length > 0
        ? profile.workflowFile
        : legacyProfilePath(profile.id)
    })),
    preferences: content.preferences
  };
}
