import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Sources, crawlSeconds, crawlSentence, type SourceRow } from './Sources.js';
import { BLOCKED_HOSTS } from '../lib/safety.js';

/**
 * The three rows are the three readings this page exists to keep apart.
 *
 * `baselineRecordCount` is `null` on every one of them, and that is not fixture laziness: the
 * column `sources.baseline_record_count` is declared in `001-init.sql` and WRITTEN BY NOTHING
 * (Task 14, carry-forward note (a)). A page that renders a dormant column as a live figure is
 * the exact shape of defect this product is built to refuse, so the fixture states the real
 * value and the tests below pin what the page may say about it.
 */
const ROWS: SourceRow[] = [
  {
    id: 'ncdxf-grants',
    label: 'NCDXF grant page',
    tier: 'C',
    funderId: 'ncdxf',
    enabled: true,
    lastPolledAt: '2026-08-02T03:17:00.000Z',
    lastSuccessAt: '2026-07-20T03:17:00.000Z',
    consecutiveFailures: 4,
    lastRecordCount: 0,
    baselineRecordCount: null,
    expectedMinRecords: 1,
    health: { state: 'failing', detail: '4 consecutive failures since the last success.' },
  },
  {
    id: 'arrl-scholarship-descriptions',
    label: 'ARRL scholarship catalog',
    tier: 'C',
    funderId: 'arrl-foundation',
    enabled: true,
    lastPolledAt: '2026-08-02T03:17:00.000Z',
    lastSuccessAt: '2026-08-02T03:17:00.000Z',
    consecutiveFailures: 0,
    lastRecordCount: 111,
    baselineRecordCount: null,
    expectedMinRecords: 100,
    health: { state: 'healthy', detail: '111 records on the last successful parse.' },
  },
  {
    id: 'austin-arc-grants',
    label: 'Austin ARC grants portal',
    tier: 'C',
    funderId: 'austin-arc',
    enabled: true,
    lastPolledAt: '2026-08-02T03:17:00.000Z',
    lastSuccessAt: '2026-08-02T03:17:00.000Z',
    consecutiveFailures: 0,
    lastRecordCount: 0,
    baselineRecordCount: null,
    expectedMinRecords: 0,
    health: {
      state: 'idle',
      detail: 'No records, which is expected for this source outside its open window.',
    },
  },
];

const RESPONSE = {
  rows: ROWS,
  summary: { total: 3, healthy: 2, unhealthy: 1 },
  canConfigure: false,
};

/**
 * `canConfigure` is what the page keys every admin control off. It is server
 * truth (`user.role === 'admin'`), not a client guess.
 */
function stubFetch(
  canConfigure: boolean,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/sources/crawl') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          startedAt: '2026-08-02T12:00:00.000Z',
          finishedAt: '2026-08-02T12:00:41.000Z',
          results: [
            { sourceId: 'ncdxf-grants', parsedCount: 3, events: 1, reviewItems: 1 },
            { sourceId: 'arrl-scholarship-descriptions', parsedCount: 111, events: 0, reviewItems: 0 },
          ],
          ...overrides,
        }),
      });
    }
    if (init?.method === 'PATCH') {
      const id = url.replace('/api/sources/', '');
      const patched = ROWS.find((r) => r.id === id);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ source: { ...patched, expectedMinRecords: 120 } }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ...RESPONSE, canConfigure }),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  stubFetch(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSources(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <Sources />
    </MemoryRouter>,
  );
}

describe('crawlSentence', () => {
  it('sums what the crawl actually did, per source', () => {
    expect(
      crawlSentence({
        startedAt: '2026-08-02T12:00:00.000Z',
        finishedAt: '2026-08-02T12:00:41.000Z',
        results: [
          { sourceId: 'a', parsedCount: 3, events: 1, reviewItems: 1 },
          { sourceId: 'b', parsedCount: 111, events: 0, reviewItems: 0 },
        ],
      }),
    ).toBe('Crawled 2 sources in 41 seconds: 114 records, 1 change detected, 1 item queued for review.');
  });

  /** A source that failed is NAMED. Folded into the totals it would look like a quiet night. */
  it('names a source that failed and the reason the fetcher gave', () => {
    const sentence = crawlSentence({
      startedAt: '2026-08-02T12:00:00.000Z',
      finishedAt: '2026-08-02T12:00:05.000Z',
      results: [
        { sourceId: 'a', parsedCount: 0, events: 0, reviewItems: 0, error: 'HTTP 503' },
        { sourceId: 'b', parsedCount: 4, events: 0, reviewItems: 0 },
      ],
    });
    expect(sentence).toContain('Failed: a (HTTP 503).');
  });

  it('omits the duration rather than printing NaN when the instants are unreadable', () => {
    expect(crawlSeconds('x', 'y')).toBeNull();
    expect(crawlSentence({ startedAt: 'x', finishedAt: 'y', results: [] })).toBe(
      'Crawled 0 sources: 0 records, 0 changes detected, 0 items queued for review.',
    );
  });
});

describe('Sources health', () => {
  it('renders one row per source with its state in words', async () => {
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3
    expect(within(table).getByText('Failing')).toBeInTheDocument();
  });

  it('shows parse yield against the configured minimum, not just a count', async () => {
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getByText('111 / 100')).toBeInTheDocument();
  });

  it('explains that an idle source is not a broken one', async () => {
    renderSources();
    expect(
      await screen.findByText(/expected for this source outside its open window/i),
    ).toBeInTheDocument();
  });

  it('shows last poll and last success separately, because they differ when a source fails', async () => {
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getByText('2026-07-20')).toBeInTheDocument();
  });

  it('summarises the fleet', async () => {
    renderSources();
    expect(await screen.findByText(/1 of 3 sources need attention/i)).toBeInTheDocument();
  });

  it('tells a member that source configuration is admin-only', async () => {
    renderSources();
    expect(
      await screen.findByText(/only an administrator can change source configuration/i),
    ).toBeInTheDocument();
  });

  it('explains why some sources are curated by hand rather than polled', async () => {
    renderSources();
    expect(await screen.findByText(/deliberately block non-browser clients/i)).toBeInTheDocument();
  });

  it('gives a member no crawl button and no configuration controls at all', async () => {
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(screen.queryByRole('button', { name: /run crawl now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: /baseline for/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /poll/i })).not.toBeInTheDocument();
  });
});

/**
 * THE UNSET MINIMUM.
 *
 * `expected_min_records` defaults to 0, so a brand-new source whose parser returns nothing reads
 * `idle` rather than `yield_dropped`. Rendering that as `0 / 0` puts a satisfied-looking
 * threshold in front of an operator for the one case where there is no threshold at all — and
 * the six-silently-broken-parsers failure would then be caught only for sources somebody had
 * already configured. It must read as UNSET.
 */
describe('Sources — an unset minimum reads as unset', () => {
  it('never prints a zero minimum as if it were a satisfied threshold', async () => {
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).queryByText('0 / 0')).not.toBeInTheDocument();
    expect(within(table).getByText(/no minimum set/i)).toBeInTheDocument();
  });

  it('says out loud that a source with no minimum cannot raise a yield alarm', async () => {
    renderSources();
    expect(
      await screen.findByText(/1 of 3 sources has no minimum configured/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/cannot raise a yield alarm/i)).toBeInTheDocument();
  });
});

/**
 * THE DORMANT BASELINE.
 *
 * `sources.baseline_record_count` is declared and written by nothing. The health logic already
 * omits its clause when the value is null; this page must not fill the gap with a figure of its
 * own, and must say why the comparison it CANNOT make is missing.
 */
describe('Sources — the dormant historical baseline', () => {
  it('prints no historical yield figure while nothing writes one', async () => {
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).queryByText(/normally yields/i)).not.toBeInTheDocument();
    expect(within(table).queryByText(/last yielded/i)).not.toBeInTheDocument();
  });

  it('explains that a drop can only be measured against the configured minimum', async () => {
    renderSources();
    expect(
      await screen.findByText(/nothing yet records what a source normally yields/i),
    ).toBeInTheDocument();
  });

  it('does show a historical yield once something writes one', async () => {
    const withBaseline = {
      ...RESPONSE,
      rows: [{ ...ROWS[1]!, baselineRecordCount: 111 }],
      summary: { total: 1, healthy: 1, unhealthy: 0 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => withBaseline }),
    );
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getByText(/normally yields 111/i)).toBeInTheDocument();
  });
});

describe('Sources — admin controls', () => {
  it('offers an admin a crawl button', async () => {
    stubFetch(true);
    renderSources();
    expect(await screen.findByRole('button', { name: /run crawl now/i })).toBeEnabled();
  });

  it('runs every source when nothing is selected and reports what came back', async () => {
    const fetchMock = stubFetch(true);
    renderSources();
    await userEvent.click(await screen.findByRole('button', { name: /run crawl now/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post?.[0]).toBe('/api/sources/crawl');
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({});
    });

    await waitFor(() => {
      const result = screen.getByRole('status');
      expect(result).toHaveTextContent(/2 sources/i);
      expect(result).toHaveTextContent(/114 records/i); // 3 + 111
      expect(result).toHaveTextContent(/1 change/i);
    });
  });

  /**
   * Task 10's precedent, on the surface that triggers it: a crawl walks ~25 small volunteer-run
   * sites, so ONE press is ONE request. A page that fanned a press out per row would multiply
   * that load by the size of the fleet — the same shape as the Verify click that would have
   * pulled ~545 MB.
   */
  it('sends exactly one request per press, never one per source', async () => {
    const fetchMock = stubFetch(true);
    renderSources();
    await userEvent.click(await screen.findByRole('button', { name: /run crawl now/i }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/2 sources/i);
    });
    const posts = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
  });

  it('disables the button while a crawl is running and says so', async () => {
    let release: (value: unknown) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Promise((resolve) => {
            release = () =>
              resolve({
                ok: true,
                status: 200,
                json: async () => ({ startedAt: 'x', finishedAt: 'y', results: [] }),
              });
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...RESPONSE, canConfigure: true }),
        });
      }),
    );

    renderSources();
    const button = await screen.findByRole('button', { name: /run crawl now/i });
    await userEvent.click(button);
    expect(await screen.findByRole('button', { name: /crawling/i })).toBeDisabled();
    release(null);
  });

  it('explains a 409 instead of leaving the button dead', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({
              error: {
                code: 'conflict',
                message: 'A crawl is already running. Wait for it to finish.',
              },
              requestId: 'req-test-1',
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...RESPONSE, canConfigure: true }),
        });
      }),
    );

    renderSources();
    await userEvent.click(await screen.findByRole('button', { name: /run crawl now/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already running/i);
    expect(screen.getByRole('button', { name: /run crawl now/i })).toBeEnabled();
  });

  it('does not retry a refused crawl on its own', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            error: { code: 'conflict', message: 'A crawl is already running.' },
            requestId: 'r',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...RESPONSE, canConfigure: true }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSources();
    await userEvent.click(await screen.findByRole('button', { name: /run crawl now/i }));
    await screen.findByRole('alert');
    const posts = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
  });

  it('lets an admin edit a source’s yield minimum', async () => {
    const fetchMock = stubFetch(true);
    renderSources();
    const field = await screen.findByRole('spinbutton', {
      name: /baseline for arrl scholarship catalog/i,
    });
    await userEvent.clear(field);
    await userEvent.type(field, '120');
    await userEvent.click(screen.getByRole('button', { name: /save arrl scholarship catalog/i }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch?.[0]).toBe('/api/sources/arrl-scholarship-descriptions');
      expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({
        expectedMinRecords: 120,
        enabled: true,
      });
    });
  });

  /**
   * `Number('')` is 0, so the brief's `onChange={Number(e.target.value)}` turned an emptied box
   * into a silent "no minimum" — switching a source's only yield alarm off while the field looked
   * merely blank. Emptying it is refused out loud instead.
   */
  it('refuses an empty minimum rather than posting it as zero', async () => {
    const fetchMock = stubFetch(true);
    renderSources();
    const field = await screen.findByRole('spinbutton', {
      name: /baseline for arrl scholarship catalog/i,
    });
    await userEvent.clear(field);
    await userEvent.click(screen.getByRole('button', { name: /save arrl scholarship catalog/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/whole number of 0 or more/i);
    expect(
      fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH'),
    ).toHaveLength(0);
  });

  it('warns an admin that typing zero switches the yield alarm off', async () => {
    stubFetch(true);
    renderSources();
    const field = await screen.findByRole('spinbutton', {
      name: /baseline for arrl scholarship catalog/i,
    });
    // Scoped to this row: the Austin source already sits at 0 and carries the same warning, which
    // is the point — the warning is about the VALUE, not about the edit.
    const row = field.closest('tr');
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).queryByText(/0 means no minimum/i),
    ).not.toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, '0');
    await waitFor(() => {
      expect(
        within(row as HTMLElement).getByText(
          /0 means no minimum: this source cannot raise a yield alarm/i,
        ),
      ).toBeInTheDocument();
    });
  });

  it('lets an admin pause a source with a labelled checkbox', async () => {
    const fetchMock = stubFetch(true);
    renderSources();
    const toggle = await screen.findByRole('checkbox', {
      name: /poll ncdxf grant page nightly/i,
    });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: /save ncdxf grant page/i }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toMatchObject({
        enabled: false,
      });
    });
  });

  it('does not tell an admin that configuration is admin-only', async () => {
    stubFetch(true);
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(
      screen.queryByText(/only an administrator can change source configuration/i),
    ).not.toBeInTheDocument();
  });
});

/**
 * THE BLOCKLIST HAS NO ESCAPE HATCH.
 *
 * `PATCH /api/sources/:id` accepts `expectedMinRecords` and `enabled` and 422s anything else. The
 * page must not offer a control the API would refuse — and above all not a URL or host field,
 * because `farweb.org` is on that list for SAFETY: the Foundation for Amateur Radio's domain now
 * redirects to a gambling site while club pages still say "apply at the FAR website".
 */
describe('Sources — the fetcher blocklist is not configurable', () => {
  it('offers an admin no URL or host control of any kind', async () => {
    stubFetch(true);
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(screen.queryByRole('textbox', { name: /url|host|address|domain/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /url|host|address|domain/i })).not.toBeInTheDocument();
    for (const field of screen.queryAllByRole('textbox')) {
      expect(field.getAttribute('type')).not.toBe('url');
    }
  });

  it('sends nothing but the two configurable keys', async () => {
    const fetchMock = stubFetch(true);
    renderSources();
    await userEvent.click(
      await screen.findByRole('button', { name: /save ncdxf grant page/i }),
    );
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(Object.keys(JSON.parse((patch?.[1] as RequestInit).body as string)).sort()).toEqual([
        'enabled',
        'expectedMinRecords',
      ]);
    });
  });

  it('names the refused hosts from the one list, and links none of them', async () => {
    stubFetch(true);
    renderSources();
    const panel = await screen.findByRole('region', { name: /hosts the fetcher refuses/i });
    for (const host of BLOCKED_HOSTS) {
      expect(within(panel).getByText(host)).toBeInTheDocument();
    }
    // Not `getAllByRole`: this page renders no outbound link at all, and an assertion that throws
    // when the list is empty would be testing the wrong thing.
    for (const link of screen.queryAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org|batualam\.org/);
    }
  });

  it('says the list cannot be changed from this page', async () => {
    stubFetch(true);
    renderSources();
    expect(await screen.findByText(/is not configurable/i)).toBeInTheDocument();
  });
});
