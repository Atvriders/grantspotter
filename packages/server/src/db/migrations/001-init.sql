-- GrantSpotter initial schema. CONTRACT §6.
-- NOTE: PRAGMA foreign_keys is set on the connection in migrate.ts, not here:
-- SQLite ignores it inside the transaction that wraps each migration.

CREATE TABLE funders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  homepage    TEXT NOT NULL,
  ein         TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE programs (
  id                   TEXT PRIMARY KEY,
  funder_id            TEXT NOT NULL REFERENCES funders(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  klass                TEXT NOT NULL,
  summary              TEXT NOT NULL,
  applicant_entities   TEXT NOT NULL,   -- JSON ApplicantEntity[]
  amount               TEXT NOT NULL,   -- JSON AmountSpec
  deadline             TEXT NOT NULL,   -- JSON DeadlineSpec
  apply_via            TEXT NOT NULL,
  apply_url            TEXT,
  apply_contact        TEXT,
  funding_restrictions TEXT NOT NULL,   -- JSON string[]
  obligations          TEXT NOT NULL,   -- JSON Obligations
  ai_policy            TEXT NOT NULL,   -- JSON AiPolicy
  trust                TEXT NOT NULL,   -- JSON TrustFields
  raw_other_text       TEXT NOT NULL,
  tags                 TEXT NOT NULL,   -- JSON string[]
  -- Ingest identity (RESOLUTIONS R1/R9). The seed corpus owns program ids;
  -- the nightly crawler resolves an existing row through (source_id,
  -- external_key) instead of minting a fresh synthetic id, which would
  -- duplicate the entire corpus every night. Nullable: hand-curated records
  -- that no source module produces have neither.
  source_id            TEXT,
  external_key         TEXT,
  -- denormalised from `trust` so the browse list can filter and sort in SQL
  content_hash         TEXT NOT NULL,
  status               TEXT NOT NULL,
  last_verified_at     TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_programs_funder ON programs(funder_id);
CREATE INDEX idx_programs_klass  ON programs(klass);
CREATE INDEX idx_programs_status ON programs(status);
-- Partial: many rows have no source at all, and SQLite treats every NULL as
-- distinct in a plain UNIQUE index, so the WHERE clause keeps the index small
-- and its intent explicit.
CREATE UNIQUE INDEX programs_source_key ON programs(source_id, external_key) WHERE source_id IS NOT NULL;

CREATE TABLE constraints (
  id            TEXT PRIMARY KEY,
  program_id    TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  hard          INTEGER NOT NULL CHECK (hard IN (0, 1)),
  fallback_rank INTEGER NOT NULL,
  raw_text      TEXT NOT NULL,
  axis          TEXT NOT NULL,
  spec          TEXT NOT NULL            -- JSON ConstraintSpec
);
CREATE INDEX idx_constraints_program ON constraints(program_id);

CREATE TABLE cycles (
  id           TEXT PRIMARY KEY,
  program_id   TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  opens_at     TEXT,
  closes_at    TEXT,
  timezone     TEXT NOT NULL,
  label        TEXT NOT NULL,
  is_estimated INTEGER NOT NULL CHECK (is_estimated IN (0, 1))
);
CREATE INDEX idx_cycles_program ON cycles(program_id);
CREATE INDEX idx_cycles_closes  ON cycles(closes_at);

CREATE TABLE sources (
  id                    TEXT PRIMARY KEY,
  funder_id             TEXT,
  label                 TEXT NOT NULL,
  tier                  TEXT NOT NULL,
  klass                 TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  expected_min_records  INTEGER NOT NULL DEFAULT 0,
  baseline_record_count INTEGER,
  last_record_count     INTEGER,
  last_polled_at        TEXT,
  last_success_at       TEXT,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT NOT NULL DEFAULT ''
);

-- RESOLUTIONS R3: this is Plan 2's shape, adopted verbatim. Plan 2's
-- insertSnapshot supplies no id (autoincrement), writes body_bytes, and
-- writes file_path only when the body was spilled to disk — so `id` is
-- INTEGER AUTOINCREMENT, `body_path NOT NULL` is gone, and `file_path` is
-- nullable. Plan 2 deletes its duplicate CREATE TABLE IF NOT EXISTS.
CREATE TABLE snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  status       INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  body_sha256  TEXT NOT NULL,
  body_bytes   INTEGER NOT NULL DEFAULT 0,
  file_path    TEXT,
  fetched_at   TEXT NOT NULL
);
CREATE INDEX idx_snapshots_source ON snapshots(source_id, fetched_at);

CREATE TABLE change_events (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  program_id  TEXT,
  kind        TEXT NOT NULL,
  field_path  TEXT,
  before_json TEXT,
  after_json  TEXT,
  detected_at TEXT NOT NULL
);
CREATE INDEX idx_change_events_detected ON change_events(detected_at);
CREATE INDEX idx_change_events_program  ON change_events(program_id);

-- RESOLUTIONS R2: the column is `candidate_json`, not `candidate` — Plans 2
-- and 3 both already write and read that name. `created_at` carries a DEFAULT
-- because Plan 2's insertReviewItem does not supply it.
CREATE TABLE review_items (
  id              TEXT PRIMARY KEY,
  change_event_id TEXT NOT NULL REFERENCES change_events(id) ON DELETE CASCADE,
  candidate_json  TEXT NOT NULL,        -- JSON Program (ReviewItem.candidate)
  decision        TEXT NOT NULL DEFAULT 'pending',
  decided_by      TEXT,
  decided_at      TEXT,
  confidence      REAL NOT NULL DEFAULT 0,
  reject_key      TEXT,
  created_at      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_review_items_decision   ON review_items(decision);
CREATE INDEX idx_review_items_reject_key ON review_items(reject_key);

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  display_name     TEXT NOT NULL DEFAULT '',
  ics_token        TEXT NOT NULL UNIQUE,
  disabled         INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at       TEXT NOT NULL,
  last_login_at    TEXT
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,        -- sha256 of the raw session id
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE profiles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('student', 'organization')),
  data       TEXT NOT NULL,            -- JSON Profile
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, kind)
);

CREATE TABLE watches (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id     TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  notify_changes INTEGER NOT NULL DEFAULT 1 CHECK (notify_changes IN (0, 1)),
  created_at     TEXT NOT NULL,
  UNIQUE (user_id, program_id)
);

-- RESOLUTIONS R24: these two tables are Plan 1's, and the column list is
-- Plan 4's, adopted verbatim (db/repositories/applications.ts writes exactly
-- these names). Plan 4 ships no migration for these tables; it asserts this
-- shape with assertApplicationSchema(db) in db/repositories/applications.ts,
-- and no later migration may create either table: migrations run in filename
-- order, so a later `CREATE TABLE IF NOT EXISTS applications` is a silent
-- no-op against the table this file already made, and every Plan 4 insert
-- then dies at runtime on `table applications has no column named
-- answers_json`. The same trap applies to indexes — SQLite matches
-- `IF NOT EXISTS` on the NAME, so idx_applications_user and
-- idx_template_instances_application are declared exactly once: here.
CREATE TABLE applications (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Nullable on purpose: a draft exists before a programme is chosen. ON
  -- DELETE SET NULL rather than CASCADE or RESTRICT, because approving a
  -- `vanished` review item deletes the programme (RESOLUTIONS R26) and
  -- neither destroying the applicant's draft nor blocking that delete on a
  -- foreign key is acceptable.
  program_id              TEXT NULL REFERENCES programs(id) ON DELETE SET NULL,
  title                   TEXT NOT NULL,
  body_markdown           TEXT NOT NULL DEFAULT '',
  answers_json            TEXT NOT NULL DEFAULT '{}',   -- JSON Record<string, string>
  fact_confirmations_json TEXT NOT NULL DEFAULT '{}',   -- JSON Record<string, FactConfirmation>
  include_disclosure      INTEGER NOT NULL DEFAULT 1,
  facts_confirmed_at      TEXT,                         -- set only while every fact is confirmed
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX idx_applications_user ON applications(user_id, updated_at DESC);

CREATE TABLE template_instances (
  id                    TEXT PRIMARY KEY,
  application_id        TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  template_id           TEXT NOT NULL,
  position              INTEGER NOT NULL,
  filled_markdown       TEXT NOT NULL,
  unresolved_slots_json TEXT NOT NULL DEFAULT '[]',     -- JSON string[] (FilledTemplate.unresolvedSlots)
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_template_instances_application ON template_instances(application_id, position);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_at ON audit_log(at);
