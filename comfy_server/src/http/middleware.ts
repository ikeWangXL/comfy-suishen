import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { httpError } from './errors.js';
import { readWebSession } from './webSession.js';

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 20 * 1024 * 1024;

export function readJsonBody(request: IncomingMessage, limitBytes: number = DEFAULT_JSON_BODY_LIMIT_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limitBytes) {
        settled = true;
        reject(httpError('PAYLOAD_TOO_LARGE', '请求体超过服务器限制。'));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      if (total === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError('INVALID_REQUEST', '请求体不是合法 JSON。'));
      }
    });
    request.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export interface BearerAuthOptions {
  exemptPaths?: readonly string[];
  verifyToken?: (token: string) => Promise<boolean>;
  allowWebSession?: boolean;
}

// S2 接线：鉴权豁免面仅 GET /health、POST /auth/login、gallery thumbnail/file（裁决 Q3）；
// S1 阶段未传 verifyToken 时一律拒绝，即契约下“无有效令牌”的默认形态。
export async function authenticateBearer(request: IncomingMessage, pathname: string, options: BearerAuthOptions = {}): Promise<void> {
  if (options.exemptPaths?.includes(pathname)) return;
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
  const token = match?.[1] ?? (options.allowWebSession ? readWebSession(request) : undefined);
  if (!token) throw httpError('AUTH_REQUIRED', '缺少访问令牌，请先登录。');
  const valid = options.verifyToken ? await options.verifyToken(token) : false;
  if (!valid) throw httpError('AUTH_REQUIRED', '访问令牌无效或已撤销，请重新登录。');
}

export function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = normalizeRemoteAddress(request.socket.remoteAddress ?? '');
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

// API 层局域网准入（保留资产，方案 §3.3）：仅私网 IPv4、回环与链路本地地址放行。
export function isPrivateLanAddress(rawAddress: string): boolean {
  const address = normalizeRemoteAddress(rawAddress);
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number);
    return first === 10 || first === 127 || first === 169 && second === 254 ||
      first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
  }
  if (isIP(address) !== 6) return false;
  return address === '::1' || address.startsWith('fc') || address.startsWith('fd') ||
    /^fe[89ab]/.test(address);
}

function normalizeRemoteAddress(rawAddress: string): string {
  return rawAddress.replace(/^::ffff:/i, '').split('%')[0].toLowerCase();
}
