import { Agent as httpAgent } from 'node:http';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import {
  REGISTRATION_MAX_DEPLOYMENT,
  REGISTRATION_MAX_PER_CONNECTION,
  REGISTRATION_MAX_PER_NETWORK,
  REGISTRATION_WINDOW_MS,
} from './auth.js';
import { createBootstrapState } from '../auth/bootstrap.js';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../auth/password.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { loadConfig } from '../config.js';
import { createSessionRepo } from '../db/repositories/sessions.js';
import { createUserRepo } from '../db/repositories/users.js';
import { createTestDb, type TestDb } from '../../test/helpers/tempDb.js';

/**
 * `POST /api/auth/enroll` — REGISTRATION, THE WAY IN THAT NOBODY HAS TO BE PRESENT FOR.
 *
 * THIS FILE USED TO BE ABOUT ENROLLMENT CODES and most of it has gone with them. It held 1,332
 * lines: one account per available use however many people pressed at once, one answer for every
 * wrong code, three ceilings on guessing, a disclosure budget per code, and a control test that
 * reproduced a six-accounts-from-a-one-use-code race on purpose. None of those properties exist to
 * hold any more — there is no code, no use count, and nothing to guess — so the tests are deleted
 * rather than adapted, and what replaces them tests the properties open registration actually has.
 *
 * THE FILE KEEPS ITS NAME because the route keeps its path; `api/auth.ts` says why the path did not
 * change with the meaning. A test file that searches cannot find is a defect this project has paid
 * for before.
 *
 * `test/api.auth.test.ts` covers login, /me, logout and the first-run token; `api/auth.test.ts`
 * covers the first-run password floor; `api/authCost.test.ts` covers what this route COSTS, which
 * is a different question and now the more important one.
 *
 * IT DRIVES THE WHOLE APP (`createApp`) rather than the router in isolation, because half of what
 * is being asserted is about the composition: the JSON body limit, the error envelope, the session
 * cookie, and the ordering of the middleware that produces them.
 */

const config = loadConfig({
  SESSION_SECRET: 'z'.repeat(32),
  NODE_ENV: 'test',
  CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter',
});

const GOOD_PASSWORD = 'a-long-enough-password';
const ADMIN_ID = 'admin-1';

/** One argon2id hash, reused for every seeded row: this file has ~40 hashes to spare and no more. */
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
  // A real administrator row, because that is the state a live deployment is in and because
  // registration is CLOSED until one exists — see the last describe in this file, which is the
  // only one that deliberately runs without it.
  db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
     VALUES (?, 'admin@example.org', 'admin@example.org', ?, 'admin', 'ics-admin', ?)`,
  ).run(ADMIN_ID, await seededPasswordHash(), '2026-09-01T00:00:00.000Z');
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

describe('signing up', () => {
  it('creates a member from an email and a password, and signs them in', async () => {
    const res = await request(build()).post('/api/auth/enroll').send({
      email: 'New.Student@Example.org',
      password: GOOD_PASSWORD,
      displayName: 'New Student',
    });

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      email: 'New.Student@Example.org',
      displayName: 'New Student',
      role: 'member',
      createdAt: expect.any(String),
    });
    // Signed in on the way out: the point of signing up is to arrive inside the product.
    const setCookie = res.headers['set-cookie'];
    expect((Array.isArray(setCookie) ? setCookie : [setCookie]).join(';')).toContain(
      `${SESSION_COOKIE}=`,
    );

    // The password they chose is the credential that was stored.
    const stored = createUserRepo(db).findByEmail('new.student@example.org');
    expect(stored).toBeDefined();
    expect(stored?.role).toBe('member');
    await expect(verifyPassword(stored!.passwordHash, GOOD_PASSWORD)).resolves.toBe(true);

    // …and an administrator can find out where this account came from. `user.register` and not
    // `user.enroll`: the old action named the enrollment code an account came from, and rows
    // carrying it are history now rather than a thing this route writes.
    const audit = db
      .prepare('SELECT actor_user_id, action, entity_type, detail FROM audit_log')
      .all() as Array<Record<string, string>>;
    expect(audit).toEqual([
      {
        actor_user_id: stored!.id,
        action: 'user.register',
        entity_type: 'user',
        // The coarse source network and nothing else — never the address, which is already in the
        // users table and does not need repeating into a record kept for longer and read by more
        // people. Loopback in this harness, which coarsens to a /24 like any other v4 address.
        detail: JSON.stringify({ origin: '127.0.0.0/24' }),
      },
    ]);
  }, 30_000);

  /**
   * NOBODY HAS TO BE ASKED. This is the whole of the owner's change, expressed as the shortest
   * possible test: a body with no credential in it at all, on a deployment that has issued nothing
   * to anybody, makes an account.
   */
  it('needs no code, no invitation and nobody else present', async () => {
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ email: 'stranger@example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(201);
    expect(memberCount()).toBe(1);
  }, 30_000);

  /**
   * A BROWSER TAB LEFT OPEN ACROSS THE UPGRADE. It is holding the old sign-up form, which has a
   * code field in it, and it will POST that field. zod strips a key an object schema does not
   * declare, so the request succeeds instead of being answered with a validation error the old
   * screen has no wording for.
   */
  it('ignores a code sent by a browser that has not been reloaded yet', async () => {
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: 'W1MX-SPRING-2027', email: 'stale-tab@example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(201);
    expect(memberCount()).toBe(1);
  }, 30_000);

  it('never emits a hash, a token or anything else the account is held together with', async () => {
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ email: 'a@example.org', password: GOOD_PASSWORD });

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/argon2|passwordHash|icsToken/i);
    expect(body).not.toContain(createUserRepo(db).findByEmail('a@example.org')!.icsToken);
  }, 30_000);
});

describe('registration never grants admin', () => {
  it('ignores a role the caller asked for, and makes a member', async () => {
    const res = await request(build()).post('/api/auth/enroll').send({
      email: 'aspiring@example.org',
      password: GOOD_PASSWORD,
      role: 'admin',
      isAdmin: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('member');
    expect(createUserRepo(db).findByEmail('aspiring@example.org')?.role).toBe('member');
    // The only admin in this deployment is still the one that was seeded.
    expect(db.prepare("SELECT id FROM users WHERE role = 'admin'").all()).toEqual([
      { id: ADMIN_ID },
    ]);
  }, 30_000);
});

describe('a body that costs the caller nothing', () => {
  it('refuses a password below the floor and says what the floor is', async () => {
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ email: 'a@example.org', password: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    // The number is in the sentence: "the request body is invalid" makes them guess.
    expect(res.body.error.message).toContain(String(MIN_PASSWORD_LENGTH));
    expect(memberCount()).toBe(0);

    const retry = await request(build())
      .post('/api/auth/enroll')
      .send({ email: 'a@example.org', password: GOOD_PASSWORD });
    expect(retry.status).toBe(201);
  }, 30_000);

  it('refuses something that could never be an email address', async () => {
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ email: 'not-an-address', password: GOOD_PASSWORD });

    expect(res.status).toBe(422);
    expect(memberCount()).toBe(0);
  }, 30_000);

  /**
   * THE FLOOR IS CHECKED BEFORE THE ADDRESS, and this is the test that keeps it there.
   *
   * MEASURED 2026-08-05 with the order reversed: a one-character password answered 409 "<address>
   * already has an account" for a member and 422 for everybody else, which classified 2,000
   * addresses in 2,983 ms with nothing created and nothing charged. The cheap invalid input must
   * not be able to separate two answers the design has decided to separate expensively.
   */
  it('answers a too-short password identically for a member and a stranger', async () => {
    createUserRepo(db).create({
      email: 'member@example.org',
      passwordHash: await seededPasswordHash(),
      role: 'member',
    });
    const app = build();

    const known = await request(app)
      .post('/api/auth/enroll')
      .send({ email: 'member@example.org', password: 'x' });
    const stranger = await request(app)
      .post('/api/auth/enroll')
      .send({ email: 'nobody@example.org', password: 'x' });

    expect(known.status).toBe(422);
    expect({ status: known.status, error: known.body.error }).toEqual({
      status: stranger.status,
      error: stranger.body.error,
    });
  }, 30_000);
});

/**
 * THE ACCOUNT-EXISTENCE ORACLE, WHICH IS NOW OPEN AND IS SAID TO BE OPEN.
 *
 * WHAT THE PREVIOUS DESIGN DID AND WHY IT CANNOT BE KEPT. `ENROLLMENT_CONFLICT_MAX` rationed the
 * specific answer per CODE — five namings per code per window, then the same question cost an
 * argon2id and got a sentence naming nobody. That was affordable because the key was a credential
 * an administrator had issued: minting a fresh bucket meant obtaining a second real code. With
 * registration open there is no such key. Every candidate is either chosen by the caller
 * (`X-Forwarded-For`, the address itself) or shared by everybody behind the tunnel, and a budget
 * whose key the caller writes is not a budget.
 *
 * FOR ONE DAY THIS BLOCK SAID "THE ANSWER IS NO LONGER RATIONED AND THE ROUTE IS" — a probe was a
 * registration attempt, charged to all three rungs, so classifying addresses stopped at the same
 * ceiling as creating accounts. That is deleted rather than adapted, because it was measured doing
 * the opposite of its purpose: 120 questions about one existing address closed sign-up for a whole
 * tunnel in 147 ms, having created nothing, and the next honest student was refused. It also never
 * hid anything — 409 for an address that exists and 201 for one that does not is the same oracle in
 * the status line, whatever the sentence says.
 *
 * SO NOTHING RATIONS THE QUESTION, and the test below that used to assert a ceiling on it now
 * asserts that there is none, and that asking costs everybody else nothing. What is still bounded
 * is the part that lasts: a question about a FREE address creates an account, and that is charged.
 *
 * AND THE ANSWER STAYS THE USEFUL ONE, which is the part worth defending: the person who meets it
 * most often is not an attacker, it is somebody who signed up last term and has forgotten. Making
 * a hit indistinguishable from a miss would mean refusing to create the account for the miss, or
 * claiming to have created one that does not exist — the second of which sends that person to a
 * sign-in screen with a password nobody stored.
 */
describe('an address that already has an account', () => {
  it('says so, names it, and sends the person to the sign-in screen', async () => {
    createUserRepo(db).create({
      email: 'taken@example.org',
      passwordHash: await seededPasswordHash(),
      role: 'member',
    });

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ email: 'Taken@Example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.message).toContain('Taken@Example.org');
    expect(res.body.error.message).toMatch(/sign in/i);
    // Nothing was created, and the account that exists is untouched.
    expect(memberCount()).toBe(1);
  }, 30_000);

  /**
   * SOMEBODY WORKING THROUGH A LIST LEAVES A MARK, and one mark rather than one per question.
   *
   * The threshold refuses nothing — the ladder is what refuses — so being wrong about the number
   * costs one audit row per source network per window and nothing else.
   */
  it('writes the operator one row when a source network is told about twenty of them', async () => {
    const stmt = db.prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
       VALUES (?, ?, ?, ?, 'member', ?, ?)`,
    );
    const hash = await seededPasswordHash();
    for (let i = 0; i < 25; i += 1) {
      const email = `known-${String(i)}@example.org`;
      stmt.run(`u-${String(i)}`, email, email, hash, `ics-${String(i)}`, '2026-09-01T00:00:00.000Z');
    }
    const app = build();

    for (let i = 0; i < 25; i += 1) {
      const res = await request(app)
        .post('/api/auth/enroll')
        .send({ email: `known-${String(i)}@example.org`, password: GOOD_PASSWORD });
      expect(res.status).toBe(409);
    }

    const rows = db
      .prepare("SELECT entity_id, detail FROM audit_log WHERE action = 'auth.addresses_probed'")
      .all() as Array<{ entity_id: string; detail: string }>;
    // Exactly one: the twentieth answer writes it and the five after it write nothing, so a caller
    // cannot bury the rest of the trail under their own noise.
    expect(rows).toHaveLength(1);
    // A network, never a host, and never an address that was asked about — the trail must not
    // become the list it exists to make visible.
    expect(rows[0]?.entity_id).toBe('127.0.0.0/24');
    expect(JSON.stringify(rows)).not.toContain('known-0@example.org');
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toMatchObject({ answers: 20 });
  }, 60_000);

  /**
   * THE FINDING THIS FILE EXISTED TO CATCH AND DID NOT, MEASURED AGAINST THE BUILT SERVER ON
   * 2026-08-12: 120 POSTs naming an address that already had an account — 147 ms, 120 ms of CPU,
   * zero argon2id, zero rows — closed the network rung, and the next honest student from a
   * different connection was answered "Too many accounts have been created from your network in the
   * last few minutes" with `SELECT COUNT(*) FROM users` returning 1.
   *
   * Two separate defects in one measurement, and this test pins both: denying the whole deployment
   * cost a thousandth of what using it costs, and the sentence the victim was shown was false.
   *
   * A HUNDRED AND TWENTY IS NOT AN ARBITRARY NUMBER. It is what the network rung was before this
   * change, so a regression that starts charging probes again fails here on the first rung it
   * reaches rather than at some larger number this test would have to guess.
   */
  it('does not let questions about other people close sign-up for everybody', async () => {
    createUserRepo(db).create({
      email: 'known@example.org',
      passwordHash: await seededPasswordHash(),
      role: 'member',
    });
    const app = build();

    for (let i = 0; i < 120; i += 1) {
      const res = await request(app)
        .post('/api/auth/enroll')
        .set('X-Forwarded-For', `203.0.113.${String((i % 100) + 20)}`)
        .send({ email: 'known@example.org', password: GOOD_PASSWORD });
      expect(res.status).toBe(409);
    }

    const honest = await request(app)
      .post('/api/auth/enroll')
      .set('X-Forwarded-For', '198.51.100.77')
      .send({ email: 'honest-student@example.org', password: GOOD_PASSWORD });
    expect(honest.status).toBe(201);
    // Not one of those 120 questions left a mark on any rung, so the connection they came from can
    // still make its own sixty accounts as well.
    expect(memberCount()).toBe(2);
  }, 120_000);
});

/**
 * TWO PEOPLE, ONE ADDRESS, ONE INSTANT.
 *
 * The check that decides this is inside the transaction, in the same synchronous stretch as the
 * INSERT, and the argon2id that used to sit between a check and a write is paid before the
 * transaction opens. `Promise.all` overlaps the handlers for real: every one of these requests
 * reads an empty table, and then all but one of them loses.
 */
describe('two people registering the same address at the same instant', () => {
  const RACERS = 6;

  it('produces exactly one account and refuses the others without a fault', async () => {
    const app = build();

    const statuses = await Promise.all(
      Array.from({ length: RACERS }, () =>
        request(app)
          .post('/api/auth/enroll')
          .send({ email: 'contested@example.org', password: GOOD_PASSWORD })
          .then((res) => res.status),
      ),
    );

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(RACERS - 1);
    // Nothing 500s: losing a race is an answer, not a fault.
    expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
    expect(memberCount()).toBe(1);
  }, 60_000);
});

/**
 * THE LADDER, AND THE QUESTION THAT DECIDES EVERY NUMBER IN IT: what does it cost the people it is
 * not aimed at?
 *
 * THIS IS THE PART OF THE CHANGE THAT IS EASIEST TO GET WRONG, and this codebase has got it wrong
 * three times. The rungs were sized against a caller GUESSING a secret and were charged only when
 * one was wrong, so no legitimate person ever met them. They are now charged on every registration,
 * which puts them in front of exactly the traffic the product exists for — so the numbers moved,
 * and these tests are about the moving rather than the numbers.
 */
describe('what the ladder must never do to the people it is not aimed at', () => {
  const app = () => build();

  it('gives thirty students signing up together thirty accounts', async () => {
    const server = app();
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_unused, i) =>
        request(server)
          .post('/api/auth/enroll')
          .send({ email: `intake-${String(i)}@example.org`, password: GOOD_PASSWORD }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(30);
    expect(memberCount()).toBe(30);
  }, 180_000);

  /**
   * THE INTAKE ARRIVES FROM ONE BUILDING. Behind the documented tunnel `req.ip` is whatever
   * Cloudflare reported, which for a lecture hall is the campus NAT — one bucket for all thirty.
   * The connection rung was TEN while it counted wrong codes; ten here would have answered twenty
   * of these students "try again later", which is the 2026-08-05 defect this file has already paid
   * for once.
   */
  it('does not refuse a whole intake because it shares one address', async () => {
    const server = app();
    const statuses: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const res = await request(server)
        .post('/api/auth/enroll')
        .set('X-Forwarded-For', '203.0.113.7')
        .send({ email: `nat-${String(i)}@example.org`, password: GOOD_PASSWORD });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(30);
  }, 180_000);
});

/**
 * WHAT THE LADDER DOES TO THE CALLER IT IS AIMED AT.
 *
 * These run the SHIPPED numbers rather than an injected small one, for the reason the old file gave
 * and which has not changed: a limiter tested at a ceiling of three proves that a limiter works,
 * not that this deployment's limiter is set where its comment says. Sixty-one requests is cheap
 * because the refused ones cost no argon2id — that is the property, not an accident of the test.
 */
describe('the ceiling on how many accounts one caller can make', () => {
  it('creates sixty from one connection and then says how long to wait', async () => {
    const server = build();
    const statuses: number[] = [];
    for (let i = 0; i < REGISTRATION_MAX_PER_CONNECTION + 1; i += 1) {
      const res = await request(server)
        .post('/api/auth/enroll')
        .send({ email: `bulk-${String(i)}@example.org`, password: GOOD_PASSWORD });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.body.error.code).toBe('rate_limited');
        expect(res.body.error.details.retryAfterSec).toBeGreaterThan(0);
        expect(res.body.error.details.retryAfterSec).toBeLessThanOrEqual(
          REGISTRATION_WINDOW_MS / 1000,
        );
        // The three things this sentence has to say to somebody who is not the attacker.
        expect(res.body.error.message).toMatch(/nothing is wrong with your details/i);
        expect(res.body.error.message).toMatch(/wait a few minutes/i);
        expect(res.body.error.message).toMatch(/signing in is not affected/i);
        /**
         * AND THE FOURTH THING, WHICH IS THAT IT IS TRUE.
         *
         * MEASURED on 2026-08-12, before this round: this sentence was shown to somebody after 120
         * requests that created NOTHING, on a deployment whose users table held one row. It counted
         * attempts and spoke about accounts. The number it quotes is now read back out of the
         * limiter, so this assertion compares the sentence against the database — which is the only
         * assertion that can catch the two drifting apart again.
         */
        expect(res.body.error.message).toContain(`${String(memberCount())} accounts have been`);
        expect(res.body.error.message).not.toMatch(/nothing has been used up/i);
      }
    }

    expect(statuses.filter((s) => s === 201)).toHaveLength(REGISTRATION_MAX_PER_CONNECTION);
    expect(statuses.at(-1)).toBe(429);
    expect(memberCount()).toBe(REGISTRATION_MAX_PER_CONNECTION);
  }, 300_000);

  /**
   * A REFUSAL CHARGES NOTHING, which is the arithmetic the whole ladder rests on: one network can
   * only ever put its own ceiling into the deployment-wide counter, so closing that one takes at
   * least two networks acting together.
   *
   * Asserted here on the connection rung against the network rung, because that is the pair a
   * single caller can actually exercise: a connection that has been cut off knocks twenty more
   * times, and none of those twenty may appear in the network's total. If a refusal charged, a
   * caller could spend the whole network rung by knocking at a door that was already shut.
   *
   * IT TAKES FOUR CONNECTIONS TO SPEND THE NETWORK RUNG NOW, and that is the 2026-08-12 change
   * showing through rather than a complication. The rung moved from 120 to 240 because behind the
   * operator's tunnel it IS the deployment ceiling and 120 was exactly the design load; the
   * connection rung stayed at 60, so the arithmetic that used to need two connections needs four.
   * The loop below walks them, which is also the closest a test gets to the measured shape — four
   * connections, sixty each, one peer.
   */
  it('does not charge a refused request to the rungs below it', async () => {
    const server = build();
    for (let i = 0; i < REGISTRATION_MAX_PER_CONNECTION + 20; i += 1) {
      await request(server)
        .post('/api/auth/enroll')
        .send({ email: `charge-${String(i)}@example.org`, password: GOOD_PASSWORD });
    }
    // Twenty requests past the connection ceiling, all refused. If any of them had been charged to
    // the network rung, the connections below would run out early.
    const rest = REGISTRATION_MAX_PER_NETWORK - REGISTRATION_MAX_PER_CONNECTION;
    const later: number[] = [];
    for (let i = 0; i < rest; i += 1) {
      const res = await request(server)
        .post('/api/auth/enroll')
        // A fresh connection every sixty, because the connection rung is sixty and this test is
        // about the rung underneath it.
        .set('X-Forwarded-For', `198.51.100.${String(Math.floor(i / 60) + 1)}`)
        .send({ email: `later-${String(i)}@example.org`, password: GOOD_PASSWORD });
      later.push(res.status);
    }
    expect(later.filter((s) => s === 201)).toHaveLength(rest);
    // …and the network rung is now exactly spent, so one more connection in it is refused with the
    // sentence that says so rather than the connection one.
    const beyond = await request(server)
      .post('/api/auth/enroll')
      .set('X-Forwarded-For', '198.51.100.9')
      .send({ email: 'beyond@example.org', password: GOOD_PASSWORD });
    expect(beyond.status).toBe(429);
    expect(beyond.body.error.message).toMatch(/from your network/i);
    // The sentence names the accounts that exist, which is the whole of `registrationRefusal`'s
    // 2026-08-12 rewrite: 240 were created, 240 is what it says, and the database agrees.
    expect(beyond.body.error.message).toContain(
      `${String(REGISTRATION_MAX_PER_NETWORK)} accounts have been`,
    );
    expect(memberCount()).toBe(REGISTRATION_MAX_PER_NETWORK);
  }, 600_000);

  /**
   * THE ROW AN OPERATOR READS WHEN SIGN-UP STOPS WORKING.
   *
   * It is more important than it was. When these rungs counted wrong codes, a closed budget refused
   * an attacker; now it refuses whoever arrives next, and the row is the only evidence that anybody
   * was turned away at all. One per rung per window, keyed on something the caller cannot mint.
   */
  it('writes one row when a rung closes, with no address in it', async () => {
    const server = build();
    for (let i = 0; i < REGISTRATION_MAX_PER_CONNECTION + 5; i += 1) {
      await request(server)
        .post('/api/auth/enroll')
        .send({ email: `noticed-${String(i)}@example.org`, password: GOOD_PASSWORD });
    }

    const rows = db
      .prepare("SELECT entity_id, detail FROM audit_log WHERE action = 'auth.registration_limited'")
      .all() as Array<{ entity_id: string; detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_id).toBe('127.0.0.0/24');
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toMatchObject({
      rung: 'connection',
      // THE COUNT THAT WAS RECORDED, AND SEPARATELY THE CEILING. `registrations` used to be the
      // ceiling under a name that promised a count, and on 2026-08-12 it was measured telling an
      // operator `"registrations":120` while the users table held one row. The two are equal here
      // because sixty accounts really were created; `memberCount()` is what makes that an assertion
      // about the database rather than about a constant.
      registrations: memberCount(),
      ceiling: REGISTRATION_MAX_PER_CONNECTION,
      windowSec: REGISTRATION_WINDOW_MS / 1000,
    });
    expect(JSON.stringify(rows)).not.toContain('noticed-0@example.org');
  }, 300_000);
});

/**
 * THE THIRD ROW EVERY REGISTRATION WRITES, AND THE ONE NOTHING WAS EVER GOING TO REMOVE.
 *
 * MEASURED, 2026-08-12: a hundred registrations against the built server produced 100 `users` rows,
 * 100 `audit_log` rows and 101 `sessions` rows — signing up signs you in — at 1,024 bytes of
 * checkpointed SQLite each. `sessions.removeExpired` existed, was tested in `test/accounts.test.ts`
 * and HAD NO CALLER anywhere in the server, so every one of those rows would have sat in the table
 * for its full thirty days and then for good.
 *
 * The sweep hangs off creating a session, which is the only thing that grows the table, and runs at
 * most hourly. This test drives it through registration because registration is the path that can
 * grow it fastest and by strangers.
 */
describe('the session rows a registration leaves behind', () => {
  it('clears expired sessions the first time it creates one', async () => {
    const sessions = createSessionRepo(db);
    // Two rows belonging to the seeded administrator: one long dead, one still live. Inserted
    // before the app has created any session of its own, so the registration below is the first
    // call to `startSession` in this router's life and therefore the first sweep.
    sessions.create({
      id: 'dead-session',
      userId: ADMIN_ID,
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    sessions.create({
      id: 'live-session',
      userId: ADMIN_ID,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(sessions.count()).toBe(2);

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ email: 'sweeper@example.org', password: GOOD_PASSWORD });
    expect(res.status).toBe(201);

    // The dead one is gone; the live one and the new member's are not.
    expect(sessions.find('dead-session')).toBeUndefined();
    expect(sessions.find('live-session')).toBeDefined();
    expect(sessions.count()).toBe(2);
  }, 30_000);
});

/**
 * A CALLER WHO WRITES THEIR OWN `X-Forwarded-For`, which is every caller when nothing sits in front
 * of this process.
 *
 * The connection rung is theirs to rotate and always was; what stops that being unlimited is the
 * two rungs underneath it, which are derived from the TCP peer and from nothing at all. This is the
 * same pair of tests the guess ladder had, re-pointed: what they pin is the SHAPE — that rotating
 * the header buys the network's ceiling and not the deployment's.
 */
describe('a caller who mints their own address', () => {
  /**
   * One socket, reused, so every request really does share a TCP peer. Without the agent, supertest
   * opens a connection per request and the peer differs only in port — which `coarseOrigin` strips
   * anyway, so this is belt and braces made explicit rather than assumed.
   */
  const agent = new httpAgent({ keepAlive: true, maxSockets: 8 });

  it('gets the network ceiling however many addresses they claim', async () => {
    const server = build();
    let created = 0;
    let refused = 0;
    for (let i = 0; i < REGISTRATION_MAX_PER_NETWORK + 10; i += 1) {
      const res = await request(server)
        .post('/api/auth/enroll')
        .agent(agent)
        // A FRESH ADDRESS EVERY TIME: the connection rung can never fire on this caller.
        .set('X-Forwarded-For', `203.0.113.${String(i % 254)}`)
        .send({ email: `minted-${String(i)}@example.org`, password: GOOD_PASSWORD });
      if (res.status === 201) created += 1;
      else if (res.status === 429) refused += 1;
    }

    expect(created).toBe(REGISTRATION_MAX_PER_NETWORK);
    expect(refused).toBe(10);
    // Not the deployment rung: one network cannot spend more than its own share, which is what
    // keeps the deployment-wide ceiling out of one caller's reach.
    expect(created).toBeLessThan(REGISTRATION_MAX_DEPLOYMENT);
  }, 600_000);
});

/**
 * THE ONE PROPERTY THAT KEEPS OPEN REGISTRATION FROM LOSING A DEPLOYMENT ITS ADMINISTRATOR.
 *
 * `bootstrap.required()` is "no accounts exist", and the first-run token is the only thing that can
 * create an administrator. A stranger registering on a fresh deployment would make that false and
 * the operator's token useless — not "somebody else is the admin", but "nobody can ever be", with
 * no repair short of deleting the database. So the door opens in the order the deployment is built.
 */
describe('a deployment nobody has set up yet', () => {
  it('creates no account at all, and says why', async () => {
    // The one test in this file that runs without the seeded administrator.
    db.prepare('DELETE FROM users').run();
    const app = build();

    const res = await request(app)
      .post('/api/auth/enroll')
      .send({ email: 'first@example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.message).toMatch(/has not been set up/i);
    // The sentence has to point at the person who can fix it, and say that the door opens after.
    expect(res.body.error.message).toMatch(/administrator account first/i);
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0);
  }, 30_000);

  it('opens the moment the administrator exists, on the same running server', async () => {
    db.prepare('DELETE FROM users').run();
    const bootstrap = createBootstrapState(db, () => undefined);
    const app = createApp({
      db,
      config,
      bootstrap,
      loginLimiter: createRateLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 5 }),
      logger: () => undefined,
    });

    expect(
      (
        await request(app)
          .post('/api/auth/enroll')
          .send({ email: 'early@example.org', password: GOOD_PASSWORD })
      ).status,
    ).toBe(409);

    const setUp = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token: bootstrap.token(), email: 'admin@example.org', password: GOOD_PASSWORD });
    expect(setUp.status).toBe(201);

    const now = await request(app)
      .post('/api/auth/enroll')
      .send({ email: 'early@example.org', password: GOOD_PASSWORD });
    expect(now.status).toBe(201);
    expect(now.body.user.role).toBe('member');
  }, 60_000);
});

/**
 * THE ROUTE THAT ANSWERED "IS ENROLMENT OPEN?" IS GONE, and this is the test that says so rather
 * than the absence of one.
 *
 * It existed so the sign-in screen could decide whether to offer a way in that would work. The
 * answer is now a constant, and a browser that still asks gets the 404 any unknown /api path gets —
 * which `routes/FirstRun.tsx` treated as "did not say" and which left the offer standing, so a tab
 * open across the upgrade behaves correctly by accident and by design at once.
 */
describe('the enrollment-open question', () => {
  it('is no longer a route, and 404s like anything else that is not there', async () => {
    const res = await request(build()).get('/api/auth/enrollment-open');
    expect(res.status).toBe(404);
  });
});
