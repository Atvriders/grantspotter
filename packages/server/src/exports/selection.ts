/**
 * WHAT AN EXPORT IS AN EXPORT OF — decided by the same query, the same table and the same code
 * that decided what the screen was showing.
 *
 * THE DEFECT THIS FILE EXISTS TO CLOSE (measured on grant.waterburp.com, 2026-08-13). Beside the
 * export buttons on Browse the product promised "exports exactly what the filters above are
 * showing". Three different filters broke that promise three different ways, under one sentence:
 *
 *   1. `?klass=ham_grant` — screen 8 programmes, `.ics` 252 VEVENTs over 121 programmes,
 *      byte-identical (but for DTSTAMP/LAST-MODIFIED) to the unfiltered feed. The calendar routes
 *      never read the query string at all.
 *   2. From 2026-09-01 / To 2026-12-31 with "Keep rolling and undated programs" CHECKED, which is
 *      the DEFAULT — screen 139, CSV 117. The checkbox had no spelling in the export vocabulary,
 *      so the export dropped exactly the 22 rolling and undated programmes the checkbox promised
 *      to keep, in the state a user reaches without touching anything.
 *   3. Award amount Min = 5000 — screen 17, CSV 143, the whole corpus, and the export links were
 *      the bare unfiltered URLs. `amountMin`, `amountMax` and `verdict` had no export spelling
 *      either, and the translator dropped them silently.
 *
 * Three causes, one promise: the wiring between the screen's filter state and the export was not
 * one thing. It was a SECOND filter vocabulary (`ExportFilter`: `closesAfter`, `closesBefore`,
 * `applicantEntities`, `tags`) with a SECOND parser and a SECOND in-memory predicate set, and a
 * hand-written translator between the two. Every filter the browse screen grew after that
 * translator was written had to be added to it by hand, and three in a row were not.
 *
 * So there is no second vocabulary now. The export routes take the browse query string verbatim —
 * the very params `filtersToSearchParams` put in the address bar and sent to `GET /api/programs` —
 * parse it with `parseBrowseQuery`, THE browse parser, and select rows with `queryProgramIds`, THE
 * browse selection, over `program_search`, THE table the screen's own count is counted from.
 * A filter cannot exist on screen and not reach the export, because there is nothing between them
 * to forget: adding a filter to `BrowseFilters` changes both surfaces or neither.
 *
 * WHY THE PROJECTION AND NOT AN IN-MEMORY RE-IMPLEMENTATION. The obvious cheaper fix — add
 * `includeRolling`, `amountMin`, `amountMax` and `verdict` to the in-memory `applyExportFilter` —
 * is the fix that leaves a fourth to be forgotten, and it cannot be made exact even for the three:
 *
 *   - `q` searches `program_search.haystack`, which is name + FUNDER NAME + summary + tags +
 *     `amountRaw` + `rawOtherText`. The in-memory predicate searched name, summary, id and tags.
 *     A user searching a funder's name saw rows on screen that the export did not contain.
 *   - the deadline window matches `next_closes_at` — the ONE soonest un-closed cycle across both
 *     of core's channels, computed by `reindexBrowse` at reindex time. The in-memory predicate
 *     matched ANY cycle in a two-year window. Different question, different answer.
 *   - and `next_closes_at` is a stored projection, so it can be older than `now()`. The screen
 *     shows what the projection says. An export computing a fresher answer disagrees with the
 *     screen it claims to be exporting — while being, in isolation, the more up-to-date of the two.
 *
 * `parityWithBrowse.test.ts` measures the resulting equality on the real corpus rather than
 * assuming it, for every filter key `BrowseFilters` has, and fails on a key it does not know.
 */
import type { Profile, Program, Verdict } from '@grantspotter/core';
import { matchAll } from '@grantspotter/core';
import type { Database } from 'better-sqlite3';
import type { BrowseFilters } from '../api/browseTypes.js';
import { hydratePrograms, queryProgramIds } from '../api/browseQuery.js';
import { parseBrowseQuery } from '../api/programsRouter.js';
import { exportablePrograms } from './filter.js';

/**
 * SQLite's own "no limit" for LIMIT, and the same constant `programsRouter` pages the browse
 * census with. An export is every match, never one page: `page` is a property of the screen, and
 * "page 1 of 3" in a file nobody can turn the page of is 89 rows of a 139-row answer.
 */
const UNPAGINATED = -1;

/**
 * The export vocabulary IS the browse vocabulary. This adds exactly one thing to
 * `parseBrowseQuery`: the retired `ExportFilter` spellings, mapped onto the browse keys they
 * always meant.
 *
 * They are kept because an export URL is a thing people bookmark, paste into a scheduler and mail
 * to a colleague, and every such URL in existence was minted by the build that shipped the defect
 * above. Dropping the spellings would not fail those URLs — it would WIDEN them, silently, to the
 * whole corpus, which is the same harm this file is closing and is the direction nobody notices.
 * A legacy key never overrides a browse key that is also present; `tags` has no browse spelling
 * (the screen has no tag filter) and is dropped, which narrows nothing and cannot widen anything,
 * because the suppression gate is not a filter option — see `exportablePrograms`.
 *
 * `includeRolling` is deliberately NOT defaulted differently for legacy links. An old
 * `?closesAfter=…&closesBefore=…` link exported 117 of the 139 rows its screen was showing; read
 * as a browse query it now exports 139. That is a widening, and it is the right one: 139 is what
 * the screen the user was looking at said, and the 22 rolling programmes are the ones a deadline
 * window most obviously should not silently delete.
 */
export function parseExportQuery(query: Record<string, unknown>): BrowseFilters {
  const merged: Record<string, unknown> = { ...query };
  const alias = (legacy: string, browse: string): void => {
    if (merged[browse] === undefined && merged[legacy] !== undefined) {
      merged[browse] = merged[legacy];
    }
  };
  alias('closesAfter', 'deadlineFrom');
  alias('closesBefore', 'deadlineTo');
  alias('applicantEntities', 'entity');
  return parseBrowseQuery(merged);
}

export interface ExportSelectionContext {
  /** The signed-in reader's active profile, or undefined. Only the verdict filter reads it. */
  profile: Profile | undefined;
  /** The injected clock. Several eligibility axes are answered relative to it. */
  nowISO: string;
}

/**
 * THE ROWS THE SCREEN WAS SHOWING, unpaginated, in the screen's own order.
 *
 * Steps 1 and 2 are `programsRouter`'s steps 1 and 3 against the same table with the same
 * arguments, which is what makes the two counts equal rather than merely close. The order is the
 * `sort` the user chose, because `queryProgramIds` orders by it — a CSV whose rows arrive in a
 * different order from the screen is a smaller lie than a CSV with the wrong rows in it, but it is
 * still one, and here it costs nothing to not tell.
 *
 * THE GATE RUNS AGAIN HERE even though `reindexBrowse` already refuses to project a
 * `do_not_publish` record. `program_search` is a CACHE: a record reclassified after the last
 * reindex has a stale projection row, and this read path is the one that leaves the building.
 * `exportablePrograms` is idempotent, so the belt is free, and `parityWithBrowse.test.ts` plants
 * exactly that stale row to prove the belt is load-bearing rather than decorative.
 */
export function selectExportPrograms(
  db: Database,
  filters: BrowseFilters,
  context: ExportSelectionContext,
): Program[] {
  const { ids } = queryProgramIds(db, { ...filters, page: 1, pageSize: UNPAGINATED });
  const hydrated = hydratePrograms(db, ids);
  const found = ids
    .map((id) => hydrated.get(id)?.program)
    .filter((program): program is Program => program !== undefined);
  return applyVerdictFilter(exportablePrograms(found), filters, context);
}

/**
 * The matcher verdict is a filter like any other on screen, and it is the one that costs money to
 * get wrong: a student who narrows to "Eligible" and exports is exporting the shortlist they will
 * pay application fees against. So the export runs the matcher — the same `matchAll` the browse
 * route runs, over the same programmes, on the same injected clock — rather than declaring the
 * verdict too expensive to honour and shipping the unfiltered corpus under a filtered heading.
 *
 * It is per-user by construction (verdicts are computed against a profile, not stored on a
 * record), which is why these responses are already `Cache-Control: no-store` and why the
 * subscribable feed answers for the token's OWNER. It costs one `matchAll` over ~150 records, in
 * process, which the eligibility report on the same router already pays.
 *
 * NO PROFILE PLUS A VERDICT FILTER IS AN EMPTY EXPORT, never the whole corpus. `programsRouter`
 * makes the same choice in the same words and for the reason that decides it here too: there is no
 * verdict to test, and answering "all of them" would attach a claim about eligibility to a list
 * nobody was matched against — in a file, which is the copy that outlives the session that
 * explained it.
 */
function applyVerdictFilter(
  programs: Program[],
  filters: BrowseFilters,
  { profile, nowISO }: ExportSelectionContext,
): Program[] {
  if (filters.verdict.length === 0) return programs;
  if (profile === undefined) return [];
  const verdicts: Map<string, Verdict> = matchAll(profile, programs, nowISO);
  return programs.filter((program) => {
    const verdict = verdicts.get(program.id);
    return verdict !== undefined && filters.verdict.includes(verdict.kind);
  });
}
