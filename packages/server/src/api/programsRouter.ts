import { Router } from 'express';
import type { Constraint, Profile, Verdict } from '@grantspotter/core';
import {
  applicantEntitySchema,
  instrumentSchema,
  matchAll,
  opportunityClassSchema,
  programStatusSchema,
} from '@grantspotter/core';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { hydratePrograms, queryProgramIds, type HydratedProgram } from './browseQuery.js';
import { isProfileKind, loadActiveProfile, type ProfileKind } from './profileStore.js';
import {
  DEFAULT_FILTERS,
  type BrowseFilters,
  type BrowseResponse,
  type BrowseRow,
  type BrowseSort,
  type BrowseSummary,
  type VerdictKind,
} from './browseTypes.js';

/**
 * DEVIATION FROM THE TASK BRIEF (2026-08-03), and why.
 *
 * The brief restates the four faceted enums as literal string arrays in this
 * file. Every one of them is already a zod enum exported from `@grantspotter/core`
 * — the same schemas `programSchema` validates records with — so restating them
 * makes a value added to CONTRACT §3 silently unfilterable: `multi()` drops
 * anything not on the local list, so the new facet would exist in the corpus,
 * appear in the projection, and answer "no results" forever, with no test able
 * to notice because the local array would still agree with itself. Reading
 * `.options` off the schema removes the second copy entirely. All four lists
 * were compared against the schemas before this change: they agreed today, which
 * is exactly why the drift would have been invisible tomorrow.
 *
 * `VERDICTS` and `SORTS` have no core schema — both are Plan-3-local unions in
 * `browseTypes.ts` — so they are keyed `Record<Union, true>` instead, which
 * fails to compile if the union gains a member.
 */
const KLASSES = opportunityClassSchema.options;
const ENTITIES = applicantEntitySchema.options;
const INSTRUMENTS = instrumentSchema.options;
const STATUSES = programStatusSchema.options;

const VERDICTS: Record<VerdictKind, true> = {
  eligible: true,
  eligible_preferred: true,
  ineligible: true,
  unknown: true,
};

const SORTS: Record<BrowseSort, true> = {
  deadline: true,
  amount_desc: true,
  name: true,
  verified: true,
};

function multi<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const raw: string[] = Array.isArray(value)
    ? value.flatMap((v) => String(v).split(','))
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const permitted = new Set<string>(allowed);
  return raw.map((s) => s.trim()).filter((s): s is T => permitted.has(s));
}

function keysOf<T extends string>(record: Record<T, true>, value: unknown): T[] {
  return multi(value, Object.keys(record) as T[]);
}

function num(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

/** Total tolerance for a hostile query string: unknown values are dropped, never echoed. */
export function parseBrowseQuery(query: Record<string, unknown>): BrowseFilters {
  const pageSizeRaw = num(query.pageSize) ?? DEFAULT_FILTERS.pageSize;
  const sort = String(query.sort);
  return {
    klass: multi(query.klass, KLASSES),
    entity: multi(query.entity, ENTITIES),
    instrument: multi(query.instrument, INSTRUMENTS),
    status: multi(query.status, STATUSES),
    verdict: keysOf(VERDICTS, query.verdict),
    deadlineFrom: iso(query.deadlineFrom),
    deadlineTo: iso(query.deadlineTo),
    includeRolling: query.includeRolling !== 'false',
    amountMin: num(query.amountMin),
    amountMax: num(query.amountMax),
    q: typeof query.q === 'string' ? query.q : undefined,
    sort: (Object.hasOwn(SORTS, sort) ? sort : DEFAULT_FILTERS.sort) as BrowseSort,
    page: Math.max(1, Math.trunc(num(query.page) ?? 1)),
    pageSize: Math.min(200, Math.max(1, Math.trunc(pageSizeRaw))),
  };
}

const EMPTY_SUMMARY: Omit<BrowseSummary, 'total'> = {
  eligible: 0,
  preferred: 0,
  ineligible: 0,
  unknown: 0,
  ineligibleByAxis: [],
  unknownByField: [],
};

/**
 * The verdict census (spec §5): "you are ineligible for 41 of these, and here is
 * the specific constraint for each".
 *
 * Both breakdowns count PROGRAMS, not reasons — a program excluded on two axes
 * adds one to each axis, never two to one — so "this axis costs you 12 awards"
 * is literally true and the numbers stay comparable across axes.
 *
 * With no profile applied, `verdicts` is empty and all four counters read zero
 * against a non-zero `total`. That is deliberate and `profileApplied` is the
 * discriminator: reporting "0 eligible" as a fact about a corpus nobody has been
 * matched against would be a false exclude, and a false exclude hides an award
 * with no signal at all.
 */
function buildSummary(verdicts: Map<string, Verdict>, total: number): BrowseSummary {
  const axisCounts = new Map<string, number>();
  const fieldCounts = new Map<string, number>();
  const summary: BrowseSummary = { total, ...EMPTY_SUMMARY };

  for (const verdict of verdicts.values()) {
    switch (verdict.kind) {
      case 'eligible':
        summary.eligible += 1;
        break;
      case 'eligible_preferred':
        summary.preferred += 1;
        break;
      case 'ineligible': {
        summary.ineligible += 1;
        const axes = new Set(verdict.reasons.map((c: Constraint) => c.spec.axis));
        for (const axis of axes) axisCounts.set(axis, (axisCounts.get(axis) ?? 0) + 1);
        break;
      }
      case 'unknown': {
        summary.unknown += 1;
        for (const field of new Set(verdict.missingProfileFields)) {
          fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
        }
        break;
      }
    }
  }

  // Ties break on the name so the ranking is stable between requests; a list
  // that reshuffled under the user on every reload could not be acted on.
  const byCountThenName = (a: readonly [string, number], b: readonly [string, number]): number =>
    b[1] - a[1] || a[0].localeCompare(b[0]);

  summary.ineligibleByAxis = [...axisCounts.entries()]
    .sort(byCountThenName)
    .map(([axis, count]) => ({ axis, count }));
  summary.unknownByField = [...fieldCounts.entries()]
    .sort(byCountThenName)
    .map(([field, count]) => ({ field, count }));
  return summary;
}

/**
 * The page size the census pass asks for. The verdict overlay runs in-process,
 * so the whole filtered corpus has to be in hand before a page can be cut —
 * spec §1.1 sizes that at ~150 records, and `queryProgramIds` is an indexed
 * lookup returning ids only. `-1` is SQLite's own "no limit" for LIMIT, so this
 * is one statement rather than a magic number large enough to hope.
 */
const UNPAGINATED = -1;

/** Watched program ids for a user, as a set the row mapper can test in O(1). */
function watchedIds(deps: RouterDeps, userId: string): Set<string> {
  const rows = deps.db
    .prepare('SELECT program_id FROM watches WHERE user_id = ?')
    .all(userId) as Array<{ program_id: string }>;
  return new Set(rows.map((r) => r.program_id));
}

export function createProgramsRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const filters = parseBrowseQuery(req.query as Record<string, unknown>);
    const prefer = isProfileKind(req.query.profile) ? req.query.profile : undefined;

    // Plan 1 validates `profiles.data` with `profileSchema` on read (CONTRACT
    // §6). A row that no longer parses is a server-side fault about stored
    // state, not a bad request — left alone the ZodError would surface as
    // `validation_failed` / 422 "The request body is invalid", which is a lie
    // about a request that was fine.
    let active: { profile: Profile; kind: ProfileKind } | null;
    try {
      active = loadActiveProfile(deps.db, user.id, prefer);
    } catch {
      throw new AppError(
        'internal',
        'Your saved profile could not be read. Re-save it from the profile editor.',
      );
    }

    // 1. Indexed filter, unpaginated, so the verdict census describes the whole
    //    filtered corpus rather than one page. ~150 records makes this cheap.
    const all = queryProgramIds(deps.db, { ...filters, page: 1, pageSize: UNPAGINATED });
    const hydrated = hydratePrograms(deps.db, all.ids);

    // A projection row whose program has been deleted hydrates to nothing.
    // `hydratePrograms` already drops it; everything below is derived from what
    // actually hydrated, in the order the indexed query returned, so the page,
    // the total and the census cannot disagree with each other — and so that a
    // stale projection row is a missing row rather than a 500.
    const found: HydratedProgram[] = all.ids
      .map((id) => hydrated.get(id))
      .filter((h): h is HydratedProgram => h !== undefined);

    // 2. Per-profile verdict overlay, on the injected clock: several axes
    //    (license tenure, age, ARRL membership years) are answered relative to
    //    "now", so a wall-clock read here would make verdicts un-reproducible.
    const verdicts: Map<string, Verdict> = active
      ? matchAll(active.profile, found.map((h) => h.program), deps.now())
      : new Map<string, Verdict>();

    const summary = buildSummary(verdicts, found.length);

    // 3. Verdict filter, then pagination. A verdict filter with no profile
    //    behind it matches nothing rather than everything: there is no verdict
    //    to test, and answering "all of them" would attach a claim about
    //    eligibility to a list nobody was matched against.
    const visible = filters.verdict.length
      ? found.filter((h) => {
          const verdict = verdicts.get(h.program.id);
          return verdict !== undefined && filters.verdict.includes(verdict.kind);
        })
      : found;

    const start = (filters.page - 1) * filters.pageSize;
    const watched = watchedIds(deps, user.id);

    const rows: BrowseRow[] = visible
      .slice(start, start + filters.pageSize)
      .map((h) => ({
        program: h.program,
        funderName: h.funderName,
        verdict: verdicts.get(h.program.id) ?? null,
        nextOpensAt: h.nextOpensAt,
        nextClosesAt: h.nextClosesAt,
        nextIsEstimated: h.nextIsEstimated,
        watched: watched.has(h.program.id),
      }));

    const body: BrowseResponse = {
      rows,
      summary,
      page: filters.page,
      pageSize: filters.pageSize,
      total: visible.length,
      profileApplied: active?.kind ?? null,
    };
    res.json(body);
  });

  return router;
}
