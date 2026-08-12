import { useMemo, useState } from 'react';
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

function Census({ summary, filters }: { summary: BrowseSummary; filters: UiFilters }): JSX.Element {
  const ineligibleHref = `/?${filtersToSearchParams({
    ...filters,
    verdict: ['ineligible'],
    page: 1,
  }).toString()}`;

  return (
    <section className="census card" aria-label="Eligibility summary">
      {/* The figure repeats the sentence beside it, so it is decoration to a screen reader. */}
      <span className="census-figure" aria-hidden="true">
        {summary.ineligible}
      </span>
      <span className="census-lede">
        You are ineligible for {summary.ineligible} of these
        {summary.ineligible > 0 && (
          <>
            {' — '}
            <Link to={ineligibleHref}>see the specific constraint for each</Link>
          </>
        )}
        .
      </span>
      <span className="eyebrow">
        {summary.eligible} eligible · {summary.preferred} preferred · {summary.unknown} unknown ·{' '}
        {summary.total} in view
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
          {summary.unknown} of the {summary.total} in view are waiting on an answer rather than
          ruling you out. Open one to see which.
        </span>
      )}
    </section>
  );
}

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
  return (
    <nav className="pager" aria-label="Pagination">
      <button
        type="button"
        className="btn"
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        Previous
      </button>
      <span className="pager-status">
        Page {page} of {pageCount} · {total} programmes match
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

  function update(next: UiFilters, options?: { replace?: boolean }): void {
    setSearchParams(filtersToSearchParams(next), { replace: options?.replace === true });
  }

  const pageCount =
    data === null ? 1 : Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize)));

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
          {hidesRollingPrograms(filters) && (
            <p className="row-warning" style={{ maxWidth: 'none' }}>
              Rolling and undated programs are hidden while a deadline window is set. NCDXF and SARA
              accept applications year-round and have no date to match against.
            </p>
          )}

          {data !== null && data.profileApplied === null && (
            <p className="row-warning" style={{ maxWidth: 'none' }}>
              No profile is set, so no eligibility verdicts are shown.{' '}
              <Link to="/profile">Set up a profile</Link> to see what you qualify for.
            </p>
          )}

          {data !== null && data.profileApplied !== null && (
            <Census summary={data.summary} filters={filters} />
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
              <ProgramTable
                rows={data.rows}
                now={nowISO}
                expandedId={expandedId}
                emptyNote={emptyNote}
                onExplain={(id) => setExpandedId((current) => (current === id ? null : id))}
              />
              {pageCount > 1 && (
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
