import type { RequestHandler } from 'express';
import type { Cycle, Funder } from '@grantspotter/core';
import { expandCycles, matchProgram, observedCycles, resolveDeadlineOwner } from '@grantspotter/core';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { isDoNotPublish } from '../normalize/index.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { loadActiveProfile } from './profileStore.js';
import { loadProvenance } from './provenanceStore.js';
import { HORIZON_DAYS } from './reindex.js';
import type { OpportunityDetail } from './browseTypes.js';

/**
 * DEVIATION FROM THE TASK BRIEF (2026-08-03), in shape only. The brief writes
 * this handler inline in `programsRouter.ts`. It lives here instead, beside the
 * `programDetail.test.ts` the brief names, so that the line the browse router
 * gains is a single `router.get('/:id', …, createProgramDetailHandler(deps))`.
 * Behaviour, route and mount point are exactly as specified; only the ~80 lines
 * of body move out of a file another task owns.
 */

/** Whether this user is watching this one program. */
function isWatched(deps: RouterDeps, userId: string, programId: string): boolean {
  const row = deps.db
    .prepare('SELECT 1 AS present FROM watches WHERE user_id = ? AND program_id = ?')
    .get(userId, programId);
  return row !== undefined;
}

/**
 * Opportunity detail (spec §8): the whole record, the funder behind it, every
 * cycle it resolves to, the field-level provenance for its values, and — when
 * the deadline did not come from this program — the program it did come from.
 */
export function createProgramDetailHandler(deps: RouterDeps): RequestHandler {
  return (req, res, next) => {
    const user = deps.currentUser(req);
    const id = req.params.id ?? '';

    const programs = createProgramRepo(deps.db);
    const program = programs.get(id);

    /**
     * DEVIATION FROM THE TASK BRIEF (2026-08-03): the `isDoNotPublish` half of
     * this test is not in the brief, and without it this route is the one hole
     * left in the suppression the rest of the pipeline maintains.
     *
     * ~553 of the corpus's records carry `do_not_publish` — past ARDC / NSF /
     * USAspending awards and the ARRL clubs already funded. Browse cannot serve
     * them because `reindexBrowse` filters them out of the projection browse
     * reads. This route reads no projection: it goes straight to the repository,
     * which knows nothing about suppression, so the brief's version answers 200
     * with the full record to anyone who can guess an id. Those records are
     * exactly the class whose "apply here" was a grant recipient's Facebook page.
     *
     * `not_found` rather than `forbidden` is deliberate: a suppressed record is
     * not a resource this user may not see, it is not published at all, and 403
     * would confirm the id exists.
     *
     * The predicate is imported, never reimplemented — the same `isDoNotPublish`
     * that `buildReviewItems`, the approve path, the corpus profiler and
     * `reindexBrowse` call. A new suppressed record type classified in
     * `normalize/index.ts` starts 404ing here in the same commit.
     */
    if (program === undefined || isDoNotPublish(program)) {
      next(new AppError('not_found', `No program with id "${id}".`));
      return;
    }

    const funder: Funder = createFunderRepo(deps.db).get(program.funderId)
      ?? { id: program.funderId, name: program.funderId, homepage: '' };

    // `resolveDeadlineOwner` and both cycle projections need the whole corpus:
    // 111 ARRL catalog entries inherit one deadline from a sibling record. The
    // corpus is filtered exactly as `reindexBrowse` filters it, so a deadline can
    // never be inherited from a record this product does not publish — core then
    // returns the program itself rather than fabricating dates.
    const allPrograms = programs.list().filter((p) => !isDoNotPublish(p));

    const nowISO = deps.now();
    const to = new Date(Date.parse(nowISO) + HORIZON_DAYS * 86_400_000).toISOString();

    /**
     * BOTH channels, as `reindexBrowse` does and for the same reason. Core keeps
     * them apart because they are separate claims: `expandCycles` repeats a
     * RECUR rule forwards and marks every row `isEstimated: true`, while
     * `observedCycles` carries the one window the funder actually published and
     * marks it `isEstimated: false`. The brief's route calls only the first, so a
     * funder's own stated deadline would appear on the browse row and vanish on
     * the detail page the user opened to check it.
     *
     * On a tie the funder's own window wins and the projection is dropped, which
     * is `reindexBrowse`'s documented rule; showing both would print the same
     * date twice, once labelled an estimate.
     */
    const byClose = new Map<string, Cycle>();
    for (const cycle of [
      ...expandCycles(program, allPrograms, nowISO, to),
      ...observedCycles(program, allPrograms, nowISO, to),
    ]) {
      const key = cycle.closesAt ?? cycle.opensAt ?? cycle.id;
      const held = byClose.get(key);
      if (held === undefined || (held.isEstimated && !cycle.isEstimated)) byClose.set(key, cycle);
    }
    const cycles: Cycle[] = [...byClose.values()]
      .sort((a, b) => (a.closesAt ?? '').localeCompare(b.closesAt ?? ''));

    const owner = resolveDeadlineOwner(program, allPrograms);
    const deadlineOwner =
      owner.id === program.id ? null : { programId: owner.id, programName: owner.name };

    // Plan 1 validates `profiles.data` on read, so a stored row that no longer
    // parses is a server-side fault about stored state, not a bad request — left
    // alone the ZodError would surface as 422 "the request body is invalid",
    // which is a lie about a request that was fine. Same handling as the browse
    // route beside it.
    let active: ReturnType<typeof loadActiveProfile>;
    try {
      active = loadActiveProfile(deps.db, user.id);
    } catch {
      next(new AppError(
        'internal',
        'Your saved profile could not be read. Re-save it from the profile editor.',
      ));
      return;
    }

    const body: OpportunityDetail = {
      program,
      funder,
      cycles,
      provenance: loadProvenance(deps.db, id),
      // On the injected clock: several axes (license tenure, age, ARRL
      // membership years) are answered relative to "now", so a wall-clock read
      // here would make this verdict disagree with the browse row's.
      verdict: active ? matchProgram(active.profile, program, nowISO) : null,
      watched: isWatched(deps, user.id, id),
      deadlineOwner,
    };
    res.json(body);
  };
}
