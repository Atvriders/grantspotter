import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useApi } from './useApi.js';
import { ApiError } from '../api/client.js';
import { SessionContext, makeSessionValue } from './session.js';
import { Browse } from '../routes/Browse.js';
import { Calendar } from '../routes/Calendar.js';
import { Sources } from '../routes/Sources.js';
import { Admin } from '../routes/Admin.js';

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

  it('reports a non-JSON 200 as an error, and leaves `data` null rather than undefined', async () => {
    stubSequence(() => tunnelHtml());
    const { result } = renderHook(() => useApi('/api/programs'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.status).toBe(200);
    // `undefined` here is what broke the app: it is not `null`, so it passes
    // through `data !== null` and the route renders as if it had a body.
    expect(result.current.data).toBeNull();
  });
});

/** A Cloudflare Tunnel error page: HTML, served with status 200. */
function tunnelHtml(): Response {
  return new Response(
    '<!DOCTYPE html><html><head><title>Error 1033</title></head>' +
      '<body><h1>Argo Tunnel error</h1></body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  );
}

/**
 * The routes, against the same broken tunnel.
 *
 * These live here rather than in each route's own test file on purpose: the
 * defect was one swallowed parse failure in `apiFetch`, and the fix is one throw
 * in `apiFetch`. Restating it eight times, once per route, would be the same
 * eight-edit mistake in test form and would imply each route carries its own
 * guard, which it does not. What the four cases below establish is the shared
 * claim: whatever `useApi` fetches, a 200 that is not JSON reaches the route as
 * `error` and not as `data`, and the route it reaches is already written to
 * render that. Browse, Calendar and Sources go through `useApi` exactly as
 * Watchlist, Inbox, Profile and Admin do — Admin is included because its user
 * table is the route whose bare `.rows.map` this change also fixed.
 */
describe('a route whose API answers 200 with HTML', () => {
  function renderRoute(ui: JSX.Element) {
    return render(
      <MemoryRouter>
        <SessionContext.Provider
          value={makeSessionValue({
            user: { id: 'u-admin', email: 'admin@example.com', role: 'admin' },
          })}
        >
          {ui}
        </SessionContext.Provider>
      </MemoryRouter>,
    );
  }

  it('Browse says so, and does not claim nothing matched', async () => {
    stubSequence(() => tunnelHtml());
    renderRoute(<Browse now="2026-08-02T12:00:00.000Z" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not load opportunities/i);
    // The empty state would be a false claim about the corpus.
    expect(screen.queryByText(/no opportunities match these filters/i)).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    // Not a blank page: the route itself still rendered.
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe('');
  });

  it('Calendar says so, and does not show an empty calendar', async () => {
    stubSequence(() => tunnelHtml());
    renderRoute(<Calendar now="2026-08-02T12:00:00.000Z" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/calendar could not be loaded/i);
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe('');
  });

  it('Sources says so, and does not show a healthy-looking table', async () => {
    stubSequence(() => tunnelHtml());
    renderRoute(<Sources />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/source health could not be loaded/i);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('Admin says so, and does not show an empty account list', async () => {
    stubSequence(() => tunnelHtml());
    renderRoute(<Admin />);

    await waitFor(() => {
      expect(
        screen.getAllByRole('alert').some((el) => /could not load accounts/i.test(el.textContent ?? '')),
      ).toBe(true);
    });
    expect(screen.queryByRole('table', { name: /user accounts/i })).toBeNull();
  });
});
