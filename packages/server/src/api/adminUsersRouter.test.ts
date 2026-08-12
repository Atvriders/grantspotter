import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { starProgram } from '../test/fixtures/programs.js';
import { createUserRepo } from '../db/repositories/users.js';
import { createSessionRepo } from '../db/repositories/sessions.js';
import { listAuditLog } from '../db/repositories/ingestion.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createAdminUsersRouter, generatePassword } from './adminUsersRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database, user: SessionUser) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => {
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/admin/users', createAdminUsersRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

/** Every audit row in the database, whatever it is about. */
function allAuditRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT at, actor_user_id, action, entity_type, entity_id, detail FROM audit_log')
    .all() as Array<Record<string, unknown>>;
}

describe('/api/admin/users', () => {
  let db: Database.Database;
  let adminId: string;
  let admin: SessionUser;

  beforeEach(async () => {
    // A genuinely empty migrated database: no seeded corpus, no seeded users.
    // The admin below is created through Plan 1's repository, so `users` holds a
    // real row and every `REFERENCES users(id)` in the schema is satisfiable.
    db = openTestDb();
    const created = createUserRepo(db).create({
      email: 'admin@example.com',
      passwordHash: await hashPassword('an-admin-password-not-a-real-secret'),
      role: 'admin',
      displayName: 'The Admin',
    });
    adminId = created.id;
    admin = { id: adminId, email: created.email, role: 'admin' };
  }, 20_000);

  afterEach(() => {
    db.close();
  });

  it('refuses a member on every route', async () => {
    const app = buildApp(db, MEMBER);
    for (const res of [
      await request(app).get('/api/admin/users'),
      await request(app).post('/api/admin/users').send({ email: 'x@example.com', role: 'member' }),
      await request(app).patch(`/api/admin/users/${adminId}/role`).send({ role: 'member' }),
      await request(app).patch(`/api/admin/users/${adminId}/disabled`).send({ disabled: true }),
      await request(app).post(`/api/admin/users/${adminId}/reset-password`),
      await request(app).delete(`/api/admin/users/${adminId}`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    // A refused request must not have written anything.
    expect(createUserRepo(db).count()).toBe(1);
    expect(allAuditRows(db)).toHaveLength(0);
  });

  it('lists users without ever emitting a password hash or an ICS token', async () => {
    const res = await request(buildApp(db, admin)).get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toEqual({
      id: adminId,
      email: 'admin@example.com',
      displayName: 'The Admin',
      role: 'admin',
      disabled: false,
      createdAt: expect.any(String),
      lastLoginAt: null,
      isSelf: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|icsToken|passwordHash/i);
    // The stored ICS token is a bearer credential; assert the literal value is
    // absent, not merely the key name that would carry it.
    expect(JSON.stringify(res.body)).not.toContain(createUserRepo(db).findById(adminId)!.icsToken);
  });

  it('creates a member and returns the generated password exactly once', async () => {
    const res = await request(buildApp(db, admin))
      .post('/api/admin/users')
      .send({ email: 'New.Member@Example.com', role: 'member', displayName: 'New Member' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('New.Member@Example.com');
    expect(res.body.user.role).toBe('member');
    expect(res.body.user.isSelf).toBe(false);
    expect(typeof res.body.generatedPassword).toBe('string');
    expect(res.body.generatedPassword.length).toBeGreaterThanOrEqual(24);

    // The generated password is the real credential, not a decoration.
    const stored = createUserRepo(db).findByEmail('new.member@example.com');
    expect(stored).toBeDefined();
    await expect(verifyPassword(stored!.passwordHash, res.body.generatedPassword)).resolves.toBe(
      true,
    );

    // …and it is never returned again.
    const list = await request(buildApp(db, admin)).get('/api/admin/users');
    expect(JSON.stringify(list.body)).not.toContain(res.body.generatedPassword);
  }, 20_000);

  it('rejects a duplicate email with 409 rather than a 500 from the unique index', async () => {
    const app = buildApp(db, admin);
    await request(app).post('/api/admin/users').send({ email: 'dup@example.com', role: 'member' });
    const second = await request(app)
      .post('/api/admin/users')
      .send({ email: 'DUP@example.com', role: 'member' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
    expect(createUserRepo(db).count()).toBe(2);
  }, 20_000);

  it('turns a lost race on the unique index into 409, not 500', async () => {
    // Both requests pass the findByEmail pre-check before either INSERT runs,
    // because argon2 hashing is awaited in between. Without the constraint
    // mapping in the router the loser surfaces as a raw SQLite error and a 500.
    const app = buildApp(db, admin);
    const results = await Promise.all([
      request(app).post('/api/admin/users').send({ email: 'race@example.com', role: 'member' }),
      request(app).post('/api/admin/users').send({ email: 'race@example.com', role: 'member' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('conflict');
    expect(createUserRepo(db).count()).toBe(2);
  }, 20_000);

  it('rejects a malformed email and an unknown role with 422', async () => {
    const app = buildApp(db, admin);
    const badEmail = await request(app)
      .post('/api/admin/users')
      .send({ email: 'nope', role: 'member' });
    expect(badEmail.status).toBe(422);
    expect(badEmail.body.error.code).toBe('validation_failed');

    const badRole = await request(app)
      .post('/api/admin/users')
      .send({ email: 'ok@example.com', role: 'superuser' });
    expect(badRole.status).toBe(422);

    const noRole = await request(app).patch(`/api/admin/users/${adminId}/role`).send({});
    expect(noRole.status).toBe(422);

    const badDisabled = await request(app)
      .patch(`/api/admin/users/${adminId}/disabled`)
      .send({ disabled: 'yes' });
    expect(badDisabled.status).toBe(422);
    expect(badDisabled.body.error.code).toBe('validation_failed');

    expect(createUserRepo(db).count()).toBe(1);
  });

  it('changes a role', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'promote@example.com', role: 'member' });
    const id = created.body.user.id as string;

    const res = await request(app).patch(`/api/admin/users/${id}/role`).send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
    expect(createUserRepo(db).findById(id)?.role).toBe('admin');
  }, 20_000);

  it('disables and re-enables a user', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'gone@example.com', role: 'member' });
    const id = created.body.user.id as string;

    const off = await request(app)
      .patch(`/api/admin/users/${id}/disabled`)
      .send({ disabled: true });
    expect(off.status).toBe(200);
    expect(off.body.user.disabled).toBe(true);
    expect(createUserRepo(db).findById(id)?.disabled).toBe(true);

    const on = await request(app)
      .patch(`/api/admin/users/${id}/disabled`)
      .send({ disabled: false });
    expect(on.status).toBe(200);
    expect(createUserRepo(db).findById(id)?.disabled).toBe(false);
  }, 20_000);

  it('refuses to let the last admin demote or disable themselves', async () => {
    const app = buildApp(db, admin);
    const demote = await request(app)
      .patch(`/api/admin/users/${adminId}/role`)
      .send({ role: 'member' });
    expect(demote.status).toBe(409);
    expect(demote.body.error.message).toMatch(/last admin/i);

    const disable = await request(app)
      .patch(`/api/admin/users/${adminId}/disabled`)
      .send({ disabled: true });
    expect(disable.status).toBe(409);
    expect(createUserRepo(db).findById(adminId)?.role).toBe('admin');
    expect(createUserRepo(db).findById(adminId)?.disabled).toBe(false);
  });

  it('refuses to let the last admin delete themselves', async () => {
    const app = buildApp(db, admin);
    const res = await request(app).delete(`/api/admin/users/${adminId}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(createUserRepo(db).findById(adminId)).toBeDefined();
  });

  it('allows demoting an admin once a second admin exists', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'second-admin@example.com', role: 'admin' });
    const res = await request(app)
      .patch(`/api/admin/users/${adminId}/role`)
      .send({ role: 'member' });
    expect(res.status).toBe(200);
    expect(createUserRepo(db).findById(created.body.user.id as string)?.role).toBe('admin');
  }, 20_000);

  it('does not count a DISABLED second admin as an admin who can still sign in', async () => {
    // `attachUser` refuses a disabled user outright, so a disabled admin is not
    // a way back into the instance. Promoting a second admin and immediately
    // disabling them must therefore leave the last-admin guard armed.
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'benched-admin@example.com', role: 'admin' });
    const id = created.body.user.id as string;
    await request(app).patch(`/api/admin/users/${id}/disabled`).send({ disabled: true });

    const demote = await request(app)
      .patch(`/api/admin/users/${adminId}/role`)
      .send({ role: 'member' });
    expect(demote.status).toBe(409);
    expect(demote.body.error.message).toMatch(/last admin/i);

    const remove = await request(app).delete(`/api/admin/users/${id}`);
    expect(remove.status).toBe(200);
  }, 20_000);

  it('resets a password to a fresh generated one and invalidates the old', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'reset@example.com', role: 'member' });
    const id = created.body.user.id as string;
    const first = created.body.generatedPassword as string;

    const res = await request(app).post(`/api/admin/users/${id}/reset-password`);
    expect(res.status).toBe(200);
    const second = res.body.generatedPassword as string;
    expect(second).not.toBe(first);

    const stored = createUserRepo(db).findById(id);
    await expect(verifyPassword(stored!.passwordHash, second)).resolves.toBe(true);
    await expect(verifyPassword(stored!.passwordHash, first)).resolves.toBe(false);
  }, 20_000);

  it('revokes the target user sessions on a password reset, and only theirs', async () => {
    // A reset whose whole point is "this credential is compromised" that leaves
    // the holder's session cookie working has not reset anything.
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'compromised@example.com', role: 'member' });
    const id = created.body.user.id as string;

    const sessions = createSessionRepo(db);
    sessions.create({ id: 'sess-target', userId: id, expiresAt: '2099-01-01T00:00:00.000Z' });
    sessions.create({ id: 'sess-admin', userId: adminId, expiresAt: '2099-01-01T00:00:00.000Z' });

    const res = await request(app).post(`/api/admin/users/${id}/reset-password`);
    expect(res.status).toBe(200);
    expect(res.body.revokedSessions).toBe(1);
    expect(sessions.find('sess-target')).toBeUndefined();
    expect(sessions.find('sess-admin')).toBeDefined();
  }, 20_000);

  it('deletes a user and takes their profiles, watches and sessions with them', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'departing@example.com', role: 'member' });
    const id = created.body.user.id as string;
    const icsToken = createUserRepo(db).findById(id)!.icsToken;

    db.prepare(
      'INSERT INTO profiles (id, user_id, kind, data, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(`p-${id}`, id, 'student', '{"kind":"student"}', NOW);
    starProgram(db, id, 'arrl-foundation-scholarship', NOW);
    createSessionRepo(db).create({
      id: 'sess-departing',
      userId: id,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    const res = await request(app).delete(`/api/admin/users/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('departing@example.com');
    expect(res.body.removed).toEqual({ profiles: 1, watches: 1, sessions: 1, applications: 0 });
    // `revokedEnrollmentCodes` was asserted here and the key is gone with the feature: enrolment
    // codes are retired (migration 095), so a deletion has no credential to withdraw and no number
    // to report. Asserted as ABSENT rather than simply dropped, because a route that quietly grew
    // the field back would be reporting a withdrawal that cannot happen.
    expect(res.body).not.toHaveProperty('revokedEnrollmentCodes');

    expect(createUserRepo(db).findById(id)).toBeUndefined();
    expect(createUserRepo(db).findByIcsToken(icsToken)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE user_id = ?').get(id)).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM watches WHERE user_id = ?').get(id)).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(id)).toEqual({
      n: 0,
    });
    // The program itself is untouched — only the star pointing at it went.
    expect(db.prepare('SELECT COUNT(*) AS n FROM programs').get()).toEqual({ n: 1 });
  }, 20_000);

  /**
   * WHAT A DELETE DOES TO THE CODES THAT ACCOUNT ISSUED — NOTHING, AND THAT IS THE 2026-08-11
   * REVERSAL.
   *
   * THE TEST THAT WAS HERE WAS NOT FAILING. It asserted that deleting an administrator WITHDREW the
   * enrollment codes they had issued, wrote one audit row per withdrawal with the request's own
   * clock, and reported the count on the response — the half of migration 094 a person performs, as
   * opposed to the trigger that caught the paths a person does not. Every word of that was right
   * while a code could create an account.
   *
   * Codes are retired. There is no route that redeems one, so there is no credential for a deletion
   * to withdraw, and what is left in `enrollment_codes` is a club's record of an intake. Rewriting
   * that record on a personnel change is precisely what migration 091 did with a cascade and what
   * 094 was written to stop; 095 finishes the job by dropping the trigger and this route by
   * dropping the revocation. So the assertion inverts: a deletion must leave the rows alone.
   *
   * The row-level proof lives in `test/userCascade.test.ts`, which reads the live schema. What is
   * asserted HERE is the part that belongs to this route — that it writes no `enrollment_code.*`
   * audit row and reports no count — because those are things a route can start doing again without
   * any schema changing.
   */
  it('leaves the enrolment record alone, and says nothing about it', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'officer@example.com', role: 'admin' });
    const id = created.body.user.id as string;

    // A row of the shape the retired feature left behind, still "open" by its own columns: no
    // revocation, an expiry in the far future and uses to spare. Written with SQL rather than
    // through a repository because there is no repository any more — which is the point.
    db.prepare(
      `INSERT INTO enrollment_codes
         (id, code_hash, label, max_uses, uses, expires_at, revoked_at, created_at,
          created_by_user_id, last_used_at, chosen, hash_scheme)
       VALUES (?, ?, ?, 30, 1, '2099-01-01T00:00:00.000Z', NULL, ?, ?, NULL, 0, 'hmac-sha256')`,
    ).run('c-officer-intake', 'digest-officer-intake', 'W1MX autumn 2026 intake', NOW, id);

    const res = await request(app).delete(`/api/admin/users/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('revokedEnrollmentCodes');

    // Untouched in every column, including the issuer — `user.enroll` audit rows carry this code's
    // id and the trail needs its subject to still resolve.
    expect(
      db
        .prepare(
          `SELECT label, uses, max_uses, revoked_at, created_by_user_id
             FROM enrollment_codes WHERE id = 'c-officer-intake'`,
        )
        .get(),
    ).toEqual({
      label: 'W1MX autumn 2026 intake',
      uses: 1,
      max_uses: 30,
      revoked_at: null,
      created_by_user_id: id,
    });

    // No audit row about a code, because nothing happened to one. A revocation row here would be a
    // record of an act nobody performed.
    expect(allAuditRows(db).filter((r) => r.entity_type === 'enrollment_code')).toEqual([]);
    const deletion = allAuditRows(db).find((r) => r.action === 'user.delete');
    expect(JSON.parse(deletion?.detail as string)).not.toHaveProperty('revokedEnrollmentCodes');
  }, 20_000);

  it('404s an unknown user id on every per-user route', async () => {
    const app = buildApp(db, admin);
    for (const res of [
      await request(app).patch('/api/admin/users/u-nope/role').send({ role: 'member' }),
      await request(app).patch('/api/admin/users/u-nope/disabled').send({ disabled: true }),
      await request(app).post('/api/admin/users/u-nope/reset-password'),
      await request(app).delete('/api/admin/users/u-nope'),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    }
  });

  it('audits every change, keeps the trail after a delete, and logs no credential', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'audited@example.com', role: 'member' });
    const id = created.body.user.id as string;
    const passwords = [created.body.generatedPassword as string];

    await request(app).patch(`/api/admin/users/${id}/role`).send({ role: 'admin' });
    await request(app).patch(`/api/admin/users/${id}/disabled`).send({ disabled: true });
    const reset = await request(app).post(`/api/admin/users/${id}/reset-password`);
    passwords.push(reset.body.generatedPassword as string);
    await request(app).delete(`/api/admin/users/${id}`);

    const trail = listAuditLog(db, id);
    expect(trail.map((e) => e.action)).toEqual([
      'user.create',
      'user.set_role',
      'user.disable',
      'user.reset_password',
      'user.delete',
    ]);
    for (const entry of trail) {
      expect(entry.userId).toBe(adminId);
      expect(entry.atISO).toBe(NOW);
    }
    // The user row is gone; the record of what was done to it is not.
    expect(createUserRepo(db).findById(id)).toBeUndefined();

    const serialized = JSON.stringify(allAuditRows(db));
    for (const password of passwords) {
      expect(password.length).toBeGreaterThanOrEqual(24);
      expect(serialized).not.toContain(password);
    }
    expect(serialized).not.toMatch(/argon2|password_hash|passwordHash/i);
  }, 20_000);
});

describe('generatePassword', () => {
  it('mints 24 unguessable base64url characters, never the same one twice', () => {
    const minted = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const password = generatePassword();
      expect(password).toMatch(/^[A-Za-z0-9_-]{24}$/);
      minted.add(password);
    }
    expect(minted.size).toBe(200);
  });
});
