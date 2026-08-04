/**
 * Generates `data/seed/programs.arrl-catalog.json` from the committed ARRL capture.
 *
 *   npm run seed:arrl
 *
 * Offline: it reads `fixtures/arrl-scholarship-descriptions/00-…html` off disk and never touches
 * the network. Re-run it after refreshing that capture; the diff is the change.
 *
 * WHY THIS IS GENERATED AND NOT TYPED. The ARRL Foundation catalogue is 111 entries — roughly
 * three quarters of the whole publishable corpus, and by far the densest source in this space.
 * Typing 111 records by hand would put transcription errors into exactly the place nobody would
 * ever check them against the page, and this project's worst defects are all of that shape: a
 * plausible value nobody checked. Generation makes the corpus a FUNCTION of the capture, and
 * `generate-arrl-seed.test.ts` asserts that the committed JSON is byte-for-byte what this
 * function produces, so the two cannot drift.
 *
 * WHY IT RUNS THE PRODUCT'S OWN PIPELINE (deviation from the task brief, recorded here and in the
 * task report). The brief sketched a private mapper — its own label table, its own constraint
 * builders, its own funder routing — beside the parser and normalizer the crawl already uses.
 * That is a second implementation of the same mapping, and this codebase has already paid for
 * that shape twice over:
 *
 *   - `hashProgram` covers every field except `TrustFields`. Any field this script computed
 *     differently from `normalizeRaw` would produce a different content hash from the very first
 *     nightly crawl, so all 111 records would raise change events on night one, every night,
 *     forever — the "phantom diff" failure Task 11 recorded when it moved ARDC's `externalKey`
 *     from `grants` to `apply`.
 *   - the parser's label table has been hardened three times (`R egion`, `License   Requirement`,
 *     `Scholarshps`, and the `Region` / `Regional Preference:` prefix collision that silently
 *     corrupted a record). A second label table here would start out one round behind and would
 *     never be told about the fourth.
 *
 * So the generator is: the shipped `SourceModule.parse` over the committed capture, then the
 * shipped `normalizeRaw`, and then only the things that are genuinely SEED facts rather than
 * crawl facts — the verification stamp, the empty content-hash placeholder the loader fills, and
 * the one-hop status inheritance the crawl performs from the database (`applyInheritedStatus` in
 * crawl/runner.ts) but which normalize/ cannot see.
 *
 * IDENTITY. `NormalizeContext.existingIdFor` is the seam the crawl uses to resolve an already
 * stored record instead of minting a fresh id (RESOLUTIONS R9). Here it is handed the SEED's
 * identity map, so the generated records carry the seed's `arrl-cat-…` ids and their inherited
 * deadline points at the seeded owner (`arrl-foundation-scholarships`) rather than at a minted
 * hash id. It is the same expression the crawl evaluates against the database once Task 16's
 * importer has written `programs.source_id` / `programs.external_key`.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchedPayload, Program, ProgramStatus } from '../packages/core/src/index.js';
import { contextForSource } from '../packages/server/src/crawl/context.js';
import {
  DEADLINE_INHERITANCE,
  DEADLINE_OWNER_EXTERNAL_KEY,
} from '../packages/server/src/normalize/deadline.js';
import { normalizeRaw } from '../packages/server/src/normalize/index.js';
import { getSource } from '../packages/server/src/sources/registry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The source module whose capture this reads. A constant of the codebase, not a guess. */
export const CATALOG_SOURCE_ID = 'arrl-scholarship-descriptions';

/** Every record in this corpus carries the date of the research pass (seed/load.ts). */
export const CATALOG_LAST_VERIFIED = '2026-08-02';

/** Generated ids are prefixed so the catalogue is greppable in the corpus and in the database. */
export const CATALOG_ID_PREFIX = 'arrl-cat-';

export const CATALOG_SEED_FILE = 'programs.arrl-catalog.json';

/** PLAN-LOCAL. A Program plus the two side-car keys `seed/validate.ts` requires beside it. */
export type SeedProgram = Program & {
  /** RESOLUTIONS R9 — the crawler identity Task 16's importer writes into the programs table. */
  sourceKey: { sourceId: string; externalKey: string };
  /**
   * `unpublished`, and it is the honest answer: these records publish NO date of their own. They
   * ride `arrl-foundation-scholarships`, whose own record declares `projected` and carries the
   * RECUR directive the calendar expands. `projected` here would be rejected by the harness
   * (`inherited` is not a kind `expandCycles` projects) and `funder_published` would be a claim
   * about a window this page never printed on these entries.
   */
  dates: { basis: 'unpublished' };
};

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

export function catalogProgramId(entryName: string): string {
  return `${CATALOG_ID_PREFIX}${slug(entryName)}`;
}

/**
 * The single committed capture for this source.
 *
 * `/^\d\d-/` is the capture convention `scripts/capture-fixture.ts` writes and
 * `scripts/profile-corpus.ts` reads, and using it here is load-bearing rather than tidy:
 * `fixtures/arrl-scholarship-descriptions/` also holds `pathological.html`, a 5 KB SYNTHETIC file
 * written to exercise the parser's error paths. Generating the shipped corpus out of a synthetic
 * fixture is not a hypothetical mistake in this repo — the scholarship deadline's "12:00 noon
 * EST" claim, removed in Task 11, traced to exactly that file.
 */
function loadCapture(repoRoot: string, sourceId: string, url: string): FetchedPayload {
  const dir = path.join(repoRoot, 'fixtures', sourceId);
  const captures = readdirSync(dir)
    .filter((file) => /^\d\d-/.test(file))
    .sort();
  if (captures.length !== 1) {
    throw new Error(
      `fixtures/${sourceId}/ holds ${captures.length} captures (${captures.join(', ') || 'none'}); ` +
        'this generator reads exactly one. Add the request mapping before re-running it.',
    );
  }
  return {
    url,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: readFileSync(path.join(dir, captures[0]), 'utf8'),
    fetchedAt: `${CATALOG_LAST_VERIFIED}T00:00:00.000Z`,
  };
}

interface SeedOwner {
  id: string;
  status: ProgramStatus;
}

/**
 * The seeded record these 111 entries ride, found by the crawl's own derivation rather than by a
 * literal: `DEADLINE_INHERITANCE` names the owner's SOURCE, `DEADLINE_OWNER_EXTERNAL_KEY` names
 * the record of that source which owns the cycle, and the seed record carrying that `sourceKey`
 * is the owner. Writing `'arrl-foundation-scholarships'` here instead would be a second copy of
 * an id that Plan 4 has already renamed once (RESOLUTIONS R9) — and 111 records inheriting from a
 * programme that does not exist produce no cycles at all, in silence.
 */
function findSeedOwner(seedDirPath: string): SeedOwner {
  const ownerSourceId = DEADLINE_INHERITANCE[CATALOG_SOURCE_ID];
  const ownerExternalKey = ownerSourceId === undefined ? undefined : DEADLINE_OWNER_EXTERNAL_KEY[ownerSourceId];
  if (ownerSourceId === undefined || ownerExternalKey === undefined) {
    throw new Error(
      `normalize/deadline.ts does not say which record owns ${CATALOG_SOURCE_ID}'s cycle, so ` +
        'these entries would each fall back to a deadline of their own.',
    );
  }

  for (const file of readdirSync(seedDirPath).sort()) {
    if (!file.endsWith('.json') || file === CATALOG_SEED_FILE) continue;
    const parsed = JSON.parse(readFileSync(path.join(seedDirPath, file), 'utf8')) as {
      programs?: Array<{
        id?: string;
        sourceKey?: { sourceId?: string; externalKey?: string };
        trust?: { status?: ProgramStatus };
      }>;
    };
    for (const record of parsed.programs ?? []) {
      if (record.sourceKey?.sourceId !== ownerSourceId) continue;
      if (record.sourceKey.externalKey !== ownerExternalKey) continue;
      if (typeof record.id !== 'string' || record.trust?.status === undefined) break;
      return { id: record.id, status: record.trust.status };
    }
  }

  throw new Error(
    `No seed record carries sourceKey (${ownerSourceId}, ${ownerExternalKey}), so all 111 ` +
      'catalogue entries would inherit from a programme that does not exist and expandCycles ' +
      'would return nothing for every one of them.',
  );
}

/**
 * The one-hop status inheritance `crawl/runner.ts` performs against the database, applied here
 * against the seeded owner instead.
 *
 * `normalize/deadline.ts` returns `unknown` for a record that rides another programme's cycle,
 * deliberately: whether applications are being accepted is a fact about the OWNER, and normalize/
 * may not read a database (spec §14). The crawl fills it in from the published owner the moment
 * the owner exists. The seed is that moment, so the same rule runs here — ONLY over `unknown`,
 * never overwriting a status the record established for itself. 110 of these once shipped badged
 * `open` while the portal they ride says, twice, "The 2026 Scholarship Cycle is now closed."; the
 * one that keeps its own answer is the Winscott scholarship, whose own text says it is not
 * currently active.
 */
function withInheritedStatus(program: Program, owner: SeedOwner): Program {
  const rides =
    program.deadline.source.kind === 'inherited' && program.deadline.source.fromProgramId === owner.id;
  if (!rides || owner.status === 'unknown' || program.trust.status !== 'unknown') return program;
  return { ...program, trust: { ...program.trust, status: owner.status } };
}

export function generateArrlCatalogSeed(repoRoot: string = REPO_ROOT): SeedProgram[] {
  const module = getSource(CATALOG_SOURCE_ID);
  if (module.expectedMinRecords < 100) {
    throw new Error(
      `${CATALOG_SOURCE_ID} expects only ${module.expectedMinRecords} records; this generator is ` +
        'the catalogue one and the catalogue is 111 entries.',
    );
  }
  const requests = Array.isArray(module.requests) ? module.requests : [];
  if (requests.length !== 1) {
    throw new Error(`${CATALOG_SOURCE_ID} no longer declares exactly one static request.`);
  }

  const payload = loadCapture(repoRoot, CATALOG_SOURCE_ID, requests[0].url);
  const raws = module.parse([payload]);
  if (raws.length < module.expectedMinRecords) {
    throw new Error(
      `The parser returned ${raws.length} records from the committed capture; the module expects ` +
        `at least ${module.expectedMinRecords}. Refusing to ship a corpus that lost entries.`,
    );
  }

  const owner = findSeedOwner(path.join(repoRoot, 'data', 'seed'));

  // THE IDENTITY SEAM (RESOLUTIONS R9). Everything the crawl would read out of the database is
  // supplied here from the seed: this source's own records resolve to their `arrl-cat-…` ids, and
  // the deadline owner resolves to the seeded anchor. `normalizeRaw` and `deadlineOwnerProgramId`
  // both evaluate `ctx.existingIdFor?.(…) ?? ctx.mintId(…)`, so nothing here is a special case.
  const ctx = contextForSource(module, CATALOG_LAST_VERIFIED);
  ctx.verificationMethod = 'seed_import';
  ctx.existingIdFor = (sourceId, externalKey) => {
    if (sourceId === CATALOG_SOURCE_ID) return catalogProgramId(externalKey);
    if (sourceId === DEADLINE_INHERITANCE[CATALOG_SOURCE_ID]) return owner.id;
    return undefined;
  };

  const seen = new Map<string, string>();
  const programs: SeedProgram[] = [];
  for (const raw of raws) {
    const normalized = withInheritedStatus(normalizeRaw(raw, ctx), owner);
    const collision = seen.get(normalized.id);
    if (collision !== undefined) {
      throw new Error(
        `Two catalogue entries slug to the id "${normalized.id}": "${collision}" and ` +
          `"${raw.name}". Seed ids must be unique; widen catalogProgramId rather than dropping one.`,
      );
    }
    seen.set(normalized.id, raw.name);
    programs.push({
      ...normalized,
      trust: {
        ...normalized.trust,
        // The loader computes the real hash with `hashProgram`, which excludes TrustFields by
        // contract — a hash written into the file is stale the moment anything else changes, and
        // the harness rejects a non-empty one.
        contentHash: '',
      },
      sourceKey: { sourceId: raw.sourceId, externalKey: raw.externalKey },
      dates: { basis: 'unpublished' },
    });
  }
  return programs;
}

/** The exact bytes of the seed file, so the test can compare against the committed one. */
export function serializeArrlCatalogSeed(programs: SeedProgram[]): string {
  return `${JSON.stringify({ programs }, null, 2)}\n`;
}

function main(): void {
  const programs = generateArrlCatalogSeed();
  const outPath = path.join(REPO_ROOT, 'data', 'seed', CATALOG_SEED_FILE);
  writeFileSync(outPath, serializeArrlCatalogSeed(programs), 'utf8');
  process.stdout.write(`Wrote ${programs.length} catalog records to ${outPath}\n`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('generate-arrl-seed.ts')) {
  main();
}
