-- Enrollment codes: the third way an account can come into existence.
--
-- Numbered 091 deliberately, for the reason 090 gives: Plans 1-4 number their migrations from 001
-- upward and stop at 037, so a 09x file always applies last regardless of what they add later.
-- `enrollment_codes` is a NEW name, checked against 001-init.sql and every 0NN-*.sql before writing
-- — SQLite matches `IF NOT EXISTS` on the NAME alone, so reusing one would make this statement a
-- silent no-op and the shape below would never exist. `db/schemaConformance.test.ts` scans every
-- migration AND every product file for a repeated table or index name and fails by name.
--
-- WHAT IS STORED, AND WHAT IS NOT.
--
-- `code_hash` is the SHA-256 of the normalised code and there is no column holding the code. That
-- is the same decision `ics_tokens` made one migration earlier, made for the same two reasons and
-- against a stronger threat: a copy of `grantspotter.sqlite` — a backup, a support attachment, the
-- JSON export this codebase writes — must not hand the reader a working credential, and an ICS
-- token only reads a public programme corpus whereas this one CREATES AN ACCOUNT. The plaintext
-- exists once, in the response to the POST that made it, and is unrecoverable afterwards; the list
-- route therefore cannot show it again, which is a property of this design and not an oversight.
--
-- SUPERSEDED BY `093-peppered-enrollment-code-digests.sql`, AND THE PARAGRAPH BELOW IS LEFT AS
-- WRITTEN BECAUSE IT IS THE RECORD OF WHAT THIS TABLE WAS. Read it as history, not as a
-- description: since migration 092 an administrator can TYPE a code, which destroyed the premise
-- the argument rests on, and 093 replaced the digest with an HMAC keyed from `SESSION_SECRET`.
-- `code_hash` is therefore the SHA-256 of the normalised code only for rows this migration's
-- generation wrote; `hash_scheme` says which of the two any given row holds. The correction lives
-- in 093 rather than in an edit here, but a reader who stops at this file must not be left holding
-- a claim that stopped being true two migrations ago.
--
-- SHA-256 with no salt and no stretching is the right primitive here and the wrong one for a
-- password, exactly as `exports/token.ts` argues: the input is 100 bits of uniform randomness this
-- process generated, so there is no dictionary to attack and nothing to precompute, and a digest
-- cheap enough to compute on every attempt is what lets the rate limiter be the thing that binds.
--
-- THE FOREIGN KEY, AND WHY IT CASCADES.
--
-- SUPERSEDED BY `094-enrollment-codes-outlive-their-issuer.sql`, AND THE PARAGRAPHS BELOW ARE LEFT
-- AS WRITTEN BECAUSE THEY ARE THE RECORD OF WHAT THIS COLUMN WAS. Read them as history: since 094
-- there is no foreign key on `created_by_user_id` at all and the column is nullable, so the shape
-- declared at the bottom of this file is NOT the shape the database has. The conclusion below —
-- that a live credential must not outlive its issuer's account — is unchanged and is now kept by a
-- trigger that REVOKES those codes instead of deleting them; what was wrong was using one cascade
-- to do that job and referential housekeeping at once, since the second one destroys the record the
-- first one needs. The cost the last paragraph calls "real and stated rather than hidden" was
-- larger than it says: it also fell on the code set in `docker-compose.yml`, which the schema
-- forced to be attributed to a person who did not issue it, so deleting that account deleted the
-- file's code and the next boot brought it back with a fresh expiry and its uses at zero.
--
-- `created_by_user_id` names the admin who issued the code, and deleting that admin deletes their
-- outstanding codes. `test/userCascade.test.ts` draws the line this sits on: rows that are A RECORD
-- OF SOMETHING THAT HAPPENED (audit_log, verify_attempts, review decisions) outlive the account,
-- and rows that KEEP WORKING ON A DELETED USER'S BEHALF do not. An enrollment code is squarely the
-- second kind — it is a live credential that mints accounts — so it dies with the issuer, for the
-- same reason 090 gave the calendar feed a cascade after the brief had said not to.
--
-- The cost is real and is stated rather than hidden: an officer who leaves mid-intake takes their
-- unspent codes with them, and the students still holding one are answered "not valid" rather than
-- "the person who issued this has left". The remedy is one admin action (issue a new code) and the
-- alternative is a credential nobody can see the owner of, which is worse. The audit trail of who
-- issued what survives regardless: `audit_log.actor_user_id` has no foreign key at all.
--
-- The column is named `created_by_user_id` and not `admin_id` or `owner_id` because
-- `userCascade.test.ts` classifies by NAME — `/(?:^|_)user_id$/` matches this, and a synonym would
-- walk straight past the guard. Verified on this host rather than read off the regex: the test's
-- own `namesAUser('created_by_user_id')` returns true, and its second rule then requires this
-- column to carry a cascade or a written exemption.
CREATE TABLE IF NOT EXISTS enrollment_codes (
  id                 TEXT PRIMARY KEY,
  -- UNIQUE is not decoration: it builds the index the redemption lookup uses (see below) and it
  -- makes a hash collision between two live codes a constraint failure at creation rather than an
  -- ambiguous SELECT at redemption.
  code_hash          TEXT NOT NULL UNIQUE,
  label              TEXT NOT NULL,
  -- NULL means "no limit". A limit of zero is not a bounded code, it is a code that can never be
  -- redeemed, and an admin who typed 0 meant something they should be told to say differently.
  max_uses           INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses               INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at         TEXT,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL,
  -- NEITHER `NOT NULL` NOR A FOREIGN KEY SINCE 094 — see the amendment in the header. This line is
  -- what a database created before that migration held for as long as it took 094 to run.
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_used_at       TEXT
);

-- NO SECONDARY INDEX, and this is the same question 090 answered rather than a copy of its answer.
--
-- Measured with EXPLAIN QUERY PLAN on this host (node 20.11.0, better-sqlite3 12.11.1) against
-- this exact DDL, for every statement `db/repositories/enrollmentCodes.ts` prepares:
--   SELECT … WHERE code_hash = ?  ->  SEARCH USING INDEX sqlite_autoindex_enrollment_codes_2 (code_hash=?)
--   UPDATE … WHERE id = ? AND …   ->  SEARCH USING INDEX sqlite_autoindex_enrollment_codes_1 (id=?)
--   SELECT … WHERE id = ?         ->  SEARCH USING COVERING INDEX sqlite_autoindex_enrollment_codes_1 (id=?)
--   SELECT … ORDER BY created_at  ->  SCAN  (+ USE TEMP B-TREE FOR ORDER BY)
--   SELECT 1 … LIMIT 1 (any open) ->  SCAN
-- The two paths on the redemption hot path are already covered by the PRIMARY KEY and the UNIQUE
-- above. The two scans read a table holding one row per intake an organisation has ever run — tens,
-- not thousands — and an index over `created_at`, or over the redeemability predicate, would be a
-- third and fourth B-tree maintained on every redemption to save scanning a single page.
