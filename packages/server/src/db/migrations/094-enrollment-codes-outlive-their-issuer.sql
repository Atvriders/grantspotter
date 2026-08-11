-- WHO A CODE IS ATTRIBUTED TO, TOLD APART FROM WHAT HAPPENS TO IT WHEN THAT PERSON LEAVES.
--
-- Numbered 094 for the reason 090, 091, 092 and 093 give: Plans 1-4 number their migrations from
-- 001 upward and stop at 037, so a 09x file always applies last regardless of what they add later.
-- This one CREATEs two names — `enrollment_codes_rebuilt` and the trigger below — and both are new,
-- checked against 001-init.sql and every 0NN-*.sql before writing, because SQLite matches
-- `IF NOT EXISTS` on the NAME alone and `db/schemaConformance.test.ts` fails a repeated one.
--
-- ---------------------------------------------------------------- one cascade, two different jobs
--
-- 091 wrote `created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE` and gave one
-- reason for it, which was a good reason: "rows that KEEP WORKING ON A DELETED USER'S BEHALF" must
-- not survive the account, and an enrollment code mints accounts. That is a POLICY. The foreign key
-- was also doing a second, unrelated job — HOUSEKEEPING, the ordinary "do not leave a row pointing
-- at a parent that is gone" — and the two were being served by a single mechanism that can only
-- express itself by DESTROYING THE ROW. Everything below is those two jobs separated.
--
-- THE POLICY IS NOT WRONG AND IT IS NOT WHAT ERASURE ACHIEVES. What has to be true is that a
-- removed account leaves no live credential behind. Deleting the row achieves that and takes with
-- it the label, the use count, the expiry, the issue date and — this is the part that matters —
-- THE SUBJECT OF THE AUDIT TRAIL. `audit_log` keeps its `enrollment_code.create` and
-- `enrollment_code.revoke` rows, because `audit_log.actor_user_id` has no foreign key on purpose,
-- and each names an `entity_id` that no longer resolves to anything; every `user.enroll` row an
-- account was created by carries `detail.enrollmentCodeId`, which stops naming a code that exists.
-- An officer asking "how many accounts did that intake code make, and who issued it?" gets a trail
-- about a row that has been deleted out from under it. REVOCATION achieves the same
-- security property — the credential stops working, at once, and cannot be brought back, because
-- `revoke` is one-way and `envEnrollmentCode.ts` refuses to resurrect a withdrawn code — and it
-- leaves the record legible. So the policy stays and its instrument changes: the trigger at the
-- bottom of this file.
--
-- THE HOUSEKEEPING JOB IS THE ONE THAT WAS MISSTATED. `created_by_user_id` is not a pointer to a
-- current owner; it is a statement about a past event — WHO ISSUED THIS — of exactly the kind
-- `test/userCascade.test.ts` already exempts for `audit_log.actor_user_id`,
-- `review_items.decided_by` and `review_rejects.decided_by`: "a RECORD OF SOMETHING THAT HAPPENED,
-- which an account deletion is not entitled to rewrite". A record of who did something cannot carry
-- referential integrity against a table people are deleted from without the record being deleted
-- too, which is a contradiction in terms. So the key goes, the column joins that list with a
-- written reason, and the guard's own premise — "nothing here keeps working on a deleted user's
-- behalf" — is what the trigger makes true rather than something a comment asserts.
--
-- ---------------------------------------------------- and the code in docker-compose.yml is nobody's
--
-- THE COLUMN BECOMES NULLABLE, AND NULL MEANS THE DEPLOYMENT. `auth/envEnrollmentCode.ts` had to
-- attribute the file's code to the oldest administrator, and said so in as many words: "a code
-- cannot exist without naming somebody. The honest answer is 'the operator, through a file', and
-- there is no row for that." NOT NULL is what forced the imprecision, and the imprecision had a
-- price that was documented and not fixed — delete that administrator and the compose code was
-- cascaded away, and the next boot RECREATED IT WITH A FRESH EXPIRY AND A USE COUNT BACK AT ZERO.
-- A code that was 89 days old with 29 of its 30 uses spent came back new because somebody removed
-- an account. That is a deletion GRANTING access, which is the one direction this table may never
-- be wrong in.
--
-- Now the file's code names nobody, because nobody is the true answer: the compose file is its
-- author, an administrator cannot reissue it, and the row is governed by the line in the file. It
-- is therefore untouched by any account deletion, which is what makes the uses it has spent and the
-- expiry it was created with survive everything except an edit to that line.
--
-- INVENTING A SYSTEM USER WAS THE OTHER OPTION AND IS STILL WORSE, for the reason
-- `envEnrollmentCode.ts` gave before it could reach for NULL: `users` rows carry a password hash, a
-- role and an ICS token, and a synthetic one would appear in the admin user list as an account
-- somebody could enable, reset or sign in as. A false row in the users table is a heavier lie than
-- an absent value in one column.
--
-- NULLABLE DOES NOT MEAN THE FILE'S CODE MAY EXIST BEFORE AN ADMINISTRATOR DOES, and this is the
-- sentence 091's foreign key was accidentally enforcing. The README's promise is that the first
-- administrator comes out of the container log and that nothing self-serve exists until one has
-- acted; a compose file that minted an account-creating credential against an empty database would
-- break it. That deferral is now an explicit gate in `syncEnvEnrollmentCode` with its own test,
-- because a security property that survives only as a side effect of a NOT NULL constraint is a
-- security property one migration away from being lost — this migration, in fact.
--
-- ---------------------------------------------------------- why the table is rebuilt, and what was
-- ---------------------------------------------------------- measured before trusting the rebuild
--
-- SQLite'S `ALTER TABLE` CANNOT DROP A FOREIGN KEY AND CANNOT RELAX `NOT NULL`. The twelve-step
-- rebuild in SQLite's own "Making Other Kinds Of Table Schema Changes" is the only way, and it is
-- the reason this file is a CREATE / INSERT SELECT / DROP / RENAME rather than the two-line ALTER
-- that 092 and 093 were. Everything asserted below about it was RUN on this host (node 20.11.0,
-- better-sqlite3 12.11.1) against this exact statement sequence inside one transaction, which is
-- how `db/migrate.ts` executes it:
--
--   · `PRAGMA foreign_key_list(enrollment_codes)` -> empty, and `PRAGMA foreign_key_check` -> empty.
--   · THE TWO IMPLICIT INDEXES SURVIVE THE RENAME UNDER THEIR OLD NAMES, which is the one thing
--     that could have quietly cost the redemption path its index. Every statement
--     `db/repositories/enrollmentCodes.ts` prepares was run through EXPLAIN QUERY PLAN against a
--     database migrated to 093 and against the same database migrated through this file, and all
--     six plans are IDENTICAL — the same access path and the same index NAME:
--       byHash   SEARCH enrollment_codes USING INDEX sqlite_autoindex_enrollment_codes_2 (code_hash=?)
--       byId     SEARCH enrollment_codes USING INDEX sqlite_autoindex_enrollment_codes_1 (id=?)
--       consume  SEARCH enrollment_codes USING INDEX sqlite_autoindex_enrollment_codes_1 (id=?)
--       list     SCAN enrollment_codes + USE TEMP B-TREE FOR ORDER BY
--       anyOpen  SCAN enrollment_codes
--       byIssuer SCAN enrollment_codes + USE TEMP B-TREE FOR ORDER BY
--     (091's block records `SEARCH USING COVERING INDEX` for the by-id read. That is the plan for a
--     `SELECT id`, and the statement this module actually prepares selects ten columns, so it was
--     already the narrower query's plan before this file existed. Measured both ways on this host:
--     `SELECT id` covering, `SELECT id, label` not. Unchanged by the rebuild either way.)
--   · `byIssuer` IS THE ONE NEW STATEMENT AND IT GETS NO INDEX, for the reason 091 gives about the
--     other two scans: this table holds one row per intake an organisation has ever run — tens —
--     and it runs once, when an administrator is deleted. A third B-tree maintained on every
--     redemption to save scanning a single page on an account deletion is the wrong trade.
--   · `PRAGMA foreign_keys` is left ALONE. SQLite documents it as a no-op inside a transaction and
--     `exports/json.ts` has already measured that on this host; the standard advice to turn it off
--     around a rebuild is aimed at tables that are a PARENT, and nothing in this schema references
--     `enrollment_codes`. Dropping a child table is unconstrained.
--
-- THE COLUMN ORDER IS 091'S TEN FOLLOWED BY 092'S AND 093'S, which is the order the database
-- physically has today, and is preserved deliberately: a rebuild is a chance to tidy and tidying
-- would make `SELECT *` return its keys in a new order for no reason anybody asked for.
CREATE TABLE enrollment_codes_rebuilt (
  id                 TEXT PRIMARY KEY,
  -- Still UNIQUE, and still for both of 091's reasons: it builds the index the redemption lookup
  -- uses, and it makes two live codes with one digest a constraint failure at creation.
  code_hash          TEXT NOT NULL UNIQUE,
  label              TEXT NOT NULL,
  max_uses           INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  uses               INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at         TEXT,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL,
  -- THE ADMINISTRATOR WHO ISSUED THIS CODE, AS A FACT ABOUT THE PAST — no foreign key, so it may
  -- name somebody who has since been deleted, and NULL when the compose file issued it and there is
  -- no person to name. Nothing reads it as a capability: what a code can do is decided entirely by
  -- `revoked_at`, `expires_at` and `uses`.
  created_by_user_id TEXT,
  last_used_at       TEXT,
  chosen             INTEGER NOT NULL DEFAULT 0 CHECK (chosen IN (0, 1)),
  hash_scheme        TEXT NOT NULL DEFAULT 'sha256'
    CHECK (hash_scheme IN ('sha256', 'hmac-sha256'))
);

-- EVERY ROW MOVES WITH ITS DIGEST, ITS USES AND ITS EXPIRY. A rebuild that lost `code_hash` would
-- be `exports/json.ts`'s refused "ship the row without its digest" idea by another route: thirty
-- students each told their code is not valid, on a boot nobody asked for.
--
-- THE ONE VALUE THAT CHANGES IS THE ATTRIBUTION OF THE COMPOSE FILE'S OWN ROWS, and it changes to
-- the truth about them rather than to something convenient. `auth/chosenCode.ts` declares this
-- exact label and `isEnvCodeLabel` folds it the same way — trimmed and case-folded — which is how
-- `envEnrollmentCode.ts` recognises the file's row at every boot. The literal is repeated here
-- because a migration is a file SQLite runs and not a file that can import a constant, so
-- `auth/envEnrollmentCode.test.ts` reads THIS FILE and fails if the two ever stop being the same
-- string: a rename of `ENV_CODE_LABEL` would otherwise leave a migration silently re-attributing
-- nothing. Those rows were attributed to the oldest administrator because the schema demanded a
-- name, not because that person issued them.
--
-- THIS PASS RUNS ONCE, AND THERE IS ONE WAY BACK IN: restoring a backup WRITTEN BY A PRE-094 BUILD
-- into a database that has already run this migration. `exports/json.ts` inserts the columns a row
-- carries, so the file's code comes back naming whichever administrator that build recorded, and
-- deleting that person would then withdraw it — the boot after that would report the code closed
-- and would not reopen it, because a withdrawn code is never resurrected. It is stated rather than
-- special-cased: the failure is loud, it is in the boot log, it cannot let anybody in, and the
-- remedy is the one an operator already has for every closed code — put a new value on the line.
-- Teaching the restore path about `ENV_CODE_LABEL` would put this string in a third place.
INSERT INTO enrollment_codes_rebuilt
  (id, code_hash, label, max_uses, uses, expires_at, revoked_at, created_at, created_by_user_id,
   last_used_at, chosen, hash_scheme)
SELECT id, code_hash, label, max_uses, uses, expires_at, revoked_at, created_at,
       CASE
         WHEN lower(trim(label)) = lower('Set in docker-compose.yml (ENROLLMENT_CODE)') THEN NULL
         ELSE created_by_user_id
       END,
       last_used_at, chosen, hash_scheme
  FROM enrollment_codes;

DROP TABLE enrollment_codes;

ALTER TABLE enrollment_codes_rebuilt RENAME TO enrollment_codes;

-- ---------------------------------------------------------------------------------------------
-- THE POLICY, NOW SAID IN THE ONE PLACE THAT CANNOT BE ROUTED AROUND.
--
-- WHY THIS IS IN THE SCHEMA AND NOT ONLY IN THE DELETE ROUTE. `api/adminUsersRouter.ts` does revoke
-- these codes itself, with the injected clock and with an audit row for each, and that is the path
-- every deletion a person can perform takes. This trigger is what stops that from being a
-- CONVENTION. `test/userCascade.test.ts` exists because this project has three times leaned on a
-- correct observation about the present as a guarantee about the future, and the guarantee 091
-- bought with its cascade was schema-level: it held for a second delete route, for a script, for a
-- `sqlite3` shell. Replacing it with a line in one router would be exactly the downgrade that test
-- was written to catch, so what replaces it is also schema-level and the router's own revocation
-- becomes the readable, audited, correctly-clocked path rather than the only thing standing there.
--
-- IT REVOKES, IT DOES NOT DELETE, WHICH IS THE WHOLE POINT OF THE FILE.
--
-- THE PREDICATE IS `anyOpen`'s, NOT "everything not already revoked". It withdraws exactly the
-- codes that could still create an account, because that is the entire security claim: an account's
-- removal must leave no live credential behind. A code that had already expired or been used up is
-- left as it is, because it is already dead in a way that cannot reverse — expiry does not un-pass
-- and `uses` never decreases — and overwriting its state would replace "it expired on the 1st" with
-- "it was withdrawn on the 8th" in the sentence `describeClosure` shows a person. Revoking a corpse
-- buys nothing and costs the reason it died.
--
-- `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` AND NOT `datetime('now')`: every timestamp in this table
-- is written by `toISOString()`, `refusalFor` compares them LEXICOGRAPHICALLY, and `2026-08-11
-- 18:13:08` sorts before `2026-08-11T…` — a single space would make a whole column of comparisons
-- silently wrong. Measured on this host: this expression and `new Date().toISOString()` produced
-- `2026-08-11T18:13:08.845Z` within the same millisecond, character for character.
--
-- IT IS WALL CLOCK, AND THAT IS THE ONLY CLOCK THERE IS HERE. Every other write in this codebase
-- takes an injected `now`; a trigger has nothing injected into it. This is one more reason the
-- router revokes first: on the path a person actually takes, the timestamp is the request's clock
-- and the trigger finds nothing left to do.
--
-- WHAT IT DOES ON A RESTORE, said here rather than discovered. `exports/json.ts` empties the tables
-- in reverse `BACKUP_TABLES` order, so on a full restore `enrollment_codes` is emptied BEFORE
-- `users` and this trigger fires against nothing. A hand-made partial backup naming `users` without
-- `enrollment_codes` will withdraw the live codes of every user it replaces, and that is the safe
-- direction: the restore is asserting a new set of accounts, and a credential issued by an account
-- that this file does not restore is exactly what the policy above says must not stay live.
CREATE TRIGGER revoke_enrollment_codes_when_issuer_deleted
AFTER DELETE ON users
BEGIN
  UPDATE enrollment_codes
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE created_by_user_id = OLD.id
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     AND (max_uses IS NULL OR uses < max_uses);
END;
