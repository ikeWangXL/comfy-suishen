export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTH_REQUIRED'
  | 'LOGIN_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'WORKFLOW_INVALID'
  | 'WORKFLOW_MODE_UNSUPPORTED'
  | 'DEPENDENCIES_MISSING'
  | 'GALLERY_UNAVAILABLE'
  | 'INVALID_FOLDER_NAME'
  | 'INVALID_GENERATION_PARAMS'
  | 'AI_NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'COMFY_ERROR'
  | 'AI_PROVIDER_ERROR'
  | 'COMFY_UNREACHABLE'
  | 'SERVER_BUSY'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_IN_USE'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_CANCELLABLE'
  | 'AI_TIMEOUT'
  | 'AI_RESPONSE_INVALID'
  | 'PATH_NOT_FOUND'
  | 'PATH_NOT_DIRECTORY'
  | 'PATH_NOT_WRITABLE'
  | 'DISK_SPACE_LOW'
  | 'BACKUP_INVALID'
  | 'BACKUP_VERSION_UNSUPPORTED';

// API §2 全量错误码的默认 HTTP 状态；附加业务码的默认状态为暂定值，
// 由归属阶段按契约用法最终确定，需要偏离时用 HttpError 构造参数显式覆盖。
export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  AUTH_REQUIRED: 401,
  LOGIN_FAILED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  WORKFLOW_INVALID: 422,
  WORKFLOW_MODE_UNSUPPORTED: 422,
  DEPENDENCIES_MISSING: 422,
  GALLERY_UNAVAILABLE: 422,
  INVALID_FOLDER_NAME: 422,
  INVALID_GENERATION_PARAMS: 422,
  AI_NOT_CONFIGURED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  COMFY_ERROR: 502,
  AI_PROVIDER_ERROR: 502,
  COMFY_UNREACHABLE: 503,
  SERVER_BUSY: 503,
  WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_IN_USE: 409,
  JOB_NOT_FOUND: 404,
  JOB_NOT_CANCELLABLE: 409,
  AI_TIMEOUT: 504,
  AI_RESPONSE_INVALID: 502,
  PATH_NOT_FOUND: 404,
  PATH_NOT_DIRECTORY: 400,
  PATH_NOT_WRITABLE: 422,
  DISK_SPACE_LOW: 422,
  BACKUP_INVALID: 422,
  BACKUP_VERSION_UNSUPPORTED: 422
};

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function httpError(code: ErrorCode, message: string, details?: Record<string, unknown>, status?: number): HttpError {
  return new HttpError(status ?? ERROR_STATUS[code], code, message, details);
}

export interface NormalizedError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof HttpError) {
    return error.details === undefined
      ? { status: error.status, code: error.code, message: error.message }
      : { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  // 未分类错误不把内部细节回给客户端（SERVER §12）；由调用方决定是否记日志。
  return { status: 500, code: 'INTERNAL_ERROR', message: '服务内部错误，请稍后重试。' };
}
