import { createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
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
 * characters from spelling something an officer would not want to read out.
 * `normalizeEnrollmentCode` then FOLDS THREE OF THE FOUR back in rather than rejecting them, so a
 * person who writes down the `0` they saw as an `O` is not punished for it. The fourth, `U`, has
 * nothing to fold onto and is DELETED — which could not matter while this generator was the only
 * source of codes, since it cannot emit one, and matters the moment an officer types
 * `W1MX-AUTUMN-2026`. Core's `ENROLLMENT_CODE_DROPPED_LETTERS` derives that letter rather than
 * listing it, and `describeEnrollmentCodeFold()` is what makes the browser and the refusals say so.
 *
 * 32^20 is 2^100. That is not a password — nothing about it is human-chosen — and it is far past
 * the point where guessing is the attack; a code of this kind is guessable ONLY by trying, and
 * nobody can try 2^100 things.
 *
 * IT NO LONGER SAYS THAT OF EVERY CODE, AND THAT IS WHY EVERYTHING AROUND IT CHANGED. Since an
 * administrator may TYPE one (`create` below takes a `chosen`), this module issues two kinds of
 * credential with two different strengths, and the paragraph above is true only of the generated
 * kind. A generated code was strong enough that nothing else had to hold — the limiter on the
 * redemption route was documented as a way of making casual guessing pointless rather than as a
 * cap, and it was keyed on an address the caller could write. A chosen code cannot carry that
 * weight, so three other things do, and `CHOSEN_CODE_MIN_LENGTH` is deliberately not one of them:
 * the deployment-wide wrong-code ceiling in `api/auth.ts`, the audit rows written when guessing
 * precedes an account, and `CHOSEN_CODE_MAX_USES` with `CHOSEN_CODE_MAX_DAYS`, which bound what a
 * guessed code is worth. Each of those constants carries the measurement it came from.
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
 * THE COMMENT THAT WAS HERE WAS TRUE WHEN IT WAS WRITTEN AND FALSE BY THE TIME IT WAS READ, WHICH
 * IS THIS CODEBASE'S MOST-REPEATED DEFECT.
 *
 * It read: "Unsalted SHA-256 … the input is 100 bits of randomness this process generated, so there
 * is no dictionary and nothing to precompute." Every word of that was right while the server was
 * the only thing that made codes. `5d25533` let an administrator TYPE one, and what stopped being
 * true was not the conclusion but the PREMISE. The sentence stayed, and a sentence that outlives its
 * premise is worse than no sentence: the next reader takes it as a decision that was made.
 *
 * MEASURED ON THIS HOST, 2026-08-10, WITH THE PRODUCT'S OWN HASH FUNCTION. A dictionary of
 * {K,N,W,A} x digit x two letters (the 1x2 callsign shape) x twenty club words x thirteen years x
 * three separators recovered `W1MX-AUTUMN-2026` — sixteen characters, and twelve after
 * normalisation, which is exactly AT the floor — from its stored digest in 32.4 s after 11,334,277
 * candidates: 349,338 a second on ONE core, single-threaded JavaScript, no GPU. There is no length
 * a person would agree to read out at a meeting that survives that. So the answer is not a longer
 * code; the answer is that the digest must stop being computable by whoever holds the file.
 *
 * A KEY. NOT A SALT, AND NOT A WORK FACTOR. All three were weighed and only one fits this table:
 *
 *   · A PER-ROW SALT DOES NOT ADDRESS THIS ATTACK AT ALL. A salt stops one precomputation being
 *     amortised across many rows. The attack above is aimed at ONE row — the club's single chosen
 *     code — and a salt the attacker can read costs it nothing. It would, meanwhile, cost the shape
 *     this whole module is built on: redemption finds a code BY ITS DIGEST in one indexed
 *     statement, so a per-row salt means hashing the guess once per row and scanning. The one
 *     lookup an anonymous caller can reach would go from O(1) to O(rows).
 *   · A WORK FACTOR (argon2id, scrypt) prices the attack instead of removing it, and bills everyone
 *     else. This digest is computed on the request path, in a single-threaded process, in front of
 *     a synchronous SQLite transaction. At 100 ms a hash a wrong code becomes a unit of denial of
 *     service and the honest student pays it too. Passwords already pay argon2id here — off the
 *     transaction, behind their own concurrency gate — and a code is not a password.
 *   · A KEY costs one HMAC, the same order as the SHA-256 it replaces, keeps the single-statement
 *     lookup exactly as it was, and removes the offline attack rather than pricing it. `createHmac`
 *     and not `sha256(key + code)`: HMAC is the keyed construction whose security does not depend
 *     on getting the concatenation right, and length extension cannot touch it.
 *
 * `exports/token.ts` KEEPS ITS UNSALTED SHA-256, and that is not an inconsistency. Its input is 256
 * bits from `randomBytes` and there is no route by which a person can choose one. What died here is
 * not the argument for a cheap digest; it is the claim that the input cannot be guessed, and over
 * there that claim is still true.
 */
const PEPPER_SALT = 'grantspotter/enrollment-code-digest';
const PEPPER_INFO = 'hmac-sha256/v1';
const PEPPER_BYTES = 32;

/** Memoised on the SECRET, not on the first answer — see `enrollmentCodePepper`. */
let derivedPepper: { secret: string; key: Buffer } | undefined;
let secretlessPepper: Buffer | undefined;

/**
 * WHERE THE KEY COMES FROM: `SESSION_SECRET`, THROUGH HKDF — AND WHAT THAT COSTS, SAID HERE RATHER
 * THAN FOUND OUT LATER.
 *
 * THE DEPLOYMENT ALREADY HAS EXACTLY ONE LONG-LIVED SECRET. `config.ts` requires `SESSION_SECRET`,
 * refuses to start without it, refuses the placeholder `docker-compose.yml` ships (and any fragment
 * of it), and refuses anything under 32 characters. So by the time any route exists there is one
 * high-entropy operator secret, it is in the environment, and it is NOT in the database file — which
 * is the only property this needs. A second secret would be a second thing to generate, to document,
 * to back up and to lose.
 *
 * HKDF RATHER THAN THE SECRET ITSELF. `auth/middleware.ts` uses `SESSION_SECRET` directly as the
 * HMAC key over a session id. Reusing those same bytes as the key of a second MAC, this one over
 * input an attacker chooses, is key reuse across purposes. `hkdfSync` gives this use its own 32
 * bytes; the salt and info are fixed and non-secret because separation is the whole of their job.
 *
 * READ FROM THE ENVIRONMENT HERE RATHER THAN INJECTED, AND THAT IS THE SAFER OF THE TWO. A code is
 * created through `api/enrollment.ts`, whose `RouterDeps` carries no config, and redeemed through
 * `api/auth.ts`, whose deps carry the whole of it. Two injection points for one key is a way for a
 * deployment to end up holding two, and that failure is silent and total: every code an
 * administrator issues is unredeemable and the only symptom is thirty students being told their code
 * is not valid. One resolution, in one place, cannot disagree with itself.
 *
 * RE-READ ON EVERY CALL, MEMOISED ON THE VALUE. A process that learns its secret after this module
 * is first touched must not be pinned to a key derived before it did.
 *
 * WITH NO `SESSION_SECRET` THE KEY IS 32 RANDOM BYTES FOR THE LIFE OF THE PROCESS, and the direction
 * of that fallback is deliberate. The server cannot reach it — `loadConfig` throws first, and
 * `index.firstRun.test.ts` pins that — so it is where a test or a direct consumer of this module
 * lands. A random key is a STRONGER pepper than a derived one, so what a missing secret can break is
 * availability (codes stop redeeming across a restart), loudly, and never secrecy. Falling back to
 * an unkeyed digest would be the same lie told in a new place.
 *
 * WHEN THE SECRET CHANGES OR IS LOST, EVERY CODE ISSUED UNDER IT STOPS REDEEMING. Nothing else about
 * the rows goes: label, uses, expiry, issuer and the whole audit trail survive, and the remedy is one
 * administrator action per open intake. Rotating `SESSION_SECRET` already signs every user out, so it
 * is already a maintenance-window act; this adds a line to its cost rather than a new kind of
 * surprise. `093-peppered-enrollment-code-digests.sql` tells whoever reads the schema, and
 * `exports/json.ts` tells whoever restores a backup onto a new host.
 *
 * IT IS NOT DETECTED, AND THAT IS A CHOICE. Detecting a changed key means storing something derived
 * from `SESSION_SECRET` beside the digests, and a key check value in the database turns a stolen
 * database into an offline oracle for the SESSION key — one hash per guess, no known plaintext
 * needed. Buying a better error message with the secrecy of the session key is the wrong way round.
 */
export function enrollmentCodePepper(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (secret === undefined || secret === '') {
    secretlessPepper ??= randomBytes(PEPPER_BYTES);
    return secretlessPepper;
  }
  if (derivedPepper === undefined || derivedPepper.secret !== secret) {
    derivedPepper = {
      secret,
      key: Buffer.from(hkdfSync('sha256', secret, PEPPER_SALT, PEPPER_INFO, PEPPER_BYTES)),
    };
  }
  return derivedPepper.key;
}

/** What `create` writes into `hash_scheme`, and one of the two values migration 093's CHECK allows. */
export const ENROLLMENT_HASH_SCHEME = 'hmac-sha256';

/** What every row written before migration 093 carries, and what nothing writes any more. */
export const LEGACY_ENROLLMENT_HASH_SCHEME = 'sha256';

/**
 * Only this digest is persisted, so a copy of the database is not a pile of working credentials —
 * which is now a claim about a KEY the copy does not contain, and no longer a claim about the input
 * being unguessable.
 */
export function hashEnrollmentCode(raw: string): string {
  return createHmac('sha256', enrollmentCodePepper())
    .update(normalizeEnrollmentCode(raw), 'utf8')
    .digest('hex');
}

/**
 * The digest a row written before migration 093 holds. LOOKED UP, NEVER WRITTEN.
 *
 * AN UPGRADE MUST NOT COST AN OPERATOR THEIR OPEN INTAKE. Nothing here can re-hash an existing row:
 * the plaintext was returned once, to the administrator who issued it, and is gone. So the choice
 * was between breaking every code a club is currently handing out and reading both digests on the
 * way in. `create`, `inspect` and `redeem` each look for either, in one indexed statement, and the
 * only thing that changes on upgrade day is that new codes are keyed.
 *
 * THE ROWS THIS FINDS ARE EXACTLY THE ROWS THE OLD COMMENT WAS RIGHT ABOUT, and that is why leaving
 * them alone is safe rather than merely convenient. A pre-093 row can only be a GENERATED code:
 * `chosen` did not exist before migration 092, and 092 shipped in the same unpushed change that
 * introduced typed codes. Twenty uniform characters out of a 32-symbol alphabet is 2^100, so the
 * unkeyed digest of one is not a dictionary target — the premise that failed for `W1MXATMN2026`
 * holds for every row that can carry this scheme.
 *
 * THEY ARE NOT REWRITTEN ON REDEMPTION EITHER, though the plaintext is in hand at that moment.
 * `code_hash` is UNIQUE and the rewrite would sit inside the transaction that creates a student's
 * account, so the cost of being wrong about it is a 500 on a successful enrolment — paid to buy
 * uniformity, not safety. Legacy rows age out on their own: a code is revoked, expires or is
 * exhausted, and this branch can be deleted when `SELECT count(*) FROM enrollment_codes WHERE
 * hash_scheme = 'sha256'` is zero.
 */
export function legacyHashEnrollmentCode(raw: string): string {
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
  /**
   * The administrator issuing this code, or null when the DEPLOYMENT is issuing it.
   *
   * REQUIRED AND NULLABLE rather than optional, for the same reason `chosen` is: the two are
   * different kinds of credential — one an administrator can be asked about and one that belongs to
   * a line in `docker-compose.yml` — and every call site has to say which it is minting. Only
   * `auth/envEnrollmentCode.ts` passes null.
   *
   * A NON-NULL ID MUST NAME A USER THAT EXISTS, and `create` checks it rather than trusting the
   * caller. Migration 094 dropped the foreign key that used to check it, because this column
   * records who issued a code and a record of a past act cannot carry referential integrity against
   * a table people are deleted from. What that key ALSO did was reject a caller that wrote an id
   * belonging to nobody, and that half is worth keeping: it is the difference between a row that
   * names a departed colleague and a row that names nothing anybody can look up.
   */
  createdByUserId: string | null;
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
  /**
   * THE ROW THAT HOLDS THIS CODE, WHATEVER STATE IT IS IN — revoked, expired, exhausted or live.
   *
   * `inspect` IS NOT THIS AND MUST NOT BECOME IT. It withholds the row's identity from every code
   * it will not honour, and that is the whole of its disclosure policy: its caller is an anonymous
   * HTTP route, and an answer that named a revoked code's row would turn a wrong guess into "yes,
   * such a code exists here". This one names the row unconditionally and has exactly one caller —
   * `auth/envEnrollmentCode.ts`, at boot, holding a value it read out of the operator's own file.
   * Nothing reachable from a request may call it.
   *
   * WHY THE BOOT PATH NEEDS IT AND `inspect` CANNOT SERVE. Reconciling `ENROLLMENT_CODE` against
   * the table turns on three questions that are all about rows a redemption would refuse: is this
   * value the one already set from the file, has it been withdrawn, or does it belong to a code an
   * administrator issued in the app? `inspect` answers "no" to all three with the same word.
   *
   * Undefined for a code that normalises to nothing, which is not a code.
   */
  findByCode(plaintext: string): EnrollmentCode | undefined;
  /** Idempotent: a second revoke returns the code with the FIRST revocation's timestamp. */
  revoke(id: string, nowISO: string): EnrollmentCode | undefined;
  /**
   * WITHDRAW EVERY CODE THIS ADMINISTRATOR ISSUED THAT COULD STILL CREATE AN ACCOUNT, and return
   * them as they now stand so the caller can write the trail.
   *
   * THE ONE CALLER IS `api/adminUsersRouter.ts`, INSIDE THE TRANSACTION THAT DELETES THE ACCOUNT.
   * Until migration 094 this happened by cascade and the rows were DELETED — which met the security
   * requirement and destroyed the evidence: the use count an officer needs to answer "how many
   * accounts did that intake make", the expiry, the label, and the subject of every `user.enroll`
   * audit row that names the code an account came from. Revoking meets the same requirement and
   * keeps all of it.
   *
   * ONLY THE OPEN ONES, which is `anyOpen`'s predicate rather than "everything not yet revoked". A
   * code that had already expired or been used up cannot come back — expiry does not un-pass and
   * `uses` never decreases — so withdrawing it would change nothing except the sentence
   * `describeClosure` shows a person, replacing why it really ended with a second, later reason.
   *
   * IT IS NOT THE ONLY THING STANDING THERE. Migration 094's trigger performs the same withdrawal
   * for any path that deletes a user without coming through here, on the ground that 091's cascade
   * was a SCHEMA-level guarantee and replacing it with a line in one router would be the downgrade
   * `test/userCascade.test.ts` exists to catch. This method is what makes the ordinary path use the
   * request's own clock and leave an audit row per code; the trigger then finds nothing to do.
   */
  revokeIssuedBy(userId: string, nowISO: string): EnrollmentCode[];
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
  created_by_user_id: string | null;
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
    `INSERT INTO enrollment_codes (id, code_hash, hash_scheme, label, chosen, max_uses, uses,
       expires_at, revoked_at, created_at, created_by_user_id, last_used_at)
     VALUES (@id, @code_hash, @hash_scheme, @label, @chosen, @max_uses, 0, @expires_at, NULL,
       @created_at, @created_by_user_id, NULL)`,
  );

  /**
   * ONE STATEMENT, TWO CANDIDATE DIGESTS — the keyed one every new row carries and the unkeyed one
   * every row older than migration 093 carries.
   *
   * `IN (@keyed, @legacy)` and not two `SELECT`s, because the single indexed lookup is the property
   * the whole design of this table is built to keep. MEASURED with `EXPLAIN QUERY PLAN` on this host
   * (node 20.11.0, better-sqlite3 12.11.1) against this DDL: `SEARCH enrollment_codes USING INDEX
   * sqlite_autoindex_enrollment_codes_2 (code_hash=?)` — byte for byte the plan `code_hash = ?`
   * produced before, and no scan.
   *
   * AT MOST ONE ROW CAN MATCH. `code_hash` is UNIQUE, so the two candidates can only both hit if two
   * rows hold the same plaintext under different schemes — which `create` below refuses by checking
   * with this same statement before it inserts, and which nothing else can produce.
   */
  const byHashStmt = db.prepare(
    `SELECT ${COLUMNS} FROM enrollment_codes WHERE code_hash IN (@keyed, @legacy)`,
  );

  /** Both readings of one typed code: what this build stores, and what a pre-093 row stores. */
  function digestsOf(plaintext: string): { keyed: string; legacy: string } {
    return { keyed: hashEnrollmentCode(plaintext), legacy: legacyHashEnrollmentCode(plaintext) };
  }
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
   * The codes one administrator issued that a person could still redeem — `anyOpen`'s three
   * conditions with an issuer, so that what this finds and what that reports can never disagree
   * about what "open" means.
   *
   * `SCAN enrollment_codes` + `USE TEMP B-TREE FOR ORDER BY`, and no index for it, measured with
   * EXPLAIN QUERY PLAN on this host against migration 094's DDL. It runs once, when an account is
   * deleted, over a table holding one row per intake an organisation has ever run; an index would
   * be a third B-tree maintained on every redemption to save reading a single page on the rarest
   * write this table has.
   *
   * `created_by_user_id = ?` never matches the compose file's row, because that row holds NULL and
   * SQL equality against NULL is unknown. That is not a happy accident — it is the whole reason 094
   * made the column nullable, and `envEnrollmentCode.test.ts` asserts it from the other side.
   */
  const openByIssuerStmt = db.prepare(
    `SELECT ${COLUMNS} FROM enrollment_codes
      WHERE created_by_user_id = @issuer
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > @now)
        AND (max_uses IS NULL OR uses < max_uses)
      ORDER BY created_at, id`,
  );

  /** Does this id name a user? Asked once per issued code, on the PRIMARY KEY. */
  const userExistsStmt = db.prepare('SELECT 1 AS ok FROM users WHERE id = ?');

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
      /**
       * THE HALF OF 091'S FOREIGN KEY THAT WAS HOUSEKEEPING, KEPT AFTER 094 TOOK THE KEY AWAY.
       *
       * THROWN, NOT RETURNED AS A REFUSAL, and the distinction is the one `CodeIssued` already
       * draws: a collision is an ordinary outcome of an administrator typing something and gets a
       * sentence, whereas an issuer id that names nobody is a caller that is wrong — there is no
       * request an administrator can send that produces it, and no sentence that would help them.
       * It is the same bargain as the `max_uses > 0` CHECK, which `enrollmentCodes.test.ts` asserts
       * still throws rather than being softened into a refusal.
       *
       * NULL IS NOT AN UNKNOWN ISSUER AND IS NOT CHECKED. It is the deployment, and there is no row
       * to look for.
       */
      if (input.createdByUserId !== null && userExistsStmt.get(input.createdByUserId) === undefined) {
        throw new Error(
          `Cannot attribute an enrollment code to "${input.createdByUserId}": no such user. Pass ` +
            'null only for a code the deployment itself is issuing (ENROLLMENT_CODE).',
        );
      }
      const plaintext = input.chosen ?? newEnrollmentCode();
      const normalized = normalizeEnrollmentCode(plaintext);
      /**
       * BOTH READINGS, THOUGH ONLY THE KEYED ONE IS STORED. A code that already exists as a pre-093
       * row hashes to the unkeyed digest and to nothing else, so a collision check that asked only
       * about the keyed one would let a second row be created for a plaintext this deployment has
       * already issued — two rows, one code, and whichever the lookup found first would be the only
       * one that could ever be redeemed or revoked. It takes one extra parameter to make that
       * impossible.
       */
      const candidates = digestsOf(plaintext);
      const row = {
        id: randomUUID(),
        code_hash: candidates.keyed,
        hash_scheme: ENROLLMENT_HASH_SCHEME,
        label: input.label,
        chosen: input.chosen === null ? 0 : 1,
        max_uses: input.maxUses,
        expires_at: input.expiresAt,
        created_at: input.nowISO,
        created_by_user_id: input.createdByUserId,
      };

      const write = db.transaction((): CodeIssued => {
        const taken = byHashStmt.get(candidates) as CodeRow | undefined;
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
        const taken = byHashStmt.get(candidates) as CodeRow | undefined;
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

    findByCode(plaintext) {
      if (normalizeEnrollmentCode(plaintext) === '') return undefined;
      // The same one indexed statement `redeem` uses, and both digests for the same reason: a
      // pre-093 row holds the unkeyed one, and a boot that could not see it would create a second
      // row for a code this deployment has already issued.
      const row = byHashStmt.get(digestsOf(plaintext)) as CodeRow | undefined;
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

    revokeIssuedBy(userId, nowISO) {
      // Read the open ones first, then revoke each by id through the SAME statement the button
      // uses, so an administrator leaving and an administrator pressing revoke write identical
      // rows. Doing it as one bulk UPDATE would have been a second way to revoke a code, and a
      // second way to revoke a code is a second place for `AND revoked_at IS NULL` to be forgotten.
      const open = openByIssuerStmt.all({ issuer: userId, now: nowISO }) as CodeRow[];
      return open.map((row) => {
        revokeStmt.run(nowISO, row.id);
        return toCode(byIdStmt.get(row.id) as CodeRow);
      });
    },

    anyOpen(nowISO) {
      return anyOpenStmt.get(nowISO) !== undefined;
    },

    inspect(plaintext, nowISO) {
      // A code that normalises to nothing is `unknown`, exactly as `redeem` treats it: an empty
      // body and a wrong guess have to be the same event or the difference is a free answer.
      if (normalizeEnrollmentCode(plaintext) === '') return { ok: false, refusal: 'unknown' };
      const row = byHashStmt.get(digestsOf(plaintext)) as CodeRow | undefined;
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
      // Both digests computed OUTSIDE the transaction, as the single one was: two HMAC-scale hashes
      // are not work worth holding a write lock across.
      const candidates = digestsOf(input.plaintext);

      const run = db.transaction((): Redemption<T> => {
        const row = byHashStmt.get(candidates) as CodeRow | undefined;
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
