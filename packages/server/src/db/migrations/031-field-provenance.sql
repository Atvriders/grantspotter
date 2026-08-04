-- Plan 3: field-level provenance (spec §8). One row per raw label captured from
-- a source, keyed to the Program field path it populated.
--
-- `field_provenance` and `idx_fp_program` are both NEW names. SQLite matches
-- `IF NOT EXISTS` on the name alone, so reusing a name declared in an earlier
-- migration would make the statement a silent no-op and the shape below would
-- never exist; `db/schemaConformance.test.ts` scans every migration on disk for
-- a repeated table or index name and fails by name.
--
-- `source_url` is a DEVIATION FROM THE TASK BRIEF, resolved towards spec §8
-- ("which source, which fetch, and the raw text the value came from"). The
-- brief's seven columns record which SOURCE MODULE a value came from but never
-- which PAGE, and `snapshot_id` cannot stand in for it: it is nullable, and
-- Task 10 — the only production caller of `recordProvenance` in this plan —
-- passes `null` on every verify. Nullable here so that the explicit
-- seven-column INSERTs in Tasks 8 and 10 keep working unchanged.
CREATE TABLE IF NOT EXISTS field_provenance (
  program_id  TEXT NOT NULL,
  field_path  TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  snapshot_id TEXT,
  raw_label   TEXT NOT NULL,
  raw_value   TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  source_url  TEXT,
  PRIMARY KEY (program_id, source_id, raw_label)
);

-- DEVIATION FROM THE TASK BRIEF (2026-08-03). The brief adds
-- `CREATE INDEX idx_fp_program ON field_provenance (program_id)`. It is not
-- here, because the PRIMARY KEY above already indexes `program_id` — it is the
-- leftmost column of the implicit `sqlite_autoindex_field_provenance_1`.
--
-- The name does not collide with anything (checked against 001-init.sql and
-- every 0NN-*.sql, and `schemaConformance.test.ts`'s declared-exactly-once scan
-- is green), so this is NOT the silent-no-op trap that bit 032 and 033. It is
-- the other half of that question: an index whose read is already covered.
--
-- Measured with EXPLAIN QUERY PLAN on a migrated database rather than reasoned
-- about. `loadProvenance`'s query, WITH the brief's index:
--   SEARCH field_provenance USING INDEX idx_fp_program (program_id=?)
-- and with it dropped:
--   SEARCH field_provenance USING INDEX sqlite_autoindex_field_provenance_1 (program_id=?)
-- Same access path, same temp B-tree for the ORDER BY, one fewer index to
-- maintain on every `recordProvenance` write. Task 8's fan-out join
-- (`JOIN field_provenance fp ON fp.program_id = w.program_id WHERE fp.source_id = ?`)
-- and this file's own DELETE both already choose the PK index over the brief's,
-- so neither loses anything either.
