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
import type { RateLimiter } from '../auth/rateLimit.js';
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
import { createSessionRepo } from '../db/repositories/sessions.js';
import { createUserRepo, normalizeEmail, toPublicUser } from '../db/repositories/users.js';
import { asyncHandler } from './asyncHandler.js';
import { AppError } from './errors.js';

export interface AuthRouterDeps {
  db: Db;
  config: AppConfig;
  bootstrap: BootstrapState;
  loginLimiter: RateLimiter;
}

const credentialsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
});

const bootstrapSchema = credentialsSchema.extend({
  token: z.string().min(1).max(256),
  displayName: z.string().max(120).optional(),
});

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const users = createUserRepo(deps.db);
  const sessions = createSessionRepo(deps.db);
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
      if (!deps.bootstrap.consume(body.token)) {
        throw new AppError('unauthorized', 'That bootstrap token is not valid.');
      }
      try {
        assertPasswordPolicy(body.password);
      } catch (err) {
        if (err instanceof WeakPasswordError) {
          throw new AppError('validation_failed', err.message);
        }
        throw err;
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

  router.post(
    '/auth/login',
    asyncHandler(async (req, res) => {
      const body = credentialsSchema.parse(req.body);
      const key = `${req.ip ?? 'unknown'}|${normalizeEmail(body.email)}`;

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
      // Single active session per user: without this, a session created at
      // bootstrap (or any earlier login) lingers forever, invisible to the
      // user who is now looking at a fresh cookie. removeAllForUser exists on
      // SessionRepo for exactly this.
      sessions.removeAllForUser(user.id);
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
