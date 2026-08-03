import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorHandler, notFoundHandler, requestIdMiddleware } from '../src/api/errors.js';
import {
  attachUser,
  requireAdmin,
  requireAuth,
  requireInboxRead,
  requireInboxWrite,
} from '../src/auth/middleware.js';
import {
  newSessionId,
  SESSION_COOKIE,
  sessionIdHash,
  signSessionCookie,
  verifySessionCookie,
} from '../src/auth/session.js';
import { createSessionRepo } from '../src/db/repositories/sessions.js';
import { createUserRepo, type Role } from '../src/db/repositories/users.js';
import { createTestDb, type TestDb } from './helpers/tempDb.js';

const SECRET = 's'.repeat(32);

let harness: TestDb;
beforeEach(() => {
  harness = createTestDb();
});
afterEach(() => harness.cleanup());

function buildApp() {
  const users = createUserRepo(harness.db);
  const sessions = createSessionRepo(harness.db);
  const app = express();
  app.use(cookieParser());
  app.use(requestIdMiddleware());
  app.use(attachUser({ users, sessions, sessionSecret: SECRET }));
  app.get('/who', (req, res) => {
    res.json({ auth: req.auth ?? null });
  });
  app.get('/private', requireAuth(), (req, res) => {
    res.json({ role: req.auth?.role });
  });
  app.get('/inbox', requireInboxRead(), (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/inbox/approve', requireInboxWrite(), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/admin', requireAdmin(), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(notFoundHandler());
  app.use(errorHandler({ logger: () => undefined }));
  return { app, users, sessions };
}

function login(
  users: ReturnType<typeof createUserRepo>,
  sessions: ReturnType<typeof createSessionRepo>,
  role: Role,
  expiresAt = new Date(Date.now() + 86_400_000).toISOString(),
) {
  const user = users.create({ email: `${role}@example.org`, passwordHash: 'h', role });
  const rawId = newSessionId();
  sessions.create({ id: sessionIdHash(rawId), userId: user.id, expiresAt });
  return { user, cookie: `${SESSION_COOKIE}=${signSessionCookie(rawId, SECRET)}` };
}

describe('session cookie crypto', () => {
  it('mints high-entropy, unique ids', () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes the id with SHA-256 so the raw value never reaches the database', () => {
    const raw = newSessionId();
    expect(sessionIdHash(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionIdHash(raw)).toBe(sessionIdHash(raw));
    expect(sessionIdHash(raw)).not.toContain(raw);
  });

  it('round-trips a signed cookie', () => {
    const raw = newSessionId();
    expect(verifySessionCookie(signSessionCookie(raw, SECRET), SECRET)).toBe(raw);
  });

  it('rejects tampering, a wrong secret and malformed values', () => {
    const raw = newSessionId();
    const signed = signSessionCookie(raw, SECRET);
    expect(verifySessionCookie(`${signed}x`, SECRET)).toBeNull();
    expect(verifySessionCookie(signed, 'w'.repeat(32))).toBeNull();
    expect(verifySessionCookie(signSessionCookie('other-id', SECRET).replace('other-id', raw), SECRET)).toBeNull();
    expect(verifySessionCookie('no-dot-here', SECRET)).toBeNull();
    expect(verifySessionCookie('', SECRET)).toBeNull();
    expect(verifySessionCookie('.sig', SECRET)).toBeNull();
  });
});

describe('attachUser', () => {
  it('attaches the user for a valid signed cookie', async () => {
    const { app, users, sessions } = buildApp();
    const { user, cookie } = login(users, sessions, 'member');
    const res = await request(app).get('/who').set('Cookie', cookie);
    expect(res.body.auth).toEqual({
      id: user.id,
      email: user.email,
      displayName: '',
      role: 'member',
    });
  });

  it('ignores a missing, unsigned, unknown or expired session', async () => {
    const { app, users, sessions } = buildApp();
    expect((await request(app).get('/who')).body.auth).toBeNull();
    expect(
      (await request(app).get('/who').set('Cookie', `${SESSION_COOKIE}=garbage`)).body.auth,
    ).toBeNull();

    const orphan = signSessionCookie(newSessionId(), SECRET);
    expect(
      (await request(app).get('/who').set('Cookie', `${SESSION_COOKIE}=${orphan}`)).body.auth,
    ).toBeNull();

    const expired = login(users, sessions, 'admin', '2020-01-01T00:00:00.000Z');
    expect((await request(app).get('/who').set('Cookie', expired.cookie)).body.auth).toBeNull();
    // the expired row is swept as a side effect
    expect(sessions.count()).toBe(0);
  });

  it('ignores a disabled user', async () => {
    const { app, users, sessions } = buildApp();
    const { user, cookie } = login(users, sessions, 'admin');
    users.setDisabled(user.id, true);
    expect((await request(app).get('/who').set('Cookie', cookie)).body.auth).toBeNull();
  });
});

describe('role guards', () => {
  it('answers 401 with the error envelope when signed out', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/private');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('answers 403 when the role is wrong', async () => {
    const { app, users, sessions } = buildApp();
    const { cookie } = login(users, sessions, 'member');
    const res = await request(app).get('/admin').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('gives members the Inbox read-only and admins full access', async () => {
    const { app, users, sessions } = buildApp();
    const member = login(users, sessions, 'member');
    const admin = login(users, sessions, 'admin');

    expect((await request(app).get('/inbox').set('Cookie', member.cookie)).status).toBe(200);
    expect((await request(app).post('/inbox/approve').set('Cookie', member.cookie)).status).toBe(403);
    expect((await request(app).get('/inbox').set('Cookie', admin.cookie)).status).toBe(200);
    expect((await request(app).post('/inbox/approve').set('Cookie', admin.cookie)).status).toBe(200);
  });
});
