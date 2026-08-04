import type { RequestHandler } from 'express';
import { AppError } from '../api/errors.js';
import type { AuthedUser } from '../api/types.js';
import type { SessionRepo } from '../db/repositories/sessions.js';
import type { Role, UserRepo } from '../db/repositories/users.js';
import { SESSION_COOKIE, sessionIdHash, verifySessionCookie } from './session.js';

export interface AuthDeps {
  users: UserRepo;
  sessions: SessionRepo;
  sessionSecret: string;
}

/** Only rewrite last_seen_at when it is this stale, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Populates req.auth when the request carries a valid session. Never rejects:
 * anonymous requests simply continue with req.auth undefined, and the route
 * guards decide what that means.
 */
export function attachUser(deps: AuthDeps): RequestHandler {
  return (req, _res, next) => {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const raw = cookies?.[SESSION_COOKIE];
    if (typeof raw !== 'string') return next();

    const rawId = verifySessionCookie(raw, deps.sessionSecret);
    if (rawId === null) return next();

    const key = sessionIdHash(rawId);
    const session = deps.sessions.find(key);
    if (session === undefined) return next();

    const nowMs = Date.now();
    if (Date.parse(session.expiresAt) <= nowMs) {
      deps.sessions.remove(key);
      return next();
    }

    const user = deps.users.findById(session.userId);
    if (user === undefined || user.disabled) return next();

    const auth: AuthedUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };
    req.auth = auth;
    req.sessionKey = key;

    if (nowMs - Date.parse(session.lastSeenAt) > TOUCH_INTERVAL_MS) {
      deps.sessions.touch(key, new Date(nowMs).toISOString());
    }
    return next();
  };
}

export function requireAuth(): RequestHandler {
  return (req, _res, next) => {
    if (req.auth === undefined) return next(new AppError('unauthorized', 'Sign in to continue.'));
    return next();
  };
}

export function requireRole(role: Role): RequestHandler {
  return (req, _res, next) => {
    if (req.auth === undefined) return next(new AppError('unauthorized', 'Sign in to continue.'));
    if (req.auth.role !== role) {
      return next(new AppError('forbidden', `This action requires the ${role} role.`));
    }
    return next();
  };
}

export function requireAdmin(): RequestHandler {
  return requireRole('admin');
}

// Spec §12's role matrix, written out once so the mapping from capability to role is readable in
// one place rather than inferred by grepping for `requireAdmin()` across five plans.
//
// WHAT THIS COMMENT USED TO CLAIM, AND WHY IT WAS WRONG. It said these were "named once so Plans
// 2-5 never re-derive it". Plans 2-5 re-derived it anyway: every router reaches for `requireAuth()`
// or `requireAdmin()` directly, and only `requireInboxRead`/`requireInboxWrite` are referenced
// anywhere — by `test/session.test.ts`. Six of the eight have no reference at all.
//
// They are kept rather than deleted because the matrix itself is worth stating, and each alias is a
// literal assignment, so what the routers do inline is byte-equivalent to what these name; there is
// no second implementation here that could drift from the first. But this block documents the
// intent, it does not enforce it — changing a line here changes NOTHING about who can reach what.
// The route tests are what hold the real matrix in place.
export const requireBrowse = requireAuth;
export const requireVerifyNow = requireAuth;
export const requireInboxRead = requireAuth;
export const requireInboxWrite = requireAdmin;
export const requireSourcesRead = requireAuth;
export const requireSourcesWrite = requireAdmin;
export const requireUserAdmin = requireAdmin;
export const requireBackup = requireAdmin;
