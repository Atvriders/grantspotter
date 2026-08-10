import type Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createBootstrapState } from '../auth/bootstrap.js';
import { hashPassword } from '../auth/password.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { loadConfig } from '../config.js';
import {
  createEnrollmentCodeRepo,
  type EnrollmentCodeRepo,
} from '../db/repositories/enrollmentCodes.js';
import { createTestDb, type TestDb } from '../../test/helpers/tempDb.js';

/**
 * WHAT AN ANONYMOUS CALLER CAN MAKE THIS SERVER SPEND, counted rather than argued.
 *
 * `enroll.test.ts` asserts what `POST /api/auth/enroll` ANSWERS. This file asserts what it COSTS —
 * and what `POST /api/auth/login` costs, because the two unauthenticated routes that hash a
 * password had the same defect and were fixed in the same change. The three findings pinned here
 * were all invisible to a suite that sent one request at a time and read only the status code: the
 * work is done between the check and the record, so a test that never overlaps two requests cannot
 * see it, and the ledger it should show up in is the one the defect skips.
 *
 * IT COUNTS THE REAL argon2id CALLS. The module is wrapped, not replaced — every hash below is a
 * genuine 19 MiB, two-pass hash, so the CPU figures are the ones a deployment would pay. Replacing
 * argon2 with a stub would make this file fast and worthless: the whole point is that the hash is
 * expensive, and a stub is the one thing that is not.
 */
const argon2Calls = vi.hoisted(() => ({ hash: 0, verify: 0 }));

/**
 * A seam for watching hashes OVERLAP rather than merely counting them.
 *
 * Counting answers a different question from counting concurrency, and the difference is the whole
 * subject of this file: the route's ceiling on in-flight work is a claim about what is running at
 * one instant, and no total can confirm or refute it. A test that wants to know the peak has to be
 * inside the call, so this hook wraps it — still the real argon2id underneath.
 */
const argon2Hooks = vi.hoisted(() => ({
  onHash: null as null | ((run: () => Promise<string>) => Promise<string>),
}));

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@node-rs/argon2')>();
  return {
    ...actual,
    hash: (...args: Parameters<typeof actual.hash>) => {
      argon2Calls.hash += 1;
      const run = (): Promise<string> => actual.hash(...args);
      return argon2Hooks.onHash === null ? run() : argon2Hooks.onHash(run);
    },
    verify: (...args: Parameters<typeof actual.verify>) => {
      argon2Calls.verify += 1;
      return actual.verify(...args);
    },
  };
});

const config = loadConfig({
  SESSION_SECRET: 'z'.repeat(32),
  NODE_ENV: 'test',
  CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter',
});

const GOOD_PASSWORD = 'a-long-enough-password';
const ADMIN_ID = 'admin-1';
const WRONG_CODE = 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZ2';

let seedHash: Promise<string> | undefined;
function seededPasswordHash(): Promise<string> {
  seedHash ??= hashPassword('a-seeded-password-not-a-real-secret');
  return seedHash;
}

let harness: TestDb;
let db: Database.Database;
let codes: EnrollmentCodeRepo;

beforeEach(async () => {
  harness = createTestDb();
  db = harness.db;
  codes = createEnrollmentCodeRepo(db);
  db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
     VALUES (?, 'admin@example.org', 'admin@example.org', ?, 'admin', 'ics-admin', ?)`,
  ).run(ADMIN_ID, await seededPasswordHash(), '2026-09-01T00:00:00.000Z');
  argon2Calls.hash = 0;
  argon2Calls.verify = 0;
}, 30_000);

afterEach(() => harness.cleanup());

function build() {
  return createApp({
    db,
    config,
    bootstrap: createBootstrapState(db, () => undefined),
    loginLimiter: createRateLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 5 }),
    logger: () => undefined,
  });
}

/**
 * A generated code, unwrapped.
 *
 * `create` returns a union since an administrator may now TYPE a code and collide with an existing
 * one (`db/repositories/enrollmentCodes.ts`). Nothing in this file types one — every call here
 * passes `chosen: null` — so the refusal branch is unreachable, and it is thrown on rather than
 * asserted away so that a future edit which does collide fails HERE, naming itself, instead of
 * surfacing as an undefined `plaintext` twenty lines further down.
 */
function issue(over: Partial<Parameters<EnrollmentCodeRepo['create']>[0]> = {}) {
  const issued = codes.create({
    label: 'W1MX autumn 2026 intake',
    chosen: null,
    maxUses: null,
    expiresAt: null,
    createdByUserId: ADMIN_ID,
    nowISO: new Date().toISOString(),
    ...over,
  });
  if (!issued.ok) throw new Error('issue(): the generated code collided with an existing one');
  return issued;
}

/** Total CPU (user + system) burned by this process, in milliseconds. */
function cpuMs(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

describe('what one unauthenticated burst can make this route do', () => {
  /**
   * THE THIRD APPEARANCE OF ONE SHAPE: check, then act, with an `await` in between.
   *
   * The callsign lookup had it (eight concurrent presses through a limit meant to allow one) and
   * the enrolment redemption had it (six accounts from a one-use code). Here it was the limiter
   * itself: `check()` ran before `await hashPassword(...)` and `recordFailure()` after it, so every
   * request that arrived before the first hashes finished passed a check that none of them had yet
   * paid for.
   *
   * MEASURED on this host before the fix, with exactly this harness: 240 concurrent wrong-code
   * enrolments produced 240 argon2id hashes, 10,181 ms of CPU and 240 answers of "that code is not
   * valid" — against a failure budget of ten. After it: 10 hashes, 991 ms of CPU, 10 answers and
   * 230 refusals.
   */
  const BURST = 240;

  it('performs at most ten argon2id hashes for a 240-request wrong-code burst', async () => {
    issue();
    const app = build();

    const startCpu = cpuMs();
    const startWall = Date.now();
    const responses = await Promise.all(
      Array.from({ length: BURST }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({
            code: WRONG_CODE,
            email: `burst-${String(i)}@example.org`,
            password: GOOD_PASSWORD,
          }),
      ),
    );
    const spentCpu = cpuMs() - startCpu;
    const wall = Date.now() - startWall;

    const refused = responses.filter((r) => r.status === 429).length;
    const answered = responses.filter((r) => r.status === 401).length;
    console.log(
      `[burst] requests=${String(BURST)} hashes=${String(argon2Calls.hash)} ` +
        `cpu=${spentCpu.toFixed(0)}ms wall=${String(wall)}ms 401=${String(answered)} ` +
        `429=${String(refused)}`,
    );

    // THE CEILING THE COMMENT IN auth.ts CLAIMS. Ten failures per window means ten hashes per
    // window, however many callers arrive at once.
    expect(argon2Calls.hash).toBeLessThanOrEqual(10);
    // Nobody got in, and everybody got an answer.
    expect(answered + refused).toBe(BURST);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member'").get() as { n: number }).n,
    ).toBe(0);
  }, 120_000);
});

/**
 * THE OTHER HALF OF EVERY RATE LIMIT: what it does to the people who are not attacking.
 *
 * A gate that bounds the work by refusing everybody bounds nothing worth having. These two pin what
 * the budget costs the people it is not aimed at, and they are the reason the claim is a budget of
 * ten rather than the single lane the callsign lookup uses: there the thing being rationed is
 * somebody else's server and one at a time is the promise, here it is this process's own CPU and a
 * club intake pressing submit together must not be serialised into a queue of refusals.
 */
describe('what the gate does not do to legitimate traffic', () => {
  it('lets ten people enrol at the same instant, all of them successfully', async () => {
    const { code, plaintext } = issue({ maxUses: 10 });
    const app = build();

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({
            code: plaintext,
            email: `together-${String(i)}@example.org`,
            password: GOOD_PASSWORD,
          }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(10);
    expect(codes.findById(code.id)?.uses).toBe(10);
  }, 120_000);

  it('does not put eight people signing in at once behind one another', async () => {
    const app = build();
    const stmt = db.prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
       VALUES (?, ?, ?, ?, 'member', ?, ?)`,
    );
    const hash = await seededPasswordHash();
    for (let i = 0; i < 8; i += 1) {
      const email = `member-${String(i)}@example.org`;
      stmt.run(`m-${String(i)}`, email, email, hash, `ics-m-${String(i)}`, '2026-09-01T00:00:00.000Z');
    }
    argon2Calls.verify = 0;

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        request(app)
          .post('/api/auth/login')
          .send({
            email: `member-${String(i)}@example.org`,
            password: 'a-seeded-password-not-a-real-secret',
          }),
      ),
    );

    // Eight different accounts are eight different buckets: every one of them is answered, and
    // every one of them costs the verify it is entitled to.
    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: 8 }, () => 200));
    expect(argon2Calls.verify).toBe(8);
  }, 120_000);
});

describe('the same shape on the other unauthenticated route that hashes', () => {
  const BURST = 60;

  /**
   * SIGN-IN HAD IT TOO, and it was worth checking rather than assuming: `check` before
   * `await verifyPasswordConstantTime(...)` and `recordFailure` after it is the identical
   * arrangement, so five was the number of wrong passwords one account tolerated ONE AT A TIME and
   * not the number of argon2id verifies it could be made to run at once.
   *
   * MEASURED on this host by reverting only the login handler to the previous shape: 60 concurrent
   * wrong passwords for one account produced 60 argon2id verifies. After the fix: 5.
   *
   * WHAT THIS TEST DOES NOT CLAIM. The bucket is the account, so this bounds the work one ACCOUNT
   * can be made to do. A caller who rotates the email address still gets a fresh bucket per address
   * and one real verify each (against the dummy hash, which is what keeps account existence out of
   * the response timing) — see the handler's comment for why a global gate on sign-in would be a
   * worse failure than the one it prevents.
   */
  it('runs at most five argon2id verifies for sixty concurrent wrong passwords on one account', async () => {
    const app = build();
    argon2Calls.verify = 0;

    const responses = await Promise.all(
      Array.from({ length: BURST }, () =>
        request(app)
          .post('/api/auth/login')
          .send({ email: 'admin@example.org', password: 'wrong-password-here' }),
      ),
    );

    const unauthorized = responses.filter((r) => r.status === 401).length;
    const refused = responses.filter((r) => r.status === 429).length;
    console.log(
      `[login] requests=${String(BURST)} verifies=${String(argon2Calls.verify)} ` +
        `401=${String(unauthorized)} 429=${String(refused)}`,
    );

    expect(argon2Calls.verify).toBeLessThanOrEqual(5);
    expect(unauthorized + refused).toBe(BURST);
    expect(refused).toBeGreaterThan(0);
  }, 120_000);
});

describe('what a valid code tells its holder about other people', () => {
  const PROBES = 200;

  async function seedKnownMembers(): Promise<void> {
    const stmt = db.prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
       VALUES (?, ?, ?, ?, 'member', ?, ?)`,
    );
    const hash = await seededPasswordHash();
    for (let i = 0; i < PROBES; i += 1) {
      const email = `known-${String(i)}@example.org`;
      stmt.run(`u-${String(i)}`, email, email, hash, `ics-${String(i)}`, '2026-09-01T00:00:00.000Z');
    }
  }

  /** A 409 that NAMES the address is the specific answer; one that does not is the vague one. */
  function namesAddress(res: request.Response, email: string): boolean {
    return res.status === 409 && String(res.body?.error?.message ?? '').includes(email);
  }

  /**
   * MEASURED before the fix: 200 probes with one `maxUses: null` code returned 200 answers that
   * separated "this address has an account" (409, naming it) from "this one does not" (201) — for
   * free, in one window, with nothing written down anywhere. A club officer's code, read out to
   * thirty people, was a membership oracle for the whole deployment.
   *
   * WHAT THIS TEST USED TO ASSERT, AND WHY IT NO LONGER DOES. It counted every 409 as an answer
   * "learned" and required 195 of the 200 to be 429 — that is, it pinned the behaviour where a code
   * that has been probed five times refuses everybody who uses it for the next fifteen minutes,
   * including the students it was issued for. That refusal was the denial-of-service primitive an
   * adversarial reader demonstrated on 2026-08-05 (five presses by one honest returning student
   * closed her club's intake), so the 429 is gone and the count of "learned" has to mean something
   * narrower and truer: how many of those answers NAMED the person asked about.
   *
   * It also asserted `argon2Calls.hash === 0`, on the reasoning that a probe should be cheap for
   * this process. That assertion is inverted here, deliberately and with the same care: a probe
   * being cheap is exactly what made 2.4 million addresses an hour possible. Past the budget a
   * probe now pays the same argon2id an enrolment pays, which is what the next test measures.
   */
  it('names a handful of already-registered addresses and then names nobody', async () => {
    const { code, plaintext } = issue();
    const app = build();
    await seedKnownMembers();

    argon2Calls.hash = 0;
    const named: number[] = [];
    const vague: number[] = [];
    const refused: number[] = [];
    for (let i = 0; i < PROBES; i += 1) {
      const email = `known-${String(i)}@example.org`;
      const res = await request(app)
        .post('/api/auth/enroll')
        .send({ code: plaintext, email, password: GOOD_PASSWORD });
      if (namesAddress(res, email)) named.push(i);
      else if (res.status === 409) vague.push(i);
      else refused.push(i);
    }

    console.log(
      `[probe] probes=${String(PROBES)} named=${String(named.length)} ` +
        `vague=${String(vague.length)} other=${String(refused.length)} ` +
        `hashes=${String(argon2Calls.hash)}`,
    );

    // A person who genuinely already has an account is still told so, plainly. A caller asking the
    // question about a LIST runs out of that answer almost immediately.
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThanOrEqual(5);
    // Everybody else is still answered — no refusals at all — and told nothing about anybody.
    expect(named.length + vague.length).toBe(PROBES);
    expect(refused).toEqual([]);
    // And every NAMED one is written down against the code that asked it, so an administrator can
    // see which code is being used this way and revoke it.
    const trail = db
      .prepare("SELECT entity_id, detail FROM audit_log WHERE action = 'enrollment_code.conflict'")
      .all() as Array<{ entity_id: string; detail: string }>;
    expect(trail).toHaveLength(named.length);
    expect(trail.every((r) => r.entity_id === code.id)).toBe(true);
    // Never the address that was asked about: the trail must not become the list it is there to
    // stop somebody building.
    expect(JSON.stringify(trail)).not.toContain('known-0@example.org');
    // One argon2id for every probe past the budget, and none for the ones inside it. The number is
    // here so that a change which makes probing cheap again shows up as a change in cost.
    expect(argon2Calls.hash).toBe(vague.length);
  }, 180_000);

  /**
   * INDISTINGUISHABLE HAS TO INCLUDE THE COST, or it is a property of the status line only.
   *
   * Past the disclosure budget the two answers still differ — a member gets 409, a stranger gets
   * 201 and an account — and they always will, because making them identical means refusing to
   * create the account, which is the denial this whole change removes. What CAN be equalised is
   * what the two cost, and here it is: both pay one argon2id, so the wall clock cannot be used to
   * sort a list faster than the route can hash.
   *
   * MEASURED before the fix, with the address check above the password floor: 200 probes at 554/sec
   * against 23/sec for a probe that had to carry a legal password — a 24x discount for asking about
   * somebody who exists. The assertion below is a ratio rather than a rate because the absolute
   * numbers belong to whichever machine runs it.
   */
  it('makes an already-registered address cost what a new one costs, past the budget', async () => {
    const { plaintext } = issue();
    const app = build();
    await seedKnownMembers();

    const SAMPLE = 12;
    // Spend the disclosure budget first: this measures the past-the-budget path on both sides.
    for (let i = 0; i < 6; i += 1) {
      await request(app)
        .post('/api/auth/enroll')
        .send({ code: plaintext, email: `known-${String(i)}@example.org`, password: GOOD_PASSWORD });
    }

    async function timeOne(email: string): Promise<number> {
      const started = performance.now();
      await request(app)
        .post('/api/auth/enroll')
        .send({ code: plaintext, email, password: GOOD_PASSWORD });
      return performance.now() - started;
    }

    // INTERLEAVED, AND A MEDIAN, because the first version of this was measuring the machine as
    // much as the route. It timed all twelve member requests and THEN all twelve stranger
    // requests, so any slowdown arriving between the two batches — another job landing on a
    // shared runner — was charged entirely to whichever side went second. It failed CI at
    // ratio 0.408 while five consecutive local runs sat between 0.81 and 1.02, and a threshold
    // widened to swallow that would have been the assertion giving up rather than the
    // measurement improving.
    //
    // Alternating the two makes drift hit both sides equally, and alternating WHICH GOES FIRST
    // within each pair cancels any residual advantage in being second (a warm connection, a
    // settled thread pool). The median then stops one stalled request deciding the result, which
    // a mean over twelve cannot.
    //
    // The threshold below is unchanged at 0.5. That is the point: the fix belongs in how the
    // number is obtained, not in how much wrongness it is willing to accept.
    const hits: number[] = [];
    const misses: number[] = [];
    for (let i = 0; i < SAMPLE; i += 1) {
      const member = `known-${String(i + 20)}@example.org`;
      const stranger = `stranger-${String(i)}@example.org`;
      if (i % 2 === 0) {
        hits.push(await timeOne(member));
        misses.push(await timeOne(stranger));
      } else {
        misses.push(await timeOne(stranger));
        hits.push(await timeOne(member));
      }
    }

    const median = (xs: readonly number[]): number => {
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    };
    const hit = median(hits);
    const miss = median(misses);
    const ratio = hit / miss;
    console.log(
      `[cost] member=${hit.toFixed(1)}ms stranger=${miss.toFixed(1)}ms ratio=${ratio.toFixed(2)} (medians of ${String(SAMPLE)} interleaved pairs)`,
    );

    // Both paths are one argon2id plus a few indexed statements; a factor of two either way is
    // noise on a shared machine, and anything outside it means one of them stopped hashing.
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  }, 180_000);

  /**
   * THE SAME 200 PROBES, ALL AT ONCE — the shape of the defect this whole change is about, applied
   * to the fix for it.
   *
   * A budget read at the top of the handler and charged after the hash would be exactly as leaky as
   * the wrong-code budget was: every probe that arrived before the first one finished hashing would
   * read a budget at zero and be answered. It is charged in the same synchronous stretch as it is
   * read instead, which is why concurrency makes no difference to this number.
   */
  it('names no more people when the 200 probes arrive at once', async () => {
    const { plaintext } = issue();
    const app = build();
    await seedKnownMembers();

    const responses = await Promise.all(
      Array.from({ length: PROBES }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({
            code: plaintext,
            email: `known-${String(i)}@example.org`,
            password: GOOD_PASSWORD,
          }),
      ),
    );

    const named = responses.filter((r, i) => namesAddress(r, `known-${String(i)}@example.org`));
    const conflicts = responses.filter((r) => r.status === 409);
    console.log(
      `[probe-burst] probes=${String(PROBES)} named=${String(named.length)} ` +
        `conflicts=${String(conflicts.length)}`,
    );
    expect(named).toHaveLength(5);
    // Everybody was answered, and nobody was refused.
    expect(conflicts).toHaveLength(PROBES);
  }, 180_000);
});

/**
 * THE CEILING ON WORK, WHICH IS NOT THE CEILING ON PEOPLE.
 *
 * `MAX_CONCURRENT_HASHES` in `api/auth.ts` claims that this process never has more than four
 * argon2id operations in flight, across both unauthenticated routes that run one, and that nothing
 * is refused to make that true. Both halves are asserted here, because a queue that silently
 * becomes a refusal under load is the defect this whole change is about and it would not show up in
 * any status code until the day it did.
 */
describe('how much argon2id one burst can have running at once', () => {
  const BURST = 40;

  it('never exceeds four concurrent hashes, and still enrols all forty', async () => {
    const { code, plaintext } = issue({ maxUses: BURST });
    const app = build();

    let live = 0;
    let peak = 0;
    const previous = argon2Hooks.onHash;
    argon2Hooks.onHash = async (run) => {
      live += 1;
      peak = Math.max(peak, live);
      try {
        return await run();
      } finally {
        live -= 1;
      }
    };

    try {
      const responses = await Promise.all(
        Array.from({ length: BURST }, (_unused, i) =>
          request(app)
            .post('/api/auth/enroll')
            .send({
              code: plaintext,
              email: `crowd-${String(i)}@example.org`,
              password: GOOD_PASSWORD,
            }),
        ),
      );
      console.log(`[gate] burst=${String(BURST)} peakConcurrentHashes=${String(peak)}`);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(4);
      expect(responses.filter((r) => r.status === 201)).toHaveLength(BURST);
      expect(codes.findById(code.id)?.uses).toBe(BURST);
    } finally {
      argon2Hooks.onHash = previous;
    }
  }, 180_000);
});

/**
 * WHAT ONE STRANGER CAN DO TO EVERYBODY ELSE, which is a different question from what they can do
 * to a route and is the one the tests above could not see.
 *
 * THE FINDING. `POST /api/auth/login` runs a real argon2id verify per request on purpose — against
 * a dummy hash when no such account exists, so that response timing does not say which addresses
 * are accounts — and its budget is keyed `(peer, email)`. A caller who never uses the same address
 * twice therefore never meets it, and until 2026-08-09 every one of those requests took a place in
 * a shared, unbounded, first-come-first-served queue that `POST /api/auth/enroll` waits in too.
 *
 * MEASURED against a real listening server in its own process, 512 connections, rotating email,
 * no account and no code, one reverse proxy in front (the documented deployment, so every request
 * shares a TCP peer and `req.ip` is what the proxy wrote):
 *
 *                        before (a4a863b)     after
 *   student's enrolment  5,036 ms (91.6x)     330 ms (5.5x)
 *   attacker's rate      6,462 req/min        67,710 req/min, 15,942 of them refused
 *   audit rows about it  0                    2
 *
 * and before the fix the student's latency rose in step with the attacker's connection count —
 * 24 connections 243 ms, 96 → 967 ms, 256 → 2,507 ms, 512 → 4,881 ms — which is the property that
 * makes it a denial of service rather than a slow afternoon: the caller chooses everyone's wait.
 *
 * THESE TESTS COUNT PLACES IN THE QUEUE RATHER THAN MILLISECONDS. The wall-clock figures above
 * belong to the machine that produced them; what belongs to the code is that the student is served
 * after a couple of turns instead of after the whole flood, and that holds at any hash speed.
 *
 * The lanes are `X-Forwarded-For` because supertest is loopback and every request shares a TCP
 * peer, which is exactly the documented deployment: one tunnel in front, `trust proxy` 1, so
 * `req.ip` is the address the tunnel wrote and is what tells two of its users apart.
 */
describe('what a sign-in flood does to somebody who is not in it', () => {
  const FLOOD = 300;
  const ATTACKER = '203.0.113.9';
  const STUDENT = '198.51.100.4';

  it('serves the student in a couple of turns instead of behind three hundred strangers', async () => {
    const { plaintext } = issue();
    const app = build();

    let settled = 0;
    const flood = Array.from({ length: FLOOD }, (_unused, i) =>
      request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ATTACKER)
        // A FRESH ADDRESS EVERY TIME, which is what makes the `(peer, email)` budget blind to it.
        .send({ email: `flood-${String(i)}@example.net`, password: 'not-the-password' })
        .then((res) => {
          settled += 1;
          return res.status;
        }),
    );

    // Let the flood reach the gate before the student presses submit.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const aheadAtStart = settled;
    const student = await request(app)
      .post('/api/auth/enroll')
      .set('X-Forwarded-For', STUDENT)
      .send({ code: plaintext, email: 'student@example.org', password: GOOD_PASSWORD });
    const servedAhead = settled - aheadAtStart;

    const statuses = await Promise.all(flood);
    const shed = statuses.filter((s) => s === 429).length;
    console.log(
      `[starve] flood=${String(FLOOD)} floodShed=${String(shed)} ` +
        `studentStatus=${String(student.status)} floodServedBeforeStudent=${String(servedAhead)}`,
    );

    // THE ASSERTION THE FINDING IS ABOUT. The student joined a queue of ~300 and was served after
    // a handful of the flood's requests, because the round is between CALLERS: one caller's share
    // is 1/n of the service however many requests they send. Under the FIFO this replaced the
    // student was behind every single one of them.
    expect(student.status).toBe(201);
    expect(servedAhead).toBeLessThan(FLOOD / 4);
    // Nobody legitimate was refused to achieve that, which is the other half of the claim.
    expect(statuses.filter((s) => s === 401).length + shed).toBe(FLOOD);
    // And the flood, not the student, is what the ceiling fell on.
    expect(shed).toBeGreaterThan(0);
  }, 180_000);

  /**
   * THE CONTROL THAT MAKES THE ONE ABOVE MEAN SOMETHING. If a student in the flood's own lane were
   * also served early, the number above would be measuring luck rather than the round.
   */
  it('does not give the flood a shortcut by joining its own lane', async () => {
    const { plaintext } = issue();
    const app = build();

    let settled = 0;
    const flood = Array.from({ length: FLOOD }, (_unused, i) =>
      request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ATTACKER)
        .send({ email: `same-lane-${String(i)}@example.net`, password: 'not-the-password' })
        .then((res) => {
          settled += 1;
          return res.status;
        }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const aheadAtStart = settled;
    // Same X-Forwarded-For as the flood: this caller IS the flood as far as the server can tell.
    const inLane = await request(app)
      .post('/api/auth/enroll')
      .set('X-Forwarded-For', ATTACKER)
      .send({ code: plaintext, email: 'in-lane@example.org', password: GOOD_PASSWORD });
    const servedAhead = settled - aheadAtStart;
    await Promise.all(flood);

    console.log(
      `[starve-control] sameLaneStatus=${String(inLane.status)} ` +
        `floodServedBeforeIt=${String(servedAhead)}`,
    );
    // Either they queued behind their own lane's backlog, or the gate shed them for being the
    // largest contributor to it. Both are the rule working; being served in two turns is not.
    if (inLane.status === 201) expect(servedAhead).toBeGreaterThan(FLOOD / 4);
    else expect(inLane.status).toBe(429);
  }, 180_000);

  /**
   * THE SECOND HALF OF THE FINDING, and the one that had nothing to do with latency: it was
   * INVISIBLE. MEASURED before the fix, `SHAPE=tunnel`: 2,244 failed sign-ins in twenty-one
   * seconds, `audit_log` empty. The operator saw a slow deployment and had nothing to look at.
   */
  it('leaves the operator one row per window, not none and not one per request', async () => {
    const app = build();
    const bursts = 60;

    await Promise.all(
      Array.from({ length: bursts }, (_unused, i) =>
        request(app)
          .post('/api/auth/login')
          .set('X-Forwarded-For', ATTACKER)
          .send({ email: `noticed-${String(i)}@example.net`, password: 'not-the-password' }),
      ),
    );

    const rows = db
      .prepare("SELECT entity_id, detail FROM audit_log WHERE action = 'auth.failed_sign_ins'")
      .all() as Array<{ entity_id: string; detail: string }>;
    console.log(`[notice] failedSignIns=${String(bursts)} rows=${String(rows.length)}`);

    // Exactly one: the fiftieth failure writes it and the ten after it write nothing, so a caller
    // cannot bury the rest of the trail under their own noise.
    expect(rows).toHaveLength(1);
    // Coarsened to a network, never a host, and never an address that was tried.
    expect(rows[0]?.entity_id).toContain('/');
    expect(JSON.stringify(rows)).not.toContain('noticed-0@example.net');
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toMatchObject({ failures: 50 });
  }, 180_000);
});

describe('whether a success refills the guess budget', () => {
  /**
   * MEASURED before the fix: `reset()` on a successful enrolment let the holder of a multi-use code
   * alternate — nine wrong codes, one real redemption, repeat. Five rounds fitted 45 wrong-code
   * guesses inside one fifteen-minute window against a ceiling of ten.
   */
  it('counts the guesses across the successes, so ten is ten', async () => {
    const { plaintext } = issue({ maxUses: 5 });
    const app = build();

    async function guess(n: number): Promise<number> {
      const res = await request(app)
        .post('/api/auth/enroll')
        .send({
          code: WRONG_CODE,
          email: `guess-${String(n)}@example.org`,
          password: GOOD_PASSWORD,
        });
      return res.status;
    }

    let wrongAccepted = 0;
    let n = 0;
    for (let round = 0; round < 5; round += 1) {
      for (let i = 0; i < 9; i += 1) {
        n += 1;
        if ((await guess(n)) === 401) wrongAccepted += 1;
      }
      await request(app)
        .post('/api/auth/enroll')
        .send({
          code: plaintext,
          email: `real-${String(round)}@example.org`,
          password: GOOD_PASSWORD,
        });
    }
    console.log(`[alternate] wrong guesses answered in one window=${String(wrongAccepted)}`);

    expect(wrongAccepted).toBe(10);
  }, 180_000);
});
