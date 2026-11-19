import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess } from '../http/envelope.js';
import { httpError } from '../http/errors.js';
import { readJsonBody } from '../http/middleware.js';
import { AccountStore } from './accountStore.js';

const API_PREFIX = '/api/v1';
const LOGIN_RATE_WINDOW_MS = 60_000;
const LOGIN_RATE_LIMIT = 10;

export interface AuthRoutesDeps {
  accountStore: AccountStore;
  serverId: string;
  serverVersion: string;
  apiVersion: string;
}

// 登录限流：按来源 IP，60s 窗口 10 次（方案 §3.2；实现独立于已退场的配对限流代码）。
const loginAttempts = new Map<string, number[]>();

function consumeLoginAttempt(remoteAddress: string): boolean {
  const now = Date.now();
  const attempts = (loginAttempts.get(remoteAddress) ?? []).filter((timestamp) => now - timestamp < LOGIN_RATE_WINDOW_MS);
  if (attempts.length >= LOGIN_RATE_LIMIT) {
    loginAttempts.set(remoteAddress, attempts);
    return false;
  }
  attempts.push(now);
  loginAttempts.set(remoteAddress, attempts);
  return true;
}

function extractBearerToken(request: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
  return match?.[1] ?? null;
}

function stringField(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  return (body as Record<string, unknown>)[key];
}

export async function handleAuthRoutes(request: IncomingMessage, response: ServerResponse, url: URL, requestId: string, deps: AuthRoutesDeps): Promise<void> {
  const pathname = url.pathname;
  if (request.method === 'POST' && pathname === `${API_PREFIX}/auth/login`) return login(request, response, requestId, deps);
  if (request.method === 'POST' && pathname === `${API_PREFIX}/auth/logout`) return logout(request, response, requestId, deps);
  if (request.method === 'GET' && pathname === `${API_PREFIX}/auth/account`) return getAccount(response, requestId, deps);
  if (request.method === 'PUT' && pathname === `${API_PREFIX}/auth/account`) return putAccount(request, response, requestId, deps);
  throw httpError('NOT_FOUND', '接口不存在。');
}

async function login(request: IncomingMessage, response: ServerResponse, requestId: string, deps: AuthRoutesDeps): Promise<void> {
  const remoteAddress = request.socket.remoteAddress ?? 'unknown';
  if (!consumeLoginAttempt(remoteAddress)) {
    throw httpError('RATE_LIMITED', '登录尝试过于频繁，请稍后再试。');
  }
  const body = await readJsonBody(request);
  const username = stringField(body, 'username');
  const password = stringField(body, 'password');
  if (typeof username !== 'string' || username.length === 0 || typeof password !== 'string' || password.length === 0) {
    throw httpError('INVALID_REQUEST', '请求需提供 username 与 password。');
  }
  if (!(await deps.accountStore.verifyCredentials(username, password))) {
    // 登录失败不区分“用户名不存在”与“密码错误”（API §3）
    throw httpError('LOGIN_FAILED', '用户名或密码错误。');
  }
  const accessToken = deps.accountStore.issueToken();
  sendSuccess(response, {
    accessToken,
    account: { username },
    server: { serverId: deps.serverId, version: deps.serverVersion, apiVersion: deps.apiVersion }
  }, requestId);
}

async function logout(request: IncomingMessage, response: ServerResponse, requestId: string, deps: AuthRoutesDeps): Promise<void> {
  const token = extractBearerToken(request);
  if (token) deps.accountStore.revokeToken(token);
  sendSuccess(response, { loggedOut: true }, requestId);
}

async function getAccount(response: ServerResponse, requestId: string, deps: AuthRoutesDeps): Promise<void> {
  const username = deps.accountStore.getUsername();
  if (username === null) throw httpError('INTERNAL_ERROR', 'owner 账号未初始化。');
  sendSuccess(response, { username }, requestId);
}

async function putAccount(request: IncomingMessage, response: ServerResponse, requestId: string, deps: AuthRoutesDeps): Promise<void> {
  const body = await readJsonBody(request);
  const currentPassword = stringField(body, 'currentPassword');
  const newUsername = stringField(body, 'newUsername');
  const newPassword = stringField(body, 'newPassword');
  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    throw httpError('INVALID_REQUEST', '修改凭据必须提供 currentPassword。');
  }
  if (newUsername === undefined && newPassword === undefined) {
    throw httpError('INVALID_REQUEST', '需提供 newUsername 或 newPassword 至少其一。');
  }
  let nextUsername: string | undefined;
  if (newUsername !== undefined) {
    if (typeof newUsername !== 'string' || newUsername.trim().length === 0) {
      throw httpError('INVALID_REQUEST', 'newUsername 不能为空。');
    }
    nextUsername = newUsername.trim();
  }
  let nextPassword: string | undefined;
  if (newPassword !== undefined) {
    if (typeof newPassword !== 'string' || newPassword.length === 0) {
      throw httpError('INVALID_REQUEST', 'newPassword 不能为空。');
    }
    nextPassword = newPassword;
  }
  if (!(await deps.accountStore.verifyPassword(currentPassword))) {
    throw httpError('LOGIN_FAILED', '当前密码错误。');
  }
  await deps.accountStore.changeCredentials(nextUsername, nextPassword);
  // 修改后撤销全部旧会话并要求重新登录（API §3；不强制用户修改默认凭据）
  deps.accountStore.revokeAllTokens();
  const username = deps.accountStore.getUsername() ?? '';
  sendSuccess(response, { username }, requestId);
}
