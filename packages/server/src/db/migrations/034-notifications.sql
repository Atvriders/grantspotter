-- Plan 3, Task 8: the in-app digest. Change events fan out to the users
-- watching the affected program. `change_event_fanout` is the idempotency
-- ledger - it is why the drain can be called from anywhere (the nightly crawl,
-- a "Verify now", an Inbox approval), repeatedly, without duplicating, and none
-- of those three has to know notifications exist.
--
-- `notifications` and `change_event_fanout`, and all three index names below,
-- are NEW names. SQLite matches `IF NOT EXISTS` on the name alone, so reusing a
-- name declared in an earlier migration would make the statement a silent no-op
-- and the shape here would never exist; `db/schemaConformance.test.ts` scans
-- every migration on disk for a repeated table or index name and fails by name.
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  -- ON DELETE CASCADE: recipients are read out of `watches`, whose own
  -- user_id cascades from `users`, so a deleted account cannot leave a digest
  -- behind that nobody can read or clear.
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  change_event_id TEXT,
  -- The source that raised the event. Source-scoped alarms (a parser yield
  -- drop) have no program_id at all, and it is the only thing that tells the
  -- reader WHICH source went quiet. It is also half of the duplicate key that
  -- stops a nightly alarm being re-delivered every night.
  source_id       TEXT,
  -- DELIBERATELY NOT A FOREIGN KEY, unlike user_id. RESOLUTIONS R26: approving
  -- a `vanished` event DELETES the program row, and "this program disappeared
  -- from its funder's site" is the single most important thing the digest ever
  -- says. A REFERENCES ... ON DELETE CASCADE would delete exactly that
  -- notification; a plain REFERENCES would refuse to write it in the first
  -- place, because the row is already gone by the time the drain runs.
  program_id      TEXT,
  -- Denormalised for the same reason: after the row is deleted there is
  -- nowhere left to read the name from.
  program_name    TEXT,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  field_path      TEXT,
  -- The RENDERED before/after (see `describeChange`), never the raw JSON: this
  -- table is what a student reads. `change_events.before_json` remains the
  -- ledger of record for an operator.
  before_text     TEXT,
  after_text      TEXT,
  created_at      TEXT NOT NULL,
  read_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications (user_id, read_at);

-- One row per change event, written whether or not anyone was told. That is
-- the point: a user's empty digest cannot distinguish "nothing changed" from
-- "the drain never ran" from "every alarm reached nobody", so the counters
-- below are what `fanoutHealth` reads to tell those three apart. Suppressing
-- noise is only safe while a silently-broken source stays visible here.
CREATE TABLE IF NOT EXISTS change_event_fanout (
  change_event_id   TEXT PRIMARY KEY,
  fanned_out_at     TEXT NOT NULL,
  recipient_count   INTEGER NOT NULL,
  -- How many watchers were NOT told, and why: 'muted' (the star's
  -- notify_changes is 0), 'duplicate_unread' (the same alarm is already
  -- sitting unread in that user's digest), 'not_publishable' (the record
  -- carries do_not_publish, so there is no page to send them to). When an
  -- event suppresses for more than one reason the column names the dominant
  -- one in that order and the count is the total.
  suppressed_count  INTEGER NOT NULL DEFAULT 0,
  suppressed_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_fanout_at ON change_event_fanout (fanned_out_at);
