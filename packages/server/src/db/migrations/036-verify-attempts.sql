-- Plan 3: per-user Verify-now rate limiting (spec §12: members are rate-limited).
--
-- One row per ATTEMPT, not per success. A refetch that the funder's site refused
-- still cost that site a request, so it still counts against the caller's budget;
-- charging only successes would turn the button into a retry hammer aimed at
-- whichever small volunteer-run server is currently having a bad day.
--
-- `verify_attempts` and `idx_verify_user_time` are both NEW names. SQLite matches
-- `IF NOT EXISTS` on the name alone, so a name already declared by an earlier
-- migration would make these statements silent no-ops and the shape below would
-- never exist; `db/schemaConformance.test.ts` scans every migration on disk for a
-- repeated table or index name and fails by name.
--
-- No foreign key to `users`: the ledger is a politeness record about traffic we
-- sent to somebody else's server, and it must not be erased by an account
-- deletion cascade while the request it describes is still fresh in the window.
CREATE TABLE IF NOT EXISTS verify_attempts (
  user_id      TEXT NOT NULL,
  program_id   TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);

-- Both queries in `checkVerifyRateLimit` lead with user_id and then range over
-- attempted_at; the per-program cooldown filters program_id out of that range.
CREATE INDEX IF NOT EXISTS idx_verify_user_time ON verify_attempts (user_id, attempted_at);
