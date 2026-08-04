import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Browse } from './Browse.js';
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
