import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useApi } from './useApi.js';
import { ApiError } from '../api/client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch stub that answers every call with the next scripted response. */
function stubSequence(...responses: Array<() => Response>): ReturnType<typeof vi.fn> {
  let call = 0;
  const fn = vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (next === undefined) throw new Error('fetch stub ran out of responses');
    return next();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useApi', () => {
  it('starts loading, then resolves the parsed body', async () => {
    stubSequence(() => jsonResponse(200, { rows: [1, 2] }));
    const { result } = renderHook(() => useApi<{ rows: number[] }>('/api/programs'));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toEqual({ rows: [1, 2] });
    expect(result.current.error).toBeNull();
  });

  it('surfaces the API envelope as an ApiError, code and status intact', async () => {
    stubSequence(() =>
      jsonResponse(403, {
        error: { code: 'forbidden', message: 'Admins only.' },
        requestId: 'req-test-1',
      }),
    );
    const { result } = renderHook(() => useApi('/api/notifications/health'));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error).toMatchObject({ code: 'forbidden', status: 403 });
    expect(result.current.loading).toBe(false);
  });

  it('says the request never reached the server rather than inventing a status', async () => {
    // A transport failure is not an envelope. Reporting it as some HTTP status
    // would tell the caller the server answered when nothing did.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const { result } = renderHook(() => useApi('/api/programs'));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.code).toBe('internal');
    expect(result.current.error?.status).toBe(0);
    expect(result.current.error?.message).toMatch(/could not be reached/i);
  });

  it('issues no request at all for a null path, and is not left loading', async () => {
    const fetchMock = stubSequence(() => jsonResponse(200, {}));
    const { result } = renderHook(() => useApi(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });

  it('refetches when reload() is called', async () => {
    const fetchMock = stubSequence(
      () => jsonResponse(200, { n: 1 }),
      () => jsonResponse(200, { n: 2 }),
    );
    const { result } = renderHook(() => useApi<{ n: number }>('/api/programs'));
    await waitFor(() => {
      expect(result.current.data).toEqual({ n: 1 });
    });

    act(() => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(result.current.data).toEqual({ n: 2 });
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches when the path changes', async () => {
    const fetchMock = stubSequence(() => jsonResponse(200, {}));
    const { rerender } = renderHook(({ path }: { path: string }) => useApi(path), {
      initialProps: { path: '/api/programs?page=1' },
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    rerender({ path: '/api/programs?page=2' });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe('/api/programs?page=2');
  });

  it('refetches when a declared dependency changes, and not otherwise', async () => {
    const fetchMock = stubSequence(() => jsonResponse(200, {}));
    const { rerender } = renderHook(({ dep }: { dep: number }) => useApi('/api/calendar', [dep]), {
      initialProps: { dep: 1 },
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    rerender({ dep: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ dep: 2 });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('aborts the in-flight request when the path changes, so a slow first answer cannot overwrite the second', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.signal !== undefined && init.signal !== null) signals.push(init.signal);
        return jsonResponse(200, {});
      }),
    );

    const { rerender } = renderHook(({ path }: { path: string }) => useApi(path), {
      initialProps: { path: '/api/programs?page=1' },
    });
    await waitFor(() => {
      expect(signals.length).toBe(1);
    });
    rerender({ path: '/api/programs?page=2' });
    await waitFor(() => {
      expect(signals.length).toBe(2);
    });

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});
