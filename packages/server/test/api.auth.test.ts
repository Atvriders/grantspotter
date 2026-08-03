import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createBootstrapState } from '../src/auth/bootstrap.js';
import { createRateLimiter } from '../src/auth/rateLimit.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { loadConfig } from '../src/config.js';
import { createSessionRepo } from '../src/db/repositories/sessions.js';
import { createTestDb, type TestDb } from './helpers/tempDb.js';

const config = loadConfig({
  SESSION_SECRET: 'z'.repeat(32),
  CONTACT_URL: 'https://example.org/grantspotter',
  NODE_ENV: 'test',
});

const GOOD_PASSWORD = 'a-long-enough-password';

let harness: TestDb;
beforeEach(() => {
  harness = createTestDb();
});
afterEach(() => harness.cleanup());

function build(logLines: string[] = []) {
  const bootstrap = createBootstrapState(harness.db, (line) => logLines.push(line));
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 5 });
  const app = createApp({
    db: harness.db,
    config,
    bootstrap,
    loginLimiter,
    logger: () => undefined,
  });
  return { app, bootstrap, loginLimiter, logLines };
}

function cookieFrom(res: request.Response): string {
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? header : [header];
  const found = raw.find((c) => typeof c === 'string' && c.startsWith(`${SESSION_COOKIE}=`));
  if (found === undefined) throw new Error('no session cookie was set');
  return found.split(';')[0];
}

describe('rate limiter', () => {
  it('blocks after the configured number of failures and recovers after the window', () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 3 });
    expect(limiter.check('k', 0).allowed).toBe(true);
    limiter.recordFailure('k', 0);
    limiter.recordFailure('k', 10);
    expect(limiter.check('k', 20).allowed).toBe(true);
    limiter.recordFailure('k', 20);

    const blocked = limiter.check('k', 30);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);

    expect(limiter.check('k', 1500).allowed).toBe(true);
  });

  it('forgets a key on reset and keys are independent', () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 1 });
    limiter.recordFailure('a', 0);
    expect(limiter.check('a', 0).allowed).toBe(false);
    expect(limiter.check('b', 0).allowed).toBe(true);
    limiter.reset('a');
    expect(limiter.check('a', 0).allowed).toBe(true);
  });
});

describe('first-run bootstrap', () => {
  it('prints a one-time token to the log when no accounts exist', () => {
    const { logLines } = build();
    expect(logLines.join('\n')).toContain('GrantSpotter first-run setup');
    expect(logLines.join('\n')).toMatch(/[0-9a-f]{48}/);
  });

  it('reports that bootstrap is required, then that it is not', async () => {
    const { app, bootstrap } = build();
    expect((await request(app).get('/api/auth/bootstrap-status')).body).toEqual({ required: true });

    const res = await request(app).post('/api/auth/bootstrap').send({
      token: bootstrap.token(),
      email: 'admin@example.org',
      password: GOOD_PASSWORD,
      displayName: 'First Admin',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.email).toBe('admin@example.org');
    expect(res.body.user.displayName).toBe('First Admin');
    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(cookieFrom(res)).toContain(`${SESSION_COOKIE}=`);

    expect((await request(app).get('/api/auth/bootstrap-status')).body).toEqual({
      required: false,
    });
  });

  it('sets an httpOnly cookie on the bootstrap response', async () => {
    const { app, bootstrap } = build();
    const res = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token: bootstrap.token(), email: 'admin@example.org', password: GOOD_PASSWORD });
    const header = res.headers['set-cookie'];
    const raw = (Array.isArray(header) ? header : [header]).join(';');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
  });

  it('rejects a wrong token and burns the right one after use', async () => {
    const { app, bootstrap } = build();
    const token = bootstrap.token();
    const wrong = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token: 'nope', email: 'a@example.org', password: GOOD_PASSWORD });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('unauthorized');

    await request(app)
      .post('/api/auth/bootstrap')
      .send({ token, email: 'admin@example.org', password: GOOD_PASSWORD });

    const again = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token, email: 'second@example.org', password: GOOD_PASSWORD });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('conflict');
  });

  it('rejects a weak password and an invalid body', async () => {
    const { app, bootstrap } = build();
    const weak = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token: bootstrap.token(), email: 'admin@example.org', password: 'short' });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe('validation_failed');

    const malformed = await request(app).post('/api/auth/bootstrap').send({ token: 'x' });
    expect(malformed.status).toBe(422);
  });
});

describe('login, me and logout', () => {
  async function seedAdmin(app: ReturnType<typeof build>['app'], bootstrap: ReturnType<typeof build>['bootstrap']) {
    const res = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token: bootstrap.token(), email: 'admin@example.org', password: GOOD_PASSWORD });
    return cookieFrom(res);
  }

  it('signs in, identifies the user, and signs out', async () => {
    const { app, bootstrap } = build();
    // Bootstrap auto-signs-in the new admin (its own session, tested
    // separately). Log that session out here so the count() assertion below
    // reflects only the login session under test, not an artifact of
    // bootstrap also having created a row — see fix round 1 in the Task 17
    // report: the previous version of this test asserted a global
    // per-user session count of 0, which conflated "the bootstrap session
    // was never cleaned up in this test" with "at most one session may ever
    // exist" and drove an incorrect single-session-per-user fix in the
    // implementation.
    const bootstrapCookie = await seedAdmin(app, bootstrap);
    await request(app).post('/api/auth/logout').set('Cookie', bootstrapCookie);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ADMIN@example.org', password: GOOD_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('admin');
    const cookie = cookieFrom(login);

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('admin@example.org');
    expect(me.body.user.lastLoginAt).toBeDefined();
    expect(Object.keys(me.body.user)).not.toContain('passwordHash');
    expect(Object.keys(me.body.user)).not.toContain('icsToken');

    const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBe(204);
    expect(createSessionRepo(harness.db).count()).toBe(0);

    const after = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('answers 401 for /api/auth/me with no session', async () => {
    const { app } = build();
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('gives the same generic answer for a wrong password and an unknown email', async () => {
    const { app, bootstrap } = build();
    await seedAdmin(app, bootstrap);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.org', password: 'a-different-password' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.org', password: GOOD_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    expect(wrongPassword.body.error.message).toBe('Incorrect email or password.');
  });

  it('refuses a disabled account', async () => {
    const { app, bootstrap } = build();
    await seedAdmin(app, bootstrap);
    harness.db.prepare('UPDATE users SET disabled = 1').run();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.org', password: GOOD_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rate-limits repeated failures and clears the counter on success', async () => {
    const { app, bootstrap } = build();
    await seedAdmin(app, bootstrap);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@example.org', password: 'wrong-password-here' });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.org', password: GOOD_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.details.retryAfterSec).toBeGreaterThan(0);
  }, 20_000);

  // Fix round 1: the reviewer demonstrated that keying the limiter on
  // `${req.ip}|${email}` let an attacker mint unlimited fresh buckets
  // against one account by rotating X-Forwarded-For (trust proxy is set in
  // app.ts, so req.ip follows that header). The lockout must be keyed on the
  // account alone, so no header the client controls can reset it.
  it('does not let rotating X-Forwarded-For reset the per-account lockout', async () => {
    const { app, bootstrap } = build();
    await seedAdmin(app, bootstrap);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ email: 'admin@example.org', password: 'wrong-password-here' });
      expect(res.status).toBe(401);
    }

    const stillBlocked = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.55')
      .send({ email: 'admin@example.org', password: GOOD_PASSWORD });
    expect(stillBlocked.status).toBe(429);
    expect(stillBlocked.body.error.code).toBe('rate_limited');
  }, 20_000);

  it('does not expose a signup route', async () => {
    const { app } = build();
    const res = await request(app).post('/api/auth/register').send({});
    expect(res.status).toBe(404);
  });

  // Fix round 1: login previously called sessions.removeAllForUser(user.id),
  // silently 401ing any other still-valid cookie for that user (e.g.
  // bootstrap's own session) the moment a second login happened. Reverted —
  // a club officer, advisor or student may plausibly be signed in on a
  // laptop and a phone at once, and nothing in spec §12 asks for
  // single-session-per-user.
  it('allows two concurrent sessions for the same user to both authenticate', async () => {
    const { app, bootstrap } = build();
    const deviceA = await seedAdmin(app, bootstrap);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.org', password: GOOD_PASSWORD });
    expect(login.status).toBe(200);
    const deviceB = cookieFrom(login);

    const meA = await request(app).get('/api/auth/me').set('Cookie', deviceA);
    const meB = await request(app).get('/api/auth/me').set('Cookie', deviceB);
    expect(meA.status).toBe(200);
    expect(meB.status).toBe(200);
    expect(createSessionRepo(harness.db).count()).toBe(2);
  });
});

describe('bootstrap state is derived from the database, not cached', () => {
  it('is not required when a user already exists at startup', () => {
    harness.db
      .prepare(
        'INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run('u1', 'a@example.org', 'a@example.org', 'h', 'admin', 'tok', 'now');
    const log = vi.fn();
    const bootstrap = createBootstrapState(harness.db, log);
    expect(bootstrap.required()).toBe(false);
    expect(bootstrap.token()).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});
