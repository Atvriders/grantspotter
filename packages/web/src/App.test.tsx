import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';

/**
 * WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT.
 *
 * These tests prove three things and nothing else: that every CONTRACT §2 path reaches its own
 * screen, that a signed-in user gets that screen inside the shell, and that `/admin` turns a
 * member away. Each route already has its own test file which owns what that route RENDERS —
 * asserting a second time here would mean two places to edit for one product decision, and the
 * copy is not this file's to keep.
 *
 * The stubs below are therefore the EMPTIEST WELL-FORMED response each endpoint can return, and
 * their shapes are lifted from the route's own test file rather than invented. That distinction
 * matters: this file previously answered every request with `{ rows: [], unread: 0 }`, which was
 * harmless only for as long as the routes were placeholders that made no requests. The moment the
 * real components were wired in, four routes read a field that shape does not have and threw —
 * so an unfaithful stub does not fail a little, it takes the screen down.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const COMPLETENESS = { total: 0, unknownCount: 0, score: 0, fields: [] };

function me(role: 'admin' | 'member'): Response {
  return jsonResponse(200, {
    user: { id: 'u-1', email: `${role}@example.com`, role },
    hasStudentProfile: false,
    hasOrgProfile: false,
    completenessFor: null,
    completeness: COMPLETENESS,
  });
}

/**
 * `BrowseResponse` (Browse.tsx). `profileApplied: null` agrees with the `/api/me` above, which
 * says this user holds no profile — a summary with a profile applied and no profile on file is
 * a contradiction a stub is free to write and the server is not.
 */
const BROWSE = {
  rows: [],
  summary: {
    total: 0,
    eligible: 0,
    preferred: 0,
    ineligible: 0,
    unknown: 0,
    ineligibleByAxis: [],
    unknownByField: [],
  },
  page: 1,
  pageSize: 25,
  total: 0,
  profileApplied: null,
};

/** `OpportunityDetail`. The `Program` is the shape `Inbox.test.tsx` builds against core's type. */
function opportunityDetail(programId: string): unknown {
  return {
    program: {
      id: programId,
      funderId: 'ardc',
      name: 'ARDC Grants Program',
      klass: 'ham_grant',
      summary: 'Grants for amateur radio and digital communication science.',
      applicantEntities: ['university'],
      amount: { instrument: 'cash_range', amountRaw: '$10,000 - $500,000', awardCountRaw: '30+' },
      deadline: {
        kind: 'annual_window',
        source: { kind: 'self' },
        note: 'Two cycles a year.',
      },
      applyVia: 'page_form',
      applyUrl: 'https://www.ardc.net/apply/',
      constraints: [],
      fundingRestrictions: [],
      obligations: {},
      aiPolicy: { stance: 'unaddressed' },
      trust: {
        status: 'open',
        sourceUrl: 'https://www.ardc.net/apply/',
        lastVerifiedAt: '2026-08-01T00:00:00.000Z',
        verificationMethod: 'live_fetch',
        contentHash: 'c0ffee',
      },
      rawOtherText: '',
      tags: [],
    },
    funder: {
      id: 'ardc',
      name: 'Amateur Radio Digital Communications',
      homepage: 'https://www.ardc.net/',
    },
    cycles: [],
    provenance: [],
    verdict: null,
    watched: false,
    deadlineOwner: null,
  };
}

/** `ChannelsResponse` (Watchlist.tsx) — in-app only, nothing configured, nothing failing. */
const CHANNELS = {
  inApp: true,
  webhookUrl: null,
  ntfyServer: null,
  ntfyTopic: null,
  health: [],
};

/** `FanoutHealth` — admin-only, so only ever requested by an admin's Watchlist. */
const FANOUT_HEALTH = {
  pendingEvents: 0,
  fannedOutEvents: 0,
  zeroRecipientEvents: 0,
  suppressed: [],
  lastFanoutAt: null,
  notifications: { total: 0, unread: 0 },
};

/** Paths a route asked for that this file has no stub for. Asserted empty after every test. */
let unstubbed: string[] = [];

/**
 * The empty-but-well-formed body for one request.
 *
 * Order matters twice over: `/api/notifications/health` must be answered before
 * `/api/notifications`, and `/api/programs/:id` before `/api/programs`, or the more general
 * pattern swallows the more specific one and a route silently gets the wrong screen's payload.
 */
function payloadFor(rawUrl: string): unknown {
  const url = new URL(rawUrl, 'http://localhost');
  const path = url.pathname;

  if (path === '/api/calendar') {
    // The server ECHOES the window it was asked about, and Calendar compares the month on screen
    // against `from`/`to` to decide whether that month was covered by the request. A stub with a
    // window of its own would make some months read as "never asked about" for no reason.
    return {
      from: url.searchParams.get('from') ?? new Date(0).toISOString(),
      to: url.searchParams.get('to') ?? new Date(0).toISOString(),
      entries: [],
      undated: [],
    };
  }
  if (path.startsWith('/api/programs/')) {
    return opportunityDetail(path.slice('/api/programs/'.length));
  }
  if (path === '/api/programs') return BROWSE;
  if (path === '/api/notifications/health') return FANOUT_HEALTH;
  if (path === '/api/notifications') return { rows: [], unread: 0 };
  if (path === '/api/watches') return { rows: [] };
  if (path === '/api/channels') return CHANNELS;
  if (path === '/api/inbox') return { rows: [], canDecide: false };
  if (path === '/api/profiles') {
    return { student: null, organization: null, completenessFor: null, completeness: COMPLETENESS };
  }
  if (path === '/api/sources/health') {
    return { rows: [], summary: { total: 0, healthy: 0, unhealthy: 0 }, canConfigure: false };
  }
  if (path === '/api/admin/users') return { rows: [] };

  // Recorded rather than thrown. A rejected fetch is indistinguishable from an outage to
  // `useApi`, so the route would render its perfectly correct "could not be reached" state and
  // this file would go on passing while a screen it claims to have proved was never drawn.
  unstubbed.push(path);
  return {};
}

/** Every response the stub has handed out and not yet been waited on. See `settle`. */
let inFlight: Promise<Response>[] = [];

function stubSignedIn(role: 'admin' | 'member'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const response = Promise.resolve(
        new URL(url, 'http://localhost').pathname === '/api/me'
          ? me(role)
          : jsonResponse(200, payloadFor(url)),
      );
      inFlight.push(response);
      return response;
    }),
  );
}

/**
 * Let every stubbed response land, and everything those responses go on to request.
 *
 * Without this, a `waitFor` on a heading can be satisfied while the screen is still empty —
 * every one of these routes draws its `<h1>` before its data arrives — and the test then
 * unmounts, which ABORTS the request before the component ever renders the payload. That is
 * how a route could throw on a perfectly well-formed response and this file still go green:
 * it would never have reached the render that throws. Re-asserting the heading after `settle`
 * is the cheap, route-agnostic way to say "and it was still on screen once the data was in",
 * because a component that throws takes the whole tree, heading included, down with it.
 */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 5 && inFlight.length > 0; pass += 1) {
    const batch = inFlight;
    inFlight = [];
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.all(batch);
    });
  }
}

function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
  inFlight = [];
  const missing = unstubbed;
  unstubbed = [];
  expect(missing, 'a route fetched an endpoint App.test.tsx has no stub for').toEqual([]);
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
    expect(
      await screen.findByRole('heading', { name: 'Browse opportunities' }),
    ).toBeInTheDocument();

    await settle();
    expect(screen.getByRole('heading', { name: 'Browse opportunities' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
  });

  it('routes a program id to the opportunity screen', async () => {
    stubSignedIn('member');
    renderAt('/o/ardc-grants');

    // The heading is the PROGRAM's name, so finding it is already evidence the id in the path
    // reached the route — but only if the id also reached the request, which is the half of
    // `:programId` that a hardcoded stub would hide.
    expect(await screen.findByRole('heading', { name: 'ARDC Grants Program' })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.map((call) => String(call[0]))).toContain(
      '/api/programs/ardc-grants',
    );
  });

  it('sends a member who reaches /admin back to Browse instead of rendering a screen they cannot use', async () => {
    stubSignedIn('member');
    renderAt('/admin');
    expect(
      await screen.findByRole('heading', { name: 'Browse opportunities' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();

    // And still not, once every request the redirect kicked off has answered.
    await settle();
    expect(screen.queryByRole('heading', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('lets an admin reach /admin', async () => {
    stubSignedIn('admin');
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Admin' })).toBeInTheDocument();

    await settle();
    expect(screen.getByRole('heading', { name: 'Admin' })).toBeInTheDocument();
  });

  it('answers an unknown path with a real not-found screen, not an empty shell', async () => {
    stubSignedIn('member');
    renderAt('/no-such-page');
    expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
  });

  it('registers every Plan 3 route name from CONTRACT §2', async () => {
    // The heading each screen actually carries, which is not always the rail's word for it:
    // `/sources` is "Source health". Matching the rail's label instead would pass against a
    // placeholder and fail against the real screen, which is exactly what happened here.
    for (const [path, heading] of [
      ['/calendar', 'Calendar'],
      ['/watchlist', 'Watchlist'],
      ['/inbox', 'Inbox'],
      ['/sources', 'Source health'],
      ['/profile', 'Profile'],
    ] as const) {
      stubSignedIn('member');
      const view = renderAt(path);
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      });
      // eslint-disable-next-line no-await-in-loop
      await settle();
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
});
