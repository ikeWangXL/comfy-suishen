import type { AiConfig } from "./config.js";
import { unprotectSecret } from "./secretStore.js";
import { isIP } from "node:net";

export type ExpandedPrompt = { expandedPrompt: string; providerName: string; model: string };

/** 内置兜底 system prompt（回退链末档：档案偏好 → 档案内 ai扩写提示词参数 → 此默认）。 */
export const BUILTIN_AI_SYSTEM_PROMPT =
  "你负责扩写图片生成提示词。保留用户的核心意图、主体和明确指定的细节，增加有用的视觉描述，不要擅自改变主题。只输出扩写后的提示词，不要解释，也不要加引号。";

/** 默认请求超时（SERVER §8：扩写失败保留原提示词，App 可重试/编辑/切换为不扩写）。 */
export const AI_REQUEST_TIMEOUT_MS = 90_000;

export interface ExpandOptions {
  timeoutMs?: number;
}

export async function expandPrompt(
  config: AiConfig,
  prompt: string,
  workflowSystemPrompt?: string,
  options: ExpandOptions = {}
): Promise<ExpandedPrompt> {
  if (!config.enabled || !config.endpoint.trim() || !config.model.trim() || !config.apiKeyProtected) {
    throw new Error("AI_NOT_CONFIGURED");
  }
  const systemPrompt = workflowSystemPrompt === undefined ? BUILTIN_AI_SYSTEM_PROMPT : workflowSystemPrompt;
  const endpoint = providerUrl(config.endpoint, 'chat/completions');
  let apiKey: string;
  try {
    apiKey = await unprotectSecret(config.apiKeyProtected);
  } catch {
    // DPAPI 无法解密（换用户环境恢复等）：等同未配置密钥（SERVER §11）。
    throw new Error("AI_NOT_CONFIGURED");
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS),
      headers: {
        ...await savedHeaders(config),
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        ...(config.maxTokens === null ? {} : { max_completion_tokens: config.maxTokens }),
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          { role: "user", content: prompt },
        ],
      }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new Error("AI_TIMEOUT");
    throw new Error("AI_PROVIDER_ERROR");
  }
  if (!response.ok) throw new Error("AI_PROVIDER_ERROR");
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("AI_RESPONSE_INVALID"); }
  const choice = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
  const content = choice?.message?.content;
  const expandedPrompt = typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("").trim()
      : "";
  if (!expandedPrompt) throw new Error("AI_RESPONSE_INVALID");
  let providerName = "OpenAI-compatible";
  try { providerName = new URL(endpoint).host; } catch { /* endpoint is validated by normalizeEndpoint */ }
  return { expandedPrompt, providerName, model: config.model };
}

/**
 * endpoint 校验（PUT /ai/settings 与 expand 共用规则）：
 * 仅接受 https，或本机回环 http（密钥不得经明文链路出网）；拒绝 URL 账号信息。
 * 返回规范化 base 地址（不带 /chat/completions 后缀）；不合法抛 Error("AI_NOT_CONFIGURED")，由调用方转 HTTP 错误。
 */
export function validateAiEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new Error("AI_NOT_CONFIGURED");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const localHost = host === "localhost" || host.endsWith(".localhost") || host === "::1" ||
    (isIP(host) === 4 && Number(host.split(".")[0]) === 127);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    throw new Error("AI_NOT_CONFIGURED");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("AI_NOT_CONFIGURED");
  return url.toString();
}

export function aiBaseUrl(raw: string): string {
  const url = new URL(validateAiEndpoint(raw));
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') || '/v1';
  return url.toString();
}

function providerUrl(raw: string, resource: string): string {
  return `${aiBaseUrl(raw)}/${resource}`;
}

export async function savedHeaders(config: AiConfig): Promise<Record<string, string>> {
  return config.headersProtected ? JSON.parse(await unprotectSecret(config.headersProtected)) as Record<string, string> : {};
}

export class AiModelListError extends Error {}

export async function listAiModels(endpoint: string, apiKey: string, headers: Record<string, string>): Promise<string[]> {
  const response = await fetch(providerUrl(endpoint, 'models'), {
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
    headers: { ...headers, authorization: `Bearer ${apiKey}`, accept: 'application/json' }
  });
  if (!response.ok) {
    const status = response.status;
    const hint = status === 401 || status === 403 ? '请检查 API Key、权限和自定义请求头。' :
      status === 404 ? '请检查 Base URL，确认供应商支持 /models 接口。' :
        status === 429 ? '供应商限制了请求频率，请稍后再试。' : '请稍后重试或检查供应商服务。';
    throw new AiModelListError(`供应商模型列表请求失败（HTTP ${status}）。${hint}`);
  }
  let payload: { data?: Array<{ id?: unknown }> } | null;
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw new AiModelListError('供应商返回的模型列表不是有效的 JSON。请检查 Base URL。');
  }
  if (!Array.isArray(payload?.data)) {
    throw new AiModelListError('供应商返回的模型列表格式无效。请确认 /models 接口兼容 OpenAI 格式。');
  }
  return [...new Set(payload.data.map(item => item?.id).filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
}
