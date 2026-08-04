import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../store/useApi.js';
import { FilterPanel } from '../components/FilterPanel.js';
import { ExportMenu } from '../components/ExportMenu.js';
import { ProgramTable, type ProgramRow } from '../components/ProgramTable.js';
import {
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
      {summary.unknown > 0 && (
        <span className="census-note">
          Unknown is not a &quot;no&quot;. It means something a program asks for could not be
          answered from your profile yet — {summary.unknown} of the {summary.total} in view are
          waiting on an answer rather than ruling you out.
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

export function Browse({ now }: { now?: string }): JSX.Element {
  const nowISO = now ?? new Date().toISOString();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filters = useMemo(() => searchParamsToFilters(searchParams), [searchParams]);
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

      <div className="browse">
        <FilterPanel filters={filters} onChange={update} />

        <div>
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
