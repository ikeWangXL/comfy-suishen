import { randomInt, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import WebSocket from 'ws';
import { AppDatabase, type JobRecord, type JobStatus } from './database.js';
import { GalleryStore, isGallerySpaceLow, type GalleryImageMetadata } from './galleryStore.js';
import { ComfyClient, type ComfyImageDescriptor } from './comfy/ComfyClient.js';
import { httpError } from './http/errors.js';
import type { EventsChannel } from './http/events.js';
import type { ApiWorkflow, ParameterRole } from './workflows/profileStore.js';

export type AiExpansionMode = 'none' | 'comfyui_clip' | 'custom_llm';

export interface JobParameterRef {
  nodeId: number | string;
  inputName: string;
  value: unknown;
  role?: ParameterRole;
}

export interface JobLoraSetting {
  nodeId: number | string;
  loraName: string;
  enabled: boolean;
  strength: number;
}

/** POST /jobs 冻结快照：jobTemplate 已注入参数、LoRA 和 AI 开关，种子留到每次执行时写入。 */
export interface JobPayload {
  workflowId: string;
  workflowRevision: string;
  workflowFingerprint: string;
  workflowName: string;
  mode: 'quick' | 'professional';
  originalPrompt: string;
  finalPrompt: string;
  aiExpansionMode: AiExpansionMode;
  count: number;
  seedBase: number | null;
  folderName: string;
  parameters: JobParameterRef[];
  loras: JobLoraSetting[];
  jobTemplate: ApiWorkflow;
  previewOutputNodeIds?: string[];
  expansionOutputNodeId: string | null;
  aiSystemPromptApplied?: boolean;
  clipExpansionWarning?: string;
  seedTarget: { nodeId: string; inputName: string } | null;
  samplerMetadata: SamplerMetadata;
}

export interface SamplerMetadata {
  model: string | null;
  loras: Array<{ nodeId: number | string | null; loraName: string; enabled: boolean; strength: number }>;
  sampler: string | null;
  steps: number | null;
  cfg: number | null;
  scheduler: string | null;
  denoise: number | null;
}

export interface SavedJobState {
  startedAt?: string;
  total: number;
  completedCount: number;
  currentIndex: number;
  progress: number;
  stage: 'queued' | 'executing' | 'saving';
  imageIds: string[];
  cancelPolicy?: 'prompt_id' | 'after_current';
  currentPromptId?: string;
  currentClientId?: string;
  currentSeed?: number;
  executionWorkflow?: ApiWorkflow;
}

type ComfyWaitResult = { kind: 'completed'; images: ComfyImageDescriptor[]; expandedPrompt?: string } | { kind: 'interrupted' };

/** 种子范围：ComfyUI 种子为非负整数；随机区间取 2^32（与 ComfyUI 常用 UI 上限一致），seedBase 校验放宽到安全整数。 */
const RANDOM_SEED_MAX = 2 ** 32;
/** waitForPrompt 允许 ComfyUI 不可达的连续轮询次数（900ms 间隔约 30s）：超限判定离线并中止（SERVER §9.2）。 */
const MAX_CONSECUTIVE_UNREACHABLE = 30;

/**
 * 生成任务队列（S5 / API §8 / SERVER §9）：串行提交，每次一个独立 prompt、
 * 快照冻结、幂等创建（routes 层配 Idempotency-Key）、重启对账（§9.2）、定向取消（§9.3）。
 */
export class JobQueue {
  private pending: string[] = [];
  private pumping = false;
  private activeJobId: string | null = null;
  private activePromptId: string | null = null;
  private activeComfy: ComfyClient | null = null;
  private readonly cancelRequested = new Set<string>();
  private readonly removedPromptJobs = new Set<string>();

  constructor(
    private readonly database: AppDatabase,
    private readonly gallery: GalleryStore,
    private readonly comfy: ComfyClient,
    private readonly emit: EventsChannel['emit'],
  ) {}

  create(payload: JobPayload, idempotencyKey: string): JobRecord {
    const job: JobRecord = {
      id: randomUUID(),
      status: 'queued',
      payload,
      result: emptyState(payload.count),
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.database.saveNewJob(job, payload.count, idempotencyKey);
    this.emitJob('job.created', job, stateOf(job));
    this.pending.push(job.id);
    this.pump();
    return this.database.getJob(job.id) ?? job;
  }

  /** 服务启动恢复（SERVER §9.2）：未终结任务按创建顺序重新入泵；cancelling 保持取消意图。 */
  enqueueForRecovery(): void {
    const unfinished: JobRecord[] = [];
    let offset = 0;
    for (;;) {
      const page = this.database.listJobs(undefined, 500, offset);
      unfinished.push(...page.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'cancelling'));
      if (page.length < 500) break;
      offset += page.length;
    }
    for (const job of unfinished) {
      if (job.status === 'cancelling') this.cancelRequested.add(job.id);
      this.pending.push(job.id);
    }
    this.pump();
  }

  async cancel(jobId: string): Promise<{ job: JobRecord; cancelPolicy: 'prompt_id' | 'after_current' }> {
    const job = this.database.getJob(jobId);
    if (!job) throw httpError('JOB_NOT_FOUND', '任务不存在。');
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      throw httpError('JOB_NOT_CANCELLABLE', '任务已结束，不能取消。');
    }

    const state = stateOf(job);
    const isQueued = job.status === 'queued' && this.activeJobId !== jobId;
    if (isQueued) {
      this.pending = this.pending.filter((id) => id !== jobId);
      state.cancelPolicy = 'after_current';
      const cancelled: JobRecord = { ...job, status: 'cancelled', result: state };
      this.database.saveJob(cancelled);
      this.emitJob('job.cancelled', cancelled, state, { cancelPolicy: state.cancelPolicy });
      this.cancelRequested.delete(jobId);
      return { job: cancelled, cancelPolicy: 'after_current' };
    }

    const cancelling: JobRecord = { ...job, status: 'cancelling', result: state };
    this.database.saveJob(cancelling);
    this.emitJob('job.canceling', cancelling, state);
    this.cancelRequested.add(jobId);
    const activePromptId = this.activePromptId;
    const activeComfy = this.activeComfy;
    if (this.activeJobId === jobId && activePromptId && activeComfy) {
      try {
        const removed = await activeComfy.cancelPrompt(activePromptId);
        state.cancelPolicy = removed ? 'prompt_id' : 'after_current';
        if (removed) this.removedPromptJobs.add(jobId);
      } catch {
        // 定向删除不可用时等待当前图完成、跳过余图（SERVER §9.3）。
        state.cancelPolicy = 'after_current';
      }
      this.database.saveJob({ ...cancelling, result: state });
    } else {
      state.cancelPolicy = 'after_current';
      this.database.saveJob({ ...cancelling, result: state });
    }
    return { job: this.database.getJob(jobId) ?? cancelling, cancelPolicy: state.cancelPolicy };
  }

  get(jobId: string): JobRecord | null {
    return this.database.getJob(jobId);
  }

  list(status?: JobStatus, limit = 30, offset = 0, oldestFirst = false): { items: JobRecord[]; nextCursor: string } {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 30, 1), 100);
    const safeOffset = Math.max(Math.trunc(offset) || 0, 0);
    const items = this.database.listJobs(status, safeLimit, safeOffset, oldestFirst);
    return { items, nextCursor: items.length === safeLimit ? String(safeOffset + safeLimit) : '' };
  }

  summary(): { pendingJobs: number; runningJobId: string | null } {
    return { pendingJobs: this.pending.length, runningJobId: this.activeJobId };
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      try {
        while (this.pending.length) {
          const jobId = this.pending.shift()!;
          const job = this.database.getJob(jobId);
          if (!job || job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') continue;
          this.activeJobId = jobId;
          await this.runJob(job);
          this.activeJobId = null;
          this.activePromptId = null;
          this.activeComfy = null;
        }
      } finally {
        this.activeJobId = null;
        this.activePromptId = null;
        this.activeComfy = null;
        this.pumping = false;
        if (this.pending.length) this.pump();
      }
    })();
  }

  private async runJob(initial: JobRecord): Promise<void> {
    const payload = initial.payload as JobPayload;
    let state = stateOf(initial);
    state.total = payload.count;
    let job: JobRecord = { ...initial, status: 'running', result: state, error: null };
    this.database.saveJob(job);

    try {
      // SERVER §9.2 重启对账：上一进程已提交的 prompt_id 先核对，可判定完成图入库；不可判定标 failed 不重复提交。
      if (state.currentPromptId && state.currentClientId) {
        const resumedComfy = this.comfy;
        this.activePromptId = state.currentPromptId;
        this.activeComfy = resumedComfy;
        if (this.cancelRequested.has(job.id)) {
          try {
            const removed = await resumedComfy.cancelPrompt(state.currentPromptId);
            state.cancelPolicy = removed ? 'prompt_id' : 'after_current';
            if (removed) this.removedPromptJobs.add(job.id);
          } catch {
            state.cancelPolicy = 'after_current';
          }
        }
        const resumed = await this.waitForPrompt(job, state, resumedComfy, state.currentPromptId, state.currentClientId);
        if (resumed.kind === 'interrupted') {
          await this.finishCancelled(job, state);
          return;
        }
        await this.completeOutputs(job, payload, state, resumedComfy, state.currentPromptId, resumed.images, resumed.expandedPrompt);
        state.completedCount += 1;
        state.currentPromptId = undefined;
        state.currentClientId = undefined;
        state.currentSeed = undefined;
        state.executionWorkflow = undefined;
        state.progress = 0;
        job = { ...job, result: state };
        this.database.saveJob(job);
      }

      for (let index = state.completedCount + 1; index <= payload.count; index++) {
        if (this.cancelRequested.has(job.id)) {
          await this.finishCancelled(job, state);
          return;
        }
        await this.assertGalleryReady(payload);
        state.currentIndex = index;
        state.stage = 'executing';
        state.startedAt ??= new Date().toISOString();
        state.progress = 0;
        job = { ...job, status: 'running', result: state };
        this.database.saveJob(job);
        this.emitJob('job.started', job, state);

        const comfy = this.comfy;
        const clientId = randomUUID();
        const seed = payload.seedBase === null ? randomInt(0, RANDOM_SEED_MAX) : payload.seedBase + index - 1;
        state.currentSeed = seed;
        state.executionWorkflow = this.buildImageWorkflow(payload, seed);
        this.database.saveJob({ ...job, result: state });
        const submitted = await comfy.submitPrompt(state.executionWorkflow, clientId);
        this.database.updateJobImage(job.id, index, { status: 'submitted', promptId: submitted.prompt_id, seed });
        state.currentPromptId = submitted.prompt_id;
        state.currentClientId = clientId;
        state.cancelPolicy = this.cancelRequested.has(job.id) ? 'after_current' : undefined;
        this.activePromptId = submitted.prompt_id;
        this.activeComfy = comfy;
        job = { ...job, result: state, status: this.cancelRequested.has(job.id) ? 'cancelling' : 'running' };
        this.database.saveJob(job);

        if (this.cancelRequested.has(job.id)) {
          try {
            const removed = await comfy.cancelPrompt(submitted.prompt_id);
            state.cancelPolicy = removed ? 'prompt_id' : 'after_current';
            if (removed) this.removedPromptJobs.add(job.id);
          } catch {
            state.cancelPolicy = 'after_current';
          }
          this.database.saveJob({ ...job, result: state });
        }

        const completed = await this.waitForPrompt(job, state, comfy, submitted.prompt_id, clientId);
        this.activePromptId = null;
        this.activeComfy = null;
        if (completed.kind === 'interrupted') {
          await this.finishCancelled(job, state);
          return;
        }
        await this.completeOutputs(job, payload, state, comfy, submitted.prompt_id, completed.images, completed.expandedPrompt);
        state.completedCount += 1;
        state.currentPromptId = undefined;
        state.currentClientId = undefined;
        state.currentSeed = undefined;
        state.executionWorkflow = undefined;
        state.progress = 0;
        job = { ...job, result: state };
        this.database.saveJob(job);

        if (this.cancelRequested.has(job.id)) {
          await this.finishCancelled(job, state);
          return;
        }
      }

      job = { ...job, status: 'completed', result: state, error: null };
      this.database.saveJob(job);
      this.emitJob('job.completed', job, state);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : '生成任务失败。';
      job = { ...job, status: 'failed', result: state, error: message };
      this.database.saveJob(job);
      this.emitJob('job.failed', job, state, { error: message });
      this.cancelRequested.delete(job.id);
    }
  }

  /** 单图工作流：冻结模板 + 逐张种子（v1.1 种子经连线写入 [params{int}-种子] 节点值）。 */
  private buildImageWorkflow(payload: JobPayload, seed: number): ApiWorkflow {
    const workflow = structuredClone(payload.jobTemplate);
    if (payload.seedTarget) {
      const target = workflow[payload.seedTarget.nodeId];
      if (target) target.inputs[payload.seedTarget.inputName] = seed;
    }
    return workflow;
  }

  /** 生成前空间复核（SERVER §10.2）：未配置/不可读 → GALLERY_UNAVAILABLE；低于阈值 → DISK_SPACE_LOW。 */
  private async assertGalleryReady(_payload: JobPayload): Promise<void> {
    const stats = await this.gallery.getVolumeStatsIfConfigured();
    if (stats === null) throw new Error('GALLERY_UNAVAILABLE: 图库根目录未配置或不可读。');
    if (isGallerySpaceLow(stats.freeBytes, stats.totalBytes)) {
      throw new Error(`DISK_SPACE_LOW: 图库剩余空间不足（${stats.freeBytes} 字节）。`);
    }
  }

  private async waitForPrompt(
    job: JobRecord,
    state: SavedJobState,
    comfy: ComfyClient,
    promptId: string,
    clientId: string,
    existingSocket?: WebSocket | null,
  ): Promise<ComfyWaitResult> {
    const socket = existingSocket === undefined ? await openProgressSocket(comfy, clientId) : existingSocket;
    let interrupted = false;
    let terminalError: string | null = null;
    let unreachableStreak = 0;
    const onMessage = (raw: WebSocket.RawData): void => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; data?: Record<string, unknown> };
        const data = message.data ?? {};
        if (data.prompt_id !== undefined && data.prompt_id !== promptId) return;
        if (message.type === 'progress') {
          const value = Number(data.value);
          const max = Number(data.max);
          if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
            state.progress = Math.max(0, Math.min(1, value / max));
            state.stage = 'executing';
            this.database.saveJob({ ...job, result: state });
            this.emitJob('job.progress', job, state, { stage: 'executing', progress: state.progress });
          }
        } else if (message.type === 'execution_interrupted') {
          interrupted = true;
        } else if (message.type === 'execution_error') {
          terminalError = 'ComfyUI 执行工作流失败。';
        }
      } catch {
        // 非 JSON 预览消息忽略。
      }
    };
    socket?.on('message', onMessage);
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    try {
      while (Date.now() < deadline) {
        if (this.removedPromptJobs.has(job.id)) return { kind: 'interrupted' };
        if (interrupted) return { kind: 'interrupted' };
        if (terminalError) throw new Error(terminalError);

        let history: Record<string, unknown> = {};
        try {
          history = await comfy.getHistory(promptId) as Record<string, unknown>;
          unreachableStreak = 0;
        } catch {
          // ComfyUI 瞬时不可达（重启中）继续轮询；连续超限（约 30s）判定离线并中止任务。
          unreachableStreak += 1;
          if (unreachableStreak >= MAX_CONSECUTIVE_UNREACHABLE) {
            throw new Error('COMFY_UNREACHABLE: ComfyUI 持续不可达，任务等待中止。');
          }
        }
        const entry = (history[promptId] ?? history) as Record<string, unknown> | undefined;
        const status = entry?.status as Record<string, unknown> | undefined;
        const statusString = String(status?.status_str ?? '').toLowerCase();
        if (statusString === 'error' || statusString === 'failed') throw new Error('ComfyUI 执行工作流失败。');
        const outputs = entry?.outputs as Record<string, { images?: ComfyImageDescriptor[]; text?: unknown }> | undefined;
        const jobPayload = job.payload as JobPayload;
        const images = Object.values(outputs ?? {}).flatMap((output) => output?.images ?? []);
        if (images.length === 0 && (status?.completed === true || statusString === 'success' || statusString === 'completed')) {
          throw new Error('ComfyUI 已执行完毕，但未返回 Server 可读取的图片输出。');
        }
        if (images.length > 0 && (status?.completed === true || statusString === 'success' || statusString === 'completed' || !status)) {
          const expandedPrompt = jobPayload.expansionOutputNodeId
            ? extractTextOutput(outputs?.[jobPayload.expansionOutputNodeId]?.text)
            : undefined;
          if (jobPayload.aiExpansionMode === 'comfyui_clip' && jobPayload.expansionOutputNodeId && !expandedPrompt) {
            throw new Error('ComfyUI 未返回 CLIP 扩写文本，生成图片未入库。');
          }
          return { kind: 'completed', images, ...(expandedPrompt === undefined ? {} : { expandedPrompt }) };
        }
        await delay(900);
      }
      throw new Error('ComfyUI 任务等待超时（24 小时）。');
    } finally {
      socket?.off('message', onMessage);
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    }
  }

  private async completeOutputs(
    job: JobRecord,
    payload: JobPayload,
    state: SavedJobState,
    comfy: ComfyClient,
    promptId: string,
    images: ComfyImageDescriptor[],
    expandedPrompt?: string
  ): Promise<void> {
    const rows = this.database.listJobImages(job.id);
    const savedRows = rows.filter((row) => row.promptId === promptId && row.imageId !== null);
    for (const row of savedRows) {
      if (row.imageId !== null && !state.imageIds.includes(row.imageId)) state.imageIds.push(row.imageId);
    }
    let nextExtraIndex = Math.max(payload.count, rows.at(-1)?.imageIndex ?? 0) + 1;
    for (let output = savedRows.length; output < images.length; output += 1) {
      const imageIndex = output === 0 ? state.currentIndex : nextExtraIndex++;
      await this.completeImage(job, payload, state, comfy, images[output], imageIndex, promptId, expandedPrompt);
    }
  }

  /** 下载、创建缩略图、入库，逐张发布图片事件。 */
  private async completeImage(
    job: JobRecord,
    payload: JobPayload,
    state: SavedJobState,
    comfy: ComfyClient,
    descriptor: ComfyImageDescriptor,
    imageIndex: number,
    promptId: string,
    expandedPrompt?: string,
  ): Promise<void> {
    if (!descriptor.filename) throw new Error('ComfyUI 返回的图像缺少文件名。');
    state.stage = 'saving';
    this.database.saveJob({ ...job, result: state });

    const original = await comfy.getOutputImage(descriptor);
    const metadata = await sharp(original).metadata();
    const thumbnail = await sharp(original).rotate()
      .resize({ width: 560, height: 560, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer();
    const extension = pathExtension(descriptor.filename) || (metadata.format ?? 'png');
    const fileName = (payload.previewOutputNodeIds?.length ?? 0) > 0 && descriptor.type === 'temp'
      ? `app-${job.id.slice(0, 8)}-${String(imageIndex).padStart(2, '0')}.${extension}`
      : descriptor.filename;
    const finalPrompt = expandedPrompt ?? payload.finalPrompt;
    const imageMetadata: GalleryImageMetadata = {
      jobId: job.id,
      createdAt: new Date().toISOString(),
      imageIndex,
      originalPrompt: payload.originalPrompt,
      finalPrompt,
      aiExpansionMode: payload.aiExpansionMode,
      workflowId: payload.workflowId,
      workflowName: payload.workflowName,
      workflowMode: payload.mode,
      workflowRevision: payload.workflowRevision,
      workflowFingerprint: payload.workflowFingerprint,
      paramSnapshot: {
        workflowRevision: payload.workflowRevision,
        parameters: payload.parameters,
        loras: payload.loras
      },
      seed: payload.seedTarget ? state.currentSeed ?? null : null,
      aspectRatio: aspectRatioParameter(payload),
      megapixels: numericParameter(payload, 'megapixels'),
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      model: payload.samplerMetadata.model,
      loras: payload.samplerMetadata.loras,
      sampler: payload.samplerMetadata.sampler,
      steps: payload.samplerMetadata.steps,
      cfg: payload.samplerMetadata.cfg,
      scheduler: payload.samplerMetadata.scheduler,
      denoise: payload.samplerMetadata.denoise,
      promptId: state.currentPromptId ?? null,
      galleryRoot: this.gallery.root,
      folderName: payload.folderName
    };
    const saved = await this.gallery.save({
      folderName: payload.folderName,
      original,
      thumbnail,
      fileName,
      extension,
      thumbnailExtension: 'webp',
      mimeType: formatMime(metadata.format),
      prompt: finalPrompt,
      metadata: imageMetadata,
    });
    if (imageIndex === state.currentIndex) {
      this.database.updateJobImage(job.id, imageIndex, { status: 'completed', imageId: saved.id });
    } else {
      this.database.addJobOutput(job.id, imageIndex, saved.id, promptId, imageMetadata.seed);
    }
    state.imageIds.push(saved.id);
    this.database.saveJob({ ...job, result: state });
    this.emitJob('job.image_created', job, state, {
      imageId: saved.id,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
    });
  }

  private async finishCancelled(job: JobRecord, state: SavedJobState): Promise<void> {
    const persisted = this.database.getJob(job.id);
    if (!state.cancelPolicy && persisted) state.cancelPolicy = stateOf(persisted).cancelPolicy;
    state.cancelPolicy ??= 'after_current';
    state.currentPromptId = undefined;
    state.currentClientId = undefined;
    state.currentSeed = undefined;
    state.executionWorkflow = undefined;
    // 未执行的余图收回 pending → cancelled（SERVER §9.3：已完成图片和记录保留）。
    for (const image of this.database.listJobImages(job.id)) {
      if (image.status === 'pending') {
        this.database.updateJobImage(job.id, image.imageIndex, { status: 'failed', error: '任务取消，未执行。' });
      }
    }
    const cancelled: JobRecord = { ...job, status: 'cancelled', result: state, error: null };
    this.database.saveJob(cancelled);
    this.emitJob('job.cancelled', cancelled, state, { cancelPolicy: state.cancelPolicy });
    this.cancelRequested.delete(job.id);
    this.removedPromptJobs.delete(job.id);
  }

  private emitJob(event: string, job: JobRecord, state: SavedJobState, extra: Record<string, unknown> = {}): void {
    const payload = job.payload as JobPayload;
    this.emit(event, {
      jobId: job.id,
      status: job.status,
      currentIndex: state.currentIndex,
      count: payload.count,
      completedCount: state.completedCount,
      ...extra,
    });
  }
}

export function jobState(job: JobRecord): Record<string, unknown> {
  const payload = job.payload as JobPayload;
  const state = stateOf(job);
  return {
    jobId: job.id,
    status: job.status,
    currentIndex: state.currentIndex,
    count: payload.count,
    completedCount: state.completedCount,
    progress: state.progress,
    errorMessage: job.error ?? null,
    createdAt: job.createdAt ?? '',
    imageIds: state.imageIds,
  };
}

function stateOf(job: JobRecord): SavedJobState {
  const value = job.result && typeof job.result === 'object' ? job.result as Partial<SavedJobState> : {};
  return {
    startedAt: value.startedAt,
    total: typeof value.total === 'number' ? value.total : (job.payload as JobPayload | undefined)?.count ?? 0,
    completedCount: typeof value.completedCount === 'number' ? value.completedCount : 0,
    currentIndex: typeof value.currentIndex === 'number' ? value.currentIndex : 0,
    progress: typeof value.progress === 'number' ? value.progress : 0,
    stage: value.stage === 'executing' || value.stage === 'saving' ? value.stage : 'queued',
    imageIds: Array.isArray(value.imageIds) ? value.imageIds : [],
    cancelPolicy: value.cancelPolicy === 'prompt_id' || value.cancelPolicy === 'after_current' ? value.cancelPolicy : undefined,
    currentPromptId: typeof value.currentPromptId === 'string' ? value.currentPromptId : undefined,
    currentClientId: typeof value.currentClientId === 'string' ? value.currentClientId : undefined,
    currentSeed: typeof value.currentSeed === 'number' ? value.currentSeed : undefined,
    executionWorkflow: value.executionWorkflow,
  };
}

function emptyState(count: number): SavedJobState {
  return { total: count, completedCount: 0, currentIndex: 0, progress: 0, stage: 'queued', imageIds: [] };
}

async function openProgressSocket(comfy: ComfyClient, clientId: string): Promise<WebSocket | null> {
  const url = comfy.getWebSocketUrl(clientId);
  const socket = new WebSocket(url);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { socket.close(); resolve(null); }, 4000);
    socket.once('open', () => { clearTimeout(timeout); resolve(socket); });
    socket.once('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

function formatMime(format?: string): string {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  if (format === 'avif') return 'image/avif';
  return 'image/png';
}

function extractTextOutput(output: unknown): string | undefined {
  if (!Array.isArray(output) || typeof output[0] !== 'string' || output[0].trim().length === 0) return undefined;
  return output[0];
}

function pathExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1) : '';
}

function numericParameter(payload: JobPayload, role: 'megapixels'): number | null {
  const found = payload.parameters.find((parameter) => parameter.role === role) ??
    payload.parameters.find((parameter) => parameter.inputName === role);
  return typeof found?.value === 'number' && Number.isFinite(found.value) ? found.value : null;
}

function aspectRatioParameter(payload: JobPayload): string | null {
  const found = payload.parameters.find((parameter) => parameter.role === 'aspectRatio') ??
    payload.parameters.find((parameter) => parameter.inputName === 'aspect_ratio');
  return typeof found?.value === 'string' && found.value.length > 0 ? found.value : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

