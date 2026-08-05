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
import { createRateLimiter, type RateLimiter } from '../auth/rateLimit.js';
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
   * OPTIONAL, and it defaults to the window below, so that adding self-service enrolment did not
   * require editing `app.ts` — which builds this bundle and is outside this change's territory.
   * `app.ts` already defaults `loginLimiter` the same way; a test injects a tiny one to prove the
   * limiter engages without sending eleven real requests.
   */
  enrollLimiter?: RateLimiter;
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
 * THE ONE BUCKET THE ENROLMENT LIMITER COUNTS IN, and why it is a constant rather than a key.
 *
 * The login limiter is keyed on the normalized email, and its comment explains why it is not keyed
 * on `req.ip`: an account-side counter must not be resettable by anything the client controls.
 * Enrolment has no account yet, and the caller chooses EVERY field of the request — the code, the
 * email, the display name. There is therefore no client-supplied key that an attacker cannot mint
 * a fresh bucket of simply by changing it, and a limiter that can be reset by rotating a field is
 * decorative. A single fixed bucket is the only key that actually caps the guess rate, because it
 * is the only one the caller cannot vary.
 *
 * WHAT IT COSTS, said plainly: ten wrong codes in fifteen minutes closes self-enrolment for
 * everybody for the rest of that window, so somebody can make a nuisance of themselves. That is the
 * same trade this product already takes on sign-in, where five wrong passwords lock a named account
 * out; a fifteen-minute pause on a sign-up route is the milder of the two, and the alternative is
 * an unbounded guessing channel against a live credential. Only a WRONG CODE is charged — an
 * expired or exhausted one is a real code and its holder is not guessing — so an intake made
 * entirely of people with real codes never touches this counter at all.
 *
 * A SUCCESSFUL ENROLMENT USED TO RESET IT, on the reasoning that a real intake clears the counter
 * as it goes, and that was a hole rather than a kindness: it made the ceiling per-success instead
 * of per-window. MEASURED, 2026-08-05: nine wrong codes, one real redemption, five times over —
 * 45 guesses inside one fifteen-minute window. The reset is gone (see the handler), and the reason
 * the login limiter keeps its own is written where that one lives.
 *
 * IT ALSO BOUNDS THE WORK, AND UNTIL 2026-08-05 THIS PARAGRAPH SAID SO UNTRUTHFULLY. The handler
 * hashes the password with argon2id BEFORE it knows whether the code is any good — it has to,
 * because that hash is the only `await` and it must not sit inside the redemption transaction — so
 * every wrong guess costs this process ~19 MiB and tens of milliseconds. What used to stand here
 * was the claim that ten of those per window is "the ceiling on what an anonymous caller can make
 * an unauthenticated route do", and that was measurably false: `check()` ran before the hash and
 * `recordFailure()` after it, so every request that arrived before the first hashes completed
 * passed a check none of them had yet paid into. MEASURED on this host, 2026-08-05: one burst of
 * 240 concurrent wrong-code requests produced 240 argon2id hashes and 10.2 s of CPU — 240 answers
 * of "that code is not valid", not one of them charged in time to stop the next.
 *
 * A false statement about a security property is worse than no statement, because it is what the
 * next person reads instead of measuring. The mechanism that makes the sentence true is
 * `RateLimiter.begin`: the slot is taken BEFORE the hash starts and settled after it, so ten is the
 * ceiling on hashes IN FLIGHT as well as on failures per window. Re-measured with the same harness
 * (`api/authCost.test.ts`) after the change: 240 requests, 10 hashes.
 */
const ENROLLMENT_BUCKET = 'enrollment';

const ENROLLMENT_WINDOW_MS = 15 * 60 * 1000;
const ENROLLMENT_MAX_FAILURES = 10;

/**
 * HOW MANY TIMES ONE CODE MAY BE TOLD THAT AN ADDRESS ALREADY HAS AN ACCOUNT.
 *
 * THE DEFECT. Every holder of one valid code could ask this route about any address they liked:
 * 409 naming the address for a hit, 201 for a miss. MEASURED, 2026-08-05: 200 probes with a single
 * `maxUses: null` code, all 200 answered, nothing charged and nothing written down. A club
 * officer's code read out to thirty people was a membership oracle for the whole deployment, and
 * the deployment had no way to find out.
 *
 * THE CHOICE, and what it costs. The three honest options were to charge a use for the attempt, to
 * make the two answers indistinguishable, or to bound and record the question per code. The first
 * is refused by a test that already exists and by the product: a person who mistypes an address
 * that turns out to be their own must not burn one of their club's thirty places. The second is
 * what most of this file does elsewhere, and it is the wrong trade HERE, because the person who
 * most often meets this answer is not an attacker — it is somebody who enrolled last term and
 * forgot, and "we cannot tell you why that did not work" sends them to their officer instead of to
 * the sign-in screen. So: the answer stays useful and the QUESTION becomes limited and visible.
 *
 * KEYED ON THE CODE, which is the one key on this route that a caller cannot mint a fresh bucket
 * of. Email, display name and password are all free-form; the code is not, because a bucket only
 * ever accumulates against a code this deployment really issued — a wrong code is refused before
 * any of this — so rotating the field costs the caller a second real credential. It is the digest
 * that is the key, never the plaintext, for the same reason only the digest is stored.
 *
 * FIVE, and the number is a judgement about the legitimate case rather than a measurement: a
 * thirty-person intake produces a handful of people who already have accounts, spread over the
 * hours or days a code lives, and never five inside fifteen minutes. WHAT IT COSTS: once a code has
 * been told five times in one window, that code is paused — the sixth caller is answered "try again
 * shortly" even if they are a new person with a fresh address. That is a narrower version of the
 * trade the paragraph above already takes for wrong codes (ten of those pause enrolment for
 * EVERYBODY), it is bounded at fifteen minutes, and it is the price of not answering an unbounded
 * number of questions about who is a member here.
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
 * Somebody enrolled with an address that already has an account, and the transaction had already
 * started when we found out.
 *
 * THERE ARE NOW TWO CHECKS FOR ONE CONDITION, and the second is not a duplicate of the first. The
 * handler reads `findByEmail` up front, before the hash, because that is where the answer is
 * rationed and recorded per code and the rationing may not have an `await` inside it. This one is
 * inside the redemption transaction, where nothing can run between it and the INSERT, and it is the
 * one that is AUTHORITATIVE: the early read is stale the instant it returns, and only a check that
 * sits in the same synchronous stretch as the write can promise that two people enrolling with the
 * same address in the same fifty milliseconds do not both get an account. Thrown from in there it
 * also rolls the transaction back, which is what stops a mistyped address from spending one of a
 * club's thirty places.
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

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const users = createUserRepo(deps.db);
  const sessions = createSessionRepo(deps.db);
  const codes = createEnrollmentCodeRepo(deps.db);
  const enrollLimiter =
    deps.enrollLimiter ??
    createRateLimiter({ windowMs: ENROLLMENT_WINDOW_MS, maxFailures: ENROLLMENT_MAX_FAILURES });
  /**
   * A SECOND COUNTER, not a second key on the first one, because they ration different things and
   * must not be able to spend each other: the bucket above rations GUESSES AT A CODE and is one
   * bucket for the whole deployment, this one rations QUESTIONS ASKED WITH a code and there is one
   * per code. Never injected — the enrolment limiter is injectable only because a test needed a
   * tiny window without editing `app.ts` (see `AuthRouterDeps`), and nothing needs that here: five
   * conflicts is reachable in a test in five requests.
   */
  const conflictLimiter = createRateLimiter({
    windowMs: ENROLLMENT_WINDOW_MS,
    maxFailures: ENROLLMENT_CONFLICT_MAX,
  });
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
       * THE ONE PLACE THIS ROUTE ANSWERS "THAT ADDRESS ALREADY HAS AN ACCOUNT", and every line of
       * it runs without an `await`, on purpose.
       *
       * READ IT AS ONE STATEMENT: is this a code that could be redeemed right now, and does that
       * address already have an account, and has this code been told that fewer than five times in
       * the last fifteen minutes — then answer, and charge. Nothing can run between the reading of
       * the budget and the charging of it, so a hundred probes arriving together are counted as a
       * hundred and not as one; a version of this that read the budget here and charged it after
       * the hash below would be a fourth copy of the defect the rest of this handler exists to fix,
       * and a concurrent burst would walk past it exactly as the wrong-code burst used to.
       *
       * BEFORE THE HASH, so a probe costs this process a SHA-256 and two indexed reads rather than
       * 19 MiB of argon2id: the check that closes an oracle must not itself be a way to spend CPU.
       *
       * ONLY FOR A CODE THIS DEPLOYMENT WOULD HONOUR. `redeemableNow` answers undefined for a code
       * that was never issued, was revoked, expired or ran out, and those callers fall through to
       * the redemption below and are answered about the CODE, exactly as before — which is what
       * keeps this answer behind a credential instead of turning the route into an oracle for
       * everybody. It is also why the order is code first, address second.
       *
       * IT NOW ALSO RUNS BEFORE THE PASSWORD FLOOR, which moves one answer: somebody whose address
       * already has an account AND whose password is too short is told about the account rather
       * than about the password. That is the more useful of the two — the second one would have
       * them pick a new password and then find they did not need one — and neither answer spends a
       * use, so it costs them nothing either way.
       */
      const codeKey = hashEnrollmentCode(body.code);
      const live = codes.redeemableNow(body.code, nowISO);
      if (live !== undefined) {
        /**
         * THE REFUSAL COVERS EVERY ATTEMPT WITH THIS CODE, not only the ones that would have been
         * a conflict, and that is the whole reason it closes anything.
         *
         * A first draft charged the budget only when the address really did have an account, and
         * left everybody else to carry on — which reads well and answers the question anyway: past
         * the budget, 429 would have meant "that address is a member" and 201 "it is not", the same
         * oracle wearing a different status code. The test in `enroll.test.ts` that asserts an
         * unknown address gets the SAME answer as a known one is what caught it. So a code that has
         * been told five times in fifteen minutes stops enrolling anybody for the rest of that
         * window: the two answers are indistinguishable because there is only one of them.
         */
        const conflicts = conflictLimiter.check(codeKey);
        if (!conflicts.allowed) {
          throw new AppError(
            'rate_limited',
            'That enrollment code has been used to try several addresses that already have ' +
              'accounts. If one of them is yours, sign in instead. Otherwise try again shortly.',
            { retryAfterSec: conflicts.retryAfterSec },
          );
        }

        if (users.findByEmail(body.email) !== undefined) {
          conflictLimiter.recordFailure(codeKey);
          // Written down because the answer below is a fact about somebody else. It names the CODE
          // and never the address: an administrator needs to know which credential is being used
          // this way so they can revoke it, and a trail of every address that was asked about would
          // be the very list this limit exists to stop anybody building — kept for longer, and read
          // by more people, than the answer itself. Bounded at five rows per code per window,
          // because past that the request is refused above and never reaches here.
          appendAuditLog(deps.db, {
            userId: null,
            action: 'enrollment_code.conflict',
            entityType: 'enrollment_code',
            entityId: live.id,
            detail: JSON.stringify({ label: live.label }),
            atISO: nowISO,
          });
          throw new AppError(
            'conflict',
            `${body.email} already has an account. Sign in with it instead — an administrator ` +
              'can issue a new password if you have forgotten yours.',
          );
        }
      }

      /**
       * CLAIMED BEFORE THE HASH, RELEASED AFTER IT, and that is the fix for the third appearance of
       * one defect in this codebase.
       *
       * `check()` here and `recordFailure()` after the `await` below was a limit only for callers
       * who took turns. 240 concurrent wrong-code requests all read a counter at zero and all
       * hashed: measured at 240 argon2id hashes and 10.2 s of CPU on 2026-08-05, against a budget
       * of ten. `begin` takes the slot in the same breath as it reads the budget, so an attempt
       * that is still running counts exactly as much as one that has already failed — which is the
       * only way the number ten can be a statement about work rather than about answers.
       *
       * The slot is released in the `finally` below whatever happens, including on a thrown
       * `AppError`: a leaked slot is a permanent hole in the budget, and this route has no other
       * mechanism that would notice one.
       */
      const attempt = enrollLimiter.begin(ENROLLMENT_BUCKET);
      if (!attempt.started) {
        throw new AppError('rate_limited', 'Too many enrollment attempts. Try again later.', {
          retryAfterSec: attempt.retryAfterSec,
        });
      }

      try {
        // The password is checked BEFORE the code is spent, and the order is the whole point — it is
        // the same lesson the bootstrap handler above learned the hard way. `redeem` increments
        // `uses` the instant it succeeds, so a policy check after it would mean a person who typed a
        // short password got a 422 telling them to pick a longer one, having already burned one of
        // their club's thirty places on an account that was never created. A rejected body must cost
        // the holder nothing.
        try {
          assertPasswordPolicy(body.password);
        } catch (err) {
          if (err instanceof WeakPasswordError) {
            throw new AppError('validation_failed', err.message);
          }
          throw err;
        }

        // OUTSIDE THE TRANSACTION, and this line is why the transaction can be trusted. argon2id is
        // tens of milliseconds of real work and the only `await` on this path; it is precisely the
        // window in which two people redeeming the same single-use code overlap. Doing it here means
        // the transaction below contains no `await` at all, so nothing can run between the statement
        // that spends the use and the statement that creates the account.
        const passwordHash = await hashPassword(body.password);

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
            // THE RACE, AND NOTHING ELSE, now that the answer above is given before the hash.
            // Reaching here means the address had no account when this request started and had one
            // by the time the transaction ran — two people enrolling with the same address in the
            // same fifty milliseconds. Neither the budget nor the trail is touched, because both
            // exist to bound a question a caller can ASK, and nobody can ask for this: it needs an
            // account to appear mid-request, which is not something the caller decides.
            //
            // It still answers the same sentence, and it still rolls the transaction back, so the
            // loser of that race has not spent one of the club's places either.
            throw new AppError(
              'conflict',
              `${body.email} already has an account. Sign in with it instead — an administrator ` +
                'can issue a new password if you have forgotten yours.',
            );
          }
          throw err;
        }

        if (!outcome.ok) {
          // Only a wrong code is charged to the limiter. An expired, revoked or exhausted code was
          // really issued by this deployment, so its holder is not guessing, and charging them would
          // let one club's stale code lock out another club's live intake.
          if (outcome.refusal === 'unknown') attempt.charge();
          const refusal = REFUSAL[outcome.refusal];
          throw new AppError(refusal.code, refusal.message);
        }

        // NO `reset()` HERE, AND THAT IS THE POINT OF THIS LINE'S ABSENCE.
        //
        // A success used to clear the whole bucket, on the reasoning that a real intake clears the
        // counter as it goes. MEASURED, 2026-08-05: the holder of a five-use code alternated nine
        // wrong codes with one real redemption and fitted 45 wrong-code guesses into a single
        // fifteen-minute window against a ceiling of ten.
        //
        // The login limiter DOES reset on success and should, because its bucket is one account and
        // the person who just proved they own that account is clearing their own failures. This
        // bucket is the whole deployment and a success proves only that the caller holds SOME code,
        // which the nine guesses before it did not depend on. Ten guesses per window is now ten,
        // whatever else happens in that window.
        startSession(req, res, outcome.account.id);
        // The same shape `/auth/bootstrap` and `/auth/me` answer with, from the same projection:
        // never the password hash, never the ICS token.
        res.status(201).json({ user: toPublicUser(outcome.account) });
      } finally {
        // A no-op after `charge()`; the whole point of it is the paths that never reach a charge —
        // a weak password, a duplicate address, a revoked code, and any throw nobody predicted.
        attempt.release();
      }
    }),
  );

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const body = credentialsSchema.parse(req.body);
      // Keyed on the normalized email alone, deliberately not mixed with
      // req.ip. req.ip is derived from X-Forwarded-For once trust proxy is
      // set (app.ts), which the client controls: an IP-mixed key lets an
      // attacker mint a fresh bucket per request just by rotating that
      // header, making the lockout decorative. An account-side counter must
      // not be resettable by anything the client controls.
      const key = normalizeEmail(body.email);

      /**
       * THE SAME SHAPE THE ENROLMENT ROUTE HAD, closed the same way and in the same change.
       *
       * `check` here and `recordFailure` after the `await` below meant that five was the number of
       * SEQUENTIAL wrong passwords one account tolerated, not the number of concurrent argon2id
       * verifies one account could be made to run — every request that arrived before the first
       * verify returned passed a counter none of them had paid into. `begin` claims the slot in the
       * same breath as it reads the budget, so five is now five either way.
       *
       * WHAT THIS DOES NOT FIX, said plainly because the honest bound is narrower than it looks:
       * this bucket is keyed on the account, so it bounds the work per ACCOUNT, not the work per
       * SERVER. A caller who rotates the email address gets a fresh bucket each time, and
       * `verifyPasswordConstantTime` runs a real argon2id verify against a dummy hash even when no
       * such account exists — that is deliberate, it is what stops the route leaking which
       * addresses are accounts through response timing. Bounding total concurrent verifies would
       * need a gate above the key, and a global gate on sign-in is a lockout for every user in the
       * deployment at once: an anonymous caller who could hold it would be able to stop everybody
       * signing in, which is a worse failure than the one it would prevent. Left as it is,
       * deliberately, and reported rather than half-fixed.
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
        const passwordOk = await verifyPasswordConstantTime(user?.passwordHash, body.password);
        const ok = passwordOk && user !== undefined && !user.disabled;

        if (!ok || user === undefined) {
          attempt.charge();
          throw new AppError('unauthorized', 'Incorrect email or password.');
        }

        // Reset stays HERE and does not on the enrolment route, and the difference is what the
        // bucket names: this one is a single account, and the person who has just proved they own
        // it is clearing their own failed attempts.
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
