import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Sources, crawlSeconds, crawlSentence, type SourceRow } from './Sources.js';
import { BLOCKED_HOSTS } from '../lib/safety.js';
import { restoreViewport, setViewportWidth } from '../test/viewport.js';

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
/**
 * AN INSTANCE WITH NO SOURCES IS THE COMMON CASE, NOT AN EXOTIC ONE.
 *
 * MEASURED 2026-08-13. Live, `GET https://grant.waterburp.com/api/sources/health` answers
 * `{"rows":[],"summary":{"total":0,"healthy":0,"unhealthy":0},"canConfigure":false}`. Locally,
 * against the same build seeded by `e2e/seed.ts` — which polls every source module through
 * `recordPollStart` — the same endpoint answers 27 rows. The difference is not the code: `sources`
 * rows are written by a crawl, and `packages/server/src/seed/import.ts` writes none, so every
 * installation looks like the live one until its first crawl runs.
 *
 * The page was drawn for the 27-row case and asserted it in prose regardless: "About twenty-five
 * sources are polled nightly", "what make one bad source findable among twenty-five", "Every
 * enabled source has a minimum configured", and a stat card reading "0 of 0 sources need
 * attention" — four claims about a fleet, over a table with a header row and no body.
 *
 * These pin the zero case, which nothing tested before.
 */
describe('Sources — an instance whose fleet is empty', () => {
  function stubEmpty(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          rows: [],
          summary: { total: 0, healthy: 0, unhealthy: 0 },
          canConfigure: false,
        }),
      }),
    );
  }

  it('never reads "0 of 0 need attention" as an all-clear', async () => {
    stubEmpty();
    renderSources();
    expect(await screen.findByText(/no sources are registered/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 of 0 sources need attention/i)).not.toBeInTheDocument();
  });

  it('states no fleet size anywhere on a page that is showing none', async () => {
    stubEmpty();
    renderSources();
    await screen.findByText(/no sources are registered/i);
    const page = document.body.textContent ?? '';
    expect(page, 'the page asserts a fleet size it is not showing').not.toMatch(
      /twenty-five|twenty five/i,
    );
  });

  it('draws no header row over an empty body', async () => {
    stubEmpty();
    renderSources();
    await screen.findByText(/no sources are registered/i);
    expect(screen.queryByRole('table', { name: /source health/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no health matrix to draw yet/i)).toBeInTheDocument();
  });

  it('does not promise that every source has a yield alarm when there are no sources', async () => {
    stubEmpty();
    renderSources();
    await screen.findByText(/no sources are registered/i);
    expect(screen.queryByText(/every enabled source has a minimum configured/i)).toBeNull();
    expect(screen.getByText(/nothing on this instance is being watched/i)).toBeInTheDocument();
  });

  it('takes the fleet size from the rows once there are some', async () => {
    stubFetch(false);
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(screen.getByText(/findable among the 3 below/i)).toBeInTheDocument();
  });
});

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

/**
 * THE ONE DENSE SCREEN THAT STAYS A TABLE.
 *
 * Browse, the watchlist and the account console all stack into cards on a phone, because their
 * rows are records read one at a time. This one is not: an operator opens it to find the ONE
 * source out of twenty-five whose State is red or whose Failures is not zero, and finding it is
 * an act of comparing a column down the page. Stacking would replace that with twenty-five
 * separate readings held in the head.
 *
 * These assert the decision rather than describing it, so a later pass that "makes /sources
 * responsive like the others" has to argue with a test first.
 */
describe('Sources health matrix at a phone width', () => {
  afterEach(() => {
    restoreViewport();
  });

  it('is still a table at 320px', async () => {
    setViewportWidth(320);
    stubFetch(true);
    renderSources();
    expect(await screen.findByRole('table', { name: /source health/i })).toBeInTheDocument();
  });

  it('keeps every column, so the comparison the page exists for still works', async () => {
    setViewportWidth(320);
    stubFetch(true);
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => (th.textContent ?? '').trim());
    expect(headers).toEqual([
      'Source',
      'State',
      'Records / minimum',
      'Last poll',
      'Last success',
      'Failures',
      'Detail',
      'Configuration',
    ]);
  });

  it('keeps the health word on every row — the cell the operator is scanning for', async () => {
    setViewportWidth(320);
    stubFetch(true);
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(screen.getByText('Failing')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('keeps "no minimum set" as words rather than letting a narrow column reduce it to 0', async () => {
    setViewportWidth(320);
    stubFetch(true);
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(screen.getByText('/ no minimum set')).toBeInTheDocument();
  });

  /**
   * A box that scrolls has to be reachable by a keyboard that has no scroll wheel, and a focus
   * stop with no name is a mystery. Both, or the horizontal scroll is a mouse-only feature.
   */
  it('makes the scrolling region focusable and named', async () => {
    setViewportWidth(320);
    stubFetch(true);
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    const region = screen.getByRole('region', { name: /source health, scrollable/i });
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('says out loud that the matrix scrolls sideways instead of reflowing', async () => {
    setViewportWidth(320);
    stubFetch(true);
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(screen.getByText(/scrolls sideways rather than reflowing/i)).toBeInTheDocument();
  });
});

/**
 * "THEY REFUSED US", NOT "WE FOUND NOTHING" (2026-08-11).
 *
 * A 403 or a 404 on a page came back from the fetcher as an ordinary payload, was recorded as a
 * SUCCESSFUL poll of zero records, and landed on this screen as `Yield dropped` — this page
 * telling an operator their parser had stopped working, about a site that had simply said no.
 * `students.ieee.org` sits behind Cloudflare, which is the ordinary way a datacentre IP gets a 403
 * that the same operator's laptop does not, so the page they were told to go and check looked
 * perfect.
 *
 * The server now fails that poll and puts the status and the address in `health.detail`. These
 * tests pin what a reader actually sees, because the whole defect was legible copy stating a
 * confident falsehood.
 */
describe('Sources — a refused source reads as refused', () => {
  const REFUSED: SourceRow = {
    id: 'ieee-student-branch-rebate',
    label: 'IEEE Student Branch Rebate',
    tier: 'C',
    funderId: 'ieee',
    enabled: true,
    lastPolledAt: '2026-08-02T03:17:00.000Z',
    lastSuccessAt: '2026-07-20T03:17:00.000Z',
    consecutiveFailures: 1,
    baselineRecordCount: null,
    lastRecordCount: 1,
    expectedMinRecords: 1,
    health: {
      state: 'failing',
      detail:
        'HTTP 403 for https://students.ieee.org/topics/submit-your-student-branch-annual-plan/ ' +
        '— the site refused us, so no page was read. This is a refusal, not an empty page. ' +
        '1 consecutive failure since the last success.',
    },
  };

  /** A source whose every address answers 410: failed, and paused so we stop asking. */
  const GONE: SourceRow = {
    ...REFUSED,
    id: 'k9ona-scholarship',
    label: 'K9ONA scholarship page',
    funderId: 'k9ona',
    enabled: false,
    health: {
      state: 'failing',
      detail:
        'HTTP 410 for https://www.k9ona.com/scholarship/ — the site states this address is ' +
        'permanently gone, so no page was read. This source has been paused so that we stop ' +
        'asking nightly; re-enable it here once someone has found where the page went. ' +
        '1 consecutive failure since the last success.',
    },
  };

  function stubRows(rows: SourceRow[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          rows,
          summary: { total: rows.length, healthy: 0, unhealthy: rows.length },
          canConfigure: true,
        }),
      }),
    );
  }

  it('names the status and the exact address that refused, in the row', async () => {
    stubRows([REFUSED]);
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getByText(/HTTP 403/)).toBeInTheDocument();
    expect(
      within(table).getByText(/students\.ieee\.org\/topics\/submit-your-student-branch-annual-plan/),
    ).toBeInTheDocument();
    expect(within(table).getByText(/the site refused us/i)).toBeInTheDocument();
  });

  it('does not say the parser stopped working — that was the sentence, and it was false', async () => {
    stubRows([REFUSED]);
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getByText('Failing')).toBeInTheDocument();
    expect(within(table).queryByText('Yield dropped')).not.toBeInTheDocument();
    // The yield alarm's own words. Neither may appear against a page nobody read.
    expect(within(table).queryByText(/this source normally yields at least/i)).not.toBeInTheDocument();
    expect(within(table).getByText(/not an empty page/i)).toBeInTheDocument();
  });

  it('greys out a source paused by a 410 and keeps the reason on the same line', async () => {
    stubRows([GONE]);
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getByText(/HTTP 410/)).toBeInTheDocument();
    expect(within(table).getByText(/permanently gone/i)).toBeInTheDocument();
    // Paused, by the same flag an administrator sets, and drawn the same way.
    const row = within(table).getByText('K9ONA scholarship page').closest('tr');
    expect(row).toHaveClass('source-paused');
    // The way back is on this row: the enable checkbox an admin ticks once they know the address.
    expect(
      within(table).getByRole('checkbox', { name: /poll K9ONA scholarship page nightly/i }),
    ).not.toBeChecked();
  });

  it('states the third reading in prose, beside the two the page was built around', async () => {
    stubRows([REFUSED]);
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(screen.getByText(/A source that refused us is not a quiet night/i)).toBeInTheDocument();
    expect(screen.getByText(/permanently gone \(410\) also pauses the source/i)).toBeInTheDocument();
  });
});
