import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionContext, makeSessionValue, type SessionValue } from '../store/session.js';
import { Watchlist } from './Watchlist.js';

/**
 * THE WATCHLIST IS WHERE SILENCE GETS READ.
 *
 * Everything below exists because an empty digest has three different causes and only one of
 * them is good news. A steady-state night on the real corpus is 553 change events and 0
 * notifications — by design — so "you have no notifications" cannot be allowed to mean "the
 * pipeline is fine". These tests pin the three readings apart: nothing changed, the drain
 * stalled, and the alarm reached a channel that has been refusing it.
 */

const ARRL_WATCH = {
  program: {
    id: 'arrl-foundation-scholarship',
    name: 'ARRL Foundation Scholarship Program',
    tags: ['tier:C', 'source:arrl-scholarship-catalog'],
    amount: { instrument: 'cash_range', amountRaw: '$500 - $25,000' },
    trust: {
      status: 'open',
      lastVerifiedAt: '2026-08-01T00:00:00.000Z',
      sourceUrl: 'https://www.arrl.org/scholarship-program',
      verificationMethod: 'live_fetch',
      contentHash: 'h1',
    },
  },
  funderName: 'ARRL Foundation',
  nextOpensAt: '2027-02-01T05:00:00.000Z',
  // The ARRL's "closes 28 February 2027" in America/New_York. Formatted in UTC this prints
  // 2027-03-01 — one day LATE, which is the direction that costs an applicant the deadline.
  nextClosesAt: '2027-03-01T04:59:00.000Z',
  nextIsEstimated: true,
  nextTimezone: 'America/New_York',
};

/** A star survives its programme changing state. 5 closed + 2 discontinued records exist. */
const DISCONTINUED_WATCH = {
  program: {
    id: 'ardc-grants',
    name: 'ARDC Grants',
    tags: ['tier:A', 'source:ardc-grants'],
    amount: { instrument: 'grant', amountRaw: 'varies' },
    trust: {
      status: 'discontinued',
      lastVerifiedAt: '2026-07-30T00:00:00.000Z',
      sourceUrl: 'https://www.ardc.net/apply/grants/',
      verificationMethod: 'live_fetch',
      contentHash: 'h2',
    },
  },
  funderName: 'Amateur Radio Digital Communications',
  nextOpensAt: null,
  // Funder-published — the rare case; `data/seed/` holds 3 records that declare one — and with no
  // zone recorded. Two independent facts the cell has to state separately.
  nextClosesAt: '2026-09-30T23:59:00.000Z',
  nextIsEstimated: false,
  nextTimezone: null,
};

/** The record that exists to intercept an instruction to apply at a hijacked domain. */
const SAFETY_WATCH = {
  program: {
    id: 'far-farweb-org-compromised',
    name: 'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
    tags: ['tier:D', 'source:manual-tier-d', 'safety_warning'],
    amount: { instrument: 'unknown', amountRaw: null },
    trust: {
      status: 'discontinued',
      lastVerifiedAt: '2026-08-01T00:00:00.000Z',
      sourceUrl: 'https://www.arrl.org/scholarship-program',
      verificationMethod: 'manual',
      contentHash: 'h3',
    },
  },
  funderName: 'Foundation for Amateur Radio',
  nextOpensAt: null,
  nextClosesAt: null,
  nextIsEstimated: false,
  nextTimezone: null,
};

const DEADLINE_MOVE = {
  id: 'ce-1:u-member',
  userId: 'u-member',
  changeEventId: 'ce-1',
  sourceId: 'arrl-scholarship-catalog',
  programId: 'arrl-foundation-scholarship',
  programName: 'ARRL Foundation Scholarship Program',
  kind: 'deadline_changed',
  title: 'Deadline changed: ARRL Foundation Scholarship Program',
  body:
    'Changed from January 31 to December 30, 12:00 PM EST (deadline.note). ' +
    'Check the funder’s own page before you rely on either date.',
  fieldPath: 'deadline.note',
  before: 'January 31',
  after: 'December 30, 12:00 PM EST',
  createdAt: '2026-08-02T03:17:00.000Z',
  readAt: null,
};

const QUIET_CHANNELS = {
  inApp: true,
  webhookUrl: null,
  ntfyServer: null,
  ntfyTopic: null,
  health: [],
};

const BROKEN_WEBHOOK_CHANNELS = {
  inApp: true,
  webhookUrl: 'https://hooks.example.com/grantspotter',
  ntfyServer: null,
  ntfyTopic: null,
  health: [
    {
      channel: 'webhook',
      lastAttemptAt: '2026-08-02T03:17:00.000Z',
      lastOkAt: '2026-07-25T03:17:00.000Z',
      lastStatus: 500,
      lastError: 'HTTP 500',
      consecutiveFailures: 7,
    },
  ],
};

/** A night that fanned out and reached everyone it should have. */
const HEALTHY_FANOUT = {
  pendingEvents: 0,
  fannedOutEvents: 553,
  zeroRecipientEvents: 0,
  suppressed: [{ reason: 'not_publishable', events: 553, watchers: 0 }],
  lastFanoutAt: '2026-08-02T03:17:00.000Z',
  notifications: { total: 1, unread: 1 },
};

/** The drain has not run. Every digest in the product is empty for a reason that is not silence. */
const STALLED_FANOUT = {
  pendingEvents: 41,
  fannedOutEvents: 0,
  zeroRecipientEvents: 0,
  suppressed: [],
  lastFanoutAt: null,
  notifications: { total: 0, unread: 0 },
};

interface StubOptions {
  watches?: unknown;
  notifications?: unknown;
  channels?: unknown;
  fanout?: unknown;
  put?: { status: number; body: unknown };
  sendTest?: { status: number; body: unknown };
  throwOnWrite?: boolean;
}

function json(status: number, body: unknown): Promise<unknown> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function noContent(): Promise<unknown> {
  return Promise.resolve({
    ok: true,
    status: 204,
    json: async () => {
      throw new Error('204 carries no body');
    },
  });
}

function stubApi(options: StubOptions = {}) {
  const watches = options.watches ?? { rows: [ARRL_WATCH, DISCONTINUED_WATCH, SAFETY_WATCH] };
  const notifications = options.notifications ?? { unread: 1, rows: [DEADLINE_MOVE] };
  const channels = options.channels ?? QUIET_CHANNELS;
  const fanout = options.fanout ?? HEALTHY_FANOUT;

  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      if (url.startsWith('/api/watches')) return json(200, watches);
      // Ordered before the prefix below on purpose: `/api/notifications/health` is a different
      // endpoint with a different shape and a different permission.
      if (url.startsWith('/api/notifications/health')) return json(200, fanout);
      if (url.startsWith('/api/notifications')) return json(200, notifications);
      if (url.startsWith('/api/channels')) return json(200, channels);
      return json(404, {
        error: { code: 'not_found', message: `no stub for ${url}` },
        requestId: 'req-stub',
      });
    }
    if (options.throwOnWrite === true) return Promise.reject(new TypeError('Failed to fetch'));
    if (method === 'PUT' && url === '/api/channels') {
      const put = options.put ?? {
        status: 200,
        body: JSON.parse(String(init?.body ?? '{}')) as unknown,
      };
      return json(put.status, put.body);
    }
    if (method === 'POST' && url === '/api/channels/test') {
      const sent = options.sendTest ?? { status: 200, body: { results: [] } };
      return json(sent.status, sent.body);
    }
    return noContent();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const MEMBER = makeSessionValue({
  user: { id: 'u-member', email: 'member@example.com', role: 'member' },
});
const ADMIN = makeSessionValue({
  user: { id: 'u-admin', email: 'admin@example.com', role: 'admin' },
});

function renderWatchlist(session: SessionValue = MEMBER) {
  return render(
    <MemoryRouter>
      <SessionContext.Provider value={session}>
        <Watchlist now="2026-08-02T12:00:00.000Z" />
      </SessionContext.Provider>
    </MemoryRouter>,
  );
}

async function rowFor(name: string | RegExp): Promise<HTMLElement> {
  await screen.findByRole('table', { name: /watched programs/i });
  const found = screen
    .getAllByRole('row')
    .find((row) => within(row).queryByText(name) !== null);
  if (found === undefined) throw new Error(`no watchlist row matching ${String(name)}`);
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Watchlist — watched programs', () => {
  it('renders the starred programs with their next deadline', async () => {
    stubApi();
    renderWatchlist();
    const table = await screen.findByRole('table', { name: /watched programs/i });
    expect(within(table).getByText('ARRL Foundation Scholarship Program')).toBeInTheDocument();
    expect(within(table).getByText('ARRL Foundation')).toBeInTheDocument();
  });

  it('prints the funder’s own calendar day, not the UTC instant one day later', async () => {
    stubApi();
    renderWatchlist();
    const row = await rowFor('ARRL Foundation Scholarship Program');
    expect(within(row).getByText('2027-02-28')).toBeInTheDocument();
    expect(within(row).queryByText('2027-03-01')).toBeNull();
  });

  it('says a projected deadline is projected and a published one is published', async () => {
    stubApi();
    renderWatchlist();
    expect(within(await rowFor('ARRL Foundation Scholarship Program')).getByText(/projected/i))
      .toBeInTheDocument();
    expect(within(await rowFor('ARDC Grants')).getByText(/published by the funder/i))
      .toBeInTheDocument();
  });

  /**
   * THE CENSUS IS COUNTED, NOT TYPED.
   *
   * The sentence it replaces lived in a `title` on every projected row and read "Only 4 of the
   * corpus's 244 cycles are funder-published". Six files said 244 and six others said 243 for the
   * same claim, and on the corpus that ships neither is right — 252 cycles with 2
   * funder-published on 2026-08-04, 248 with 0 by 2027-02-01, because the three seed records that
   * declare a funder-published window all close inside a year. A number the reader cannot check
   * against the rows under it is the failure this product exists to avoid, so this one is derived
   * from `watchRows`: change the stub and the sentence changes with it.
   */
  it('counts the provenance of the rows it is showing, rather than quoting a fixed total', async () => {
    stubApi();
    renderWatchlist();
    await screen.findByRole('table', { name: /watched programs/i });
    // ARDC is funder-published, the ARRL catalog row is projected, and the safety-warning record
    // carries no close date at all — three rows, three different states.
    expect(
      screen.getByText(/1 funder-published, 1 projected, 1 with no close date recorded/i),
    ).toBeInTheDocument();
  });

  it('recounts when the watchlist is different, so the sentence cannot be a constant', async () => {
    stubApi({ watches: { rows: [ARRL_WATCH, { ...ARRL_WATCH, program: { ...ARRL_WATCH.program, id: 'p2', name: 'Second Projected' } }] } });
    renderWatchlist();
    await screen.findByRole('table', { name: /watched programs/i });
    expect(
      screen.getByText(/0 funder-published, 2 projected, 0 with no close date recorded/i),
    ).toBeInTheDocument();
  });

  /**
   * `nextIsEstimated` is only a claim when a date exists. The server sends `false` beside a null
   * `nextClosesAt` — see SAFETY_WATCH — so a census that counted undated rows as funder-published
   * would report the product's rarest state as its commonest one on a fresh install.
   */
  it('does not read an undated row as a funder-published one', async () => {
    stubApi({ watches: { rows: [SAFETY_WATCH] } });
    renderWatchlist();
    await screen.findByRole('table', { name: /watched programs/i });
    expect(
      screen.getByText(/0 funder-published, 0 projected, 1 with no close date recorded/i),
    ).toBeInTheDocument();
  });

  it('labels a deadline with no recorded zone as UTC instead of guessing the browser’s', async () => {
    stubApi();
    renderWatchlist();
    const row = await rowFor('ARDC Grants');
    expect(within(row).getByText('2026-09-30')).toBeInTheDocument();
    expect(within(row).getByText(/utc/i)).toBeInTheDocument();
    expect(within(row).getByText(/no zone recorded/i)).toBeInTheDocument();
  });

  it('keeps a watch whose programme is no longer open, and reports the new status', async () => {
    stubApi();
    renderWatchlist();
    const row = await rowFor('ARDC Grants');
    expect(within(row).getByRole('img', { name: /status: discontinued/i })).toBeInTheDocument();
  });

  it('explains that a star subscribes to changes, not just the date', async () => {
    stubApi();
    renderWatchlist();
    expect(await screen.findByText(/subscribes you to every change/i)).toBeInTheDocument();
  });

  it('renders the farweb.org record as a safety warning', async () => {
    stubApi();
    renderWatchlist();
    const row = await rowFor(/domain compromised/i);
    expect(within(row).getByText(/safety warning/i)).toBeInTheDocument();
  });

  it('offers no outbound link at all, so no hijacked host is reachable from this page', async () => {
    stubApi();
    renderWatchlist();
    await screen.findByRole('table', { name: /watched programs/i });
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href, `${href} leaves the application`).toMatch(/^\//);
    }
  });

  it('shows an empty state when nothing is starred', async () => {
    stubApi({ watches: { rows: [] } });
    renderWatchlist();
    expect(await screen.findByText(/you are not watching anything yet/i)).toBeInTheDocument();
  });

  it('reports a failed watch load rather than rendering it as an empty watchlist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/watches')) {
          return json(500, {
            error: { code: 'internal', message: 'the database is unavailable' },
            requestId: 'req-test-1',
          });
        }
        if (url.startsWith('/api/notifications')) return json(200, { rows: [], unread: 0 });
        return json(200, QUIET_CHANNELS);
      }),
    );
    renderWatchlist();
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/you are not watching anything yet/i)).toBeNull();
  });

  it('unstars a program', async () => {
    const fetchMock = stubApi();
    renderWatchlist();
    const row = await rowFor('ARRL Foundation Scholarship Program');
    await userEvent.click(within(row).getByRole('button', { name: /stop watching/i }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(del?.[0]).toBe('/api/watches/arrl-foundation-scholarship');
    });
  });
});

describe('Watchlist — change digest', () => {
  it('renders the deadline-move notification as a readable sentence', async () => {
    stubApi();
    renderWatchlist();
    const digest = await screen.findByRole('region', { name: /change digest/i });
    expect(
      within(digest).getByText('Deadline changed: ARRL Foundation Scholarship Program'),
    ).toBeInTheDocument();
    expect(within(digest).getByText('January 31')).toBeInTheDocument();
    expect(within(digest).getByText('December 30, 12:00 PM EST')).toBeInTheDocument();
  });

  it('keeps the sentence that tells the reader what to do about it', async () => {
    stubApi();
    renderWatchlist();
    const digest = await screen.findByRole('region', { name: /change digest/i });
    expect(within(digest).getByText(/before you rely on either date/i)).toBeInTheDocument();
  });

  it('links a notification to the program it concerns', async () => {
    stubApi();
    renderWatchlist();
    const digest = await screen.findByRole('region', { name: /change digest/i });
    expect(within(digest).getByRole('link', { name: /open the record/i })).toHaveAttribute(
      'href',
      '/o/arrl-foundation-scholarship',
    );
  });

  it('names the source, not a missing programme, on a source-level alarm', async () => {
    stubApi({
      notifications: {
        unread: 1,
        rows: [
          {
            ...DEADLINE_MOVE,
            id: 'ce-2:u-member',
            kind: 'parse_yield_dropped',
            programId: null,
            programName: null,
            title: 'Parser yield dropped',
            body: 'Changed from at least 111 records to 0 records. Check the funder’s page yourself.',
            fieldPath: null,
            before: 'at least 111 records',
            after: '0 records',
          },
        ],
      },
    });
    renderWatchlist();
    const digest = await screen.findByRole('region', { name: /change digest/i });
    expect(within(digest).queryByRole('link', { name: /open the record/i })).toBeNull();
    expect(within(digest).getByText(/arrl-scholarship-catalog/)).toBeInTheDocument();
  });

  it('marks a single notification read', async () => {
    const fetchMock = stubApi();
    renderWatchlist();
    await userEvent.click(await screen.findByRole('button', { name: /mark read/i }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          (call) => call[0] === '/api/notifications/ce-1:u-member/read',
        ),
      ).toBe(true);
    });
  });

  it('marks everything read', async () => {
    const fetchMock = stubApi();
    renderWatchlist();
    await userEvent.click(await screen.findByRole('button', { name: /mark all read/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => call[0] === '/api/notifications/read-all')).toBe(
        true,
      );
    });
  });
});

describe('Watchlist — an empty digest is never rendered as good news', () => {
  it('tells a member that silence here is not a report on the pipeline', async () => {
    stubApi({ notifications: { rows: [], unread: 0 } });
    renderWatchlist(MEMBER);
    const digest = await screen.findByRole('region', { name: /change digest/i });
    expect(within(digest).getByText(/no change has been recorded/i)).toBeInTheDocument();
    expect(within(digest).getByText(/not a report on the change pipeline/i)).toBeInTheDocument();
  });

  it('does not ask a member for the admin-only fan-out health', async () => {
    const fetchMock = stubApi({ notifications: { rows: [], unread: 0 } });
    renderWatchlist(MEMBER);
    await screen.findByRole('region', { name: /change digest/i });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).startsWith('/api/notifications/health')),
    ).toBe(false);
  });

  it('shows an admin that the drain ran and reached everyone, so silence means silence', async () => {
    stubApi({ notifications: { rows: [], unread: 0 } });
    renderWatchlist(ADMIN);
    const digest = await screen.findByRole('region', { name: /change digest/i });
    expect(await within(digest).findByText(/last ran/i)).toBeInTheDocument();
    expect(within(digest).getByText(/2026-08-02/)).toBeInTheDocument();
    // 553 events suppressed with 0 watchers is the design working, not an outage. It is stated
    // twice on purpose — once as what the drain processed, once as what it withheld and why — so
    // this asserts the count is present rather than that it appears exactly once.
    expect(within(digest).getAllByText(/553/).length).toBeGreaterThan(0);
    expect(within(digest).getByText(/not publishable: 553 events, 0 watchers/i)).toBeInTheDocument();
  });

  it('shows an admin a stalled drain as a stalled drain, not as a quiet week', async () => {
    stubApi({ notifications: { rows: [], unread: 0 }, fanout: STALLED_FANOUT });
    renderWatchlist(ADMIN);
    const digest = await screen.findByRole('region', { name: /change digest/i });
    const alert = await within(digest).findByRole('alert');
    expect(alert).toHaveTextContent(/41/);
    expect(alert).toHaveTextContent(/waiting/i);
    expect(alert).toHaveTextContent(/never run/i);
  });

  it('names an alarm that reached nobody at all', async () => {
    stubApi({
      notifications: { rows: [], unread: 0 },
      fanout: { ...HEALTHY_FANOUT, zeroRecipientEvents: 3 },
    });
    renderWatchlist(ADMIN);
    const digest = await screen.findByRole('region', { name: /change digest/i });
    expect(await within(digest).findByText(/reached nobody/i)).toBeInTheDocument();
  });

  it('says a channel has been failing, so a broken webhook cannot read as a quiet week', async () => {
    stubApi({ notifications: { rows: [], unread: 0 }, channels: BROKEN_WEBHOOK_CHANNELS });
    renderWatchlist(MEMBER);
    const digest = await screen.findByRole('region', { name: /change digest/i });
    const alert = await within(digest).findByRole('alert');
    expect(alert).toHaveTextContent(/webhook/i);
    expect(alert).toHaveTextContent(/7/);
  });
});

describe('Watchlist — delivery channels', () => {
  it('offers webhook and ntfy delivery, with in-app stated as the default', async () => {
    stubApi();
    renderWatchlist();
    const settings = await screen.findByRole('region', { name: /delivery/i });
    expect(within(settings).getByText(/in-app digest is always on/i)).toBeInTheDocument();
    expect(within(settings).getByLabelText(/webhook url/i)).toBeInTheDocument();
    expect(within(settings).getByLabelText(/ntfy topic/i)).toBeInTheDocument();
  });

  it('says email is optional and not configured here, rather than showing a dead field', async () => {
    stubApi();
    renderWatchlist();
    const settings = await screen.findByRole('region', { name: /delivery/i });
    expect(within(settings).getByText(/email is optional and is not required/i)).toBeInTheDocument();
    expect(within(settings).queryByLabelText(/smtp/i)).toBeNull();
  });

  it('surfaces a refused webhook URL as an explanation, and offers no way to override it', async () => {
    stubApi({
      put: {
        status: 422,
        body: {
          error: {
            code: 'validation_failed',
            message: 'webhook URLs must use https',
            details: { field: 'webhookUrl' },
          },
          requestId: 'req-test-1',
        },
      },
    });
    renderWatchlist();
    await userEvent.type(
      await screen.findByLabelText(/webhook url/i),
      'http://example.com/hook',
    );
    await userEvent.click(screen.getByRole('button', { name: /save delivery settings/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/https/i);
    expect(alert).toHaveTextContent(/not configurable/i);
    expect(screen.queryByRole('button', { name: /anyway|override|force/i })).toBeNull();
  });

  it('marks the field the server refused', async () => {
    stubApi({
      put: {
        status: 422,
        body: {
          error: {
            code: 'validation_failed',
            message: 'refusing a private or internal webhook host (loopback): 127.0.0.1',
            details: { field: 'webhookUrl' },
          },
          requestId: 'req-test-2',
        },
      },
    });
    renderWatchlist();
    const input = await screen.findByLabelText(/webhook url/i);
    await userEvent.type(input, 'https://192.0.2.10/hook');
    await userEvent.click(screen.getByRole('button', { name: /save delivery settings/i }));
    await screen.findByRole('alert');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not blame the address when it was the API that could not be reached', async () => {
    stubApi({ throwOnWrite: true });
    renderWatchlist();
    await userEvent.type(
      await screen.findByLabelText(/webhook url/i),
      'https://hooks.example.com/grantspotter',
    );
    await userEvent.click(screen.getByRole('button', { name: /save delivery settings/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/never completed|could not be reached/i);
    expect(alert).not.toHaveTextContent(/refused that delivery target/i);
  });

  it('reports a failed test delivery as a result, not as an error page', async () => {
    stubApi({
      channels: BROKEN_WEBHOOK_CHANNELS,
      sendTest: {
        status: 200,
        body: { results: [{ channel: 'webhook', ok: false, status: 500 }] },
      },
    });
    renderWatchlist();
    await userEvent.click(
      await screen.findByRole('button', { name: /send a test notification/i }),
    );
    const results = await screen.findByRole('list', { name: /test delivery/i });
    expect(within(results).getByText(/not delivered/i)).toBeInTheDocument();
    expect(within(results).getByText(/500/)).toBeInTheDocument();
  });

  it('explains that there is nothing to test when no external channel is configured', async () => {
    stubApi({
      sendTest: {
        status: 409,
        body: {
          error: {
            code: 'conflict',
            message:
              'No external channel is configured, so there is nothing to test. The in-app digest is always on.',
          },
          requestId: 'req-test-3',
        },
      },
    });
    renderWatchlist();
    await userEvent.click(
      await screen.findByRole('button', { name: /send a test notification/i }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing to test/i);
  });

  it('shows a channel’s delivery health beside the destination that produced it', async () => {
    stubApi({ channels: BROKEN_WEBHOOK_CHANNELS });
    renderWatchlist();
    const settings = await screen.findByRole('region', { name: /delivery/i });
    expect(within(settings).getByText(/7 deliveries in a row/i)).toBeInTheDocument();
    expect(within(settings).getByText(/2026-07-25/)).toBeInTheDocument();
  });
});
