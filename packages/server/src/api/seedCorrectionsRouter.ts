/**
 * THE SECOND DOOR, AS THREE ROUTES.
 *
 * `seed/consentedCorrections.ts` holds the whole of the argument for why this is a screen and not
 * a CLI subcommand, and the whole of what these routes may and may not write. This file is the
 * seam: it authorises, it validates a request body, and it hands two functions a database.
 *
 * ADMIN ON EVERY ROUTE, INCLUDING THE READ. The preview names records, quotes the sentences a
 * funder wrote, and reports how many of this instance's applicant profiles change verdict — and
 * the two writes change what EVERY member is told about their own eligibility. A member has no
 * business reaching any of it, so `requireAuth` and `requireAdmin` guard all three and
 * `seedCorrectionsRouter.test.ts` asserts 401 for a stranger and 403 for a member on each.
 *
 * THE CONFIRMATION WORD IS NOT THE CONSENT. The consent is the list of proposal ids, each a digest
 * of exactly the text the operator was shown; the word is only the "somebody is present" signal
 * that `Admin.tsx`'s restore panel already establishes as this product's shape for an
 * irreversible act. Both are required, and the ids are what the server actually obeys — an id
 * whose proposal has moved since it was read is refused rather than resolved to the nearest thing.
 */
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { applyConsented, pendingChanges } from '../seed/consentedCorrections.js';
import type { ConsentAct } from '../seed/consentedCorrections.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';

/** Typed to apply corrections. Mirrors `CONFIRM_WORD` in `Admin.tsx`. */
export const CONFIRM_CORRECT = 'CORRECT';
/** Typed to add a programme. A DIFFERENT word, because it is a different act. */
export const CONFIRM_ADD = 'ADD';

const bodySchema = z.object({
  confirm: z.string(),
  proposalIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});

export function createSeedCorrectionsRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, deps.requireAdmin, (_req, res) => {
    res.json(pendingChanges(deps.db, { nowISO: deps.now() }));
  });

  function apply(act: ConsentAct, word: string): RequestHandler {
    return (req, res, next) => {
      try {
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'validation_failed',
            'Name the changes to apply, and type the confirmation word.',
            parsed.error.issues,
          );
        }
        if (parsed.data.confirm !== word) {
          throw new AppError('bad_request', `Type ${word} to confirm. Nothing was written.`);
        }
        const result = applyConsented(deps.db, {
          act,
          proposalIds: parsed.data.proposalIds,
          userId: deps.currentUser(req).id,
          nowISO: deps.now(),
        });
        // A refusal is not an error: an apply may land some changes and refuse others, and the
        // operator is owed both halves. Only a reconcile that could not run at all is a 500.
        if (!result.ran) {
          throw new AppError(
            'internal',
            result.error ?? 'The pending changes could not be computed, so nothing was written.',
          );
        }
        res.json(result);
      } catch (err) {
        next(err);
      }
    };
  }

  router.post('/apply', deps.requireAuth, deps.requireAdmin, apply('correct', CONFIRM_CORRECT));
  router.post('/add', deps.requireAuth, deps.requireAdmin, apply('add', CONFIRM_ADD));

  return router;
}
