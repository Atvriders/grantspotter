import { CHOSEN_CODE_MIN_LENGTH, exhaustionChance } from '@grantspotter/core';
import type Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEnrollmentCodeRepo,
  hashEnrollmentCode,
  normalizeEnrollmentCode,
  type EnrollmentCodeRepo,
} from '../db/repositories/enrollmentCodes.js';
import { ENV_CODE_LABEL } from '../auth/chosenCode.js';
import { openTestDb } from '../test/testDb.js';
import type { RouterDeps, SessionUser } from './deps.js';
import { createEnrollmentRouter } from './enrollment.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';

const NOW = '2026-09-01T12:00:00.000Z';
const ADMIN: SessionUser = { id: 'admin-1', email: 'admin@example.org', role: 'admin' };
const MEMBER: SessionUser = { id: 'member-1', email: 'member@example.org', role: 'member' };

let db: Database.Database;

/** The same seam `adminUsersRouter.test.ts` uses: the auth middleware is injected, not imported. */
function buildApp(user: SessionUser) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => {
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/admin/enrollment-codes', createEnrollmentRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

/**
 * Seed a code straight through the repository, bypassing the router. `create` returns a union
 * because a CHOSEN code can collide; nothing seeded here is chosen, so the refusal is thrown on.
 */
function seedCode(over: Partial<Parameters<EnrollmentCodeRepo['create']>[0]> = {}) {
  const issued = createEnrollmentCodeRepo(db).create({
    label: 'seeded',
    chosen: null,
    maxUses: null,
    expiresAt: null,
    createdByUserId: ADMIN.id,
    nowISO: NOW,
    ...over,
  });
  if (!issued.ok) throw new Error('seedCode(): unexpected collision');
  return issued;
}

function insertUser(id: string, role: 'admin' | 'member'): void {
  db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
     VALUES (?, ?, ?, 'not-a-real-hash', ?, ?, ?)`,
  ).run(id, `${id}@example.org`, `${id}@example.org`, role, `ics-${id}`, NOW);
}

function auditRows(): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT at, actor_user_id, action, entity_type, entity_id, detail FROM audit_log')
    .all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  db = openTestDb();
  insertUser(ADMIN.id, 'admin');
  insertUser(MEMBER.id, 'member');
});

afterEach(() => {
  db.close();
});

describe('/api/admin/enrollment-codes', () => {
  it('refuses a member on every route, and writes nothing', async () => {
    const { code } = seedCode();
    const app = buildApp(MEMBER);

    for (const res of [
      await request(app).get('/api/admin/enrollment-codes'),
      await request(app).post('/api/admin/enrollment-codes').send({ label: 'sneaky' }),
      await request(app).post(`/api/admin/enrollment-codes/${code.id}/revoke`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }

    // A refused request must not have issued a code, revoked one, or left a trail suggesting it did.
    expect(createEnrollmentCodeRepo(db).list()).toHaveLength(1);
    expect(createEnrollmentCodeRepo(db).list()[0].revokedAt).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  it('issues a code, shows the plaintext once, and never shows it again', async () => {
    const app = buildApp(ADMIN);
    const res = await request(app)
      .post('/api/admin/enrollment-codes')
      .send({ label: 'W1MX autumn 2026 intake', maxUses: 30, expiresInDays: 7 });

    expect(res.status).toBe(201);
    expect(res.body.code).toEqual({
      id: expect.any(String),
      label: 'W1MX autumn 2026 intake',
      // No `code` in the body, so the server generated one, and the record says so.
      chosen: false,
      maxUses: 30,
      uses: 0,
      // Seven days from the INJECTED clock, not from the wall clock.
      expiresAt: '2026-09-08T12:00:00.000Z',
      revokedAt: null,
      createdAt: NOW,
      createdByUserId: ADMIN.id,
      lastUsedAt: null,
    });
    const plaintext: string = res.body.plaintext;
    expect(plaintext).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}$/);

    // The list route is the only other way to see a code, and it cannot show this.
    const list = await request(app).get('/api/admin/enrollment-codes');
    expect(list.status).toBe(200);
    expect(list.body.codes).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(normalizeEnrollmentCode(plaintext));
    expect(JSON.stringify(list.body)).not.toContain(hashEnrollmentCode(plaintext));
    expect(list.body.codes[0]).not.toHaveProperty('plaintext');
    expect(list.body.codes[0]).not.toHaveProperty('codeHash');

    // Neither can the database, or the audit trail written beside it.
    const stored = JSON.stringify(db.prepare('SELECT * FROM enrollment_codes').all());
    expect(stored).not.toContain(normalizeEnrollmentCode(plaintext));
    expect(JSON.stringify(auditRows())).not.toContain(normalizeEnrollmentCode(plaintext));
    expect(JSON.stringify(auditRows())).not.toContain(hashEnrollmentCode(plaintext));
  });

  it('records who issued what, without recording the credential', async () => {
    const res = await request(buildApp(ADMIN))
      .post('/api/admin/enrollment-codes')
      .send({ label: 'Field Day helpers', maxUses: 5 });

    expect(auditRows()).toEqual([
      {
        at: NOW,
        actor_user_id: ADMIN.id,
        action: 'enrollment_code.create',
        entity_type: 'enrollment_code',
        entity_id: res.body.code.id,
        // `chosen: false` is in the trail because the two kinds of code are not equally strong and
        // the trail is where an administrator reconstructs what was issued. It is a boolean and
        // never the code, which is what the assertions below the create test check.
        detail: JSON.stringify({
          label: 'Field Day helpers',
          chosen: false,
          maxUses: 5,
          expiresAt: null,
        }),
      },
    ]);
  });

  it('treats an omitted limit and an explicit null as the same unlimited code', async () => {
    const app = buildApp(ADMIN);
    const omitted = await request(app).post('/api/admin/enrollment-codes').send({ label: 'a' });
    const explicit = await request(app)
      .post('/api/admin/enrollment-codes')
      .send({ label: 'b', maxUses: null, expiresInDays: null });

    for (const res of [omitted, explicit]) {
      expect(res.status).toBe(201);
      expect(res.body.code.maxUses).toBeNull();
      expect(res.body.code.expiresAt).toBeNull();
    }
  });

  it.each([
    ['no label at all', {}],
    ['a label of spaces', { label: '   ' }],
    ['a limit of zero', { label: 'a', maxUses: 0 }],
    ['a negative limit', { label: 'a', maxUses: -1 }],
    ['a fractional limit', { label: 'a', maxUses: 1.5 }],
    ['an absurd limit', { label: 'a', maxUses: 10_001 }],
    ['an expiry in the past', { label: 'a', expiresInDays: -1 }],
    ['an expiry of zero days', { label: 'a', expiresInDays: 0 }],
  ])('refuses %s', async (_name, body) => {
    const res = await request(buildApp(ADMIN)).post('/api/admin/enrollment-codes').send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(createEnrollmentCodeRepo(db).list()).toEqual([]);
  });

  it('revokes a code, and a second press changes nothing', async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post('/api/admin/enrollment-codes').send({ label: 'intake' });
    const id: string = created.body.code.id;

    const first = await request(app).post(`/api/admin/enrollment-codes/${id}/revoke`);
    expect(first.status).toBe(200);
    expect(first.body.code.revokedAt).toBe(NOW);

    const second = await request(app).post(`/api/admin/enrollment-codes/${id}/revoke`);
    expect(second.status).toBe(200);
    expect(second.body.code).toEqual(first.body.code);

    // One create, one revoke: the second press is not an event.
    expect(auditRows().map((r) => r.action)).toEqual([
      'enrollment_code.create',
      'enrollment_code.revoke',
    ]);
  });

  it('answers 404 for a code that does not exist', async () => {
    const res = await request(buildApp(ADMIN)).post(
      '/api/admin/enrollment-codes/no-such-id/revoke',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('lists every code with the counts an officer needs to answer a question about it', async () => {
    const live = seedCode({ label: 'live', maxUses: 30 });
    createEnrollmentCodeRepo(db).redeem({ plaintext: live.plaintext, nowISO: NOW }, () => 1);

    const res = await request(buildApp(ADMIN)).get('/api/admin/enrollment-codes');
    expect(res.body.codes).toEqual([
      expect.objectContaining({ label: 'live', maxUses: 30, uses: 1, lastUsedAt: NOW }),
    ]);
  });
});

/**
 * A CODE AN ADMINISTRATOR TYPED, AND THE FOUR THINGS THAT ARE TRUE OF IT AND OF NOTHING ELSE HERE.
 *
 * It can be too weak to be worth having; it has to be bounded in time, because it will be said out
 * loud; it can collide with a code that already exists, because normalisation folds letters onto
 * digits; and it can give itself away through its own label. Every one of those is a refusal an
 * administrator reads, so every one of them is asserted on the SENTENCE and not only on the status.
 */
describe('a code the administrator chooses', () => {
  /** The shape the feature exists for: a callsign, a season and a year. */
  const CHOSEN = 'W1MX-FALL-2026';
  const NORMALIZED = 'W1MXFA112026';

  /**
   * ONE ROUTER FOR THE WHOLE TEST, rebuilt between tests and not between requests.
   *
   * `createEnrollmentRouter` is called once by `api/mount.ts` at boot, so the per-window state it
   * closes over — the map that keeps one collision row per administrator per code — lives as long
   * as the process. A helper that built a fresh app per request would hand every request a fresh
   * map and would quietly assert nothing about the throttle.
   */
  let app: ReturnType<typeof buildApp> | undefined;
  beforeEach(() => {
    app = undefined;
  });

  function create(body: Record<string, unknown>) {
    app ??= buildApp(ADMIN);
    return request(app).post('/api/admin/enrollment-codes').send(body);
  }

  it('issues it, marks it chosen, and reports what was actually stored', async () => {
    const res = await create({
      label: 'W1MX autumn 2026 intake',
      code: CHOSEN,
      maxUses: 30,
      expiresInDays: 90,
    });

    expect(res.status).toBe(201);
    expect(res.body.code.chosen).toBe(true);
    // The administrator's own string comes back, so the console can show them what to read out…
    expect(res.body.plaintext).toBe(CHOSEN);
    // …and beside it, the value that was really committed to. They are not the same string, and
    // that difference is the whole reason this field exists.
    expect(res.body.normalized).toBe(NORMALIZED);
    expect(res.body.code.expiresAt).toBe('2026-11-30T12:00:00.000Z');
  });

  it('is redeemable by a holder who spells it any of the ways it can be spelled', async () => {
    await create({ label: 'intake', code: CHOSEN, maxUses: 30, expiresInDays: 90 });
    const repo = createEnrollmentCodeRepo(db);

    for (const typed of [CHOSEN, 'w1mx fall 2026', NORMALIZED, 'WIMX-FA11-2O26']) {
      expect(repo.inspect(typed, NOW).ok, typed).toBe(true);
    }
    expect(repo.redeem({ plaintext: 'wimx fa11 2o26', nowISO: NOW }, () => 'ok')).toMatchObject({
      ok: true,
      account: 'ok',
    });
  });

  it('refuses one that is too short, and says both numbers', async () => {
    const res = await create({ label: 'intake', code: 'W1MX2026', maxUses: 30, expiresInDays: 90 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    // The administrator's count and the floor, in the sentence, because a refusal that says only
    // "too short" gets retried one character at a time.
    expect(res.body.error.message).toMatch(/\b8 characters\b/);
    expect(res.body.error.message).toMatch(/at least 12/);
    /**
     * THE REASON, AND IT IS NO LONGER THE ONE THIS TEST USED TO PIN. It required
     * "ten wrong codes every fifteen minutes" and "1,862 wrong codes a second", which is the shape
     * of the defect rather than a passing detail: the sentence explained the floor by quoting the
     * throughput of a limiter keyed on a header the caller writes. Both are gone with the limiter
     * they described. What is asserted now is the deployment-wide ceiling, which is the true bound
     * on exhaustive search — and, deliberately, that the sentence quotes it "however many addresses
     * they use", because that clause is the whole difference.
     */
    expect(res.body.error.message).toMatch(/240 wrong codes every fifteen minutes/);
    expect(res.body.error.message).toMatch(/23,040 a day, however many addresses they use/);
    // The two odds, computed rather than asserted as prose: eight characters is not "found", it is
    // a probability, and a refusal that rounds one into a verdict invites disbelief.
    expect(res.body.error.message).toContain(exhaustionChance(8));
    expect(res.body.error.message).toContain(exhaustionChance(CHOSEN_CODE_MIN_LENGTH));
    /**
     * AND THE LIMIT OF THE CLAIM, WHICH IS THE ASSERTION THIS ROUND EXISTS FOR. The old sentence
     * ended "it is a floor rather than a promise", which is a hedge; a reader who clears the floor
     * still comes away believing the number did something for them. `W1MX-SPRING-2027` clears it by
     * two characters and was found on the seventh guess, so the refusal now says outright that no
     * length measures guessability, and says it with the measurement.
     */
    expect(res.body.error.message).toMatch(/not a measure of how hard your code is to GUESS/);
    expect(res.body.error.message).toMatch(/W1MX-SPRING-2027 was found on the seventh attempt/);
    expect(res.body.error.message).not.toMatch(/1,862/);
    expect(createEnrollmentCodeRepo(db).list()).toEqual([]);
  });

  /**
   * THE BOUND THAT IS LEFT WHEN THE FLOOR IS ADMITTED NOT TO BE ONE.
   *
   * MEASURED against the built server on 2026-08-10: a chosen code found on the seventh guess went
   * on to mint 60 further member accounts, one per request, until the harness stopped asking. The
   * argument recorded in core for NOT requiring `maxUses` — that it bounds the consequence and not
   * the attack — is still true and is now the reason to require it rather than the reason not to.
   */
  it('refuses a chosen code that says nothing about how many accounts it may make', async () => {
    const res = await create({ label: 'intake', code: CHOSEN, expiresInDays: 90 });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/has to say how many accounts it may create/);
    // The number an officer should type, so the refusal is a decision rather than a puzzle…
    expect(res.body.error.message).toMatch(/Thirty is the usual answer/);
    // …and the ceiling, so the next attempt is not refused a second time for a different reason.
    expect(res.body.error.message).toMatch(/most a chosen code may have is 200/);
    expect(createEnrollmentCodeRepo(db).list()).toEqual([]);
  });

  it('caps a chosen code at 200 accounts while leaving the generated ceiling alone', async () => {
    const chosen = await create({
      label: 'intake',
      code: CHOSEN,
      maxUses: 201,
      expiresInDays: 90,
    });
    expect(chosen.status).toBe(422);
    expect(chosen.body.error.message).toMatch(/at most 200 accounts and this one asks for 201/);
    // 200 exactly is allowed: a ceiling that refuses its own stated value is a different rule.
    expect(
      (await create({ label: 'hamfest', code: CHOSEN, maxUses: 200, expiresInDays: 90 })).status,
    ).toBe(201);

    // Nothing about this feature makes a 2^100 code weaker: it keeps 10,000 and keeps `null`.
    const generated = await create({ label: 'badges', maxUses: 10_000 });
    expect(generated.status).toBe(201);
    expect(generated.body.code.maxUses).toBe(10_000);
    expect((await create({ label: 'open house', maxUses: null })).status).toBe(201);
  });

  it('counts the code AFTER the fold, so dashes do not buy length', async () => {
    // Eleven characters padded to seventeen with dashes. The dashes are not the code.
    const res = await create({ label: 'intake', code: '1-2-3-4-5-6-7-8-9', maxUses: 30, expiresInDays: 90 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/\b9 characters\b/);
  });

  it('refuses one with no expiry, and says why a chosen code cannot have none', async () => {
    const res = await create({ label: 'intake', code: CHOSEN });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/has to expire/);
    // The argument is disclosure, not guessing, and the refusal makes that argument rather than
    // asserting a rule.
    expect(res.body.error.message).toMatch(/whiteboard/);
    expect(res.body.error.message).toMatch(/up to 365/);
    expect(createEnrollmentCodeRepo(db).list()).toEqual([]);
  });

  it('refuses an expiry past a year for a chosen code while allowing ten for a generated one', async () => {
    const chosen = await create({ label: 'intake', code: CHOSEN, maxUses: 30, expiresInDays: 400 });
    expect(chosen.status).toBe(422);
    expect(chosen.body.error.message).toMatch(/at most 365 days and this one asks for 400/);

    // The generated ceiling is untouched: nothing about this feature makes a 2^100 code weaker.
    const generated = await create({ label: 'intake', expiresInDays: 3650 });
    expect(generated.status).toBe(201);
    expect(generated.body.code.chosen).toBe(false);
  });

  it('refuses a label that repeats the code, because the label is not a secret', async () => {
    const res = await create({
      label: `${CHOSEN} intake`,
      code: CHOSEN,
      maxUses: 30,
      expiresInDays: 90,
    });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/label repeats the code/i);
    expect(res.body.error.message).toMatch(/audit log/);
    // Nothing was written, so the credential is not in the trail by way of the refusal either.
    expect(createEnrollmentCodeRepo(db).list()).toEqual([]);
    expect(JSON.stringify(auditRows())).not.toContain(NORMALIZED);
  });

  /**
   * THE TRAP. Two codes an administrator would swear are different are one code, because the fold
   * that lets a student read `0` as `O` runs on what an administrator types too.
   */
  it('refuses a second code that normalises onto the first, and names which one', async () => {
    const first = await create({
      label: 'W1MX autumn 2026 intake',
      code: CHOSEN,
      maxUses: 30,
      expiresInDays: 90,
    });
    expect(first.status).toBe(201);

    const second = await create({
      label: 'Field Day helpers',
      code: 'WIMX-FA11-2O26',
      maxUses: 30,
      expiresInDays: 90,
    });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
    // Which code it clashes with, so the honest case — one officer, same code twice in a term —
    // is a fact rather than a mystery.
    expect(second.body.error.message).toContain('W1MX autumn 2026 intake');
    // Why two different-looking strings are one code, in the words the preview uses.
    expect(second.body.error.message).toContain('O counts as 0');
    expect(second.body.error.message).toContain(NORMALIZED);
    // And the thing an administrator would otherwise try next, refused in advance.
    expect(second.body.error.message).toMatch(/Revoking the other one does not free the text/);
    expect(createEnrollmentCodeRepo(db).list()).toHaveLength(1);
  });

  it('refuses a collision with a revoked code too, which is the point of saying so', async () => {
    const first = await create({ label: 'last term', code: CHOSEN, maxUses: 30, expiresInDays: 90 });
    await request(buildApp(ADMIN)).post(
      `/api/admin/enrollment-codes/${String(first.body.code.id)}/revoke`,
    );

    const again = await create({ label: 'this term', code: CHOSEN, maxUses: 30, expiresInDays: 90 });
    expect(again.status).toBe(409);
    // Anyone still holding the withdrawn code would be holding the new one, which is exactly what
    // revoking was for.
    expect(again.body.error.message).toMatch(/anyone still holding the old one could use the new/i);
  });

  /**
   * THE ORACLE, AND WHAT IS DONE ABOUT IT.
   *
   * An administrator who guesses a colleague's chosen code learns it from the refusal. That grants
   * no access they do not already have — they can mint an admin account outright — but until this
   * row existed it was SILENT, and a silent way to learn somebody else's credential is the one
   * property worth removing. A miss is already loud, because a miss creates a code.
   */
  it('writes the probe down when a chosen code hits an existing one', async () => {
    const first = await create({ label: 'W1MX autumn 2026 intake', code: CHOSEN, maxUses: 30, expiresInDays: 90 });
    await create({ label: 'guess', code: 'WIMX FA11 2O26', maxUses: 30, expiresInDays: 90 });

    const collisions = auditRows().filter((r) => r.action === 'enrollment_code.collision');
    expect(collisions).toEqual([
      {
        at: NOW,
        actor_user_id: ADMIN.id,
        action: 'enrollment_code.collision',
        entity_type: 'enrollment_code',
        // The code that was probed, so its issuer can revoke it.
        entity_id: first.body.code.id,
        detail: JSON.stringify({ label: 'W1MX autumn 2026 intake' }),
      },
    ]);
    // The row records that somebody asked. It is not a copy of the answer.
    expect(JSON.stringify(collisions)).not.toContain(NORMALIZED);
    expect(JSON.stringify(collisions)).not.toContain(hashEnrollmentCode(CHOSEN));
  });

  it('records the probe once a window, so the trail cannot be flooded to bury itself', async () => {
    await create({ label: 'W1MX autumn 2026 intake', code: CHOSEN, maxUses: 30, expiresInDays: 90 });
    for (let i = 0; i < 20; i += 1) {
      await create({ label: `guess ${String(i)}`, code: CHOSEN, maxUses: 30, expiresInDays: 90 });
    }
    // Twenty probes, one row. `deps.now` is pinned, so every one of them is inside one window.
    expect(auditRows().filter((r) => r.action === 'enrollment_code.collision')).toHaveLength(1);
  });

  it('leaves the generated path exactly as it was', async () => {
    const res = await create({ label: 'Field Day helpers', maxUses: 5 });

    expect(res.status).toBe(201);
    expect(res.body.code.chosen).toBe(false);
    // No expiry required, no floor applied, and the twenty-character shape is unchanged.
    expect(res.body.code.expiresAt).toBeNull();
    expect(res.body.plaintext).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(res.body.normalized).toBe(normalizeEnrollmentCode(res.body.plaintext));
  });

  it('records that a code was chosen, and never the code', async () => {
    const res = await create({ label: 'W1MX autumn intake', code: CHOSEN, maxUses: 30, expiresInDays: 90 });

    expect(auditRows()).toEqual([
      {
        at: NOW,
        actor_user_id: ADMIN.id,
        action: 'enrollment_code.create',
        entity_type: 'enrollment_code',
        entity_id: res.body.code.id,
        detail: JSON.stringify({
          label: 'W1MX autumn intake',
          chosen: true,
          maxUses: 30,
          expiresAt: '2026-11-30T12:00:00.000Z',
        }),
      },
    ]);
    // The same promise the generated path makes, now that the code is a string somebody typed.
    const trail = JSON.stringify(auditRows());
    expect(trail).not.toContain(NORMALIZED);
    expect(trail).not.toContain(CHOSEN);
    expect(trail).not.toContain(hashEnrollmentCode(CHOSEN));
    const stored = JSON.stringify(db.prepare('SELECT * FROM enrollment_codes').all());
    expect(stored).not.toContain(NORMALIZED);
    expect(stored).toContain(hashEnrollmentCode(CHOSEN));
  });

  /**
   * THE ONE LABEL AN ADMINISTRATOR MAY NOT USE, AND WHY IT IS A REFUSAL RATHER THAN A CONVENTION.
   *
   * `auth/envEnrollmentCode.ts` recognises the row set by `ENROLLMENT_CODE` in docker-compose.yml
   * by its label and by nothing else — the table stores a digest, so there is nothing else to
   * recognise it by. A code issued here under that label would be treated as the file's on the
   * next boot and withdrawn, because the file does not name it: an administrator would watch a
   * code they issued switch itself off after a restart, with no trail but a revocation nobody
   * performed.
   */
  it('refuses the label that the compose file code answers to', async () => {
    const res = await create({ label: ENV_CODE_LABEL, code: CHOSEN, maxUses: 30, expiresInDays: 90 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/withdrawn the next time this server started/);
    expect(createEnrollmentCodeRepo(db).list()).toEqual([]);
  });

  it('refuses it however it is cased or padded, since that is how the boot compares it', async () => {
    for (const label of [ENV_CODE_LABEL.toUpperCase(), `  ${ENV_CODE_LABEL.toLowerCase()}  `]) {
      const res = await create({ label, code: null, maxUses: null, expiresInDays: null });
      expect(res.status, label).toBe(422);
    }
  });

  it('does not stand in the way of a label that merely mentions the file', async () => {
    // Containment would be the wrong rule: the identity is exact equality, so anything else is a
    // label an officer is entitled to write.
    const res = await create({ label: 'Codes we set in docker-compose.yml, autumn', code: null, maxUses: null, expiresInDays: null });
    expect(res.status).toBe(201);
  });
  it('refuses a code longer than the paste guard', async () => {
    const res = await create({ label: 'intake', code: 'W1MX'.repeat(40), maxUses: 30, expiresInDays: 90 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('treats a code of nothing but punctuation as too short rather than as no code', async () => {
    // It is a non-empty string, so it is a CHOSEN code — and it normalises to nothing, which is
    // zero characters. Falling through to "generate one" would silently give the administrator a
    // different credential from the one they asked for.
    const res = await create({ label: 'intake', code: '-----', maxUses: 30, expiresInDays: 90 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/\b0 characters\b/);
    expect(createEnrollmentCodeRepo(db).list()).toEqual([]);
  });
});
