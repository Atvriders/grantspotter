import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../store/useApi.js';
import { FilterPanel } from '../components/FilterPanel.js';
import { ExportMenu } from '../components/ExportMenu.js';
import {
  ProgramTable,
  PROGRAMME_TABLE_MIN_PX,
  type ProgramRow,
} from '../components/ProgramTable.js';
import { useNarrowerThan } from '../lib/narrowLayout.js';
import {
  EMPTY_FILTERS,
  FACETS,
  filtersToSearchParams,
  hidesRollingPrograms,
  searchParamsToFilters,
  type UiFilters,
} from '../lib/filterState.js';
import '../components/browse.css';

/** Mirrors `BrowseSummary` in `packages/server/src/api/browseTypes.ts`. Web never imports server. */
export interface BrowseSummary {
  total: number;
  eligible: number;
  preferred: number;
  ineligible: number;
  unknown: number;
  /** Constraint axes ranked by how many programs they exclude the user from. */
  ineligibleByAxis: Array<{ axis: string; count: number }>;
  /**
   * Profile fields ranked by how many `unknown` verdicts are WAITING ON them. The server ships
   * `{ field, count }` and nothing else — there is deliberately no `resolves`, because the matcher
   * short-circuits per axis and filling a field usually moves a verdict from one `unknown` to a
   * different one rather than answering it.
   */
  unknownByField: Array<{ field: string; count: number }>;
}

export interface BrowseResponse {
  rows: ProgramRow[];
  summary: BrowseSummary;
  page: number;
  pageSize: number;
  total: number;
  profileApplied: 'student' | 'organization' | null;
}

/**
 * THE POPULATION THE CENSUS COUNTS, AND WHY IT IS NOT ALWAYS THE LIST UNDERNEATH IT.
 *
 * `summary` is computed by the server BEFORE the verdict filter is applied — `programsRouter`
 * builds it from `found`, and only then cuts `visible` down to the verdicts asked for. That is the
 * right population for a census: the verdict filter is a VIEW of the match, not a change to what
 * was matched, and a breakdown of a set already restricted to one verdict says nothing at all
 * ("59 ineligible, 0 of everything else").
 *
 * WHAT WAS FALSE UNTIL 2026-08-13. This card printed `summary.total` as "N IN VIEW" whatever the
 * filters were, so `/?verdict=ineligible` — the destination of this card's OWN link — showed
 * "143 IN VIEW" above a pager reading "Page 2 of 2 · 59 programmes match", on the same screen,
 * with every visible row ineligible. Two numbers for one set, one of them wrong, on the state the
 * product routes the reader into.
 *
 * So the card now names both sets and never conflates them: the four counters and `matched`
 * describe the population the matcher ran over, `shown` is what the verdict filter left, and
 * `shown` is the pager's number by construction — it is `data.total`, the exact value `Pager` is
 * handed. The only way they can disagree again is if one of them stops coming from the response.
 */
function Census({
  summary,
  filters,
  shown,
}: {
  summary: BrowseSummary;
  filters: UiFilters;
  shown: number;
}): JSX.Element {
  const matched = summary.total;
  const verdictFiltered = filters.verdict.length > 0;
  const ineligibleHref = `/?${filtersToSearchParams({
    ...filters,
    verdict: ['ineligible'],
    page: 1,
  }).toString()}`;
  // No drill-down out of the drill-down: on a view that is already exactly the ineligible ones,
  // "see the specific constraint for each" points at the screen the reader is standing on.
  const alreadyIneligibleOnly = filters.verdict.length === 1 && filters.verdict[0] === 'ineligible';

  /** The set the four counters are about, named the same way in every sentence on this card. */
  const population = verdictFiltered ? 'that match your other filters' : 'in view';

  return (
    <section className="census card" aria-label="Eligibility summary">
      {/* The figure repeats the sentence beside it, so it is decoration to a screen reader. */}
      <span className="census-figure" aria-hidden="true">
        {summary.ineligible}
      </span>
      <span className="census-lede">
        You are ineligible for {summary.ineligible} of{' '}
        {verdictFiltered ? <>the {matched} {population}</> : <>these</>}
        {summary.ineligible > 0 && !alreadyIneligibleOnly && (
          <>
            {' — '}
            <Link to={ineligibleHref}>see the specific constraint for each</Link>
          </>
        )}
        .
      </span>
      <span className="eyebrow">
        {summary.eligible} eligible · {summary.preferred} preferred · {summary.ineligible}{' '}
        ineligible · {summary.unknown} unknown ·{' '}
        {verdictFiltered
          ? `${matched} matched, of which the verdict filter is showing ${shown}`
          : `${matched} in view`}
      </span>
      {/*
        WHOSE GAP IT IS, AND WHY THIS PARAGRAPH NO LONGER GUESSES.

        This read "It means something a program asks for could not be answered from your profile
        yet" until 2026-08-12. That sentence pins every `unknown` in the corpus on the reader, and
        `summary` is the one place on this screen that CANNOT know whether that is true: it is a
        count over the whole corpus, and the two kinds of unknown are not distinguished in it.

        Measured on the shipped corpus for a licensed EE undergraduate: 27 unknown, and 20 of them
        carry an EMPTY `missingProfileFields` — 19 records that never stated who may apply, plus
        one radius rule whose centre never resolved to a coordinate. For twenty of twenty-seven the
        missing thing is in GrantSpotter's own record, and there is no field the reader could fill
        in that would change it. Sending them to the profile editor asks them to close a hole in
        our data by typing something about themselves, which is the same misdirection as calling it
        a refusal, only quieter — `VerdictBadge`'s title was corrected for exactly this and this
        paragraph, one component above it on the same screen, was not.

        So the cause is named as the disjunction it actually is, and `VerdictBadge` and the
        opportunity page say which of the two any particular row is. `Browse.test.tsx` forbids the
        re-attribution rather than pinning the wording, so rewording this is free and blaming the
        reader again is not.
      */}
      {summary.unknown > 0 && (
        <span className="census-note">
          Unknown is not a &quot;no&quot;. It means something the matcher could not work out —
          either your profile has not answered it, or the record itself never stated it — so{' '}
          {summary.unknown} of the {matched} {population}{' '}
          {summary.unknown === 1 ? 'is' : 'are'} waiting on an answer rather than ruling you out.
          Open one to see which.
        </span>
      )}
    </section>
  );
}

/**
 * WHY THIS CONTROL CAN SAY "PAST THE END" AT ALL.
 *
 * `page` is whatever the URL asked for, and the URL is the shareable source of truth for this
 * screen (`lib/filterState.ts`). A link shared from page 3 of one reader's result set lands
 * somebody with a narrower profile — or a corpus one crawl older — on a page that no longer
 * exists. Until 2026-08-13 that state printed "Page 4 of 3 · 143 programmes match" over "No
 * opportunities match these filters.": a page number that cannot exist, above a claim that
 * nothing matched while the same line said 143 did.
 *
 * Nothing is clamped or redirected, because the reader asked for a specific page and being moved
 * silently is how a shared link stops meaning what it said. The state is named instead, and
 * Previous walks back to the last page that exists rather than to another empty one.
 */
function Pager({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (next: number) => void;
}): JSX.Element {
  const pastEnd = page > pageCount;
  return (
    <nav className="pager" aria-label="Pagination">
      <button
        type="button"
        className="btn"
        onClick={() => onPage(Math.min(page - 1, pageCount))}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        Previous
      </button>
      <span className="pager-status">
        {pastEnd ? (
          <>
            Page {page} is past the end · {total} programmes match, on {pageCount}{' '}
            {pageCount === 1 ? 'page' : 'pages'}
          </>
        ) : (
          <>
            Page {page} of {pageCount} · {total} programmes match
          </>
        )}
      </span>
      <button
        type="button"
        className="btn"
        onClick={() => onPage(page + 1)}
        disabled={page >= pageCount}
        aria-label="Next page"
      >
        Next
      </button>
    </nav>
  );
}

/**
 * The first viewport width at which the filter rail can stand BESIDE the results.
 *
 * MEASURED. The rail is 264 px with a `--s-5` (24 px) gutter, and the results column still has to
 * hold the programme table's 666 px min-content or the table starts scrolling sideways the moment
 * the rail appears — which is the state it shipped in, from 900 px up: at 900 the results column
 * was 644 px against a table that needs 666. That table plus `.table-wrap`'s two hairlines is
 * 668 px; 668 + 264 + 24, plus `AppShell`'s 208 px nav rail and 48 px of page padding, is 1212.
 * Below that the filters become a disclosure across the full width, which is also what hands the
 * table back the room it needs.
 */
export const FILTER_RAIL_MIN_PX = 1212;

/**
 * How many filters are currently narrowing the corpus.
 *
 * Every individual checkbox counts, not "3 of 7 groups are touched": a reader who has ticked four
 * applicant entities has made four decisions, and rolling them into one is how a filter set comes
 * to look smaller than it is. It exists so that CLOSING the filter sheet never hides the fact that
 * the list underneath is filtered — the summary states the count whether it is open or shut.
 */
export function activeFilterCount(f: UiFilters): number {
  let count = FACETS.reduce((sum, facet) => sum + f[facet.key].length, 0);
  if (f.deadlineFrom !== undefined) count += 1;
  if (f.deadlineTo !== undefined) count += 1;
  // "Keep rolling and undated programs" is on by default, so only turning it OFF is a filter.
  if (!f.includeRolling) count += 1;
  if (f.amountMin !== undefined) count += 1;
  if (f.amountMax !== undefined) count += 1;
  if (f.q !== undefined && f.q !== '') count += 1;
  if (f.sort !== EMPTY_FILTERS.sort) count += 1;
  return count;
}

/** `$1,500`, for a bound the reader typed as a bare number. */
function money(amount: number): string {
  return `$${amount.toLocaleString('en-US')}`;
}

/**
 * WHAT IS ACTUALLY NARROWING THIS VIEW, in words, so an empty result can name its own cause.
 *
 * The empty state used to prescribe two remedies from a fixed string — "Widen the deadline window
 * or clear a verdict filter" — regardless of what was set. Searching `zzzznotathing` with nothing
 * else on produced exactly that: the two things that could not help, and no mention of the search
 * box that had emptied the list. A remedy for a filter nobody set is worse than no remedy, because
 * the reader goes looking for a control that is already at its default.
 *
 * SORT IS DELIBERATELY ABSENT even though `activeFilterCount` counts it. A sort changes what is on
 * top, never what is in the set, so it can never be the reason nothing matched — and naming it here
 * would send the reader to the one control that cannot bring a row back.
 *
 * `includeRolling` is named only through `hidesRollingPrograms`: unticked with no deadline window
 * it narrows nothing, because the server only applies it inside one.
 */
export function narrowingFilters(f: UiFilters): string[] {
  const out: string[] = [];
  // The search first: it is the narrowest thing on this screen and the likeliest single cause.
  if (f.q !== undefined && f.q !== '') out.push(`the search “${f.q}”`);
  for (const facet of FACETS) {
    const values: readonly string[] = f[facet.key];
    if (values.length === 0) continue;
    const labels: Record<string, string> = facet.labels;
    out.push(`${facet.legend.toLowerCase()} — ${values.map((v) => labels[v] ?? v).join(', ')}`);
  }
  if (f.deadlineFrom !== undefined || f.deadlineTo !== undefined) {
    out.push(
      `a deadline window (${f.deadlineFrom ?? 'any date'} to ${f.deadlineTo ?? 'any date'})`,
    );
  }
  if (hidesRollingPrograms(f)) out.push('rolling and undated programmes excluded from that window');
  if (f.amountMin !== undefined) out.push(`a minimum award of ${money(f.amountMin)}`);
  if (f.amountMax !== undefined) out.push(`a maximum award of ${money(f.amountMax)}`);
  return out;
}

/**
 * The empty result, saying which of the two empties it is.
 *
 * It lives here rather than in `ProgramTable` because naming the cause needs the filters, and
 * `ProgramTable` is handed rows and nothing else. Its own empty state stays where it is for its
 * other callers; this route no longer reaches it.
 */
function EmptyResults({
  filters,
  page,
  pageCount,
  total,
  pastEnd,
  note,
  onPage,
}: {
  filters: UiFilters;
  page: number;
  pageCount: number;
  total: number;
  pastEnd: boolean;
  note?: ReactNode;
  onPage: (next: number) => void;
}): JSX.Element {
  const narrowing = narrowingFilters(filters);
  return (
    <div className="table-wrap">
      <div className="empty-state">
        {pastEnd ? (
          <>
            <p>
              There is no page {page}. {total} programmes match these filters, on {pageCount}{' '}
              {pageCount === 1 ? 'page' : 'pages'} — the link you followed points past the end of
              them.
            </p>
            <p>
              <button type="button" className="btn" onClick={() => onPage(pageCount)}>
                Go to page {pageCount}
              </button>
            </p>
          </>
        ) : narrowing.length === 0 ? (
          <p>
            No opportunities match. No filter is set, so this is the whole corpus as GrantSpotter
            holds it.
          </p>
        ) : (
          <p>
            No opportunities match these filters. What is narrowing this view:{' '}
            {narrowing.join('; ')}. Change or clear{' '}
            {narrowing.length === 1 ? 'it' : 'one of those'} to widen it.
          </p>
        )}
        {note !== undefined && <p className="empty-note">{note}</p>}
      </div>
    </div>
  );
}

export function Browse({ now }: { now?: string }): JSX.Element {
  const nowISO = now ?? new Date().toISOString();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const filtersInSheet = useNarrowerThan(FILTER_RAIL_MIN_PX);
  const stackedRows = useNarrowerThan(PROGRAMME_TABLE_MIN_PX);

  const filters = useMemo(() => searchParamsToFilters(searchParams), [searchParams]);
  const activeCount = useMemo(() => activeFilterCount(filters), [filters]);
  const query = useMemo(() => filtersToSearchParams(filters).toString(), [filters]);
  const { data, loading, error } = useApi<BrowseResponse>(
    `/api/programs${query === '' ? '' : `?${query}`}`,
  );

  /**
   * HOW MANY PROGRAMMES THE DEADLINE WINDOW IS ACTUALLY HIDING.
   *
   * The warning below used to name two funders — "NCDXF and SARA accept applications year-round"
   * — as if they were the set. Measured against the corpus this build serves, unticking the box
   * over a nine-month window moves the total by 28, of which those two are 2: the three YLRL
   * memorial scholarships, the Yasme Foundation and twenty-odd others were hidden and unnamed
   * while the sentence read like a complete list.
   *
   * A count cannot be written down, because it is a function of the window, every other filter and
   * the corpus installed. So it is MEASURED: the same query with the box ticked, whose `total` is
   * the same unpaginated figure as this one's. One extra request, only while the box is unticked
   * inside a window, and never on the default view.
   *
   * When either request is in flight the count is `null` and the sentence states no number rather
   * than a number belonging to the previous filters — `useApi` keeps the last body while the next
   * one loads, which is exactly how a stale figure would get printed as a fresh one.
   */
  const rollingIsHiding = hidesRollingPrograms(filters);
  const withRollingQuery = useMemo(
    () => filtersToSearchParams({ ...filters, includeRolling: true }).toString(),
    [filters],
  );
  const rollingProbe = useApi<BrowseResponse>(
    rollingIsHiding ? `/api/programs?${withRollingQuery}` : null,
  );
  const rollingHiddenCount = ((): number | null => {
    if (data === null || loading) return null;
    if (rollingProbe.data === null || rollingProbe.loading || rollingProbe.error !== null) {
      return null;
    }
    const difference = rollingProbe.data.total - data.total;
    // A negative difference cannot happen — ticking the box only ever adds records — so it means
    // the two answers describe different filters. Say nothing rather than say something backwards.
    return difference < 0 ? null : difference;
  })();

  function update(next: UiFilters, options?: { replace?: boolean }): void {
    setSearchParams(filtersToSearchParams(next), { replace: options?.replace === true });
  }

  const pageCount =
    data === null ? 1 : Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize)));

  /**
   * A page number beyond the last one that exists, on a result set that is not itself empty.
   *
   * `total === 0` is deliberately NOT this state: nothing matched, the page number is beside the
   * point, and telling a reader their page is past the end of nothing explains nothing.
   */
  const pastEnd = data !== null && data.total > 0 && data.page > pageCount;

  /**
   * Why nothing matched, when the reason is knowable. A verdict filter with no profile behind it
   * matches nothing SERVER-SIDE by design — there is no verdict to test — and an unexplained empty
   * table reads as "the corpus has none of these", which is a false claim about the corpus made in
   * place of a true one about the profile.
   */
  const emptyNote =
    data !== null && data.profileApplied === null && filters.verdict.length > 0 ? (
      <>
        No profile is set, so no verdict can match. Clear the verdict filter, or{' '}
        <Link to="/profile">set up a profile</Link> to be matched against these programmes.
      </>
    ) : undefined;

  return (
    <>
      <p className="eyebrow">Corpus</p>
      <h1 style={{ marginBottom: 'var(--s-5)' }}>Browse opportunities</h1>

      <div className={filtersInSheet ? 'browse browse-sheet' : 'browse'}>
        {/*
          A sidebar a phone cannot afford becomes a disclosure it can ignore.

          `<details>` and not a modal: a modal has to trap focus, restore it, and answer Escape,
          and every one of those is a thing to get wrong for an affordance whose entire job is
          "open the filters when you want them". Closed is the default here because a reader who
          arrived on a phone came to read the list, not to configure it — and the summary states
          how many filters are already on, so a closed sheet can never hide the fact that what is
          underneath has been narrowed.
        */}
        {filtersInSheet ? (
          <details className="filter-sheet card">
            <summary>
              <span className="filter-sheet-title">Filters</span>
              <span className="filter-sheet-count">
                {activeCount === 0 ? 'none set' : `${activeCount} set`}
                {/* The same sentence the pager uses, so the two can never disagree. */}
                {data !== null && ` · ${data.total} programmes match`}
              </span>
            </summary>
            <FilterPanel filters={filters} onChange={update} />
          </details>
        ) : (
          <FilterPanel filters={filters} onChange={update} />
        )}

        <div className={stackedRows ? 'browse-results browse-results-stacked' : 'browse-results'}>
          {rollingIsHiding && (
            <p className="row-warning" style={{ maxWidth: 'none' }}>
              {rollingHiddenCount === null
                ? 'Rolling and undated programs are hidden while a deadline window is set: a ' +
                  'programme that accepts applications year-round has no date to match against, ' +
                  'so it drops out of any window. Tick “Keep rolling and undated programs” to put ' +
                  'them back.'
                : rollingHiddenCount === 0
                  ? 'Rolling and undated programs are hidden while a deadline window is set, but ' +
                    'none of the programmes matching your other filters is one — so nothing is ' +
                    'missing from this list because of it.'
                  : `Rolling and undated programs are hidden while a deadline window is set: ` +
                    `${String(rollingHiddenCount)} ${
                      rollingHiddenCount === 1
                        ? 'programme that matches your other filters is'
                        : 'programmes that match your other filters are'
                    } not in this list. Tick “Keep rolling and undated programs” to put ${
                      rollingHiddenCount === 1 ? 'it' : 'them'
                    } back.`}
            </p>
          )}

          {data !== null && data.profileApplied === null && (
            <p className="row-warning" style={{ maxWidth: 'none' }}>
              No profile is set, so no eligibility verdicts are shown.{' '}
              <Link to="/profile">Set up a profile</Link> to see what you qualify for.
            </p>
          )}

          {data !== null && data.profileApplied !== null && (
            <Census summary={data.summary} filters={filters} shown={data.total} />
          )}

          <ExportMenu filters={filters} />

          {loading && <p className="eyebrow">Loading…</p>}
          {error !== null && (
            <p role="alert">
              Could not load opportunities ({error.code}
              {error.status === 0 ? ', the API could not be reached' : ''}).
            </p>
          )}

          {data !== null && (
            <>
              {data.rows.length === 0 ? (
                <EmptyResults
                  filters={filters}
                  page={data.page}
                  pageCount={pageCount}
                  total={data.total}
                  pastEnd={pastEnd}
                  note={emptyNote}
                  onPage={(next) => update({ ...filters, page: next })}
                />
              ) : (
                <ProgramTable
                  rows={data.rows}
                  now={nowISO}
                  expandedId={expandedId}
                  onExplain={(id) => setExpandedId((current) => (current === id ? null : id))}
                />
              )}
              {/* Shown past the end even when there is only one page, because "there is no page 4"
                  needs the control that walks back to a page there is. */}
              {(pageCount > 1 || pastEnd) && (
                <Pager
                  page={data.page}
                  pageCount={pageCount}
                  total={data.total}
                  onPage={(next) => update({ ...filters, page: next })}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
