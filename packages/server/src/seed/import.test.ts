/**
 * The first-run corpus import.
 *
 * Two things are being proved here, and both are failures this project has already had:
 *
 *   1. THE IMPORT IS IDEMPOTENT. A container that restarts must not double its corpus, and must
 *      not revert a record an operator has reviewed and edited.
 *   2. THE IMPORT RUNS AGAINST A GENUINELY EMPTY, GENUINELY PRODUCTION-SHAPED DATABASE. These
 *      tests open the database through `openDatabase`, the same function `index.ts` calls, so
 *      `foreign_keys = ON` is really on. `new Database(':memory:')` leaves that pragma OFF, and a
 *      suite that used one would not notice an importer that wrote `programs` before `funders` —
 *      which is exactly how the first approve on a fresh install came to crash, hidden because
 *      the tests that covered it hand-wrote the `funders` INSERT the product never performed.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/migrate.js';
import { migrate, openDatabase } from '../db/migrate.js';
import { isDoNotPublish } from '../normalize/index.js';
import { importSeedIfEmpty } from './import.js';
import { loadSeedCorpus, publishableSeedPrograms, seedDir } from './load.js';

let db: Db;
let dataDir: string;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  dataDir = tempDir('grantspotter-import-');
  db = openDatabase(join(dataDir, 'test.sqlite'));
  migrate(db);
});

afterEach(() => {
  db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function countPrograms(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n;
}

describe('importSeedIfEmpty', () => {
  it('runs against a database with foreign keys really enforced', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('imports the whole corpus into an empty database', () => {
    const corpus = loadSeedCorpus(seedDir());
    const result = importSeedIfEmpty(db);
    expect(result.imported).toBe(true);
    expect(result.programs).toBe(corpus.programs.length);
    expect(result.programs).toBeGreaterThanOrEqual(100);
    expect(result.funders).toBe(corpus.funders.length);
    expect(result.funders).toBeGreaterThanOrEqual(20);
    expect(countPrograms()).toBe(result.programs);
    expect((db.prepare('SELECT COUNT(*) AS n FROM funders').get() as { n: number }).n).toBe(
      result.funders,
    );
  });

  /**
   * The funders are the point. Every `programs.funder_id` is `REFERENCES funders(id)` and the
   * pragma above is on, so an importer that wrote programs first — or that left the funder rows
   * to some later path — throws here instead of silently producing a corpus whose first approve
   * crashes.
   */
  it('creates the funder row every program points at', () => {
    importSeedIfEmpty(db);
    const orphans = db
      .prepare('SELECT p.id FROM programs p LEFT JOIN funders f ON f.id = p.funder_id WHERE f.id IS NULL')
      .all();
    expect(orphans).toEqual([]);
  });

  it('is a no-op on a database that already holds programs', () => {
    importSeedIfEmpty(db);
    const before = countPrograms();
    const second = importSeedIfEmpty(db);
    expect(second.imported).toBe(false);
    expect(second.reason).toContain('already');
    expect(countPrograms()).toBe(before);
  });

  /**
   * The idempotency proof, stated the way a restart states it: run it twice and compare the
   * whole table, not just its size. A second import that overwrote rows in place would keep the
   * count identical and still throw away an operator's review.
   */
  it('leaves every stored row untouched on a second run', () => {
    importSeedIfEmpty(db);
    db.prepare("UPDATE programs SET status = 'contact_only' WHERE id = 'ardc-grants'").run();
    const before = db.prepare('SELECT * FROM programs ORDER BY id').all();

    const second = importSeedIfEmpty(db);
    expect(second.imported).toBe(false);
    expect(db.prepare('SELECT * FROM programs ORDER BY id').all()).toEqual(before);
    expect(
      (db.prepare("SELECT status FROM programs WHERE id = 'ardc-grants'").get() as { status: string })
        .status,
    ).toBe('contact_only');
  });

  it('re-imports when forced, and still does not duplicate', () => {
    const first = importSeedIfEmpty(db);
    const forced = importSeedIfEmpty(db, { force: true });
    expect(forced.imported).toBe(true);
    expect(forced.programs).toBe(first.programs);
    expect(countPrograms()).toBe(first.programs);
  });

  it('stores the computed content hash, not an empty string', () => {
    importSeedIfEmpty(db);
    const rows = db.prepare('SELECT id, content_hash FROM programs').all() as Array<{
      id: string;
      content_hash: string;
    }>;
    expect(rows.length).toBeGreaterThan(100);
    for (const row of rows) expect(row.content_hash, row.id).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * RESOLUTIONS R9. Without this pair on the row, Plan 2's `normalizeRaw` cannot resolve the
   * seeded record and mints a fresh id for it, so the first nightly crawl inserts a second copy
   * of every seeded record and the second crawl inserts a third. Task 11 found the same class of
   * defect one level up: the ARDC anchor's `externalKey` was written `grants` where the module
   * emits `apply`, which would have duplicated every ARDC record on the first crawl.
   */
  it('binds each seeded record to the crawler identity that owns it', () => {
    const corpus = loadSeedCorpus(seedDir());
    const result = importSeedIfEmpty(db);
    expect(result.sourceKeys).toBe(corpus.sourceKeys.size);
    expect(result.sourceKeys).toBeGreaterThan(100);

    const scholarships = db
      .prepare("SELECT source_id, external_key FROM programs WHERE id = 'arrl-foundation-scholarships'")
      .get() as { source_id: string; external_key: string };
    expect(scholarships).toEqual({
      source_id: 'arrl-scholarship-program',
      external_key: 'scholarship-program',
    });

    const catalog = db
      .prepare(
        "SELECT COUNT(*) AS n FROM programs WHERE id LIKE 'arrl-cat-%' AND source_id = 'arrl-scholarship-descriptions'",
      )
      .get() as { n: number };
    expect(catalog.n).toBe(111);

    for (const [programId, key] of corpus.sourceKeys) {
      const row = db
        .prepare('SELECT source_id, external_key FROM programs WHERE id = ?')
        .get(programId) as { source_id: string; external_key: string };
      expect(row, programId).toEqual({ source_id: key.sourceId, external_key: key.externalKey });
    }
  });

  /**
   * Two records will legitimately carry no crawler identity once Tasks 12 and 13 land — the
   * `austin-arc` module emits one page-level record while the seed splits Austin ARC into
   * Copeland and Greenwood, and `ieee-mtts` emits only its chapter-support record. Inventing a
   * key no parser emits would fail to reconcile while looking correct.
   */
  it('leaves source_id null only for records no source module re-reads', () => {
    const corpus = loadSeedCorpus(seedDir());
    importSeedIfEmpty(db);
    const rows = db
      .prepare('SELECT id FROM programs WHERE source_id IS NULL ORDER BY id')
      .all() as Array<{ id: string }>;
    const expected = corpus.programs
      .filter((p) => !corpus.sourceKeys.has(p.id))
      .map((p) => p.id)
      .sort();
    expect(rows.map((r) => r.id)).toEqual(expected);
    for (const id of expected) {
      expect(['austin-arc-greenwood', 'ieee-mtt-s-student-awards']).toContain(id);
    }
  });

  it('never lets two records claim one crawler identity, which the partial unique index forbids', () => {
    importSeedIfEmpty(db);
    const dupes = db
      .prepare(
        `SELECT source_id, external_key, COUNT(*) AS n FROM programs
         WHERE source_id IS NOT NULL GROUP BY source_id, external_key HAVING n > 1`,
      )
      .all();
    expect(dupes).toEqual([]);
  });

  /**
   * THE SUPPRESSION BOUNDARY (six leaks, every one a private filter at a read site). The
   * importer writes EVERY record, including the ones tagged `do_not_publish` — a funder's grant
   * history is the best evidence of who that funder funds, so those rows are stored deliberately
   * and hidden at the read boundaries. The corpus that ships today carries none of them (Task 14
   * adds the suppressed batches), so this test supplies one rather than asserting over an empty
   * set, and asks `isDoNotPublish` — the one predicate — whether it is suppressed.
   */
  it('stores a suppressed record rather than dropping it at import', () => {
    const dir = tempDir('grantspotter-seed-dnp-');
    for (const file of readdirSync(seedDir())) {
      if (file.endsWith('.json')) writeFileSync(join(dir, file), readFileSync(join(seedDir(), file)));
    }
    const curated = JSON.parse(readFileSync(join(dir, 'programs.curated.json'), 'utf8')) as {
      programs: Array<Record<string, unknown>>;
    };
    const donor = curated.programs.find((p) => p.id === 'arrl-etp-grants');
    expect(donor).toBeDefined();
    const suppressed: Record<string, unknown> = {
      ...structuredClone(donor!),
      id: 'probe-past-award',
      name: 'Probe past award',
      tags: [...(donor!.tags as string[]), 'do_not_publish'],
    };
    delete suppressed.sourceKey; // one crawler identity per record; this copy claims none
    curated.programs.push(suppressed);
    writeFileSync(join(dir, 'programs.curated.json'), JSON.stringify(curated, null, 2), 'utf8');

    const corpus = loadSeedCorpus(dir);
    const stored = corpus.programs.find((p) => p.id === 'probe-past-award');
    expect(stored).toBeDefined();
    expect(isDoNotPublish(stored!)).toBe(true);

    const result = importSeedIfEmpty(db, { dir });
    expect(result.programs).toBe(corpus.programs.length);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM programs WHERE id = 'probe-past-award'").get(),
    ).toEqual({ n: 1 });
    expect(result.reason).toContain('1 suppressed');
  });

  /**
   * The counts a real install ends with. Derived from the corpus through `publishableSeedPrograms`
   * — a call to the shared `isDoNotPublish`, never a second filter — so this asserts the shipped
   * numbers without freezing them while Tasks 12-14 are still adding batches. When the whole
   * corpus has landed these are 150 publishable and ~553 suppressed.
   */
  it('stores every record, publishable and suppressed alike', () => {
    const corpus = loadSeedCorpus(seedDir());
    const publishable = publishableSeedPrograms(corpus.programs).length;
    const suppressed = corpus.programs.length - publishable;

    const result = importSeedIfEmpty(db);
    expect(result.programs).toBe(publishable + suppressed);
    expect(countPrograms()).toBe(publishable + suppressed);

    const storedTags = (
      db.prepare('SELECT id, tags FROM programs').all() as Array<{ id: string; tags: string }>
    ).map((row) => ({ id: row.id, tags: JSON.parse(row.tags) as string[] }));
    expect(storedTags.filter((p) => isDoNotPublish(p)).length).toBe(suppressed);
    expect(storedTags.filter((p) => !isDoNotPublish(p)).length).toBe(publishable);
  });

  it('writes nothing at all when the corpus cannot be loaded', () => {
    expect(() => importSeedIfEmpty(db, { dir: join(dataDir, 'no-such-seed-dir') })).toThrow();
    expect(countPrograms()).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM funders').get() as { n: number }).n).toBe(0);
  });

  /**
   * A failure PART WAY THROUGH the writes, not before them: a row already holding one of the
   * corpus's crawler identities makes the partial unique index reject that record's insert, and
   * the whole import must roll back rather than leave a half-corpus behind.
   */
  it('rolls back every write when one record fails mid-import', () => {
    const now = '2026-08-02T00:00:00.000Z';
    db.prepare(
      `INSERT INTO funders (id, name, homepage, created_at, updated_at)
       VALUES ('arrl-foundation', 'Decoy', 'https://example.com', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO programs (id, funder_id, name, klass, summary, applicant_entities, amount,
                             deadline, apply_via, funding_restrictions, obligations, ai_policy,
                             trust, raw_other_text, tags, source_id, external_key, content_hash,
                             status, last_verified_at, created_at, updated_at)
       VALUES ('decoy', 'arrl-foundation', 'Decoy', 'ham_scholarship', 'decoy', '[]', '{}', '{}',
               'none', '[]', '{}', '{}', '{}', '', '[]', 'arrl-scholarship-program',
               'scholarship-program', 'deadbeef', 'unknown', '2026-08-02', ?, ?)`,
    ).run(now, now);

    expect(() => importSeedIfEmpty(db, { force: true })).toThrow();
    const rows = db.prepare('SELECT id FROM programs').all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['decoy']);
    // The funders written inside the same transaction went back too — all but the decoy's own.
    const funders = db.prepare('SELECT id FROM funders').all() as Array<{ id: string }>;
    expect(funders.map((f) => f.id)).toEqual(['arrl-foundation']);
  });

  it('reports what it did in a sentence an operator can read at boot', () => {
    const result = importSeedIfEmpty(db);
    expect(result.reason).toMatch(/\d+ programs/);
    expect(result.reason).toMatch(/\d+ funders/);
    expect(result.reason).toContain('2026-08-02');
  });
});
