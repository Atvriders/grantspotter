import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { Agent as httpAgent } from 'node:http';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createBootstrapState, FIRST_RUN_TOKEN_FILE } from '../src/auth/bootstrap.js';
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
   * WHAT THE MAP DOES OVER A PROCESS LIFETIME, WHICH IS NOT WHAT IT DOES OVER A WINDOW.
   *
   * `recent` prunes the key it is asked about and nothing else, so a caller who never repeats a key
   * never causes one to be read a second time and every key they ever touched stayed for good.
   * MEASURED by a reviewer at 342 bytes retained per distinct forged `X-Forwarded-For` — bounded
   * per window, unbounded over a lifetime, about 3.9 MB a day that only a restart returned.
   *
   * `keysRetained` exists because this is otherwise unassertable: `count` on a stale key answers 0
   * whether the key was swept or is sitting there. See `RateLimiterMemory`.
   */
  describe('what it keeps when nobody ever asks about the same key twice', () => {
    it('sweeps the keys whose window has passed instead of holding them for the process lifetime', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 100 });
      for (let i = 0; i < 2000; i += 1) limiter.recordFailure(`forged-${String(i)}`, 0);
      expect(limiter.keysRetained()).toBe(2000);

      // A second window, and a caller who has moved on to fresh keys — which is the whole point:
      // nothing will ever read the first two thousand again.
      for (let i = 0; i < 200; i += 1) limiter.recordFailure(`later-${String(i)}`, 5000);

      // Under 2,200. The old map only ever grew.
      expect(limiter.keysRetained()).toBeLessThanOrEqual(200);
      // And the sweep took nothing live with it: every one of the 200 is still counted.
      expect(limiter.count('later-0', 5000)).toBe(1);
      expect(limiter.count('later-199', 5000)).toBe(1);
    });

    it('does not sweep a small map at all, so an honest deployment pays nothing for this', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 100 });
      for (let i = 0; i < 50; i += 1) limiter.recordFailure(`net-${String(i)}`, 0);
      // Stale, and still there: the scan is not worth its own cost below the threshold, and these
      // keys cost nothing until something asks about them (which prunes them) or the map grows.
      for (let i = 0; i < 5; i += 1) limiter.recordFailure(`net-${String(i)}`, 9000);
      expect(limiter.keysRetained()).toBe(50);
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

  /**
   * A BUDGET WHOSE IN-FLIGHT ATTEMPTS ARE THE SUCCESSES, WHICH IS THE REGISTRATION LADDER.
   *
   * The case above — "nothing recorded, so the wait is one hash" — is right for a limiter counting
   * FAILURES, because an attempt that is still running usually succeeds and hands its slot back.
   * `api/auth.ts`'s three rungs count CREATED ACCOUNTS: every running attempt that succeeds charges,
   * so its slot never comes back and the budget is not draining, it is being spent.
   *
   * WHAT THE ONE-SECOND ANSWER COST, MEASURED against the built server on this host, 2026-08-12:
   * 260 students from one building NAT pressing submit together were answered 200 × 201 and 56 ×
   * `429 retryAfterSec=1`. A student who waited the one second they were told came back to
   * `429 retryAfterSec=897`. Off by 897×, in the branch whose comment justified it.
   *
   * THE PROPERTY THESE PIN IS THE ONE THE PRODUCT PROMISES: a caller who waits exactly as long as
   * they were told is not refused a second time. It is asserted arithmetically here, at the
   * limiter, because the shipped window is fifteen minutes and no test may sleep through it.
   */
  describe('a budget that counts successes', () => {
    it('quotes the window a held slot is about to occupy, not one hash', () => {
      const successes = createRateLimiter({
        windowMs: 900_000,
        maxFailures: 1,
        counts: 'successes',
      });
      successes.begin('k', 1000);
      const blocked = successes.begin('k', 4000);
      // 900 s of window less the 3 s the running attempt has already been holding its slot.
      expect(blocked.started === false && blocked.retryAfterSec).toBe(897);
      expect(blocked.started === false && blocked.recorded).toBe(0);

      // The same instant on a limiter counting failures still answers one hash, which is what that
      // branch was written for and is still true there.
      const failures = createRateLimiter({ windowMs: 900_000, maxFailures: 1 });
      failures.begin('k', 1000);
      const other = failures.begin('k', 4000);
      expect(other.started === false && other.retryAfterSec).toBe(1);
    });

    it('lets in the caller who waited exactly as long as it told them to', () => {
      const limiter = createRateLimiter({ windowMs: 900_000, maxFailures: 1, counts: 'successes' });
      const running = limiter.begin('k', 1000);
      const blocked = limiter.begin('k', 4000);
      if (blocked.started) throw new Error('the budget was open');
      const told = blocked.retryAfterSec;

      // The account is created 2.4 s after the refusal — the settle time measured for a
      // 260-student burst — and the slot becomes a recorded registration.
      if (running.started) running.charge();

      // Back at exactly the second they were given, and not one before it.
      expect(limiter.check('k', 4000 + told * 1000 - 1).allowed).toBe(false);
      expect(limiter.check('k', 4000 + told * 1000).allowed).toBe(true);
    });

    it('dates a charge from when the attempt started, so the wait it quoted stays true', () => {
      // The same run as above with the charge landing late: `charge()` takes no argument on the
      // registration path, and if it stamped the settle instead of the start, every forecast made
      // while that attempt was running would be short by however long the hash queue took.
      const limiter = createRateLimiter({ windowMs: 900_000, maxFailures: 1, counts: 'successes' });
      const running = limiter.begin('k', 1000);
      if (running.started) running.charge();
      expect(limiter.count('k', 1000)).toBe(1);
      // Recorded at 1000, so it is gone at 901000 — not at 901000 plus a settle nobody measured.
      expect(limiter.check('k', 900_999).allowed).toBe(false);
      expect(limiter.check('k', 901_000).allowed).toBe(true);
    });

    it('gives back the slot the attempt was holding when they settle out of order', () => {
      const limiter = createRateLimiter({ windowMs: 900_000, maxFailures: 2, counts: 'successes' });
      const first = limiter.begin('k', 1000);
      const second = limiter.begin('k', 2000);
      // The younger of the two goes, so the oldest slot held is still the one taken at 1000.
      if (second.started) second.release();
      expect(limiter.begin('k', 3000).started).toBe(true);

      const blocked = limiter.begin('k', 4000);
      expect(blocked.started === false && blocked.retryAfterSec).toBe(897);
      if (first.started) first.release();
    });
  });
});

/**
 * THE OTHER KIND OF LIMIT, and the reason it is a separate primitive rather than a second option on
 * the one above: a budget refuses, a gate waits. Confusing the two is what answered twenty of
 * thirty students with a valid enrollment code "Too many enrollment attempts. Try again later."
 */
const ONE_LANE = { peer: '203.0.113.7', route: 'sign-in', origin: '203.0.113.7' } as const;

/**
 * A wait ceiling far longer than anything these tests take, so that the deadline is inert unless a
 * test is deliberately about it. Every other assertion here is about the ROUND and about the DEPTH,
 * and a deadline firing inside one of them would be measuring the machine rather than the code.
 */
const NO_DEADLINE = 60_000;

/** A lane, spelled once. `route` defaults to sign-in because most of these tests predate it. */
function lane(peer: string, origin = peer, route: 'sign-in' | 'sign-up' = 'sign-in') {
  return { peer, route, origin } as const;
}

describe('concurrency gate', () => {
  it('never runs more than the ceiling at once, and still runs everything', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 3, maxQueued: 100, maxWaitMs: NO_DEADLINE });
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
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 10, maxWaitMs: NO_DEADLINE });
    await expect(
      gate.run(ONE_LANE, () => Promise.reject(new Error('argon2 fell over'))),
    ).rejects.toThrow('argon2 fell over');
    expect(gate.inFlight).toBe(0);
    await expect(gate.run(ONE_LANE, () => Promise.resolve('served'))).resolves.toBe('served');
  });

  it('serves one lane in the order it arrived, so nobody starves', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 10, maxWaitMs: NO_DEADLINE });
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
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 100, maxWaitMs: NO_DEADLINE });
    const served: string[] = [];
    const work = (tag: string) => async () => {
      served.push(tag);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const flood = lane('203.0.113.7');
    const student = lane('198.51.100.4');

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
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 100, maxWaitMs: NO_DEADLINE });
    const served: string[] = [];
    const work = (tag: string) => async () => {
      served.push(tag);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const tunnel = '10.0.0.1';

    const all = [gate.run(lane(tunnel, '203.0.113.7'), work('flood-0'))];
    for (let i = 1; i < 20; i += 1) {
      all.push(gate.run(lane(tunnel, '203.0.113.7'), work(`flood-${String(i)}`)));
    }
    all.push(gate.run(lane(tunnel, '198.51.100.4'), work('student')));
    await Promise.all(all);

    expect(served[2]).toBe('student');
  });

  /**
   * AND THE FIRST LEVEL IS WHAT STOPS THE SECOND BEING FORGED. With nothing in front of this
   * process the reported origin is a header the caller writes, so a flood can mint a lane per
   * request; the peer it arrives on is still one value, and one peer is still one share.
   */
  it('gives a caller minting a fresh reported origin per request no more than one peer share', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 100, maxWaitMs: NO_DEADLINE });
    const served: string[] = [];
    const work = (tag: string) => async () => {
      served.push(tag);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };

    const all = [gate.run(lane('203.0.113.7', 'forged-0'), work('flood-0'))];
    for (let i = 1; i < 20; i += 1) {
      all.push(gate.run(lane('203.0.113.7', `forged-${String(i)}`), work(`flood-${String(i)}`)));
    }
    all.push(gate.run(lane('198.51.100.4'), work('student')));
    await Promise.all(all);

    // Nineteen forged lanes bought one turn between them, because they are all one peer.
    expect(served[2]).toBe('student');
  });

  /**
   * THE LEVEL ADDED ON 2026-08-12, AND THE FINDING IT IS FOR.
   *
   * MEASURED against the built server: a 1,642 req/s flood on `/api/auth/login` while 130 students
   * registered from 130 distinct addresses — 37 accounts, 83 students SHED, 10 refused. The round
   * took turns between callers and knew nothing about routes, so a caller flooding sign-in was
   * competing for places that sign-up needed, and every shed sign-up had already spent a place in
   * the registration budget getting there.
   *
   * The two lanes here differ in NOTHING BUT THE ROUTE — same peer, same reported origin — so this
   * cannot pass by accident on either of the other two levels. Under the round this replaced they
   * were one lane and the sign-up was 21st of 21.
   */
  it('gives the other route its turn even when the flood is the same caller', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 100, maxWaitMs: NO_DEADLINE });
    const served: string[] = [];
    const work = (tag: string) => async () => {
      served.push(tag);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const signIn = lane('203.0.113.7', '203.0.113.7', 'sign-in');
    const signUp = lane('203.0.113.7', '203.0.113.7', 'sign-up');

    const all = [gate.run(signIn, work('flood-0'))];
    for (let i = 1; i < 20; i += 1) all.push(gate.run(signIn, work(`flood-${String(i)}`)));
    all.push(gate.run(signUp, work('student')));
    await Promise.all(all);

    expect(served.slice(0, 3)).toEqual(['flood-0', 'flood-1', 'student']);
    expect(served).toHaveLength(21);
  });

  /**
   * THE PROMISE ABOUT THE WAIT, ENFORCED RATHER THAN DERIVED.
   *
   * `MAX_QUEUED_HASHES` used to carry it as arithmetic — depth over concurrency times a slot cost
   * measured on an idle machine — and MEASURED under load on the same host that produced the
   * constant, the slot cost was 168 ms rather than 42 and a member's sign-in took 10,680 ms against
   * a promised worst case of 2,700. A promise that only holds when nothing else is happening is not
   * a promise about a queue.
   *
   * So a waiter that reaches the front having already waited too long is refused instead of
   * started. `expired` and `shed` are counted apart because they tell an operator different things.
   */
  it('drops a waiter that has waited longer than the promise instead of starting its work', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 10, maxWaitMs: 20 });
    let ran = 0;
    const slow = async (): Promise<void> => {
      ran += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
    };

    const running = gate.run(ONE_LANE, slow);
    await Promise.resolve();
    const waiting = gate.run(lane('198.51.100.4'), slow);

    await expect(waiting).rejects.toThrow(QueueFullError);
    await running;
    // One body ever started: the one that was already running. The 120 ms holder made the waiter
    // exceed a 20 ms promise, so its slot went nowhere rather than into a hash nobody is waiting
    // on any more.
    expect(ran).toBe(1);
    expect(gate.expired).toBe(1);
    // Not counted as a shed: the queue had nine places free the whole time.
    expect(gate.shed).toBe(0);
    expect(gate.inFlight).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('says which of the two refusals it was, so an operator can tell load from slowness', async () => {
    const full = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 1, maxWaitMs: NO_DEADLINE });
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const running = full.run(ONE_LANE, () => held);
    const queued = full.run(ONE_LANE, () => held).catch(() => undefined);
    await Promise.resolve();
    await expect(full.run(ONE_LANE, () => held)).rejects.toMatchObject({ reason: 'full' });
    open();
    await Promise.all([running, queued]);

    const slow = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 10, maxWaitMs: 20 });
    const busy = slow.run(ONE_LANE, () => new Promise((resolve) => setTimeout(resolve, 120)));
    await Promise.resolve();
    await expect(slow.run(lane('198.51.100.4'), () => Promise.resolve())).rejects.toMatchObject({
      reason: 'waited-too-long',
    });
    await busy;
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
  function saturate(
    gate: ReturnType<typeof createConcurrencyGate>,
    where: ReturnType<typeof lane>,
    n: number,
  ) {
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const runs = Array.from({ length: n }, () => gate.run(where, () => held).catch(() => 'shed'));
    return { runs, open };
  }

  it('sheds the flood rather than the caller who arrived into it', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 4, maxWaitMs: NO_DEADLINE });
    const flood = lane('203.0.113.7');
    const student = lane('198.51.100.4');

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
   * AND THE SAME LEVEL AT THE CEILING. Places in a full queue are the scarcer thing: taking turns
   * only helps somebody who is IN the queue, and the student measured above was not — they were
   * shed on arrival. The heaviest ROUTE is compared before the heaviest caller inside it, so a
   * sign-in flood cannot displace a sign-up however many connections it holds.
   */
  it('sheds the flooding route rather than the one request from the other one', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 4, maxWaitMs: NO_DEADLINE });
    const signIn = lane('203.0.113.7', '203.0.113.7', 'sign-in');
    const signUp = lane('203.0.113.7', '203.0.113.7', 'sign-up');

    const { runs, open } = saturate(gate, signIn, 5);
    await Promise.resolve();
    expect(gate.waiting).toBe(4);

    let studentRan = false;
    const studentRun = gate.run(signUp, async () => {
      studentRan = true;
    });
    expect(gate.shed).toBe(1);

    open();
    await Promise.all([...runs, studentRun]);
    expect(studentRan).toBe(true);
    expect((await Promise.all(runs)).filter((r) => r === 'shed')).toHaveLength(1);
  });

  /**
   * THE OTHER SIDE OF THE SAME RULE, and the reason it is a rule about SHARE rather than about
   * arrival order: when every lane is the same size there is no flood to shed, only genuine load,
   * and the honest answer is to turn away the newest rather than to drop somebody who has already
   * been waiting. That case is the only one in which a caller with one request is refused.
   */
  it('turns away the arrival when no lane is larger than any other', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 2, maxWaitMs: NO_DEADLINE });
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const nth = (n: number) => lane(`198.51.100.${String(n)}`);

    const running = gate.run(nth(1), () => held);
    const queued = [gate.run(nth(2), () => held), gate.run(nth(3), () => held)];
    await Promise.resolve();
    expect(gate.waiting).toBe(2);

    await expect(gate.run(nth(4), () => held)).rejects.toThrow(QueueFullError);
    // Nobody who was already waiting was disturbed to make room for somebody who was not.
    expect(gate.waiting).toBe(2);

    open();
    await Promise.all([running, ...queued]);
  });

  it('runs nothing for a shed request, so being turned away costs the caller nothing', async () => {
    const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 1, maxWaitMs: NO_DEADLINE });
    let started = 0;
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const flood = lane('203.0.113.7');
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
  /**
   * REWRITTEN ON 2026-08-12 BECAUSE THE DESIGN CHANGED, AND THE ASSERTION THAT WENT IS NAMED.
   *
   * This block used to require `crossed` to be true EXACTLY ONCE per window and false for every
   * event after it — "a caller who keeps going writes no further rows, so the trail cannot be used
   * to bury itself". That was a true description of the primitive and it was the wrong contract, in
   * a way only a measurement showed: a boolean can say nothing but "at least the threshold", so
   * both audit rows built on it printed the threshold CONSTANT, and 4,000 probes measured against
   * the built server produced one row saying `"answers":20`. Silence past the threshold IS the
   * bound on the trail, but total silence throws the magnitude away, and the magnitude is the whole
   * signal.
   *
   * So the contract is now: announce at the threshold, then at each DOUBLING of it, and answer with
   * the count rather than with a boolean. The anti-flood property the old assertion protected is
   * kept and asserted below in the form that survives — logarithmic, not constant.
   */
  it('answers with the count at the threshold, and says nothing in between', () => {
    const notice = createThresholdNotice({ windowMs: 1000, threshold: 3 });
    expect(notice.announce('k', 0)).toBe(0);
    expect(notice.announce('k', 10)).toBe(0);
    expect(notice.announce('k', 20)).toBe(3);
    // Silent until the count doubles, so a caller who keeps going cannot buy a row per request.
    expect(notice.announce('k', 30)).toBe(0);
    expect(notice.announce('k', 40)).toBe(0);
    expect(notice.announce('k', 50)).toBe(6);
    expect(notice.announce('k', 60)).toBe(0);
  });

  it('reports the magnitude of a flood in a logarithmic number of rows', () => {
    const notice = createThresholdNotice({ windowMs: 900_000, threshold: 20 });
    const announced: number[] = [];
    for (let i = 0; i < 4000; i += 1) {
      const n = notice.announce('one-source', i);
      if (n > 0) announced.push(n);
    }
    // The measured 4,000 probes: eight rows, the last of which says 2,560 — an operator can tell
    // this from a club intake, which is the one thing `{"answers":20}` could never do.
    expect(announced).toEqual([20, 40, 80, 160, 320, 640, 1280, 2560]);
  });

  it('counts each key separately and starts again in the next window', () => {
    const notice = createThresholdNotice({ windowMs: 1000, threshold: 2 });
    expect(notice.announce('a', 0)).toBe(0);
    expect(notice.announce('b', 0)).toBe(0);
    expect(notice.announce('a', 1)).toBe(2);
    expect(notice.announce('b', 1)).toBe(2);
    // Same key, next window: the count restarts, so a sustained flood is reported from the
    // threshold again rather than carrying on up the doubling ladder for the life of the process.
    expect(notice.announce('a', 1001)).toBe(0);
    expect(notice.announce('a', 1002)).toBe(2);
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
  /**
   * THIS TEST'S ASSERTION IS INVERTED, DELIBERATELY, AND THE OLD ONE WAS NOT WRONG.
   *
   * It required the startup banner to CONTAIN a 48-hex token, and for the life of this project that
   * was the design: the token was printed to the container log, `createBootstrapState` printed it
   * only while no account existed, and the README told the operator to read it with `awk`.
   *
   * The owner asked for it to stop being in the log, and the reason is one printing-only-once never
   * addressed: `docker logs` does not forget. The token is dead the moment it is spent, but the
   * line stays in the operator's scrollback, in journald, in whatever ships their logs, and in the
   * screenshot they paste into an issue. So the token goes to a file in `DATA_DIR` — mode 0600,
   * beside the database whose reader can already read every password hash in the deployment, and
   * removed the moment it is used — and the banner says where rather than what.
   */
  it('writes the one-time token to a file and keeps it out of the log', () => {
    const { bootstrap, logLines } = build();
    const printed = logLines.join('\n');
    expect(printed).toContain('GrantSpotter first-run setup');
    // The thing this change exists for.
    expect(printed).not.toMatch(/[0-9a-f]{48}/);

    const path = join(harness.dir, FIRST_RUN_TOKEN_FILE);
    expect(printed).toContain(path);
    // The token really is somewhere the operator can get it, and it is the one the route accepts.
    // The token in the file is the one this process will accept — not merely a token-shaped
    // string. A second `createBootstrapState` would mint and write a FRESH one (that is the
    // documented per-restart behaviour), so the comparison has to be against the live state.
    const written = readFileSync(path, 'utf8').trim();
    expect(written).toMatch(/^[0-9a-f]{48}$/);
    expect(written).toBe(bootstrap.token());
    // Owner-readable only. `DATA_DIR` is a mounted volume on the deployment this ships to, and the
    // mode is what stops a second container or another user on the host reading it.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  /**
   * A SPENT TOKEN LEAVES NOTHING BEHIND. Its absence is also how an operator can tell from the
   * outside that setup finished, without signing in to find out.
   */
  it('deletes the file when the token is used', async () => {
    const { app, bootstrap } = build();
    const path = join(harness.dir, FIRST_RUN_TOKEN_FILE);
    expect(existsSync(path)).toBe(true);

    const res = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token: bootstrap.token(), email: 'admin@example.org', password: GOOD_PASSWORD });
    expect(res.status).toBe(201);
    expect(existsSync(path)).toBe(false);
  });

  /**
   * THE FILE COULD NOT BE WRITTEN, AND THE DEPLOYMENT IS STILL SETTABLE-UP.
   *
   * The alternative to printing here is a first-run screen asking for a token that exists nowhere,
   * which is a deployment nobody can finish — so the token goes to the log, loudly, with the
   * reason and the fact that it will stay there. The failure is simulated by a directory occupying
   * the file's name, which is the same `writeFileSync` error a full disk or a per-file permission
   * produces. A wholly unwritable `DATA_DIR` never reaches this: SQLite cannot create its WAL and
   * the process exits before `createBootstrapState` is called (measured against the built server).
   */
  it('prints the token, with the reason, when the file cannot be written', () => {
    mkdirSync(join(harness.dir, FIRST_RUN_TOKEN_FILE));
    const { bootstrap, logLines } = build();
    const printed = logLines.join('\n');

    expect(printed).toContain('could NOT be written');
    // The operator can still finish setup, which is the whole reason this branch prints a secret.
    expect(printed).toContain(bootstrap.token());
    // And it says what that costs them, rather than leaving a stray credential in a log unremarked.
    expect(printed).toMatch(/will stay in this log/i);
  });

  /**
   * A TOKEN FILE FROM AN EARLIER BOOT IS SWEPT BY THE FIRST BOOT THAT FINDS THE DEPLOYMENT CLAIMED.
   * The ordinary path is `consume` deleting it; this is the path where the container was replaced,
   * or the account came from somewhere else, between one boot and the next.
   */
  it('sweeps a stale file left over from a boot that never finished setup', () => {
    const path = join(harness.dir, FIRST_RUN_TOKEN_FILE);
    build();
    expect(existsSync(path)).toBe(true);

    harness.db
      .prepare(
        'INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run('u1', 'a@example.org', 'a@example.org', 'h', 'admin', 'tok', 'now');

    createBootstrapState(harness.db, () => undefined);
    expect(existsSync(path)).toBe(false);
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

  /**
   * A DISABLED ACCOUNT IS THE ONE 401 ON THIS ROUTE THAT MUST NOT BE THE GENERIC ONE.
   *
   * The test above requires a wrong password and an unknown address to be answered identically, and
   * that is the anti-enumeration property this route is built around. This one is its boundary:
   * MEASURED against the built server on 2026-08-12 — enrol, sign in 200, `UPDATE users SET
   * disabled=1`, then the SAME correct password — the answer was "Incorrect email or password.",
   * byte for byte the wrong-password answer. The reader is the account's owner, an administrator
   * has just switched them off, and the product's only password reset is "ask an administrator", so
   * that sentence sends the one person who can do nothing to ask the one person who already
   * decided. The anti-enumeration argument cannot reach this state: getting here requires the
   * correct password, which is proof of ownership rather than a probe.
   */
  it('tells a disabled member the truth instead of blaming their password', async () => {
    const { app, bootstrap } = build();
    await seedAdmin(app, bootstrap);
    harness.db.prepare('UPDATE users SET disabled = 1').run();

    const correct = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.org', password: GOOD_PASSWORD });
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.org', password: 'a-different-password' });

    expect(correct.status).toBe(401);
    // The whole point: it is NOT the sentence a wrong password gets.
    expect(correct.body.error.message).not.toBe(wrong.body.error.message);
    expect(correct.body.error.message).toMatch(/switched off by an administrator/i);
    // And it says the thing that stops them chasing a password that is fine.
    expect(correct.body.error.message).toMatch(/your password is correct/i);
    // A wrong password on the same disabled account is still the generic answer: this branch must
    // not become a way to test passwords against a known-disabled address with a clearer oracle.
    expect(wrong.body.error.message).toBe('Incorrect email or password.');
  });

  /**
   * WHAT AN HTTP CLIENT READS, WHICH IS NOT THE ENVELOPE. MEASURED 2026-08-12: every 429 from both
   * unauthenticated routes answered `retry-after: undefined`, alone among this server's
   * rate-limited routes — `verifyRouter.ts`, `exports.ts` and `callsign.ts` all set it.
   */
  it('puts Retry-After on a sign-in 429, not only in the error details', async () => {
    const { app, bootstrap } = build();
    await seedAdmin(app, bootstrap);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@example.org', password: 'wrong-password-here' });
    }
    const blocked = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.org', password: GOOD_PASSWORD });

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBe(blocked.body.error.details.retryAfterSec);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
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

  /**
   * THIS TEST USED TO BE CALLED "does not expose a signup route" AND ITS CLAIM IS NOW FALSE.
   *
   * It POSTed `/api/auth/register`, expected 404, and stood for a real design property: for the
   * life of this project every account came from the first-run token, an administrator, or (later)
   * an enrollment code, and there was nowhere a stranger could make one. The owner has removed that
   * property on purpose. Leaving the test as it was would have kept it GREEN — nothing answers on
   * `/api/auth/register` — while the thing it was protecting had been deleted, which is the worst
   * of the three options.
   *
   * What survives is the narrower claim, and it is the one worth pinning: the public sign-up route
   * cannot mint an administrator, whatever it is sent. `api/enroll.test.ts` holds the rest.
   */
  it('has a public sign-up route that cannot make an administrator', async () => {
    const { app, bootstrap } = build();
    await seedAdmin(app, bootstrap);

    const res = await request(app)
      .post('/api/auth/enroll')
      .send({ email: 'stranger@example.org', password: GOOD_PASSWORD, role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('member');
    expect(
      harness.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get(),
    ).toEqual({ n: 1 });
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
