import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, getHealth, postLogin } from '../src/api/client.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
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
