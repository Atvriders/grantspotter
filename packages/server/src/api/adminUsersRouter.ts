import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { appendAuditLog } from '../db/repositories/ingestion.js';
import { createSessionRepo } from '../db/repositories/sessions.js';
import { createUserRepo, type Role, type UserRecord } from '../db/repositories/users.js';
import { asyncHandler } from './asyncHandler.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';

/** PLAN-LOCAL to Plan 3. The safe projection of a user for an admin screen. */
export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** True for the row describing the signed-in admin, so the UI can guard it. */
  isSelf: boolean;
}

/** What a delete destroyed, so the admin is told rather than left to guess. */
export interface RemovedCounts {
  profiles: number;
  watches: number;
  sessions: number;
  applications: number;
}

const roleSchema = z.enum(['admin', 'member']);

/**
 * A deliberately conservative email check, rather than a full RFC 5322 grammar
 * or zod's `.email()`. The real gate is the unique index on
 * `users.email_normalized`; this only rejects input that could never be an
 * address, so a typo produces 422 rather than a permanently unusable account.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const createBodySchema = z.object({
  email: z.string().trim().min(3).max(254).regex(EMAIL, 'Not an email address.'),
  role: roleSchema,
  displayName: z.string().trim().max(120).optional(),
});

const roleBodySchema = z.object({ role: roleSchema });
const disabledBodySchema = z.object({ disabled: z.boolean() });

/**
 * 24 characters of base64url from 18 random bytes (144 bits). An admin never
 * chooses another person's password: it is generated, shown once, and stored
 * only as an argon2id hash, so a screenshot of this screen or a leaked audit
 * log never contains a credential an admin typed for someone else.
 */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

function toRow(user: UserRecord, selfId: string): AdminUserRow {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null,
    isSelf: user.id === selfId,
  };
}

/**
 * better-sqlite3 raises the unique index as a plain error. Two admins creating
 * the same address at once both clear the `findByEmail` pre-check — argon2
 * hashing is awaited in between — so the loser must become a 409 here or it
 * reaches the client as a 500 with a raw SQLite message.
 */
function isDuplicateEmail(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : '';
  return (
    (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') &&
    /users\.email_normalized/.test(message)
  );
}

export function createAdminUsersRouter(deps: RouterDeps): Router {
  const router = Router();
  const users = createUserRepo(deps.db);
  const sessions = createSessionRepo(deps.db);

  /**
   * Lock-out guard. An instance with zero admins who can still sign in cannot
   * be recovered by a self-hoster with no console, so "the last admin" is the
   * last ENABLED admin: `attachUser` refuses a disabled user outright, so a
   * disabled admin is not a way back in and does not satisfy this check.
   */
  function otherEnabledAdminExists(exceptId: string): boolean {
    return users.list().some((u) => u.id !== exceptId && u.role === 'admin' && !u.disabled);
  }

  function assertNotLastAdmin(user: UserRecord): void {
    if (user.role === 'admin' && !user.disabled && !otherEnabledAdminExists(user.id)) {
      throw new AppError(
        'conflict',
        'This is the last admin who can still sign in; promote or enable another admin first.',
      );
    }
  }

  function load(id: string): UserRecord {
    const user = users.findById(id);
    if (user === undefined) throw new AppError('not_found', `No user with id "${id}".`);
    return user;
  }

  function audit(
    req: Request,
    entry: { action: string; entityId: string; detail: Record<string, unknown> },
  ): void {
    appendAuditLog(deps.db, {
      userId: deps.currentUser(req).id,
      action: entry.action,
      entityType: 'user',
      entityId: entry.entityId,
      // NEVER a password, a hash or an ICS token: an audit trail is read by
      // more people, and kept for longer, than anything else this router writes.
      detail: JSON.stringify(entry.detail),
      atISO: deps.now(),
    });
  }

  const countFor = {
    profiles: deps.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?'),
    watches: deps.db.prepare('SELECT COUNT(*) AS n FROM watches WHERE user_id = ?'),
    sessions: deps.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?'),
    applications: deps.db.prepare('SELECT COUNT(*) AS n FROM applications WHERE user_id = ?'),
  };

  router.get('/', deps.requireAuth, deps.requireAdmin, (req, res) => {
    const selfId = deps.currentUser(req).id;
    res.json({
      rows: users
        .list()
        .map((u) => toRow(u, selfId))
        .sort((a, b) => a.email.localeCompare(b.email)),
    });
  });

  router.post(
    '/',
    deps.requireAuth,
    deps.requireAdmin,
    asyncHandler(async (req, res) => {
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('validation_failed', 'The new user is invalid.', parsed.error.issues);
      }
      const { email, role, displayName } = parsed.data;

      if (users.findByEmail(email) !== undefined) {
        throw new AppError('conflict', `${email} already has an account.`);
      }

      const generatedPassword = generatePassword();
      const passwordHash = await hashPassword(generatedPassword);

      let created: UserRecord;
      try {
        created = users.create({ email, passwordHash, role, displayName: displayName ?? '' });
      } catch (err) {
        if (isDuplicateEmail(err)) {
          throw new AppError('conflict', `${email} already has an account.`);
        }
        throw err;
      }

      audit(req, { action: 'user.create', entityId: created.id, detail: { email, role } });

      // The one and only time this value leaves the process.
      res.status(201).json({
        user: toRow(created, deps.currentUser(req).id),
        generatedPassword,
      });
    }),
  );

  router.patch('/:id/role', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    try {
      const parsed = roleBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'validation_failed',
          'role must be "admin" or "member".',
          parsed.error.issues,
        );
      }
      const { role } = parsed.data;
      const user = load(req.params.id);
      if (user.role === 'admin' && role === 'member') assertNotLastAdmin(user);

      users.setRole(user.id, role);
      audit(req, {
        action: 'user.set_role',
        entityId: user.id,
        detail: { from: user.role, to: role },
      });
      res.json({ user: toRow(load(user.id), deps.currentUser(req).id) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/disabled', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    try {
      const parsed = disabledBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          'validation_failed',
          'disabled must be true or false.',
          parsed.error.issues,
        );
      }
      const { disabled } = parsed.data;
      const user = load(req.params.id);
      if (disabled) assertNotLastAdmin(user);

      users.setDisabled(user.id, disabled);
      // Disabling does not delete sessions on purpose: `attachUser` re-reads
      // `users.disabled` on every request, so the account is locked out at once
      // and the session rows stay available for a later audit of what it did.
      audit(req, {
        action: disabled ? 'user.disable' : 'user.enable',
        entityId: user.id,
        detail: {},
      });
      res.json({ user: toRow(load(user.id), deps.currentUser(req).id) });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/:id/reset-password',
    deps.requireAuth,
    deps.requireAdmin,
    asyncHandler(async (req, res) => {
      const user = load(req.params.id);
      const generatedPassword = generatePassword();
      const passwordHash = await hashPassword(generatedPassword);

      const revokedSessions = (countFor.sessions.get(user.id) as { n: number }).n;
      users.setPasswordHash(user.id, passwordHash);
      // A reset whose reason is "this credential is compromised" that leaves the
      // holder's cookie working has reset nothing. The ICS token is deliberately
      // NOT rotated here — it is a read-only calendar feed, and rotating it would
      // silently break a subscription the user did not ask to lose. Deleting the
      // account is what destroys it.
      sessions.removeAllForUser(user.id);

      audit(req, { action: 'user.reset_password', entityId: user.id, detail: { revokedSessions } });
      res.json({
        user: toRow(load(user.id), deps.currentUser(req).id),
        generatedPassword,
        revokedSessions,
      });
    }),
  );

  router.delete('/:id', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    try {
      const self = deps.currentUser(req);
      const user = load(req.params.id);

      // Self-deletion is refused outright, not merely when you are the last
      // admin: an admin who removes their own account mid-session cannot undo
      // it, and a second admin can always do it for them. This also makes the
      // last-admin case unreachable rather than merely guarded.
      if (user.id === self.id) {
        throw new AppError(
          'conflict',
          'You cannot delete your own account. Ask another admin, or disable it instead.',
        );
      }
      assertNotLastAdmin(user);

      const removed: RemovedCounts = {
        profiles: (countFor.profiles.get(user.id) as { n: number }).n,
        watches: (countFor.watches.get(user.id) as { n: number }).n,
        sessions: (countFor.sessions.get(user.id) as { n: number }).n,
        applications: (countFor.applications.get(user.id) as { n: number }).n,
      };
      const row = toRow(user, self.id);

      // Every `REFERENCES users(id)` in the schema is ON DELETE CASCADE
      // (sessions, profiles, watches, applications — 001-init.sql) and
      // `openDatabase` sets `PRAGMA foreign_keys = ON`, so one DELETE takes the
      // lot atomically instead of leaving orphans that surface later as a raw
      // SQLite error. `audit_log.actor_user_id` has NO foreign key, so the
      // record of what this account did — and of this deletion — outlives it.
      deps.db.transaction(() => {
        deps.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        audit(req, {
          action: 'user.delete',
          entityId: user.id,
          detail: { email: user.email, role: user.role, removed },
        });
      })();

      res.json({ user: row, removed });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
