import type Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createBootstrapState } from '../auth/bootstrap.js';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../auth/password.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { loadConfig } from '../config.js';
import {
  createEnrollmentCodeRepo,
  hashEnrollmentCode,
  type EnrollmentCodeRepo,
} from '../db/repositories/enrollmentCodes.js';
import { createUserRepo } from '../db/repositories/users.js';
import { createTestDb, type TestDb } from '../../test/helpers/tempDb.js';

/**
 * THE PUBLIC HALF OF ENROLMENT: `POST /api/auth/enroll` and `GET /api/auth/enrollment-open`.
 *
 * `test/api.auth.test.ts` covers login, /me and logout; `api/auth.test.ts` covers the first-run
 * token. This file covers the third way an account can come into existence — the one nobody has to
 * be present for — and the properties it has to hold are not the properties of a sign-in form:
 * exactly one account per available use no matter how many people press at once, one answer for
 * every wrong code, and never an administrator.
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
let codes: EnrollmentCodeRepo;

beforeEach(async () => {
  harness = createTestDb();
  db = harness.db;
  codes = createEnrollmentCodeRepo(db);
  // A real administrator row: `enrollment_codes.created_by_user_id` references it, and its presence
  // is also what makes first-run bootstrap closed, which is the state a live deployment is in.
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

function issue(over: Partial<Parameters<EnrollmentCodeRepo['create']>[0]> = {}) {
  return codes.create({
    label: 'W1MX autumn 2026 intake',
    maxUses: null,
    expiresAt: null,
    createdByUserId: ADMIN_ID,
    nowISO: new Date().toISOString(),
    ...over,
  });
}

function memberCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member'").get() as { n: number }
  ).n;
}

function usesOf(id: string): number {
  return codes.findById(id)?.uses ?? -1;
}

/** Status plus the error envelope, with the per-request id removed: what a caller can tell apart. */
function refusal(res: request.Response): unknown {
  return { status: res.status, error: res.body.error };
}

describe('enrolling with a code', () => {
  it('creates a member, signs them in, and spends exactly one use', async () => {
    const { code, plaintext } = issue({ maxUses: 30 });

    const res = await request(build()).post('/api/auth/enroll').send({
      code: plaintext,
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
    // Signed in on the way out: the point of enrolling is to arrive inside the product.
    const setCookie = res.headers['set-cookie'];
    expect((Array.isArray(setCookie) ? setCookie : [setCookie]).join(';')).toContain(
      `${SESSION_COOKIE}=`,
    );

    // The password they chose is the credential that was stored.
    const stored = createUserRepo(db).findByEmail('new.student@example.org');
    expect(stored).toBeDefined();
    expect(stored?.role).toBe('member');
    await expect(verifyPassword(stored!.passwordHash, GOOD_PASSWORD)).resolves.toBe(true);

    // Exactly one use, stamped.
    expect(codes.findById(code.id)).toMatchObject({ uses: 1, lastUsedAt: expect.any(String) });

    // …and an administrator can find out where this account came from, without the code appearing.
    const audit = db
      .prepare('SELECT actor_user_id, action, entity_type, detail FROM audit_log')
      .all() as Array<Record<string, string>>;
    expect(audit).toEqual([
      {
        actor_user_id: stored!.id,
        action: 'user.enroll',
        entity_type: 'user',
        detail: JSON.stringify({ enrollmentCodeId: code.id, label: 'W1MX autumn 2026 intake' }),
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(plaintext.replace(/-/g, ''));
  }, 30_000);

  it('accepts the code as it was written down, not as it was generated', async () => {
    const { plaintext } = issue();
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: ` ${plaintext.toLowerCase()} `, email: 'a@example.org', password: GOOD_PASSWORD });
    expect(res.status).toBe(201);
  }, 30_000);

  it('never emits a hash, a token or anything else the account is held together with', async () => {
    const { plaintext } = issue();
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/argon2|passwordHash|icsToken/i);
    expect(body).not.toContain(createUserRepo(db).findByEmail('a@example.org')!.icsToken);
    expect(body).not.toContain(hashEnrollmentCode(plaintext));
  }, 30_000);
});

describe('enrolment never grants admin', () => {
  it('ignores a role the caller asked for, and makes a member', async () => {
    const { plaintext } = issue();
    const res = await request(build()).post('/api/auth/enroll').send({
      code: plaintext,
      email: 'aspiring@example.org',
      password: GOOD_PASSWORD,
      role: 'admin',
      isAdmin: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('member');
    expect(createUserRepo(db).findByEmail('aspiring@example.org')?.role).toBe('member');
    // The only admin in this deployment is still the one that was seeded.
    expect(
      db.prepare("SELECT id FROM users WHERE role = 'admin'").all(),
    ).toEqual([{ id: ADMIN_ID }]);
  }, 30_000);
});

describe('a code that cannot be redeemed', () => {
  it('answers an unknown code and a wrong-but-plausible one identically', async () => {
    // A real code exists; neither of these is it. One is shaped exactly like a code from this
    // deployment's own alphabet, the other is the real code with its last character changed — the
    // guess somebody makes if they think they mistyped one character.
    const { code, plaintext } = issue();
    const app = build();

    const lastIsZero = plaintext.endsWith('0');
    const nearMiss = `${plaintext.slice(0, -1)}${lastIsZero ? '2' : '0'}`;
    expect(nearMiss).not.toBe(plaintext);

    const unknown = await request(app)
      .post('/api/auth/enroll')
      .send({ code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', email: 'a@example.org', password: GOOD_PASSWORD });
    const plausible = await request(app)
      .post('/api/auth/enroll')
      .send({ code: nearMiss, email: 'b@example.org', password: GOOD_PASSWORD });

    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('unauthorized');
    // Byte-identical, envelope and all: nothing here tells the caller that some OTHER code exists,
    // how many there are, or that they were one character away from one.
    expect(refusal(plausible)).toEqual(refusal(unknown));

    expect(memberCount()).toBe(0);
    expect(usesOf(code.id)).toBe(0);
  }, 30_000);

  it('tells the holder of a revoked code that it was withdrawn', async () => {
    const { code, plaintext } = issue();
    codes.revoke(code.id, new Date().toISOString());

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/withdrawn/i);
    expect(memberCount()).toBe(0);
  }, 30_000);

  it('tells the holder of an expired code that it expired', async () => {
    const { plaintext } = issue({ expiresAt: '2020-01-01T00:00:00.000Z' });

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/expired/i);
    expect(memberCount()).toBe(0);
  }, 30_000);

  /**
   * THE THIRTY-FIRST PERSON.
   *
   * A club officer issues a thirty-use code for an intake and thirty-one people turn up. The
   * thirty-first has typed everything correctly, has done nothing wrong, and is the single most
   * likely person in this whole feature to conclude that the product is broken and give up. What
   * this message has to do is tell them it is not their fault and name the one action that fixes
   * it — ask the person who gave them the code — rather than say "not valid" and let them retype
   * it eleven times.
   */
  it('tells the person who arrived after a code ran out that it is not their fault', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    const app = build();

    const first = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'first@example.org', password: GOOD_PASSWORD });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'second@example.org', password: GOOD_PASSWORD });

    expect(second.status).toBe(403);
    expect(second.body.error.message).toMatch(/already been used/i);
    // The two things the sentence exists to say.
    expect(second.body.error.message).toMatch(/not.*wrong|nothing is wrong/i);
    expect(second.body.error.message).toMatch(/ask the person who gave you the code/i);

    expect(memberCount()).toBe(1);
    expect(usesOf(code.id)).toBe(1);
  }, 30_000);
});

describe('a body that costs the holder nothing', () => {
  it('refuses a password below the floor without spending the code', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    // The number is in the sentence: "the request body is invalid" makes them guess.
    expect(res.body.error.message).toContain(String(MIN_PASSWORD_LENGTH));

    // Their one place is still theirs.
    expect(usesOf(code.id)).toBe(0);
    expect(memberCount()).toBe(0);
    const retry = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });
    expect(retry.status).toBe(201);
  }, 30_000);

  it('refuses an address that already has an account without spending the code', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    createUserRepo(db).create({
      email: 'taken@example.org',
      passwordHash: await seededPasswordHash(),
      role: 'member',
    });

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'Taken@Example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(usesOf(code.id)).toBe(0);
    expect(memberCount()).toBe(1);
  }, 30_000);

  it('refuses something that could never be an email address', async () => {
    const { code, plaintext } = issue();
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'not-an-address', password: GOOD_PASSWORD });

    expect(res.status).toBe(422);
    expect(usesOf(code.id)).toBe(0);
  }, 30_000);
});

/**
 * THE HEART OF THIS FEATURE, AND THE DEFECT IT IS SHAPED AGAINST.
 *
 * This project shipped a check-then-act with an `await` between the check and the write once
 * already, in the callsign lookup: eight concurrent presses all read the same empty ledger, all
 * passed a limit meant to allow one, and all sent a request. Nothing about that was visible to a
 * test that made the presses one after another.
 *
 * So the first test below is a CONTROL rather than a test of the product: it drives the naive shape
 * — read the row, await an argon2id hash, write `uses + 1` computed in JavaScript — through the
 * same `Promise.all` harness, and proves the harness genuinely overlaps by watching that shape
 * fail. Without it, the second test passing would be evidence of nothing: a harness that serialised
 * its requests would pass it just as happily against a broken implementation.
 */
describe('two people redeeming the last use at the same instant', () => {
  const RACERS = 6;

  it('CONTROL: the naive read-await-write shape hands out six accounts from a one-use code', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    const codeHash = hashEnrollmentCode(plaintext);
    const users = createUserRepo(db);

    // Deliberately NOT `repo.redeem`. This is what the route would look like if the check and the
    // write were separated by the password hash, which is the only await on the real path.
    async function naiveRedeem(email: string): Promise<boolean> {
      const row = db
        .prepare('SELECT id, uses, max_uses FROM enrollment_codes WHERE code_hash = ?')
        .get(codeHash) as { id: string; uses: number; max_uses: number | null };
      if (row.max_uses !== null && row.uses >= row.max_uses) return false;

      const passwordHash = await hashPassword(GOOD_PASSWORD);

      db.prepare('UPDATE enrollment_codes SET uses = ? WHERE id = ?').run(row.uses + 1, row.id);
      users.create({ email, passwordHash, role: 'member' });
      return true;
    }

    const results = await Promise.all(
      Array.from({ length: RACERS }, (_unused, i) => naiveRedeem(`racer-${String(i)}@example.org`)),
    );

    // Every one of them believed it had the last use. This is the bug, reproduced on purpose.
    expect(results.filter(Boolean)).toHaveLength(RACERS);
    expect(memberCount()).toBe(RACERS);

    // AND THE LEDGER DOES NOT EVEN RECORD IT. Measured, not predicted: this assertion was written
    // as `toBe(RACERS)` and came back 1. All six racers read `uses = 0` and all six wrote
    // `uses = 0 + 1`, so five of the writes are lost and the table ends up saying that a one-use
    // code was used once — while six accounts exist. An officer auditing this afterwards would see
    // nothing wrong at all, which is the part that makes this class of defect survive: it is silent
    // in exactly the record you would go and check. `uses = uses + 1` in the WHERE-guarded UPDATE
    // is what makes the count arithmetic rather than a guess.
    expect(usesOf(code.id)).toBe(1);
  }, 30_000);

  it('produces exactly one account, and exactly one use, from a one-use code', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    const app = build();

    const responses = await Promise.all(
      Array.from({ length: RACERS }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({
            code: plaintext,
            email: `racer-${String(i)}@example.org`,
            password: GOOD_PASSWORD,
          }),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(memberCount()).toBe(1);
    expect(usesOf(code.id)).toBe(1);

    // The five who lost are told the truthful thing — the code ran out — and not "invalid".
    const losers = responses.filter((r) => r.status !== 201);
    expect(losers).toHaveLength(RACERS - 1);
    for (const loser of losers) {
      expect(loser.status).toBe(403);
      expect(loser.body.error.message).toMatch(/already been used/i);
    }
    // Exactly one account exists, and it belongs to whichever racer won.
    const emails = (db.prepare("SELECT email FROM users WHERE role = 'member'").all() as Array<{
      email: string;
    }>).map((r) => r.email);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatch(/^racer-\d@example\.org$/);
    expect(created[0].body.user.email).toBe(emails[0]);
  }, 30_000);

  it('hands out no more than the limit when many race for a few places', async () => {
    const { code, plaintext } = issue({ maxUses: 2 });
    const app = build();

    const responses = await Promise.all(
      Array.from({ length: RACERS }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({
            code: plaintext,
            email: `crowd-${String(i)}@example.org`,
            password: GOOD_PASSWORD,
          }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
    expect(memberCount()).toBe(2);
    expect(usesOf(code.id)).toBe(2);
  }, 30_000);
});

describe('the rate limiter is what makes the entropy mean something', () => {
  /**
   * The shipped numbers, not injected ones: ten wrong codes in fifteen minutes. There is no seam to
   * inject a smaller limiter through `createApp` — `AppDeps` does not carry one, and `app.ts` is
   * outside this change's territory — and testing the real configuration is worth more than testing
   * a fake anyway, because the number that matters operationally is the one that ships.
   */
  it('closes the door after ten wrong codes and says how long for', async () => {
    issue();
    const app = build();

    async function guess(n: number) {
      return request(app)
        .post('/api/auth/enroll')
        .send({
          code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZ2',
          email: `guess-${String(n)}@example.org`,
          password: GOOD_PASSWORD,
        });
    }

    for (let i = 0; i < 10; i += 1) {
      expect((await guess(i)).status).toBe(401);
    }

    const blocked = await guess(10);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.details.retryAfterSec).toBeGreaterThan(0);
    expect(memberCount()).toBe(0);
  }, 60_000);

  it('does not charge the holder of a real code that has run out', async () => {
    const { plaintext } = issue({ maxUses: 1 });
    const app = build();
    expect(
      (
        await request(app)
          .post('/api/auth/enroll')
          .send({ code: plaintext, email: 'first@example.org', password: GOOD_PASSWORD })
      ).status,
    ).toBe(201);

    // Eleven attempts with a REAL code that has run out — one more than the failure budget. Their
    // holder is not guessing, so none of them is charged and the eleventh is still answered with
    // the truth rather than with a lockout.
    for (let i = 0; i < 11; i += 1) {
      const res = await request(app)
        .post('/api/auth/enroll')
        .send({ code: plaintext, email: `late-${String(i)}@example.org`, password: GOOD_PASSWORD });
      expect(res.status).toBe(403);
    }
  }, 60_000);

  it('forgets the failures as soon as somebody enrolls successfully', async () => {
    const { plaintext } = issue({ maxUses: 5 });
    const app = build();

    for (let i = 0; i < 9; i += 1) {
      await request(app)
        .post('/api/auth/enroll')
        .send({
          code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZ2',
          email: `guess-${String(i)}@example.org`,
          password: GOOD_PASSWORD,
        });
    }

    const good = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'real@example.org', password: GOOD_PASSWORD });
    expect(good.status).toBe(201);

    // The intake carries on: the nine mistypes before it are no longer held against anybody.
    const after = await request(app)
      .post('/api/auth/enroll')
      .send({
        code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZ2',
        email: 'another@example.org',
        password: GOOD_PASSWORD,
      });
    expect(after.status).toBe(401);
  }, 60_000);
});

describe('whether the sign-in screen should offer to enrol at all', () => {
  it('is false on a deployment that has never issued a code', async () => {
    const res = await request(build()).get('/api/auth/enrollment-open');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: false });
  });

  it('is true while one code could be redeemed, and false once none can', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    const app = build();
    expect((await request(app).get('/api/auth/enrollment-open')).body).toEqual({ open: true });

    await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });

    expect(usesOf(code.id)).toBe(1);
    expect((await request(app).get('/api/auth/enrollment-open')).body).toEqual({ open: false });
  }, 30_000);

  it('answers one boolean and nothing else — no label, no count, no id', async () => {
    issue({ label: 'W1MX autumn 2026 intake', maxUses: 30 });
    const res = await request(build()).get('/api/auth/enrollment-open');
    expect(Object.keys(res.body)).toEqual(['open']);
    expect(JSON.stringify(res.body)).not.toMatch(/W1MX|30|intake/);
  });
});
