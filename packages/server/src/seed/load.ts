/**
 * The seed corpus loader.
 *
 * Why the corpus is a set of JSON files and not TypeScript: seed records are data with
 * provenance, they get re-verified on a schedule, and a maintainer updating a deadline must not
 * have to compile anything. `validate.ts` — the harness this loader runs over every file — plus
 * the tests in `seed.test.ts` are what make that safe.
 *
 * Every record in every batch carries `"contentHash": ""`. The loader computes the real hash with
 * `hashProgram`, which by contract excludes `TrustFields`, so a hash written into the file would
 * be stale the moment anything else changed. The harness rejects a non-empty one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Funder, Program } from '@grantspotter/core';
import { hashProgram } from '@grantspotter/core';
import { SeedValidationError, type SeedViolation, validateSeedFile } from './validate.js';

/**
 * The date of the research pass every record in this corpus was verified in. The harness refuses
 * a record stamped with anything else, so bumping this constant is a deliberate act that forces
 * the whole corpus to be re-verified rather than a value that quietly drifts.
 */
export const SEED_LAST_VERIFIED = '2026-08-02';

/**
 * PLAN-LOCAL. Mirrors Plan 2's (sourceId, externalKey) identity for a raw record.
 *
 * The seed corpus owns program identity. Without a stable link back to the source that re-reads a
 * record, Plan 2's `normalizeRaw` mints a fresh id from `programIdFor(sourceId, externalKey)` on
 * the very first nightly crawl and the whole corpus is duplicated — twice on night two. So each
 * seed record carries `"sourceKey"` copied verbatim from the Plan 2 source module that re-reads
 * it, Task 16's importer writes the pair into `programs.source_id` / `programs.external_key`, and
 * `normalizeRaw` resolves the existing id instead of minting one.
 *
 * `sourceKey` is deliberately not part of `Program`: CONTRACT §3 freezes that type and the two
 * columns live beside the record, not inside it.
 */
export interface SeedSourceKey {
  sourceId: string;
  externalKey: string;
}

/** PLAN-LOCAL. */
export interface SeedCorpus {
  funders: Funder[];
  /**
   * EVERY record, including any tagged `do_not_publish`. Suppressed records are stored
   * deliberately — a funder's grant history is the best evidence of who that funder funds — and
   * are hidden at every READ boundary, never dropped at load. Call `publishableSeedPrograms`
   * (re-exported below) for the subset a user may see; never write a private filter.
   */
  programs: Program[];
  /** programId → the crawler identity that owns it. Missing for records no source re-reads. */
  sourceKeys: Map<string, SeedSourceKey>;
}

export {
  SAFETY_WARNING_TAG,
  SeedValidationError,
  publishableSeedPrograms,
  validateSeedFile,
} from './validate.js';
export type { DateBasis, SeedRuleId, SeedSideCar, SeedViolation } from './validate.js';

export function seedDir(): string {
  // Walk up from this module to the repository root. `src/seed/` and `dist/seed/` sit at the same
  // depth, and Task 18 copies `data/` into `/app` so the container layout matches the repo.
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '..', '..', '..', '..', 'data', 'seed');
}

export function loadSeedCorpus(dir: string = seedDir()): SeedCorpus {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const violations: SeedViolation[] = [];
  const funders: Funder[] = [];
  const programs: Program[] = [];
  const sourceKeys = new Map<string, SeedSourceKey>();
  const seenSourceKeys = new Map<string, string>();
  const funderIds = new Set<string>();
  const programIds = new Set<string>();

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      violations.push({
        file,
        recordId: '',
        rule: 'json',
        message: `is not valid JSON: ${(error as Error).message}`,
      });
      continue;
    }

    const result = validateSeedFile(file, parsed, SEED_LAST_VERIFIED);
    violations.push(...result.violations);

    for (const funder of result.funders) {
      if (funderIds.has(funder.id)) {
        violations.push({
          file,
          recordId: funder.id,
          rule: 'duplicate-id',
          message: 'duplicate funder id in the seed corpus.',
        });
        continue;
      }
      funderIds.add(funder.id);
      funders.push(funder);
    }

    for (const program of result.programs) {
      if (programIds.has(program.id)) {
        violations.push({
          file,
          recordId: program.id,
          rule: 'duplicate-id',
          message: 'duplicate program id in the seed corpus.',
        });
        continue;
      }
      programIds.add(program.id);
      programs.push(program);

      const sourceKey = result.sideCars.get(program.id)?.sourceKey;
      if (sourceKey === undefined) continue;
      const composite = `${sourceKey.sourceId}|${sourceKey.externalKey}`;
      const owner = seenSourceKeys.get(composite);
      if (owner !== undefined) {
        violations.push({
          file,
          recordId: program.id,
          rule: 'duplicate-source-key',
          message:
            `shares sourceKey ${composite} with ${owner}. programs.source_id/external_key is ` +
            'uniquely indexed, so only one record may own a crawler identity — and the loser ' +
            'would be re-minted as a duplicate on the first nightly crawl.',
        });
        continue;
      }
      seenSourceKeys.set(composite, program.id);
      sourceKeys.set(program.id, sourceKey);
    }
  }

  for (const program of programs) {
    if (funderIds.has(program.funderId)) continue;
    violations.push({
      file: '<corpus>',
      recordId: program.id,
      rule: 'orphan-funder',
      message: `names funder "${program.funderId}", which is not in the seed corpus.`,
    });
  }

  if (violations.length > 0) throw new SeedValidationError(violations);

  return {
    funders,
    programs: programs.map((program) => ({
      ...program,
      trust: { ...program.trust, contentHash: hashProgram(program) },
    })),
    sourceKeys,
  };
}
