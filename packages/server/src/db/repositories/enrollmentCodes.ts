import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ENROLLMENT_CODE_ALPHABET,
  normalizeEnrollmentCode,
  type EnrollmentCode,
} from '@grantspotter/core';
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
 *
 * IT NO LONGER SAYS THAT OF EVERY CODE. Since an administrator may TYPE one (`create` below takes a
 * `chosen`), this module issues two kinds of credential with two different strengths, and the
 * paragraph above is true only of the generated kind. What bounds the other is
 * `CHOSEN_CODE_MIN_LENGTH` in core, which derives its floor from what the shipped limiter actually
 * lets an attacker try.
 */
const ALPHABET = ENROLLMENT_CODE_ALPHABET;
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
 * The one form a code is ever hashed in — NOW DEFINED IN CORE, and re-exported here.
 *
 * It moved on 2026-08-10 and the move is the point rather than tidying: an administrator can now
 * type a code, so the admin console has to show them what their code will actually be stored as
 * BEFORE they save it, and `web -> server` is a direction this repository does not allow. Core is
 * shared, so the fold has exactly one definition and the browser's preview cannot drift from what
 * the server hashes.
 *
 * Re-exported rather than re-imported by each caller because `api/auth.ts`, this module's tests and
 * this module itself already say `from './enrollmentCodes.js'`, and a rename that touches five
 * files to move a function is a rename that hides the reason it moved.
 */
export { normalizeEnrollmentCode };

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
  /**
   * The code an administrator typed, or null to have one generated.
   *
   * REQUIRED AND NULLABLE rather than optional, so that every call site states which kind of
   * credential it is minting. The two are not interchangeable — one is 2^100 and one is a phrase
   * somebody can say out loud — and a field that can be left off is a field that gets left off.
   *
   * NOTHING IS VALIDATED HERE. The floor, the expiry rule and the label check are policy and live
   * in `api/enrollment.ts` beside the sentences that explain them to an administrator; this
   * repository's job is to store a digest and to refuse a collision, and it will faithfully store
   * the digest of `A` if something above it asks for that.
   */
  chosen: string | null;
  maxUses: number | null;
  /** ISO, or null for a code that never expires. */
  expiresAt: string | null;
  createdByUserId: string;
  nowISO: string;
}

/**
 * WHAT ISSUING A CODE CAN NOW DO INSTEAD OF SUCCEEDING, AND WHY THE GENERATED PATH GREW A BRANCH IT
 * CANNOT REACH.
 *
 * `code_hash` is UNIQUE, and two DIFFERENT-LOOKING chosen codes can land on one digest, because the
 * fold is the whole point of the fold: `W1MX-FALL-2026` and `WIMX-FA11-2O26` both normalise to
 * `W1MXFA112026`. That was impossible while the server was the only thing that made codes — the
 * generator never emits `I`, `L`, `O` or `U` at all, so no two generated codes can fold onto each
 * other, and two of them landing on the same 20 characters is 2^-100.
 *
 * So a collision is now an ORDINARY OUTCOME of an administrator typing something, not a fault, and
 * it is returned rather than thrown. A thrown SQLite constraint error would reach the error handler
 * as a 500, and a 500 is the product saying "something went wrong here" about a request where
 * nothing went wrong at all: somebody typed a code that is already in use, and the honest answer
 * says so and says which one.
 *
 * `conflict` is null only in a case that cannot arise through this API: the colliding row was read
 * back and had gone. Kept because the alternative is a nullish access in the one branch nobody
 * tests, and the router has a sentence for it.
 */
export type CodeIssued =
  | { ok: true; code: EnrollmentCode; plaintext: string; normalized: string }
  | { ok: false; conflict: { id: string; label: string } | null };

export interface EnrollmentCodeRepo {
  /**
   * The plaintext is returned HERE AND NOWHERE ELSE — nothing can recover it afterwards.
   *
   * For a chosen code the plaintext is the administrator's own string, returned verbatim so the
   * console can show it back exactly as typed; `normalized` beside it is what was actually hashed,
   * which is the value they are really committing to and the one the console must show them.
   */
  create(input: CreateEnrollmentCodeInput): CodeIssued;
  list(): EnrollmentCode[];
  findById(id: string): EnrollmentCode | undefined;
  /** Idempotent: a second revoke returns the code with the FIRST revocation's timestamp. */
  revoke(id: string, nowISO: string): EnrollmentCode | undefined;
  /** Is there at least one code a person could redeem right now? Never says which, or how many. */
  anyOpen(nowISO: string): boolean;
  /**
   * What this deployment would say about `plaintext` at `nowISO`, WITHOUT SPENDING ANYTHING.
   *
   * READ-ONLY: it writes nothing, and its answer is stale the instant it returns, which is why
   * `redeem` re-tests every one of these conditions in the write itself and remains the only thing
   * that decides who gets a place.
   *
   * IT ANSWERS BOTH HALVES because its caller needs both before it does anything expensive.
   * `api/auth.ts` uses `ok: true` — which code is asking — to ration the "that address already has
   * an account" answer per code, in one synchronous stretch, because a rationing with an `await`
   * in the middle is the defect this module is shaped against. It uses `ok: false` to answer the
   * caller about the CODE and go no further: a code this deployment will not honour must not reach
   * an argon2id hash, and until 2026-08-05 every wrong guess paid for one.
   *
   * The refusal it reports is the same value `redeem` would report, from the same function, so the
   * two can never disagree — but `redeem`'s is the authoritative one and is what a response is
   * built from when a redemption is actually attempted.
   */
  inspect(
    plaintext: string,
    nowISO: string,
  ): { ok: true; id: string; label: string } | { ok: false; refusal: EnrollmentRefusal };
  redeem<T>(
    input: { plaintext: string; nowISO: string },
    createAccount: CreateAccount<T>,
  ): Redemption<T>;
}

interface CodeRow {
  id: string;
  label: string;
  chosen: number;
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
  'id, label, chosen, max_uses, uses, expires_at, revoked_at, created_at, created_by_user_id, last_used_at';

function toCode(row: CodeRow): EnrollmentCode {
  return {
    id: row.id,
    label: row.label,
    // `=== 1`, not truthiness: SQLite has no boolean and migration 092's CHECK is what keeps the
    // column to 0 or 1. Reading anything else as `false` is the safe direction to be wrong in — it
    // understates a code's strength rather than overstating it.
    chosen: row.chosen === 1,
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
 * Is this the UNIQUE constraint on `code_hash`, as opposed to any other way an insert can fail?
 *
 * NARROW ON PURPOSE. The table also carries `CHECK (max_uses IS NULL OR max_uses > 0)` and
 * `CHECK (chosen IN (0, 1))`, and a foreign key to `users`. Catching "a constraint failed" would
 * turn a zero-use code — which `enrollmentCodes.test.ts` asserts still throws — into a refusal that
 * says a code collided, which is a wrong answer dressed as a helpful one. The column name is
 * matched as well as the error code because `id` is also unique, and a UUID collision is a
 * different accident that deserves to be seen.
 */
function isCodeHashCollision(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' && err.message.includes('enrollment_codes.code_hash');
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
    `INSERT INTO enrollment_codes (id, code_hash, label, chosen, max_uses, uses, expires_at,
       revoked_at, created_at, created_by_user_id, last_used_at)
     VALUES (@id, @code_hash, @label, @chosen, @max_uses, 0, @expires_at, NULL, @created_at,
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
    /**
     * ONE TRANSACTION: look for the digest, then write it — or refuse and write nothing.
     *
     * `.immediate()` and a re-read inside it, for the same reason `redeem` below gives: a check
     * followed by a write is only a check if nothing can run in between. Here the thing that could
     * run in between is a second administrator issuing the same chosen code from another browser
     * tab, and the write lock is what makes "is this code taken?" and "take it" one decision.
     *
     * THE `catch` AROUND IT SHOULD BE UNREACHABLE AND IS NOT DELETED. Holding the write lock means
     * no other connection can insert between the SELECT and the INSERT, so the UNIQUE constraint on
     * `code_hash` has nothing left to catch. It is kept because "should be unreachable" is a claim
     * about today's schema and today's callers, and the failure mode if the claim is ever wrong is
     * a 500 on a route where an administrator has done nothing wrong. The cost of keeping it is
     * eight lines; the cost of being wrong about it is the product blaming the user for a
     * constraint. `redeem`'s `changes !== 1` branch is the same bargain, one statement further on.
     */
    create(input) {
      const plaintext = input.chosen ?? newEnrollmentCode();
      const normalized = normalizeEnrollmentCode(plaintext);
      const row = {
        id: randomUUID(),
        code_hash: hashEnrollmentCode(plaintext),
        label: input.label,
        chosen: input.chosen === null ? 0 : 1,
        max_uses: input.maxUses,
        expires_at: input.expiresAt,
        created_at: input.nowISO,
        created_by_user_id: input.createdByUserId,
      };

      const write = db.transaction((): CodeIssued => {
        const taken = byHashStmt.get(row.code_hash) as CodeRow | undefined;
        if (taken !== undefined) {
          return { ok: false, conflict: { id: taken.id, label: taken.label } };
        }
        insertStmt.run(row);
        return {
          ok: true,
          code: {
            id: row.id,
            label: row.label,
            chosen: row.chosen === 1,
            maxUses: row.max_uses,
            uses: 0,
            expiresAt: row.expires_at,
            revokedAt: null,
            createdAt: row.created_at,
            createdByUserId: row.created_by_user_id,
            lastUsedAt: null,
          },
          // The one and only time this value exists outside the caller's own memory — and for a
          // chosen code, the caller already had it.
          plaintext,
          normalized,
        };
      });

      try {
        return write.immediate();
      } catch (err) {
        if (!isCodeHashCollision(err)) throw err;
        const taken = byHashStmt.get(row.code_hash) as CodeRow | undefined;
        return {
          ok: false,
          conflict: taken === undefined ? null : { id: taken.id, label: taken.label },
        };
      }
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

    inspect(plaintext, nowISO) {
      // A code that normalises to nothing is `unknown`, exactly as `redeem` treats it: an empty
      // body and a wrong guess have to be the same event or the difference is a free answer.
      if (normalizeEnrollmentCode(plaintext) === '') return { ok: false, refusal: 'unknown' };
      const row = byHashStmt.get(hashEnrollmentCode(plaintext)) as CodeRow | undefined;
      if (row === undefined) return { ok: false, refusal: 'unknown' };
      // The same four conditions `redeem` reads, from the same function, so the two can never
      // disagree about what "could be redeemed" means.
      const refusal = refusalFor(row, nowISO);
      if (refusal !== undefined) return { ok: false, refusal };
      return { ok: true, id: row.id, label: row.label };
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
