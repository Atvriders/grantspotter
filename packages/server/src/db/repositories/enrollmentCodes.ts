import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { EnrollmentCode } from '@grantspotter/core';
import type { Db } from '../migrate.js';

/**
 * THE ALPHABET A CODE IS WRITTEN IN, AND WHY IT IS NOT BASE64URL.
 *
 * `adminUsersRouter.generatePassword` uses `randomBytes(18).toString('base64url')`, and that is
 * right for what it is: a password, pasted from a screen into a password manager, seen by two
 * people. An enrollment code is a different object with a different life. It is read out at a club
 * meeting, written on a whiteboard, printed at the bottom of a flyer and typed into a phone by
 * someone standing up — so a case-sensitive alphabet containing `l`, `I`, `O` and `0` turns every
 * one of those journeys into a support conversation.
 *
 * This is Crockford's base32 alphabet: the ten digits and the twenty-two consonants and vowels left
 * after removing `I`, `L`, `O` and `U`. The first three are removed because they are the shapes
 * that get confused with `1` and `0`, and `U` because dropping it is what keeps a random 20
 * characters from spelling something an officer would not want to read out. `normalizeEnrollmentCode`
 * then FOLDS the removed letters back in rather than rejecting them, so a person who writes down
 * the `0` they saw as an `O` is not punished for it.
 *
 * 32^20 is 2^100. That is not a password — nothing about it is human-chosen — and it is far past
 * the point where guessing is the attack; the rate limiter on the redemption route is what makes
 * that entropy mean something operationally, because a code is guessable ONLY by trying.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 20;
const GROUP_SIZE = 5;

/**
 * A fresh code, in the form a person reads: `K7QF2-9XMPT-3RJVH-8WCND`.
 *
 * `randomBytes` (the CSPRNG, never `Math.random`), and `byte % 32` is UNIFORM here rather than
 * approximately uniform: 256 is an exact multiple of 32, so every alphabet index is produced by
 * exactly eight of the 256 byte values. The same expression with a 26- or 62-character alphabet
 * would be biased, which is why the alphabet size is a power of two and not a matter of taste.
 *
 * The dashes are presentation only — `normalizeEnrollmentCode` removes them — so a code typed
 * without them, or with spaces instead, is the same code.
 */
export function newEnrollmentCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    if (i > 0 && i % GROUP_SIZE === 0) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * The one form a code is ever hashed in.
 *
 * Case is folded, the transcription confusions are folded (`O`→`0`, `I`/`L`→`1`), and everything
 * that is not in the alphabet — the dashes this module writes, the spaces a person types, the
 * newline an email client wrapped in — is dropped. It runs on BOTH sides: the code is normalised
 * before its digest is stored and before a candidate's digest is compared, so the two can never
 * disagree about what the code was.
 *
 * Dropping unknown characters rather than rejecting them is deliberate. The alternative is a
 * validation error that says "that is not a valid code" for a trailing space, which is both useless
 * to the person and a second answer an attacker could tell apart from "wrong code".
 */
export function normalizeEnrollmentCode(raw: string): string {
  const CONFUSABLE: Record<string, string> = { O: '0', I: '1', L: '1' };
  let out = '';
  for (const character of raw.toUpperCase()) {
    const folded = CONFUSABLE[character] ?? character;
    if (ALPHABET.includes(folded)) out += folded;
  }
  return out;
}

/**
 * Only this digest is persisted, so a copy of the database is not a pile of working credentials.
 *
 * Unsalted SHA-256, exactly as `exports/token.ts` does for an ICS token and for the same reason:
 * the input is 100 bits of randomness this process generated, so there is no dictionary and nothing
 * to precompute, and a work factor would buy nothing while making every redemption attempt cost the
 * server real time — which is the wrong lever, since the rate limiter is the one that binds.
 */
export function hashEnrollmentCode(raw: string): string {
  return createHash('sha256').update(normalizeEnrollmentCode(raw), 'utf8').digest('hex');
}

/**
 * Why a code was refused. Four values, and the distinction between the first and the other three is
 * the whole of this module's disclosure policy.
 *
 * `unknown` is the answer to every code this deployment has never issued AND to every code that was
 * mistyped — they are indistinguishable to us and must stay indistinguishable to the caller, or the
 * route becomes an oracle that says "yes, such a code exists, keep going". The other three are only
 * ever reached by someone holding a code this deployment really did issue, so telling them which of
 * the three it is reveals nothing about any OTHER code — not whether one exists, not how many, not
 * who holds one — and is the difference between a person emailing their club officer and a person
 * concluding the product is broken.
 */
export type EnrollmentRefusal = 'unknown' | 'revoked' | 'expired' | 'exhausted';

/** What one redemption attempt did. `account` is whatever the caller's `createAccount` returned. */
export type Redemption<T> =
  | { ok: true; code: EnrollmentCode; account: T }
  | { ok: false; refusal: EnrollmentRefusal };

/**
 * What the caller does with the use it just won, run inside the redemption transaction.
 *
 * It is handed the code AS IT NOW STANDS — the use it is spending is already counted in
 * `code.uses` — so a caller that writes an audit row can name the code and its label without a
 * second query, and without any of it landing outside the transaction that spent the use.
 *
 * MUST BE SYNCHRONOUS. Returning a promise would hand the event loop back mid-transaction, which
 * is the exact defect this whole module is shaped to prevent; better-sqlite3 will not await it and
 * the transaction would commit around an unfinished write.
 */
export type CreateAccount<T> = (code: EnrollmentCode) => T;

export interface CreateEnrollmentCodeInput {
  label: string;
  maxUses: number | null;
  /** ISO, or null for a code that never expires. */
  expiresAt: string | null;
  createdByUserId: string;
  nowISO: string;
}

export interface EnrollmentCodeRepo {
  /** The plaintext is returned HERE AND NOWHERE ELSE — nothing can recover it afterwards. */
  create(input: CreateEnrollmentCodeInput): { code: EnrollmentCode; plaintext: string };
  list(): EnrollmentCode[];
  findById(id: string): EnrollmentCode | undefined;
  /** Idempotent: a second revoke returns the code with the FIRST revocation's timestamp. */
  revoke(id: string, nowISO: string): EnrollmentCode | undefined;
  /** Is there at least one code a person could redeem right now? Never says which, or how many. */
  anyOpen(nowISO: string): boolean;
  /**
   * Which code this is, if it is one that could be redeemed at `nowISO` — and `undefined` for
   * every code that could not, whether because it was never issued, was revoked, expired or ran
   * out. READ-ONLY: it spends nothing, writes nothing, and its answer is stale the instant it
   * returns, which is why `redeem` re-tests every one of these conditions in the write itself and
   * remains the only thing that decides who gets a place.
   *
   * IT EXISTS FOR ONE CALLER AND ONE REASON. `api/auth.ts` has to decide whether to tell somebody
   * that their address already has an account, and that answer is rationed per code — so it needs
   * to know WHICH code is asking before it does the expensive part of the work, in the same
   * synchronous stretch as the rationing, or the rationing has an `await` in the middle of it and
   * is the very defect it was added to close. Nothing here may be used to answer a caller about
   * the code itself: `redeem`'s refusal messages are the only thing that describes a code to the
   * person holding it.
   */
  redeemableNow(plaintext: string, nowISO: string): { id: string; label: string } | undefined;
  redeem<T>(
    input: { plaintext: string; nowISO: string },
    createAccount: CreateAccount<T>,
  ): Redemption<T>;
}

interface CodeRow {
  id: string;
  label: string;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  created_by_user_id: string;
  last_used_at: string | null;
}

/** `code_hash` is deliberately absent: nothing outside this file has any use for the digest. */
const COLUMNS =
  'id, label, max_uses, uses, expires_at, revoked_at, created_at, created_by_user_id, last_used_at';

function toCode(row: CodeRow): EnrollmentCode {
  return {
    id: row.id,
    label: row.label,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Why this row cannot be redeemed at `nowISO`, or undefined if it can.
 *
 * Order matters and is not alphabetical. Revocation is a deliberate act by an administrator and
 * outranks everything: a code that was revoked AND has expired should say it was withdrawn, because
 * that is the fact the holder needs to act on. Expiry outranks exhaustion for the same reason — an
 * expired code will not come back by waiting, whereas "exhausted" invites "ask for one more use".
 *
 * The comparisons are lexicographic on ISO-8601 strings, which is exact rather than lucky: every
 * timestamp in this table is written by `toISOString()` (via the injected `now`), so all of them are
 * the same fixed-width UTC format and string order IS chronological order.
 */
function refusalFor(row: CodeRow, nowISO: string): EnrollmentRefusal | undefined {
  if (row.revoked_at !== null) return 'revoked';
  // `> nowISO`, not `>=`: a code stops working AT its expiry instant, not one millisecond after.
  if (row.expires_at !== null && row.expires_at <= nowISO) return 'expired';
  if (row.max_uses !== null && row.uses >= row.max_uses) return 'exhausted';
  return undefined;
}

export function createEnrollmentCodeRepo(db: Db): EnrollmentCodeRepo {
  const insertStmt = db.prepare(
    `INSERT INTO enrollment_codes (id, code_hash, label, max_uses, uses, expires_at, revoked_at,
       created_at, created_by_user_id, last_used_at)
     VALUES (@id, @code_hash, @label, @max_uses, 0, @expires_at, NULL, @created_at,
       @created_by_user_id, NULL)`,
  );
  const byHashStmt = db.prepare(`SELECT ${COLUMNS} FROM enrollment_codes WHERE code_hash = ?`);
  const byIdStmt = db.prepare(`SELECT ${COLUMNS} FROM enrollment_codes WHERE id = ?`);
  const listStmt = db.prepare(`SELECT ${COLUMNS} FROM enrollment_codes ORDER BY created_at, id`);
  const revokeStmt = db.prepare(
    'UPDATE enrollment_codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  );
  const anyOpenStmt = db.prepare(
    `SELECT 1 AS ok FROM enrollment_codes
      WHERE revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND (max_uses IS NULL OR uses < max_uses)
      LIMIT 1`,
  );

  /**
   * THE STATEMENT THAT MAKES A SINGLE-USE CODE SINGLE-USE.
   *
   * Every condition that bounds a code is repeated HERE, in the WHERE clause of the write, and not
   * only in the read above it. That repetition is the entire mechanism: `uses = uses + 1` and
   * `uses < max_uses` are evaluated by SQLite in one statement against one snapshot of the row, so
   * two attempts on a one-use code cannot both see `uses = 0`. `changes` is then the answer to
   * "did I get it?", and the caller must believe `changes` rather than the SELECT it did first.
   *
   * A version of this that read the row, decided, and then wrote `uses = ?` with a number computed
   * in JavaScript would be correct in every test that ran the attempts one after another and wrong
   * the first time two people pressed the button together. That is not hypothetical here: this
   * project shipped exactly that shape in the callsign lookup, where a check and its act had an
   * `await` between them and eight concurrent presses all passed a limit meant to allow one.
   */
  const consumeStmt = db.prepare(
    `UPDATE enrollment_codes
        SET uses = uses + 1, last_used_at = @now
      WHERE id = @id
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > @now)
        AND (max_uses IS NULL OR uses < max_uses)`,
  );

  return {
    create(input) {
      const plaintext = newEnrollmentCode();
      const row = {
        id: randomUUID(),
        code_hash: hashEnrollmentCode(plaintext),
        label: input.label,
        max_uses: input.maxUses,
        expires_at: input.expiresAt,
        created_at: input.nowISO,
        created_by_user_id: input.createdByUserId,
      };
      insertStmt.run(row);
      return {
        code: {
          id: row.id,
          label: row.label,
          maxUses: row.max_uses,
          uses: 0,
          expiresAt: row.expires_at,
          revokedAt: null,
          createdAt: row.created_at,
          createdByUserId: row.created_by_user_id,
          lastUsedAt: null,
        },
        // The one and only time this value exists outside the caller's own memory.
        plaintext,
      };
    },

    list() {
      return (listStmt.all() as CodeRow[]).map(toCode);
    },

    findById(id) {
      const row = byIdStmt.get(id) as CodeRow | undefined;
      return row === undefined ? undefined : toCode(row);
    },

    revoke(id, nowISO) {
      // `AND revoked_at IS NULL` in the statement, so a second revoke changes nothing rather than
      // rewriting when the first one happened — the timestamp is evidence, and an admin pressing a
      // button twice must not be able to move it.
      revokeStmt.run(nowISO, id);
      const row = byIdStmt.get(id) as CodeRow | undefined;
      return row === undefined ? undefined : toCode(row);
    },

    anyOpen(nowISO) {
      return anyOpenStmt.get(nowISO) !== undefined;
    },

    redeemableNow(plaintext, nowISO) {
      if (normalizeEnrollmentCode(plaintext) === '') return undefined;
      const row = byHashStmt.get(hashEnrollmentCode(plaintext)) as CodeRow | undefined;
      if (row === undefined) return undefined;
      // The same four conditions `redeem` reads, from the same function, so the two can never
      // disagree about what "could be redeemed" means.
      if (refusalFor(row, nowISO) !== undefined) return undefined;
      return { id: row.id, label: row.label };
    },

    /**
     * ONE TRANSACTION: verify the code, spend a use, and create the account — or none of it.
     *
     * `createAccount` runs INSIDE the transaction and must be synchronous. That is not an
     * implementation detail leaking out, it is the contract, and better-sqlite3's synchronous API
     * is what makes it keepable: no other request's code can run between the `UPDATE` that spends
     * the use and the `INSERT` that makes the account, because there is no `await` for the event
     * loop to interleave at. Everything expensive and asynchronous — hashing the password with
     * argon2id, which takes tens of milliseconds and is exactly where two concurrent redemptions
     * overlap — belongs BEFORE this call, in the caller.
     *
     * The consequence worth stating: if `createAccount` throws, the transaction rolls back and the
     * use is NOT spent. Somebody who mistypes an email address that already has an account has not
     * burned one of their club's thirty places.
     *
     * `.immediate()` rather than the default deferred BEGIN. This deployment is a single process
     * (spec §3), so within it the two statements are already indivisible; `IMMEDIATE` takes the
     * write lock up front so that a SECOND connection — a backup, a `sqlite3` shell, a future
     * sidecar — cannot hold a read snapshot that turns the UPDATE into `SQLITE_BUSY` halfway
     * through. The `changes !== 1` branch below is the belt to that brace and is genuinely
     * reachable there, which is why it re-reads rather than assuming why it lost.
     */
    redeem<T>(
      input: { plaintext: string; nowISO: string },
      createAccount: CreateAccount<T>,
    ): Redemption<T> {
      // A code that normalises to nothing — an empty body, a string of dashes — is not a code. It
      // is refused as `unknown` like any other wrong guess rather than as a validation error, so it
      // cannot be told apart from a real miss.
      if (normalizeEnrollmentCode(input.plaintext) === '') return { ok: false, refusal: 'unknown' };
      const codeHash = hashEnrollmentCode(input.plaintext);

      const run = db.transaction((): Redemption<T> => {
        const row = byHashStmt.get(codeHash) as CodeRow | undefined;
        if (row === undefined) return { ok: false, refusal: 'unknown' };

        // This read decides only the MESSAGE. Whether the use is actually available is decided by
        // the UPDATE below, which re-tests every one of these conditions in the write itself.
        const refusal = refusalFor(row, input.nowISO);
        if (refusal !== undefined) return { ok: false, refusal };

        if (consumeStmt.run({ id: row.id, now: input.nowISO }).changes !== 1) {
          // The row moved under us between the SELECT and the UPDATE. Re-read it and answer with
          // what is true NOW rather than with what was true a statement ago.
          const after = byIdStmt.get(row.id) as CodeRow | undefined;
          if (after === undefined) return { ok: false, refusal: 'unknown' };
          return { ok: false, refusal: refusalFor(after, input.nowISO) ?? 'exhausted' };
        }

        // Re-read so the record carries the `uses` and `lastUsedAt` this redemption just wrote,
        // rather than the values from before it — and so the caller's `createAccount` sees the
        // same record the response will.
        const consumed = toCode(byIdStmt.get(row.id) as CodeRow);
        return { ok: true, code: consumed, account: createAccount(consumed) };
      });

      return run.immediate();
    },
  };
}
