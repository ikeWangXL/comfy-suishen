import { createHash } from "node:crypto";
import { RESOLUTION_SELECTOR_ENUMS } from "../workflows/resolution.js";
import { loadWorkflowFile } from "../workflows/workflowFiles.js";

export type ApiNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string; [key: string]: unknown };
};

export type ApiWorkflow = Record<string, ApiNode>;

export type WorkflowParameters = {
  finalPrompt: string;
  seed: number;
  aspectRatio: string;
  megapixels: number;
  filenamePrefix?: string;
};

export type ModelReference = { folder: string; alternateFolders?: string[]; name: string; kind: "model" | "lora" };

// v1.1 模板的比例参数为 comfy-core ResolutionSelector（comfy_extras/nodes_resolution.py）：
// 枚举值带显示标签（如 "9:16 (Portrait Widescreen)"），API 短标签（"9:16" 等）由首段唯一映射到枚举值。
const ALLOWED_RATIOS = new Set<string>(RESOLUTION_SELECTOR_ENUMS);
const SHORT_LABEL_TO_ENUM = new Map(RESOLUTION_SELECTOR_ENUMS.map((label) => [label.split(" (")[0], label]));

function isLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && typeof value[0] === "string";
}

function scrubSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) scrubSecrets(item);
    return;
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (/^(api[_-]?key|apikey)$/i.test(key)) {
      delete object[key];
    } else {
      scrubSecrets(object[key]);
    }
  }
}

export class WorkflowAdapter {
  private constructor(private readonly template: ApiWorkflow) {}

  static async load(): Promise<WorkflowAdapter> {
    const parsed: unknown = loadWorkflowFile("upload/app图片工作流-v1.1.json");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("工作流模板必须是 ComfyUI API Prompt JSON 对象");
    }
    // Workflow files may carry credentials (the legacy template shipped one). Never retain or forward them.
    scrubSecrets(parsed);
    const adapter = new WorkflowAdapter(parsed as ApiWorkflow);
    adapter.validateMappings();
    return adapter;
  }

  getTemplate(): ApiWorkflow {
    return structuredClone(this.template);
  }

  getDefaults(): { prompt: string; aspectRatio: string; megapixels: number } {
    const prompt = this.find("PrimitiveStringMultiline", "[params{string}-提示词]").inputs.value;
    const ratio = this.find("ResolutionSelector", "[params{enum}-比例]").inputs;
    const pixels = this.find("PrimitiveFloat", "[params{float}-像素]").inputs.value;
    return {
      prompt: typeof prompt === "string" ? prompt : "",
      aspectRatio: typeof ratio.aspect_ratio === "string" ? ratio.aspect_ratio : "9:16 (Portrait Widescreen)",
      megapixels: typeof pixels === "number" ? pixels : 1,
    };
  }

  getAiSystemPrompt(): string {
    const node = Object.values(this.template).find(
      (node) => node.class_type === "PrimitiveStringMultiline" && node._meta?.title === "[params{string}-ai扩写提示词]",
    );
    const value = node?.inputs.value;
    return typeof value === "string" ? value : "";
  }

  getFingerprint(): string {
    return createHash("sha256").update(JSON.stringify(this.template)).digest("hex");
  }

  getGenerationMetadata(): Record<string, unknown> {
    const nodes = Object.values(this.createExecutionWorkflow(""));
    const find = (classType: string): ApiNode | undefined => nodes.find((node) => node.class_type === classType);
    const sampler = find("KSampler")?.inputs ?? {};
    const modelNode = nodes.find((node) => node.class_type === "UNETLoader" || node.class_type === "CheckpointLoaderSimple");
    const baseModel = modelNode?.inputs.unet_name ?? modelNode?.inputs.ckpt_name ?? null;
    const modelNames = nodes.flatMap((node) => {
      const inputs = node.inputs;
      return ["unet_name", "ckpt_name", "clip_name", "vae_name"]
        .filter((field) => typeof inputs[field] === "string")
        .map((field) => inputs[field] as string);
    });
    const loras = nodes.filter((node) => node.class_type === "LoraLoader" || node.class_type === "LoraLoaderModelOnly")
      .map((node) => ({
        name: node.inputs.lora_name,
        strengthModel: node.inputs.strength_model,
        strengthClip: node.inputs.strength_clip,
      }));
    return {
      model: typeof baseModel === "string" ? baseModel : null,
      modelFiles: modelNames,
      loras,
      sampler: sampler.sampler_name,
      steps: sampler.steps,
      cfg: sampler.cfg,
      scheduler: sampler.scheduler,
      denoise: sampler.denoise,
      workflowFingerprint: this.getFingerprint(),
    };
  }

  validateMappings(): void {
    const prompt = this.find("PrimitiveStringMultiline", "[params{string}-提示词]");
    const seed = this.find("PrimitiveInt", "[params{int}-种子]");
    const ratio = this.find("ResolutionSelector", "[params{enum}-比例]");
    const pixels = this.find("PrimitiveFloat", "[params{float}-像素]");
    const latent = this.find("EmptySD3LatentImage", "空Latent图像");
    const sampler = this.find("KSampler", "K采样器");
    const save = this.find("SaveImage", "保存图像（agent可用）");
    const decode = this.find("VAEDecode", "VAE解码");

    for (const [node, field] of [
      [prompt, "value"], [seed, "value"], [ratio, "aspect_ratio"], [pixels, "value"],
      [latent, "batch_size"], [save, "filename_prefix"], [decode, "samples"],
    ] as const) {
      if (!(field in node.inputs)) throw new Error(`工作流映射无效：${node.class_type} 缺少 ${field}`);
    }
    // v1.1 结构：种子与出图尺寸由参数节点经连线供值，写入点在参数节点自身。
    const samplerSeed = sampler.inputs.seed;
    if (!isLink(samplerSeed) || this.template[samplerSeed[0]] !== seed) {
      throw new Error("工作流映射无效：KSampler.seed 未连接到种子参数节点");
    }
    for (const field of ["width", "height"] as const) {
      const sizeSource = latent.inputs[field];
      if (!isLink(sizeSource) || this.template[sizeSource[0]] !== ratio) {
        throw new Error(`工作流映射无效：EmptySD3LatentImage.${field} 未连接到比例节点`);
      }
    }
    const imageSource = save.inputs.images;
    if (!isLink(imageSource) || this.template[imageSource[0]]?.class_type !== "VAEDecode") {
      throw new Error("工作流映射无效：SaveImage.images 未连接到 VAEDecode");
    }
    // Verify that the direct prompt node feeds the positive text path through the expected switches.
    const positiveNodes = Object.values(this.template).filter((node) => node.class_type === "CLIPTextEncode" && /Positive Prompt/i.test(node._meta?.title ?? ""));
    if (positiveNodes.length !== 1 || !isLink(positiveNodes[0].inputs.text)) throw new Error("工作流映射无效：正向 CLIPTextEncode 提示词入口应恰好有一个");
    const positive = positiveNodes[0];
    const textPath = this.resolveTextPath(positive.inputs.text);
    if (!textPath.some((id) => id === this.nodeId(prompt))) throw new Error("工作流映射无效：直接提示词节点未连接到正向提示词");
  }

  buildPrompt(parameters: WorkflowParameters): ApiWorkflow {
    const aspectRatio = this.normalizeAspectRatio(parameters.aspectRatio);
    this.validateParameters({ ...parameters, aspectRatio });
    const workflow = this.createExecutionWorkflow(parameters.finalPrompt);
    const seedId = this.findId(workflow, "PrimitiveInt", "[params{int}-种子]");
    const ratioId = this.findId(workflow, "ResolutionSelector", "[params{enum}-比例]");
    const pixelsId = this.findId(workflow, "PrimitiveFloat", "[params{float}-像素]");
    const latentId = this.findId(workflow, "EmptySD3LatentImage", "空Latent图像");
    const saveId = this.findId(workflow, "SaveImage", "保存图像（agent可用）");

    workflow[seedId].inputs.value = parameters.seed;
    workflow[ratioId].inputs.aspect_ratio = aspectRatio;
    workflow[pixelsId].inputs.value = parameters.megapixels;
    workflow[latentId].inputs.batch_size = 1;
    workflow[saveId].inputs.filename_prefix = parameters.filenamePrefix ?? "app";
    return workflow;
  }

  getModelReferences(): ModelReference[] {
    const refs: ModelReference[] = [];
    const folders: Record<string, string> = {
      UNETLoader: "diffusion_models", CheckpointLoaderSimple: "checkpoints",
      CLIPLoader: "text_encoders", DualCLIPLoader: "text_encoders", VAELoader: "vae",
    };
    for (const node of Object.values(this.createExecutionWorkflow(""))) {
      const input = node.inputs as Record<string, unknown>;
      if (node.class_type === "LoraLoader" || node.class_type === "LoraLoaderModelOnly") {
        if (typeof input.lora_name === "string") refs.push({ folder: "loras", name: input.lora_name, kind: "lora" });
      } else {
        const folder = folders[node.class_type];
        const field = node.class_type === "UNETLoader" ? "unet_name" : node.class_type === "VAELoader" ? "vae_name" : node.class_type === "CheckpointLoaderSimple" ? "ckpt_name" : "clip_name";
        if (folder && typeof input[field] === "string") refs.push({
          folder,
          ...(node.class_type === "CLIPLoader" || node.class_type === "DualCLIPLoader" ? { alternateFolders: ["clip"] } : {}),
          name: input[field] as string,
          kind: "model",
        });
      }
    }
    return refs;
  }

  getNodeTypes(): string[] {
    return [...new Set(Object.values(this.createExecutionWorkflow("")).map((node) => node.class_type))];
  }

  private createExecutionWorkflow(finalPrompt: string): ApiWorkflow {
    const workflow = structuredClone(this.template);
    // 提示词写入 [params{string}-提示词] 参数节点（1025），保留 AI 扩写切换链路（1062/1064）；
    // 扩写开关取值由建任务参数（aiExpansionMode 推导）决定，此处不干预。
    const promptId = this.findId(workflow, "PrimitiveStringMultiline", "[params{string}-提示词]");
    workflow[promptId].inputs.value = finalPrompt;

    const saveId = this.findId(workflow, "SaveImage", "保存图像（agent可用）");
    const reachable = new Set<string>();
    const visit = (id: string): void => {
      if (reachable.has(id) || !workflow[id]) return;
      reachable.add(id);
      for (const value of Object.values(workflow[id].inputs)) {
        if (isLink(value)) visit(value[0]);
      }
    };
    visit(saveId);
    for (const id of Object.keys(workflow)) if (!reachable.has(id)) delete workflow[id];
    return workflow;
  }

  private find(classType: string, title: string): ApiNode {
    const found = Object.values(this.template).filter((node) => node.class_type === classType && node._meta?.title === title);
    if (found.length !== 1) throw new Error(`工作流映射无效：${classType}（${title}）应恰好有一个，当前为 ${found.length} 个`);
    return found[0];
  }

  private findId(workflow: ApiWorkflow, classType: string, title: string): string {
    const found = Object.entries(workflow).filter(([, node]) => node.class_type === classType && node._meta?.title === title);
    if (found.length !== 1) throw new Error(`工作流映射无效：${classType}（${title}）应恰好有一个，当前为 ${found.length} 个`);
    return found[0][0];
  }

  private nodeId(node: ApiNode): string {
    return Object.entries(this.template).find(([, value]) => value === node)?.[0] ?? "";
  }

  private resolveTextPath(value: unknown, visited = new Set<string>()): string[] {
    if (!isLink(value) || visited.has(value[0])) return [];
    visited.add(value[0]);
    const id = value[0];
    const node = this.template[id];
    if (!node) return [];
    return [id, ...Object.values(node.inputs).flatMap((next) => this.resolveTextPath(next, visited))];
  }

  private validateParameters(parameters: WorkflowParameters): void {
    if (typeof parameters.finalPrompt !== "string" || !parameters.finalPrompt.trim()) throw new Error("finalPrompt 不能为空");
    if (!Number.isSafeInteger(parameters.seed) || parameters.seed < 0) throw new Error("seed 必须是非负安全整数");
    if (!ALLOWED_RATIOS.has(parameters.aspectRatio)) throw new Error(`aspectRatio 不在允许列表中：${parameters.aspectRatio}`);
    if (!Number.isFinite(parameters.megapixels) || parameters.megapixels <= 0) throw new Error("megapixels 必须为正数");
  }

  /** API 短标签（"9:16"）→ ResolutionSelector 实际枚举值；已是枚举值则原样返回。 */
  private normalizeAspectRatio(value: string): string {
    if (ALLOWED_RATIOS.has(value)) return value;
    const mapped = SHORT_LABEL_TO_ENUM.get(value);
    if (mapped !== undefined) return mapped;
    throw new Error(`aspectRatio 不在允许列表中：${value}（应为 comfy ResolutionSelector 枚举值或 1:1/9:16 等短标签）`);
  }
}
