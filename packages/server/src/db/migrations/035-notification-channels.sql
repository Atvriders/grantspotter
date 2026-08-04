-- Plan 3, Task 9: optional delivery channels. In-app is the default and is
-- always available; everything here is opt-in.
--
-- There is deliberately NO SMTP column. Spec §11.2 makes mail optional and
-- never required, Plan 3 does not implement it, and an unused credential
-- column is a liability that invites someone to start writing secrets into it.
-- Nothing dangles: no code in this plan reads a column that does not exist.
--
-- `notification_channels`, `notification_channel_health` and both indexes are
-- NEW names. SQLite matches `IF NOT EXISTS` on the NAME alone, so reusing a
-- name declared in an earlier migration would make the statement a silent
-- no-op and the shape below would never exist; `db/schemaConformance.test.ts`
-- scans every migration on disk for a repeated table or index name.
--
-- DEVIATION FROM THE TASK BRIEF (2026-08-02): the brief's DDL has a bare
-- `user_id TEXT PRIMARY KEY` with no foreign key. A webhook URL is an outbound
-- destination this deployment will POST to on a schedule, so a row that
-- outlives its account is a live endpoint with no owner — and `openDatabase`
-- sets `PRAGMA foreign_keys = ON`, so the cascade Plan 1 gives `watches` and
-- `profiles` (RESOLUTIONS R19) is available here for free. Test fixtures must
-- therefore seed the `users` row first, exactly as they already do for
-- `watches`.
CREATE TABLE IF NOT EXISTS notification_channels (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  in_app      INTEGER NOT NULL DEFAULT 1 CHECK (in_app IN (0, 1)),
  webhook_url TEXT,
  ntfy_server TEXT,
  ntfy_topic  TEXT,
  updated_at  TEXT NOT NULL
);

-- SECOND DEVIATION, and the reason this task ships two tables.
--
-- `deliverExternal` returns a `DeliveryResult[]` and the brief stores it
-- nowhere. That is this repo's signature defect — a value computed and never
-- read — in its most consequential form: a webhook that has 500'd every night
-- for a week produces exactly the same user-visible state as a week in which
-- no grant deadline moved. Silence would then mean both "nothing happened" and
-- "the pipeline is broken", and a user cannot act on a notification that never
-- arrived.
--
-- One row per (user, channel), holding the same health vocabulary Plan 1
-- already uses on `sources` (`last_polled_at` / `last_success_at` /
-- `consecutive_failures`), so the sources health page and this read the same
-- way. Keyed by channel rather than widened into `notification_channels` so a
-- third channel needs no DDL, and so a delete of the config does not erase the
-- record of why it was deleted.
CREATE TABLE IF NOT EXISTS notification_channel_health (
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL CHECK (channel IN ('webhook', 'ntfy')),
  last_attempt_at      TEXT NOT NULL,
  last_ok_at           TEXT,
  last_status          INTEGER,
  last_error           TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel)
);

-- The composite primary key already indexes (user_id, channel), which is the
-- only direction `loadDeliveryHealth` asks in. This index serves the other
-- one: "which users' deliveries are currently broken", the question an
-- operator asks across the whole deployment.
CREATE INDEX IF NOT EXISTS idx_nch_failing
  ON notification_channel_health (consecutive_failures)
  WHERE consecutive_failures > 0;
