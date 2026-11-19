import { resolvePrimitiveNumber, type ObjectInfoNodeSpec } from './schemaParser.js';
import type { ApiWorkflow } from './profileStore.js';

export interface ResolutionNode {
  classType: string;
  inputs: Record<string, unknown>;
}

export interface ResolutionResult {
  width: number;
  height: number;
  effectiveMegapixels: number;
  effectiveAspectRatio: string;
  algorithm: string;
}

/** 预览不可用（未知 class_type、未知枚举值、image 分支等）——调用方按契约返回明确错误，不回退本地估算。 */
export class ResolutionUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionUnsupportedError';
  }
}

// comfy-core ResolutionSelector 的比例枚举值 → (宽比, 高比)，精确对应 comfy_extras/nodes_resolution.py 的 ASPECT_RATIOS。
const RESOLUTION_SELECTOR_RATIOS: Record<string, [number, number]> = {
  '1:1 (Square)': [1, 1],
  '2:3 (Portrait Photo)': [2, 3],
  '3:2 (Photo)': [3, 2],
  '3:4 (Portrait Standard)': [3, 4],
  '4:3 (Standard)': [4, 3],
  '9:16 (Portrait Widescreen)': [9, 16],
  '16:9 (Widescreen)': [16, 9],
  '21:9 (Ultrawide)': [21, 9]
};

/** ResolutionSelector 比例枚举值全集（WorkflowAdapter 参数校验与短标签映射的取值来源，顺序同 nodes_resolution.py）。 */
export const RESOLUTION_SELECTOR_ENUMS: readonly string[] = Object.keys(RESOLUTION_SELECTOR_RATIOS);

/**
 * 分辨率预览与出图同算法入口（§4.3）：aspectValue 为实际枚举值（§4.2 映射后），
 * megapixels 为请求/任务值（覆盖节点连线来源的 megapixels 输入）。
 * 出图时注入输入值、计算交给 ComfyUI；预览在 server 侧按同一节点算法计算。
 */
export function resolveResolution(
  node: ResolutionNode, schema: ObjectInfoNodeSpec | undefined, aspectValue: string, megapixels: number, workflow: ApiWorkflow = {}
): ResolutionResult {
  if (!Number.isFinite(megapixels) || megapixels <= 0) {
    throw new ResolutionUnsupportedError(`无效的 megapixels：${megapixels}`);
  }
  const mpSpec = schema ? [...schema.required, ...schema.optional].find((s) => s.name === 'megapixels') : undefined;
  if (mpSpec?.min !== undefined && megapixels < mpSpec.min) {
    throw new ResolutionUnsupportedError(`megapixels=${megapixels} 低于节点允许下限 ${mpSpec.min}`);
  }
  if (mpSpec?.max !== undefined && megapixels > mpSpec.max) {
    throw new ResolutionUnsupportedError(`megapixels=${megapixels} 超过节点允许上限 ${mpSpec.max}`);
  }
  if (node.classType !== 'ResolutionSelector') {
    throw new ResolutionUnsupportedError('分辨率预览需要 ComfyUI 的 ResolutionSelector 节点。');
  }
  const multiple = resolvePrimitiveNumber(workflow, node.inputs.multiple ?? 8);
  if (multiple === undefined) {
    throw new ResolutionUnsupportedError('无法读取分辨率对齐倍数，请直接填写数值或连接整数值节点。');
  }
  return resolveComfySelector(Math.round(multiple), aspectValue, megapixels);
}

/** Python round() 为银行家舍入；JS Math.round 是半进位——必须等价移植，否则宽高对不齐。 */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** comfy_extras/nodes_resolution.py::ResolutionSelector.execute 精确移植（MP 基准 1024×1024，multiple 取整无下限）。 */
function resolveComfySelector(multiple: number, aspectValue: string, megapixels: number): ResolutionResult {
  const ratios = RESOLUTION_SELECTOR_RATIOS[aspectValue];
  if (!ratios) {
    throw new ResolutionUnsupportedError(`ResolutionSelector 不支持比例枚举值 ${aspectValue}`);
  }
  if (multiple < 1) {
    throw new ResolutionUnsupportedError(`ResolutionSelector 的 multiple=${multiple} 无效`);
  }
  const totalPixels = megapixels * 1024 * 1024;
  const scale = Math.sqrt(totalPixels / (ratios[0] * ratios[1]));
  const width = roundHalfEven((ratios[0] * scale) / multiple) * multiple;
  const height = roundHalfEven((ratios[1] * scale) / multiple) * multiple;
  return {
    width,
    height,
    effectiveMegapixels: (width * height) / 1_000_000,
    effectiveAspectRatio: aspectValue,
    algorithm: 'ResolutionSelector'
  };
}
