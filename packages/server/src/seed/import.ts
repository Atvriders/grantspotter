/**
 * The first-run corpus import.
 *
 * A fresh installation starts with an empty database and no way to reach a funder: the crawl is
 * nightly, its results land in a review queue, and nothing is published until an admin approves
 * it. So the shipped corpus is what makes the product usable on the first boot, and this is where
 * it lands.
 *
 * IT NEVER OVERWRITES A HUMAN DECISION. Every seeded record enters the normal trust pipeline
 * (spec §13): it ages, it can go amber, "Verify now" refetches it, and an operator may edit or
 * retire it. A container restart must not silently put back what somebody removed, so the import
 * runs only against an empty `programs` table unless it is explicitly forced.
 *
 * IT WRITES EACH RECORD'S CRAWLER IDENTITY (RESOLUTIONS R9). `programs.source_id` /
 * `programs.external_key` are how Plan 2's `normalizeRaw` resolves a seeded row through
 * `ctx.existingIdFor` instead of minting a fresh id. Without them the first nightly crawl inserts
 * a second copy of every seeded record and the second crawl inserts a third — and Task 11 found
 * that exact defect one level up, in an anchor whose `externalKey` said `grants` where the module
 * emits `apply`.
 *
 * IT DOES NOT FILTER. `do_not_publish` records are stored deliberately — a funder's grant history
 * is the best evidence of who that funder funds — and are hidden at every READ boundary by the
 * shared `isDoNotPublish`. That boundary has leaked six times, every time from a path that wrote
 * its own predicate, so the only thing this file does with suppression is COUNT it, through
 * `publishableSeedPrograms`, for the sentence the operator reads at boot.
 *
 * IT DOES NOT REINDEX THE BROWSE PROJECTION, deliberately. `restoreBackup` (exports/json.ts) has
 * to: it is invoked from a request, mid-process, and nothing else is going to rebuild the
 * projection afterwards. This runs from `index.ts` at startup, and `index.ts` already calls
 * `reindexBrowse(db, now())` unconditionally before `app.listen` — its comment names "a seed
 * import" as one of the three reasons it is there. A second rebuild inside this transaction would
 * do the same work twice and would go stale again the moment the first crawl approved anything.
 * `import.test.ts` asserts the rows; `index.firstRun.test.ts` asserts that a real boot serves a
 * browsable corpus, which is the claim that would be false if this reasoning were wrong.
 */
import type { Database } from 'better-sqlite3';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { loadSeedCorpus, publishableSeedPrograms, seedDir } from './load.js';

/** PLAN-LOCAL. */
export interface SeedImportResult {
  imported: boolean;
  funders: number;
  programs: number;
  sourceKeys: number;
  reason: string;
}

export function importSeedIfEmpty(
  db: Database,
  options: { dir?: string; force?: boolean } = {},
): SeedImportResult {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number };
  if (existing.n > 0 && options.force !== true) {
    return {
      imported: false,
      funders: 0,
      programs: existing.n,
      sourceKeys: 0,
      reason:
        `The programs table already holds ${existing.n} records; the seed import does not ` +
        'overwrite reviewed data.',
    };
  }

  // Loaded BEFORE the transaction opens. `loadSeedCorpus` runs the whole validation harness, and
  // a corpus that fails it must leave the database untouched rather than half-written.
  const corpus = loadSeedCorpus(options.dir ?? seedDir());
  const funders = createFunderRepo(db);
  const programs = createProgramRepo(db);

  db.transaction(() => {
    // Funders first, and not as a matter of taste: `programs.funder_id REFERENCES funders(id)`
    // and `openDatabase` sets `foreign_keys = ON`, so the other order throws. The version of this
    // bug that shipped had nothing creating funder rows at all, and it crashed the first approve
    // on a fresh install — invisible because both tests hand-wrote the INSERT.
    for (const funder of corpus.funders) funders.upsert(funder);
    // `upsert`'s second argument writes source_id / external_key in the same statement, so a
    // record and its crawler identity can never be committed apart.
    for (const program of corpus.programs) programs.upsert(program, corpus.sourceKeys.get(program.id));
  })();

  const publishable = publishableSeedPrograms(corpus.programs).length;
  const suppressed = corpus.programs.length - publishable;
  return {
    imported: true,
    funders: corpus.funders.length,
    programs: corpus.programs.length,
    sourceKeys: corpus.sourceKeys.size,
    reason:
      `Imported ${corpus.programs.length} programs (${publishable} publishable, ` +
      `${suppressed} suppressed) from ${corpus.funders.length} funders, ` +
      `${corpus.sourceKeys.size} of them bound to a crawler identity, all verified 2026-08-02.`,
  };
}
