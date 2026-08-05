import type Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEnrollmentCodeRepo,
  hashEnrollmentCode,
  normalizeEnrollmentCode,
} from '../db/repositories/enrollmentCodes.js';
import { openTestDb } from '../test/testDb.js';
import type { RouterDeps, SessionUser } from './deps.js';
import { createEnrollmentRouter } from './enrollment.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';

const NOW = '2026-09-01T12:00:00.000Z';
const ADMIN: SessionUser = { id: 'admin-1', email: 'admin@example.org', role: 'admin' };
const MEMBER: SessionUser = { id: 'member-1', email: 'member@example.org', role: 'member' };

let db: Database.Database;

/** The same seam `adminUsersRouter.test.ts` uses: the auth middleware is injected, not imported. */
function buildApp(user: SessionUser) {
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
  app.use('/api/admin/enrollment-codes', createEnrollmentRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

function insertUser(id: string, role: 'admin' | 'member'): void {
  db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
     VALUES (?, ?, ?, 'not-a-real-hash', ?, ?, ?)`,
  ).run(id, `${id}@example.org`, `${id}@example.org`, role, `ics-${id}`, NOW);
}

function auditRows(): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT at, actor_user_id, action, entity_type, entity_id, detail FROM audit_log')
    .all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  db = openTestDb();
  insertUser(ADMIN.id, 'admin');
  insertUser(MEMBER.id, 'member');
});

afterEach(() => {
  db.close();
});

describe('/api/admin/enrollment-codes', () => {
  it('refuses a member on every route, and writes nothing', async () => {
    const { code } = createEnrollmentCodeRepo(db).create({
      label: 'seeded',
      maxUses: null,
      expiresAt: null,
      createdByUserId: ADMIN.id,
      nowISO: NOW,
    });
    const app = buildApp(MEMBER);

    for (const res of [
      await request(app).get('/api/admin/enrollment-codes'),
      await request(app).post('/api/admin/enrollment-codes').send({ label: 'sneaky' }),
      await request(app).post(`/api/admin/enrollment-codes/${code.id}/revoke`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }

    // A refused request must not have issued a code, revoked one, or left a trail suggesting it did.
    expect(createEnrollmentCodeRepo(db).list()).toHaveLength(1);
    expect(createEnrollmentCodeRepo(db).list()[0].revokedAt).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  it('issues a code, shows the plaintext once, and never shows it again', async () => {
    const app = buildApp(ADMIN);
    const res = await request(app)
      .post('/api/admin/enrollment-codes')
      .send({ label: 'W1MX autumn 2026 intake', maxUses: 30, expiresInDays: 7 });

    expect(res.status).toBe(201);
    expect(res.body.code).toEqual({
      id: expect.any(String),
      label: 'W1MX autumn 2026 intake',
      maxUses: 30,
      uses: 0,
      // Seven days from the INJECTED clock, not from the wall clock.
      expiresAt: '2026-09-08T12:00:00.000Z',
      revokedAt: null,
      createdAt: NOW,
      createdByUserId: ADMIN.id,
      lastUsedAt: null,
    });
    const plaintext: string = res.body.plaintext;
    expect(plaintext).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}$/);

    // The list route is the only other way to see a code, and it cannot show this.
    const list = await request(app).get('/api/admin/enrollment-codes');
    expect(list.status).toBe(200);
    expect(list.body.codes).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(normalizeEnrollmentCode(plaintext));
    expect(JSON.stringify(list.body)).not.toContain(hashEnrollmentCode(plaintext));
    expect(list.body.codes[0]).not.toHaveProperty('plaintext');
    expect(list.body.codes[0]).not.toHaveProperty('codeHash');

    // Neither can the database, or the audit trail written beside it.
    const stored = JSON.stringify(db.prepare('SELECT * FROM enrollment_codes').all());
    expect(stored).not.toContain(normalizeEnrollmentCode(plaintext));
    expect(JSON.stringify(auditRows())).not.toContain(normalizeEnrollmentCode(plaintext));
    expect(JSON.stringify(auditRows())).not.toContain(hashEnrollmentCode(plaintext));
  });

  it('records who issued what, without recording the credential', async () => {
    const res = await request(buildApp(ADMIN))
      .post('/api/admin/enrollment-codes')
      .send({ label: 'Field Day helpers', maxUses: 5 });

    expect(auditRows()).toEqual([
      {
        at: NOW,
        actor_user_id: ADMIN.id,
        action: 'enrollment_code.create',
        entity_type: 'enrollment_code',
        entity_id: res.body.code.id,
        detail: JSON.stringify({ label: 'Field Day helpers', maxUses: 5, expiresAt: null }),
      },
    ]);
  });

  it('treats an omitted limit and an explicit null as the same unlimited code', async () => {
    const app = buildApp(ADMIN);
    const omitted = await request(app).post('/api/admin/enrollment-codes').send({ label: 'a' });
    const explicit = await request(app)
      .post('/api/admin/enrollment-codes')
      .send({ label: 'b', maxUses: null, expiresInDays: null });

    for (const res of [omitted, explicit]) {
      expect(res.status).toBe(201);
      expect(res.body.code.maxUses).toBeNull();
      expect(res.body.code.expiresAt).toBeNull();
    }
  });

  it.each([
    ['no label at all', {}],
    ['a label of spaces', { label: '   ' }],
    ['a limit of zero', { label: 'a', maxUses: 0 }],
    ['a negative limit', { label: 'a', maxUses: -1 }],
    ['a fractional limit', { label: 'a', maxUses: 1.5 }],
    ['an absurd limit', { label: 'a', maxUses: 10_001 }],
    ['an expiry in the past', { label: 'a', expiresInDays: -1 }],
    ['an expiry of zero days', { label: 'a', expiresInDays: 0 }],
  ])('refuses %s', async (_name, body) => {
    const res = await request(buildApp(ADMIN)).post('/api/admin/enrollment-codes').send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(createEnrollmentCodeRepo(db).list()).toEqual([]);
  });

  it('revokes a code, and a second press changes nothing', async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post('/api/admin/enrollment-codes').send({ label: 'intake' });
    const id: string = created.body.code.id;

    const first = await request(app).post(`/api/admin/enrollment-codes/${id}/revoke`);
    expect(first.status).toBe(200);
    expect(first.body.code.revokedAt).toBe(NOW);

    const second = await request(app).post(`/api/admin/enrollment-codes/${id}/revoke`);
    expect(second.status).toBe(200);
    expect(second.body.code).toEqual(first.body.code);

    // One create, one revoke: the second press is not an event.
    expect(auditRows().map((r) => r.action)).toEqual([
      'enrollment_code.create',
      'enrollment_code.revoke',
    ]);
  });

  it('answers 404 for a code that does not exist', async () => {
    const res = await request(buildApp(ADMIN)).post(
      '/api/admin/enrollment-codes/no-such-id/revoke',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('lists every code with the counts an officer needs to answer a question about it', async () => {
    const repo = createEnrollmentCodeRepo(db);
    const live = repo.create({
      label: 'live',
      maxUses: 30,
      expiresAt: null,
      createdByUserId: ADMIN.id,
      nowISO: NOW,
    });
    repo.redeem({ plaintext: live.plaintext, nowISO: NOW }, () => 1);

    const res = await request(buildApp(ADMIN)).get('/api/admin/enrollment-codes');
    expect(res.body.codes).toEqual([
      expect.objectContaining({ label: 'live', maxUses: 30, uses: 1, lastUsedAt: NOW }),
    ]);
  });
});
