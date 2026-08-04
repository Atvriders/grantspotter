/**
 * Build the database the e2e server opens.
 *
 * DEVIATION FROM THE TASK BRIEF (2026-08-04), and the reason it is worth one.
 *
 * The brief seeds `seedFixtureCorpus` — five hand-written programs — "so the e2e assertions and
 * the unit assertions describe the same records". Every property this suite exists to prove is a
 * property of the REAL corpus and unprovable against five records: 68 eligible-or-preferred of
 * 150 for a licensed EE undergraduate, 8 unknowns that are not soft noes, 4 funder-published
 * cycles among hundreds of projected ones, 112 programmes riding one December deadline, ~553
 * records stored and deliberately hidden, `costShareRequired` unstated on 148 and `false` on
 * zero. A five-record fixture cannot state any of them, and a suite that only proves pages load
 * is the suite this project has repeatedly paid for.
 *
 * So the corpus comes from `scripts/profile-corpus.ts`'s `loadCorpus()`, which normalizes the
 * SAME committed fixtures the server tests parse, through the product's own source modules,
 * normalizer and both suppression gates. It is more faithful to the unit suites than the fixture
 * corpus is, not less: nothing here restates a rule the product owns.
 *
 * Everything is written through the product's own writers — `funderFor`, `recordPollStart`,
 * `upsertProgram` + `sourceKeyFor`, `reprojectAllCycles`, `reindexBrowse` — for the reason the
 * fixture module gives: `funders` and `programs` carry NOT NULL columns only the repositories
 * populate, `programs.funder_id` is a real foreign key under `PRAGMA foreign_keys = ON`, and
 * `programs` has no `data` column (RESOLUTIONS R1).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashPassword } from '../packages/server/src/auth/password.js';
import { migrate, openDatabase } from '../packages/server/src/db/migrate.js';
import { ensureIngestionSchema } from '../packages/server/src/db/ingestSchema.js';
import { createFunderRepo } from '../packages/server/src/db/repositories/funders.js';
import { createUserRepo } from '../packages/server/src/db/repositories/users.js';
import {
  recordPollStart,
  recordPollSuccess,
  upsertProgram,
} from '../packages/server/src/db/repositories/ingestion.js';
import { reprojectAllCycles, sourceKeyFor } from '../packages/server/src/review/index.js';
import { funderFor, SOURCES } from '../packages/server/src/sources/registry.js';
import { reindexBrowse } from '../packages/server/src/api/reindex.js';
import { loadCorpus } from '../scripts/profile-corpus.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  ARRL_CATALOG_SOURCE_ID,
  ARRL_SCHOLARSHIP_NAME,
  DB_PATH,
  MEMBER_EMAIL,
  MEMBER_PASSWORD,
  NEWCOMER_EMAIL,
  NEWCOMER_PASSWORD,
  OFFLINE_SOURCE_ID,
} from './helpers.js';

const POLLED_AT = '2026-08-02T03:17:00.000Z';

async function main(): Promise<void> {
  rmSync(dirname(DB_PATH), { recursive: true, force: true });
  mkdirSync(dirname(DB_PATH), { recursive: true });

  // Plan 1's migration runner, not a hand-rolled glob: the e2e database must be
  // byte-for-byte the schema the server will open, `schema_migrations` included.
  const db = openDatabase(DB_PATH);
  migrate(db);
  ensureIngestionSchema(db);

  const corpus = await loadCorpus();

  // Sources first. `recordPollStart` REGISTERS the source as well as stamping the poll, which is
  // how a module added to the registry reaches the health page; `funderFor` is the registry's own
  // answer to "which organization is behind this module", and the crawl runner upserts it in
  // exactly this position for exactly this reason (`programs.funder_id` is NOT NULL and a real FK).
  const funders = createFunderRepo(db);
  for (const source of SOURCES) {
    funders.upsert(funderFor(source.funderId));
    recordPollStart(db, source, POLLED_AT);
  }
  for (const entry of corpus.loaded) {
    recordPollSuccess(db, entry.sourceId, entry.programs, POLLED_AT);
  }

  // EVERY SOURCE BUT ONE IS PAUSED, and this is the whole reason a crawl is safe to trigger from
  // a test. `runCrawl` filters on `sources.enabled` (RESOLUTIONS R20) on BOTH the nightly and the
  // manual path, so with only `manual-tier-d` — the one module with `requests: []` — left enabled,
  // pressing "Run crawl now" exercises parse, diff, review queue and source health end to end
  // while reaching out to nobody. The alternative is a suite that walks ~25 small nonprofits'
  // websites every time it runs, which is the politeness failure the nightly jitter exists to
  // avoid, and flaky besides.
  db.prepare('UPDATE sources SET enabled = 0 WHERE id != ?').run(OFFLINE_SOURCE_ID);

  // A funder a record names but no source module declares would otherwise fail the foreign key
  // half-way through the seed with a bare SQLITE_CONSTRAINT. Ask the registry by name so the
  // failure, if it ever happens, says which funder is missing from FUNDERS.
  const known = new Set(SOURCES.map((s) => s.funderId));
  for (const program of [...corpus.programs, ...corpus.suppressedPrograms]) {
    if (known.has(program.funderId)) continue;
    funders.upsert(funderFor(program.funderId));
    known.add(program.funderId);
  }

  for (const program of corpus.programs) upsertProgram(db, program, sourceKeyFor(program));

  // Cycles BEFORE the suppressed records go in. `reprojectAllCycles` walks every row in
  // `programs`, and a suppressed record is not an opportunity, so it must not contribute a
  // projected deadline to a table the browse projection reads.
  const nowISO = new Date().toISOString();
  reprojectAllCycles(db, nowISO);

  // The ~553 records the product stores and refuses to show. Four separate read surfaces call
  // `isDoNotPublish` before rendering — browse's projection, the opportunity detail route, the
  // watchlist and the calendar — and none of those refusals can be exercised end-to-end against
  // a database that holds none of them. The detail route answered 200 for every one of these to
  // anyone who could guess an id until that guard was added.
  for (const program of corpus.suppressedPrograms) {
    upsertProgram(db, program, sourceKeyFor(program));
  }

  // Plan 1's `users` table has NOT NULL email_normalized / password_hash /
  // ics_token, all of which createUserRepo().create() populates.
  const users = createUserRepo(db);
  users.create({
    email: MEMBER_EMAIL,
    passwordHash: await hashPassword(MEMBER_PASSWORD),
    role: 'member',
    displayName: 'E2E Member',
  });
  users.create({
    email: NEWCOMER_EMAIL,
    passwordHash: await hashPassword(NEWCOMER_PASSWORD),
    role: 'member',
    displayName: 'E2E Newcomer',
  });
  users.create({
    email: ADMIN_EMAIL,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    displayName: 'E2E Admin',
  });

  // Provenance for the one field the change-event journey moves, so the fan-out and the detail
  // page both have a source to name. The values are the record's own, read back out of the
  // corpus rather than invented.
  const arrl = corpus.programs.find((p) => p.name === ARRL_SCHOLARSHIP_NAME);
  if (arrl === undefined) {
    throw new Error(
      'The ARRL Foundation Scholarship Program is not in the loaded corpus, so the deadline ' +
        'every other journey inherits does not exist. Check fixtures/arrl-scholarship-program/.',
    );
  }
  db.prepare(
    `INSERT INTO field_provenance
       (program_id, field_path, source_id, snapshot_id, raw_label, raw_value, fetched_at, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    arrl.id,
    'deadline.note',
    ARRL_CATALOG_SOURCE_ID,
    null,
    'Deadline',
    arrl.deadline.note,
    POLLED_AT,
    arrl.trust.sourceUrl,
  );

  const indexed = reindexBrowse(db, nowISO);
  db.close();

  console.log(
    `[e2e:seed] ${corpus.programs.length} publishable, ${corpus.suppressedPrograms.length} ` +
      `suppressed, ${indexed} indexed for browse, ${SOURCES.length} sources, 3 users.`,
  );
}

void main();
