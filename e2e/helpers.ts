import Database from 'better-sqlite3';

export const E2E_PORT = 3131;
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * The URL Playwright polls to decide the server is up.
 *
 * DEVIATION FROM THE TASK BRIEF (2026-08-04), and it is the difference between
 * this suite running at all and this suite timing out. The brief sets
 * `webServer.url` to `BASE_URL` — i.e. `/` — and then says in the same breath
 * that `/` answers Plan 1's JSON **404** until Plan 5 Task 17 mounts the SPA
 * middleware. Playwright treats 2xx, 3xx, 400, 401, 402 and 403 as "ready" and
 * every other status, 404 included, as "not yet"; it therefore polls `/` for the
 * full 180s `timeout` and dies with `Timed out waiting … from config.webServer`
 * having never run a single test. Measured, not assumed: with `url: BASE_URL`
 * the run ends in that timeout and no spec is collected.
 *
 * `/api/health` is the honest readiness probe anyway — it answers 200 only once
 * the migrations, the mount hook and the listener are all up, which is exactly
 * the condition "the server is ready" names.
 */
export const HEALTH_URL = `${BASE_URL}/api/health`;

/**
 * DATA_DIR for the e2e server, and the file Plan 1's entrypoint opens inside it:
 * `openDatabase(join(config.dataDir, 'grantspotter.sqlite'))`. The seed script
 * and the server must name the same file, or the seed silently populates a
 * database nothing reads.
 */
export const DATA_DIR = 'e2e/.tmp';
export const DB_PATH = `${DATA_DIR}/grantspotter.sqlite`;

export const MEMBER_EMAIL = 'member@example.com';
export const MEMBER_PASSWORD = 'e2e-member-password-not-a-real-secret';
export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'e2e-admin-password-not-a-real-secret';

/**
 * A member who holds NO profile, reserved for the browser journey.
 *
 * DEVIATION FROM THE TASK BRIEF (2026-08-04). The brief runs the browser flow as `MEMBER_EMAIL`
 * and opens it by asserting that the app says a profile is missing — which is only true on the
 * very first spec to touch that account, in the very first run against a fresh database. Two
 * specs deep it is asserting the state a previous spec left behind. A dedicated account costs one
 * row and makes the journey say what it means: this is a user who has not filled anything in yet.
 */
export const NEWCOMER_EMAIL = 'newcomer@example.com';
export const NEWCOMER_PASSWORD = 'e2e-newcomer-password-not-a-real-secret';

/**
 * The programme whose deadline 112 of the 150 publishable records inherit.
 *
 * Its id is minted by the normalizer from the source record, so it is looked up by name rather
 * than transcribed: a re-captured fixture changes the id's content hash without changing which
 * programme this is, and a hard-coded id would then fail as "not found" instead of as whatever
 * actually moved.
 */
export const ARRL_SCHOLARSHIP_NAME = 'ARRL Foundation Scholarship Program';

/**
 * The one source in the registry that makes NO network request (`requests: []`,
 * "No network access at all"). It is what the manual-crawl journeys trigger, so
 * the e2e run never reaches out to arrl.org, ncdxf.org or any of the ~25 small
 * nonprofits this product polls — a test suite that hammers third-party sites is
 * the thing the nightly jitter exists to avoid, and it would be flaky besides.
 */
export const OFFLINE_SOURCE_ID = 'manual-tier-d';

/** The ARRL catalog source, whose deadline 112 of the 150 publishable records inherit. */
export const ARRL_CATALOG_SOURCE_ID = 'arrl-scholarship-descriptions';

/**
 * Write a real ChangeEvent row, exactly as the nightly crawl does. This is the
 * simulation: the row is real, the fan-out is real, only the crawl is skipped.
 *
 * `drainChangeEvents` runs on every read of `GET /api/notifications`, so the row
 * is fanned out by the running server the next time the watchlist is opened —
 * nothing here reaches into the delivery path.
 */
export function insertChangeEvent(event: {
  id: string;
  sourceId: string;
  programId: string | null;
  kind: string;
  before: unknown;
  after: unknown;
  detectedAt: string;
  fieldPath: string | null;
}): void {
  const db = new Database(DB_PATH);
  try {
    db.prepare(
      `INSERT INTO change_events
         (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.sourceId,
      event.programId,
      event.kind,
      JSON.stringify(event.before),
      JSON.stringify(event.after),
      event.detectedAt,
      event.fieldPath,
    );
  } finally {
    db.close();
  }
}

function readDb<T>(read: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** The stored id of a programme, by its exact name. */
export function programIdByName(name: string): string {
  const row = readDb((db) =>
    db.prepare('SELECT id FROM programs WHERE name = ?').get(name) as { id: string } | undefined,
  );
  if (row === undefined) throw new Error(`no program named "${name}" in the seeded corpus`);
  return row.id;
}

/**
 * Program ids the corpus stores and every read surface refuses: past awards and cross-check-only
 * rows. Read out of the database rather than listed here, because the point of the assertion is
 * that the records really are stored — a hard-coded id could pass against an empty table.
 */
export function suppressedProgramIds(limit = 5): string[] {
  return readDb((db) =>
    (
      db
        .prepare("SELECT id FROM programs WHERE tags LIKE '%do_not_publish%' ORDER BY id LIMIT ?")
        .all(limit) as Array<{ id: string }>
    ).map((r) => r.id),
  );
}

/** How many rows the corpus holds, publishable and suppressed. */
export function programCounts(): { total: number; suppressed: number } {
  return readDb((db) => ({
    total: (db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n,
    suppressed: (
      db
        .prepare("SELECT COUNT(*) AS n FROM programs WHERE tags LIKE '%do_not_publish%'")
        .get() as { n: number }
    ).n,
  }));
}
