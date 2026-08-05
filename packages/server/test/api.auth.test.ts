import { Agent as httpAgent } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createBootstrapState } from '../src/auth/bootstrap.js';
import { coarseOrigin, createConcurrencyGate, createRateLimiter } from '../src/auth/rateLimit.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { loadConfig } from '../src/config.js';
import { createSessionRepo } from '../src/db/repositories/sessions.js';
import { createTestDb, type TestDb } from './helpers/tempDb.js';

const config = loadConfig({
  SESSION_SECRET: 'z'.repeat(32),
  NODE_ENV: 'test',
  // Required with no default: `loadConfig` refuses to build a config without a contact
  // URL, so every harness that wants one has to name an address a real deployment could
  // hold. Nothing here reaches the network; this value only has to survive the loader.
  CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter',
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

  /**
   * THE HALF THAT `check` + `recordFailure` CANNOT EXPRESS.
   *
   * Both auth routes do tens of milliseconds of argon2id between deciding that an attempt is
   * allowed and finding out whether it failed, and for as long as a limiter counts only the ones
   * that have already finished, everything that arrives during that window is uncounted. These four
   * cases are the whole contract `begin` adds: a started attempt occupies the budget, releasing
   * gives the slot back without recording anything, charging converts it into a failure, and an
   * attempt settles exactly once however many times the handler says so.
   */
  describe('attempts in flight', () => {
    it('counts a started attempt against the budget before its outcome is known', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 2 });
      const first = limiter.begin('k', 0);
      const second = limiter.begin('k', 0);
      expect(first.started).toBe(true);
      expect(second.started).toBe(true);

      const third = limiter.begin('k', 0);
      expect(third.started).toBe(false);
      // Nothing is recorded yet, so the wait is one hash rather than one window: the honest answer
      // is "a moment", and 1000 ms of window would have said "a second" here anyway — a longer
      // window makes the difference visible, which is what the next assertion is for.
      const longer = createRateLimiter({ windowMs: 900_000, maxFailures: 1 });
      longer.begin('k', 0);
      const blocked = longer.begin('k', 0);
      expect(blocked.started === false && blocked.retryAfterSec).toBe(1);
    });

    it('gives the slot back on release, and records nothing', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 1 });
      const attempt = limiter.begin('k', 0);
      expect(limiter.begin('k', 0).started).toBe(false);
      if (attempt.started) attempt.release();
      expect(limiter.check('k', 0).allowed).toBe(true);
    });

    it('turns the slot into a recorded failure on charge, and the window then applies', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 1 });
      const attempt = limiter.begin('k', 0);
      if (attempt.started) attempt.charge(0);
      const blocked = limiter.check('k', 10);
      expect(blocked.allowed).toBe(false);
      // Charged at 0, so the budget frees at the window's end and not a hash later.
      expect(blocked.retryAfterSec).toBe(1);
      expect(limiter.check('k', 1500).allowed).toBe(true);
    });

    it('settles once: a release after a charge does not un-record the failure', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 1 });
      const attempt = limiter.begin('k', 0);
      if (attempt.started) {
        attempt.charge(0);
        // Exactly what the enrolment handler's `finally` does on every path, including the charged
        // one. If this gave the slot back, the budget would be one larger than it says forever.
        attempt.release();
        attempt.charge(0);
      }
      expect(limiter.check('k', 10).allowed).toBe(false);
      // …and one failure, not two: the second charge was a no-op, so the window still clears at
      // 1000 ms from the first.
      expect(limiter.check('k', 1500).allowed).toBe(true);
    });
  });
});

/**
 * THE OTHER KIND OF LIMIT, and the reason it is a separate primitive rather than a second option on
 * the one above: a budget refuses, a gate waits. Confusing the two is what answered twenty of
 * thirty students with a valid enrollment code "Too many enrollment attempts. Try again later."
 */
describe('concurrency gate', () => {
  it('never runs more than the ceiling at once, and still runs everything', async () => {
    const gate = createConcurrencyGate(3);
    let live = 0;
    let peak = 0;
    const done: number[] = [];

    await Promise.all(
      Array.from({ length: 20 }, (_unused, i) =>
        gate.run(async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((resolve) => setTimeout(resolve, 5));
          live -= 1;
          done.push(i);
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(done).toHaveLength(20);
    // Drained: a slot leaked by a thrown body would show up here as a gate that never empties.
    expect(gate.inFlight).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('gives the slot back when the work throws, so one failure is not a permanent hole', async () => {
    const gate = createConcurrencyGate(1);
    await expect(
      gate.run(() => Promise.reject(new Error('argon2 fell over'))),
    ).rejects.toThrow('argon2 fell over');
    expect(gate.inFlight).toBe(0);
    await expect(gate.run(() => Promise.resolve('served'))).resolves.toBe('served');
  });

  it('serves waiters in the order they arrived, so nobody starves', async () => {
    const gate = createConcurrencyGate(1);
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        gate.run(async () => {
          order.push(i);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

/**
 * What goes into an audit row about a limiter, and what deliberately does not: an operator has to be
 * able to recognise their own campus NAT, and a row that outlives the incident must not be a record
 * of where one named person was sitting.
 */
describe('coarsening an origin for the audit trail', () => {
  it('keeps the network and drops the host', () => {
    expect(coarseOrigin('203.0.113.7')).toBe('203.0.113.0/24');
    // A v4 client on a dual-stack socket is a v4 client.
    expect(coarseOrigin('::ffff:198.51.100.42')).toBe('198.51.100.0/24');
    expect(coarseOrigin('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48');
  });

  it('writes nothing down for anything it does not recognise', () => {
    expect(coarseOrigin(undefined)).toBe('unknown');
    expect(coarseOrigin('')).toBe('unknown');
    expect(coarseOrigin('not-an-address')).toBe('unknown');
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
  // app.ts, so req.ip follows that header). Nothing the client writes may
  // appear in this key — which is still true, and is why the key uses the TCP
  // peer rather than req.ip: see the handler, and the test below this one.
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

  /**
   * THE OTHER HALF OF THE TEST ABOVE, and the reason both are needed.
   *
   * Keyed on the account alone, that lockout was a weapon: the email is a value the CALLER supplies,
   * so five wrong guesses at a name a stranger picked refused that person's own correct password.
   * MEASURED, 2026-08-05: 24 requests held one named officer out of their own account for an hour,
   * and there was no way for them to clear it — `reset()` only runs on a success, which is the thing
   * being refused.
   *
   * So the key carries the TCP PEER as well. A header cannot change it (the test above), and a
   * stranger's failures therefore pile up against the stranger's own connection.
   *
   * The two clients here are two real sockets with different source addresses — 127.0.0.0/8 is all
   * local on Linux, so `localAddress` gives a genuinely different peer without a second machine.
   *
   * WHAT THIS DOES NOT CLAIM, and it is written into the handler as well: behind a reverse proxy
   * every client shares one peer, so on the documented deployment shape the composite collapses
   * back to the account and the lockout is reachable again. There is no per-client value that
   * survives a proxy and is not a header, and keying on a header is the defect the test above pins.
   */
  it('lets an account be signed into from another connection while one is locked out', async () => {
    const { app, bootstrap } = build();
    await seedAdmin(app, bootstrap);
    const attacker = new httpAgent({ localAddress: '127.0.0.2' });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await request(app)
        .post('/api/auth/login')
        .agent(attacker)
        .send({ email: 'admin@example.org', password: 'wrong-password-here' });
    }
    // The attacker has spent their own budget…
    const attackerNow = await request(app)
      .post('/api/auth/login')
      .agent(attacker)
      .send({ email: 'admin@example.org', password: GOOD_PASSWORD });
    expect(attackerNow.status).toBe(429);

    // …and the owner of the account, on their own connection, signs in.
    const owner = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.org', password: GOOD_PASSWORD });
    expect(owner.status).toBe(200);
    expect(owner.body.user.email).toBe('admin@example.org');
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
