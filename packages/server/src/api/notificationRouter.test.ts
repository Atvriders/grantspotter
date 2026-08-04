import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, starProgram } from '../test/fixtures/programs.js';
import { createNotificationRouter } from './notificationRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };
const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@example.com', role: 'admin' };

function buildApp(db: Database.Database, user: SessionUser = MEMBER) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    // The real one is Plan 1's; this fake enforces the same rule so a route that
    // forgets to ask for it fails here rather than in production.
    requireAdmin: (_req, _res, next) =>
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admins only.')),
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/notifications', createNotificationRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

function seedWatchedDeadlineMove(db: Database.Database) {
  // starProgram inserts the users row and the programs row before the star:
  // both are ON DELETE CASCADE parents in Plan 1's DDL (RESOLUTIONS R19).
  starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
  db.prepare(
    `INSERT INTO change_events
       (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ce-1', 'arrl-scholarship-descriptions', 'arrl-foundation-scholarship',
    'deadline_changed', JSON.stringify('2027-01-31T17:00:00.000Z'),
    JSON.stringify('2026-12-30T17:00:00.000Z'), NOW, 'deadline.closesAt');
}

describe('notifications API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  it('drains pending change events on read, so the digest is never stale', async () => {
    seedWatchedDeadlineMove(db);
    const res = await request(buildApp(db)).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(1);
    expect(res.body.rows[0].title)
      .toBe('Deadline changed: ARRL Foundation Scholarship Program');
    expect(res.body.rows[0].programId).toBe('arrl-foundation-scholarship');
    expect(res.body.rows[0].sourceId).toBe('arrl-scholarship-descriptions');
  });

  it('marks one notification read', async () => {
    seedWatchedDeadlineMove(db);
    const app = buildApp(db);
    const list = await request(app).get('/api/notifications');
    const id = list.body.rows[0].id;
    const mark = await request(app).post(`/api/notifications/${id}/read`);
    expect(mark.status).toBe(204);
    const after = await request(app).get('/api/notifications');
    expect(after.body.unread).toBe(0);
    expect(after.body.rows[0].readAt).toBe(NOW);
  });

  it('marks everything read', async () => {
    seedWatchedDeadlineMove(db);
    const app = buildApp(db);
    await request(app).get('/api/notifications');
    const mark = await request(app).post('/api/notifications/read-all');
    expect(mark.status).toBe(204);
    const after = await request(app).get('/api/notifications');
    expect(after.body.unread).toBe(0);
  });

  it('refuses to mark another user’s notification read', async () => {
    seedWatchedDeadlineMove(db);
    const owner = buildApp(db);
    const list = await request(owner).get('/api/notifications');
    const id = list.body.rows[0].id;
    const intruder = buildApp(db, { id: 'u-other', email: 'o@example.com', role: 'member' });
    const res = await request(intruder).post(`/api/notifications/${id}/read`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.requestId).toBeTruthy();
  });

  it('supports unread-only listing', async () => {
    seedWatchedDeadlineMove(db);
    const app = buildApp(db);
    const list = await request(app).get('/api/notifications');
    await request(app).post(`/api/notifications/${list.body.rows[0].id}/read`);
    const unread = await request(app).get('/api/notifications?unreadOnly=true');
    expect(unread.body.rows).toEqual([]);
  });

  /**
   * An empty digest is ambiguous on its own: nothing changed, or the drain never
   * ran, or every alarm reached nobody. This is the endpoint that tells them
   * apart, and it is the reader that makes `change_event_fanout`'s counters
   * something other than a write-only table.
   */
  it('reports fan-out health to an admin', async () => {
    starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
    db.prepare(
      `INSERT INTO change_events
         (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ce-orphan', 'arrl-scholarship-descriptions', 'ardc-grants', 'status_changed',
      JSON.stringify('open'), JSON.stringify('closed'), NOW, 'trust.status');

    const before = await request(buildApp(db, ADMIN)).get('/api/notifications/health');
    expect(before.status).toBe(200);
    expect(before.body.pendingEvents).toBe(1);

    await request(buildApp(db)).get('/api/notifications');

    const after = await request(buildApp(db, ADMIN)).get('/api/notifications/health');
    expect(after.body.pendingEvents).toBe(0);
    expect(after.body.fannedOutEvents).toBe(1);
    expect(after.body.zeroRecipientEvents).toBe(1);
    expect(after.body.lastFanoutAt).toBe(NOW);
    expect(after.body.notifications).toEqual({ total: 0, unread: 0 });
  });

  it('keeps fan-out health away from members', async () => {
    const res = await request(buildApp(db)).get('/api/notifications/health');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});
