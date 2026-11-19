import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ApiWorkflow, WorkflowAnalysis } from './workflows/profileStore.js';
import { buildV1LegacyProfileEntry } from './v1LegacyWorkflow.js';

export type JobStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';

export interface JobRecord {
  id: string;
  status: JobStatus;
  payload: unknown;
  result?: unknown;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ImageRecord {
  id: string;
  folderName: string;
  galleryRoot?: string | null;
  fileName: string;
  thumbnailName: string;
  mimeType?: string | null;
  prompt?: string | null;
  metadata?: unknown;
  createdAt?: string;
}

export interface DeviceTokenRecord {
  deviceId: string;
  deviceName: string;
  tokenHash: string;
  pairedAt?: string;
  lastSeenAt?: string | null;
}

export interface AppSettings {
  key: string;
  value: unknown;
}

/** workflow_profiles 行（S4）：analysis/workflow 以 JSON 深拷贝持久化，读出即对象。 */
export interface WorkflowProfileRecord {
  id: string;
  name: string;
  revision: string;
  fingerprint: string;
  confirmedModes: string[];
  isDefault: boolean;
  workflowFile: string;
  workflow: ApiWorkflow;
  analysis: WorkflowAnalysis;
  createdAt: string;
  updatedAt: string;
}

/** workflow_inspections 行（S4）：inspect→确认→保存的暂存记录。 */
export interface WorkflowInspectionRecord {
  inspectionId: string;
  revision: string;
  fingerprint: string;
  analysis: WorkflowAnalysis;
  workflow: ApiWorkflow;
  createdAt: string;
}

/** workflow_preferences 行读取形状：pref_key 为不透明键（param:/lora:/aiSystemPrompt 前缀），值为解析后 JSON。 */
export interface WorkflowPreferenceRow {
  prefKey: string;
  value: unknown;
}

/** 备份导出/恢复用的偏好全行形状（S8）：带归属档案与 revision。 */
export interface WorkflowPreferenceDumpRow {
  workflowId: string;
  workflowRevision: string;
  prefKey: string;
  value: unknown;
}

/** 逐张状态（S5 / API §8 详情 images 列表）：index 1-based。 */
export interface JobImageRecord {
  jobId: string;
  imageIndex: number;
  status: 'pending' | 'submitted' | 'completed' | 'failed';
  imageId: string | null;
  promptId: string | null;
  seed: number | null;
  error: string | null;
}

type SqlRow = Record<string, string | number | bigint | null>;

interface SchemaMigration {
  version: number;
  name: string;
  statements: readonly string[];
  /**
   * 数据迁移钩子（S8）：schema 语句执行后在同一事务内调用，失败随事务回滚。
   * V1 数据迁移需要 JS 逻辑（存量行搬运/清空），纯 SQL statements 表达不了。
   */
  apply?: (db: DatabaseSync) => void;
}

/** v1 = V1 既有 schema 基线（jobs/images/paired_devices/settings，含 images.gallery_root 列）；后续版本按阶段追加（S2 起）。 */
const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  { version: 1, name: 'baseline-v1-schema', statements: [] },
  {
    version: 2,
    name: 'auth-owner-and-tokens',
    statements: [
      `CREATE TABLE owner_account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );`,
      `CREATE TABLE auth_tokens (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );`
    ]
  },
  {
    version: 3,
    name: 'workflow-profile-domain',
    statements: [
      `CREATE TABLE workflow_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        revision TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        workflow_json TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        confirmed_modes_json TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );`,
      `CREATE TABLE workflow_inspections (
        inspection_id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        workflow_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );`,
      `CREATE TABLE workflow_preferences (
        workflow_id TEXT NOT NULL REFERENCES workflow_profiles(id) ON DELETE CASCADE,
        workflow_revision TEXT NOT NULL,
        pref_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (workflow_id, workflow_revision, pref_key)
      );`
    ]
  },
  {
    version: 4,
    name: 'job-images-and-idempotency',
    statements: [
      `CREATE TABLE job_images (
        job_id TEXT NOT NULL,
        image_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        image_id TEXT,
        prompt_id TEXT,
        seed INTEGER,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (job_id, image_index)
      );`,
      `CREATE INDEX idx_job_images_job ON job_images(job_id, image_index);`,
      `CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );`
    ]
  },
  {
    version: 5,
    name: 'backup-index',
    statements: [
      `CREATE TABLE backup_index (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        format_version INTEGER NOT NULL,
        profile_count INTEGER NOT NULL,
        preference_count INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );`
    ]
  },
  {
    version: 6,
    name: 'v1-legacy-data-migration',
    statements: [],
    apply: applyV1LegacyDataMigration
  },
  {
    version: 7,
    name: 'workflow-files',
    statements: [
      'ALTER TABLE workflow_profiles ADD COLUMN workflow_file TEXT;',
      "UPDATE workflow_profiles SET workflow_file = 'create/profile-' || id || '.json';"
    ]
  }
];

/**
 * V1 数据迁移（SERVER §11 / 方案 §8-S8；用户裁决 Q5：不补写标记、不做兼容——仅数据搬运）。
 * 判定为 V1 遗留库（jobs/images/paired_devices 任一非空）时执行：
 * - 为旧模板创建一条档案条目：原始 JSON（git 历史脱敏快照）深拷贝入库，无标记参数、不可生成；
 *   fingerprint 用 V1 口径哈希，与既有图库 metadata.workflowFingerprint 同源 → 图库/任务历史的
 *   关联引用原样保留（images/jobs 行零改动，不补写 workflowId——关联经 fingerprint 解析）；
 * - paired_devices 数据清空（表结构保留，§3.4 T3）；
 * - 图库/图片/AI 设置（config.json）与 settings 表原样保留，本函数不触碰。
 * 新装空库（三表皆空）不创建迁移档案条目，paired_devices 清空为无操作。
 * 已有 V1.1 档案时不重复创建条目（幂等护栏，正常只随 v6 执行一次）。
 */
function applyV1LegacyDataMigration(db: DatabaseSync): void {
  const hasLegacyEvidence = (table: string): boolean => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as SqlRow;
    return Number(row.n) > 0;
  };
  if (!hasLegacyEvidence('jobs') && !hasLegacyEvidence('images') && !hasLegacyEvidence('paired_devices')) {
    return;
  }
  db.exec('DELETE FROM paired_devices');
  const profileRow = db.prepare('SELECT COUNT(*) AS n FROM workflow_profiles').get() as SqlRow;
  if (Number(profileRow.n) > 0) return;
  const entry = buildV1LegacyProfileEntry();
  db.prepare(`INSERT INTO workflow_profiles
    (id, name, revision, fingerprint, workflow_json, analysis_json, confirmed_modes_json, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.id, entry.name, entry.revision, entry.fingerprint,
      JSON.stringify(entry.workflow), JSON.stringify(entry.analysis),
      JSON.stringify(entry.confirmedModes), entry.isDefault ? 1 : 0);
}

/** Opens the server database and creates the minimal durable schema. */
export class AppDatabase {
  readonly db: DatabaseSync;
  private readonly databasePath: string;
  /** 本轮启动若发生迁移，迁移前数据库文件备份的落盘路径（无迁移或备份失败为 null，SERVER §11）。 */
  preMigrationBackupFile: string | null = null;

  constructor(databasePath: string) {
    const absolutePath = databasePath === ':memory:' ? databasePath : resolve(databasePath);
    if (absolutePath !== ':memory:') mkdirSync(dirname(absolutePath), { recursive: true });
    this.databasePath = absolutePath;
    this.db = new DatabaseSync(absolutePath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        folder_name TEXT NOT NULL,
        gallery_root TEXT,
        file_name TEXT NOT NULL,
        thumbnail_name TEXT NOT NULL,
        mime_type TEXT,
        prompt TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(folder_name, file_name)
      );
      CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
      CREATE TABLE IF NOT EXISTS paired_devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL UNIQUE,
        paired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    const imageColumns = this.db.prepare('PRAGMA table_info(images)').all() as SqlRow[];
    if (!imageColumns.some((column) => column.name === 'gallery_root')) {
      this.db.exec('ALTER TABLE images ADD COLUMN gallery_root TEXT');
    }
    this.runMigrations();
  }

  /** 迁移框架（SERVER §11）：待应用版本在单事务内执行并记录版本号，失败回滚；应用前先备份数据库文件。 */
  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    const appliedVersions = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as SqlRow[]).map((row) => Number(row.version))
    );
    const pending = SCHEMA_MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version));
    if (pending.length > 0) this.backupDatabaseBeforeMigration();
    for (const migration of pending) {
      this.db.exec('BEGIN');
      try {
        for (const statement of migration.statements) this.db.exec(statement);
        migration.apply?.(this.db);
        this.db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw new Error(`数据库迁移 v${migration.version}（${migration.name}）失败：${(error as Error).message}`);
      }
    }
  }

  /**
   * 迁移前数据库备份（SERVER §11"更新前备份数据库；迁移失败回滚并保留旧文件"）：
   * 启动期本进程独占连接，checkpoint(TRUNCATE) 后整文件复制到 backups/ 目录；
   * 备份失败不阻断迁移（回滚本身仍是安全网），只如实记录文件名为 null。
   */
  private backupDatabaseBeforeMigration(): void {
    if (this.databasePath === ':memory:') return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // checkpoint 失败时直接复制主文件仍可用（WAL 内未并入的提交属于丢失窗口，不再补救）。
    }
    try {
      const backupDirectory = join(dirname(this.databasePath), 'backups');
      mkdirSync(backupDirectory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(backupDirectory, `db-pre-migration-${stamp}.sqlite`);
      copyFileSync(this.databasePath, file);
      this.preMigrationBackupFile = file;
    } catch {
      this.preMigrationBackupFile = null;
    }
  }

  /** 本轮启动实际应用的迁移版本（诊断/展示用）。 */
  getAppliedMigrations(): Array<{ version: number; name: string }> {
    const rows = this.db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as SqlRow[];
    return rows.map((row) => ({ version: Number(row.version), name: String(row.name) }));
  }

  saveJob(job: JobRecord): void {
    this.db.prepare(`INSERT INTO jobs (id,status,payload_json,result_json,error,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json,
      result_json=excluded.result_json, error=excluded.error, updated_at=excluded.updated_at`)
      .run(job.id, job.status, JSON.stringify(job.payload), job.result === undefined ? null : JSON.stringify(job.result), job.error ?? null, job.createdAt ?? null);
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as SqlRow | undefined;
    if (!row) return null;
    return { id: String(row.id), status: String(row.status) as JobStatus, payload: parseJson(row.payload_json),
      result: parseJson(row.result_json), error: row.error == null ? null : String(row.error),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }

  listJobs(status?: JobStatus, limit = 50, offset = 0, oldestFirst = false): JobRecord[] {
    const safeLimit = boundedInteger(limit, 1, 500, 50);
    const safeOffset = boundedInteger(offset, 0, 2_147_483_647, 0);
    const direction = oldestFirst ? 'ASC' : 'DESC';
    const order = `ORDER BY created_at ${direction}, rowid ${direction} LIMIT ? OFFSET ?`;
    const rows = (status
      ? this.db.prepare(`SELECT * FROM jobs WHERE status = ? ${order}`).all(status, safeLimit, safeOffset)
      : this.db.prepare(`SELECT * FROM jobs ${order}`).all(safeLimit, safeOffset)) as SqlRow[];
    return rows.map(row => ({ id: String(row.id), status: String(row.status) as JobStatus,
      payload: parseJson(row.payload_json), result: parseJson(row.result_json),
      error: row.error == null ? null : String(row.error), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
  }

  saveImage(image: ImageRecord): void {
    this.db.prepare(`INSERT INTO images (id,folder_name,gallery_root,file_name,thumbnail_name,mime_type,prompt,metadata_json,created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      ON CONFLICT(id) DO UPDATE SET folder_name=excluded.folder_name,gallery_root=excluded.gallery_root,file_name=excluded.file_name,
      thumbnail_name=excluded.thumbnail_name,mime_type=excluded.mime_type,prompt=excluded.prompt,
      metadata_json=excluded.metadata_json`)
      .run(image.id, image.folderName, image.galleryRoot ?? null, image.fileName, image.thumbnailName, image.mimeType ?? null,
        image.prompt ?? null, image.metadata === undefined ? null : JSON.stringify(image.metadata), image.createdAt ?? null);
  }

  hasImageName(folderName: string, fileName: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS found FROM images WHERE folder_name=? AND file_name=? LIMIT 1').get(folderName, fileName));
  }

  getImage(id: string): ImageRecord | null {
    const row = this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? rowToImage(row) : null;
  }

  getImageJobId(image: ImageRecord): string | null {
    const row = this.db.prepare('SELECT job_id FROM job_images WHERE image_id = ?').get(image.id) as SqlRow | undefined;
    const legacyJobId = (image.metadata as { jobId?: unknown } | undefined)?.jobId;
    return row ? String(row.job_id) : typeof legacyJobId === 'string' ? legacyJobId : null;
  }

  deleteGalleryImage(imageId: string, job: JobRecord | null): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM images WHERE id = ?').run(imageId);
      this.db.prepare('DELETE FROM job_images WHERE image_id = ?').run(imageId);
      if (job) {
        const result = job.result as { imageIds?: string[] } | undefined;
        const imageIds = (result?.imageIds ?? []).filter((id) => id !== imageId && this.getImage(id) !== null);
        const remaining = this.db.prepare(`SELECT 1 FROM images AS i
          WHERE json_extract(i.metadata_json, '$.jobId') = ?
            OR i.id IN (SELECT image_id FROM job_images WHERE job_id = ?) LIMIT 1`).get(job.id, job.id);
        if (!remaining && imageIds.length === 0) {
          this.db.prepare('DELETE FROM job_images WHERE job_id = ?').run(job.id);
          this.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
        } else if (result?.imageIds) {
          // Keep updated_at intact: it also represents the job's end time.
          this.db.prepare('UPDATE jobs SET result_json = ? WHERE id = ?')
            .run(JSON.stringify({ ...result, imageIds }), job.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listImages(page = 1, pageSize = 30, folderName?: string, offsetOverride?: number, galleryRoot?: string): { items: ImageRecord[]; page: number; pageSize: number; total: number } {
    const safePage = boundedInteger(page, 1, 2_147_483_647, 1);
    const safeSize = boundedInteger(pageSize, 1, 101, 30);
    const safeOffset = boundedInteger(offsetOverride ?? (safePage - 1) * safeSize, 0, 2_147_483_647, 0);
    const conditions: string[] = [];
    const values: (string | number | null)[] = [];
    if (galleryRoot !== undefined) {
      conditions.push('(gallery_root = ? COLLATE NOCASE OR gallery_root IS NULL)');
      values.push(galleryRoot);
    }
    if (folderName !== undefined) {
      conditions.push('folder_name = ?');
      values.push(folderName);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM images${where}`).get(...values) as SqlRow;
    const rows = this.db.prepare(`SELECT * FROM images${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, safeSize, safeOffset) as SqlRow[];
    return { items: rows.map(rowToImage), page: safePage, pageSize: safeSize, total: Number(totalRow.total) };
  }

  pairDevice(deviceId: string, deviceName: string, tokenHash: string): void {
    this.db.prepare(`INSERT INTO paired_devices(device_id,device_name,token_hash) VALUES (?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET device_name=excluded.device_name,token_hash=excluded.token_hash,
      paired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_seen_at=NULL`)
      .run(deviceId, deviceName, tokenHash);
  }

  getPairedDeviceByTokenHash(tokenHash: string): DeviceTokenRecord | null {
    const row = this.db.prepare('SELECT * FROM paired_devices WHERE token_hash=?').get(tokenHash) as SqlRow | undefined;
    return row ? { deviceId: String(row.device_id), deviceName: String(row.device_name), tokenHash: String(row.token_hash),
      pairedAt: String(row.paired_at), lastSeenAt: row.last_seen_at == null ? null : String(row.last_seen_at) } : null;
  }

  touchPairedDevice(deviceId: string): void {
    this.db.prepare("UPDATE paired_devices SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE device_id=?").run(deviceId);
  }

  removePairedDevice(deviceId: string): void {
    this.db.prepare('DELETE FROM paired_devices WHERE device_id=?').run(deviceId);
  }

  listPairedDevices(): DeviceTokenRecord[] {
    const rows = this.db.prepare('SELECT * FROM paired_devices ORDER BY paired_at DESC').all() as SqlRow[];
    return rows.map(row => ({ deviceId: String(row.device_id), deviceName: String(row.device_name), tokenHash: String(row.token_hash),
      pairedAt: String(row.paired_at), lastSeenAt: row.last_seen_at == null ? null : String(row.last_seen_at) }));
  }

  /** paired_devices 数据清空（§3.4 T3：表结构保留，避免迁移风险）。 */
  clearPairedDevices(): void {
    this.db.exec('DELETE FROM paired_devices');
  }

  getSetting<T = unknown>(key: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key=?').get(key) as SqlRow | undefined;
    return row ? JSON.parse(String(row.value_json)) as T : null;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO settings(key,value_json) VALUES (?,?) ON CONFLICT(key)
      DO UPDATE SET value_json=excluded.value_json,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(key, JSON.stringify(value));
  }

  getOwnerAccount(): { username: string; passwordHash: string } | null {
    const row = this.db.prepare('SELECT username, password_hash FROM owner_account WHERE id = 1').get() as SqlRow | undefined;
    return row ? { username: String(row.username), passwordHash: String(row.password_hash) } : null;
  }

  saveOwnerAccount(username: string, passwordHash: string): void {
    this.db.prepare(`INSERT INTO owner_account (id, username, password_hash) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(username, passwordHash);
  }

  saveAuthToken(tokenHash: string): void {
    this.db.prepare('INSERT OR IGNORE INTO auth_tokens (token_hash) VALUES (?)').run(tokenHash);
  }

  hasAuthToken(tokenHash: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS found FROM auth_tokens WHERE token_hash = ?').get(tokenHash));
  }

  deleteAuthToken(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(tokenHash);
  }

  deleteAllAuthTokens(): void {
    this.db.exec('DELETE FROM auth_tokens');
  }

  // ---------- S4 工作流配置档域（workflow_profiles / workflow_inspections / workflow_preferences） ----------

  saveWorkflowProfile(profile: {
    id: string; name: string; revision: string; fingerprint: string;
    confirmedModes: string[]; isDefault: boolean; workflowFile: string; workflow: ApiWorkflow; analysis: WorkflowAnalysis;
  }): void {
    this.db.prepare(`INSERT INTO workflow_profiles
      (id, name, revision, fingerprint, workflow_json, analysis_json, confirmed_modes_json, is_default, workflow_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(profile.id, profile.name, profile.revision, profile.fingerprint,
        JSON.stringify(profile.workflow), JSON.stringify(profile.analysis),
        JSON.stringify(profile.confirmedModes), profile.isDefault ? 1 : 0, profile.workflowFile);
  }

  updateWorkflowProfile(id: string, profile: {
    revision: string; fingerprint: string; confirmedModes: string[]; workflowFile: string;
    workflow: ApiWorkflow; analysis: WorkflowAnalysis;
  }): void {
    this.db.prepare(`UPDATE workflow_profiles SET revision = ?, fingerprint = ?, workflow_json = ?, analysis_json = ?,
      confirmed_modes_json = ?, workflow_file = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(profile.revision, profile.fingerprint, JSON.stringify(profile.workflow), JSON.stringify(profile.analysis),
        JSON.stringify(profile.confirmedModes), profile.workflowFile, id);
  }

  getWorkflowProfile(id: string): WorkflowProfileRecord | null {
    const row = this.db.prepare('SELECT * FROM workflow_profiles WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? rowToWorkflowProfile(row) : null;
  }

  getDefaultWorkflowProfile(): WorkflowProfileRecord | null {
    const row = this.db.prepare('SELECT * FROM workflow_profiles WHERE is_default = 1 LIMIT 1').get() as SqlRow | undefined;
    return row ? rowToWorkflowProfile(row) : null;
  }

  countWorkflowProfiles(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM workflow_profiles').get() as SqlRow;
    return Number(row.total);
  }

  /** mode 为 'quick'|'professional'（路由已校验）：按 confirmed_modes 过滤，创建时间倒序（API §2 列表规则）。 */
  listWorkflowProfiles(mode?: string): WorkflowProfileRecord[] {
    const rows = (mode === undefined
      ? this.db.prepare('SELECT * FROM workflow_profiles ORDER BY created_at DESC, rowid DESC').all()
      : this.db.prepare('SELECT * FROM workflow_profiles WHERE confirmed_modes_json LIKE ? ORDER BY created_at DESC, rowid DESC')
        .all(`%"${mode}"%`)) as SqlRow[];
    return rows.map(rowToWorkflowProfile);
  }

  workflowProfileNameExists(name: string, excludeId?: string): boolean {
    const row = excludeId === undefined
      ? this.db.prepare('SELECT 1 AS found FROM workflow_profiles WHERE name = ? LIMIT 1').get(name)
      : this.db.prepare('SELECT 1 AS found FROM workflow_profiles WHERE name = ? AND id != ? LIMIT 1').get(name, excludeId);
    return Boolean(row);
  }

  renameWorkflowProfile(id: string, name: string): void {
    this.db.prepare(`UPDATE workflow_profiles SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(name, id);
  }

  /** 默认档案单例不变量：先清零再置位，单事务完成。 */
  setDefaultWorkflowProfile(id: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('UPDATE workflow_profiles SET is_default = 0');
      this.db.prepare(`UPDATE workflow_profiles SET is_default = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteWorkflowProfile(id: string): void {
    // 偏好行经 FK ON DELETE CASCADE 随档案删除；任务/图片/快照保留（API §5）。
    this.db.prepare('DELETE FROM workflow_profiles WHERE id = ?').run(id);
  }

  /** 运行任务引用检查（API §5 WORKFLOW_IN_USE）：S5 建任务 payload 形状含 workflowId（API §8），按其 JSON 串匹配活跃任务。 */
  workflowInActiveUse(workflowId: string): boolean {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM jobs
      WHERE status IN ('queued', 'running', 'cancelling') AND payload_json LIKE ?`)
      .get(`%"workflowId":"${workflowId}"%`) as SqlRow;
    return Number(row.total) > 0;
  }

  saveWorkflowInspection(record: WorkflowInspectionRecord): void {
    this.db.prepare(`INSERT INTO workflow_inspections
      (inspection_id, revision, fingerprint, analysis_json, workflow_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run(record.inspectionId, record.revision, record.fingerprint,
        JSON.stringify(record.analysis), JSON.stringify(record.workflow));
  }

  getWorkflowInspection(inspectionId: string): WorkflowInspectionRecord | null {
    const row = this.db.prepare('SELECT * FROM workflow_inspections WHERE inspection_id = ?')
      .get(inspectionId) as SqlRow | undefined;
    if (!row) return null;
    return {
      inspectionId: String(row.inspection_id),
      revision: String(row.revision),
      fingerprint: String(row.fingerprint),
      analysis: JSON.parse(String(row.analysis_json)) as WorkflowAnalysis,
      workflow: JSON.parse(String(row.workflow_json)) as ApiWorkflow,
      createdAt: String(row.created_at)
    };
  }

  getWorkflowPreferenceRows(workflowId: string, revision: string): WorkflowPreferenceRow[] {
    const rows = this.db.prepare('SELECT pref_key, value_json FROM workflow_preferences WHERE workflow_id = ? AND workflow_revision = ?')
      .all(workflowId, revision) as SqlRow[];
    return rows.map((row) => ({ prefKey: String(row.pref_key), value: parseJson(row.value_json) }));
  }

  /** 偏好整组替换（§6.3 last-write-wins）：单事务先清当前 revision 再写入新组。 */
  replaceWorkflowPreferences(workflowId: string, revision: string, entries: WorkflowPreferenceRow[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM workflow_preferences WHERE workflow_id = ? AND workflow_revision = ?')
        .run(workflowId, revision);
      const insert = this.db.prepare('INSERT INTO workflow_preferences (workflow_id, workflow_revision, pref_key, value_json) VALUES (?, ?, ?, ?)');
      for (const entry of entries) {
        insert.run(workflowId, revision, entry.prefKey, JSON.stringify(entry.value));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------- S5 生成任务域（job_images / idempotency_keys） ----------

  saveNewJob(job: JobRecord, count: number, idempotencyKey: string): void {
    this.db.exec('BEGIN');
    try {
      this.saveJob(job);
      this.createJobImages(job.id, count);
      this.saveIdempotencyKey(idempotencyKey, job.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createJobImages(jobId: string, count: number): void {
    const insert = this.db.prepare('INSERT INTO job_images (job_id, image_index, status) VALUES (?, ?, ?)');
    for (let index = 1; index <= count; index += 1) {
      insert.run(jobId, index, 'pending');
    }
  }

  updateJobImage(jobId: string, imageIndex: number, patch: {
    status?: 'pending' | 'submitted' | 'completed' | 'failed';
    imageId?: string | null;
    promptId?: string | null;
    seed?: number | null;
    error?: string | null;
  }): void {
    const current = this.db.prepare('SELECT * FROM job_images WHERE job_id = ? AND image_index = ?')
      .get(jobId, imageIndex) as SqlRow | undefined;
    if (!current) return;
    this.db.prepare(`UPDATE job_images SET status = ?, image_id = ?, prompt_id = ?, seed = ?, error = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id = ? AND image_index = ?`)
      .run(
        patch.status ?? String(current.status),
        patch.imageId !== undefined ? patch.imageId : current.image_id == null ? null : String(current.image_id),
        patch.promptId !== undefined ? patch.promptId : current.prompt_id == null ? null : String(current.prompt_id),
        patch.seed !== undefined ? patch.seed : current.seed == null ? null : Number(current.seed),
        patch.error !== undefined ? patch.error : current.error == null ? null : String(current.error),
        jobId, imageIndex
      );
  }

  addJobOutput(jobId: string, imageIndex: number, imageId: string, promptId: string, seed: number | null): void {
    this.db.prepare('INSERT INTO job_images (job_id, image_index, status, image_id, prompt_id, seed) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, imageIndex, 'completed', imageId, promptId, seed);
  }

  listJobImages(jobId: string): JobImageRecord[] {
    const rows = this.db.prepare('SELECT * FROM job_images WHERE job_id = ? ORDER BY image_index ASC').all(jobId) as SqlRow[];
    return rows.map((row) => ({
      jobId: String(row.job_id),
      imageIndex: Number(row.image_index),
      status: String(row.status) as JobImageRecord['status'],
      imageId: row.image_id == null ? null : String(row.image_id),
      promptId: row.prompt_id == null ? null : String(row.prompt_id),
      seed: row.seed == null ? null : Number(row.seed),
      error: row.error == null ? null : String(row.error)
    }));
  }

  /** 幂等键（SERVER §9.2）：键 → 首次创建的 jobId；重放由调用方返回同一任务。 */
  saveIdempotencyKey(key: string, jobId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO idempotency_keys (key, job_id) VALUES (?, ?)').run(key, jobId);
  }

  getIdempotencyJobId(key: string): string | null {
    const row = this.db.prepare('SELECT job_id FROM idempotency_keys WHERE key = ?').get(key) as SqlRow | undefined;
    return row ? String(row.job_id) : null;
  }

  // ---------- S8 备份域（backup_index + 档案/偏好 dump 与整体替换） ----------

  saveBackupIndexEntry(entry: {
    id: string; fileName: string; createdAt: string; formatVersion: number;
    profileCount: number; preferenceCount: number; sizeBytes: number; checksum: string;
  }): void {
    this.db.prepare(`INSERT INTO backup_index
      (id, file_name, created_at, format_version, profile_count, preference_count, size_bytes, checksum)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.id, entry.fileName, entry.createdAt, entry.formatVersion,
        entry.profileCount, entry.preferenceCount, entry.sizeBytes, entry.checksum);
  }

  listBackupIndexEntries(): Array<{
    id: string; fileName: string; createdAt: string; formatVersion: number;
    profileCount: number; preferenceCount: number; sizeBytes: number; checksum: string;
  }> {
    const rows = this.db.prepare('SELECT * FROM backup_index ORDER BY created_at DESC, rowid DESC').all() as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id), fileName: String(row.file_name), createdAt: String(row.created_at),
      formatVersion: Number(row.format_version), profileCount: Number(row.profile_count),
      preferenceCount: Number(row.preference_count), sizeBytes: Number(row.size_bytes),
      checksum: String(row.checksum)
    }));
  }

  getBackupIndexEntry(fileName: string): {
    id: string; fileName: string; createdAt: string; formatVersion: number;
    profileCount: number; preferenceCount: number; sizeBytes: number; checksum: string;
  } | null {
    const row = this.db.prepare('SELECT * FROM backup_index WHERE file_name = ?').get(fileName) as SqlRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id), fileName: String(row.file_name), createdAt: String(row.created_at),
      formatVersion: Number(row.format_version), profileCount: Number(row.profile_count),
      preferenceCount: Number(row.preference_count), sizeBytes: Number(row.size_bytes),
      checksum: String(row.checksum)
    };
  }

  /** 备份导出：全部偏好行（backup.ts 结构化打包，restore 时整体替换回去）。 */
  listAllWorkflowPreferenceRows(): WorkflowPreferenceDumpRow[] {
    const rows = this.db.prepare('SELECT workflow_id, workflow_revision, pref_key, value_json FROM workflow_preferences').all() as SqlRow[];
    return rows.map((row) => ({
      workflowId: String(row.workflow_id),
      workflowRevision: String(row.workflow_revision),
      prefKey: String(row.pref_key),
      value: parseJson(row.value_json)
    }));
  }

  /**
   * 备份恢复的档案/偏好整体替换：先清后插，单事务；失败整体回滚，不破坏现数据（SERVER §11）。
   * 偏好行 workflow_id 引用随插入的档案行存在（同事务先插档案再插偏好）。
   */
  replaceProfilesAndPreferences(profiles: Array<{
    id: string; name: string; revision: string; fingerprint: string;
    confirmedModes: string[]; isDefault: boolean; workflowFile: string; workflow: ApiWorkflow; analysis: WorkflowAnalysis;
    createdAt?: string; updatedAt?: string;
  }>, preferences: Array<{ workflowId: string; workflowRevision: string; prefKey: string; value: unknown }>): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM workflow_preferences');
      this.db.exec('DELETE FROM workflow_profiles');
      const insertProfile = this.db.prepare(`INSERT INTO workflow_profiles
        (id, name, revision, fingerprint, workflow_json, analysis_json, confirmed_modes_json, is_default, workflow_file, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
      for (const profile of profiles) {
        insertProfile.run(profile.id, profile.name, profile.revision, profile.fingerprint,
          JSON.stringify(profile.workflow), JSON.stringify(profile.analysis),
          JSON.stringify(profile.confirmedModes), profile.isDefault ? 1 : 0, profile.workflowFile,
          profile.createdAt ?? null, profile.updatedAt ?? null);
      }
      const insertPreference = this.db.prepare(
        'INSERT INTO workflow_preferences (workflow_id, workflow_revision, pref_key, value_json) VALUES (?, ?, ?, ?)');
      for (const preference of preferences) {
        insertPreference.run(preference.workflowId, preference.workflowRevision, preference.prefKey, JSON.stringify(preference.value));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}

function parseJson(value: unknown): unknown {
  return value == null ? null : JSON.parse(String(value));
}

function boundedInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function rowToImage(row: SqlRow): ImageRecord {
  return { id: String(row.id), folderName: String(row.folder_name),
    galleryRoot: row.gallery_root == null ? null : String(row.gallery_root),
    fileName: String(row.file_name), thumbnailName: String(row.thumbnail_name), mimeType: row.mime_type == null ? null : String(row.mime_type),
    prompt: row.prompt == null ? null : String(row.prompt), metadata: parseJson(row.metadata_json), createdAt: String(row.created_at) };
}

function rowToWorkflowProfile(row: SqlRow): WorkflowProfileRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    revision: String(row.revision),
    fingerprint: String(row.fingerprint),
    confirmedModes: JSON.parse(String(row.confirmed_modes_json)) as string[],
    isDefault: Number(row.is_default) === 1,
    workflowFile: String(row.workflow_file ?? ''),
    workflow: JSON.parse(String(row.workflow_json)) as ApiWorkflow,
    analysis: JSON.parse(String(row.analysis_json)) as WorkflowAnalysis,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
