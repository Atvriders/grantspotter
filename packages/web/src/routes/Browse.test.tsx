import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { activeFilterCount, Browse, FILTER_RAIL_MIN_PX } from './Browse.js';
import { EMPTY_FILTERS } from '../lib/filterState.js';
import { restoreViewport, setViewportWidth } from '../test/viewport.js';
import {
  ARRL_FOUNDATION_ROW,
  ARRL_GRANTS_ROW,
  CHICAGO_FM_ROW,
  FAR_SAFETY_ROW,
  makeResponse,
  makeRow,
} from '../test/programRowFixtures.js';

const RESPONSE = makeResponse({
  rows: [ARRL_FOUNDATION_ROW, CHICAGO_FM_ROW],
  summary: {
    total: 2,
    eligible: 1,
    preferred: 0,
    ineligible: 1,
    unknown: 0,
    ineligibleByAxis: [{ axis: 'other', count: 1 }],
    unknownByField: [],
  },
  total: 2,
  profileApplied: 'student',
});

function stubFetch(body: unknown = RESPONSE) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderBrowse(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Browse now="2026-08-02T12:00:00.000Z" />
    </MemoryRouter>,
  );
}

function requestedUrls(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls.map((call) => String((call as [string])[0]));
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Browse', () => {
  it('renders one row per program with a verdict badge', async () => {
    renderBrowse();
    const table = await screen.findByRole('table', { name: /opportunities/i });
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2
    expect(within(table).getByLabelText('Eligible')).toBeInTheDocument();
  });

  it('shows the verdict census as a headline, not buried', async () => {
    renderBrowse();
    expect(await screen.findByText(/you are ineligible for 1 of these/i)).toBeInTheDocument();
  });

  it('renders the amber unverified badge on a record older than 90 days', async () => {
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.getByLabelText(/unverified\. last checked 2026-01-05/i)).toBeInTheDocument();
  });

  it('renders the stale-mirror warning inline on the row that carries it', async () => {
    renderBrowse();
    expect(await screen.findByText(/mirror stale ARRL data/i)).toBeInTheDocument();
  });

  it('renders status "discontinued" rather than an empty cell', async () => {
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.getByLabelText('Status: discontinued')).toBeInTheDocument();
  });

  it('renders an em dash for a program with no next deadline', async () => {
    renderBrowse();
    const table = await screen.findByRole('table', { name: /opportunities/i });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[2]!).getByText('—')).toBeInTheDocument();
  });

  it('sends the filters from the URL to the API', async () => {
    const fetchMock = stubFetch();
    renderBrowse('/?klass=ham_grant&verdict=ineligible&sort=name');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = requestedUrls(fetchMock)[0]!;
    expect(url).toContain('klass=ham_grant');
    expect(url).toContain('verdict=ineligible');
    expect(url).toContain('sort=name');
  });

  it('refetches when a filter checkbox is toggled', async () => {
    const fetchMock = stubFetch();
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    await userEvent.click(screen.getByRole('checkbox', { name: /ham grant/i }));
    await waitFor(() => {
      expect(requestedUrls(fetchMock).some((u) => u.includes('klass=ham_grant'))).toBe(true);
    });
  });

  it('gives the filter panel a labelled landmark and grouped fieldsets', async () => {
    renderBrowse();
    const panel = await screen.findByRole('region', { name: /filters/i });
    expect(within(panel).getByRole('group', { name: /opportunity class/i })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: /applicant/i })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: /instrument/i })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: /matcher verdict/i })).toBeInTheDocument();
  });

  it('warns that rolling programs drop out when a deadline window is set', async () => {
    renderBrowse('/?deadlineFrom=2026-12-01&includeRolling=false');
    expect(await screen.findByText(/rolling and undated programs are hidden/i)).toBeInTheDocument();
  });

  it('does not warn about rolling programs when no deadline window is set', async () => {
    renderBrowse('/?includeRolling=false');
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.queryByText(/rolling and undated programs are hidden/i)).not.toBeInTheDocument();
  });

  it('tells the user when no profile is applied instead of showing silent nulls', async () => {
    stubFetch(makeResponse({ ...RESPONSE, profileApplied: null }));
    renderBrowse();
    expect(await screen.findByRole('link', { name: /set up a profile/i })).toBeInTheDocument();
  });

  it('does not render the verdict census when nobody has been matched', async () => {
    stubFetch(makeResponse({ ...RESPONSE, profileApplied: null }));
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.queryByText(/you are ineligible for/i)).not.toBeInTheDocument();
  });

  it('shows an empty state rather than a bare table', async () => {
    stubFetch(
      makeResponse({
        rows: [],
        summary: { ...RESPONSE.summary, total: 0, eligible: 0, ineligible: 0 },
        total: 0,
      }),
    );
    renderBrowse();
    expect(await screen.findByText(/no opportunities match these filters/i)).toBeInTheDocument();
  });
});

describe('Browse census honesty', () => {
  it('names unknown as a question rather than letting it read as a soft no', async () => {
    stubFetch(
      makeResponse({
        rows: [ARRL_GRANTS_ROW],
        summary: {
          total: 150,
          eligible: 100,
          preferred: 4,
          ineligible: 38,
          unknown: 8,
          ineligibleByAxis: [{ axis: 'geography', count: 20 }],
          unknownByField: [{ field: 'is501c3', count: 8 }],
        },
        total: 150,
      }),
    );
    renderBrowse();
    expect(await screen.findByText(/8 unknown/i)).toBeInTheDocument();
    expect(screen.getByText(/not a "no"/i)).toBeInTheDocument();
  });

  it('links the ineligible figure to the same query filtered to ineligible', async () => {
    renderBrowse('/?klass=ham_grant');
    const link = await screen.findByRole('link', { name: /see the specific constraint for each/i });
    expect(link.getAttribute('href')).toContain('verdict=ineligible');
    expect(link.getAttribute('href')).toContain('klass=ham_grant');
  });

  it('omits the drill-down link when nothing excludes the user', async () => {
    stubFetch(
      makeResponse({
        rows: [ARRL_FOUNDATION_ROW],
        summary: { ...RESPONSE.summary, total: 1, eligible: 1, ineligible: 0 },
        total: 1,
      }),
    );
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(
      screen.queryByRole('link', { name: /see the specific constraint for each/i }),
    ).not.toBeInTheDocument();
  });
});

describe('Browse pagination', () => {
  /**
   * THE CORPUS IS 150 PUBLISHABLE PROGRAMMES AND THE DEFAULT PAGE SIZE IS 50. Without a pager the
   * first page is the only page anyone can reach, so two thirds of the corpus is unreachable while
   * the screen shows no sign that anything was cut. The API has always returned the unpaginated
   * `total` next to the page precisely so this control can exist.
   */
  const PAGED = makeResponse({
    rows: [ARRL_FOUNDATION_ROW, CHICAGO_FM_ROW],
    summary: { ...RESPONSE.summary, total: 150 },
    page: 1,
    pageSize: 50,
    total: 150,
  });

  it('says which page of how many the reader is on', async () => {
    stubFetch(PAGED);
    renderBrowse();
    expect(await screen.findByText(/page 1 of 3/i)).toBeInTheDocument();
    expect(screen.getByText(/150 programmes/i)).toBeInTheDocument();
  });

  it('asks the API for the next page when Next is pressed', async () => {
    const fetchMock = stubFetch(PAGED);
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    await userEvent.click(screen.getByRole('button', { name: /next page/i }));
    await waitFor(() => {
      expect(requestedUrls(fetchMock).some((u) => u.includes('page=2'))).toBe(true);
    });
  });

  it('disables Previous on the first page and Next on the last', async () => {
    stubFetch(PAGED);
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next page/i })).toBeEnabled();
  });

  it('hides the pager when everything fits on one page', async () => {
    stubFetch(RESPONSE);
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.queryByRole('button', { name: /next page/i })).not.toBeInTheDocument();
  });

  it('resets to page 1 when a filter changes, so page 3 of an old query is not requested', async () => {
    const fetchMock = stubFetch(PAGED);
    renderBrowse('/?page=3');
    await screen.findByRole('table', { name: /opportunities/i });
    await userEvent.click(screen.getByRole('checkbox', { name: /ham grant/i }));
    await waitFor(() => {
      const withKlass = requestedUrls(fetchMock).filter((u) => u.includes('klass=ham_grant'));
      expect(withKlass.length).toBeGreaterThan(0);
      expect(withKlass.every((u) => !u.includes('page='))).toBe(true);
    });
  });
});

describe('Browse deadlines', () => {
  /**
   * The end of the chain migration 037 opened: `program_search.next_timezone` -> `BrowseRow
   * .nextTimezone` -> `formatDate`. Browse used to have nothing to pass and printed the UTC day.
   */
  it("renders the funder's own calendar day for a zoned deadline", async () => {
    stubFetch(makeResponse({ rows: [ARRL_GRANTS_ROW], total: 1 }));
    renderBrowse();
    const table = await screen.findByRole('table', { name: /opportunities/i });
    expect(within(table).getByText('2027-02-28')).toBeInTheDocument();
    expect(within(table).queryByText('2027-03-01')).not.toBeInTheDocument();
  });

  it('marks a projected deadline as an estimate', async () => {
    stubFetch(makeResponse({ rows: [ARRL_GRANTS_ROW], total: 1 }));
    renderBrowse();
    const table = await screen.findByRole('table', { name: /opportunities/i });
    expect(within(table).getByText('est.')).toBeInTheDocument();
  });
});

describe('Browse safety warning', () => {
  it('renders the compromised-domain record as a warning and never as a link to that host', async () => {
    stubFetch(makeResponse({ rows: [FAR_SAFETY_ROW], total: 1 }));
    const { container } = renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.getByRole('note', { name: /safety warning/i })).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('farweb.org');
  });
});

describe('Browse failure states', () => {
  it('reports a transport failure as a failure to reach the API, not as an empty corpus', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    renderBrowse();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load opportunities/i);
    expect(screen.queryByText(/no opportunities match these filters/i)).not.toBeInTheDocument();
  });

  /**
   * A verdict filter with no profile behind it matches nothing SERVER-SIDE, by design: there is no
   * verdict to test. An unexplained empty table reads as "the corpus has none of these", which is
   * a false claim about the corpus rather than a true one about the profile.
   */
  it('explains an empty result caused by a verdict filter with no profile', async () => {
    stubFetch(makeResponse({ rows: [], total: 0, profileApplied: null }));
    renderBrowse('/?verdict=eligible');
    expect(await screen.findByText(/no profile is set, so no verdict can match/i)).toBeInTheDocument();
  });
});

describe('Browse search', () => {
  it('owns the only search box in the product', async () => {
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
  });

  it('sends the typed query to the API', async () => {
    const fetchMock = stubFetch();
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    await userEvent.type(screen.getByRole('searchbox'), 'FAR');
    await waitFor(() => {
      expect(requestedUrls(fetchMock).some((u) => u.includes('q=FAR'))).toBe(true);
    });
  });

  it('keeps a stale row list from outliving a filter change', async () => {
    const fetchMock = stubFetch();
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeResponse({ rows: [makeRow({ funderName: 'Someone else' })], total: 1 }),
    });
    await userEvent.click(screen.getByRole('checkbox', { name: /ham grant/i }));
    await waitFor(() => {
      expect(screen.queryByText('ARRL Foundation')).not.toBeInTheDocument();
    });
  });
});

/**
 * The filter rail on a phone.
 *
 * The rail is 264px of permanently-visible chrome, and at 900px — where it used to appear — it
 * left the results table a 644px column against a 691px min-content. Below `FILTER_RAIL_MIN_PX`
 * it becomes a `<details>` the reader opens when they want it. The one thing it may never do is
 * close over the fact that the list underneath has been narrowed, which is what these assert.
 */
describe('Browse filter sheet', () => {
  afterEach(() => {
    restoreViewport();
  });

  function sheet(): HTMLDetailsElement {
    const el = document.querySelector('details.filter-sheet');
    if (el === null) throw new Error('no filter sheet rendered');
    return el as HTMLDetailsElement;
  }

  it('keeps the rail beside the results at the width it fits at', async () => {
    setViewportWidth(FILTER_RAIL_MIN_PX);
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(document.querySelector('details.filter-sheet')).toBeNull();
    expect(document.querySelector('.filter-panel')).not.toBeNull();
  });

  it('folds the rail into a disclosure one pixel below it', async () => {
    setViewportWidth(FILTER_RAIL_MIN_PX - 1);
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(sheet().open).toBe(false);
    // Folded, not deleted: the panel is still the same panel.
    expect(sheet().querySelector('.filter-panel')).not.toBeNull();
  });

  it('states how many programmes survive the filters while it is shut', async () => {
    setViewportWidth(390);
    renderBrowse();
    await screen.findByRole('list', { name: /opportunities/i });
    const summary = sheet().querySelector('summary');
    expect(sheet().open).toBe(false);
    expect(summary?.textContent).toMatch(/2 programmes match/);
  });

  it('counts the filters that are on, so a shut sheet cannot hide them', async () => {
    setViewportWidth(390);
    renderBrowse('/?status=open&klass=ham_grant&q=arrl');
    await screen.findByRole('list', { name: /opportunities/i });
    expect(sheet().querySelector('summary')?.textContent).toMatch(/3 set/);
  });

  it('says "none set" rather than a bare zero when nothing is filtered', async () => {
    setViewportWidth(390);
    renderBrowse();
    await screen.findByRole('list', { name: /opportunities/i });
    expect(sheet().querySelector('summary')?.textContent).toMatch(/none set/);
  });

  it('opens on the summary, putting the whole panel within reach', async () => {
    setViewportWidth(390);
    renderBrowse();
    await screen.findByRole('list', { name: /opportunities/i });
    const summary = sheet().querySelector('summary');
    expect(summary).not.toBeNull();
    await userEvent.click(summary as HTMLElement);
    expect(sheet().open).toBe(true);
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
  });
});

describe('Browse results on a phone', () => {
  afterEach(() => {
    restoreViewport();
  });

  it('stacks the results into records rather than shrinking the table', async () => {
    setViewportWidth(390);
    renderBrowse();
    expect(await screen.findByRole('list', { name: /opportunities/i })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('still names every programme and its funder', async () => {
    setViewportWidth(390);
    renderBrowse();
    await screen.findByRole('list', { name: /opportunities/i });
    expect(screen.getByRole('link', { name: 'ARRL Foundation Scholarship Program' })).toBeInTheDocument();
    expect(screen.getByText('Six Meter Club of Chicago')).toBeInTheDocument();
  });

  /** The census is the page's headline claim and is not a table thing. It stays. */
  it('keeps the ineligible census above the stack', async () => {
    setViewportWidth(320);
    renderBrowse();
    await screen.findByRole('list', { name: /opportunities/i });
    expect(screen.getByText(/you are ineligible for 1 of these/i)).toBeInTheDocument();
  });
});

describe('activeFilterCount', () => {
  it('is zero for the defaults, so the sheet says "none set" honestly', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
  });

  it('counts every ticked box rather than every touched group', () => {
    expect(
      activeFilterCount({ ...EMPTY_FILTERS, entity: ['individual', 'university', 'teacher'] }),
    ).toBe(3);
  });

  it('counts turning rolling programmes OFF, because the default is on', () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, includeRolling: false })).toBe(1);
    expect(activeFilterCount({ ...EMPTY_FILTERS, includeRolling: true })).toBe(0);
  });

  it('does not count an empty search string as a filter', () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: '' })).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, q: 'arrl' })).toBe(1);
  });

  it('counts a non-default sort, which narrows nothing but does change what is on top', () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, sort: 'amount_desc' })).toBe(1);
  });
});
