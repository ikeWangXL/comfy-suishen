import type { ApiWorkflow, ParsedLora } from "../workflows/profileStore.js";
import { collectModelReferences, normalizeObjectInfo, reachableNodeIds, requiredInputGaps, scanLoras } from "../workflows/schemaParser.js";

export type ComfySystemStats = Record<string, unknown>;
export type ComfyHistory = Record<string, unknown>;
export type ComfyImageDescriptor = { filename: string; subfolder?: string; type?: string };
export type DependencyReport = {
  connected: boolean;
  missingNodes: string[];
  missingModels: string[];
  missingLoras: string[];
  mappingErrors: string[];
  loras: ParsedLora[];
  systemStats?: ComfySystemStats;
};

export class ComfyHttpError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
    this.name = "ComfyHttpError";
  }
}

export class ComfyClient {
  private baseUrl: URL;
  private objectInfoCache: { data: Record<string, unknown>; fetchedAt: number } | null = null;
  private static readonly OBJECT_INFO_TTL_MS = 30_000;

  constructor(baseUrl = "http://127.0.0.1:8188", private readonly requestTimeoutMs = 15_000) {
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  }

  /**
   * 运行时切换 ComfyUI 地址（S8 /local/api/config 与备份恢复用）：调用方先完成 URL 形状校验，
   * 这里只负责落位。object_info 缓存属于旧实例，切换即失效。
   */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    this.objectInfoCache = null;
  }

  get baseUrlText(): string {
    return this.baseUrl.toString().replace(/\/$/, "");
  }

  /** object_info 结果 30s 级 TTL 缓存（方案 §2.1：降低状态轮询与建任务的重复 HTTP 开销）；force 绕过缓存。 */
  async getObjectInfo(force = false): Promise<Record<string, unknown>> {
    if (!force && this.objectInfoCache && Date.now() - this.objectInfoCache.fetchedAt < ComfyClient.OBJECT_INFO_TTL_MS) {
      return this.objectInfoCache.data;
    }
    const data = await this.getJson<Record<string, unknown>>("object_info");
    this.objectInfoCache = { data, fetchedAt: Date.now() };
    return data;
  }

  /**
   * 依赖检查（SERVER §6.2）：可达图 required 输入预检（§7.2 F2）→ mappingErrors 精确到 nodeId；
   * 节点类型/模型/LoRA 文件缺失；LoRA 扫描按节点类型、不依赖标题。
   * 模型列表每次现拉；调用方须在建任务前重新调用（状态缓存不取代提交前校验）。
   */
  async inspectDependencies(workflow: ApiWorkflow): Promise<DependencyReport> {
    const report: DependencyReport = { connected: false, missingNodes: [], missingModels: [], missingLoras: [], mappingErrors: [], loras: [] };
    report.loras = scanLoras(workflow);
    let objectInfo: Record<string, unknown>;
    try {
      objectInfo = await this.getObjectInfo();
    } catch {
      return report;
    }
    report.connected = true;
    try {
      report.systemStats = await this.getJson<ComfySystemStats>("system_stats");
    } catch {
      // system_stats 为尽力而为的附带信息，不影响 connected 判定
    }
    const specs = normalizeObjectInfo(objectInfo);
    for (const node of Object.values(workflow)) {
      if (!specs.has(node.class_type) && !report.missingNodes.includes(node.class_type)) {
        report.missingNodes.push(node.class_type);
      }
    }
    const reachable = reachableNodeIds(workflow, specs);
    report.mappingErrors.push(...requiredInputGaps(workflow, specs, reachable));
    const references = collectModelReferences(workflow);
    const folders = [...new Set(references.flatMap((ref) => ref.folders))];
    const modelLists = new Map<string, string[]>();
    await Promise.all(folders.map(async (folder) => {
      try {
        modelLists.set(folder, await this.getJson<string[]>(`models/${encodeURIComponent(folder)}`));
      } catch {
        modelLists.set(folder, []);
      }
    }));
    for (const ref of references) {
      const installed = ref.folders.some((folder) => (modelLists.get(folder) ?? []).includes(ref.name));
      if (!installed) {
        (ref.kind === "lora" ? report.missingLoras : report.missingModels).push(ref.name);
      }
    }
    return report;
  }

  /** /status 快照用 system_stats 探测：尽力而为、不抛错；version 取 system.comfyui_version。 */
  async probeSystemStats(): Promise<{ connected: boolean; version: string | null }> {
    try {
      const stats = await this.getJson<Record<string, unknown>>("system_stats");
      const system = (stats.system ?? {}) as Record<string, unknown>;
      const version = typeof system.comfyui_version === "string" ? system.comfyui_version : null;
      return { connected: true, version };
    } catch {
      return { connected: false, version: null };
    }
  }

  async submitPrompt(workflow: ApiWorkflow, clientId?: string): Promise<{ prompt_id: string; number?: number; node_errors?: unknown }> {
    const result = await this.postJson<{ prompt_id?: string; number?: number; node_errors?: unknown }>("prompt", { prompt: workflow, ...(clientId ? { client_id: clientId } : {}) });
    if (!result.prompt_id) throw new ComfyHttpError("ComfyUI 未返回 prompt_id", 502, result.node_errors);
    return { prompt_id: result.prompt_id, number: result.number, node_errors: result.node_errors };
  }

  getHistory(promptId: string): Promise<ComfyHistory> {
    return this.getJson<ComfyHistory>(`history/${encodeURIComponent(promptId)}`);
  }

  getWebSocketUrl(clientId: string): URL {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
    url.searchParams.set("clientId", clientId);
    return url;
  }

  async getOutputImage(image: ComfyImageDescriptor): Promise<Uint8Array> {
    const url = new URL("view", this.baseUrl);
    url.searchParams.set("filename", image.filename);
    url.searchParams.set("subfolder", image.subfolder ?? "");
    url.searchParams.set("type", image.type ?? "output");
    const response = await this.fetchWithTimeout(url, { method: "GET" });
    if (!response.ok) throw new ComfyHttpError(`ComfyUI /view 请求失败（HTTP ${response.status}）`, response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  async cancelPrompt(promptId: string): Promise<boolean> {
    // Only remove this prompt if it is still pending. Never call /interrupt because older
    // ComfyUI builds may ignore prompt_id and interrupt a user's unrelated workflow.
    try {
      const queue = await this.getJson<Record<string, unknown>>("queue");
      if (!queueContains(queue.queue_pending, promptId)) return false;
      await this.postJson("queue", { delete: [promptId] });
      const afterDelete = await this.getJson<Record<string, unknown>>("queue");
      if (queueContains(afterDelete.queue_running, promptId)) return false;
      if (queueContains(afterDelete.queue_pending, promptId)) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async getJson<T>(route: string): Promise<T> {
    const response = await this.fetchWithTimeout(new URL(route, this.baseUrl), { method: "GET" });
    return this.readJson<T>(response);
  }

  private async postJson<T = unknown>(route: string, body: unknown): Promise<T> {
    const response = await this.fetchWithTimeout(new URL(route, this.baseUrl), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return this.readJson<T>(response);
  }

  private async readJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
    if (!response.ok) throw new ComfyHttpError(`ComfyUI 请求失败（HTTP ${response.status}）`, response.status, parsed);
    return parsed as T;
  }

  private async fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    try { return await fetch(url, { ...init, signal }); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ComfyHttpError(`无法连接 ComfyUI：${detail}`);
    }
  }
}

function queueContains(value: unknown, promptId: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (Array.isArray(entry)) return entry[1] === promptId;
    if (entry && typeof entry === "object") return (entry as Record<string, unknown>).prompt_id === promptId;
    return false;
  });
}
