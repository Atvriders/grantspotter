import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportBackup, restoreBackup } from '../../exports/json.js';
import { openTestDb } from '../../test/testDb.js';
import {
  createEnrollmentCodeRepo,
  ENROLLMENT_HASH_SCHEME,
  hashEnrollmentCode,
  legacyHashEnrollmentCode,
  LEGACY_ENROLLMENT_HASH_SCHEME,
  newEnrollmentCode,
  normalizeEnrollmentCode,
  type EnrollmentCodeRepo,
} from './enrollmentCodes.js';

const NOW = '2026-09-01T12:00:00.000Z';
const LATER = '2026-09-08T12:00:00.000Z';

let db: Database.Database;
let repo: EnrollmentCodeRepo;
let adminId: string;

/**
 * A user row created with raw SQL rather than through `createUserRepo`, deliberately: this file is
 * about the code table, `users.create` costs an argon2id hash it has no use for, and the only thing
 * the foreign key needs is a real `users.id`.
 */
function insertUser(id: string): string {
  db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
     VALUES (?, ?, ?, 'not-a-real-hash', 'admin', ?, ?)`,
  ).run(id, `${id}@example.org`, `${id}@example.org`, `ics-${id}`, NOW);
  return id;
}

beforeEach(() => {
  db = openTestDb();
  repo = createEnrollmentCodeRepo(db);
  adminId = insertUser('admin-1');
});

afterEach(() => {
  db.close();
});

/**
 * A code that was issued, unwrapped. `create` returns a union because a code an administrator TYPES
 * can collide with one that already exists; every caller of this helper expects to get a code, so
 * the refusal branch throws here rather than being narrowed away at each call site.
 */
function issue(over: Partial<Parameters<EnrollmentCodeRepo['create']>[0]> = {}) {
  const issued = repo.create({
    label: 'W1MX autumn 2026 intake',
    chosen: null,
    maxUses: null,
    expiresAt: null,
    createdByUserId: adminId,
    nowISO: NOW,
    ...over,
  });
  if (!issued.ok) throw new Error('issue(): unexpected collision');
  return issued;
}

describe('the code a person reads', () => {
  it('is drawn from an alphabet with no character that can be misread as another', () => {
    const code = newEnrollmentCode();
    // 20 characters in four dashed groups of five.
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(code.replace(/-/g, '')).toHaveLength(20);
    // The four confusable letters are the whole reason for the alphabet.
    expect(code).not.toMatch(/[ILOU]/);
  });

  it('is different every time, from the CSPRNG', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newEnrollmentCode()));
    expect(seen.size).toBe(200);
  });

  it('forgives every way a person can retype it wrongly', () => {
    const canonical = normalizeEnrollmentCode('K7QF2-9XMPT-3RJVH-8WCND');
    expect(canonical).toBe('K7QF29XMPT3RJVH8WCND');

    for (const variant of [
      'k7qf2-9xmpt-3rjvh-8wcnd', // lower case
      'K7QF29XMPT3RJVH8WCND', // no dashes
      ' K7QF2 9XMPT 3RJVH 8WCND ', // spaces instead
      'K7QF2-9XMPT-3RJVH-8WCND\n', // pasted out of an email
    ]) {
      expect(normalizeEnrollmentCode(variant)).toBe(canonical);
      expect(hashEnrollmentCode(variant)).toBe(hashEnrollmentCode('K7QF2-9XMPT-3RJVH-8WCND'));
    }
  });

  it('folds the letters that were removed back onto the digits they look like', () => {
    // Someone reading `0` off a whiteboard writes `O`; someone reading `1` writes `l` or `I`.
    expect(normalizeEnrollmentCode('O1IL')).toBe('0111');
    expect(hashEnrollmentCode('0111')).toBe(hashEnrollmentCode('o1il'));
  });

  it('is not a code at all once nothing recognisable is left', () => {
    expect(normalizeEnrollmentCode('----')).toBe('');
    expect(normalizeEnrollmentCode('!!! ??')).toBe('');
  });
});

describe('issuing a code', () => {
  it('returns the plaintext exactly once and never stores it', () => {
    const { code, plaintext } = issue({ maxUses: 30, expiresAt: LATER });

    expect(plaintext).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(code).toEqual({
      id: expect.any(String),
      label: 'W1MX autumn 2026 intake',
      chosen: false,
      maxUses: 30,
      uses: 0,
      expiresAt: LATER,
      revokedAt: null,
      createdAt: NOW,
      createdByUserId: adminId,
      lastUsedAt: null,
    });

    // THE WHOLE ROW, every column, as text: the code is in none of it. Asserting on the columns
    // this repository happens to select would miss a column somebody adds later.
    const raw = JSON.stringify(db.prepare('SELECT * FROM enrollment_codes').all());
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toContain(normalizeEnrollmentCode(plaintext));
    expect(raw).toContain(hashEnrollmentCode(plaintext));

    // And nothing this module returns can get it back.
    expect(JSON.stringify(repo.list())).not.toContain(normalizeEnrollmentCode(plaintext));
    expect(JSON.stringify(repo.findById(code.id))).not.toContain(normalizeEnrollmentCode(plaintext));
  });

  it('refuses a limit of zero at the database, not merely in the API', () => {
    expect(() => issue({ maxUses: 0 })).toThrow(/CHECK constraint failed/);
  });

  it('lists in issue order and reads back what it wrote', () => {
    const first = issue({ label: 'first', nowISO: '2026-09-01T00:00:00.000Z' });
    const second = issue({ label: 'second', nowISO: '2026-09-02T00:00:00.000Z' });
    expect(repo.list().map((c) => c.label)).toEqual(['first', 'second']);
    expect(repo.findById(second.code.id)?.label).toBe('second');
    expect(repo.findById(first.code.id)?.id).toBe(first.code.id);
    expect(repo.findById('no-such-id')).toBeUndefined();
  });

  /**
   * The claim `exports/json.ts` makes when it puts this table in `BACKUP_TABLES`, made executable.
   *
   * An operator restoring a backup in the middle of an intake must not silently invalidate the
   * codes their club has already handed out — thirty students each told "that enrollment code is
   * not valid", with nothing on either side of the screen to explain it. Revocation and expiry are
   * what end a code; a restore is not.
   */
  it('survives a backup and restore, code and all', () => {
    const { code, plaintext } = issue({ maxUses: 30 });
    const backup = exportBackup(db, NOW);

    db.prepare('DELETE FROM enrollment_codes').run();
    expect(repo.list()).toEqual([]);

    restoreBackup(db, JSON.parse(JSON.stringify(backup)) as typeof backup);

    expect(repo.findById(code.id)).toEqual(code);
    // The code a student is holding still works — which is only true because the digest travelled.
    expect(repo.redeem({ plaintext, nowISO: LATER }, () => 'ok').ok).toBe(true);
  });

  it('dies with the administrator who issued it', () => {
    issue();
    expect(repo.list()).toHaveLength(1);
    // A live credential must not outlive the account that owns it — the same rule
    // `090-ics-tokens.sql` was corrected to follow, enforced here by the cascade.
    db.prepare('DELETE FROM users WHERE id = ?').run(adminId);
    expect(repo.list()).toEqual([]);
  });
});

/**
 * A CODE SOMEBODY TYPED. The repository stores a digest either way; what changes is that the input
 * is now a string a person chose, which means it can already be taken.
 *
 * Nothing about the FLOOR or the EXPIRY is tested here, because none of it lives here: this module
 * will faithfully store the digest of `A` if `api/enrollment.ts` asks it to, and the argument for
 * why it must not be asked is in that file next to the sentence an administrator reads.
 */
describe('a code the caller supplied', () => {
  const CHOSEN = 'W1MX-FALL-2026';

  it('stores the chosen code and marks the row as chosen', () => {
    const issued = repo.create({
      label: 'W1MX autumn 2026 intake',
      chosen: CHOSEN,
      maxUses: null,
      expiresAt: LATER,
      createdByUserId: adminId,
      nowISO: NOW,
    });
    if (!issued.ok) throw new Error('expected the first chosen code to be issued');

    expect(issued.code.chosen).toBe(true);
    expect(issued.plaintext).toBe(CHOSEN);
    expect(issued.normalized).toBe('W1MXFA112026');
    expect(repo.findById(issued.code.id)?.chosen).toBe(true);

    // The same promise as the generated path: the digest is stored and the code is not.
    const raw = JSON.stringify(db.prepare('SELECT * FROM enrollment_codes').all());
    expect(raw).not.toContain(CHOSEN);
    expect(raw).not.toContain('W1MXFA112026');
    expect(raw).toContain(hashEnrollmentCode(CHOSEN));
  });

  it('is redeemed by any spelling that folds onto it', () => {
    repo.create({
      label: 'intake',
      chosen: CHOSEN,
      maxUses: null,
      expiresAt: null,
      createdByUserId: adminId,
      nowISO: NOW,
    });
    expect(repo.redeem({ plaintext: 'wimx fa11 2o26', nowISO: NOW }, () => 'ok').ok).toBe(true);
  });

  /**
   * THE COLLISION, AT THE LEVEL THAT HAS TO REFUSE IT. `code_hash` is UNIQUE, so the alternative to
   * this branch is a thrown SQLite constraint error and a 500 on a request where the administrator
   * did nothing wrong.
   */
  it('refuses a second code that folds onto the first, and names the one it clashes with', () => {
    const first = repo.create({
      label: 'W1MX autumn 2026 intake',
      chosen: CHOSEN,
      maxUses: null,
      expiresAt: null,
      createdByUserId: adminId,
      nowISO: NOW,
    });
    if (!first.ok) throw new Error('expected the first chosen code to be issued');

    const second = repo.create({
      label: 'Field Day helpers',
      // Not one character of this is the same as `CHOSEN`, and it is the same code.
      chosen: 'wimx-fa11-2o26',
      maxUses: null,
      expiresAt: null,
      createdByUserId: adminId,
      nowISO: LATER,
    });

    expect(second).toEqual({
      ok: false,
      conflict: { id: first.code.id, label: 'W1MX autumn 2026 intake' },
    });
    // Refused means nothing was written: not a row, and not a use of the id it would have had.
    expect(repo.list()).toHaveLength(1);
  });

  it('refuses a collision with a revoked code, because revoking does not free the text', () => {
    const first = repo.create({
      label: 'last term',
      chosen: CHOSEN,
      maxUses: null,
      expiresAt: null,
      createdByUserId: adminId,
      nowISO: NOW,
    });
    if (!first.ok) throw new Error('expected the first chosen code to be issued');
    repo.revoke(first.code.id, NOW);

    const again = repo.create({
      label: 'this term',
      chosen: CHOSEN,
      maxUses: null,
      expiresAt: null,
      createdByUserId: adminId,
      nowISO: LATER,
    });
    expect(again.ok).toBe(false);
  });

  it('does not confuse a chosen code with a generated one that happens to be issued beside it', () => {
    repo.create({
      label: 'chosen',
      chosen: CHOSEN,
      maxUses: null,
      expiresAt: null,
      createdByUserId: adminId,
      nowISO: NOW,
    });
    // A later instant, not the same one: `list()` orders by `created_at` and breaks ties on a
    // random UUID, so two codes issued at the identical timestamp come back in either order.
    issue({ label: 'generated', nowISO: LATER });

    expect(repo.list().map((c) => [c.label, c.chosen])).toEqual([
      ['chosen', true],
      ['generated', false],
    ]);
  });

  it('carries `chosen` through a backup and a restore', () => {
    repo.create({
      label: 'chosen',
      chosen: CHOSEN,
      maxUses: null,
      expiresAt: null,
      createdByUserId: adminId,
      nowISO: NOW,
    });
    const backup = exportBackup(db, NOW);
    db.prepare('DELETE FROM enrollment_codes').run();
    restoreBackup(db, JSON.parse(JSON.stringify(backup)) as typeof backup);

    // An operator who restores must not be told every code on the instance was generated — that is
    // the reassuring answer rather than the true one, and it is the one they would act on.
    expect(repo.list().map((c) => c.chosen)).toEqual([true]);
  });

  /**
   * A backup written before migration 092 has no `chosen` key at all. `exports/json.ts` inserts
   * only the columns a row carries, so the column default decides — and every code that existed
   * before this feature really was generated, because there was no way to supply one.
   */
  it('reads a code restored from a backup that predates the column as generated', () => {
    const { code } = issue({ label: 'from an old backup' });
    const backup = exportBackup(db, NOW);
    for (const row of backup.tables.enrollment_codes ?? []) delete row.chosen;

    db.prepare('DELETE FROM enrollment_codes').run();
    restoreBackup(db, JSON.parse(JSON.stringify(backup)) as typeof backup);

    expect(repo.findById(code.id)?.chosen).toBe(false);
  });

  /**
   * The column is a boolean SQLite has no type for, so migration 092 spends a CHECK on it. Without
   * one, a hand-edited or badly restored row holding 2 would read as `chosen: false` — a code the
   * console would present as unguessable when it is not, which is the wrong direction to be wrong.
   */
  it('refuses a value that is neither chosen nor generated, at the database', () => {
    const { code } = issue();
    expect(() =>
      db.prepare('UPDATE enrollment_codes SET chosen = 2 WHERE id = ?').run(code.id),
    ).toThrow(/CHECK constraint failed/);
  });
});

/**
 * WHAT A STOLEN DATABASE IS WORTH.
 *
 * Until migration 093 the answer was "every code an officer chose", and it was not a theory:
 * `W1MX-AUTUMN-2026` was recovered from its stored digest on this host in 32.4 s and 11,334,277
 * dictionary candidates, using the product's own hash function. These tests hold the property that
 * replaced it — the digest is a MAC under a key that is not in the file — and the price that
 * property has, which is that the key is `SESSION_SECRET` and the codes go with it.
 */
describe('the digest a stolen database hands over', () => {
  const CHOSEN = 'W1MX-AUTUMN-2026';
  const SECRET = 'a-test-session-secret-32-chars-min';
  const OTHER_SECRET = 'a-different-test-session-secret-32';

  let before: string | undefined;
  beforeEach(() => {
    before = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = before;
  });

  /** The dictionary attack, refused. Everything an attacker holds is here except the key. */
  it('is not the digest a dictionary can attack', () => {
    const issued = repo.create({
      label: 'autumn intake',
      chosen: CHOSEN,
      maxUses: null,
      expiresAt: LATER,
      createdByUserId: adminId,
      nowISO: NOW,
    });
    if (!issued.ok) throw new Error('expected the chosen code to be issued');

    const raw = JSON.stringify(db.prepare('SELECT * FROM enrollment_codes').all());
    // The whole row as text: not the code, not its normalised form, and — the new part — not the
    // unkeyed digest an attacker can compute from a guess.
    expect(raw).not.toContain(CHOSEN);
    expect(raw).not.toContain('W1MXATMN2026');
    expect(raw).not.toContain(legacyHashEnrollmentCode(CHOSEN));
    expect(raw).toContain(hashEnrollmentCode(CHOSEN));
    expect(hashEnrollmentCode(CHOSEN)).not.toBe(legacyHashEnrollmentCode(CHOSEN));
  });

  it('records which function made it, so a legacy row can be told apart', () => {
    const { code } = issue();
    const stored = db
      .prepare('SELECT hash_scheme FROM enrollment_codes WHERE id = ?')
      .get(code.id) as { hash_scheme: string };
    expect(stored.hash_scheme).toBe(ENROLLMENT_HASH_SCHEME);
    expect(ENROLLMENT_HASH_SCHEME).not.toBe(LEGACY_ENROLLMENT_HASH_SCHEME);
  });

  it('depends on the secret, which is what makes the file alone useless', () => {
    const underOne = hashEnrollmentCode(CHOSEN);
    process.env.SESSION_SECRET = OTHER_SECRET;
    expect(hashEnrollmentCode(CHOSEN)).not.toBe(underOne);
    // …and the derivation is stable, so the same secret always reads the same code.
    process.env.SESSION_SECRET = SECRET;
    expect(hashEnrollmentCode(CHOSEN)).toBe(underOne);
  });

  /**
   * THE PRICE, STATED AS A TEST RATHER THAN AS A WARNING. An operator who rotates `SESSION_SECRET`
   * — or restores this data onto a host that generated its own — keeps every row and loses every
   * code. That is the trade migration 093 makes, and it is worth having a test fail if somebody
   * ever decides quietly that it should not be true.
   */
  it('stops redeeming when the secret changes, and loses nothing else', () => {
    const { code, plaintext } = issue({ label: 'mid-intake', maxUses: 30 });
    expect(repo.redeem({ plaintext, nowISO: NOW }, () => 'ok').ok).toBe(true);

    process.env.SESSION_SECRET = OTHER_SECRET;
    expect(repo.redeem({ plaintext, nowISO: NOW }, () => 'ok')).toEqual({
      ok: false,
      refusal: 'unknown',
    });
    // The record is all still there: the administrator can see it, revoke it and issue its
    // replacement. What is gone is the credential, not the row.
    expect(repo.findById(code.id)).toMatchObject({ label: 'mid-intake', uses: 1, maxUses: 30 });
  });
});

/**
 * THE UPGRADE, FROM THE ONLY POSITION THAT MATTERS: a club that is mid-intake when it happens.
 *
 * Nothing can re-hash an existing row — the plaintext went to the administrator once and is gone —
 * so the rows already in the table keep their unkeyed digest and are read under both.
 */
describe('a code issued before the digest was keyed', () => {
  const LEGACY_PLAINTEXT = 'K7QF2-9XMPT-3RJVH-8WCND';

  /** A pre-093 row, written the way the old code wrote it: unkeyed digest, legacy scheme. */
  function insertLegacyRow(id: string, label: string): void {
    db.prepare(
      `INSERT INTO enrollment_codes (id, code_hash, hash_scheme, label, chosen, max_uses, uses,
         expires_at, revoked_at, created_at, created_by_user_id, last_used_at)
       VALUES (?, ?, ?, ?, 0, NULL, 0, NULL, NULL, ?, ?, NULL)`,
    ).run(
      id,
      legacyHashEnrollmentCode(LEGACY_PLAINTEXT),
      LEGACY_ENROLLMENT_HASH_SCHEME,
      label,
      NOW,
      adminId,
    );
  }

  it('is still redeemed after the upgrade, however the holder typed it', () => {
    insertLegacyRow('legacy-1', 'last term');
    expect(repo.inspect(LEGACY_PLAINTEXT, NOW)).toEqual({ ok: true, id: 'legacy-1', label: 'last term' });
    expect(repo.redeem({ plaintext: 'k7qf2 9xmpt 3rjvh 8wcnd', nowISO: NOW }, () => 'ok').ok).toBe(
      true,
    );
    expect(repo.findById('legacy-1')?.uses).toBe(1);
  });

  it('is still revoked, expired and exhausted by the same rules', () => {
    insertLegacyRow('legacy-2', 'withdrawn');
    repo.revoke('legacy-2', NOW);
    expect(repo.redeem({ plaintext: LEGACY_PLAINTEXT, nowISO: LATER }, () => 1)).toEqual({
      ok: false,
      refusal: 'revoked',
    });
  });

  /**
   * THE COLLISION THE SECOND DIGEST EXISTS TO CATCH. A chosen code hashes to the keyed digest and a
   * pre-093 row holds the unkeyed one, so a create that checked only its own reading would insert a
   * SECOND row for a plaintext this deployment has already issued — two rows, one code, and only
   * one of them ever findable again.
   */
  it('cannot be shadowed by a new code that is the same code', () => {
    insertLegacyRow('legacy-3', 'the one already out there');
    const again = repo.create({
      label: 'this term',
      chosen: LEGACY_PLAINTEXT,
      maxUses: null,
      expiresAt: LATER,
      createdByUserId: adminId,
      nowISO: LATER,
    });
    expect(again).toEqual({
      ok: false,
      conflict: { id: 'legacy-3', label: 'the one already out there' },
    });
    expect(repo.list()).toHaveLength(1);
  });

  /** Nothing writes the old scheme any more: the two live side by side, they do not multiply. */
  it('is the only kind of row that carries the unkeyed scheme', () => {
    insertLegacyRow('legacy-4', 'last term');
    issue({ label: 'this term', nowISO: LATER });
    repo.create({
      label: 'chosen this term',
      chosen: 'W1MX-AUTUMN-2026',
      maxUses: null,
      expiresAt: LATER,
      createdByUserId: adminId,
      nowISO: LATER,
    });

    const rows = db
      .prepare('SELECT label, hash_scheme FROM enrollment_codes ORDER BY created_at, label')
      .all() as Array<{ label: string; hash_scheme: string }>;
    expect(rows).toEqual([
      { label: 'last term', hash_scheme: LEGACY_ENROLLMENT_HASH_SCHEME },
      { label: 'chosen this term', hash_scheme: ENROLLMENT_HASH_SCHEME },
      { label: 'this term', hash_scheme: ENROLLMENT_HASH_SCHEME },
    ]);
  });

  it('refuses a scheme the schema has never heard of, at the database', () => {
    insertLegacyRow('legacy-5', 'last term');
    expect(() =>
      db.prepare("UPDATE enrollment_codes SET hash_scheme = 'md5' WHERE id = 'legacy-5'").run(),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('revoking a code', () => {
  it('stamps the first revocation and never moves it', () => {
    const { code } = issue();
    const revoked = repo.revoke(code.id, NOW);
    expect(revoked?.revokedAt).toBe(NOW);

    const again = repo.revoke(code.id, LATER);
    expect(again?.revokedAt).toBe(NOW);
  });

  it('answers undefined for a code that does not exist', () => {
    expect(repo.revoke('no-such-id', NOW)).toBeUndefined();
  });
});

describe('redeeming a code', () => {
  it('spends a use, stamps it, and runs the caller inside the same transaction', () => {
    const { code, plaintext } = issue({ maxUses: 2 });

    const outcome = repo.redeem({ plaintext, nowISO: LATER }, (redeemed) => {
      // The caller is handed the record AS IT NOW STANDS: the use it is spending is counted.
      expect(redeemed.uses).toBe(1);
      expect(redeemed.lastUsedAt).toBe(LATER);
      return 'the account';
    });

    expect(outcome).toEqual({
      ok: true,
      account: 'the account',
      code: expect.objectContaining({ id: code.id, uses: 1, lastUsedAt: LATER }),
    });
    expect(repo.findById(code.id)?.uses).toBe(1);
  });

  it('accepts the code however the holder typed it', () => {
    const { plaintext } = issue();
    const typed = plaintext.toLowerCase().replace(/-/g, ' ');
    expect(repo.redeem({ plaintext: typed, nowISO: NOW }, () => 1).ok).toBe(true);
  });

  it.each([
    ['an unknown code', () => 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', 'unknown'],
    ['an empty code', () => '', 'unknown'],
    ['a code that is only punctuation', () => '-----', 'unknown'],
  ])('refuses %s', (_label, plaintext, refusal) => {
    issue();
    expect(repo.redeem({ plaintext: plaintext(), nowISO: NOW }, () => 1)).toEqual({
      ok: false,
      refusal,
    });
  });

  it('refuses a revoked, an expired and an exhausted code, and says which', () => {
    const revoked = issue({ label: 'revoked' });
    repo.revoke(revoked.code.id, NOW);
    expect(repo.redeem({ plaintext: revoked.plaintext, nowISO: LATER }, () => 1)).toEqual({
      ok: false,
      refusal: 'revoked',
    });

    const expired = issue({ label: 'expired', expiresAt: NOW });
    // AT the expiry instant, not merely after it.
    expect(repo.redeem({ plaintext: expired.plaintext, nowISO: NOW }, () => 1)).toEqual({
      ok: false,
      refusal: 'expired',
    });

    const exhausted = issue({ label: 'exhausted', maxUses: 1 });
    expect(repo.redeem({ plaintext: exhausted.plaintext, nowISO: NOW }, () => 1).ok).toBe(true);
    expect(repo.redeem({ plaintext: exhausted.plaintext, nowISO: NOW }, () => 1)).toEqual({
      ok: false,
      refusal: 'exhausted',
    });
    expect(repo.findById(exhausted.code.id)?.uses).toBe(1);
  });

  it('reports revocation ahead of expiry ahead of exhaustion', () => {
    // All three are true of this code at once. The holder needs the fact they can act on, and
    // "an administrator withdrew it" outranks "it ran out".
    const { code, plaintext } = issue({ maxUses: 1, expiresAt: NOW });
    db.prepare('UPDATE enrollment_codes SET uses = 1, revoked_at = ? WHERE id = ?').run(NOW, code.id);
    expect(repo.redeem({ plaintext, nowISO: LATER }, () => 1)).toEqual({
      ok: false,
      refusal: 'revoked',
    });

    db.prepare('UPDATE enrollment_codes SET revoked_at = NULL WHERE id = ?').run(code.id);
    expect(repo.redeem({ plaintext, nowISO: LATER }, () => 1)).toEqual({
      ok: false,
      refusal: 'expired',
    });
  });

  it('spends nothing when the caller throws', () => {
    const { code, plaintext } = issue({ maxUses: 1 });

    expect(() =>
      repo.redeem({ plaintext, nowISO: NOW }, () => {
        throw new Error('that address already has an account');
      }),
    ).toThrow(/already has an account/);

    // The use is not spent, the timestamp is not written, and the code still works. Somebody who
    // mistypes an email must not burn one of their club's places.
    expect(repo.findById(code.id)).toMatchObject({ uses: 0, lastUsedAt: null });
    expect(repo.redeem({ plaintext, nowISO: NOW }, () => 'ok').ok).toBe(true);
  });

  it('runs out exactly at the limit however many times it is asked', () => {
    const { code, plaintext } = issue({ maxUses: 3 });
    const results = Array.from({ length: 10 }, () =>
      repo.redeem({ plaintext, nowISO: NOW }, () => 1),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.refusal === 'exhausted')).toHaveLength(7);
    expect(repo.findById(code.id)?.uses).toBe(3);
  });
});

describe('whether the door is open at all', () => {
  it('is false with no codes, and with only codes nobody could redeem', () => {
    expect(repo.anyOpen(NOW)).toBe(false);

    const revoked = issue({ label: 'revoked' });
    repo.revoke(revoked.code.id, NOW);
    issue({ label: 'expired', expiresAt: NOW });
    const exhausted = issue({ label: 'exhausted', maxUses: 1 });
    repo.redeem({ plaintext: exhausted.plaintext, nowISO: NOW }, () => 1);

    expect(repo.anyOpen(NOW)).toBe(false);
  });

  it('is true as soon as one code could be redeemed, and says nothing else', () => {
    issue({ label: 'live', maxUses: 30, expiresAt: LATER });
    expect(repo.anyOpen(NOW)).toBe(true);
    // …and false again once it has run out, at the same instant the redemption would fail.
    expect(repo.anyOpen(LATER)).toBe(false);
  });
});
