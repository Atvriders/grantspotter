import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportBackup, restoreBackup } from '../../exports/json.js';
import { openTestDb } from '../../test/testDb.js';
import {
  createEnrollmentCodeRepo,
  hashEnrollmentCode,
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

function issue(over: Partial<Parameters<EnrollmentCodeRepo['create']>[0]> = {}) {
  return repo.create({
    label: 'W1MX autumn 2026 intake',
    maxUses: null,
    expiresAt: null,
    createdByUserId: adminId,
    nowISO: NOW,
    ...over,
  });
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
