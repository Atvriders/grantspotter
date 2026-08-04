import { Router } from 'express';
import type {
  ApplicantEntity,
  Cycle,
  DeadlineKind,
  Instrument,
  OpportunityClass,
  Profile,
  Program,
  ProgramStatus,
  Verdict,
} from '@grantspotter/core';
import { expandCycles, matchAll, observedCycles, resolveDeadlineOwner } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import { isDoNotPublish } from '../normalize/index.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { loadActiveProfile, type ProfileKind } from './profileStore.js';
import { HORIZON_DAYS } from './reindex.js';
import { watchedProgramIds } from './watchRouter.js';
import { prepLeadFor, prepStartFor } from './prepLead.js';

/**
 * PLAN-LOCAL to Plan 3. WHERE THIS ENTRY'S DATE CAME FROM, resolved.
 *
 * `'stated'` means this programme published the window itself. `'inherited'` means the dates were
 * read off ANOTHER programme's record — and it names that programme, because "inherited" without a
 * name is a shrug, not an answer.
 *
 * TWO KINDS ARE ENOUGH, and that is a property of core rather than an assumption here.
 * `resolveDeadlineOwner` returns the INPUT programme when the declared owner is absent from the
 * corpus or the chain loops, which read naively would make a dangling inheritance look self-stated.
 * It cannot reach an entry: such a programme still carries `deadline.kind: 'inherited'` after
 * resolution, and both cycle functions test the OWNER's kind — `'inherited'` is in core's
 * `KINDS_WITH_NO_CYCLE` and absent from its `PROJECTABLE_KINDS` — so it produces no cycle at all
 * and can only land in `undated`. `calendarRouter.test.ts` pins that, and fails if either set moves.
 */
export type CalendarDeadlineSource =
  | { kind: 'stated' }
  | { kind: 'inherited'; fromProgramId: string; fromProgramName: string };

/** PLAN-LOCAL to Plan 3. One dated deadline, with everything the wall needs. */
export interface CalendarEntry {
  cycle: Cycle;
  programId: string;
  programName: string;
  funderName: string;
  klass: OpportunityClass;
  instrument: Instrument;
  applicantEntities: ApplicantEntity[];
  /**
   * `false` means the funder published this window itself; `true` means it was
   * projected forward from a recurrence rule. Duplicated from `cycle` onto the
   * entry deliberately: this is the flag the overlay renders, and a UI that has
   * to reach one level deeper to find it is a UI that will eventually forget.
   */
  isEstimated: boolean;
  /**
   * Which programme's deadline this actually is.
   *
   * 112 of the 150 publishable records inherit their deadline from the ARRL Foundation scholarship
   * portal, so December 2026 stacks 113 entries on one day of which 112 are one portal date. Both
   * `expandCycles` and `observedCycles` already resolve that inheritance internally and then
   * discard the answer; without it on the entry a chip cannot say whose date it is, and a user
   * reads 113 coincidences instead of one deadline that 112 applications share.
   */
  deadlineSource: CalendarDeadlineSource;
  prepLeadDays: number;
  prepStartAt: string | null;
  prepNote: string;
  decisionLagMinDays: number | null;
  decisionLagMaxDays: number | null;
  watched: boolean;
  verdictKind: Verdict['kind'] | null;
  /**
   * Plan 3 Global Constraints: "every user-facing date renders with its
   * `lastVerifiedAt` provenance — no bare dates", and "`status: 'unknown'`
   * renders as a real, labelled state". The calendar is nothing but dates, and
   * 118 of the 150 real records carry `status: 'unknown'`, so both fields are
   * on every entry or neither constraint can be honoured on this surface.
   */
  status: ProgramStatus;
  lastVerifiedAt: string;
}

/** PLAN-LOCAL to Plan 3. A program the corpus holds no dated deadline for. */
export interface UndatedProgram {
  programId: string;
  programName: string;
  funderName: string;
  deadlineKind: DeadlineKind;
  deadlineNote: string;
  status: ProgramStatus;
  lastVerifiedAt: string;
}

/** PLAN-LOCAL to Plan 3. `GET /api/calendar`. */
export interface CalendarResponse {
  from: string;
  to: string;
  entries: CalendarEntry[];
  undated: UndatedProgram[];
}

const YEAR_MS = 365 * 86_400_000;

/**
 * The longest window one request may ask for, in days — five years.
 *
 * `expandCycles` runs a year loop per program, so an unbounded `to` is an
 * unbounded loop over ~150 programs: `to=9999-12-31` is roughly eight thousand
 * iterations each. The cap is a refusal (422), not a silent clamp, for the same
 * reason an unreadable date is: quietly answering a smaller window than the one
 * asked for is a wrong answer that looks like a right one. Five years is far
 * past any planning horizon this product serves — the browse projection itself
 * only looks 550 days ahead.
 */
const MAX_WINDOW_DAYS = 5 * 365;

/**
 * A window bound, or `fallback` when the parameter is absent.
 *
 * DELIBERATE DIVERGENCE from `parseBrowseQuery`, which is documented as totally
 * tolerant ("unknown values are dropped, never echoed"). Dropping an unreadable
 * browse filter widens a list, and the user can see the list. Dropping an
 * unreadable calendar bound substitutes a different month for the one asked
 * for, and the answer looks exactly like the right answer. Absent is a default;
 * present-and-unreadable is a bad request.
 */
function bound(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new AppError(
      'validation_failed',
      `The calendar window parameter "${name}" is not a date this server can read.`,
      { parameter: name },
    );
  }
  return value;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * Both channels core exposes, for one program, as one list.
 *
 * They are two separate calls and stay that way. `expandCycles` repeats a
 * `RECUR` rule forwards and marks every row `isEstimated: true`;
 * `observedCycles` records the single window a funder actually printed and
 * marks it `isEstimated: false`, inventing no successor for the years after it.
 * Merging them into one `expandCycles` pass is exactly the shortcut that would
 * publish a 2027 ARISS deadline ARISS has never announced.
 *
 * The brief for this task built the calendar from `expandCycles` alone. Against
 * the real corpus at 2026-08-02 that omits all four funder-published windows
 * (ARISS, Yaesu, and two federal NOFOs) — so a calendar meant to distinguish
 * "the funder said so" from "we projected it" would have contained only the
 * projections, while `reindexBrowse`, which merges both, showed the funder's
 * real date on the browse row beside it.
 */
function cyclesFor(program: Program, all: Program[], fromISO: string, toISO: string): Cycle[] {
  return [
    ...expandCycles(program, all, fromISO, toISO),
    ...observedCycles(program, all, fromISO, toISO),
  ].filter((c) => c.closesAt !== undefined);
}

export function createCalendarRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const nowISO = deps.now();
    const from = bound(req.query.from, 'from', nowISO);
    const to = bound(req.query.to, 'to', new Date(Date.parse(nowISO) + YEAR_MS).toISOString());

    const spanMs = Date.parse(to) - Date.parse(from);
    if (spanMs < 0) {
      throw new AppError('validation_failed', 'The calendar window ends before it begins.', {
        from,
        to,
      });
    }
    if (spanMs > MAX_WINDOW_DAYS * 86_400_000) {
      throw new AppError(
        'validation_failed',
        `A calendar window may span at most ${MAX_WINDOW_DAYS} days.`,
        { from, to, maxDays: MAX_WINDOW_DAYS },
      );
    }

    // RESOLUTIONS R1: whole records through Plan 1's repository; the funder
    // display name is the only thing read in SQL, once, into a lookup.
    //
    // `do_not_publish` is filtered here for the same reason `reindexBrowse`
    // filters it: 545 of the 742 records the corpus can produce are past awards
    // and already-funded clubs, stored on purpose but never an opportunity. A
    // calendar entry IS the claim "prepare this by then", and the `undated`
    // list is the claim "this exists but has no date" — a grant somebody else
    // won in 2024 is neither.
    const programs: Program[] = createProgramRepo(deps.db)
      .list()
      .filter((program) => !isDoNotPublish(program));
    const funderById = new Map(
      (deps.db.prepare('SELECT id, name FROM funders').all() as Array<{ id: string; name: string }>)
        .map((f) => [f.id, f.name] as const),
    );
    const funderNameFor = (program: Program): string => funderById.get(program.funderId) ?? '';

    // Plan 1 validates `profiles.data` with `profileSchema` on read. A row that
    // no longer parses is a server-side fault about stored state, not a bad
    // request, so it must not surface as `validation_failed` / 422 — that would
    // be a lie about a request that was fine.
    let active: { profile: Profile; kind: ProfileKind } | null;
    try {
      active = loadActiveProfile(deps.db, user.id);
    } catch {
      throw new AppError(
        'internal',
        'Your saved profile could not be read. Re-save it from the profile editor.',
      );
    }

    const verdicts = active
      ? matchAll(active.profile, programs, nowISO)
      : new Map<string, Verdict>();
    const watched = new Set(watchedProgramIds(deps.db, user.id));

    /**
     * "Undated" is a property of the CORPUS, not of the month on screen.
     *
     * The horizon is `HORIZON_DAYS` from now — the same 550 days `reindexBrowse`
     * uses to compute `next_closes_at` — so "no deadline published" means the
     * same 28 records here as it does in an empty next-deadline cell on a browse
     * row, whichever month the user is looking at. Scoping it to [from, to]
     * instead, as the brief does, reports 147 of 150 real programmes as undated
     * for a September view, including the 111 ARRL-catalog entries whose
     * deadline is a well-known December 30. Telling a user that a programme with
     * a published deadline has none is the same class of lie as publishing a
     * date the funder never announced.
     */
    const horizonEnd = addDays(nowISO, HORIZON_DAYS);

    const entries: CalendarEntry[] = [];
    const undated: UndatedProgram[] = [];

    for (const program of programs) {
      const inWindow = cyclesFor(program, programs, from, to);

      // A window that reaches past the horizon can legitimately hold cycles for
      // a program the horizon does not, so what the window found settles it
      // first; only then is the corpus-wide question asked.
      if (inWindow.length === 0 && cyclesFor(program, programs, nowISO, horizonEnd).length === 0) {
        undated.push({
          programId: program.id,
          programName: program.name,
          funderName: funderNameFor(program),
          deadlineKind: program.deadline.kind,
          deadlineNote: program.deadline.note,
          status: program.trust.status,
          lastVerifiedAt: program.trust.lastVerifiedAt,
        });
      }

      if (inWindow.length === 0) continue;

      const lead = prepLeadFor(program);
      // The SAME resolution both cycle functions ran to produce `inWindow`, kept this time. There
      // is no second definition of inheritance here: `resolveDeadlineOwner` is core's, called with
      // the same corpus, so the owner named on the chip is the record the dates were read off.
      const owner = resolveDeadlineOwner(program, programs);
      const deadlineSource: CalendarDeadlineSource =
        owner.id === program.id
          ? { kind: 'stated' }
          : { kind: 'inherited', fromProgramId: owner.id, fromProgramName: owner.name };

      for (const cycle of inWindow) {
        entries.push({
          cycle,
          programId: program.id,
          programName: program.name,
          funderName: funderNameFor(program),
          klass: program.klass,
          instrument: program.amount.instrument,
          applicantEntities: program.applicantEntities,
          isEstimated: cycle.isEstimated,
          deadlineSource,
          prepLeadDays: lead.prepLeadDays,
          prepStartAt: prepStartFor(cycle.closesAt ?? null, lead.prepLeadDays),
          prepNote: lead.note,
          decisionLagMinDays: lead.decisionLagMinDays ?? null,
          decisionLagMaxDays: lead.decisionLagMaxDays ?? null,
          watched: watched.has(program.id),
          verdictKind: verdicts.get(program.id)?.kind ?? null,
          status: program.trust.status,
          lastVerifiedAt: program.trust.lastVerifiedAt,
        });
      }
    }

    // On a tie the funder's own stated window sorts first — the same tie-break
    // `reindexBrowse`'s `nextCycle` applies, so the two surfaces agree about
    // which of two same-day deadlines is the authoritative one.
    entries.sort((a, b) => {
      const byClose = (a.cycle.closesAt ?? '').localeCompare(b.cycle.closesAt ?? '');
      if (byClose !== 0) return byClose;
      const byKind = Number(a.isEstimated) - Number(b.isEstimated);
      if (byKind !== 0) return byKind;
      return a.programName.localeCompare(b.programName);
    });
    undated.sort((a, b) => a.programName.localeCompare(b.programName));

    const body: CalendarResponse = { from, to, entries, undated };
    res.json(body);
  });

  return router;
}
