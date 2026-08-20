/**
 * WHO MAY REACH THE SECOND DOOR, AND WHAT THE DOOR REQUIRES BEFORE IT WRITES.
 *
 * The module beneath this router (`seed/consentedCorrections.test.ts`) proves what it changes and
 * what it refuses. This file proves the two things only the seam can: that a member cannot reach
 * any of it — including the READ, which quotes funder sentences and reports how many of this
 * instance's applicant profiles change verdict — and that neither write happens without both a
 * typed confirmation and the explicit list of proposals the operator read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { createUserRepo } from '../db/repositories/users.js';
import {
  CONFIRM_ADD,
  CONFIRM_CORRECT,
  createSeedCorrectionsRouter,
} from './seedCorrectionsRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-20T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };
const ANONYMOUS = null;

const ROUTES = [
  { method: 'get' as const, path: '/api/admin/seed-corrections', body: undefined },
  {
    method: 'post' as const,
    path: '/api/admin/seed-corrections/apply',
    body: { confirm: CONFIRM_CORRECT, proposalIds: ['whatever'] },
  },
  {
    method: 'post' as const,
    path: '/api/admin/seed-corrections/add',
    body: { confirm: CONFIRM_ADD, proposalIds: ['whatever'] },
  },
];

function buildApp(db: Database.Database, user: SessionUser | null) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => {
      next(user === null ? new AppError('unauthorized', 'Sign in to continue.') : undefined);
    },
    requireAdmin: (_req, _res, next) => {
      next(user?.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user as SessionUser,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/admin/seed-corrections', createSeedCorrectionsRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

function auditCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
}

describe('/api/admin/seed-corrections', () => {
  let db: Database.Database;
  let admin: SessionUser;

  beforeEach(() => {
    db = openTestDb();
    const created = createUserRepo(db).create({
      email: 'admin@example.com',
      passwordHash: 'not-a-real-hash',
      role: 'admin',
      displayName: 'The Admin',
    });
    admin = { id: created.id, email: created.email, role: 'admin' };
  });

  afterEach(() => {
    db.close();
  });

  it('refuses a member every route, including the read', async () => {
    const app = buildApp(db, MEMBER);
    for (const route of ROUTES) {
      const res = await request(app)[route.method](route.path).send(route.body ?? {});
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    expect(auditCount(db)).toBe(0);
  });

  it('refuses an anonymous caller every route', async () => {
    const app = buildApp(db, ANONYMOUS);
    for (const route of ROUTES) {
      const res = await request(app)[route.method](route.path).send(route.body ?? {});
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    }
    expect(auditCount(db)).toBe(0);
  });

  it('shows an admin what the image would change', async () => {
    const res = await request(buildApp(db, admin)).get('/api/admin/seed-corrections');
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
    // This database holds no programs at all, so every shipped record is an addition and nothing
    // is a correction — which is exactly what a reader should be told.
    expect(res.body.additions.length).toBeGreaterThan(0);
    expect(res.body.wording).toEqual([]);
    expect(res.body.rules).toEqual([]);
    expect(res.body.profilesMeasured).toBe(0);
  });

  it('reading changes nothing', async () => {
    const app = buildApp(db, admin);
    const before = db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number };
    await request(app).get('/api/admin/seed-corrections');
    expect((db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n).toBe(
      before.n,
    );
    expect(auditCount(db)).toBe(0);
  });

  /**
   * THE WORD IS NOT THE CONSENT — the ids are — but without the word nothing happens at all, and
   * the two acts do not share a word. Typing CORRECT cannot add a programme even by accident.
   */
  it('writes nothing without the right confirmation word', async () => {
    const app = buildApp(db, admin);
    const plan = await request(app).get('/api/admin/seed-corrections');
    const addition = plan.body.additions[0] as { id: string };

    for (const attempt of [
      { path: '/api/admin/seed-corrections/add', body: { confirm: '', proposalIds: [addition.id] } },
      {
        path: '/api/admin/seed-corrections/add',
        body: { confirm: CONFIRM_CORRECT, proposalIds: [addition.id] },
      },
      {
        path: '/api/admin/seed-corrections/apply',
        body: { confirm: CONFIRM_ADD, proposalIds: [addition.id] },
      },
    ]) {
      const res = await request(app).post(attempt.path).send(attempt.body);
      expect(res.status, JSON.stringify(attempt.body)).toBe(400);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n).toBe(0);
    expect(auditCount(db)).toBe(0);
  });

  it('will not act on a request that names no proposals', async () => {
    const app = buildApp(db, admin);
    const res = await request(app)
      .post('/api/admin/seed-corrections/apply')
      .send({ confirm: CONFIRM_CORRECT, proposalIds: [] });
    expect(res.status).toBe(422);
    expect(auditCount(db)).toBe(0);
  });

  it('adds only the programme whose id was consented to, and records the admin who did it', async () => {
    const app = buildApp(db, admin);
    const plan = await request(app).get('/api/admin/seed-corrections');
    const additions = plan.body.additions as Array<{ id: string; programId: string }>;
    expect(additions.length).toBeGreaterThan(1);
    const chosen = additions[0]!;

    const res = await request(app)
      .post('/api/admin/seed-corrections/add')
      .send({ confirm: CONFIRM_ADD, proposalIds: [chosen.id] });

    expect(res.status).toBe(200);
    expect(res.body.applied).toHaveLength(1);
    expect(res.body.applied[0].programId).toBe(chosen.programId);
    expect(res.body.programsReindexed).toBeGreaterThan(0);

    const ids = (db.prepare('SELECT id FROM programs').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(ids).toEqual([chosen.programId]);

    const row = db
      .prepare('SELECT actor_user_id, action FROM audit_log ORDER BY id')
      .get() as { actor_user_id: string; action: string };
    expect(row.action).toBe('seed_correction.record_added');
    expect(row.actor_user_id).toBe(admin.id);
  });

  /**
   * A refusal is a 200 carrying the refusal, not a 4xx: an apply may land some changes and refuse
   * others, and an operator is owed both halves in one answer.
   */
  it('reports a stale proposal id as a refusal rather than an error', async () => {
    const app = buildApp(db, admin);
    const res = await request(app)
      .post('/api/admin/seed-corrections/apply')
      .send({ confirm: CONFIRM_CORRECT, proposalIds: ['an-id-nobody-was-ever-shown'] });

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual([]);
    expect(res.body.refused).toHaveLength(1);
    expect(res.body.refused[0].why).toMatch(/no longer being offered/);
    expect(auditCount(db)).toBe(0);
  });
});
