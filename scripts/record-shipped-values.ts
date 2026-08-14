/**
 * npm run seed:shipped-values
 *
 * Regenerates `data/seed/shipped-values.tsv` — the digest of every value the seed corpus has ever
 * carried, which is the ONLY thing that lets a shipped data correction reach a deployment that was
 * seeded before the correction existed. `packages/server/src/seed/corrections.ts` rewrites a field
 * only when the value it holds hashes to a line in that file; a value that was never recorded can
 * never be corrected, and a value that was recorded can never be lost, because this script unions
 * and never replaces.
 *
 *   npm run seed:shipped-values                   # the working tree
 *   npm run seed:shipped-values -- --history      # every git revision that touched data/seed
 *   npm run seed:shipped-values -- --rev f466f8e^ # one revision, e.g. the state a deployment holds
 *   npm run seed:shipped-values -- --check        # write nothing; exit 1 if the file is stale
 *
 * THE ROUTINE FOR THE NEXT CORRECTION, and it is deliberately two steps and no migration:
 *
 *   1. edit data/seed/*.json
 *   2. npm run seed:shipped-values      (unions the new values in; the old ones stay)
 *
 * `shippedValues.test.ts` fails if step 2 is skipped, and names the record. Nothing else is
 * needed: the corrections reconcile is generic over paths and records, so a second correction, and
 * a tenth, cost exactly these two steps.
 *
 * WHY GIT HISTORY IS AN OPTION AT ALL. The ledger was introduced AFTER the 2026-08-13 correction
 * had already shipped, so the values a live deployment actually holds are only in git. `--history`
 * replays every revision of data/seed through today's loader and records what each one carried. A
 * revision the current loader cannot read is reported and skipped, never guessed at.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeedCorpus, seedDir } from '../packages/server/src/seed/load.js';
import {
  ShippedValues,
  digestOf,
  formatShippedValues,
  loadShippedValues,
  shippedValuesPath,
  witnessedValuesOf,
} from '../packages/server/src/seed/shippedValues.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** ISO day of a revision, which is the date that revision's values were first carried. */
function revDate(rev: string): string {
  return git(['show', '-s', '--format=%cs', rev]).trim();
}

/** Materialises data/seed/*.json at one revision into a temp directory. */
function seedDirAtRev(rev: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'grantspotter-seed-rev-'));
  const listed = git(['ls-tree', '--name-only', rev, 'data/seed/']).trim();
  for (const path of listed.split('\n')) {
    if (!path.endsWith('.json')) continue;
    writeFileSync(join(dir, path.slice('data/seed/'.length)), git(['show', `${rev}:${path}`]));
  }
  return dir;
}

function recordCorpus(values: ShippedValues, dir: string, firstSeen: string): number {
  const corpus = loadSeedCorpus(dir);
  let added = 0;
  for (const program of corpus.programs) {
    for (const { path, value } of witnessedValuesOf(program)) {
      const before = values.size;
      values.add({ sha256: digestOf(value), programId: program.id, path, firstSeen });
      if (values.size > before) added += 1;
    }
  }
  return added;
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const history = args.includes('--history');
  const revAt = args.indexOf('--rev');
  const explicitRevs = revAt >= 0 ? args.slice(revAt + 1).filter((a) => !a.startsWith('--')) : [];

  const target = shippedValuesPath();
  const values = loadShippedValues(target);
  const before = values.size;
  console.log(`Ledger at ${target}: ${String(before)} recorded values.`);

  const revs: string[] = [...explicitRevs];
  if (history) {
    const log = git(['log', '--format=%H', '--', 'data/seed']).trim();
    revs.push(...(log === '' ? [] : log.split('\n')));
  }

  for (const rev of revs) {
    const dir = seedDirAtRev(rev);
    try {
      const added = recordCorpus(values, dir, revDate(rev));
      console.log(`  ${rev.slice(0, 8)} ${revDate(rev)}: +${String(added)}`);
    } catch (error) {
      // Never guessed at: a revision today's loader refuses is reported and skipped, and the
      // values it carried simply stay uncorrectable.
      console.log(`  ${rev.slice(0, 8)}: SKIPPED — ${(error as Error).message.split('\n')[0]}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const workingTreeDate = new Date().toISOString().slice(0, 10);
  const added = recordCorpus(values, seedDir(), workingTreeDate);
  console.log(`  working tree ${workingTreeDate}: +${String(added)}`);

  const text = formatShippedValues(values);
  if (check) {
    const current = readFileSync(target, 'utf8');
    if (current === text) {
      console.log(`\nUp to date: ${String(values.size)} values.`);
      return;
    }
    console.error(
      `\n${target} is stale (${String(before)} recorded, ${String(values.size)} needed). ` +
        'Run `npm run seed:shipped-values`.',
    );
    process.exitCode = 1;
    return;
  }
  writeFileSync(target, text);
  console.log(`\nWrote ${String(values.size)} values (${String(values.size - before)} new).`);
}

main();
