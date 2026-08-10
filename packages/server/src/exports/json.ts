/**
 * THE FULL BACKUP — and the one place in this package where suppression must NOT apply.
 *
 * Every other export in `packages/server/src/exports/` goes through `buildExportRows`, whose first
 * act is the unconditional `exportablePrograms` gate: 150 records may leave, 553 may not. This
 * file deliberately does the opposite. It reads `SELECT *` and takes everything, because the 553
 * suppressed records — past ARDC / NSF / USAspending awards, the 37 ARRL clubs already funded —
 * are real data an administrator owns, and a "backup" that quietly drops three quarters of the
 * corpus is not a backup. Dropping them here would be data loss on the next restore.
 *
 * That makes this the ONLY place where a restore could resurrect a suppressed record as a
 * publishable one, so `json.test.ts` asserts the census on both sides of a real round trip through
 * an empty migrated database: 150 publishable / 553 suppressed before, and the same 553 ids
 * suppressed after.
 *
 * SCHEMA-AGNOSTIC BY DESIGN. Tables come from a declared list intersected with `sqlite_master`;
 * columns come from `PRAGMA table_info`. A migration can add or rename a column without touching
 * this file, and a backup taken today restores into tomorrow's schema for every column the two
 * have in common. `json.test.ts` holds the other end of that bargain with a census that fails, by
 * name, the moment a migration introduces a table this file has never classified.
 */
import type { Database } from 'better-sqlite3';
import { reindexBrowse } from '../api/reindex.js';

export const BACKUP_FORMAT_VERSION = 1;

/**
 * What a backup contains.
 *
 * CONTRACT §6's list is the spine (`funders` … `audit_log`, plus `review_rejects` and
 * `ics_tokens`), minus `sessions`. Two deviations from the task brief, both deliberate:
 *
 *   1. **`review_rejects` is present.** The brief's list omits it although CONTRACT §6 names it.
 *      It is the ledger of every candidate an operator has already rejected; losing it on restore
 *      re-queues every rejection the team has ever worked through.
 *   2. **Six tables that CONTRACT §6 does not yet name are present** — `field_provenance`,
 *      `notifications`, `change_event_fanout`, `notification_channels`,
 *      `notification_channel_health`, `verify_attempts`. They were added by migrations 031 and
 *      034-036, they hold real per-user state (a configured webhook URL, an unread digest, a rate
 *      limiter's ledger), and CONTRACT §6's prose has simply not caught up. Backing up only what
 *      the contract remembers would silently lose a user's notification channel on every restore.
 *
 * ORDER IS LOAD-BEARING: parents first. `restoreBackup` walks this list forwards to insert and
 * backwards to delete, so an `ON DELETE CASCADE` can never eat a table that has not been emptied
 * yet, and a child row is never inserted before the parent it references.
 */
export const BACKUP_TABLES = [
  'funders',
  'programs',
  'constraints',
  'cycles',
  'field_provenance',
  'sources',
  'snapshots',
  'change_events',
  'change_event_fanout',
  'review_items',
  'review_rejects',
  'verify_attempts',
  'users',
  'profiles',
  'watches',
  'notifications',
  'notification_channels',
  'notification_channel_health',
  'applications',
  'template_instances',
  'audit_log',
  'ics_tokens',
  // Migration 091. AFTER `users`, because `created_by_user_id` references it and this list is
  // walked forwards to insert.
  //
  // BACKED UP, DIGEST AND ALL — RE-DECIDED ON 2026-08-10, BECAUSE THE REASON GIVEN HERE HAD STOPPED
  // BEING TRUE. What this comment used to say was that "the table holds a SHA-256 digest and no
  // code, so a backup file is not a bundle of working credentials". That was an argument about the
  // INPUT: a digest of twenty random characters is not worth attacking. Migration 092 let an
  // administrator type the input, and MEASURED on this host, `W1MX-AUTUMN-2026` came back out of
  // its stored digest in 32.4 s and 11,334,277 dictionary candidates. For those months this file
  // was writing a set of live credentials into a downloadable JSON, with `chosen` beside each one
  // saying which were worth the 32 seconds.
  //
  // WHAT MAKES IT SAFE NOW IS NOT IN THE FILE, WHICH IS THE POINT. Migration 093 made `code_hash` an
  // HMAC under a key derived from `SESSION_SECRET`, and `SESSION_SECRET` is an environment variable:
  // it is not a column, not a table, and not in any backup this function can produce. A leaked
  // backup is a list of MACs whose key the reader does not have. Two consequences worth an
  // operator's attention rather than a discovery: keep the backup and the compose file that holds
  // your secret apart, since together they are the pair — and any row still carrying
  // `hash_scheme = 'sha256'` predates 093 and therefore, necessarily, is a generated 2^100 code, so
  // it is the case the original argument really was true about.
  //
  // THE ALTERNATIVE — SHIPPING THE ROW WITHOUT ITS DIGEST — WAS WEIGHED AND REFUSED. `code_hash` is
  // NOT NULL and UNIQUE, so a redacted export would have to invent one, and a restore would then
  // silently invalidate every code a club has already handed out: thirty students each answered
  // "that enrollment code is not valid", with nothing on either side of the screen to explain it,
  // and the officer unable to reproduce it because the code they are holding is the one that
  // stopped existing. Revocation and expiry are what end a code; a restore is not. Trading a
  // certain harm for a hypothetical one is a bad trade even before the hypothetical was keyed.
  //
  // WHAT A RESTORE ONTO A DIFFERENT HOST DOES, said here because this is the only file that knows a
  // restore is happening: the digests were keyed to the OLD deployment's `SESSION_SECRET`, so unless
  // the operator carried that secret across with the data, the codes come back as records and not as
  // codes — labels, uses, expiry, issuer and audit trail intact, and nothing redeemable.
  // `json.test.ts` holds that as an executable fact rather than as a warning nobody reads.
  'enrollment_codes',
] as const;

/**
 * Rebuilt from `programs` on restore, never imported. Importing them would be worse than useless:
 * they are the browse surface, they honour suppression, and a projection restored verbatim from a
 * file is stale the instant the corpus it was projected from is replaced.
 */
export const DERIVED_TABLES = ['program_search', 'program_facets'] as const;

/**
 * Excluded on purpose, and for two different reasons.
 *
 * `sessions` — restoring live session rows resurrects logged-in browsers out of a file. It has no
 * user value and it is a straightforward security hazard; a restore should mean everybody signs in
 * again. `schema_migrations` is the TARGET database's own ledger of which migrations it has run.
 * Overwriting it with the source's ledger would make a newer database claim it is still at the
 * older database's revision, and the next `migrate()` would skip work it genuinely needs to do.
 */
export const NEVER_BACKED_UP_TABLES = ['sessions', 'schema_migrations'] as const;

/** PLAN-LOCAL. */
export interface BackupFile {
  app: 'grantspotter';
  formatVersion: number;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

/** PLAN-LOCAL. */
export interface RestoreResult {
  /** Tables this restore replaced, in canonical parent-before-child order. */
  tablesRestored: string[];
  /**
   * Tables the file carried that this schema does not have. Reported rather than dropped in
   * silence: an admin restoring a newer backup into an older build needs to be told which of their
   * data did not land.
   */
  tablesSkipped: string[];
  rowsRestored: number;
  /** Rows whose every column is unknown to this schema. Same reason as `tablesSkipped`. */
  rowsSkipped: number;
  /**
   * How many programmes the browse index was rebuilt for, or `null` when this schema has no browse
   * projection to rebuild.
   *
   * THIS FIELD EXISTS BECAUSE OF A DEFECT (Plan 3 Task 25 / Plan 5 progress ledger). The restore
   * copy claimed "browse index was rebuilt" while nothing in the restore path reindexed anything —
   * so a restored deployment served the PREVIOUS corpus's filters and search rows, while telling
   * the administrator the opposite. `restoreBackup` now genuinely calls `reindexBrowse`, inside the
   * same transaction, and returns the count so the copy can state a number instead of a claim.
   * `null` is not `0`: "could not rebuild" and "rebuilt nothing" are different sentences, and the
   * admin console is about to print one of them.
   */
  programsReindexed: number | null;
}

interface B64Envelope {
  $b64: string;
}

function isB64Envelope(v: unknown): v is B64Envelope {
  return typeof v === 'object' && v !== null && typeof (v as B64Envelope).$b64 === 'string';
}

/** SQLite identifier quoting: doubled `"` inside `"`. Every table name here is a literal from the
 * frozen lists above, but quoting is done properly anyway so that adding a name can never become
 * an injection. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function existingTables(db: Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function columnsOf(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${ident(table)})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** JSON has no bytes. A `BLOB` becomes `{"$b64": "..."}` — a shape no SQLite value can collide
 * with, so the decode is unambiguous. */
function encodeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { $b64: value.toString('base64') };
  if (value instanceof Uint8Array) return { $b64: Buffer.from(value).toString('base64') };
  return value;
}

function decodeValue(value: unknown): unknown {
  if (isB64Envelope(value)) return Buffer.from(value.$b64, 'base64');
  if (value === undefined) return null;
  return value;
}

export function exportBackup(db: Database, nowISO: string): BackupFile {
  const present = existingTables(db);
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of BACKUP_TABLES) {
    if (!present.has(table)) continue;
    const rows = db.prepare(`SELECT * FROM ${ident(table)}`).all() as Array<
      Record<string, unknown>
    >;
    tables[table] = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = encodeValue(v);
      return out;
    });
  }
  return { app: 'grantspotter', formatVersion: BACKUP_FORMAT_VERSION, exportedAt: nowISO, tables };
}

export function restoreBackup(
  db: Database,
  raw: unknown,
  nowISO: string = new Date().toISOString(),
): RestoreResult {
  const file = raw as Partial<BackupFile> | null;
  if (file === null || typeof file !== 'object' || file.app !== 'grantspotter') {
    throw new Error('This file is not a GrantSpotter backup.');
  }
  if (file.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Cannot restore format version ${String(file.formatVersion)}; this build reads version ${BACKUP_FORMAT_VERSION}.`,
    );
  }
  const tables = file.tables ?? {};
  const allowed = new Set<string>(BACKUP_TABLES);
  for (const name of Object.keys(tables)) {
    if (!allowed.has(name)) throw new Error(`Backup names unknown table "${name}"; refusing to restore.`);
  }

  const present = existingTables(db);
  // CANONICAL ORDER, not the file's key order. A file written by another build — or by hand — can
  // name its tables in any order it likes; parent-before-child is a property of the schema, not of
  // the file, so it is taken from `BACKUP_TABLES` here.
  const named = new Set(Object.keys(tables));
  const targets = BACKUP_TABLES.filter((t) => named.has(t) && present.has(t));
  const tablesSkipped = [...named].filter((t) => !present.has(t)).sort();

  let rowsRestored = 0;
  let rowsSkipped = 0;
  let programsReindexed: number | null = null;
  const canReindex = DERIVED_TABLES.every((t) => present.has(t)) && present.has('programs');

  const run = db.transaction(() => {
    /**
     * `defer_foreign_keys`, NOT `foreign_keys = OFF`.
     *
     * SQLite documents `PRAGMA foreign_keys` as a NO-OP inside a transaction, and better-sqlite3's
     * `db.transaction()` has already issued `BEGIN` by the time this line runs — verified on this
     * host: `db.pragma('foreign_keys')` still reads `1` immediately after setting it to `OFF`. The
     * brief's restore therefore believed it had disabled foreign keys and had not, which is the
     * worst of both worlds: order still mattered, and nobody knew.
     *
     * Deferring is also the better answer on its own terms. It lets the tables load in any order
     * within the transaction, and then enforces every reference at COMMIT — so a backup with a
     * dangling reference is REFUSED and rolled back whole, rather than landing a database that is
     * quietly inconsistent. `PRAGMA foreign_key_check` on the restored database is empty, and
     * `json.test.ts` asserts exactly that.
     */
    db.pragma('defer_foreign_keys = ON');

    // Reverse order: children first. `ON DELETE CASCADE` actions still fire under deferred
    // enforcement, so emptying `funders` before `programs` would cascade the programmes away
    // underneath the insert loop.
    for (const table of [...targets].reverse()) {
      db.prepare(`DELETE FROM ${ident(table)}`).run();
    }

    for (const table of targets) {
      const schemaColumns = columnsOf(db, table);
      for (const row of tables[table]) {
        const columns = Object.keys(row).filter((c) => schemaColumns.has(c));
        if (columns.length === 0) {
          rowsSkipped += 1;
          continue;
        }
        const sql =
          `INSERT INTO ${ident(table)} (${columns.map(ident).join(',')}) ` +
          `VALUES (${columns.map(() => '?').join(',')})`;
        db.prepare(sql).run(...columns.map((c) => decodeValue(row[c])));
        rowsRestored += 1;
      }
    }

    // Inside the transaction on purpose: if the restored corpus cannot be projected, the restore
    // itself is rolled back rather than leaving a half-usable database behind.
    if (canReindex) programsReindexed = reindexBrowse(db, nowISO);
  });

  run();
  return { tablesRestored: [...targets], tablesSkipped, rowsRestored, rowsSkipped, programsReindexed };
}
