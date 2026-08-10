import { Agent as httpAgent } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createBootstrapState } from '../src/auth/bootstrap.js';
import {
  coarseOrigin,
  createConcurrencyGate,
  createRateLimiter,
  createThresholdNotice,
  QueueFullError,
} from '../src/auth/rateLimit.js';
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
   * `count` EXISTS TO BE SAID, NOT TO REFUSE. The enrolment route writes an audit row when an
   * account comes out of a place that has just been getting codes wrong, and "seven" and "one" are
   * the same boolean to `check`. See `RateLimiter.count`.
   */
  describe('how many, rather than whether', () => {
    it('reports the failures inside the window and forgets the ones outside it', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 100 });
      expect(limiter.count('k', 0)).toBe(0);
      for (const at of [0, 10, 20, 30, 40, 50, 60]) limiter.recordFailure('k', at);
      expect(limiter.count('k', 60)).toBe(7);
      // Past the window it is not a run of guesses any more, it is history.
      expect(limiter.count('k', 1100)).toBe(0);
    });

    it('does not count an attempt whose outcome is still unknown', () => {
      // `check` treats an in-flight attempt as spent, because it is deciding whether to allow more
      // work. This is going into a sentence about what has already happened, and a request that
      // may yet succeed is not a wrong code.
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 2 });
      const attempt = limiter.begin('k', 0);
      expect(limiter.check('k', 0).allowed).toBe(true);
      expect(limiter.count('k', 0)).toBe(0);
      if (attempt.started) attempt.charge(0);
      expect(limiter.count('k', 0)).toBe(1);
    });

    it('counts each key on its own', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 100 });
      limiter.recordFailure('a', 0);
      limiter.recordFailure('a', 0);
      limiter.recordFailure('b', 0);
      expect([limiter.count('a', 0), limiter.count('b', 0), limiter.count('c', 0)]).toEqual([
        2, 1, 0,
      ]);
    });
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
const ONE_LANE = { peer: '203.0.113.7', origin: '203.0.113.7' };

describe('concurrency gate', () => {
  it('never runs more than the ceiling at once, and still runs everything', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 3, maxQueued: 100 });
    let live = 0;
    let peak = 0;
    const done: number[] = [];

    await Promise.all(
      Array.from({ length: 20 }, (_unused, i) =>
        gate.run(ONE_LANE, async () => {
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
    expect(gate.shed).toBe(0);
  });

  it('gives the slot back when the work throws, so one failure is not a permanent hole', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 10 });
    await expect(
      gate.run(ONE_LANE, () => Promise.reject(new Error('argon2 fell over'))),
    ).rejects.toThrow('argon2 fell over');
    expect(gate.inFlight).toBe(0);
    await expect(gate.run(ONE_LANE, () => Promise.resolve('served'))).resolves.toBe('served');
  });

  it('serves one lane in the order it arrived, so nobody starves', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 10 });
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        gate.run(ONE_LANE, async () => {
          order.push(i);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  /**
   * THE FINDING THIS PRIMITIVE WAS REWRITTEN FOR, at the level where it can be asserted exactly
   * rather than in milliseconds.
   *
   * Strict FIFO put a caller with one request behind every request anybody else had already sent,
   * so one caller sending N of them chose everybody's wait — measured end to end on 2026-08-09 as
   * a student's enrolment going from 81 ms to 4,881 ms while a stranger held 512 connections open
   * on the sign-in route. Round-robin makes a caller's share 1/n of the service however many
   * requests they send, so the arithmetic below holds for any N.
   */
  it('gives a caller with one request the next turn, not the last one', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 100 });
    const served: string[] = [];
    const work = (tag: string) => async () => {
      served.push(tag);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const flood = { peer: '203.0.113.7', origin: '203.0.113.7' };
    const student = { peer: '198.51.100.4', origin: '198.51.100.4' };

    const all = [gate.run(flood, work('flood-0'))];
    for (let i = 1; i < 20; i += 1) all.push(gate.run(flood, work(`flood-${String(i)}`)));
    all.push(gate.run(student, work('student')));
    await Promise.all(all);

    // flood-0 took the free slot on arrival, so the round starts on the flood's lane and serves
    // flood-1 before it comes round to the student: 21st through the door, THIRD served, and third
    // for any size of flood at all. Under the FIFO this replaced the student was 21st out of 21.
    expect(served.slice(0, 3)).toEqual(['flood-0', 'flood-1', 'student']);
    expect(served).toHaveLength(21);
  });

  /**
   * THE SECOND LEVEL OF THE ROUND, and the deployment shape it is for. Behind a reverse proxy every
   * caller shares one TCP peer, so a round over peers alone would collapse to plain FIFO and the
   * finding would be reproducible through the operator's own tunnel. Taking turns over the
   * reported origin INSIDE each peer is what tells two users of one tunnel apart.
   */
  it('takes turns inside one peer, so a tunnel is not one lane', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 100 });
    const served: string[] = [];
    const work = (tag: string) => async () => {
      served.push(tag);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const tunnel = '10.0.0.1';

    const all = [gate.run({ peer: tunnel, origin: '203.0.113.7' }, work('flood-0'))];
    for (let i = 1; i < 20; i += 1) {
      all.push(gate.run({ peer: tunnel, origin: '203.0.113.7' }, work(`flood-${String(i)}`)));
    }
    all.push(gate.run({ peer: tunnel, origin: '198.51.100.4' }, work('student')));
    await Promise.all(all);

    expect(served[2]).toBe('student');
  });

  /**
   * AND THE FIRST LEVEL IS WHAT STOPS THE SECOND BEING FORGED. With nothing in front of this
   * process the reported origin is a header the caller writes, so a flood can mint a lane per
   * request; the peer it arrives on is still one value, and one peer is still one share.
   */
  it('gives a caller minting a fresh reported origin per request no more than one peer share', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 100 });
    const served: string[] = [];
    const work = (tag: string) => async () => {
      served.push(tag);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };

    const all = [gate.run({ peer: '203.0.113.7', origin: 'forged-0' }, work('flood-0'))];
    for (let i = 1; i < 20; i += 1) {
      all.push(
        gate.run({ peer: '203.0.113.7', origin: `forged-${String(i)}` }, work(`flood-${String(i)}`)),
      );
    }
    all.push(gate.run({ peer: '198.51.100.4', origin: '198.51.100.4' }, work('student')));
    await Promise.all(all);

    // Nineteen forged lanes bought one turn between them, because they are all one peer.
    expect(served[2]).toBe('student');
  });
});

/**
 * WHAT HAPPENS AT THE CEILING, which is the half of the fix that bounds MEMORY and the wait rather
 * than dividing them fairly. The rule is that the request dropped is the newest one belonging to
 * whoever holds the largest share — so a flood can only ever displace itself, and the person with
 * one request in a queue full of somebody else's is never the one turned away.
 */
describe('what the gate sheds when it is full', () => {
  /** Hold every slot and every queue place, and hand back a lever to let them all finish. */
  function saturate(gate: ReturnType<typeof createConcurrencyGate>, lane: { peer: string; origin: string }, n: number) {
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const runs = Array.from({ length: n }, () => gate.run(lane, () => held).catch(() => 'shed'));
    return { runs, open };
  }

  it('sheds the flood rather than the caller who arrived into it', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 4 });
    const flood = { peer: '203.0.113.7', origin: '203.0.113.7' };
    const student = { peer: '198.51.100.4', origin: '198.51.100.4' };

    // One running plus four queued is the whole gate.
    const { runs, open } = saturate(gate, flood, 5);
    await Promise.resolve();
    expect(gate.waiting).toBe(4);

    // The student walks into a full queue and is admitted; one of the flood's is shed for them.
    let studentRan = false;
    const studentRun = gate.run(student, async () => {
      studentRan = true;
    });
    expect(gate.shed).toBe(1);
    expect(gate.waiting).toBe(4);

    open();
    await Promise.all([...runs, studentRun]);
    expect(studentRan).toBe(true);
    expect((await Promise.all(runs)).filter((r) => r === 'shed')).toHaveLength(1);
    expect(gate.inFlight).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  /**
   * THE OTHER SIDE OF THE SAME RULE, and the reason it is a rule about SHARE rather than about
   * arrival order: when every lane is the same size there is no flood to shed, only genuine load,
   * and the honest answer is to turn away the newest rather than to drop somebody who has already
   * been waiting. That case is the only one in which a caller with one request is refused.
   */
  it('turns away the arrival when no lane is larger than any other', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 2 });
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const lane = (n: number) => ({ peer: `198.51.100.${String(n)}`, origin: `198.51.100.${String(n)}` });

    const running = gate.run(lane(1), () => held);
    const queued = [gate.run(lane(2), () => held), gate.run(lane(3), () => held)];
    await Promise.resolve();
    expect(gate.waiting).toBe(2);

    await expect(gate.run(lane(4), () => held)).rejects.toThrow(QueueFullError);
    // Nobody who was already waiting was disturbed to make room for somebody who was not.
    expect(gate.waiting).toBe(2);

    open();
    await Promise.all([running, ...queued]);
  });

  it('runs nothing for a shed request, so being turned away costs the caller nothing', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 1 });
    let started = 0;
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const flood = { peer: '203.0.113.7', origin: '203.0.113.7' };
    const count = async (): Promise<void> => {
      started += 1;
      await held;
    };

    const running = gate.run(flood, count);
    const waiting = gate.run(flood, count).catch(() => 'shed');
    await Promise.resolve();
    await expect(gate.run(flood, count)).rejects.toThrow(QueueFullError);

    open();
    await Promise.all([running, waiting]);
    // Two bodies ever started: the one that was running and the one that was queued. The third
    // never entered `work`, which is what makes a shed cheap for this process as well as for them.
    expect(started).toBe(2);
    expect(gate.shed).toBe(1);
  });
});

/**
 * THE COUNTER THAT ONLY SPEAKS. Every other limiter in this file answers "may this proceed?"; this
 * one answers "should somebody be told?", and it was added because 3,776 unauthenticated requests
 * measured on 2026-08-09 produced zero rows in `audit_log`.
 */
describe('threshold notice', () => {
  it('is true exactly once, on the event that reaches the threshold', () => {
    const notice = createThresholdNotice({ windowMs: 1000, threshold: 3 });
    expect(notice.crossed('k', 0)).toBe(false);
    expect(notice.crossed('k', 10)).toBe(false);
    expect(notice.crossed('k', 20)).toBe(true);
    // A caller who keeps going writes no further rows, so the trail cannot be used to bury itself.
    expect(notice.crossed('k', 30)).toBe(false);
    expect(notice.crossed('k', 40)).toBe(false);
  });

  it('counts each key separately and starts again in the next window', () => {
    const notice = createThresholdNotice({ windowMs: 1000, threshold: 2 });
    expect(notice.crossed('a', 0)).toBe(false);
    expect(notice.crossed('b', 0)).toBe(false);
    expect(notice.crossed('a', 1)).toBe(true);
    expect(notice.crossed('b', 1)).toBe(true);
    // Same key, next window: the count restarts, so a sustained flood is reported once a window.
    expect(notice.crossed('a', 1001)).toBe(false);
    expect(notice.crossed('a', 1002)).toBe(true);
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
