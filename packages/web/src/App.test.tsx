import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function me(role: 'admin' | 'member'): Response {
  return jsonResponse(200, {
    user: { id: 'u-1', email: `${role}@example.com`, role },
    hasStudentProfile: false,
    hasOrgProfile: false,
    completenessFor: null,
    completeness: { total: 0, unknownCount: 0, score: 0, fields: [] },
  });
}

function stubSignedIn(role: 'admin' | 'member'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/me' ? me(role) : jsonResponse(200, { rows: [], unread: 0 }),
    ),
  );
}

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('App', () => {
  it('says it is loading rather than flashing the sign-in form at a signed-in user', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    renderAt('/');
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('shows the sign-in form when nobody is signed in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(401, {
          error: { code: 'unauthorized', message: 'Sign in to continue.' },
          requestId: 'req-test-1',
        }),
      ),
    );
    renderAt('/');
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /primary/i })).not.toBeInTheDocument();
  });

  it('renders Browse inside the shell for a signed-in member', async () => {
    stubSignedIn('member');
    renderAt('/');
    expect(await screen.findByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Browse' })).toBeInTheDocument();
  });

  it('routes a program id to the opportunity screen', async () => {
    stubSignedIn('member');
    renderAt('/o/ardc-grants');
    expect(await screen.findByRole('heading', { name: 'Opportunity' })).toBeInTheDocument();
  });

  it('sends a member who reaches /admin back to Browse instead of rendering a screen they cannot use', async () => {
    stubSignedIn('member');
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Browse' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('lets an admin reach /admin', async () => {
    stubSignedIn('admin');
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Admin' })).toBeInTheDocument();
  });

  it('answers an unknown path with a real not-found screen, not an empty shell', async () => {
    stubSignedIn('member');
    renderAt('/no-such-page');
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
  });

  it('registers every Plan 3 route name from CONTRACT §2', async () => {
    for (const [path, heading] of [
      ['/calendar', 'Calendar'],
      ['/watchlist', 'Watchlist'],
      ['/inbox', 'Inbox'],
      ['/sources', 'Sources'],
      ['/profile', 'Profile'],
    ] as const) {
      stubSignedIn('member');
      const view = renderAt(path);
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      });
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
});
