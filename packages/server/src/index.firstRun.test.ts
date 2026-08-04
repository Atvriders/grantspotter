/**
 * WHAT DOES A FRESH INSTALL ACTUALLY END UP WITH?
 *
 * Everything else about the seed import is tested against a database handle. This boots the real
 * entrypoint twice against one throwaway DATA_DIR, which is the only way to see the three things
 * that are properties of the WIRING rather than of any function:
 *
 *   1. the import runs at all on a fresh install, and runs before the browse projection is built,
 *      so the corpus a first-time visitor browses is not empty;
 *   2. a restart does not import a second time — the idempotency claim as a container makes it,
 *      not as a unit test makes it;
 *   3. the crawler identity survives to disk, which is what stops the first nightly crawl from
 *      inserting a second copy of every seeded record.
 *
 * This project has already paid for the difference between the two kinds of test: the dangling
 * deadline-owner reference survived 37 commits of remediation because every test that exercised
 * inheritance hand-wrote the owner id into its own fixture, so the lookup succeeded in every test
 * and in no production run.
 *
 * `tsx` rather than `dist/`, for the same reason the shutdown suite gives: the suite must not
 * depend on a build step having been run, and `node --import tsx` runs the same module graph.
 * (The built image was additionally booted by hand against an empty DATA_DIR for Task 16; see the
 * task report.)
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { loadSeedCorpus, publishableSeedPrograms, seedDir } from './seed/load.js';

const ENTRYPOINT = fileURLToPath(new URL('./index.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const started: ChildProcessWithoutNullStreams[] = [];
const dataDirs: string[] = [];

afterAll(() => {
  for (const proc of started.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Boots the entrypoint, waits for it to listen, stops it cleanly, and returns everything it said. */
async function bootAndStop(dataDir: string, port: number): Promise<string> {
  const proc = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      // No default exists for either of these and none may be added: the server refuses to start
      // without them. This used to be an example.com contact URL; `loadConfig` refuses the RFC
      // 2606 documentation domains now, so it is loopback — which is where this process is anyway
      // and is equally not a stranger's host. The secret names itself as a test value on purpose;
      // see the reasoning in deploy/compose.test.ts.
      SESSION_SECRET: 'first-run-test-session-secret-not-a-real-secret',
      CONTACT_URL: 'http://127.0.0.1:3030/grantspotter',
      // A crawl would reach the network, and would also be the thing that duplicates the corpus
      // if the import were wired in after the scheduler.
      CRAWL_ENABLED: 'false',
    },
  }) as ChildProcessWithoutNullStreams;
  started.push(proc);

  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server never listened. Output:\n${log}`)), 60_000);
    const onData = (chunk: Buffer): void => {
      log += chunk.toString();
      if (log.includes('listening on port')) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${String(code)} before listening. Output:\n${log}`));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not stop')), 15_000);
    proc.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
  return log;
}

describe('a real first run', () => {
  it('seeds a browsable corpus on boot and does not import it twice', async () => {
    const corpus = loadSeedCorpus(seedDir());
    const publishable = publishableSeedPrograms(corpus.programs).length;

    const dataDir = mkdtempSync(join(tmpdir(), 'grantspotter-first-run-'));
    dataDirs.push(dataDir);

    const firstBoot = await bootAndStop(dataDir, 3231);
    expect(firstBoot).toContain(`[seed] Imported ${corpus.programs.length} programs`);
    expect(firstBoot).toContain(`${publishable} publishable`);

    const db = new Database(join(dataDir, 'grantspotter.sqlite'), { readonly: true });
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n).toBe(
        corpus.programs.length,
      );
      expect((db.prepare('SELECT COUNT(*) AS n FROM funders').get() as { n: number }).n).toBe(
        corpus.funders.length,
      );
      // The browse projection is the corpus a visitor actually sees, and it is built from the
      // publishable subset only. Empty here would mean the import ran too late — or not at all.
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM program_search').get() as { n: number }).n,
      ).toBe(publishable);
      // Every seeded record the crawl re-reads carries its identity on disk.
      expect(
        (
          db
            .prepare('SELECT COUNT(*) AS n FROM programs WHERE source_id IS NOT NULL')
            .get() as { n: number }
        ).n,
      ).toBe(corpus.sourceKeys.size);
      // 111 of them are the generated ARRL catalogue, and each rides the seeded owner's cycle.
      expect(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM programs
               WHERE id LIKE 'arrl-cat-%'
                 AND json_extract(deadline, '$.source.fromProgramId') = 'arrl-foundation-scholarships'`,
            )
            .get() as { n: number }
        ).n,
      ).toBe(111);
    } finally {
      db.close();
    }

    const secondBoot = await bootAndStop(dataDir, 3232);
    expect(secondBoot).toContain(
      `[seed] The programs table already holds ${corpus.programs.length} records`,
    );
    expect(secondBoot).not.toContain('[seed] Imported');

    const after = new Database(join(dataDir, 'grantspotter.sqlite'), { readonly: true });
    try {
      expect((after.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n).toBe(
        corpus.programs.length,
      );
    } finally {
      after.close();
    }
  }, 180_000);
});
