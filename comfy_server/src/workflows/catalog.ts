import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { join } from 'node:path';
import type { ComfyClient } from '../comfy/ComfyClient.js';
import type { AppDatabase, WorkflowProfileRecord } from '../database.js';
import { httpError } from '../http/errors.js';
import type { EventsChannel } from '../http/events.js';
import { availableProfileModes, computeWorkflowIdentity, WorkflowProfileStore } from './profileStore.js';
import { imageOutputNodeIds, normalizeObjectInfo } from './schemaParser.js';
import { discoverWorkflowFiles, loadWorkflowFile, workflowDataDirectory } from './workflowFiles.js';

type ChangeKind = 'graph' | 'catalog' | 'preferences';

export class WorkflowCatalog {
  readonly store: WorkflowProfileStore;
  private readonly published = new Map<string, string>();
  private inFlight: Promise<void> | undefined;

  constructor(database: AppDatabase, private readonly comfy: ComfyClient, private readonly emit: EventsChannel['emit']) {
    this.store = new WorkflowProfileStore(database);
    for (const profile of this.store.listProfiles()) this.published.set(profile.id, this.signature(profile));
  }

  watch(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchers = ['upload', 'create'].map((directory) => watch(join(workflowDataDirectory(), directory), (_event, name) => {
      if (name && !name.toLowerCase().endsWith('.json')) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void this.refresh().catch((error: unknown) => console.error('[workflows] 文件同步失败：', error));
      }, 250);
    }));
    for (const watcher of watchers) {
      watcher.on('error', (error) => console.error('[workflows] 目录监听失败：', error));
    }
    return () => {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
  }

  refresh(): Promise<void> {
    this.inFlight ??= this.syncFiles().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  async requireCurrent(id: string): Promise<WorkflowProfileRecord> {
    await this.refresh();
    const profile = this.store.requireProfile(id);
    const fingerprint = computeWorkflowIdentity(loadWorkflowFile(profile.workflowFile)).fingerprint;
    if (fingerprint !== profile.fingerprint) {
      throw httpError('CONFLICT', '工作流已更新，参数表尚未同步，请刷新工作流档案后重试。');
    }
    return profile;
  }

  publish(kind: ChangeKind, workflowIds: string[], changeId: string = randomUUID()) {
    for (const id of workflowIds) {
      const profile = this.store.getProfile(id);
      if (profile) this.published.set(id, this.signature(profile));
      else this.published.delete(id);
    }
    const change = { changeId, changeKind: kind, workflowIds, workflowId: workflowIds.length === 1 ? workflowIds[0] : undefined };
    this.emit('workflow.updated', change);
    return change;
  }

  private async syncFiles(): Promise<void> {
    const files = discoverWorkflowFiles();
    const profiles = new Map(this.store.listProfiles().map((profile) => [profile.workflowFile, profile]));
    const needsAnalysis = files.some((file) => {
      const profile = profiles.get(file.relativePath);
      return !profile || profile.analysis.imageOutputAvailable === undefined ||
        profile.fingerprint !== computeWorkflowIdentity(file.workflow).fingerprint ||
        (profile.analysis.imageOutputAvailable === false && imageOutputNodeIds(file.workflow).length > 0) ||
        profile.analysis.parameters.length === 0 && profile.analysis.issues.some((issue) => issue.severity === 'error');
    });
    if (needsAnalysis) {
      const raw = await this.comfy.getObjectInfo().catch(() => null);
      if (raw) this.store.syncWorkflowFiles(discoverWorkflowFiles(), normalizeObjectInfo(raw));
    }
    const current = new Map(this.store.listProfiles().map((profile) => [profile.id, this.signature(profile)]));
    const changed = [...new Set([...current.keys(), ...this.published.keys()])]
      .filter((id) => current.get(id) !== this.published.get(id));
    if (changed.length > 0) this.publish('graph', changed);
  }

  private signature(profile: WorkflowProfileRecord): string {
    return JSON.stringify([profile.fingerprint, availableProfileModes(profile)]);
  }
}
