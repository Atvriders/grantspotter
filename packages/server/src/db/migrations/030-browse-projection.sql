-- Plan 3: denormalized browse projection.
-- Rebuilt wholesale by reindexBrowse(); never edited row-by-row.
--
-- Both tables and all seven indexes are NEW NAMES. SQLite matches
-- `IF NOT EXISTS` on the name alone, so a name Plan 1's 001-init.sql already
-- uses would make the statement below a silent no-op and the shape would never
-- exist — see the RESOLUTIONS R23 note in db/ingestSchema.ts, which is the same
-- trap with `idx_snapshots_source`. `db/schemaConformance.test.ts` now scans
-- every migration on disk for a repeated table or index name and fails by name,
-- so this comment has a test behind it.

CREATE TABLE IF NOT EXISTS program_search (
  program_id        TEXT PRIMARY KEY,
  funder_id         TEXT NOT NULL,
  funder_name       TEXT NOT NULL,
  name              TEXT NOT NULL,
  klass             TEXT NOT NULL,
  status            TEXT NOT NULL,
  instrument        TEXT NOT NULL,
  amount_min        INTEGER,
  amount_max        INTEGER,
  deadline_kind     TEXT NOT NULL,
  next_opens_at     TEXT,
  next_closes_at    TEXT,
  next_is_estimated INTEGER NOT NULL DEFAULT 0,
  last_verified_at  TEXT NOT NULL,
  haystack          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS program_facets (
  program_id  TEXT NOT NULL,
  facet_kind  TEXT NOT NULL,   -- 'entity' | 'tag'
  facet_value TEXT NOT NULL,
  PRIMARY KEY (program_id, facet_kind, facet_value)
);

CREATE INDEX IF NOT EXISTS idx_ps_klass       ON program_search (klass);
CREATE INDEX IF NOT EXISTS idx_ps_status      ON program_search (status);
CREATE INDEX IF NOT EXISTS idx_ps_instrument  ON program_search (instrument);
CREATE INDEX IF NOT EXISTS idx_ps_closes      ON program_search (next_closes_at);
CREATE INDEX IF NOT EXISTS idx_ps_amount      ON program_search (amount_min, amount_max);
CREATE INDEX IF NOT EXISTS idx_ps_verified    ON program_search (last_verified_at);
CREATE INDEX IF NOT EXISTS idx_pf_lookup      ON program_facets (facet_kind, facet_value);
