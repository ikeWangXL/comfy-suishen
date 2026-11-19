import type { IncomingMessage, ServerResponse } from 'node:http';
import { httpError } from './errors.js';

const SESSION_COOKIE = 'comfy_web_session';

export function isWebRequest(request: IncomingMessage): boolean {
  return request.headers['x-comfy-web'] === '1';
}

function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  const origin = request.headers.origin;
  return !!host && (origin === `http://${host}` || origin === `https://${host}`);
}

export function readWebSession(request: IncomingMessage): string | undefined {
  const upgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
  if (upgrade || request.method !== 'GET' && request.method !== 'HEAD') {
    if (!sameOrigin(request)) return undefined;
  }
  if (!upgrade && !isWebRequest(request)) return undefined;
  return /(?:^|;\s*)comfy_web_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
}

export function requireWebOrigin(request: IncomingMessage): void {
  if (!sameOrigin(request)) throw httpError('FORBIDDEN', '请从电脑服务地址打开网页。');
}

export function setWebSession(request: IncomingMessage, response: ServerResponse, token: string): void {
  const secure = request.headers.origin?.startsWith('https://') ? '; Secure' : '';
  const expiry = token ? '' : '; Max-Age=0';
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/api/v1; HttpOnly; SameSite=Strict${secure}${expiry}`);
}
