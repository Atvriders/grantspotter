/**
 * Source of truth for these codes is packages/server/src/api/errors.ts.
 * They are restated here because import direction is one-way: web may import
 * from core, never from server.
 */
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

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
  requestId: string;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly requestId: string;
  readonly details?: unknown;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    requestId: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    if (details !== undefined) this.details = details;
  }
}

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = (value as { error?: unknown }).error;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { code?: unknown }).code === 'string' &&
    typeof (candidate as { message?: unknown }).message === 'string'
  );
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'include',
  };
  if (options.signal !== undefined) init.signal = options.signal;
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(path, init);
  if (response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    if (isErrorBody(payload)) {
      throw new ApiError(
        payload.error.code,
        payload.error.message,
        response.status,
        payload.requestId ?? '',
        payload.error.details,
      );
    }
    throw new ApiError('internal', `Request failed with status ${response.status}.`, response.status, '');
  }

  return payload as T;
}

// ---- typed endpoint wrappers ----

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  migrations: number;
  programs: number;
  now: string;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  createdAt: string;
  lastLoginAt?: string;
}

export async function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/api/health');
}

export async function getBootstrapStatus(): Promise<{ required: boolean }> {
  return apiFetch<{ required: boolean }>('/api/auth/bootstrap-status');
}

export async function postBootstrap(body: {
  token: string;
  email: string;
  password: string;
  displayName?: string;
}): Promise<{ user: PublicUser }> {
  return apiFetch<{ user: PublicUser }>('/api/auth/bootstrap', { method: 'POST', body });
}

export async function postLogin(body: {
  email: string;
  password: string;
}): Promise<{ user: PublicUser }> {
  return apiFetch<{ user: PublicUser }>('/api/auth/login', { method: 'POST', body });
}

export async function postLogout(): Promise<void> {
  return apiFetch<void>('/api/auth/logout', { method: 'POST' });
}

export async function getMe(): Promise<{ user: PublicUser }> {
  return apiFetch<{ user: PublicUser }>('/api/auth/me');
}

// ---- Plan 3 conveniences ----
//
// These are wrappers, not a second client. Every envelope-parsing rule lives in
// apiFetch above: it throws
//   new ApiError(body.error.code, body.error.message, response.status,
//                body.requestId ?? '', body.error.details)
// for a well-formed error body and ApiError('internal', …) for anything else,
// which is exactly what RESOLUTIONS R6 requires. Re-deriving that here — reading
// `body?.error` as if it were a string — would assign the whole
// { code, message } object to ApiError.code.

/** GET `path`, optionally abortable. Resolves the parsed body. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(path, signal === undefined ? {} : { signal });
}

/** POST / PUT / PATCH / DELETE `path` with an optional JSON body. */
export async function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return apiFetch<T>(path, body === undefined ? { method } : { method, body });
}
