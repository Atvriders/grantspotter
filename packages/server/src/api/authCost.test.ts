import type Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { REGISTRATION_MAX_PER_CONNECTION } from './auth.js';
import { createBootstrapState } from '../auth/bootstrap.js';
import { hashPassword } from '../auth/password.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { loadConfig } from '../config.js';
import { createTestDb, type TestDb } from '../../test/helpers/tempDb.js';

/**
 * WHAT AN ANONYMOUS CALLER CAN MAKE THIS SERVER SPEND, counted rather than argued.
 *
 * `enroll.test.ts` asserts what `POST /api/auth/enroll` ANSWERS. This file asserts what it COSTS —
 * and what `POST /api/auth/login` costs, because the two unauthenticated routes that hash a
 * password had the same defect and were fixed in the same change. The findings pinned here were all
 * invisible to a suite that sent one request at a time and read only the status code: the work is
 * done between the check and the record, so a test that never overlaps two requests cannot see it,
 * and the ledger it should show up in is the one the defect skips.
 *
 * THIS FILE MATTERS MORE AFTER 2026-08-11 THAN BEFORE IT. Until then an anonymous caller could not
 * make this route run argon2id at all without a code an administrator had issued; registration is
 * open now, so a POST from anybody buys 19 MiB and two passes of somebody else's CPU. Every number
 * below is what bounds that.
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

let seedHash: Promise<string> | undefined;
function seededPasswordHash(): Promise<string> {
  seedHash ??= hashPassword('a-seeded-password-not-a-real-secret');
  return seedHash;
}

let harness: TestDb;
let db: Database.Database;

beforeEach(async () => {
  harness = createTestDb();
  db = harness.db;
  // Registration is closed until an administrator exists, so every cost measured here is measured
  // in the state a live deployment is in.
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

function memberCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member'").get() as { n: number }
  ).n;
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
   * paid for. MEASURED then: 240 concurrent requests against a budget of ten produced 240 argon2id
   * hashes and 10,181 ms of CPU.
   *
   * THE BURST IS A DIFFERENT BURST NOW and the shape of the answer is the same. It used to be 240
   * wrong codes, which cost a SHA-256 each and were refused before the hash by a credential check;
   * with no credential to check, all 240 of these are requests this route would happily serve, and
   * the only thing between them and 240 hashes is the ladder — read and charged in one synchronous
   * stretch, which is what makes the number below the ceiling rather than the burst.
   */
  const BURST = 240;

  it('performs at most sixty argon2id hashes for a 240-request registration burst', async () => {
    const app = build();

    const startCpu = cpuMs();
    const startWall = Date.now();
    const responses = await Promise.all(
      Array.from({ length: BURST }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({ email: `burst-${String(i)}@example.org`, password: GOOD_PASSWORD }),
      ),
    );
    const spentCpu = cpuMs() - startCpu;
    const wall = Date.now() - startWall;

    const refused = responses.filter((r) => r.status === 429).length;
    const created = responses.filter((r) => r.status === 201).length;
    console.log(
      `[burst] requests=${String(BURST)} hashes=${String(argon2Calls.hash)} ` +
        `cpu=${spentCpu.toFixed(0)}ms wall=${String(wall)}ms 201=${String(created)} ` +
        `429=${String(refused)}`,
    );

    // THE CEILING THE COMMENT IN auth.ts CLAIMS. Sixty registrations per connection per window
    // means sixty hashes, however many callers arrive at once.
    expect(argon2Calls.hash).toBeLessThanOrEqual(REGISTRATION_MAX_PER_CONNECTION);
    // Everybody got an answer, and exactly the accounts the ceiling allows were created.
    expect(created + refused).toBe(BURST);
    expect(created).toBe(REGISTRATION_MAX_PER_CONNECTION);
    expect(memberCount()).toBe(REGISTRATION_MAX_PER_CONNECTION);
  }, 180_000);
});

/**
 * THE OTHER HALF OF EVERY RATE LIMIT: what it does to the people who are not attacking.
 *
 * A gate that bounds the work by refusing everybody bounds nothing worth having. These two pin what
 * the budget costs the people it is not aimed at, and they are the reason the claim is a ceiling of
 * sixty rather than the single lane the callsign lookup uses: there the thing being rationed is
 * somebody else's server and one at a time is the promise, here it is this process's own CPU and a
 * club intake pressing submit together must not be serialised into a queue of refusals.
 */
describe('what the gate does not do to legitimate traffic', () => {
  it('lets ten people sign up at the same instant, all of them successfully', async () => {
    const app = build();

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({ email: `together-${String(i)}@example.org`, password: GOOD_PASSWORD }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(10);
    expect(memberCount()).toBe(10);
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

/**
 * WHAT A STRANGER CAN FIND OUT ABOUT OTHER PEOPLE, and the two assertions in this file that are
 * DELIBERATELY GONE because the design they described is gone.
 *
 * WHAT USED TO BE HERE. Two tests pinned the disclosure budget: five addresses named per code per
 * window, and — the more interesting one — a MEASURED RATIO showing that past that budget, asking
 * about a member cost the same wall-clock as registering a stranger, because both paid one
 * argon2id. That equality was the point: if the two answers cannot be made identical, at least make
 * them cost the same, so a caller cannot sort a list faster than the route can hash.
 *
 * NEITHER SURVIVES OPEN REGISTRATION, and neither is quietly dropped. The budget was keyed on the
 * digest of the code the question was asked with; there is no code, and every remaining candidate
 * key is one the caller writes. And the cost equality was in service of hiding a difference the
 * status line now states outright — 409 names the address, 201 creates the account — so paying an
 * argon2id to make a hit as slow as a miss would buy nothing at all and would spend a legitimate
 * returning member's time to buy it. A hit is now the CHEAPEST answer this route gives (no hash),
 * and that is a deliberate reversal rather than a regression that slipped through.
 *
 * AND FOR ONE DAY THE ANSWER TO "WHAT BOUNDS IT INSTEAD" WAS "THE LADDER" — a probe was a
 * registration attempt and was charged like one, so a caller could classify exactly as many
 * addresses as they could have created accounts. These two tests asserted that ceiling. THEY NOW
 * ASSERT ITS ABSENCE, and the reason is measured rather than argued: 120 probes at one existing
 * address closed sign-up for a whole tunnel in 147 ms of CPU-cheap work, and the honest student who
 * arrived next was refused with a sentence about accounts that did not exist. The charge did not
 * even buy secrecy — 409 against 201 is the same oracle, in the status line, whatever the sentence
 * says — so what it bought was the denial and nothing else.
 *
 * WHAT THESE TESTS MEASURE NOW is the trade that replaced it: the question is free and unlimited,
 * and it costs everybody else nothing. What stays bounded is the SQUATTING, because a question
 * about an address that is free creates a real account and is charged as one.
 */
describe('what a stranger can find out about other people', () => {
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

  /** A 409 that NAMES the address is the answer somebody learns something from. */
  function namesAddress(res: request.Response, email: string): boolean {
    return res.status === 409 && String(res.body?.error?.message ?? '').includes(email);
  }

  it('answers all two hundred of them, and takes nothing from anybody else to do it', async () => {
    const app = build();
    await seedKnownMembers();

    argon2Calls.hash = 0;
    const named: number[] = [];
    const refused: number[] = [];
    const other: number[] = [];
    for (let i = 0; i < PROBES; i += 1) {
      const email = `known-${String(i)}@example.org`;
      const res = await request(app)
        .post('/api/auth/enroll')
        .send({ email, password: GOOD_PASSWORD });
      if (namesAddress(res, email)) named.push(i);
      else if (res.status === 429) refused.push(i);
      else other.push(i);
    }

    console.log(
      `[probe] probes=${String(PROBES)} named=${String(named.length)} ` +
        `429=${String(refused.length)} other=${String(other.length)} ` +
        `hashes=${String(argon2Calls.hash)}`,
    );

    // ALL OF THEM. This assertion is the inverse of the one it replaces, deliberately: the oracle
    // is open, it was open before under a ceiling that hid nothing, and the ceiling's real effect
    // was to let these 200 questions shut sign-up for every student in the deployment.
    expect(named).toHaveLength(PROBES);
    expect(refused).toEqual([]);
    expect(other).toEqual([]);
    // NOT ONE argon2id FOR THE WHOLE RUN. Every one of these was a hit, and a hit is answered
    // before the hash. The number is here so that a change which starts hashing on this path — or
    // one which stops hashing on the miss path — shows up as a change in cost rather than silently.
    expect(argon2Calls.hash).toBe(0);
    // THE PROPERTY THAT MATTERS, and the one the old ceiling destroyed: 200 questions cost the
    // people who are not asking them exactly nothing. A whole club intake can still sign up.
    const intake = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .set('X-Forwarded-For', '198.51.100.4')
          .send({ email: `after-probes-${String(i)}@example.org`, password: GOOD_PASSWORD }),
      ),
    );
    expect(intake.filter((r) => r.status === 201)).toHaveLength(10);
    // And the operator has exactly one row about it, written by the twentieth answer. It is now the
    // ONLY thing standing between an attacker and a club roster, which is why it is asserted here
    // as well as in `enroll.test.ts`.
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.addresses_probed'")
        .get() as { n: number },
    ).toEqual({ n: 1 });
  }, 300_000);

  /**
   * THE SAME PROBES, ALL AT ONCE, and the number is the same one — which is the point of running it
   * twice.
   *
   * WHAT THIS TEST IS FOR HAS SURVIVED THE CHANGE IN WHAT IT EXPECTS. Concurrency must make no
   * difference to what this route does, because every defect this file exists for is a defect that
   * only appears when two requests overlap. It used to check that 200 simultaneous probes could not
   * walk past a ladder none of them had paid into yet; it now checks that 200 simultaneous probes
   * still leave the ladder alone, which is the same question asked of the opposite answer. A
   * regression that starts charging probes again fails the sequential test above at 60 and this one
   * at 60 as well, whichever order the requests happen to interleave in.
   */
  it('answers all of them when the two hundred probes arrive at once, and still charges nothing', async () => {
    const app = build();
    await seedKnownMembers();

    const responses = await Promise.all(
      Array.from({ length: PROBES }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({ email: `known-${String(i)}@example.org`, password: GOOD_PASSWORD }),
      ),
    );

    const named = responses.filter((r, i) => namesAddress(r, `known-${String(i)}@example.org`));
    const refused = responses.filter((r) => r.status === 429);
    console.log(
      `[probe-burst] probes=${String(PROBES)} named=${String(named.length)} ` +
        `429=${String(refused.length)}`,
    );
    expect(named).toHaveLength(PROBES);
    expect(refused).toHaveLength(0);

    const student = await request(app)
      .post('/api/auth/enroll')
      .send({ email: 'after-the-burst@example.org', password: GOOD_PASSWORD });
    expect(student.status).toBe(201);
  }, 300_000);
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

  it('never exceeds four concurrent hashes, and still registers all forty', async () => {
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
            .send({ email: `crowd-${String(i)}@example.org`, password: GOOD_PASSWORD }),
        ),
      );
      console.log(`[gate] burst=${String(BURST)} peakConcurrentHashes=${String(peak)}`);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(4);
      expect(responses.filter((r) => r.status === 201)).toHaveLength(BURST);
      expect(memberCount()).toBe(BURST);
    } finally {
      argon2Hooks.onHash = previous;
    }
  }, 180_000);
});

/**
 * WHAT ONE STRANGER CAN DO TO EVERYBODY ELSE, which is a different question from what they can do
 * to a route and is the one the tests above could not see.
 *
 * THE FINDING, 2026-08-09. `POST /api/auth/login` runs a real argon2id verify per request on
 * purpose — against a dummy hash when no such account exists, so that response timing does not say
 * which addresses are accounts — and its budget is keyed `(peer, email)`. A caller who never uses
 * the same address twice therefore never meets it, and every one of those requests took a place in
 * a shared, unbounded, first-come-first-served queue that the sign-up route waits in too.
 *
 * MEASURED against a real listening server in its own process, 512 connections, rotating email,
 * one reverse proxy in front (the documented deployment, so every request shares a TCP peer and
 * `req.ip` is what the proxy wrote):
 *
 *                        before (a4a863b)     after
 *   student's sign-up    5,036 ms (91.6x)     330 ms (5.5x)
 *   attacker's rate      6,462 req/min        67,710 req/min, 15,942 of them refused
 *   audit rows about it  0                    2
 *
 * and before the fix the student's latency rose in step with the attacker's connection count —
 * 24 connections 243 ms, 96 → 967 ms, 256 → 2,507 ms, 512 → 4,881 ms — which is the property that
 * makes it a denial of service rather than a slow afternoon: the caller chooses everyone's wait.
 *
 * THE DIRECTION IS NOW BOTH WAYS, which is what the last test in this block is for. Open
 * registration means an anonymous caller can aim argon2id at this process without a credential, so
 * "a sign-up flood must not starve sign-in" is a claim that has to be measured and not inherited.
 *
 * THESE TESTS COUNT PLACES IN THE QUEUE RATHER THAN MILLISECONDS. The wall-clock figures above
 * belong to the machine that produced them; what belongs to the code is that the person who is not
 * in the flood is served after a couple of turns instead of after the whole of it.
 *
 * The lanes are `X-Forwarded-For` because supertest is loopback and every request shares a TCP
 * peer, which is exactly the documented deployment: one tunnel in front, `trust proxy` 1, so
 * `req.ip` is the address the tunnel wrote and is what tells two of its users apart.
 */
describe('what a flood does to somebody who is not in it', () => {
  const FLOOD = 300;
  const ATTACKER = '203.0.113.9';
  const STUDENT = '198.51.100.4';

  /**
   * WHAT IS COUNTED HERE IS THE FLOOD'S COMPLETED VERIFIES, AND IT USED TO BE ITS RESPONSES.
   *
   * That is a correction to the MEASUREMENT rather than a relaxation of the claim, and the sibling
   * test three blocks down was already written the corrected way for the same reason: "counting
   * responses says '253 went first' about a member who waited 144 ms — the number would be
   * measuring the ladder working and calling it starvation."
   *
   * It became wrong here on 2026-08-12, when `MAX_QUEUED_HASHES` moved from 256 to 192. A
   * 300-request flood now overflows the queue by about a hundred, and an overflowing request is
   * REFUSED IN MICROSECONDS — it settles before the student has finished being parsed. Counting
   * those as "served ahead of the student" produced 110 against a threshold of 75 and would have
   * failed a change that made the student's position better rather than worse. A 401 is the only
   * status on this route that means an argon2id verify actually ran, so it is the only status that
   * means somebody took a turn the student was waiting for.
   */
  it('serves the student in a couple of turns instead of behind three hundred strangers', async () => {
    const app = build();

    let verified = 0;
    const flood = Array.from({ length: FLOOD }, (_unused, i) =>
      request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ATTACKER)
        // A FRESH ADDRESS EVERY TIME, which is what makes the `(peer, email)` budget blind to it.
        .send({ email: `flood-${String(i)}@example.net`, password: 'not-the-password' })
        .then((res) => {
          if (res.status === 401) verified += 1;
          return res.status;
        }),
    );

    // Let the flood reach the gate before the student presses submit.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const aheadAtStart = verified;
    const student = await request(app)
      .post('/api/auth/enroll')
      .set('X-Forwarded-For', STUDENT)
      .send({ email: 'student@example.org', password: GOOD_PASSWORD });
    const servedAhead = verified - aheadAtStart;

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
   * THE CONTROL THAT MAKES THE ONE ABOVE MEAN SOMETHING. If a caller in the flood's own lane were
   * also served early, the number above would be measuring luck rather than the round.
   *
   * THE REQUEST IT SENDS CHANGED ON 2026-08-12 AND SO DID ITS CLAIM, because a lane is now
   * (peer, route, origin) and the old version's "same lane" was no longer one. It POSTed
   * `/auth/enroll` from the flood's `X-Forwarded-For` and required that request to be slow or shed;
   * with the route in the round, a sign-up from that address is in the SIGN-UP round and is served
   * in a couple of turns. That is the reservation working exactly as intended rather than a leak —
   * the whole point of the level is that sign-up's share belongs to sign-ups whoever sends them,
   * and it must, because behind one campus NAT the flooder and a student share an origin. The
   * attacker gains nothing by it: their sign-up is served exactly as fast as it would have been if
   * they had never sent the flood, so flooding buys no priority.
   *
   * What the control was really protecting is the caller level, and this asserts it where it still
   * lives: a second SIGN-IN from the flood's own address, which is the same lane in every one of
   * the three keys. Both assertions are in one test because either alone can be satisfied by the
   * wrong mechanism.
   */
  it('gives the flood no shortcut in its own lane, and its other route no more than a turn', async () => {
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
    // Same address AND same route as the flood: this request is the flood, as far as every key the
    // gate has can tell.
    const inLane = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', ATTACKER)
      .send({ email: 'in-lane@example.net', password: 'not-the-password' });
    const servedAhead = settled - aheadAtStart;

    // Same address, the other route.
    const otherRoute = await request(app)
      .post('/api/auth/enroll')
      .set('X-Forwarded-For', ATTACKER)
      .send({ email: 'in-lane@example.org', password: GOOD_PASSWORD });
    await Promise.all(flood);

    console.log(
      `[starve-control] sameLaneStatus=${String(inLane.status)} ` +
        `floodServedBeforeIt=${String(servedAhead)} otherRouteStatus=${String(otherRoute.status)}`,
    );
    // Either they queued behind their own lane's backlog, or the gate shed them for being the
    // largest contributor to it. Both are the rule working; being served in two turns is not.
    if (inLane.status === 401) expect(servedAhead).toBeGreaterThan(FLOOD / 4);
    else expect(inLane.status).toBe(429);
    // And the other route is served, which is the level added for the students and applies to
    // everybody who uses it — including the person flooding the route next door.
    expect(otherRoute.status).toBe(201);
  }, 180_000);

  /**
   * THE DIRECTION THE 2026-08-11 CHANGE OPENED, and the one the brief for it asked to be measured:
   * a burst of REGISTRATIONS must not delay a member signing in.
   *
   * That exact starvation was a confirmed defect two days ago in the other direction, and the
   * reason it cannot recur in this one is not new code — it is that the gate's round is between
   * callers rather than between routes. What IS new is that the flood arrives at all: before today
   * a caller with no credential could not make this route hash anything.
   *
   * TWO MECHANISMS ARE VISIBLE IN THE NUMBERS THIS PRINTS, and they compose. The ladder refuses
   * most of the flood before it reaches the gate at all (60 of 300 from one address are served, the
   * other 240 are refused without hashing), and the gate then takes turns between what is left and
   * the member. Either alone would be enough for this assertion; the test logs both so that a
   * regression in one is not hidden by the other.
   *
   * WHAT IS COUNTED IS THE HASHES SERVED AHEAD, NOT THE RESPONSES. The sibling tests above count
   * settled responses, which is the right measure when every request in the flood does a real
   * argon2id. It is the wrong measure here: 240 of these 300 are refused by the ladder in
   * microseconds, so counting responses says "253 went first" about a member who waited 144 ms —
   * the number would be measuring the ladder working and calling it starvation. The queue position
   * that matters is how many of the flood's HASHES were served first.
   */
  it('signs a member in while three hundred registrations are in flight', async () => {
    const app = build();
    createUserRepoRow(db, 'quiet-member@example.org', await seededPasswordHash());

    let settled = 0;
    let hashed = 0;
    const flood = Array.from({ length: FLOOD }, (_unused, i) =>
      request(app)
        .post('/api/auth/enroll')
        .set('X-Forwarded-For', ATTACKER)
        .send({ email: `signup-flood-${String(i)}@example.net`, password: GOOD_PASSWORD })
        .then((res) => {
          settled += 1;
          if (res.status === 201) hashed += 1;
          return res.status;
        }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const hashedAtStart = hashed;
    const settledAtStart = settled;
    const startedAt = performance.now();
    const member = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', STUDENT)
      .send({ email: 'quiet-member@example.org', password: 'a-seeded-password-not-a-real-secret' });
    const waited = performance.now() - startedAt;
    const servedAhead = hashed - hashedAtStart;

    const statuses = await Promise.all(flood);
    const created = statuses.filter((s) => s === 201).length;
    const refused = statuses.filter((s) => s === 429).length;
    console.log(
      `[signup-flood] flood=${String(FLOOD)} created=${String(created)} refused=${String(refused)} ` +
        `alreadySettledWhenMemberPressed=${String(settledAtStart)} ` +
        `memberStatus=${String(member.status)} memberWaited=${waited.toFixed(0)}ms ` +
        `floodHashesBeforeMember=${String(servedAhead)}`,
    );

    // The member signs in, and is served after a handful of the flood's hashes rather than behind
    // all of them. A quarter of what the ladder let through is the same fraction the two tests
    // above use, and it is generous: the round-robin serves the member in one or two turns.
    expect(member.status).toBe(200);
    expect(servedAhead).toBeLessThan(REGISTRATION_MAX_PER_CONNECTION / 4);
    // The ladder is the first of the two mechanisms: most of the flood never reached the hash.
    expect(created).toBe(REGISTRATION_MAX_PER_CONNECTION);
    expect(created + refused).toBe(FLOOD);
  }, 180_000);

  /**
   * THE FINDING OF 2026-08-12, WHICH IS THE SAME STARVATION SEEN FROM THE OTHER SIDE OF THE WALLET.
   *
   * MEASURED against the built server, a 1,642 req/s sign-in flood across rotated origins while 130
   * students registered from 130 distinct addresses: 37 accounts created, 83 students SHED BY THE
   * GATE, 10 refused by the ladder. 37 + 83 = 120 = the network rung to the last unit — every
   * student the gate threw away had already charged the budget the remaining students needed, so a
   * flood on a route with no ladder of its own converted the whole registration budget into
   * refusals, and left it converted for fifteen minutes after the flood stopped.
   *
   * TWO FIXES MEET HERE AND THE TEST IS DELIBERATELY BLIND TO WHICH ONE CARRIED IT, because both
   * must hold: the gate's round now takes turns between the two ROUTES, so a sign-in flood cannot
   * take sign-up's share of the queue; and a registration the gate sheds releases its budget slots
   * instead of recording them, so a shed can no longer be spent on anybody's behalf.
   *
   * THE FLOOD IS ONE `X-Forwarded-For` because that is the owner's deployment: behind a Cloudflare
   * Tunnel `req.ip` is what the tunnel wrote and a caller cannot rotate it. The shape where they
   * can is the residual `hashGate` documents, and it is a configuration answer rather than a code
   * one.
   */
  it('lets a class register while a sign-in flood is filling the gate, and leaves their budget alone', async () => {
    const app = build();
    const STUDENTS = 30;

    let floodSettled = 0;
    const flood = Array.from({ length: FLOOD }, (_unused, i) =>
      request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ATTACKER)
        .send({ email: `gate-flood-${String(i)}@example.net`, password: 'not-the-password' })
        .then((res) => {
          floodSettled += 1;
          return res.status;
        }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const students = await Promise.all(
      Array.from({ length: STUDENTS }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          // One address each, as thirty students behind one tunnel would arrive.
          .set('X-Forwarded-For', `198.51.100.${String(i + 1)}`)
          .send({ email: `class-${String(i)}@example.org`, password: GOOD_PASSWORD }),
      ),
    );
    const statuses = await Promise.all(flood);

    const created = students.filter((r) => r.status === 201).length;
    const shed = students.filter((r) => r.status === 429).length;
    console.log(
      `[cross-route] flood=${String(FLOOD)} floodShed=${String(statuses.filter((s) => s === 429).length)} ` +
        `studentsCreated=${String(created)} studentsRefused=${String(shed)} ` +
        `floodSettledDuring=${String(floodSettled)}`,
    );

    // EVERY STUDENT. Not most of them, and not "more than before": the flood is one caller on one
    // route and there is nothing about thirty registrations that this server cannot serve.
    expect(created).toBe(STUDENTS);
    expect(memberCount()).toBe(STUDENTS);

    // AND THE BUDGET IS WHERE THE ACCOUNTS ARE. Whatever the gate did to the flood, the deployment
    // rung has been charged thirty times and not once more, so the students who come afterwards —
    // a second club, the following lecture — are served.
    const later = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .set('X-Forwarded-For', '203.0.113.200')
          .send({ email: `later-${String(i)}@example.org`, password: GOOD_PASSWORD }),
      ),
    );
    expect(later.filter((r) => r.status === 201)).toHaveLength(10);
  }, 300_000);

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

/** One member row, inserted directly: the sign-in flood tests need somebody to sign in AS. */
function createUserRepoRow(handle: Database.Database, email: string, passwordHash: string): void {
  handle
    .prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
       VALUES (?, ?, ?, ?, 'member', ?, ?)`,
    )
    .run(`u-${email}`, email, email, passwordHash, `ics-${email}`, '2026-09-01T00:00:00.000Z');
}
