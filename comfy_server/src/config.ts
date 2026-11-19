import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface AiConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKeyProtected: string | null;
  headersProtected: string | null;
  headerNames: string[];
  reasoningEffort: string;
  maxTokens: number | null;
}

export interface ServerConfig {
  host: string;
  port: number;
  apiPort: number;
  comfyBaseUrl: string;
  galleryRoot: string;
  autoStart: boolean;
  ai: AiConfig;
}

export function getDataDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData
    ? path.join(localAppData, 'ComfyAppServer')
    : path.join(os.homedir(), '.comfy-app-server');
}

export function getConfigPath(): string {
  return path.join(getDataDirectory(), 'config.json');
}

export function getDatabasePath(): string {
  return path.join(getDataDirectory(), 'library.sqlite');
}

export function defaultConfig(): ServerConfig {
  return {
    host: '0.0.0.0',
    port: 8787,
    apiPort: 8788,
    comfyBaseUrl: 'http://127.0.0.1:8188',
    // 新装默认未配置图库（SERVER §10.1）；V1 升级保留既有值。
    galleryRoot: '',
    autoStart: false,
    ai: {
      enabled: false,
      endpoint: '',
      model: '',
      apiKeyProtected: null,
      headersProtected: null,
      headerNames: [],
      reasoningEffort: '',
      maxTokens: null
    }
  };
}

const LEGACY_TLS_KEYS = ['tlsPassphraseProtected', 'tlsPublicKeyPin', 'tlsAddresses'] as const;

export async function loadConfig(): Promise<ServerConfig> {
  await mkdir(getDataDirectory(), { recursive: true });
  const configPath = getConfigPath();
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    // 一次性迁移：剥离 V1 TLS 字段并回写（TLS/配对链路退场，方案 §2/§3.4-T4 删除性变更）。
    const migrated = LEGACY_TLS_KEYS.some((key) => key in raw);
    for (const key of LEGACY_TLS_KEYS) delete raw[key];
    const parsed = raw as Partial<ServerConfig>;
    const base = defaultConfig();
    const config: ServerConfig = { ...base, ...parsed, ai: { ...base.ai, ...parsed.ai } };
    if (migrated) await saveConfig(config);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`无法读取本地服务配置：${(error as Error).message}`);
    }
    const config = defaultConfig();
    await saveConfig(config);
    return config;
  }
}

export async function saveConfig(config: ServerConfig): Promise<void> {
  await mkdir(getDataDirectory(), { recursive: true });
  const configPath = getConfigPath();
  const tempPath = `${configPath}.tmp`;
  await writeFile(tempPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, configPath);
}
