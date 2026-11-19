import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase, WorkflowProfileRecord as WorkflowProfileRecordDb } from '../database.js';
import { httpError } from '../http/errors.js';
import { imageOutputNodeIds, parseWorkflow, type ObjectInfoNodeSpec } from './schemaParser.js';
import {
  deleteWorkflowFile,
  discoverWorkflowFiles,
  hasWorkflowFile,
  saveWorkflowFile,
  uploadProfilePath,
  workflowFileProfileId
} from './workflowFiles.js';

/** ComfyUI API prompt JSON（SERVER §7.1）：对象 { nodeId: { class_type, inputs, _meta } }，非画布导出格式。
 * _meta 除 title 外可带 cnr_id/ver 等扩展键（V1/v1.1 模板实况），未知键按 unknown 保留、永不解析。 */
export interface ApiWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string } & Record<string, unknown>;
}
export type ApiWorkflow = Record<string, ApiWorkflowNode>;

export function availableProfileModes(profile: WorkflowProfileRecordDb): string[] {
  return profile.analysis.imageOutputAvailable === false || imageOutputNodeIds(profile.workflow).length === 0 ? [] :
    profile.confirmedModes.filter((mode) => profile.analysis.suggestedModes.some((available) => available === mode));
}

export type ParameterType = 'string' | 'int' | 'float' | 'boolean' | 'enum' | 'model' | 'clip' | 'vae';

/** 普通模式四角色（方案 §4.1-4）；其余标记参数为专业模式控件（Q2 一套解析）。 */
export type ParameterRole = 'prompt' | 'aspectRatio' | 'megapixels' | 'aiExpansion';

export type GenerationMode = 'quick' | 'professional';
export type AiExpansionMode = 'none' | 'comfyui_clip' | 'custom_llm';

export interface EnumOption {
  label: string;
  value: string;
}

export interface ParameterConstraints {
  min?: number;
  max?: number;
  step?: number;
}

export interface ParsedParameter {
  key: string;
  name: string;
  type: ParameterType;
  role: ParameterRole | null;
  nodeId: number | string;
  inputName: string;
  value: unknown;
  defaultValue: unknown;
  mode: GenerationMode;
  displayValue?: string;
  options?: EnumOption[];
  constraints?: ParameterConstraints;
}

export interface ParsedLora {
  nodeId: number | string;
  loraName: string;
  strength: number;
  enabled: boolean;
}

export interface InspectionIssue {
  nodeId: number | string | null;
  severity: 'error' | 'warning';
  message: string;
}

export interface WorkflowReadonlyInfo {
  sampler: string | null;
  scheduler: string | null;
}

export interface WorkflowAnalysis {
  imageOutputAvailable?: boolean;
  revision: string;
  fingerprint: string;
  parameters: ParsedParameter[];
  loras: ParsedLora[];
  aiExpansionModes: AiExpansionMode[];
  suggestedModes: GenerationMode[];
  issues: InspectionIssue[];
  readonlyInfo: WorkflowReadonlyInfo;
}

/** 解析结果暂存记录（S3 由调用方暂存；S4 落 DB workflow_inspections）。原始 JSON 深拷贝、永不修改。 */
export interface InspectionRecord {
  inspectionId: string;
  createdAt: string;
  analysis: WorkflowAnalysis;
  originalWorkflow: ApiWorkflow;
}

/** 节点 ID：数字串转 number（契约 nodeId:number），其余（如 "1023:494"）保留字符串。 */
export function parseNodeId(rawId: string): number | string {
  return /^\d+$/.test(rawId) ? Number(rawId) : rawId;
}

/** 规范化序列化：对象键排序递归，同一语义 JSON 恒等。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** workflowRevision/fingerprint：规范化 JSON 的 sha256；revision 为 "sha256:<hex>"（契约示例形状）。 */
export function computeWorkflowIdentity(workflow: ApiWorkflow): { revision: string; fingerprint: string } {
  const fingerprint = createHash('sha256').update(canonicalJson(workflow), 'utf8').digest('hex');
  return { revision: `sha256:${fingerprint}`, fingerprint };
}

export function buildInspectionRecord(analysis: WorkflowAnalysis, originalWorkflow: ApiWorkflow): InspectionRecord {
  return {
    inspectionId: `inspect_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    analysis,
    originalWorkflow: structuredClone(originalWorkflow)
  };
}

// ---------- S4 档案域（SERVER §6.2/§7 / API §5） ----------

/** 节点 inputs 内的密钥字段名（SERVER §11：嵌入工作流的第三方密钥不进运行图/响应/日志）。 */
const SECRET_KEY_PATTERN = /^(api[_-]?key|apikey)$/i;

/** 入库前深拷贝并递归剥离 api_key 类字段；返回净化的原始 JSON 副本。 */
export function scrubWorkflowSecrets(workflow: ApiWorkflow): ApiWorkflow {
  const clone = structuredClone(workflow);
  scrubSecretsIn(clone);
  return clone;
}

function scrubSecretsIn(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) scrubSecretsIn(item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SECRET_KEY_PATTERN.test(key)) delete record[key];
    else scrubSecretsIn(record[key]);
  }
}

export class WorkflowProfileStore {
  constructor(private readonly database: AppDatabase) {}

  listProfiles(mode?: string): WorkflowProfileRecordDb[] {
    return this.database.listWorkflowProfiles(mode)
      .filter((profile) => hasWorkflowFile(profile.workflowFile) && (mode === undefined || availableProfileModes(profile).includes(mode)));
  }

  getProfile(id: string): WorkflowProfileRecordDb | null {
    const profile = this.database.getWorkflowProfile(id);
    return profile && hasWorkflowFile(profile.workflowFile) ? profile : null;
  }

  getDefaultProfile(): WorkflowProfileRecordDb | null {
    const profile = this.database.getDefaultWorkflowProfile();
    return profile && hasWorkflowFile(profile.workflowFile) ? profile : null;
  }

  requireProfile(id: string): WorkflowProfileRecordDb {
    const profile = this.getProfile(id);
    if (!profile) throw httpError('WORKFLOW_NOT_FOUND', '工作流档案不存在，可能已被删除。');
    return profile;
  }

  /** 首个档案自动默认（API §5）；之后仅在 setAsDefault 时替换。档案名全局唯一（PATCH 重命名同口径）。
   * setAsDefault 时清零既有默认位（S8 冒烟发现的双默认缺陷修复：直接插 is_default=1 会与旧默认并存，
   * getDefaultProfile LIMIT 1 会命中先插入的旧行）。 */
  createProfile(input: {
    name: string;
    confirmedModes: string[];
    setAsDefault: boolean;
    analysis: WorkflowAnalysis;
    workflow: ApiWorkflow;
  }): WorkflowProfileRecordDb {
    if (this.database.workflowProfileNameExists(input.name)) {
      throw httpError('CONFLICT', `档案名"${input.name}"已被使用，请换一个名称。`);
    }
    const id = `wf_${randomUUID()}`;
    const workflowFile = uploadProfilePath(id);
    saveWorkflowFile(workflowFile, input.workflow);
    const priorCount = this.database.countWorkflowProfiles();
    const currentDefault = this.database.getDefaultWorkflowProfile();
    const isDefault = input.setAsDefault || !currentDefault || !hasWorkflowFile(currentDefault.workflowFile);
    this.database.saveWorkflowProfile({
      id,
      name: input.name,
      revision: input.analysis.revision,
      fingerprint: input.analysis.fingerprint,
      confirmedModes: input.confirmedModes,
      isDefault,
      workflowFile,
      workflow: input.workflow,
      analysis: input.analysis
    });
    if (isDefault && priorCount > 0) {
      this.database.setDefaultWorkflowProfile(id);
    }
    return this.requireProfile(id);
  }

  renameProfile(id: string, name: string): WorkflowProfileRecordDb {
    const profile = this.requireProfile(id);
    if (name !== profile.name && this.database.workflowProfileNameExists(name, id)) {
      throw httpError('CONFLICT', `档案名"${name}"已被使用，请换一个名称。`);
    }
    this.database.renameWorkflowProfile(id, name);
    return this.requireProfile(id);
  }

  /** 删除默认档案后不自动顺位（API §5：由用户另行选择），默认位保持空缺直到 PUT /default。 */
  setDefaultProfile(id: string): WorkflowProfileRecordDb {
    this.requireProfile(id);
    this.database.setDefaultWorkflowProfile(id);
    return this.requireProfile(id);
  }

  deleteProfile(id: string): void {
    const profile = this.requireProfile(id);
    if (this.database.workflowInActiveUse(id)) {
      throw httpError('WORKFLOW_IN_USE', '档案正在被运行中的生成任务使用，等待任务结束后再删除。');
    }
    deleteWorkflowFile(profile.workflowFile);
    this.database.deleteWorkflowProfile(id);
  }

  /** Register files placed directly in upload/create, and refresh changed graphs from their file source. */
  syncWorkflowFiles(files: ReturnType<typeof discoverWorkflowFiles>, specs: Map<string, ObjectInfoNodeSpec>): void {
    const profiles = this.database.listWorkflowProfiles();
    const profileByFile = new Map(profiles.map((profile) => [profile.workflowFile, profile]));
    for (const file of files) {
      const existing = profileByFile.get(file.relativePath);
      const fingerprint = computeWorkflowIdentity(file.workflow).fingerprint;
      if (existing?.fingerprint === fingerprint && (existing.analysis.imageOutputAvailable === true ||
        (existing.analysis.imageOutputAvailable === false && imageOutputNodeIds(file.workflow).length === 0)) &&
        existing.analysis.parameters.length > 0) continue;
      const analysis = parseWorkflow(file.workflow, specs);
      if (!existing) {
        const baseName = file.name || '工作流';
        let name = baseName;
        let suffix = 2;
        while (this.database.workflowProfileNameExists(name)) name = `${baseName} (${suffix++})`;
        const id = workflowFileProfileId(file.relativePath);
        const priorCount = this.database.countWorkflowProfiles();
        const currentDefault = this.database.getDefaultWorkflowProfile();
        const isDefault = !currentDefault || !hasWorkflowFile(currentDefault.workflowFile);
        this.database.saveWorkflowProfile({
          id,
          name,
          revision: analysis.revision,
          fingerprint: analysis.fingerprint,
          confirmedModes: analysis.suggestedModes,
          isDefault,
          workflowFile: file.relativePath,
          workflow: file.workflow,
          analysis
        });
        if (isDefault && priorCount > 0) this.database.setDefaultWorkflowProfile(id);
        profileByFile.set(file.relativePath, this.database.getWorkflowProfile(id) as WorkflowProfileRecordDb);
        continue;
      }
      const changed = existing.fingerprint !== analysis.fingerprint ||
        canonicalJson(existing.analysis) !== canonicalJson(analysis);
      if (changed) {
        const confirmedModes = existing.confirmedModes;
        this.database.updateWorkflowProfile(existing.id, {
          revision: analysis.revision,
          fingerprint: analysis.fingerprint,
          confirmedModes,
          workflowFile: file.relativePath,
          workflow: file.workflow,
          analysis
        });
      }
    }
  }

  saveInspection(record: InspectionRecord): void {
    this.database.saveWorkflowInspection({
      inspectionId: record.inspectionId,
      revision: record.analysis.revision,
      fingerprint: record.analysis.fingerprint,
      analysis: record.analysis,
      workflow: record.originalWorkflow,
      createdAt: record.createdAt
    });
  }

  getInspection(inspectionId: string): InspectionRecord | null {
    const stored = this.database.getWorkflowInspection(inspectionId);
    if (!stored) return null;
    return {
      inspectionId: stored.inspectionId,
      createdAt: stored.createdAt,
      analysis: stored.analysis,
      originalWorkflow: stored.workflow
    };
  }

}
