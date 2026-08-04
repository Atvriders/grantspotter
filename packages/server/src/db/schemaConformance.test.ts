import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { MIGRATIONS_DIR } from './migrate.js';

// ------------------------------------------------------- the DDL scan, wherever the DDL lives

/**
 * WHY THE SCAN IS NO LONGER `migrations/*.sql` (close-out review, verdict 10).
 *
 * "Binds for `migrations/`. `schemaConformance.test.ts:122` globs MIGRATIONS_DIR only — and
 * `db/ingestSchema.ts:31,76` runs CREATE TABLE / CREATE INDEX outside it, which is **where the
 * original defect lived**."
 *
 * That is exact. `ingestSchema.ts`'s own header describes the very defect: it used to run
 * `CREATE TABLE IF NOT EXISTS programs (...)` with its own column list, which no-opped against the
 * migrated database and produced `SQLITE_CONSTRAINT: NOT NULL constraint failed: programs.summary`
 * on the first nightly crawl. The check written to make that impossible could not see the file it
 * happened in. Five recurrences of the same trap are on record in this project (`programs`,
 * `idx_snapshots_source`, the R24 `applications` note, and the two the header names).
 *
 * So the scan now DISCOVERS its own inputs: every migration, plus every non-test TypeScript file
 * under `packages/server/src` that declares a table or an index, found by reading them rather than
 * by a list somebody maintains. `db/migrate.ts` (`schema_migrations`) and `db/ingestSchema.ts`
 * (`review_rejects`, `idx_audit_entity`) are both in it today; a sixth recurrence in a seventh file
 * would be too.
 *
 * TEST FILES ARE EXCLUDED, deliberately and narrowly: `api/applications.test.ts` builds a
 * DELIBERATELY partial schema in its own `:memory:` database to prove the trap fires, so scanning
 * it would fail this invariant for demonstrating it. Nothing a test file execs can reach the
 * production database — the ordering hazard is between statements run at BOOT, and no test file
 * runs at boot.
 */
const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every `CREATE` of a named schema object. WIDER THAN THE OLD `(table|index)` PATTERN, which the
 * review noted "misses CREATE TEMP TABLE, quoted identifiers, CREATE VIEW, CREATE VIRTUAL TABLE" —
 * every one of those shares SQLite's single schema namespace, so every one of them can be the
 * silent second declaration. `unparsedCreates` below is the guard on the guard: anything spelled
 * `create` that this pattern does NOT understand is reported rather than skipped, because a
 * pattern that silently `continue`s is how the contrast invariant was defeated.
 */
const DDL = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:temp(?:orary)?\s+)?` +
    String.raw`(table|index|view|virtual\s+table|trigger)\s+(?:if\s+not\s+exists\s+)?` +
    String.raw`([a-z0-9_]+|"[^"]+"|` + '`[^`]+`' + String.raw`|\[[^\]]+\])`,
  'gi',
);

/** Prose about creating a table is not creating a table. Strips SQL `--` and TS comments alike. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/--[^\n]*/g, '');
}

/** `CREATE VIRTUAL TABLE` occupies the same namespace as `CREATE TABLE`; so does a TEMP one. */
function normaliseKey(kind: string, name: string): string {
  const k = kind.toLowerCase().replace(/\s+/g, ' ') === 'virtual table' ? 'table' : kind.toLowerCase();
  return `${k} ${name.replace(/^["`[]|["`\]]$/g, '').toLowerCase()}`;
}

interface DdlFile {
  /** Repo-relative-ish label used in failure messages. */
  where: string;
  text: string;
}

/**
 * Every string / template literal in a TypeScript file. Comments are already gone; what is left is
 * code, and DDL in code always lives inside a literal.
 */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const quote = src[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      i += 1;
      continue;
    }
    let j = i + 1;
    let buf = '';
    while (j < src.length && src[j] !== quote) {
      if (src[j] === '\\') {
        buf += src[j] + (src[j + 1] ?? '');
        j += 2;
        continue;
      }
      buf += src[j];
      j += 1;
    }
    out.push(buf);
    i = j + 1;
  }
  return out;
}

/**
 * WHY A LITERAL HAS TO LOOK LIKE A STATEMENT TO BE SCANNED.
 *
 * `db/repositories/applications.ts` throws an error whose message ARGUES FOR this very rule —
 * "SQLite matches CREATE TABLE IF NOT EXISTS on the name, so the second definition silently never
 * runs" — and scanning its raw text declared four phantom objects (`table in`, `table on`,
 * `index statements`, …) and reported the sentence itself as an unreadable CREATE. English prose
 * that mentions DDL is not DDL. A literal that BEGINS with a SQL statement keyword is; one that
 * begins mid-sentence is not, and no statement this codebase execs begins mid-sentence.
 */
const SQL_STATEMENT = /^\s*(?:create|alter|drop|pragma|insert|replace|update|delete|select|with|begin)\b/i;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Every file this invariant reads: all migrations, plus every product file that declares DDL. */
function ddlFiles(): DdlFile[] {
  const files: DdlFile[] = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({
      where: `migrations/${f}`,
      text: stripComments(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')),
    }));

  for (const abs of tsFilesUnder(SERVER_SRC)) {
    const text = stringLiterals(stripComments(readFileSync(abs, 'utf8')))
      .filter((lit) => SQL_STATEMENT.test(lit))
      .join('\n;\n');
    DDL.lastIndex = 0;
    if (!DDL.test(text)) continue;
    files.push({ where: path.relative(SERVER_SRC, abs).split(path.sep).join('/'), text });
  }
  return files;
}

/** `"table programs" -> [the files that declare it]`, across every scanned file. */
function declarations(files: readonly DdlFile[]): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const file of files) {
    DDL.lastIndex = 0;
    for (let m = DDL.exec(file.text); m !== null; m = DDL.exec(file.text)) {
      const key = normaliseKey(m[1], m[2]);
      declared.set(key, [...(declared.get(key) ?? []), file.where]);
    }
  }
  return declared;
}

/**
 * Every `create` the pattern above did not consume — a `CREATE TABLE ${name}` built by string
 * interpolation, a syntax it does not know, a quoting style it does not handle. The pattern is the
 * only thing standing between a duplicate declaration and silence, so anything it cannot read is a
 * failure rather than a skip.
 */
function unparsedCreates(file: DdlFile): string[] {
  const consumed: Array<[number, number]> = [];
  DDL.lastIndex = 0;
  for (let m = DDL.exec(file.text); m !== null; m = DDL.exec(file.text)) {
    consumed.push([m.index, m.index + m[0].length]);
  }
  const out: string[] = [];
  const bare = /\bcreate\b/gi;
  for (let m = bare.exec(file.text); m !== null; m = bare.exec(file.text)) {
    if (consumed.some(([start, end]) => m.index >= start && m.index < end)) continue;
    out.push(`${file.where}: "${file.text.slice(m.index, m.index + 90).replace(/\s+/g, ' ')}…"`);
  }
  return out;
}

/**
 * Plan 3's declared read-contract with Plans 1 and 2. If this test fails, a
 * column was renamed upstream; reconcile the name before touching anything else.
 */
const REQUIRED: Record<string, string[]> = {
  funders: ['id', 'name'],
  // Plan 1's normalized shape (RESOLUTIONS R1). There is no `data` column.
  // `source_id` / `external_key` are the crawler-reconciliation pair from R9.
  programs: [
    'id', 'funder_id', 'name', 'klass', 'summary', 'applicant_entities',
    'amount', 'deadline', 'apply_via', 'apply_url', 'apply_contact',
    'funding_restrictions', 'obligations', 'ai_policy', 'trust',
    'raw_other_text', 'tags', 'content_hash', 'status', 'last_verified_at',
    'source_id', 'external_key',
  ],
  cycles: ['id', 'program_id', 'opens_at', 'closes_at', 'timezone', 'label', 'is_estimated'],
  users: ['id', 'email', 'role'],
  // `enabled` is read by the sources router and by the admin pause toggle
  // (Tasks 14 and 24), and gates Plan 2's runCrawl (RESOLUTIONS R20).
  sources: [
    'id', 'label', 'tier', 'funder_id', 'enabled', 'last_polled_at', 'last_success_at',
    'consecutive_failures', 'last_record_count', 'expected_min_records',
  ],
  snapshots: ['id', 'source_id', 'url', 'fetched_at', 'status'],
  change_events: [
    'id', 'source_id', 'program_id', 'kind', 'before_json', 'after_json',
    'detected_at', 'field_path',
  ],
  review_items: [
    'id', 'change_event_id', 'candidate_json', 'decision', 'decided_by',
    'decided_at', 'confidence', 'reject_key',
  ],
  // RESOLUTIONS R26: the Inbox decision route delegates to Plan 2's review
  // pipeline, which writes reject memory and the provenance trail. Plan 3 reads
  // both back in `inboxRouter.test.ts`, so both are part of its read-contract.
  // `review_rejects` is Plan 2's plan-local table (CONTRACT §6); `audit_log` is
  // Plan 1's, and its columns are `at` / `actor_user_id`, not `created_at` /
  // `user_id` — a rename upstream would make provenance silently unreadable.
  review_rejects: ['reject_key', 'decided_by', 'decided_at'],
  audit_log: ['at', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'detail'],
  // DEVIATION FROM THE TASK BRIEF, resolved towards the plan (2026-08-03).
  // The brief's REQUIRED map omits `profiles` and `watches`, but both are rows
  // in the plan's own read-contract table AND the plan says in prose that "the
  // conformance test asserts the columns (including `watches.notify_changes`)"
  // — the sentence that justifies Plan 3 shipping NO migration for either
  // table (RESOLUTIONS R19). Asserting them is the whole reason Plan 3 is
  // allowed not to create them, so the omission is a gap in the brief, not a
  // narrowing of the contract. Both shapes below are Plan 1's 001-init.sql.
  profiles: ['id', 'user_id', 'kind', 'data', 'updated_at'],
  watches: ['id', 'user_id', 'program_id', 'notify_changes', 'created_at'],
  // `next_timezone` is migration 037's addition. `next_closes_at` is the UTC
  // instant of a LOCAL wall time, so the two are a pair: an instant without its
  // frame cannot be rendered as a calendar day, and rendering it in UTC prints
  // the ARRL's 2027-02-28 window as 2027-03-01 — one day late. If this column
  // is ever dropped, browse and the watchlist go straight back to that.
  program_search: [
    'program_id', 'funder_id', 'funder_name', 'name', 'klass', 'status',
    'instrument', 'amount_min', 'amount_max', 'deadline_kind',
    'next_opens_at', 'next_closes_at', 'next_is_estimated', 'next_timezone',
    'last_verified_at', 'haystack',
  ],
  program_facets: ['program_id', 'facet_kind', 'facet_value'],
  // Plan-3-local (migration 031). `source_url` is Task 5's documented addition
  // to the brief's seven columns: `source_id` names the source MODULE, and
  // `snapshot_id` is nullable — Task 10's verify path always writes null — so
  // without it a provenance row carries no page a reader could open.
  field_provenance: [
    'program_id', 'field_path', 'source_id', 'snapshot_id', 'raw_label',
    'raw_value', 'fetched_at', 'source_url',
  ],
};

describe('schema conformance (Plan 3 read-contract)', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it.each(Object.entries(REQUIRED))('table %s has every column Plan 3 reads', (table, columns) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    expect(rows.length, `table "${table}" does not exist`).toBeGreaterThan(0);
    const present = new Set(rows.map((r) => r.name));
    const missing = columns.filter((c) => !present.has(c));
    expect(missing, `${table} is missing columns`).toEqual([]);
  });

  // RESOLUTIONS R1, made executable: if a `data` column ever reappears on
  // `programs`, someone has re-introduced the document shape Plan 1's
  // normalized DDL replaced, and half of Plan 3 would silently read stale JSON.
  it('programs has no `data` column — records are read through createProgramRepo', () => {
    const rows = db.prepare('PRAGMA table_info(programs)').all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).not.toContain('data');
  });

  /**
   * The two-definitions-one-name trap, made executable — now over EVERY file that declares a
   * table or an index, not only `migrations/`. SQLite matches `IF NOT EXISTS` on the NAME alone,
   * so a second declaration of an existing name is a silent no-op and the shape you think you
   * added never exists. Reading the text on disk is the only way to see it, because the database
   * cannot tell you about a statement that did nothing.
   *
   * See the header above `ddlFiles` for why the migrations-only version could not see the file the
   * original defect lived in.
   */
  it('declares every table and index name exactly once, across migrations AND product code', () => {
    const files = ddlFiles();
    const declared = declarations(files);
    const duplicated = [...declared.entries()]
      .filter(([, where]) => where.length > 1)
      .map(([key, where]) => `${key} declared in ${where.join(', ')}`)
      .sort();
    expect(
      duplicated,
      'SQLite matches IF NOT EXISTS on the name, so the second declaration never runs and its ' +
        'shape never exists. Give it a distinct name, or delete it and let the owner keep it.',
    ).toEqual([]);
  });

  /**
   * VACUITY GUARDS FOR THE SCAN ITSELF. A regex that stopped matching, or a walk that stopped
   * walking, would pass the check above over an empty set — the same silence it exists to break.
   * `db/ingestSchema.ts` is named because it is the exact file the original defect lived in and
   * the exact file the migrations-only scan could not see.
   */
  it('scans every file that declares schema, including the ones outside migrations/', () => {
    const where = ddlFiles().map((f) => f.where);
    expect(where.filter((w) => w.startsWith('migrations/')).length).toBeGreaterThan(5);
    expect(where).toContain('db/ingestSchema.ts');
    expect(where).toContain('db/migrate.ts');

    const declared = declarations(ddlFiles());
    // Two from migrations, two from the product files above: if either half of the scan went
    // quiet, one of these four disappears.
    expect(declared.get('table programs')).toEqual(['migrations/001-init.sql']);
    expect(declared.get('index idx_pf_lookup')).toEqual(['migrations/030-browse-projection.sql']);
    expect(declared.get('table review_rejects')).toEqual(['db/ingestSchema.ts']);
    expect(declared.get('index idx_audit_entity')).toEqual(['db/ingestSchema.ts']);
    expect(declared.get('table schema_migrations')).toEqual(['db/migrate.ts']);
  });

  /**
   * The prose/statement boundary, pinned. If `stringLiterals` or `SQL_STATEMENT` ever widened, the
   * error message in `db/repositories/applications.ts` — which is an ARGUMENT for this invariant,
   * written in English, mentioning CREATE TABLE four times — would start declaring phantom tables
   * named after the words following it.
   */
  it('reads SQL statements in product code, and not English sentences about them', () => {
    const literals = stringLiterals(
      `const sql = 'CREATE TABLE ok (id TEXT)';\n` +
        `const help = 'do NOT delete Plan 1\\'s CREATE TABLE, because its CREATE INDEX statements';`,
    );
    expect(literals.filter((l) => SQL_STATEMENT.test(l))).toEqual(['CREATE TABLE ok (id TEXT)']);

    // …and the real file is in the scan's blind spot on purpose: it declares nothing.
    expect(ddlFiles().map((f) => f.where)).not.toContain('db/repositories/applications.ts');
  });

  /**
   * THE GUARD ON THE GUARD. The contrast invariant was defeated by a token its parser silently
   * skipped; the same shape here would be a `CREATE` this pattern cannot read — an interpolated
   * name, a syntax it does not know — which would drop out of the duplicate check without a word.
   * Every `create` in every scanned file must be one the pattern understood.
   */
  it('understands every CREATE it scans, and reports the ones it cannot read', () => {
    const escaped = ddlFiles().flatMap(unparsedCreates);
    expect(
      escaped,
      'this CREATE was not matched by the DDL pattern, so its name is invisible to the ' +
        'duplicate-declaration check. Widen the pattern rather than leaving the statement ' +
        'unscanned.',
    ).toEqual([]);
  });

  it('recognises the DDL shapes the old (table|index)-only pattern missed', () => {
    const kinds = declarations([
      {
        where: 'synthetic',
        text: [
          'CREATE TEMP TABLE scratch (a);',
          'CREATE VIRTUAL TABLE docs USING fts5(body);',
          'CREATE VIEW open_programs AS SELECT 1;',
          'CREATE TRIGGER touch AFTER UPDATE ON programs BEGIN SELECT 1; END;',
          'CREATE UNIQUE INDEX IF NOT EXISTS "idx_quoted" ON programs (id);',
        ].join('\n'),
      },
    ]);
    expect([...kinds.keys()].sort()).toEqual([
      'index idx_quoted',
      'table docs',
      'table scratch',
      'trigger touch',
      'view open_programs',
    ]);
    // A virtual table and a plain table of the same name are ONE name to SQLite, which is the
    // whole reason the kinds are folded together rather than kept apart.
    const clash = declarations([
      { where: 'a.sql', text: 'CREATE TABLE docs (a);' },
      { where: 'b.ts', text: 'CREATE VIRTUAL TABLE docs USING fts5(body);' },
    ]);
    expect(clash.get('table docs')).toEqual(['a.sql', 'b.ts']);
  });

  it('sees a CREATE it cannot parse rather than skipping it', () => {
    expect(
      unparsedCreates({ where: 'x.ts', text: 'db.exec(`CREATE TABLE ${name} (id TEXT)`);' }),
    ).toHaveLength(1);
    expect(unparsedCreates({ where: 'x.sql', text: 'CREATE TABLE ok (id TEXT);' })).toEqual([]);
    // `created_at` is not a CREATE, and a comment about creating tables is not one either.
    expect(
      unparsedCreates({ where: 'x.sql', text: stripComments('-- CREATE TABLE ghost\ncreated_at') }),
    ).toEqual([]);
  });
});

/**
 * RESOLUTIONS R19, made executable per file rather than per name. The check
 * above catches a name declared twice; this one catches the case where someone
 * pastes a Plan 1 table back into a Plan 3 migration under a *different* name,
 * or empties one of these files of the indexes that are its only reason to
 * exist.
 */
describe('migration ownership (RESOLUTIONS R19)', () => {
  let ownedDb: Database.Database;

  beforeAll(() => {
    ownedDb = openTestDb();
  });

  afterAll(() => {
    ownedDb.close();
  });

  // `profiles` and `watches` are CONTRACT §6 tables created by Plan 1's
  // 001-init.sql. Plan 3's 032/033 may only add indexes: a CREATE TABLE here
  // sorts after 001, so it no-ops, and its (divergent, FK-less) shape would
  // read as the schema while never existing.
  //
  // DEVIATION FROM THE TASK BRIEF (2026-08-03): the brief matched these two
  // regexes against the RAW file text. Both files explain the no-op trap in
  // their header comments, and 032-profiles.sql spells the words "CREATE TABLE
  // IF NOT EXISTS" while doing so, so the raw-text form fails on a comment that
  // is arguing FOR the rule it is being failed by. Comments are stripped first,
  // exactly as the duplicate-name check above already does.
  // NARROWED 2026-08-04 (controller ruling). This used to also assert
  // `toMatch(/CREATE INDEX/)` on both files — "these migrations exist to add an
  // index, so one must be here". That generalised from 033, where the index IS
  // the file's only reason to exist, to 032, where it demonstrably is not:
  // every access path against `profiles` is prefixed by user_id, and Plan 1's
  // UNIQUE (user_id, kind) already indexes all of them (EXPLAIN QUERY PLAN gives
  // the identical access path with 032's index dropped). Task 4 measured that,
  // emptied the file, went red here, and correctly restored the index rather
  // than rewriting another task's committed invariant from inside its own task.
  //
  // The right fix is to narrow the assertion, not to keep a redundant index
  // alive to satisfy a test. 033's index is not left unguarded: it has its own
  // specific test below, which names `idx_watches_user_created` and states the
  // read it covers — strictly better than a generic "contains CREATE INDEX".
  //
  // What remains here is the invariant that actually matters: a CREATE TABLE in
  // one of these files sorts after 001-init.sql, so it silently no-ops, and its
  // divergent FK-less shape would read as the schema while never existing.
  it.each([
    ['032-profiles.sql'],
    ['033-watches.sql'],
  ])('%s never re-creates a Plan 1 table', (file) => {
    const raw = readFileSync(
      fileURLToPath(new URL(`./migrations/${file}`, import.meta.url)),
      'utf8',
    );
    const sql = raw.replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/CREATE\s+TABLE/i);
  });

  it('keeps Plan 1’s cascade on watches, which is what makes the fixtures need parents', () => {
    const keys = ownedDb.prepare('PRAGMA foreign_key_list(watches)').all() as Array<{
      table: string; on_delete: string;
    }>;
    expect(keys.map((k) => k.table).sort()).toEqual(['programs', 'users']);
    for (const k of keys) expect(k.on_delete).toBe('CASCADE');
    expect(ownedDb.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  /**
   * The index migration 033 actually adds. Plan 1 already ships
   * `idx_watches_program` for the fan-out direction, and the UNIQUE
   * (user_id, program_id) constraint already indexes the other, so the only
   * thing left uncovered was `watchedProgramIds`' ORDER BY created_at. If this
   * index disappears, every watchlist read goes back to sorting in memory.
   */
  it('indexes the watchlist read that Plan 1 left uncovered', () => {
    const names = (
      ownedDb.prepare('PRAGMA index_list(watches)').all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain('idx_watches_user_created');
    expect(names).toContain('idx_watches_program');
  });
});
