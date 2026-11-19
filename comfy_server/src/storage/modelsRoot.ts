import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppDatabase } from '../database.js';
import { httpError } from '../http/errors.js';
import { assertRealDirectoryTree } from './filesystem.js';

/**
 * ComfyUI 模型目录指向（S6 / API §7 / 裁决 Q1）：server 不扫描模型文件；
 * 把指向写入 ComfyUI 的 extra_model_paths.yaml（YAML 由本模块手工格式化，server 无 yaml 依赖）。
 *
 * yaml 落点 = settings 'comfyDirectory'（ComfyUI 安装目录，S8 控制台负责录入）；
 * 未配置时指向仅入库存档、不写 yaml，响应 needsRestart=false + message 说明（契约缺口，已报主控）。
 */
const MODELS_ROOT_KEY = 'modelsRoot';
const COMFY_DIRECTORY_KEY = 'comfyDirectory';

export interface ModelsRootStatusPayload {
  path: string | null;
  needsRestart: boolean;
}

export interface ModelsRootWriteResult extends ModelsRootStatusPayload {
  yamlWritten: boolean;
  message?: string;
}

const YAML_SUBFOLDERS = ['checkpoints', 'loras', 'vae', 'diffusion_models', 'text_encoders', 'clip'] as const;

export class ModelsRootStore {
  constructor(private readonly database: AppDatabase) {}

  getModelsRoot(): ModelsRootStatusPayload {
    const stored = this.database.getSetting<string>(MODELS_ROOT_KEY);
    return { path: typeof stored === 'string' && stored.length > 0 ? stored : null, needsRestart: false };
  }

  async setModelsRoot(rawPath: unknown): Promise<ModelsRootWriteResult> {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      throw httpError('INVALID_REQUEST', '请求需提供模型目录路径。');
    }
    const target = resolve(rawPath.trim());
    assertRealDirectoryTree(target);

    const comfyDirectory = this.readComfyDirectory();
    let yamlWritten = false;
    let message: string | undefined;
    if (comfyDirectory !== null) {
      this.writeExtraModelPathsYaml(comfyDirectory, target);
      yamlWritten = true;
    } else {
      message = '模型目录指向已保存；尚未配置 ComfyUI 安装目录（控制台设置），extra_model_paths.yaml 未写入，配置后需重新提交。';
    }
    this.database.setSetting(MODELS_ROOT_KEY, target);
    return { path: target, needsRestart: yamlWritten, yamlWritten, message };
  }

  /** 冒烟/运维复位用：清除指向与 ComfyUI 目录设置（不动已写入的 yaml 文件）。 */
  clearSettings(): void {
    this.database.db.prepare('DELETE FROM settings WHERE key = ? OR key = ?').run(MODELS_ROOT_KEY, COMFY_DIRECTORY_KEY);
  }

  getComfyDirectory(): string | null {
    return this.readComfyDirectory();
  }

  setComfyDirectoryForTests(directory: string): void {
    this.database.setSetting(COMFY_DIRECTORY_KEY, directory);
  }

  private readComfyDirectory(): string | null {
    const stored = this.database.getSetting<string>(COMFY_DIRECTORY_KEY);
    return typeof stored === 'string' && stored.length > 0 ? stored : null;
  }

  private writeExtraModelPathsYaml(comfyDirectory: string, modelsRoot: string): void {
    if (!existsSync(comfyDirectory) || !statSync(comfyDirectory).isDirectory()) {
      throw httpError('PATH_NOT_FOUND', `ComfyUI 安装目录不存在：${comfyDirectory}`);
    }
    const yamlPath = resolve(comfyDirectory, 'extra_model_paths.yaml');
    if (existsSync(yamlPath)) {
      // server 托管该文件；保留一次性备份以便人工找回手工配置。
      copyFileSync(yamlPath, `${yamlPath}.comfy-app-bak`);
    }
    const lines = [
      `# comfy-app server 写入于 ${new Date().toISOString()}；重启 ComfyUI 后生效。`,
      'comfy_app:',
      `  base_path: ${modelsRoot}`,
      '  is_default: false',
      ...YAML_SUBFOLDERS.map((subfolder) => `  ${subfolder}: ${subfolder}`)
    ];
    try {
      writeFileSync(yamlPath, `${lines.join('\n')}\n`, 'utf8');
    } catch (error) {
      throw httpError('PATH_NOT_WRITABLE', `无法写入 ${yamlPath}（${(error as Error).message}）`);
    }
  }
}
