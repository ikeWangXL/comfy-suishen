import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

export interface ErrorPayload {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export function sendSuccess(response: ServerResponse, data: unknown, requestId: string): void {
  sendJson(response, 200, { data, requestId });
}

export function sendError(response: ServerResponse, error: ErrorPayload, requestId: string): void {
  const errorBody = error.details === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, details: error.details };
  sendJson(response, error.status, { error: errorBody, requestId });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}
