/**
 * DOES A SHIPPED DATA CORRECTION ACTUALLY REACH A RUNNING DEPLOYMENT?
 *
 * `seed/corrections.test.ts` proves the mechanism against a database handle. This proves the claim
 * a CONTAINER makes, because that is where it failed: the fix for 31 records was committed, the
 * image was rebuilt, the operator pulled it, `/api/health` came up serving a byte-identical
 * bundle — and every one of those records was still wrong, because nothing in the boot path could
 * write into a database that already held programs.
 *
 * So this boots the real entrypoint, on a real DATA_DIR, three times:
 *
 *   1. on an empty directory, where the importer seeds the current corpus and the reconcile
 *      correctly finds nothing to do — a fresh install must be untouched by all of this;
 *   2. after four records have been wound back to values a PREVIOUS RELEASE really shipped, one of
 *      which an operator has then edited — the shape of the owner's database;
 *   3. again, to prove the second run changes nothing.
 *
 * THE FOUR VALUES BELOW ARE REAL. They are the exact bytes `data/seed` carried before the
 * 2026-08-13 correction, and their digests are in the shipped ledger — which the first assertion
 * checks, so a regeneration that ever dropped them turns this red instead of quietly passing
 * against a ledger that can no longer prove anything.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from './db/migrate.js';
import { createProgramRepo, withContentHash } from './db/repositories/programs.js';
import { loadSeedCorpus, seedDir } from './seed/load.js';
import { digestOf, loadShippedValues } from './seed/shippedValues.js';

const ENTRYPOINT = fileURLToPath(new URL('./index.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** (record, field, the bytes an earlier release of data/seed really shipped). */
const WOUND_BACK = [
  { id: 'arrl-etp-grants', field: 'awardCountRaw', value: 'Not published.' },
  { id: 'amsat-no-grants-program', field: 'amountRaw', value: 'No grants are made.' },
  {
    id: 'far-domain-compromised',
    field: 'amountRaw',
    value: "No award is available through this organisation's former website.",
  },
] as const;

/** The fourth: wound back, and then edited here. This one must survive untouched. */
const OPERATOR = {
  id: 'chicago-fm-club-scholarship-discontinued',
  field: 'amountRaw',
  value: 'Not awarded. The programme no longer exists.',
  edit: ' Confirmed by our club secretary, 2026-08-20.',
} as const;

const started: ChildProcessWithoutNullStreams[] = [];
const dataDirs: string[] = [];

afterAll(() => {
  for (const proc of started.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function bootAndStop(dataDir: string, port: number): Promise<string> {
  const proc = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SESSION_SECRET: 'seed-corrections-test-session-secret-not-a-real-secret',
      CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter',
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

function amountRawOf(dbPath: string, id: string, field: 'amountRaw' | 'awardCountRaw'): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT amount FROM programs WHERE id = ?').get(id) as { amount: string };
    return String((JSON.parse(row.amount) as Record<string, unknown>)[field] ?? '(absent)');
  } finally {
    db.close();
  }
}

function rowBytes(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return JSON.stringify(db.prepare('SELECT * FROM programs ORDER BY id').all());
  } finally {
    db.close();
  }
}

describe('a shipped data correction, as a container performs it', () => {
  it('reaches a database the seed importer refuses to touch, and stops at the operator’s edit', async () => {
    const corpus = loadSeedCorpus(seedDir());
    const ledger = loadShippedValues();
    const dataDir = mkdtempSync(join(tmpdir(), 'grantspotter-seed-corrections-'));
    dataDirs.push(dataDir);
    const dbPath = join(dataDir, 'grantspotter.sqlite');

    // The four wound-back values are values THIS PROJECT SHIPPED, and the ledger says so.
    for (const { id, field, value } of [...WOUND_BACK, OPERATOR]) {
      expect(
        ledger.witness(id, field === 'amountRaw' ? 'amount.amountRaw' : 'amount.awardCountRaw', value),
        `data/seed/shipped-values.tsv no longer proves that ${id}.${field} ever held ` +
          `"${value}" (${digestOf(value)}). Without that line the correction below can never be ` +
          'applied on a real deployment, and this test would be measuring nothing.',
      ).toBeDefined();
    }

    // ---- boot 1: a fresh install. Nothing to correct, and nothing touched. -------------------
    const firstBoot = await bootAndStop(dataDir, 3251);
    expect(firstBoot).toContain(`[seed] Imported ${String(corpus.programs.length)} programs`);
    expect(firstBoot).toContain('[seed] Shipped-data corrections: none outstanding.');
    expect(firstBoot).not.toContain('corrected ');
    const fresh = rowBytes(dbPath);

    // ---- wind four records back to the previous release, then let an operator edit one -------
    const db = openDatabase(dbPath);
    const programs = createProgramRepo(db);
    for (const { id, field, value } of WOUND_BACK) {
      const record = programs.get(id);
      expect(record, id).toBeDefined();
      programs.upsert(withContentHash({ ...record!, amount: { ...record!.amount, [field]: value } }));
    }
    const edited = programs.get(OPERATOR.id)!;
    programs.upsert(
      withContentHash({
        ...edited,
        amount: { ...edited.amount, [OPERATOR.field]: `${OPERATOR.value}${OPERATOR.edit}` },
      }),
    );
    db.close();

    // ---- boot 2: the correction arrives ------------------------------------------------------
    const secondBoot = await bootAndStop(dataDir, 3252);
    expect(secondBoot).toContain(
      '[seed] Shipped-data corrections: 3 field(s) on 3 record(s) rewritten, 1 left alone',
    );
    for (const { id, field } of WOUND_BACK) {
      const path = field === 'amountRaw' ? 'amount.amountRaw' : 'amount.awardCountRaw';
      expect(secondBoot).toContain(`[seed]   corrected ${id}: ${path}`);
      expect(amountRawOf(dbPath, id, field)).toBe(
        String(corpus.programs.find((p) => p.id === id)!.amount[field] ?? '(absent)'),
      );
    }
    expect(secondBoot).toContain(
      `[seed]   left alone ${OPERATOR.id} amount.amountRaw — your copy is not the text GrantSpotter shipped`,
    );
    expect(amountRawOf(dbPath, OPERATOR.id, OPERATOR.field)).toBe(`${OPERATOR.value}${OPERATOR.edit}`);

    // What the operator can read afterwards, per record, with the text that was replaced.
    const audit = new Database(dbPath, { readonly: true });
    try {
      const applied = audit
        .prepare("SELECT entity_id, detail FROM audit_log WHERE action = 'seed_correction.applied' ORDER BY id")
        .all() as Array<{ entity_id: string; detail: string }>;
      expect(applied.map((r) => r.entity_id).sort()).toEqual(WOUND_BACK.map((w) => w.id).sort());
      expect(
        applied.map((r) => (JSON.parse(r.detail) as { replaced: string }).replaced).sort(),
      ).toEqual(WOUND_BACK.map((w) => w.value).sort());
      const refused = audit
        .prepare("SELECT entity_id, detail FROM audit_log WHERE action = 'seed_correction.left_alone'")
        .all() as Array<{ entity_id: string; detail: string }>;
      expect(refused).toHaveLength(1);
      expect(refused[0]!.entity_id).toBe(OPERATOR.id);
    } finally {
      audit.close();
    }

    // The three corrected records are now byte-identical to a fresh install; the edited one is
    // not, and that difference is the operator's work surviving an upgrade.
    const afterCorrection = rowBytes(dbPath);
    expect(afterCorrection).not.toBe(fresh);

    // ---- boot 3: idempotent ------------------------------------------------------------------
    const thirdBoot = await bootAndStop(dataDir, 3253);
    expect(thirdBoot).toContain('[seed] Shipped-data corrections: 0 field(s) on 0 record(s) rewritten');
    expect(thirdBoot).not.toContain('corrected ');
    expect(rowBytes(dbPath)).toBe(afterCorrection);

    const twice = new Database(dbPath, { readonly: true });
    try {
      // The refusal is recorded once, not once per restart.
      expect(
        (
          twice
            .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'seed_correction.left_alone'")
            .get() as { n: number }
        ).n,
      ).toBe(1);
    } finally {
      twice.close();
    }
  }, 300_000);
});
