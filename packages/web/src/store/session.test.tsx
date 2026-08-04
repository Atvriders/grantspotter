import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  SessionProvider,
  makeSessionValue,
  unevaluatedProfileKinds,
  useSession,
  type SessionValue,
} from './session.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function envelope(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message }, requestId: 'req-test-1' });
}

function stubRoutes(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    const make = routes[url];
    if (make === undefined) return envelope(404, 'not_found', `no stub for ${url}`);
    return make();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const USER = { id: 'u-1', email: 'member@example.com', role: 'member' as const };
const COMPLETENESS = { total: 5, unknownCount: 2, score: 60, fields: [] };

/** Renders every field the shell and the routes read, so a test can assert on text. */
function Probe(): JSX.Element {
  const session = useSession();
  return (
    <dl>
      <dt>user</dt>
      <dd data-testid="user">{session.user?.email ?? '(anonymous)'}</dd>
      <dt>unread</dt>
      <dd data-testid="unread">{session.unread}</dd>
      <dt>loading</dt>
      <dd data-testid="loading">{String(session.loading)}</dd>
      <dt>completenessFor</dt>
      <dd data-testid="completeness-for">{session.completenessFor ?? '(none)'}</dd>
      <dt>unevaluated</dt>
      <dd data-testid="unevaluated">
        {session.unevaluatedProfiles.length === 0 ? '(none)' : session.unevaluatedProfiles.join(',')}
      </dd>
      <dt>score</dt>
      <dd data-testid="score">{session.completeness.score}</dd>
    </dl>
  );
}

function renderSession() {
  return render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionProvider', () => {
  it('exposes the signed-in user and the unread notification count', async () => {
    stubRoutes({
      '/api/me': () =>
        jsonResponse(200, {
          user: USER,
          hasStudentProfile: true,
          hasOrgProfile: false,
          completenessFor: 'student',
          completeness: COMPLETENESS,
        }),
      '/api/notifications?unreadOnly=true': () => jsonResponse(200, { rows: [], unread: 4 }),
    });

    renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });
    expect(screen.getByTestId('user')).toHaveTextContent('member@example.com');
    expect(screen.getByTestId('unread')).toHaveTextContent('4');
    expect(screen.getByTestId('score')).toHaveTextContent('60');
  });

  it('treats a 401 as anonymous and stops loading, without asking for notifications', async () => {
    const fetchMock = stubRoutes({
      '/api/me': () => envelope(401, 'unauthorized', 'Sign in to continue.'),
    });

    renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });
    expect(screen.getByTestId('user')).toHaveTextContent('(anonymous)');
    const urls = fetchMock.mock.calls.map((call) => (call as [string])[0]);
    expect(urls).not.toContain('/api/notifications?unreadOnly=true');
  });

  // --- the dual-profile decision (progress ledger, "For Task 15") ---

  it('names the profile the completeness meter was computed from', async () => {
    stubRoutes({
      '/api/me': () =>
        jsonResponse(200, {
          user: USER,
          hasStudentProfile: false,
          hasOrgProfile: true,
          completenessFor: 'organization',
          completeness: COMPLETENESS,
        }),
      '/api/notifications?unreadOnly=true': () => jsonResponse(200, { rows: [], unread: 0 }),
    });

    renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('completeness-for')).toHaveTextContent('organization');
    });
    expect(screen.getByTestId('unevaluated')).toHaveTextContent('(none)');
  });

  it('tells a user holding BOTH profiles which one the meter did not evaluate', async () => {
    // One score, two profiles. Showing it unlabelled would assert that the
    // organisation profile is 60% complete when it was never looked at.
    stubRoutes({
      '/api/me': () =>
        jsonResponse(200, {
          user: USER,
          hasStudentProfile: true,
          hasOrgProfile: true,
          completenessFor: 'student',
          completeness: COMPLETENESS,
        }),
      '/api/notifications?unreadOnly=true': () => jsonResponse(200, { rows: [], unread: 0 }),
    });

    renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('completeness-for')).toHaveTextContent('student');
    });
    expect(screen.getByTestId('unevaluated')).toHaveTextContent('organization');
  });

  it('counts every held profile as unevaluated when the server names none', async () => {
    // A server that does not say which profile the score speaks for has not
    // told us it speaks for the student one. Guessing here would rebuild the
    // preference order the server documents as having exactly one definition.
    stubRoutes({
      '/api/me': () =>
        jsonResponse(200, {
          user: USER,
          hasStudentProfile: true,
          hasOrgProfile: true,
          completeness: COMPLETENESS,
        }),
      '/api/notifications?unreadOnly=true': () => jsonResponse(200, { rows: [], unread: 0 }),
    });

    renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('completeness-for')).toHaveTextContent('(none)');
    });
    expect(screen.getByTestId('unevaluated')).toHaveTextContent('student,organization');
  });

  it('reports an empty completeness report for a user with no profile at all', async () => {
    stubRoutes({
      '/api/me': () =>
        jsonResponse(200, {
          user: USER,
          hasStudentProfile: false,
          hasOrgProfile: false,
          completenessFor: null,
          completeness: { total: 5, unknownCount: 5, score: 0, fields: [] },
        }),
      '/api/notifications?unreadOnly=true': () => jsonResponse(200, { rows: [], unread: 0 }),
    });

    renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('score')).toHaveTextContent('0');
    });
    expect(screen.getByTestId('unevaluated')).toHaveTextContent('(none)');
  });

  it('survives a notifications outage without losing the session', async () => {
    stubRoutes({
      '/api/me': () =>
        jsonResponse(200, {
          user: USER,
          hasStudentProfile: false,
          hasOrgProfile: false,
          completenessFor: null,
          completeness: COMPLETENESS,
        }),
      '/api/notifications?unreadOnly=true': () => envelope(500, 'internal', 'boom'),
    });

    renderSession();
    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });
    expect(screen.getByTestId('user')).toHaveTextContent('member@example.com');
    expect(screen.getByTestId('unread')).toHaveTextContent('0');
  });
});

describe('SessionProvider.logout', () => {
  it('posts to the logout route and drops the user', async () => {
    let signedIn = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/auth/logout') {
        signedIn = false;
        return new Response(null, { status: 204 });
      }
      if (url === '/api/me') {
        return signedIn
          ? jsonResponse(200, {
              user: USER,
              hasStudentProfile: false,
              hasOrgProfile: false,
              completenessFor: null,
              completeness: COMPLETENESS,
            })
          : envelope(401, 'unauthorized', 'Sign in to continue.');
      }
      return jsonResponse(200, { rows: [], unread: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);

    function LogoutProbe(): JSX.Element {
      const { user, logout } = useSession();
      return (
        <>
          <span data-testid="user">{user?.email ?? '(anonymous)'}</span>
          <button
            type="button"
            onClick={() => {
              void logout();
            }}
          >
            Sign out
          </button>
        </>
      );
    }

    render(
      <SessionProvider>
        <LogoutProbe />
      </SessionProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('member@example.com');
    });

    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('(anonymous)');
    });

    const urls = fetchMock.mock.calls.map((call) => (call as [string])[0]);
    expect(urls).toContain('/api/auth/logout');
  });
});

describe('unevaluatedProfileKinds', () => {
  it('lists every held profile the report does not speak for', () => {
    expect(
      unevaluatedProfileKinds({
        hasStudentProfile: true,
        hasOrgProfile: true,
        completenessFor: 'student',
      }),
    ).toEqual(['organization']);
  });

  it('lists nothing when the only held profile is the evaluated one', () => {
    expect(
      unevaluatedProfileKinds({
        hasStudentProfile: true,
        hasOrgProfile: false,
        completenessFor: 'student',
      }),
    ).toEqual([]);
  });

  it('lists nothing when the user holds no profile', () => {
    expect(
      unevaluatedProfileKinds({
        hasStudentProfile: false,
        hasOrgProfile: false,
        completenessFor: null,
      }),
    ).toEqual([]);
  });
});

describe('makeSessionValue', () => {
  it('defaults to a signed-out, not-loading session', () => {
    const value = makeSessionValue();
    expect(value.user).toBeNull();
    expect(value.loading).toBe(false);
    expect(value.unread).toBe(0);
    expect(value.completeness).toEqual({ total: 0, unknownCount: 0, score: 0, fields: [] });
    expect(value.completenessFor).toBeNull();
    expect(value.unevaluatedProfiles).toEqual([]);
  });

  it('derives unevaluatedProfiles from the fields it is given, so a test cannot state a contradiction', () => {
    const value: SessionValue = makeSessionValue({
      user: USER,
      hasStudentProfile: true,
      hasOrgProfile: true,
      completenessFor: 'student',
    });
    expect(value.unevaluatedProfiles).toEqual(['organization']);
  });

  it('lets a caller state the list explicitly when it is testing the list itself', () => {
    expect(makeSessionValue({ unevaluatedProfiles: ['student'] }).unevaluatedProfiles).toEqual([
      'student',
    ]);
  });
});
