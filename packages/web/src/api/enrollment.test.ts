import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from './client.js';
import {
  createEnrollmentCode,
  getEnrollmentOpen,
  postEnroll,
  revokeEnrollmentCode,
  ENROLLMENT_CODES_PATH,
} from './enrollment.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('asking whether enrolment is open', () => {
  it('reads the boolean the server sent', async () => {
    const fetchMock = stub({ open: true });
    await expect(getEnrollmentOpen()).resolves.toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/enrollment-open');
  });

  it('reads a definite no as a definite no', async () => {
    stub({ open: false });
    await expect(getEnrollmentOpen()).resolves.toBe(false);
  });

  /**
   * `null` is not `false`. A server that answered without saying — an older build behind a proxy
   * that turns a 404 into a 200, a tunnel's own page — has told us nothing, and the caller treats
   * "no" and "did not say" differently on purpose.
   */
  it('does not read silence as a no', async () => {
    stub({});
    await expect(getEnrollmentOpen()).resolves.toBeNull();
  });

  it('does not read a non-boolean as a no either', async () => {
    stub({ open: 'yes' });
    await expect(getEnrollmentOpen()).resolves.toBeNull();
  });

  it('survives a JSON null body rather than throwing on a property of it', async () => {
    stub(null);
    await expect(getEnrollmentOpen()).resolves.toBeNull();
  });

  it('raises the API envelope as an ApiError, so a caller can tell no from could-not-ask', async () => {
    stub({ error: { code: 'internal', message: 'nope' }, requestId: 'r' }, { ok: false, status: 500 });
    await expect(getEnrollmentOpen()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('the admin side of the codes', () => {
  it('creates a code with explicit nulls rather than omitted keys', async () => {
    const fetchMock = stub({ code: {}, plaintext: 'ENR-1' });
    await createEnrollmentCode({ label: 'Autumn intake', maxUses: null, expiresInDays: 30 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENROLLMENT_CODES_PATH);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      label: 'Autumn intake',
      maxUses: null,
      expiresInDays: 30,
    });
  });

  it('escapes the id it is given rather than pasting it into a path', async () => {
    const fetchMock = stub({ code: {} });
    await revokeEnrollmentCode('code/../../etc');

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/enrollment-codes/code%2F..%2F..%2Fetc/revoke');
  });
});

describe('redeeming a code', () => {
  it('posts to the enrol route and sends nothing it was not given', async () => {
    const fetchMock = stub({ user: { id: 'u-9', email: 'student@example.edu', role: 'member' } });
    await postEnroll({ code: 'JOIN-1', email: 'student@example.edu', password: 'a-long-password' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/enroll');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      code: 'JOIN-1',
      email: 'student@example.edu',
      password: 'a-long-password',
    });
  });

  it('carries the server’s refusal through as an ApiError with its details intact', async () => {
    stub(
      {
        error: {
          code: 'forbidden',
          message: 'This enrollment code has been revoked.',
          details: { reason: 'revoked' },
        },
        requestId: 'req-1',
      },
      { ok: false, status: 403 },
    );

    // The reason is what tells the enrolment screen which of four sentences to say, so it has to
    // survive the trip through `apiFetch` rather than being flattened into the message.
    await expect(
      postEnroll({ code: 'x', email: 'a@b.edu', password: 'a-long-password' }),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'revoked' } });
  });
});
