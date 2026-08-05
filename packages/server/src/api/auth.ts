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
import { asyncHandler } from './asyncHandler.js';
import { EMAIL_SHAPE } from './enrollment.js';
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
 * expired or exhausted one is a real code and its holder is not guessing — and a successful
 * enrolment resets the bucket, so a real intake clears the counter as it goes.
 *
 * IT ALSO BOUNDS THE WORK. The handler hashes the password with argon2id BEFORE it knows whether
 * the code is any good — it has to, because that hash is the only `await` and it must not sit
 * inside the redemption transaction — so every wrong guess costs this process ~19 MiB and tens of
 * milliseconds. Ten of those per window is the ceiling on what an anonymous caller can make an
 * unauthenticated route do, and it is the same bucket for the same reason.
 */
const ENROLLMENT_BUCKET = 'enrollment';

const ENROLLMENT_WINDOW_MS = 15 * 60 * 1000;
const ENROLLMENT_MAX_FAILURES = 10;

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
 * Somebody enrolled with an address that already has an account.
 *
 * A module-local error rather than a `findByEmail` pre-check in the handler, because the check has
 * to happen INSIDE the redemption transaction: a check up here would be separated from the INSERT
 * by the argon2id hash, which is the shape of every check-then-act defect in this codebase. Thrown
 * from inside the transaction it also rolls the transaction back, which is what stops a mistyped
 * email from spending one of a club's thirty places.
 *
 * `adminUsersRouter.ts` needs BOTH a pre-check and a catch of the raw SQLite unique-constraint
 * error, and the difference is instructive rather than an inconsistency: that route awaits argon2
 * between its check and its write, so its check really can go stale and the constraint really is
 * its last line. This one cannot — nothing runs between the check and the INSERT — so the
 * constraint here is a backstop that no ordering of requests can reach.
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

      const decision = enrollLimiter.check(ENROLLMENT_BUCKET);
      if (!decision.allowed) {
        throw new AppError('rate_limited', 'Too many enrollment attempts. Try again later.', {
          retryAfterSec: decision.retryAfterSec,
        });
      }

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
      const nowISO = new Date().toISOString();

      let outcome: Redemption<UserRecord>;
      try {
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
          // administrator can always answer "where did this account come from?" — and so the three
          // facts can never disagree. NEVER the code itself: an audit trail is read by more people,
          // and kept for longer, than anything else this route writes.
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
          throw new AppError('conflict', `${body.email} already has an account.`);
        }
        throw err;
      }

      if (!outcome.ok) {
        // Only a wrong code is charged to the limiter. An expired, revoked or exhausted code was
        // really issued by this deployment, so its holder is not guessing, and charging them would
        // let one club's stale code lock out another club's live intake.
        if (outcome.refusal === 'unknown') enrollLimiter.recordFailure(ENROLLMENT_BUCKET);
        const refusal = REFUSAL[outcome.refusal];
        throw new AppError(refusal.code, refusal.message);
      }

      enrollLimiter.reset(ENROLLMENT_BUCKET);
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
      // Keyed on the normalized email alone, deliberately not mixed with
      // req.ip. req.ip is derived from X-Forwarded-For once trust proxy is
      // set (app.ts), which the client controls: an IP-mixed key lets an
      // attacker mint a fresh bucket per request just by rotating that
      // header, making the lockout decorative. An account-side counter must
      // not be resettable by anything the client controls.
      const key = normalizeEmail(body.email);

      const decision = deps.loginLimiter.check(key);
      if (!decision.allowed) {
        throw new AppError('rate_limited', 'Too many sign-in attempts. Try again later.', {
          retryAfterSec: decision.retryAfterSec,
        });
      }

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
        deps.loginLimiter.recordFailure(key);
        throw new AppError('unauthorized', 'Incorrect email or password.');
      }

      deps.loginLimiter.reset(key);
      const at = new Date().toISOString();
      users.recordLogin(user.id, at);
      // Deliberately does NOT call sessions.removeAllForUser here: multiple
      // concurrent sessions per user (e.g. a laptop and a phone) are
      // intended. Revocation-on-login was reverted per fix round 1 — see
      // the Task 17 report.
      startSession(req, res, user.id);
      res.json({ user: toPublicUser({ ...user, lastLoginAt: at }) });
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
