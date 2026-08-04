import { Router } from 'express';
import { asyncHandler } from './asyncHandler.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { checkVerifyRateLimit, type VerifyRunner } from './verify.js';
import { drainChangeEvents } from './notify.js';
import { reindexBrowse } from './reindex.js';

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

      const exists = deps.db.prepare('SELECT 1 FROM programs WHERE id = ?').get(programId);
      if (exists === undefined) {
        next(new AppError('not_found', `No program with id "${programId}".`));
        return;
      }

      const limit = checkVerifyRateLimit(deps.db, user.id, user.role, programId, nowISO);
      if (!limit.allowed) {
        const retryAfterSec = limit.retryAfterSec ?? 600;
        // Retry-After is a transport header, so it is set on the response
        // directly; the body is still Plan 1's single error envelope.
        res.set('Retry-After', String(retryAfterSec));
        next(new AppError(
          'rate_limited',
          'You have verified this recently. Small nonprofits host these pages; we poll them politely.',
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
