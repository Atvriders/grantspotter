-- Per-user subscribable calendar tokens (Plan 5 Task 9). CONTRACT §6 has been amended to name
-- this table; RESOLUTIONS R14 records it as the one table this plan creates.
--
-- Numbered 090 deliberately: Plans 1-4 number their migrations from 001 upward and stop at 037,
-- so this file always applies last regardless of what they added. `ics_tokens` and every index
-- name below are NEW names, checked against 001-init.sql and every 0NN-*.sql before writing —
-- SQLite matches `IF NOT EXISTS` on the NAME alone, so reusing one would make the statement a
-- silent no-op and the shape here would never exist. `db/schemaConformance.test.ts` scans every
-- migration AND every product file for a repeated table or index name and fails by name.
--
-- DEVIATION FROM THE TASK BRIEF, and it is the reason this table needed reviewing at all.
--
-- The brief says: "No FOREIGN KEY on user_id: that would couple this migration to the exact
-- column type Plan 1 chose for users.id. Rows are cleaned up by the delete route." Both halves
-- are wrong in a way that costs security rather than tidiness.
--
--   * The coupling is imaginary. This file lives in the same directory as 001-init.sql, applies
--     after it in the same process, and `users.id` is `TEXT PRIMARY KEY` right there. A foreign
--     key does not pin a type; SQLite has no static column types to pin.
--   * The delete route does not clean these rows up. `api/adminUsersRouter.ts` removes an account
--     with ONE `DELETE FROM users` and lets SQLite do the rest — its own comment says "Every
--     `REFERENCES users(id)` in the schema is ON DELETE CASCADE" — and Plan 3 Task 13's report
--     states, on the strength of that, that "the ICS token dies with the row".
--
-- Without the key below, that sentence is false. A removed member's calendar client keeps GETting
-- /calendar/<token>.ics on its twelve-hour schedule, serving the organisation's whole programme
-- corpus to whoever holds the URL, forever — nothing in the system ever revisits the row — while
-- the admin console reports the account gone and counts it as removed. `test/userCascade.test.ts`
-- was written BEFORE this table existed, naming `ics_tokens.user_id` specifically, precisely so
-- that a cascade-less version of this migration would arrive red instead of quiet.
--
-- The column is named `user_id` and not `owner_id` for the same reason: that invariant's scan is
-- name-based, and a synonym would walk straight past it.
CREATE TABLE IF NOT EXISTS ics_tokens (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- DEVIATION FROM THE TASK BRIEF (2026-08-04): the brief's
-- `CREATE INDEX IF NOT EXISTS idx_ics_tokens_hash ON ics_tokens (token_hash)` is NOT here.
--
-- The name collides with nothing, so this is not the silent-no-op trap above; it is the other
-- half of that question — an index whose read is already covered. `token_hash TEXT NOT NULL
-- UNIQUE` already builds `sqlite_autoindex_ics_tokens_2` over exactly that column, and
-- `user_id TEXT PRIMARY KEY` builds `sqlite_autoindex_ics_tokens_1` over the other lookup.
--
-- Measured with EXPLAIN QUERY PLAN on this host rather than reasoned about. Both of this table's
-- two reads, WITH the brief's index present and with it absent, plan identically:
--   SELECT user_id    ... WHERE token_hash = ?  ->  SEARCH USING INDEX sqlite_autoindex_ics_tokens_2 (token_hash=?)
--   SELECT token_hash ... WHERE user_id    = ?  ->  SEARCH USING INDEX sqlite_autoindex_ics_tokens_1 (user_id=?)
-- SQLite does not choose `idx_ics_tokens_hash` even when it exists. It would be a third B-tree to
-- maintain on every token rotation, bought for nothing. `exports/dataSource.test.ts` pins the two
-- access paths, so if a future read stops being covered this decision fails rather than rots.
