import { Router, type Request } from 'express';
import { z } from 'zod';
import { createRateLimiter, type RateLimiter } from '../auth/rateLimit.js';
import {
  lookupCallsign,
  wouldReachTheSource,
  type CallsignLookupDeps,
} from '../callsign/callook.js';
import { createHostCooldown, type HostCooldown } from '../callsign/cooldown.js';
import type { CallsignLookupResult } from '../callsign/types.js';
import { asyncHandler } from './asyncHandler.js';
import { AppError } from './errors.js';

/**
 * `POST /api/callsign/lookup` — one person, one button, one request to callook.info.
 *
 * WHO MAY CALL IT, AND WHY THE LIST IS SHORT.
 *
 * ONE caller: a signed-in user filling in their OWN profile. That is the entire list, and the
 * omission is the point of the endpoint.
 *
 * THERE WERE TWO UNTIL 2026-08-11, AND THE SECOND WAS AN UNAUTHENTICATED ONE. The first-run setup
 * screen had a callsign field and a lookup panel, no session, and the one-time setup token in a
 * text box; this route accepted that token in the request body, matched it constant-time and
 * answered on it, under a rate bucket of its own. `routes/FirstRun.tsx` deleted the field and the
 * panel in the same round — account creation stopped asking for a callsign at all — and the
 * privilege was left behind it: an anonymous door into an outbound request, kept open for a screen
 * that no longer exists, used by nothing and watched by nobody. Deleted here rather than left
 * "harmless because unreachable", because unreachable-from-our-own-UI is not a property of a route
 * a stranger can POST to. `index.ts` no longer passes `bootstrap.token()` to this router, and the
 * body schema no longer has a `setupToken` key at all, so a request carrying one is refused as an
 * unknown field (422) by the `.strict()` rule below rather than quietly stripped and answered.
 *
 * An administrator creating somebody else's account may NOT look that person's callsign up.
 * The result of a lookup is a name, a home address AND — since `59356c5` stopped discarding
 * `location` — callook's geocode of that address, stated to eight decimal places. Filling any of
 * them into a third party's profile makes GrantSpotter state, on that person's behalf, facts they
 * never gave it, and the coordinate makes that sharper rather than softer: a latitude at that
 * precision is the home address again, in a form the profile stores and the matcher reads. The
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
 *
 * WHETHER IT EXISTS AT ALL IS THE OPERATOR'S CALL. `index.ts` mounts this router only when
 * `CALLSIGN_LOOKUP_ENABLED` is true (it defaults to true). This is the one path in the product
 * that contacts a host publishing `Disallow: /` — see the header of `callsign/callook.ts` for why
 * RFC 9309 does not scope a user-initiated lookup, and the README section "The callsign lookup"
 * for the same argument written for a reader who is not holding the code. An operator who reads
 * that and disagrees must be able to act on it without patching the image, so there is a switch.
 * With it off the route is not registered and `/api/callsign/lookup` 404s; the profile form keeps
 * every field and the user types four of them, which is what it does today for every non-US
 * licensee anyway.
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

/** PLAN-LOCAL. The signed-in user, or `undefined` when the request carries no session. */
export interface CallsignCaller {
  id: string;
  role: 'admin' | 'member';
}

export interface CallsignRouterDeps {
  transport: CallsignTransport;
  /**
   * `setupToken: () => string | null` WAS HERE AND IS GONE (2026-08-11). It was the one-time
   * first-run token, read and never consumed, so that the setup screen's callsign panel could look
   * a callsign up before any account existed. That panel is gone; see the header for why the
   * privilege did not get to outlive it.
   */
  /**
   * Anonymous-tolerant, unlike `RouterDeps.currentUser`, which throws when there is no session:
   * this returns `undefined` and the handler refuses. It stays a value rather than becoming a
   * `requireAuth()` mount because the caller is also the rate-limit key — the handler needs the id,
   * not merely the guarantee that there is one — and because the unit suite swaps it for a stub.
   */
  sessionUser?: (req: Request) => CallsignCaller | undefined;
  /** Injected by the tests; production gets the module's own, built from the constants below. */
  limiter?: RateLimiter;
  /** Passed through to the client. Production leaves it at the client's own default. */
  timeoutMs?: number;
  /**
   * Where "callook.info asked us to wait" and "callook.info is answering us right now" are
   * remembered. Optional, and defaulted PER ROUTER rather than to a module-level singleton.
   *
   * Per router is one per process where it counts — the composition root builds this router once —
   * and one per app where it also counts, because a module-level ledger would carry one test's
   * `429 Retry-After: 120` into the next test's lookup and make a suite that answers questions
   * about bursts depend on the order it happens to run in.
   *
   * ONE PER PROCESS IS ALSO WHAT MAKES THE HOST'S LANE MEAN ANYTHING. Two routers would be two
   * lanes, and two lanes at one host is two simultaneous requests — which is the number this
   * bounds. Nothing here can enforce that on a caller who builds two routers; what it can do is
   * make the shared object the obvious thing to pass, which is why the composition root passes
   * nothing and takes this default.
   */
  cooldown?: HostCooldown;
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
 * WHICH MEANS A PRESS THAT MAKES NO REQUEST IS NOT RATIONED, and that is not a loophole, it is
 * the sentence above taken literally. `callsign/callook.ts` refuses a callsign the FCC did not
 * issue in this process, from a table core already holds, before any socket exists — callook
 * publishes FCC records and nothing else, so there is nothing to ask. Until 2026-08-04 the route
 * charged for it anyway: nine `DL1ABC` presses from one member returned 200 eight times and then
 * 429, with zero requests made to anybody, and the next press — with a real US callsign — was
 * refused for 600 seconds. The people that hit hardest are the international operators whose
 * whole experience of this feature is the `not_us` message, which exists specifically to tell them
 * nothing is wrong with their licence. Telling them that eight times and then locking the form is
 * the opposite of what it says.
 *
 * THERE ARE NOW FIVE WAYS A PRESS COSTS THE SOURCE NOTHING, three of which arrived on 2026-08-04
 * and one on 2026-08-09: a callsign the FCC did not issue, a string that is not a callsign at all,
 * a base URL on the hard blocklist, a host whose `Retry-After` has not run out, and a host this
 * process is already mid-question with. The first two were one case until the typo that reads as a
 * foreign licence was found (`callsign/shape.ts`), and splitting them changed nothing here: neither
 * becomes a request, so neither is charged. The cooldown case is the one that
 * matters most to the person: being told "the source asked us to wait two minutes" and ALSO being
 * charged for hearing it would mean a member who pressed the button eight times during a cooldown
 * came out the other side of it with no allowance left and still nothing filled in. A source asking
 * to be left alone is not the user spending their share, and neither is another person's press
 * getting to the one lane first.
 *
 * `wouldReachTheSource` is the predicate, and it is EXPORTED BY THE CLIENT rather than restated
 * here: it is the same function `lookupCallsign` reads for its own short-circuits, over the same
 * deps object, so the thing being rationed and the thing being counted cannot drift apart.
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
 *
 * `setupToken: z.string().min(1).max(256).optional()` WAS THE SECOND KEY AND IS GONE (2026-08-11).
 * Now that it is not declared, `.strict()` refuses it like any other unknown key, which is the
 * right answer for the only client that could still send one: it is holding a credential this
 * route no longer honours, and being told so beats being answered as though it had worked.
 */
const lookupBodySchema = z
  .object({
    callsign: z.string().min(1).max(16),
  })
  .strict();

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

  /**
   * ONE deps OBJECT, BUILT ONCE, READ BY BOTH THE PREDICATE AND THE CALL.
   *
   * `wouldReachTheSource` answers "does this press cost callook.info a request" for the SAME
   * configuration `lookupCallsign` is about to run under — the same base URL and the same cooldown
   * ledger. Asking the question against a different object is how the thing being rationed and the
   * thing being counted drift apart, which is the defect this route already had once, from the
   * other direction, when it could not ask at all.
   */
  const lookupDeps: CallsignLookupDeps = {
    transport: deps.transport,
    cooldown: deps.cooldown ?? createHostCooldown(),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  };

  router.post(
    '/lookup',
    asyncHandler(async (req, res) => {
      const body = lookupBodySchema.parse(req.body);

      /**
       * A SESSION, OR NOTHING. There is no second credential and no anonymous branch.
       *
       * There was one until 2026-08-11: a `tokenMatches(deps.setupToken(), body.setupToken)` arm
       * that answered an unauthenticated caller holding the one-time first-run token, on a rate
       * bucket of its own keyed `'setup'` — one bucket for the whole first-run path, deliberately
       * not per-IP, because `trust proxy` is on and a per-IP key is one the caller can mint a fresh
       * one of at will. Every word of that reasoning was sound and the branch is gone anyway: the
       * screen it served was deleted, so what it defended was a door with nothing behind it.
       *
       * That the door closed by itself once an account existed (`BootstrapState.token()` answers
       * `null` for good after the first user) is not an argument for keeping it. It bounded how
       * long the privilege lasted; it did not make an unauthenticated outbound-request trigger,
       * live on every fresh deployment, something anybody was watching.
       *
       * The rate key is therefore the caller's id and can be nothing else, which also removes the
       * one case where two different people shared a bucket.
       */
      const user = sessionUser(req);
      if (user === undefined) {
        throw new AppError('unauthorized', 'Sign in to look a callsign up.');
      }
      const rateKey = `user:${user.id}`;

      /**
       * The gate is on the REQUEST, so a press that cannot become one walks straight past it.
       *
       * Asked BEFORE `limiter.check`, not after, and that ordering is the whole of it: a member
       * who has genuinely spent their eight and then types a German callsign gets the `not_us`
       * sentence rather than a 429, because answering them costs callook.info nothing at all.
       *
       * The cost of letting it past is local and bounded — a whitespace strip, an upper-case, a
       * prefix test, a URL parse against a ten-name blocklist and one map read — and the caller is
       * already authenticated, so this is not a door anyone can reach without a session.
       * Authorisation above; rationing here.
       */
      if (wouldReachTheSource(body.callsign, lookupDeps)) {
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
        // person can click. Counting it AFTER instead would also have fixed the `not_us` charge,
        // and would have opened a worse hole — `check` and `recordFailure` are synchronous
        // neighbours today, so nothing can interleave between them; with an `await` in the middle,
        // eight concurrent presses would all pass a check that none of them had yet paid for.
        //
        // THE SAME PROPERTY IS WHY THE PREDICATE ABOVE CAN BE TRUSTED ABOUT THE HOST'S LANE. There
        // is no `await` anywhere between `wouldReachTheSource` and `lookupCallsign`'s claim of it —
        // an async function's body runs synchronously up to its first `await`, and the claim is
        // before that one — so a press cannot be charged here and then find the lane taken. If an
        // `await` is ever introduced between these two lines the failure is one press charged for a
        // request it did not make, never an unbounded request, because the claim is the authority
        // and it refuses.
        limiter.recordFailure(rateKey);
      }

      const result: CallsignLookupResult = await lookupCallsign(body.callsign, lookupDeps);

      res.status(200).json(result);
    }),
  );

  return router;
}
