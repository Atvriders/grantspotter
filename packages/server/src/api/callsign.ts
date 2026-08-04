import { timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { createRateLimiter, type RateLimiter } from '../auth/rateLimit.js';
import { lookupCallsign } from '../callsign/callook.js';
import type { CallsignLookupResult } from '../callsign/types.js';
import { asyncHandler } from './asyncHandler.js';
import { AppError } from './errors.js';

/**
 * `POST /api/callsign/lookup` — one person, one button, one request to callook.info.
 *
 * WHO MAY CALL IT, AND WHY THE LIST IS SHORT.
 *
 * Two callers: the first-run setup screen, which has no session and holds the one-time setup
 * token instead, and a signed-in user filling in their OWN profile. That is the entire list,
 * and the omission is the point of the endpoint.
 *
 * An administrator creating somebody else's account may NOT look that person's callsign up.
 * The result of a lookup is a name and a home address, and filling them into a third party's
 * profile makes GrantSpotter state, on that person's behalf, facts they never gave it — the
 * exact failure the whole product is built to avoid. So there is no user-id parameter on this
 * route, and the body schema is `.strict()`: a request that names anybody is REFUSED (422)
 * rather than silently answered for the caller instead. The result is returned to the caller
 * and nothing is written anywhere, so the only profile a lookup can ever reach is the one the
 * caller is filling in themselves.
 *
 * WHY IT FAILS SOFT. Every non-`found` outcome is HTTP 200 carrying a status and a sentence,
 * exactly as `verifyRouter` returns `ok: false` with a 200. The request succeeded; it is the
 * source that had nothing, or was mid-import, or was unreachable. Flattening those into an
 * HTTP error would tell a licensed operator that something is wrong with their licence.
 */

/**
 * PLAN-LOCAL. The transport `lookupCallsign` requires, declared structurally here rather than
 * imported, exactly as `api/verify.ts` declares `VerifyFetcher` (verify.ts:29-31) instead of
 * depending on the production fetcher. The composition root passes the real one; the route
 * tests pass a fake, which is what keeps this suite off the network.
 */
export interface CallsignTransport {
  (url: string, init: RequestInit): Promise<Response>;
}

/** PLAN-LOCAL. The signed-in user, or `undefined` — this is the one route with both callers. */
export interface CallsignCaller {
  id: string;
  role: 'admin' | 'member';
}

export interface CallsignRouterDeps {
  transport: CallsignTransport;
  /**
   * The one-time first-run token while no account exists, or `null`. READ, NEVER CONSUMED:
   * `BootstrapState.consume` spends the token on a match, and spending it here would leave an
   * operator who looked their callsign up holding a token that can no longer create the
   * administrator account — a dead end whose only exit is restarting the container.
   */
  setupToken: () => string | null;
  /**
   * Anonymous-tolerant, unlike `RouterDeps.currentUser`, which throws when there is no session.
   * A missing session is a legitimate state on this route (the first-run caller), so it has to
   * be a value rather than an exception.
   */
  sessionUser?: (req: Request) => CallsignCaller | undefined;
  /** Injected by the tests; production gets the module's own, built from the constants below. */
  limiter?: RateLimiter;
  /** Passed through to the client. Production leaves it at the client's own default. */
  timeoutMs?: number;
}

/**
 * THE RATE LIMIT, and why it is the login limiter rather than a second mechanism.
 *
 * `auth/rateLimit.ts` is already an in-memory sliding-window counter keyed by a string, which
 * is precisely what is wanted here; writing a second one would be two things to reason about
 * and one of them untested. What differs is what gets counted: the login limiter counts
 * FAILURES, because a successful sign-in is not something to ration. Here every attempt is
 * counted, successful or not, because the cost being rationed is the REQUEST — one press of
 * this button is one request to somebody else's server, and a lookup that keeps timing out is
 * the moment that server can least afford to be asked again. Same reasoning as
 * `verifyRouter`'s ledger insert, which also lands before the fetch and is not rolled back.
 *
 * The numbers are a judgement, not a measurement: this is a person typing one callsign, and a
 * few corrections to a typo is the widest honest use. Eight in ten minutes covers that with
 * room to spare and is nowhere near enough to be a source of load.
 */
export const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
export const LOOKUP_MAX_PER_WINDOW = 8;

/**
 * `.strict()` IS THE AUTHORISATION RULE, not tidiness.
 *
 * zod strips unknown keys by default, which would make `{ callsign, userId: 'u-other' }` a
 * request that looks like it targeted another user and quietly answered for the caller. On
 * this route that difference matters: refusing tells whoever built that client that looking a
 * callsign up on somebody else's behalf is not a thing this endpoint does, and the alternative
 * is a client that believes it worked.
 *
 * The length cap is 16 rather than the longest callsign anyone holds: a US callsign is at most
 * 6 characters, and the slack is for a `/P` or `/4` suffix the client did not strip. Anything
 * longer is not a callsign and never becomes a URL.
 */
const lookupBodySchema = z
  .object({
    callsign: z.string().min(1).max(16),
    setupToken: z.string().min(1).max(256).optional(),
  })
  .strict();

/** Constant-time, and length-checked first because `timingSafeEqual` throws on a length mismatch. */
function tokenMatches(expected: string | null, candidate: string | undefined): boolean {
  if (expected === null || candidate === undefined) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `req.auth` is populated by `auth/middleware.ts`'s `attachUser` on every request. */
function defaultSessionUser(req: Request): CallsignCaller | undefined {
  return req.auth === undefined ? undefined : { id: req.auth.id, role: req.auth.role };
}

export function createCallsignRouter(deps: CallsignRouterDeps): Router {
  const router = Router();
  const sessionUser = deps.sessionUser ?? defaultSessionUser;
  const limiter =
    deps.limiter ??
    createRateLimiter({ windowMs: LOOKUP_WINDOW_MS, maxFailures: LOOKUP_MAX_PER_WINDOW });

  router.post(
    '/lookup',
    asyncHandler(async (req, res) => {
      const body = lookupBodySchema.parse(req.body);

      /**
       * The session first, and the token only when there is no session.
       *
       * Once an account exists `setupToken()` answers `null` for good (BootstrapState.token
       * checks the user count on every call), so the anonymous door closes by itself the
       * moment the deployment is set up. An authenticated request that carries a token is
       * answered as the signed-in user and the token is not looked at — it cannot widen what
       * that user may do, and it must not be spendable by anyone who already has a session.
       */
      const user = sessionUser(req);
      const rateKey =
        user !== undefined
          ? `user:${user.id}`
          : tokenMatches(deps.setupToken(), body.setupToken)
            ? // ONE bucket for the whole first-run path, deliberately not per-IP. `trust proxy`
              // is on, so `req.ip` comes from a header the client sets, and a per-IP key would
              // be a bucket the caller can mint a fresh one of at will. Before any account
              // exists there is exactly one operator and one token, so one bucket is the honest
              // shape as well as the unspoofable one.
              'setup'
            : null;

      if (rateKey === null) {
        throw new AppError(
          'unauthorized',
          'Sign in to look a callsign up. During first-run setup, send the one-time setup token ' +
            'printed in the server log with the request.',
        );
      }

      const decision = limiter.check(rateKey);
      if (!decision.allowed) {
        // Retry-After is a transport header; the body stays the one error envelope.
        res.set('Retry-After', String(decision.retryAfterSec));
        throw new AppError(
          'rate_limited',
          'That is more callsign lookups than one person filling in a form makes. callook.info ' +
            'answers these for free; GrantSpotter asks it politely. Try again shortly, or type ' +
            'your licence details in yourself.',
          { retryAfterSec: decision.retryAfterSec },
        );
      }
      // Counted BEFORE the lookup and never rolled back: what is being rationed is the request
      // this is about to make, and a source that is failing must not be retriable as fast as a
      // person can click.
      limiter.recordFailure(rateKey);

      const result: CallsignLookupResult = await lookupCallsign(body.callsign, {
        transport: deps.transport,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      });

      res.status(200).json(result);
    }),
  );

  return router;
}
