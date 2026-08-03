import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

export type ApiErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'internal';

export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  validation_failed: 422,
  rate_limited: 429,
  internal: 500,
};

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
  requestId: string;
}

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdMiddleware(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.header('x-request-id');
    const requestId = inbound !== undefined && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  };
}

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => {
    next(new AppError('not_found', 'Not found.'));
  };
}

export interface ErrorHandlerOptions {
  logger?: (line: string) => void;
}

export function errorHandler(options: ErrorHandlerOptions = {}): ErrorRequestHandler {
  const log = options.logger ?? ((line: string) => console.error(line));

  return (err, _req, res, _next) => {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : randomUUID();

    let appError: AppError;
    if (err instanceof AppError) {
      appError = err;
    } else if (err instanceof ZodError) {
      appError = new AppError('validation_failed', 'The request body is invalid.', err.issues);
    } else if (
      err instanceof SyntaxError &&
      (err as SyntaxError & { type?: string }).type === 'entity.parse.failed'
    ) {
      appError = new AppError('bad_request', 'The request body is not valid JSON.');
    } else if ((err as { type?: string }).type === 'entity.too.large') {
      appError = new AppError('payload_too_large', 'The request body is too large.');
    } else {
      log(
        `[error] requestId=${requestId} ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}`,
      );
      appError = new AppError('internal', 'Something went wrong.');
    }

    const body: ApiErrorBody = {
      error: { code: appError.code, message: appError.message },
      requestId,
    };
    if (appError.details !== undefined) body.error.details = appError.details;

    res.status(appError.status).json(body);
  };
}
