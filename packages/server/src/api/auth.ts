import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { BootstrapState } from '../auth/bootstrap.js';
import { requireAuth } from '../auth/middleware.js';
import {
  assertPasswordPolicy,
  hashPassword,
  verifyPasswordConstantTime,
  WeakPasswordError,
} from '../auth/password.js';
import {
  coarseOrigin,
  createConcurrencyGate,
  createRateLimiter,
  createThresholdNotice,
  QueueFullError,
  type RateLimiter,
} from '../auth/rateLimit.js';
import {
  newSessionId,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookieOptions,
  sessionIdHash,
  signSessionCookie,
} from '../auth/session.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/migrate.js';
import {
  createEnrollmentCodeRepo,
  hashEnrollmentCode,
  type EnrollmentRefusal,
  type Redemption,
} from '../db/repositories/enrollmentCodes.js';
import { appendAuditLog } from '../db/repositories/ingestion.js';
import { createSessionRepo } from '../db/repositories/sessions.js';
import {
  createUserRepo,
  normalizeEmail,
  toPublicUser,
  type UserRecord,
} from '../db/repositories/users.js';
import { EMAIL_SHAPE } from './adminUsersRouter.js';
import { asyncHandler } from './asyncHandler.js';
import { AppError, type ApiErrorCode } from './errors.js';

export interface AuthRouterDeps {
  db: Db;
  config: AppConfig;
  bootstrap: BootstrapState;
  loginLimiter: RateLimiter;
  /**
   * THE BUDGET FOR WRONG ENROLMENT CODES, and nothing else on that route — see
   * `ENROLLMENT_MAX_FAILURES` for what it is keyed on and what it deliberately does not gate.
   *
   * OPTIONAL, and it defaults to the window below, so that adding self-service enrolment did not
   * require editing `app.ts` — which builds this bundle. `app.ts` already defaults `loginLimiter`
   * the same way. Nothing injects it today: the shipped numbers are reachable in eleven requests,
   * and `enroll.test.ts` says why testing the configuration that ships is worth more than testing a
   * smaller one.
   */
  enrollGuessLimiter?: RateLimiter;
}

/**
 * The SIGN-IN body. `min(1)` is deliberate and must stay.
 *
 * A length floor belongs at the points that SET a credential, never at the point that
 * CHECKS one. Raising this to the policy minimum would (a) permanently lock out anyone
 * who already holds a shorter password — a restored database, a migration from an older
 * release, an account an operator inserted by hand — since there would then be no body
 * that both matches their password and passes the schema, and (b) leak the policy to an
 * unauthenticated attacker, because a below-floor guess would answer 422 where an
 * above-floor guess answers 401. Every wrong password must be the same 401.
 *
 * The floor for CREATING a credential is `assertPasswordPolicy` (auth/password.ts),
 * applied in the bootstrap handler below. It is the only route in the server that takes
 * a caller-chosen password: `adminUsersRouter` generates the passwords it stores.
 */
const credentialsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
});

const bootstrapSchema = credentialsSchema.extend({
  token: z.string().min(1).max(256),
  displayName: z.string().max(120).optional(),
});

/**
 * THE SELF-ENROLMENT BODY, and the field that is conspicuously absent from it.
 *
 * There is no `role`. Not "role, validated"; not "role, defaulted" — no role at all, so that the
 * only way this route could ever mint an administrator would be for somebody to add the field
 * here. zod strips keys an object schema does not declare, so a body carrying `"role":"admin"`
 * reaches the handler with that key gone, and the handler passes the literal `'member'`.
 *
 * `password` is `min(1)` for the same reason the sign-in schema is, but it does NOT stay there:
 * `assertPasswordPolicy` runs in the handler. A length floor in the schema would answer 422 for a
 * short password and something else for a long wrong one, which is a difference an attacker can
 * measure; the floor belongs at the point that SETS a credential, and it is enforced there.
 *
 * `code` is bounded at 128 characters rather than at the 20 a code actually is. A holder who pastes
 * their code with the dashes, or with a stray space, or in lower case, must be answered "that code
 * is not valid" and not "your request is malformed": every wrong code has to look the same, and a
 * length check in the schema would be a second, different answer that leaks where the boundary is.
 */
const enrollSchema = z.object({
  code: z.string().min(1).max(128),
  email: z.string().trim().min(3).max(254).regex(EMAIL_SHAPE, 'Not an email address.'),
  password: z.string().min(1).max(512),
  displayName: z.string().trim().max(120).optional(),
});

/**
 * WHICH BUCKET A WRONG ENROLMENT CODE IS COUNTED IN, and why it is no longer a constant.
 *
 * UNTIL 2026-08-05 IT WAS THE LITERAL STRING `'enrollment'` — one bucket for the whole deployment.
 * The reasoning written here was that the caller chooses every field of the request, so there is no
 * key they cannot mint a fresh bucket of, so the only key that caps anything is a fixed one. The
 * reasoning was sound and the conclusion was a deployment-wide off switch. MEASURED, 2026-08-05:
 * ten wrong codes from one stranger — no code, no account, no relationship to this deployment —
 * answered every subsequent enrolment with 429 for fifteen minutes, and 48 requests held it closed
 * for an hour. Every club on the instance, refused, by anybody.
 *
 * TWO THINGS CHANGED, and the key is only the second.
 *
 * FIRST, THE BUDGET IS NOW ONLY CONSULTED BY A CALLER WHO IS GUESSING. It sits on the branch that
 * answers "that code is not valid" and nowhere else. Somebody holding a code this deployment really
 * issued never reads it, never charges it and can never be refused by it, whatever anybody else has
 * been doing. That alone is what stops a stranger closing an intake: a guess and a redemption no
 * longer pass through the same gate.
 *
 * SECOND, IT IS KEYED ON THE CALLER'S ORIGIN as the deployment's own proxy reports it (`req.ip`;
 * `app.ts` sets `trust proxy` to 1, so that is the address the one hop in front of us wrote, not
 * one a client can put in a header when a proxy is really there). WHAT AN ATTACKER REACHES BY
 * CONTROLLING IT, said plainly because the last version of this comment guessed instead of saying:
 * a caller who can reach this process directly, with nothing in front of it, chooses `req.ip` and
 * can therefore mint an unlimited number of fresh buckets and make an unlimited number of guesses.
 * What that buys them is guesses at 2^100, which is worth nothing at any rate — a wrong code now
 * costs this process one SHA-256 and one indexed read, and no argon2id at all — and what it costs
 * them is the ability to refuse anybody but themselves. That is the right way round. A key nobody
 * can forge (the TCP peer) would be one value for every user behind the operator's tunnel, which is
 * the deployment-wide off switch again with extra steps.
 *
 * WHAT IT STILL COSTS, and it is not nothing: a club whose students all leave through one campus
 * NAT share one bucket, so ten MISTYPED codes from that building pause enrolment from that building
 * for the rest of the window. Only wrong codes are charged — an expired or exhausted one is a real
 * code and its holder is not guessing — so an intake in which people paste the code correctly never
 * touches it.
 *
 * A SUCCESSFUL ENROLMENT DOES NOT RESET IT. That was a hole rather than a kindness: it made the
 * ceiling per-success instead of per-window. MEASURED, 2026-08-05: nine wrong codes, one real
 * redemption, five times over — 45 guesses inside one fifteen-minute window.
 *
 * IT NO LONGER CLAIMS TO BOUND THE WORK, because it never did and something else does now. This
 * paragraph used to say that ten failures per window is the ceiling on argon2id hashes an anonymous
 * caller can start. It was false twice over: first because `check()` ran before the hash and
 * `recordFailure()` after it (240 concurrent wrong codes → 240 hashes, 10.2 s of CPU, measured),
 * and then because the fix for that charged legitimate enrolments to the same budget (30 students
 * with a valid code → 10 accounts, 20 refusals, measured). Both were the same mistake: a counter of
 * ANSWERS being asked to bound WORK. The work is bounded by `hashGate` below, which takes turns
 * between callers rather than refusing per caller, and by the ordering in the handler — a code this
 * deployment will not honour never reaches the hash at all.
 */
const ENROLLMENT_WINDOW_MS = 15 * 60 * 1000;
const ENROLLMENT_MAX_FAILURES = 10;

/**
 * HOW MANY argon2id OPERATIONS THIS PROCESS WILL HAVE IN FLIGHT AT ONCE, across both
 * unauthenticated routes that perform one.
 *
 * FOUR, matching libuv's default thread-pool size, which is where `@node-rs/argon2` actually runs:
 * past that the operating system is queueing these anyway, and a queue we can see is worth more
 * than one we cannot — it bounds peak resident memory at four times argon2id's 19 MiB, and it
 * gives `authCost.test.ts` a number to assert instead of a hope.
 */
const MAX_CONCURRENT_HASHES = 4;

/**
 * HOW MANY MAY BE WAITING FOR ONE OF THOSE FOUR SLOTS, and why a ceiling had to exist at all.
 *
 * THIS PARAGRAPH USED TO SAY THERE WAS NO CEILING, and said it as a virtue: "everything past it
 * waits and is then served; nothing is refused". MEASURED on this host, 2026-08-09: a stranger with
 * no code and no account, opening 512 connections and POSTing `/api/auth/login` with a fresh email
 * per request — which the `(peer, email)` sign-in counter can never fire on — took a student's
 * enrolment from 81 ms to 4,881 ms, and the figure rose in step with their connection count
 * (24 connections 243 ms, 96 → 967 ms, 256 → 2,507 ms) because the depth of the queue was theirs
 * to choose.
 * A caller who can choose everyone's wait can choose a wait longer than everyone's patience, at
 * which point every one of those hashes is CPU spent on somebody who has already closed the tab.
 * "Nothing is refused" was not generosity; it was the denial of service with the word removed.
 *
 * TWO HUNDRED AND FIFTY-SIX, derived rather than picked. Measured here, four-way concurrent
 * argon2id costs 42 ms a hash (1,536 verifies drained in 16.1 s at four at a time), so a full
 * queue drains in 256/4 x 42 ms = 2.7 s. That is the worst wait this gate will impose on anybody,
 * and it is the number to change if a deployment's hardware is slower — not the concurrency,
 * which is a property of the machine, but this, which is a promise about the wait.
 *
 * IT IS NOT A PER-CALLER BUDGET AND CANNOT BE SPENT ON ANYBODY ELSE'S BEHALF. The gate is
 * round-robin between callers and sheds whoever holds the largest share, so a flood displaces only
 * itself; 256 is reached by legitimate traffic only when 256 DIFFERENT people are waiting at once,
 * which is an order of magnitude past a club intake and is real load rather than an attack.
 */
const MAX_QUEUED_HASHES = 256;

/**
 * What a shed request is told to wait, and it is the honest number rather than a punitive one: the
 * queue in front of them drains in 2.7 s at worst, so the true answer is "about a second", and a
 * limiter that says fifteen minutes when it means one second teaches people to ignore it.
 */
const SHED_RETRY_AFTER_SEC = 1;

/**
 * HOW MANY FAILED SIGN-INS FROM ONE SOURCE NETWORK BEFORE AN OPERATOR IS TOLD, and the number
 * refuses nothing whatsoever.
 *
 * WHY IT EXISTS. MEASURED, 2026-08-09: 2,244 failed sign-ins arriving in twenty-one seconds
 * produced ZERO rows in `audit_log`. The per-`(peer, email)` counter below is the right shape for stopping
 * somebody guessing ONE person's password and is blind by construction to somebody who never
 * guesses the same address twice — and that caller is the one an operator most needs to know
 * about, because they are the one who was making everybody else wait. A control nobody can see
 * operating cannot be operated, and the ones this server already has were all invisible to exactly
 * the traffic that mattered.
 *
 * KEYED ON THE COARSENED TCP PEER, which no header can change. The reported origin would name the
 * actual client network behind a tunnel and is the more useful fact — and is precisely why it is
 * not used: a caller who can write it can hold every bucket below the threshold and be invisible
 * again. An unforgeable key that is sometimes coarse beats a precise one that can be evaded.
 *
 * FIFTY IN FIFTEEN MINUTES. Being wrong about this number costs one audit row per source network
 * per window and nothing else — nobody is refused, delayed, or told anything different — so it is
 * set where a busy campus NAT on results day will occasionally trip it rather than where only an
 * attack will.
 */
const FAILED_SIGN_IN_NOTICE = 50;
const SIGN_IN_NOTICE_WINDOW_MS = 15 * 60 * 1000;

/**
 * HOW MANY TIMES ONE CODE MAY BE TOLD, IN SO MANY WORDS, THAT AN ADDRESS ALREADY HAS AN ACCOUNT.
 *
 * THE DEFECT THIS BOUNDS. Every holder of one valid code could ask this route about any address
 * they liked: 409 naming the address for a hit, 201 for a miss. MEASURED, 2026-08-05: 200 probes
 * with a single `maxUses: null` code, all 200 answered, nothing charged and nothing written down.
 * A club officer's code read out to thirty people was a membership oracle for the whole deployment,
 * and the deployment had no way to find out.
 *
 * THE DEFECT THE FIRST FIX INTRODUCED, which is why the shape below is not the obvious one. The
 * budget was made to REFUSE: past five, that code answered 429 to everybody, so that the member and
 * non-member answers could not be told apart. It made the answers indistinguishable by making the
 * code unusable, and a shared credential that any caller can switch off is a denial-of-service
 * primitive with a five-request price tag. MEASURED, 2026-08-05: ONE returning student who already
 * had an account, pressing submit five times in good faith with the right password, closed her
 * club's intake for the other thirty for fifteen minutes; a stranger needed six requests and 20 an
 * hour to hold it closed indefinitely; and revoking and reissuing did not help, because five more
 * requests re-locked the new code.
 *
 * SO THE BUDGET NO LONGER REFUSES ANYTHING. It decides which of two answers a conflict gets:
 *
 *   WITHIN IT — the specific one. It names the address, says to sign in instead, costs no argon2id,
 *   spends no use, and is written to the audit log against the CODE. That answer is the whole
 *   reason this route does not simply say "that did not work": the person who meets it most often
 *   is not an attacker, it is somebody who enrolled last term and forgot, and a vague refusal sends
 *   them to their club officer instead of to the sign-in screen.
 *
 *   PAST IT — nothing is said early at all. The request goes on to do exactly what a real
 *   enrolment does: it pays the argon2id hash, enters the redemption transaction, and is refused
 *   there by the duplicate check with a sentence that names nobody. Nothing is logged, because past
 *   this point the questions are no longer being answered specifically and a row per question is
 *   the very list the limit exists to stop anybody building.
 *
 * WHAT THAT BUYS, and it is the point: the cheap answer becomes bounded and visible while the
 * expensive one stays available, so a legitimate person past the budget is inconvenienced by a
 * vaguer message and NOT locked out, and a caller probing addresses past the budget pays one
 * argon2id per address either way — the same cost as enrolling — instead of getting a free bit.
 *
 * WHAT IT DOES NOT BUY, stated rather than implied: past the budget a hit is still a 409 and a miss
 * is still a 201, so a caller who is willing to pay can still classify addresses. Making those two
 * identical would mean refusing to create the account for the miss, which is the denial this whole
 * paragraph exists to avoid. What a miss costs them is what it has always cost: one hash, one of
 * the club's places, an account row and an audit row with the code's id in it. That is the residual
 * and it is loud, which is the best available property.
 *
 * KEYED ON THE CODE'S DIGEST — never the plaintext, for the same reason only the digest is stored.
 * A caller cannot mint a fresh bucket by editing a field: a bucket only ever accumulates against a
 * code this deployment really issued, so rotating the key costs a second real credential. And
 * because exhausting a bucket no longer refuses anybody, filling one deliberately achieves nothing
 * except making one's own answers vaguer and more expensive.
 *
 * FIVE is a judgement about the legitimate case, not a measurement: a thirty-person intake produces
 * a handful of people who already have accounts, spread over the days a code lives, and rarely five
 * inside fifteen minutes.
 */
const ENROLLMENT_CONFLICT_MAX = 5;

/**
 * WHAT EACH REFUSAL SAYS, AND WHAT IT REFUSES TO SAY.
 *
 * `unknown` covers both a code this deployment never issued and a code its holder mistyped, because
 * those are the same event to us and must stay the same answer to them. It says nothing about
 * whether any other code exists, how many there are, or who holds one — the sentence would read
 * identically on a deployment with two hundred live codes and on one with none.
 *
 * The other three are reachable only by somebody holding a code this deployment really did issue,
 * so naming the state gives away nothing and withholding it would be cruelty dressed as security.
 * The exhausted message is the one that earns its length: a club officer who issues a thirty-use
 * code for an intake WILL have a thirty-first person arrive, that person has done nothing wrong,
 * and if the product answers them with "not valid" they will reasonably conclude it is broken and
 * stop — instead of sending one message to the officer who can issue another code in ten seconds.
 */
const REFUSAL: Record<EnrollmentRefusal, { code: ApiErrorCode; message: string }> = {
  unknown: {
    code: 'unauthorized',
    message:
      'That enrollment code is not valid. Check it with whoever gave it to you — the letters are ' +
      'not case-sensitive and the dashes do not matter.',
  },
  revoked: {
    code: 'forbidden',
    message:
      'That enrollment code has been withdrawn by an administrator. Ask whoever gave it to you ' +
      'for a new one.',
  },
  expired: {
    code: 'forbidden',
    message:
      'That enrollment code has expired. Ask whoever gave it to you for a new one — they can ' +
      'issue one immediately.',
  },
  exhausted: {
    code: 'forbidden',
    message:
      'That enrollment code has already been used the number of times it was issued for. Nothing ' +
      'is wrong with your details and you have not done anything wrong — ask the person who gave ' +
      'you the code to issue another one.',
  },
};

/**
 * THE TWO SENTENCES A CONFLICT GETS, and the only difference between them is how much they say.
 *
 * The specific one is for the person this answer was written for — somebody who enrolled last term
 * and has forgotten — and it names the address because that is what turns "it did not work" into
 * "go to the sign-in screen". It is rationed and recorded; see `ENROLLMENT_CONFLICT_MAX`.
 *
 * The generic one carries the same advice and no fact about anybody. It is what a caller gets once
 * that code has already been given the specific answer five times in a window, and it is also what
 * the loser of a genuine race gets. Both sentences end with the same instruction, so the person who
 * needs it is never left without it.
 */
function conflictNaming(email: string): string {
  return (
    `${email} already has an account. Sign in with it instead — an administrator can issue a new ` +
    'password if you have forgotten yours.'
  );
}

const CONFLICT_GENERIC =
  'That did not create an account, and nothing was spent. If the address you gave already has an ' +
  'account, sign in with it instead — an administrator can issue a new password if you have ' +
  'forgotten yours. Otherwise try again, or with a different address.';

/**
 * Somebody enrolled with an address that already has an account, and the transaction had already
 * started when we found out.
 *
 * THERE ARE TWO CHECKS FOR ONE CONDITION, and the second is not a duplicate of the first. The
 * handler reads `findByEmail` up front, before the hash, because that is where the specific answer
 * is rationed and recorded per code and the rationing may not have an `await` inside it. This one
 * is inside the redemption transaction, where nothing can run between it and the INSERT, and it is
 * the one that is AUTHORITATIVE: the early read is stale the instant it returns, and only a check
 * that sits in the same synchronous stretch as the write can promise that two people enrolling with
 * the same address in the same fifty milliseconds do not both get an account. Thrown from in there
 * it also rolls the transaction back, which is what stops a mistyped address from spending one of a
 * club's thirty places.
 *
 * IT IS ALSO THE ORDINARY PATH now, not only the race: once a code has spent its disclosure budget
 * the handler deliberately says nothing early and lets the request arrive here, having paid the
 * same argon2id a real enrolment pays. That is what makes a probe past the budget cost what an
 * enrolment costs instead of being the cheapest answer on the route.
 *
 * `adminUsersRouter.ts` needs a pre-check AND a catch of the raw SQLite unique-constraint error,
 * and the difference is instructive rather than an inconsistency: that route awaits argon2 between
 * its check and its write, so its check really can go stale and the constraint really is its last
 * line. The check that matters here cannot — nothing runs between it and the INSERT — so the
 * constraint is a backstop that no ordering of requests can reach.
 */
class DuplicateEmailError extends Error {
  constructor() {
    super('duplicate email');
    this.name = 'DuplicateEmailError';
  }
}

/**
 * THE CALLER, AS THE DEPLOYMENT'S OWN PROXY REPORTS THEM — the key for anything rationed per
 * caller rather than per credential.
 *
 * `app.ts` sets `trust proxy` to 1, so express takes the RIGHTMOST entry of `X-Forwarded-For`: the
 * one the single hop in front of this process wrote, not one a client can prepend. That is
 * trustworthy exactly when the documented deployment shape holds (one reverse proxy or tunnel) and
 * is chosen by the client when it does not. Every use of this value carries a comment saying which
 * of those two it is relying on.
 */
function reportedOrigin(req: Request): string {
  return req.ip === undefined || req.ip === '' ? 'unknown' : req.ip;
}

/**
 * THE CALLER'S TCP PEER, which no header can change and no client can choose.
 *
 * Behind a reverse proxy this is the proxy, one value for everybody — useless for telling two
 * clients apart and unforgeable. It is used where the cost of a forgeable key would be real
 * (sign-in, below) and `reportedOrigin` is used where the cost of a fixed key would be worse.
 */
function peerAddress(req: Request): string {
  const raw = req.socket.remoteAddress;
  return raw === undefined || raw === '' ? 'unknown' : raw;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const users = createUserRepo(deps.db);
  const sessions = createSessionRepo(deps.db);
  const codes = createEnrollmentCodeRepo(deps.db);
  const guessLimiter =
    deps.enrollGuessLimiter ??
    createRateLimiter({ windowMs: ENROLLMENT_WINDOW_MS, maxFailures: ENROLLMENT_MAX_FAILURES });
  /**
   * A SECOND COUNTER, not a second key on the first, because they ration different things and must
   * not be able to spend each other: the one above rations GUESSES AT A CODE and is per caller,
   * this one rations SPECIFIC ANSWERS GIVEN WITH a code and is per code. Never injected — the guess
   * limiter is injectable only because a test needed a tiny window without editing `app.ts` (see
   * `AuthRouterDeps`), and nothing needs that here: five is reachable in five requests.
   */
  const disclosureLimiter = createRateLimiter({
    windowMs: ENROLLMENT_WINDOW_MS,
    maxFailures: ENROLLMENT_CONFLICT_MAX,
  });
  /**
   * ONE GATE FOR BOTH ROUTES, because there is one CPU. Sign-in and enrolment are the only two
   * unauthenticated paths in this server that run argon2id, and a ceiling that either of them could
   * exceed by borrowing the other's headroom would not be a ceiling.
   *
   * SPLITTING IT PER ROUTE WAS THE OBVIOUS FIX AND IS THE WRONG ONE. The measured failure was
   * `/api/auth/login` starving `/api/auth/enroll`, so giving each its own gate makes that exact
   * probe come out clean — and leaves the same stranger able to make every MEMBER of the
   * deployment wait five seconds to sign in, which is the larger population and the more important
   * route. The thing being starved was never the enrolment route; it was everybody who was not the
   * attacker. So the round is between CALLERS and cuts across both routes: a student enrolling and
   * a member signing in are two lanes, and the flood is a third whatever it is aimed at.
   *
   * MEASURED, 2026-08-09, 512 connections rotating the email on `/api/auth/login` against a server
   * in its own process, with one student enrolling throughout. Three deployment shapes, because
   * the two halves of a lane are trustworthy in different ones:
   *
   *   shape                                   student's enrolment      audit rows
   *   one proxy in front (documented)         5,036 ms -> 330 ms       0 -> 2
   *   no proxy, attacker forges the header    5,133 ms -> 302 ms       0 -> 2
   *   one proxy AND a caller-chosen req.ip    5,070 ms -> 4,065 ms     0 -> 2
   *
   * Nothing legitimate was refused in any of the three, before or after: the enrolment was answered
   * 201 every time, and what changed is how long it took.
   *
   * THE THIRD ROW IS THE RESIDUAL AND IT IS STATED RATHER THAN ROUNDED OFF. It is a deployment in
   * which every caller shares one TCP peer AND `req.ip` is a value the caller writes — a proxy that
   * does not append `X-Forwarded-For`, or `trust proxy` set to more hops than there really are. In
   * that shape this process has no signal at all that distinguishes one caller from another, so no
   * scheduler could divide anything fairly and this one does not pretend to. What it still does is
   * bound the damage: the wait stops growing with the attacker's connection count and settles at
   * the queue's own drain time. The fix for that row is configuration, not code.
   */
  const hashGate = createConcurrencyGate({
    maxConcurrent: MAX_CONCURRENT_HASHES,
    maxQueued: MAX_QUEUED_HASHES,
  });
  /**
   * Never consulted before answering anybody and never able to refuse: it exists so that the
   * traffic the counters above are blind to leaves a mark. See `FAILED_SIGN_IN_NOTICE`.
   */
  const signInNotice = createThresholdNotice({
    windowMs: SIGN_IN_NOTICE_WINDOW_MS,
    threshold: FAILED_SIGN_IN_NOTICE,
  });

  /**
   * ONE ROW PER KEY PER WINDOW, and no more, for a thing that is happening to the deployment rather
   * than to a record in it.
   *
   * WHY IT EXISTS. Until 2026-08-05 a stranger could close self-enrolment for every club on the
   * instance with ten requests and the `audit_log` was EMPTY afterwards: the operator saw a page
   * refusing everybody with no record of when it started, roughly where from, or that a limiter was
   * involved at all. A control whose operation is invisible cannot be operated.
   *
   * WHY IT IS BOUNDED. The row is written by the request that CLOSES a budget, never by the ones
   * refused afterwards, so a caller who keeps knocking writes one row per fifteen minutes rather
   * than one per request — an audit trail an attacker can fill at will is an audit trail that hides
   * everything else in it.
   */
  const announced = new Map<string, number>();
  function announceOnce(key: string, row: Parameters<typeof appendAuditLog>[1]): void {
    const nowMs = Date.now();
    const last = announced.get(key);
    if (last !== undefined && nowMs - last < ENROLLMENT_WINDOW_MS) return;
    // Swept here rather than on a timer: the map is only ever read on this path, so the only moment
    // a stale entry costs anything is the moment we are already looking at it. Without this a
    // caller rotating the key would grow it without bound, which is the memory version of the
    // unbounded audit trail this function exists to prevent.
    for (const [seen, at] of announced) if (nowMs - at >= ENROLLMENT_WINDOW_MS) announced.delete(seen);
    announced.set(key, nowMs);
    appendAuditLog(deps.db, row);
  }

  /**
   * THE ONE PLACE EITHER UNAUTHENTICATED ROUTE RUNS argon2id, and the only place that knows what a
   * shed looks like to a person.
   *
   * The lane is the pair the gate takes turns over: the TCP peer, which nobody can forge, and the
   * address our own proxy reported, which tells two users of one tunnel apart. Neither is
   * trustworthy alone and `QueueLane` says why the round is nested over both.
   *
   * A SHED IS A 429 AND NOT A 500, because it is a true statement about capacity rather than a
   * fault, and it is deliberately the same 429 on both routes and for every caller: it depends on
   * queue occupancy and on nothing about the address, the code or the password, so it cannot be
   * used to tell any of those apart. Nothing has been spent when it is thrown — no argon2id, no
   * enrolment use, no failure charged to any budget — so retrying really does cost the caller
   * nothing but the wait.
   */
  async function hashUnderGate<T>(req: Request, work: () => Promise<T>): Promise<T> {
    const peer = peerAddress(req);
    const origin = reportedOrigin(req);
    try {
      return await hashGate.run({ peer, origin }, work);
    } catch (err) {
      if (!(err instanceof QueueFullError)) throw err;
      // One row per source per window, by the same rule the other two announcements follow: the
      // caller being shed is by definition the one sending the most, and a row per shed request
      // would be an audit trail they could fill at will. Coarsened, because this row outlives the
      // incident. The peer is first because it is the half nobody can forge.
      announceOnce(`shed:${coarseOrigin(peer)}|${coarseOrigin(origin)}`, {
        userId: null,
        action: 'auth.hash_queue_shed',
        entityType: 'auth',
        entityId: coarseOrigin(peer),
        detail: JSON.stringify({
          reportedOrigin: coarseOrigin(origin),
          maxQueued: MAX_QUEUED_HASHES,
          maxConcurrent: MAX_CONCURRENT_HASHES,
        }),
        atISO: new Date().toISOString(),
      });
      throw new AppError(
        'rate_limited',
        'This server is already doing as much password checking as it can right now. Nothing is ' +
          'wrong with your details, nothing has been used up, and nobody needs to do anything ' +
          'about it — wait a moment and try again.',
        { retryAfterSec: SHED_RETRY_AFTER_SEC },
      );
    }
  }

  const router = Router();

  function startSession(req: Request, res: Response, userId: string): void {
    const rawId = newSessionId();
    sessions.create({
      id: sessionIdHash(rawId),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      userAgent: (req.header('user-agent') ?? '').slice(0, 255),
    });
    res.cookie(
      SESSION_COOKIE,
      signSessionCookie(rawId, deps.config.sessionSecret),
      sessionCookieOptions(req),
    );
  }

  router.get('/auth/bootstrap-status', (_req, res) => {
    res.json({ required: deps.bootstrap.required() });
  });

  router.post(
    '/auth/bootstrap',
    asyncHandler(async (req, res) => {
      const body = bootstrapSchema.parse(req.body);

      if (!deps.bootstrap.required()) {
        throw new AppError('conflict', 'An account already exists; bootstrap is closed.');
      }

      // The password is checked BEFORE the token is consumed, and the order is the
      // whole point. `consume` sets the one-time token to null on a match, so when
      // this ran after it, an operator who typed a short password got a 422 telling
      // them to pick a longer one — and the token they had just copied out of
      // `docker logs` was already spent. Every retry, correct token and good password,
      // then answered 401 "That bootstrap token is not valid", while bootstrap-status
      // went on reporting `required: true` and the first-run screen went on inviting
      // them to try. Restarting the container to mint a fresh token was the only way
      // in. A rejected body must cost the operator nothing; the token is spent only by
      // an attempt that would otherwise have created the account.
      try {
        assertPasswordPolicy(body.password);
      } catch (err) {
        if (err instanceof WeakPasswordError) {
          throw new AppError('validation_failed', err.message);
        }
        throw err;
      }

      if (!deps.bootstrap.consume(body.token)) {
        throw new AppError('unauthorized', 'That bootstrap token is not valid.');
      }

      const user = users.create({
        email: body.email,
        passwordHash: await hashPassword(body.password),
        role: 'admin',
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      });
      startSession(req, res, user.id);
      res.status(201).json({ user: toPublicUser(user) });
    }),
  );

  /**
   * Is self-enrolment available at all right now?
   *
   * ONE BOOLEAN, and it is the only thing about enrollment codes that an anonymous caller can
   * learn. It exists because the alternative is worse for everyone: without it the sign-in screen
   * either always shows an "I have an enrollment code" link — sending people who have no code down
   * a road that ends in a refusal on a deployment that has never issued one — or never shows it,
   * leaving the club's thirty students to be told the URL by word of mouth.
   *
   * WHAT IT DELIBERATELY DOES NOT ANSWER: which code, how many codes, when they expire, who issued
   * them, or whether any particular code is among them. `true` on a deployment with one live code
   * is byte-identical to `true` on a deployment with two hundred, and knowing that the door is
   * unlocked is worth nothing without the key — a redemption still costs a guess against 100 bits,
   * through the rate limiter. The admin list route, which answers all of those questions, is behind
   * `requireAdmin` for exactly that reason.
   *
   * Not rate-limited: it takes no input, so there is nothing to guess at, and repeating it a
   * thousand times yields the same bit a thousand times.
   */
  router.get('/auth/enrollment-open', (_req, res) => {
    res.json({ open: codes.anyOpen(new Date().toISOString()) });
  });

  router.post(
    '/auth/enroll',
    asyncHandler(async (req, res) => {
      const body = enrollSchema.parse(req.body);

      const nowISO = new Date().toISOString();

      /**
       * THE PASSWORD FLOOR FIRST, BEFORE ANYTHING THAT DEPENDS ON THE ADDRESS OR THE CODE, and this
       * ordering is a security property rather than a matter of taste.
       *
       * MEASURED, 2026-08-05, with the floor checked after the address: one valid code and a
       * ONE-CHARACTER password answered 409 "<address> already has an account" for a member and 422
       * "Password must be at least 12 characters." for anybody else — and the 422 was charged to no
       * budget, written to no log and cost no argon2id. 2,000 addresses were classified in 2,983 ms,
       * which is 2.4 million an hour, with nothing created and nothing spent. The route's own sign-up
       * screen checks this floor before it POSTs, so that branch was unreachable from the product
       * and existed only for somebody using it as a directory.
       *
       * A cheap invalid input must never be able to separate two answers that the design has decided
       * are worth separating expensively. This check depends on nothing but the password: it answers
       * identically for a member, a stranger, a valid code and a wrong one, so it cannot be used to
       * tell any of them apart.
       *
       * It also still runs before the code is spent, which is the reason it was first put here: a
       * person who types a short password must not have burned one of their club's thirty places on
       * an account that was never created.
       */
      try {
        assertPasswordPolicy(body.password);
      } catch (err) {
        if (err instanceof WeakPasswordError) {
          throw new AppError('validation_failed', err.message);
        }
        throw err;
      }

      /**
       * THE CODE, SECOND, AND A CODE THIS DEPLOYMENT WILL NOT HONOUR GOES NO FURTHER.
       *
       * It does not reach the address lookup, so no wrong guess can ask about anybody; it does not
       * reach argon2id, which is what makes the wrong-code burst cheap for this process rather than
       * expensive (240 concurrent wrong codes used to cost 240 hashes and 10.2 s of CPU — now they
       * cost 240 SHA-256s and one indexed read each); and it is answered about the CODE, in the
       * words `REFUSAL` holds, which is all any of these callers can be told.
       */
      const seen = codes.inspect(body.code, nowISO);
      if (!seen.ok) {
        if (seen.refusal === 'unknown') {
          /**
           * THE ONLY BUDGET A GUESS TOUCHES, and the only branch that touches it.
           *
           * Check and charge with no `await` between them, so a burst is counted as a burst. And
           * NOTHING ELSE ON THIS ROUTE READS THIS COUNTER: somebody holding a code this deployment
           * really issued cannot be refused by it however hard a stranger has been knocking, which
           * is what stops ten wrong codes from closing an intake. Being keyed per caller as well is
           * belt to that brace; see `ENROLLMENT_MAX_FAILURES` for what a forged key does and does
           * not buy.
           */
          const origin = reportedOrigin(req);
          const guesses = guessLimiter.check(origin);
          if (!guesses.allowed) {
            throw new AppError(
              'rate_limited',
              'Too many enrollment codes have been tried from this connection recently. Nothing ' +
                'is wrong with a code you were given — wait and try it again.',
              { retryAfterSec: guesses.retryAfterSec },
            );
          }
          guessLimiter.recordFailure(origin);
          if (!guessLimiter.check(origin).allowed) {
            // The request that CLOSED the budget writes the one row for this window. An operator
            // who finds enrolment refusing somebody needs to be able to see that a limiter did it
            // and roughly where from; `coarseOrigin` keeps that to a /24 or a /48, because an audit
            // row outlives the incident. No address and no code: the caller had neither.
            announceOnce(`guess:${origin}`, {
              userId: null,
              action: 'enrollment.code_guessing',
              entityType: 'enrollment',
              entityId: coarseOrigin(origin),
              detail: JSON.stringify({
                failures: ENROLLMENT_MAX_FAILURES,
                windowSec: ENROLLMENT_WINDOW_MS / 1000,
              }),
              atISO: nowISO,
            });
          }
        }
        const refusal = REFUSAL[seen.refusal];
        throw new AppError(refusal.code, refusal.message);
      }

      /**
       * THE ADDRESS, THIRD, AND ONLY FOR SOMEBODY HOLDING A LIVE CODE.
       *
       * Every line runs without an `await`: the budget is read and charged in one synchronous
       * stretch, so a hundred probes arriving together are counted as a hundred and not as one.
       *
       * PAST THE BUDGET THIS BLOCK SIMPLY DOES NOTHING, and the request carries on to pay the same
       * argon2id and enter the same transaction as a real enrolment, where the duplicate check
       * refuses it with a sentence that names nobody. That is the difference between rationing an
       * ANSWER and rationing a SERVICE: the previous version answered 429 here, which meant five
       * requests from anybody — or five honest presses from one returning student — stopped that
       * code enrolling the other twenty-nine for fifteen minutes. See `ENROLLMENT_CONFLICT_MAX`.
       */
      const codeKey = hashEnrollmentCode(body.code);
      if (disclosureLimiter.check(codeKey).allowed && users.findByEmail(body.email) !== undefined) {
        disclosureLimiter.recordFailure(codeKey);
        // Written down because the answer below is a fact about somebody else. It names the CODE
        // and never the address: an administrator needs to know which credential is being used
        // this way so they can revoke it, and a trail of every address that was asked about would
        // be the very list this limit exists to stop anybody building — kept for longer, and read
        // by more people, than the answer itself. Bounded at five rows per code per window,
        // because past that this block is skipped entirely.
        appendAuditLog(deps.db, {
          userId: null,
          action: 'enrollment_code.conflict',
          entityType: 'enrollment_code',
          entityId: seen.id,
          detail: JSON.stringify({ label: seen.label }),
          atISO: nowISO,
        });
        if (!disclosureLimiter.check(codeKey).allowed) {
          // The answer that spent the budget says so, once per code per window. This is the row an
          // administrator acts on: it names a credential they can revoke, and unlike the old
          // behaviour revoking now actually helps, because nothing about this state refuses anybody
          // and so nothing about it can be re-created against the replacement code.
          announceOnce(`disclosure:${codeKey}`, {
            userId: null,
            action: 'enrollment_code.conflict_paused',
            entityType: 'enrollment_code',
            entityId: seen.id,
            detail: JSON.stringify({
              label: seen.label,
              answers: ENROLLMENT_CONFLICT_MAX,
              windowSec: ENROLLMENT_WINDOW_MS / 1000,
            }),
            atISO: nowISO,
          });
        }
        throw new AppError('conflict', conflictNaming(body.email));
      }

      /**
       * OUTSIDE THE TRANSACTION, AND INSIDE THE GATE.
       *
       * Outside the transaction because argon2id is tens of milliseconds of real work and the only
       * `await` on this path; it is precisely the window in which two people redeeming the same
       * single-use code overlap. Doing it here means the transaction below contains no `await` at
       * all, so nothing can run between the statement that spends the use and the statement that
       * creates the account.
       *
       * Inside the gate because this is the expensive thing, and the expensive thing is what wants
       * bounding. The gate QUEUES: thirty students pressing submit together all get accounts, four
       * hashes at a time. What used to stand here was a failure budget claiming a slot for every
       * attempt including the successful ones, and it answered twenty of those thirty students
       * "Too many enrollment attempts. Try again later."
       *
       * The queue is now bounded and takes turns between callers, which is what stopped somebody
       * else's flood on the sign-in route deciding how long this student waits — see
       * `MAX_QUEUED_HASHES`. A student can still be shed, but only by being the largest single
       * contributor to the backlog themselves, and nothing of theirs is spent when they are: the
       * code has not been redeemed and no budget has been charged at this point in the handler.
       */
      const passwordHash = await hashUnderGate(req, () => hashPassword(body.password));

      let outcome: Redemption<UserRecord>;
      try {
        // `nowISO` is the one read at the top of this handler — one instant per request, so the
        // spent use, the account and the audit row all carry the same timestamp, and so the
        // expiry this redemption is tested against is the one the answer above was decided with.
        outcome = codes.redeem({ plaintext: body.code, nowISO }, (code) => {
          if (users.findByEmail(body.email) !== undefined) throw new DuplicateEmailError();
          const created = users.create({
            email: body.email,
            passwordHash,
            // A LITERAL, not a parameter, not a default, not a variable. Enrolment produces
            // members; the only ways to become an administrator are the first-run token and an
            // existing administrator promoting you.
            role: 'member',
            ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
          });
          // Written inside the same transaction as the account and the spent use, so an
          // administrator can always answer "where did this account come from?" — and so the
          // three facts can never disagree. NEVER the code itself: an audit trail is read by more
          // people, and kept for longer, than anything else this route writes.
          appendAuditLog(deps.db, {
            userId: created.id,
            action: 'user.enroll',
            entityType: 'user',
            entityId: created.id,
            detail: JSON.stringify({ enrollmentCodeId: code.id, label: code.label }),
            atISO: nowISO,
          });
          return created;
        });
      } catch (err) {
        if (err instanceof DuplicateEmailError) {
          // TWO WAYS TO ARRIVE HERE, and they get the same sentence because the caller may not be
          // told which. Either this code has already given its five specific answers this window,
          // or the address had no account when the request started and had one by the time the
          // transaction ran. Both have now paid the same argon2id an enrolment pays, which is the
          // point: past the budget, asking about a member and asking about a stranger cost the
          // same, and neither of them is refused a place they were entitled to — the transaction
          // rolled back, so no use was spent.
          throw new AppError('conflict', CONFLICT_GENERIC);
        }
        throw err;
      }

      if (!outcome.ok) {
        // NOT CHARGED TO THE GUESS BUDGET, and this is not the wrong-code path. `inspect` said this
        // code was live a few milliseconds ago, so reaching here means the row moved underneath the
        // hash — the last place was taken, or an administrator revoked it in that instant. That
        // person is holding a real credential and is not guessing at anything.
        const refusal = REFUSAL[outcome.refusal];
        throw new AppError(refusal.code, refusal.message);
      }

      // NO `reset()` HERE, AND THAT IS THE POINT OF THIS LINE'S ABSENCE.
      //
      // A success used to clear the guess bucket, on the reasoning that a real intake clears the
      // counter as it goes. MEASURED, 2026-08-05: the holder of a five-use code alternated nine
      // wrong codes with one real redemption and fitted 45 wrong-code guesses into a single
      // fifteen-minute window against a ceiling of ten. Holding SOME code says nothing about the
      // nine guesses before it, which did not depend on it.
      startSession(req, res, outcome.account.id);
      // The same shape `/auth/bootstrap` and `/auth/me` answer with, from the same projection:
      // never the password hash, never the ICS token.
      res.status(201).json({ user: toPublicUser(outcome.account) });
    }),
  );

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const body = credentialsSchema.parse(req.body);
      /**
       * THE ACCOUNT AND THE TCP PEER, AND NOT `req.ip`.
       *
       * THE HALF THAT WAS ALREADY RIGHT. This key must not contain anything the client can rewrite.
       * `req.ip` follows `X-Forwarded-For` (`trust proxy` is set in `app.ts`), so a caller reaching
       * this process directly can mint a fresh bucket per request by rotating that header — which a
       * reviewer demonstrated once already, and which `test/api.auth.test.ts` pins.
       * `req.socket.remoteAddress` is the TCP peer: no header changes it and no client chooses it.
       *
       * THE HALF THAT WAS WRONG. Keyed on the address ALONE, the bucket was a weapon anybody could
       * point at anybody: the email is a value the CALLER supplies, so five wrong guesses at a name
       * a stranger picked refused that person's own correct password. MEASURED, 2026-08-05: 24
       * requests held one named officer out of their account for an hour, and no audit row was
       * written. Adding the peer means a stranger's failures accumulate against THEIR OWN
       * connection and the owner, signing in from anywhere else, never meets them.
       *
       * WHAT THIS DOES NOT FIX, said rather than implied. Behind a reverse proxy every client
       * shares one peer address, so on the documented deployment shape this composite collapses
       * back to the account and the lockout is still reachable by anybody who can get through the
       * tunnel. Closing that needs a client identity that is neither forgeable nor constant, and
       * this deployment has none: the only per-client value that survives a proxy is a header. The
       * alternative — keying on that header — trades a targeted lockout for unlimited password
       * guessing against every account at once, which is the worse of the two. Left here, in the
       * open, rather than papered over.
       */
      const key = `${peerAddress(req)} ${normalizeEmail(body.email)}`;

      /**
       * THE SAME SHAPE THE ENROLMENT ROUTE HAD, closed the same way and in the same change.
       *
       * `check` here and `recordFailure` after the `await` below meant that five was the number of
       * SEQUENTIAL wrong passwords one account tolerated, not the number of concurrent argon2id
       * verifies one account could be made to run — every request that arrived before the first
       * verify returned passed a counter none of them had paid into. `begin` claims the slot in the
       * same breath as it reads the budget, so five is now five either way.
       *
       * WHAT IT BOUNDS AND WHAT SOMETHING ELSE BOUNDS. This bucket bounds ATTEMPTS against one
       * account from one connection; it does not bound the work per SERVER, because a caller who
       * rotates the email address gets a fresh bucket each time and `verifyPasswordConstantTime`
       * runs a real argon2id verify against a dummy hash even when no such account exists — which
       * is deliberate, and is what stops the route leaking which addresses are accounts through
       * response timing. IT IS THEREFORE BLIND, BY CONSTRUCTION, TO THE CHEAPEST FLOOD THERE IS,
       * and that is not a defect in the key — a key that caught it would be a key an attacker
       * could point at a named person. What that blindness cost was measured on 2026-08-09 and is
       * answered in two other places rather than here: `MAX_QUEUED_HASHES`, so a caller sending a
       * fresh address every time gets one caller's share of the CPU instead of all of it, and
       * `FAILED_SIGN_IN_NOTICE`, so the operator finds out.
       *
       * This paragraph used to end by declining to bound the per-server work, on the grounds that
       * "a global gate on sign-in is a lockout for every user in the deployment at once", and was
       * then rewritten to say that a gate which QUEUES refuses nobody. Both were half right. A
       * shared queue with no ceiling and no notion of whose turn it is refuses nobody and starves
       * everybody: 512 connections here took a student's enrolment to 4,881 ms. What makes the
       * shared gate safe is not that it queues, it is that it takes turns.
       */
      const attempt = deps.loginLimiter.begin(key);
      if (!attempt.started) {
        throw new AppError('rate_limited', 'Too many sign-in attempts. Try again later.', {
          retryAfterSec: attempt.retryAfterSec,
        });
      }

      try {
        // Finding 2: never branch on "was a user found?" before verifying — that
        // reintroduces the account-existence timing leak
        // verifyPasswordConstantTime exists to close. user?.passwordHash is
        // passed straight through; whether the user exists, is disabled, or
        // typed the wrong password is decided only after the one argon2id
        // verify has already run.
        const user = users.findByEmail(body.email);
        const passwordOk = await hashUnderGate(req, () =>
          verifyPasswordConstantTime(user?.passwordHash, body.password),
        );
        const ok = passwordOk && user !== undefined && !user.disabled;

        if (!ok || user === undefined) {
          attempt.charge();
          /**
           * COUNTED HERE AND NOWHERE EARLIER, so the row means what it says. A request refused by
           * the schema, by the bucket above or by the gate is not a failed sign-in — it is a
           * request that never reached a password — and rolling those in would make the number an
           * operator sees stop being "somebody is trying passwords".
           *
           * The count is per coarsened TCP PEER and not per account: the traffic that produced no
           * audit rows at all was a caller who never used the same address twice, and the only
           * thing every one of those requests had in common was where it came from.
           */
          const coarsePeer = coarseOrigin(peerAddress(req));
          if (signInNotice.crossed(coarsePeer)) {
            appendAuditLog(deps.db, {
              userId: null,
              action: 'auth.failed_sign_ins',
              entityType: 'auth',
              entityId: coarsePeer,
              // Never an address, and never how many DISTINCT addresses were tried: the second
              // would be the more useful signal and it is also a list of who was asked about,
              // kept for longer and read by more people than the answers were.
              detail: JSON.stringify({
                failures: FAILED_SIGN_IN_NOTICE,
                windowSec: SIGN_IN_NOTICE_WINDOW_MS / 1000,
              }),
              atISO: new Date().toISOString(),
            });
          }
          throw new AppError('unauthorized', 'Incorrect email or password.');
        }

        // Reset stays HERE and does not on the enrolment route, and the difference is what the
        // bucket names: this one is one account reached from one connection, and the person who has
        // just proved they own that account is clearing their own failed attempts. The enrolment
        // guess bucket is not owned by anybody, so nothing anybody does there can clear it.
        deps.loginLimiter.reset(key);
        const at = new Date().toISOString();
        users.recordLogin(user.id, at);
        // Deliberately does NOT call sessions.removeAllForUser here: multiple
        // concurrent sessions per user (e.g. a laptop and a phone) are
        // intended. Revocation-on-login was reverted per fix round 1 — see
        // the Task 17 report.
        startSession(req, res, user.id);
        res.json({ user: toPublicUser({ ...user, lastLoginAt: at }) });
      } finally {
        attempt.release();
      }
    }),
  );

  router.post('/auth/logout', (req, res) => {
    // Finding 1: a session row's existence is not validity — but logout only
    // ever needs to delete the row the *current, already-authenticated*
    // request resolved. req.sessionKey is set by auth/middleware.ts's
    // attachUser, which re-checks expiresAt itself before setting it (see
    // Task 17 report), so there is nothing further to validate here.
    if (req.sessionKey !== undefined) sessions.remove(req.sessionKey);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth(), (req, res) => {
    const user = req.auth === undefined ? undefined : users.findById(req.auth.id);
    if (user === undefined) throw new AppError('unauthorized', 'Sign in to continue.');
    res.json({ user: toPublicUser(user) });
  });

  return router;
}
