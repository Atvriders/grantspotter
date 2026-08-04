import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, apiGet, apiSend, getHealth, postLogin } from './client.js';

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  // Real fetch() hands back a distinct Response per call; its body can only be
  // read once. Cloning here reproduces that per-call freshness so a test that
  // exercises apiFetch more than once against the same fixture (as the
  // ApiError-decode test below does: once via `.rejects.toThrow`, once via
  // try/catch) doesn't trip "Body is unusable" on the second read.
  const fn = vi.fn(async () => response.clone());
  vi.stubGlobal('fetch', fn);
  return fn;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Plan 1's frozen envelope: { error: { code, message, details? }, requestId }. */
function errorBody(code: string, message: string, details?: unknown) {
  return {
    error: details === undefined ? { code, message } : { code, message, details },
    requestId: 'req-test-1',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Folded in from Plan 1 Task 18's packages/web/test/client.test.ts, which this
// file replaces (RESOLUTIONS R11). These five are Plan 1's assertions, kept
// whole — including the three the task brief's rewrite of this block dropped
// (`details` on a decoded envelope, the exact `message`, and `requestId === ''`
// on the non-envelope fallback) and the `response.clone()` that lets the
// envelope test read the same fixture twice.
// ---------------------------------------------------------------------------
describe('apiFetch (Plan 1)', () => {
  it('returns the parsed body on success and sends cookies', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { ok: true, programs: 0 }));
    await expect(getHealth()).resolves.toEqual({ ok: true, programs: 0 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/health');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('serialises a JSON body with the right content type', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { user: { id: 'u1' } }));
    await postLogin({ email: 'a@example.org', password: 'a-long-enough-password' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@example.org',
      password: 'a-long-enough-password',
    });
  });

  it('turns the server error envelope into an ApiError', async () => {
    stubFetch(
      jsonResponse(429, {
        error: {
          code: 'rate_limited',
          message: 'Too many sign-in attempts. Try again later.',
          details: { retryAfterSec: 900 },
        },
        requestId: 'req-42',
      }),
    );

    await expect(apiFetch('/api/auth/login', { method: 'POST', body: {} })).rejects.toThrow(
      ApiError,
    );

    try {
      await apiFetch('/api/auth/login', { method: 'POST', body: {} });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiError = err as ApiError;
      expect(apiError.code).toBe('rate_limited');
      expect(apiError.status).toBe(429);
      expect(apiError.requestId).toBe('req-42');
      expect(apiError.message).toBe('Too many sign-in attempts. Try again later.');
      expect(apiError.details).toEqual({ retryAfterSec: 900 });
    }
  });

  it('falls back to an internal ApiError when the body is not an envelope', async () => {
    stubFetch(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    try {
      await getHealth();
      expect.unreachable('should have thrown');
    } catch (err) {
      const apiError = err as ApiError;
      expect(apiError).toBeInstanceOf(ApiError);
      expect(apiError.code).toBe('internal');
      expect(apiError.status).toBe(502);
      expect(apiError.requestId).toBe('');
    }
  });

  it('resolves undefined for a 204', async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(apiFetch<void>('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});

// ---- Plan 3's thin wrappers ----
describe('apiGet', () => {
  it('delegates to apiFetch, so the session cookie travels', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { hello: 'world' }));
    await expect(apiGet<{ hello: string }>('/api/me')).resolves.toEqual({ hello: 'world' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/me');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('GET');
  });

  it('passes an AbortSignal through', async () => {
    const fetchMock = stubFetch(jsonResponse(200, {}));
    const controller = new AbortController();
    await apiGet('/api/programs', controller.signal);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('sends no signal at all when none is given', async () => {
    const fetchMock = stubFetch(jsonResponse(200, {}));
    await apiGet('/api/programs');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeUndefined();
  });

  it('throws ApiError carrying the status, the code and the details', async () => {
    stubFetch(
      jsonResponse(
        429,
        errorBody('rate_limited', 'Verified recently.', {
          reason: 'program_cooldown',
          retryAfterSec: 1800,
        }),
      ),
    );
    const err = await apiGet('/api/programs/x/verify').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
    expect((err as ApiError).details).toEqual({ reason: 'program_cooldown', retryAfterSec: 1800 });
  });

  it('keeps a 422 a 422, because zod failures are validation_failed and not 400', async () => {
    stubFetch(jsonResponse(422, errorBody('validation_failed', 'Profile failed validation.', [])));
    const err = await apiGet('/api/profiles').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'validation_failed' });
  });

  it('still throws ApiError when the error body is not JSON at all', async () => {
    stubFetch(new Response('gateway exploded', { status: 500 }));
    const err = await apiGet('/api/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).toBe('internal');
  });
});

describe('apiSend', () => {
  it('serializes the body as JSON', async () => {
    const fetchMock = stubFetch(jsonResponse(201, {}));
    await apiSend('POST', '/api/watches', { programId: 'ardc-grants' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ programId: 'ardc-grants' });
  });

  it('sends no body and no content-type when there is nothing to send', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await apiSend('POST', '/api/notifications/read-all');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it('tolerates a 204 with no body', async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(apiSend('DELETE', '/api/watches/x')).resolves.toBeUndefined();
  });

  it('carries every method the product surface uses', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const fetchMock = stubFetch(new Response(null, { status: 204 }));
      await apiSend(method, '/api/sources/x');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe(method);
    }
  });
});
