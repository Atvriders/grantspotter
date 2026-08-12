import { Router } from 'express';
import { asyncHandler } from './asyncHandler.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { checkVerifyRateLimit, type VerifyRunner } from './verify.js';
import { drainChangeEvents } from './notify.js';
import { reindexBrowse } from './reindex.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { isDoNotPublish } from '../normalize/index.js';

/**
 * `POST /api/programs/:id/verify` — spec §8's "Verify now", open to admin and
 * member alike (spec §12 rate-limits the member, not the button).
 *
 * The attempt is written to the ledger BEFORE the refetch, and deliberately not
 * rolled back when the refetch fails. These pages belong to small volunteer-run
 * organisations; charging only successful fetches would let a user whose target
 * is timing out — the exact moment a server is least able to take it — retry as
 * fast as they can click.
 */
export function createVerifyRouter(deps: RouterDeps, runner: VerifyRunner): Router {
  const router = Router();

  router.post(
    '/:id/verify',
    deps.requireAuth,
    asyncHandler(async (req, res, next) => {
      const user = deps.currentUser(req);
      const programId = req.params.id;
      const nowISO = deps.now();

      /**
       * THE SUPPRESSION GATE, and it is the FIRST thing this route does.
       *
       * Until 2026-08-04 the existence test here was `SELECT 1 FROM programs`,
       * which knows nothing about suppression, so this route answered 200 for
       * every one of the ~553 `do_not_publish` records the corpus stores. That
       * was three separate failures at once, measured against a live server on
       * the seeded 703-record database:
       *
       *  - A READ LEAK. A successful refetch returns the hidden record's own
       *    parsed fields in `diffs` — the ARRL club-grant past award came back
       *    with `{"label":"recipient",…}`, `usaspending--2045755` with its
       *    `adjacencyHits`/`adjacencyScore`, the ARRL summary table with
       *    `recordType: crosscheck`. Six suppressed ids across six sources
       *    answered 200 and four of them performed a live refetch, to a member
       *    and to an admin alike.
       *  - AN AMPLIFIER. Admin verification is deliberately unrate-limited
       *    (`checkVerifyRateLimit` returns immediately for `admin`), so the id
       *    space of records the product refuses to show became an unmetered way
       *    to aim requests at the ~25 small volunteer-run sites behind them.
       *  - A WRITE. The refetch drains change events; afterwards 21 of the
       *    database's 21 `change_events` joined to `do_not_publish` programs.
       *
       * The gate runs BEFORE the rate-limit check and before the
       * `verify_attempts` insert, so a refused id leaves no row anywhere — the
       * refusal must not be observable in the ledger either.
       *
       * `not_found`, not `forbidden`, and the same sentence an unknown id gets:
       * a suppressed record is not a resource this user may not see, it is not
       * published at all, and a distinguishable refusal turns the route into an
       * existence oracle over the 553.
       *
       * The predicate is IMPORTED, never reimplemented — the same
       * `isDoNotPublish` that `programDetail`, `reindexBrowse`, the watchlist,
       * the calendar, the corpus profiler and the approve path call. A new
       * suppressed record type classified in `normalize/index.ts` starts 404ing
       * here in the same commit.
       */
      const program = createProgramRepo(deps.db).get(programId);
      if (program === undefined || isDoNotPublish(program)) {
        next(new AppError('not_found', `No program with id "${programId}".`));
        return;
      }

      const limit = checkVerifyRateLimit(deps.db, user.id, user.role, programId, nowISO);
      if (!limit.allowed) {
        const retryAfterSec = limit.retryAfterSec ?? 600;
        // Retry-After is a transport header, so it is set on the response
        // directly; the body is still Plan 1's single error envelope.
        res.set('Retry-After', String(retryAfterSec));
        /*
         * TWO REASONS, TWO SENTENCES (2026-08-12). One sentence answered both, and it was
         * "You have verified this recently" — which names THIS programme, and is false of the
         * whole of `hourly_cap`. `checkVerifyRateLimit` returns that reason when a member has
         * spent ten verifications across the corpus in the last hour, and it fires on a record
         * they have never once checked. The browser never saw it (`components/VerifyButton.tsx`
         * writes its own sentence per reason), so the falsity was reserved for whoever reads the
         * API directly — and a sentence being hard to reach is not a reason for it to be untrue.
         *
         * Neither says when. `retryAfterSec` travels with both and is the one statement of it;
         * see the docblock in `api/auth.ts` and `packages/server/test/userFacingCopyContract.
         * test.ts`, which fails when a refusal starts promising a duration again.
         */
        next(new AppError(
          'rate_limited',
          limit.reason === 'hourly_cap'
            ? 'You have used every verification in your hourly allowance. Small nonprofits host ' +
                'these pages; we poll them politely.'
            : 'You have verified this programme recently. Small nonprofits host these pages; we ' +
                'poll them politely.',
          { reason: limit.reason, retryAfterSec },
        ));
        return;
      }

      deps.db
        .prepare('INSERT INTO verify_attempts (user_id, program_id, attempted_at) VALUES (?, ?, ?)')
        .run(user.id, programId, nowISO);

      const result = await runner.verify(programId);

      if (result.ok) {
        reindexBrowse(deps.db, nowISO);
        drainChangeEvents(deps.db, nowISO);
      }

      // A failed FETCH is a 200 carrying `ok: false`: the request succeeded, the
      // funder's site (or the blocklist standing in front of it) did not, and
      // `result.error` carries the fetcher's own sentence for the user to read.
      // The UI renders that difference; an HTTP error would flatten it into
      // "something went wrong here", which is not what happened.
      res.status(200).json(result);
    }),
  );

  return router;
}
