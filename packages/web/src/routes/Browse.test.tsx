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

  /**
   * THE WARNING NAMED TWO FUNDERS AND HID TWENTY-TWO PROGRAMMES.
   *
   * It read "NCDXF and SARA accept applications year-round and have no date to match against."
   * Measured on the live site 2026-08-13, unticking the box moved the total by 22, of which those
   * two were 2 — the three YLRL memorial scholarships, the Yasme Foundation and the rest were
   * hidden and unnamed while the sentence read like a complete list. Measured again locally on the
   * corpus this build serves, over 2026-09-01 to 2027-06-01: 148 with the box ticked, 120 without.
   *
   * The count cannot be a constant — it is a function of the window, the other filters and the
   * corpus — so the route measures it, and these assert it is MEASURED rather than asserting the
   * figure.
   */
  describe('the rolling-programs warning', () => {
    function stubTwo(inWindow: number, withRolling: number) {
      const fetchMock = vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            makeResponse({
              rows: [ARRL_GRANTS_ROW],
              total: String(url).includes('includeRolling=false') ? inWindow : withRolling,
            }),
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('names no funder as if it were the whole hidden set', async () => {
      stubTwo(120, 148);
      renderBrowse('/?deadlineFrom=2026-09-01&deadlineTo=2027-06-01&includeRolling=false');
      const warning = await screen.findByText(/rolling and undated programs are hidden/i);
      await waitFor(() => {
        expect((warning.textContent ?? '').replace(/\s+/g, ' ')).toBe(
          'Rolling and undated programs are hidden while a deadline window is set: ' +
            '28 programmes that match your other filters are not in this list. ' +
            'Tick “Keep rolling and undated programs” to put them back.',
        );
      });
      expect(warning.textContent ?? '', 'the warning still names an example as the set').not.toMatch(
        /NCDXF|SARA|Yasme|YLRL/,
      );
    });

    it('says one programme in the singular', async () => {
      stubTwo(120, 121);
      renderBrowse('/?deadlineFrom=2026-09-01&includeRolling=false');
      const warning = await screen.findByText(/rolling and undated programs are hidden/i);
      await waitFor(() => {
        expect(warning.textContent ?? '').toMatch(/1 programme that matches your other filters is/);
      });
    });

    it('states no count when the window is hiding nothing, rather than a bare zero', async () => {
      stubTwo(120, 120);
      renderBrowse('/?deadlineFrom=2026-09-01&includeRolling=false');
      const warning = await screen.findByText(/rolling and undated programs are hidden/i);
      await waitFor(() => {
        expect(warning.textContent ?? '').toMatch(/nothing is missing from this list/i);
      });
    });

    it('asks for the same query with rolling programmes kept, and only then', async () => {
      const fetchMock = stubTwo(120, 148);
      renderBrowse('/?klass=ham_grant&deadlineFrom=2026-09-01&includeRolling=false');
      await waitFor(() => {
        const probe = requestedUrls(fetchMock).filter((u) => !u.includes('includeRolling=false'));
        expect(probe.length).toBeGreaterThan(0);
        // The probe differs from the view in exactly one filter, or the difference it measures is
        // not the one the sentence names.
        expect(probe[0]).toContain('klass=ham_grant');
        expect(probe[0]).toContain('deadlineFrom=2026-09-01');
      });
    });

    it('asks for nothing extra on a view where the box is not hiding anything', async () => {
      const fetchMock = stubFetch();
      renderBrowse('/?deadlineFrom=2026-09-01');
      await screen.findByRole('table', { name: /opportunities/i });
      expect(requestedUrls(fetchMock)).toHaveLength(1);
    });
  });

  it('tells the user when no profile is applied instead of showing silent nulls', async () => {
    stubFetch(makeResponse({ ...RESPONSE, profileApplied: null }));
    renderBrowse();
    const link = await screen.findByRole('link', { name: /set up a profile/i });
    // The whole sentence, because "no verdicts are shown" without the reason reads as a claim
    // about the corpus rather than about the reader's profile.
    expect((link.parentElement?.textContent ?? '').replace(/\s+/g, ' ')).toBe(
      'No profile is set, so no eligibility verdicts are shown. Set up a profile to see what you qualify for.',
    );
  });

  /**
   * The one state where "nothing here" is not a claim about the corpus at all.
   *
   * Asserted with a pattern rather than the literal string on purpose: the copy contract's
   * assertion corpus is repository-wide, and quoting this particular word verbatim would mark
   * every other component's identical loading line as covered by a test that never rendered it.
   */
  it('says it is loading rather than showing an empty screen while it waits', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
    renderBrowse();
    expect(screen.getByText(/^Loading/)).toBeInTheDocument();
    expect(screen.queryByText(/no opportunities match/i)).not.toBeInTheDocument();
  });

  it('does not render the verdict census when nobody has been matched', async () => {
    stubFetch(makeResponse({ ...RESPONSE, profileApplied: null }));
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.queryByText(/you are ineligible for/i)).not.toBeInTheDocument();
  });

  /**
   * AN EMPTY RESULT WITH NO FILTERS ON IT MAY NOT SAY "THESE FILTERS".
   *
   * The empty state used to open with "No opportunities match these filters." unconditionally, on
   * a screen where the filter rail is untouched. There are no filters in that state, so the one
   * sentence explaining the emptiness pointed at controls that are all at their defaults.
   */
  it('shows an empty state rather than a bare table, and names no filter when none is set', async () => {
    stubFetch(
      makeResponse({
        rows: [],
        summary: { ...RESPONSE.summary, total: 0, eligible: 0, ineligible: 0 },
        total: 0,
      }),
    );
    renderBrowse();
    expect(await screen.findByText(/no opportunities match/i)).toBeInTheDocument();
    expect(screen.getByText(/no filter is set/i)).toBeInTheDocument();
    expect(screen.queryByText(/these filters/i)).not.toBeInTheDocument();
  });
});

/**
 * THE EMPTY STATE HAS TO NAME WHAT IS ACTUALLY NARROWING THE VIEW.
 *
 * Reproduced on the live site 2026-08-13: `/?q=zzzznotathing`, the search box the only thing set,
 * printed "No opportunities match these filters. Widen the deadline window or clear a verdict
 * filter." — the two controls that could not have caused it, and no mention of the one that did.
 * A reader who follows that instruction finds a deadline window that is empty and a verdict filter
 * with nothing ticked, and concludes the corpus has nothing rather than that they mistyped.
 *
 * The remedies are asserted as a PROHIBITION on naming an unset control, plus a requirement to
 * name the set one, so the wording stays free to change and the defect cannot come back.
 */
describe('Browse empty state', () => {
  const EMPTY = makeResponse({
    rows: [],
    summary: { ...RESPONSE.summary, total: 0, eligible: 0, preferred: 0, ineligible: 0, unknown: 0 },
    total: 0,
  });

  it('names the search term that emptied the list, and prescribes nothing else', async () => {
    stubFetch(EMPTY);
    renderBrowse('/?q=zzzznotathing');
    const empty = await screen.findByText(/no opportunities match these filters/i);
    const text = empty.textContent ?? '';
    expect(text.replace(/\s+/g, ' ')).toBe(
      'No opportunities match these filters. What is narrowing this view: ' +
        'the search “zzzznotathing”. Change or clear it to widen it.',
    );
    expect(text, 'the empty state prescribes a deadline window nobody set').not.toMatch(
      /deadline window/i,
    );
    expect(text, 'the empty state prescribes a verdict filter nobody set').not.toMatch(
      /verdict/i,
    );
  });

  it('names a facet, a window and both amount bounds when those are what is set', async () => {
    stubFetch(EMPTY);
    renderBrowse('/?klass=ham_grant&deadlineFrom=2026-09-01&amountMin=5000&amountMax=9000');
    const empty = await screen.findByText(/no opportunities match these filters/i);
    const text = (empty.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toMatch(/opportunity class — Ham grant/i);
    // An open-ended window says so on the end that is open, rather than printing "undefined".
    expect(text).toContain('a deadline window (2026-09-01 to any date)');
    expect(text).toContain('a minimum award of $5,000');
    expect(text).toContain('a maximum award of $9,000');
  });

  it('names the excluded rolling programmes as their own reason, not as the window', async () => {
    stubFetch(EMPTY);
    renderBrowse('/?deadlineTo=2027-06-01&includeRolling=false');
    const empty = await screen.findByText(/no opportunities match these filters/i);
    const text = (empty.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('a deadline window (any date to 2027-06-01)');
    expect(text).toContain('rolling and undated programmes excluded from that window');
  });

  /** A sort reorders; it can never be why nothing matched, so it is never offered as a remedy. */
  it('does not offer the sort as something to change', async () => {
    stubFetch(EMPTY);
    renderBrowse('/?q=zzzznotathing&sort=name');
    const empty = await screen.findByText(/no opportunities match these filters/i);
    expect(empty.textContent ?? '').not.toMatch(/sort/i);
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

  /**
   * THE CENSUS NOTE MUST NOT SEND THE READER TO THE PROFILE EDITOR TO CLOSE A HOLE IN OUR DATA.
   *
   * Until 2026-08-12 this paragraph read "It means something a program asks for could not be
   * answered from your profile yet". That sentence attributes every `unknown` in the corpus to a
   * gap in the READER, and it stopped being true the moment `matcher.ts` learned that a record
   * stating nothing about who may apply is a question rather than a refusal.
   *
   * MEASURED against the built server on the shipped corpus for the flagship profile
   * (`e2e/api.spec.ts`, "unknown is a real state", which names all twenty by programme):
   * 27 unknown, of which 20 carry an EMPTY `missingProfileFields` — 19 records whose applicant
   * list nobody ever filled in, plus the Yankee Clipper radius whose centre never resolved to a
   * coordinate. For 20 of 27 the missing thing is in GRANTSPOTTER'S record and there is no field
   * the reader could fill in that would change it. Before the entity fix it was 1 of 8, which is
   * how a mostly-true sentence became a mostly-false one without any test noticing.
   *
   * This is the same defect the same commit fixed in `VerdictBadge` — whose title said "could not
   * be evaluated from your profile" — one component up, on the summary card at the top of the same
   * screen. `a11y.test.tsx` already asserted this paragraph EXISTS; nothing asserted it was true.
   *
   * The rule is stated as a prohibition rather than as a golden string so that rewording is free
   * and re-attributing the gap to the reader is not.
   */
  it('never blames the reader’s profile for the corpus-wide unknown count', async () => {
    stubFetch(
      makeResponse({
        rows: [ARRL_GRANTS_ROW],
        summary: {
          total: 150,
          eligible: 55,
          preferred: 13,
          ineligible: 55,
          unknown: 27,
          ineligibleByAxis: [{ axis: 'geography', count: 36 }],
          unknownByField: [{ field: 'gpa', count: 7 }],
        },
        total: 150,
        profileApplied: 'student',
      }),
    );
    renderBrowse();
    const note = await screen.findByText(/waiting on an answer rather than ruling you out/i);
    const text = note.textContent ?? '';

    // The gap may not be pinned on the profile. The corpus-wide figure covers both kinds of
    // unknown and the summary has no way to tell the reader which of the two any given row is.
    expect(text, 'the census note blames the reader’s profile for every unknown').not.toMatch(
      /(?:answered|evaluated|worked out|settled)\s+from your profile\b(?![^.]*\brecord\b)/i,
    );
    // ...and it must still say the number and refuse to read as a refusal.
    expect(text).toMatch(/27 of the 150/);
    expect(text).toMatch(/not a .no./i);
    // The other cause has to be named, or the reader has no way to know it exists.
    expect(text, 'the census note never mentions the other cause').toMatch(
      /record|programme|program/i,
    );
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

  it('says "is waiting" when exactly one record is unknown', async () => {
    stubFetch(
      makeResponse({
        rows: [ARRL_GRANTS_ROW],
        summary: {
          total: 8,
          eligible: 4,
          preferred: 0,
          ineligible: 3,
          unknown: 1,
          ineligibleByAxis: [],
          unknownByField: [],
        },
        total: 8,
      }),
    );
    renderBrowse('/?klass=ham_grant');
    const note = await screen.findByText(/waiting on an answer rather than ruling you out/i);
    expect(note.textContent ?? '').toMatch(/1 of the 8 in view is waiting/);
  });
});

/**
 * THE CENSUS AND THE PAGER DESCRIBE SETS THAT ARE NAMED, AND THE NUMBER THEY SHARE AGREES.
 *
 * Reproduced on the live site 2026-08-13, on the state the census's OWN link routes into:
 * `/?verdict=ineligible` showed "39 ELIGIBLE · 4 PREFERRED · 41 UNKNOWN · 143 IN VIEW" above a
 * pager reading "Page 2 of 2 · 59 programmes match", every visible row ineligible.
 *
 * The server computes `summary` over the match BEFORE the verdict filter and `total` after it
 * (`programsRouter.ts`), which is the right split — a breakdown of a set already narrowed to one
 * verdict says nothing. What was wrong was the words: `summary.total` was printed as "in view"
 * when the view was something else. These assert the two figures against `data.total`, which is
 * the pager's own input, under every verdict filter.
 */
describe('Browse census and pager describe the same set', () => {
  const MATCHED = 143;
  const SUMMARY = {
    total: MATCHED,
    eligible: 39,
    preferred: 4,
    ineligible: 59,
    unknown: 41,
    ineligibleByAxis: [{ axis: 'geography', count: 20 }],
    unknownByField: [{ field: 'gpa', count: 7 }],
  };

  function filtered(shown: number) {
    return makeResponse({
      rows: [ARRL_GRANTS_ROW],
      summary: SUMMARY,
      page: 1,
      pageSize: 50,
      total: shown,
      profileApplied: 'student',
    });
  }

  it.each([
    ['ineligible', 59],
    ['eligible', 39],
    ['eligible_preferred', 4],
    ['unknown', 41],
  ])('never calls the wider match "in view" under verdict=%s', async (verdict, shown) => {
    stubFetch(filtered(shown));
    renderBrowse(`/?verdict=${verdict}`);
    const census = await screen.findByRole('region', { name: /eligibility summary/i });
    const text = (census.textContent ?? '').replace(/\s+/g, ' ');

    // The one claim that was false: the pre-filter population announced as what is on screen.
    expect(text, 'the census calls the pre-filter population "in view"').not.toMatch(
      new RegExp(`${String(MATCHED)} in view`),
    );
    // Both sets are named, and the second number is the pager's own.
    expect(text).toContain(`${String(MATCHED)} matched`);
    expect(text).toContain(`showing ${String(shown)}`);
  });

  it('reads out every counter, and they sum to the population', async () => {
    stubFetch(filtered(59));
    renderBrowse('/?verdict=ineligible');
    const census = await screen.findByRole('region', { name: /eligibility summary/i });
    const text = (census.textContent ?? '').replace(/\s+/g, ' ');
    // Every counter is on screen — the ineligible one was missing from this line until
    // 2026-08-13, which is what made the four numbers un-addable by the reader.
    for (const [label, n] of [
      ['eligible', SUMMARY.eligible],
      ['preferred', SUMMARY.preferred],
      ['ineligible', SUMMARY.ineligible],
      ['unknown', SUMMARY.unknown],
    ] as const) {
      expect(text).toContain(`${String(n)} ${label}`);
    }
    expect(text).toContain('matched, of which the verdict filter is showing 59');
    // They add up to the population, which is the arithmetic the card is inviting.
    expect(SUMMARY.eligible + SUMMARY.preferred + SUMMARY.ineligible + SUMMARY.unknown).toBe(
      MATCHED,
    );
  });

  it('states the pager total and the census total as the same number for the same set', async () => {
    stubFetch({ ...filtered(59), page: 2, total: 59 });
    renderBrowse('/?verdict=ineligible&page=2');
    const pager = await screen.findByRole('navigation', { name: /pagination/i });
    const census = screen.getByRole('region', { name: /eligibility summary/i });
    expect(pager.textContent ?? '').toContain('59 programmes match');
    expect((census.textContent ?? '').replace(/\s+/g, ' ')).toContain('showing 59');
  });

  it('does not offer a drill-down into the view the reader is already on', async () => {
    stubFetch(filtered(59));
    renderBrowse('/?verdict=ineligible');
    await screen.findByRole('region', { name: /eligibility summary/i });
    expect(
      screen.queryByRole('link', { name: /see the specific constraint for each/i }),
    ).not.toBeInTheDocument();
  });

  it('still says "in view" when no verdict filter narrows the match', async () => {
    stubFetch(filtered(MATCHED));
    renderBrowse();
    const census = await screen.findByRole('region', { name: /eligibility summary/i });
    expect((census.textContent ?? '').replace(/\s+/g, ' ')).toContain(`${String(MATCHED)} in view`);
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

  /**
   * "PAGE 4 OF 3", AND THE SECOND FALSE SENTENCE STANDING UNDER IT.
   *
   * Reproduced on the live site 2026-08-13: `/?page=4` printed "No opportunities match these
   * filters." directly above "Page 4 of 3 · 143 programmes match". Nothing matched AND 143
   * matched, on one screen, and a page number that cannot exist above both. `lib/filterState.ts`
   * documents the URL as the shareable source of truth for this screen, so a link shared from page
   * 3 of a wider result set lands a reader here.
   */
  describe('a page past the end of the result set', () => {
    const PAST_END = { ...PAGED, page: 4 as const, rows: [] };

    it('does not claim nothing matched when 150 did', async () => {
      stubFetch(PAST_END);
      renderBrowse('/?page=4');
      await screen.findByRole('navigation', { name: /pagination/i });
      expect(screen.queryByText(/no opportunities match/i)).not.toBeInTheDocument();
      expect(screen.getByText(/there is no page 4/i)).toBeInTheDocument();
    });

    it('does not print a page number past the last one as if it existed', async () => {
      stubFetch(PAST_END);
      renderBrowse('/?page=4');
      const pager = await screen.findByRole('navigation', { name: /pagination/i });
      const status = (pager.textContent ?? '').replace(/\s+/g, ' ');
      expect(status, 'the pager states a page count it has just contradicted').not.toMatch(
        /page 4 of 3/i,
      );
      expect(status).toContain('Page 4 is past the end · 150 programmes match, on 3 pages');
    });

    it('offers the last page that exists, and asks the API for it', async () => {
      const fetchMock = stubFetch(PAST_END);
      renderBrowse('/?page=4');
      await userEvent.click(await screen.findByRole('button', { name: /go to page 3/i }));
      await waitFor(() => {
        expect(requestedUrls(fetchMock).some((u) => u.includes('page=3'))).toBe(true);
      });
    });

    it('walks Previous back to the last page that exists, not to another empty one', async () => {
      const fetchMock = stubFetch({ ...PAGED, page: 9 as const, rows: [] });
      renderBrowse('/?page=9');
      await userEvent.click(await screen.findByRole('button', { name: /previous page/i }));
      await waitFor(() => {
        expect(requestedUrls(fetchMock).some((u) => u.includes('page=3'))).toBe(true);
      });
      expect(requestedUrls(fetchMock).some((u) => u.includes('page=8'))).toBe(false);
    });

    /** An empty result set has no "end" to be past, and its page number explains nothing. */
    it('reads an empty result as empty rather than as a page past the end', async () => {
      stubFetch(
        makeResponse({
          rows: [],
          summary: { ...RESPONSE.summary, total: 0, eligible: 0, ineligible: 0 },
          total: 0,
          page: 4,
        }),
      );
      renderBrowse('/?q=zzzznotathing&page=4');
      expect(await screen.findByText(/no opportunities match these filters/i)).toBeInTheDocument();
      expect(screen.queryByText(/past the end/i)).not.toBeInTheDocument();
    });
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
    const note = await screen.findByText(/no profile is set, so no verdict can match/i);
    expect((note.textContent ?? '').replace(/\s+/g, ' ')).toBe(
      'No profile is set, so no verdict can match. Clear the verdict filter, or set up a profile to be matched against these programmes.',
    );
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
