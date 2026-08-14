/**
 * A SHIPPED DATA CORRECTION, MEASURED AGAINST A DATABASE SHAPED LIKE A RUNNING DEPLOYMENT.
 *
 * Every test here seeds a real, migrated, foreign-keys-on database from a PREVIOUS RELEASE of the
 * corpus — a copy of `data/seed` with one or two fields wound back — and then runs the reconcile
 * against the corpus that ships today. That is the shape of the problem this mechanism exists for:
 * not a fresh install (where there is nothing to correct), and not a fixture (where the bytes are
 * whatever the test author typed), but a database somebody has been using.
 *
 * The two claims being proved are opposites, and both have to hold at once:
 *
 *   1. a field still holding exactly the text we shipped IS rewritten, on a database the seed
 *      importer refuses to touch;
 *   2. a field holding anything else — one character of an operator's edit is enough — is NOT
 *      rewritten, and the operator is told.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile, Program } from '@grantspotter/core';
import { hashProgram, matchAll } from '@grantspotter/core';
import type { Db } from '../db/migrate.js';
import { migrate, openDatabase } from '../db/migrate.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { applySeedCorrections, meaningOf, planForProgram } from './corrections.js';
import { importSeedIfEmpty } from './import.js';
import { loadSeedCorpus, seedDir } from './load.js';
import {
  CORRECTABLE_PATHS,
  ShippedValues,
  digestOf,
  formatShippedValues,
  valueAt,
  witnessedValuesOf,
} from './shippedValues.js';

/** The record the live site was measured on, and the one the 2026-08-13 correction rewrote. */
const SUBJECT = 'arrl-club-grant';

let db: Db;
const tempDirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface SeedFile {
  programs?: Array<Record<string, unknown>>;
}

/**
 * A copy of the shipped corpus with `mutate` applied to every record — "the release before this
 * one". It goes through `loadSeedCorpus`'s full validation on import, so a mutation that would not
 * have been shippable fails the test rather than quietly producing an unreal database.
 */
function previousRelease(mutate: (record: Record<string, unknown>) => void): string {
  const dir = temp('grantspotter-corrections-corpus-');
  for (const file of readdirSync(seedDir())) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(seedDir(), file), 'utf8')) as SeedFile;
    for (const record of parsed.programs ?? []) mutate(record);
    writeFileSync(join(dir, file), JSON.stringify(parsed, null, 2));
  }
  return dir;
}

/** A ledger recording every value carried by every one of `dirs` — the union a real one is. */
function ledgerOf(dirs: string[]): string {
  const values = new ShippedValues();
  for (const dir of dirs) {
    for (const program of loadSeedCorpus(dir).programs) {
      for (const { path, value } of witnessedValuesOf(program)) {
        values.add({ sha256: digestOf(value), programId: program.id, path, firstSeen: '2026-08-04' });
      }
    }
  }
  const file = join(temp('grantspotter-corrections-ledger-'), 'shipped-values.tsv');
  writeFileSync(file, formatShippedValues(values));
  return file;
}

function rowsOf(): string {
  return JSON.stringify(db.prepare('SELECT * FROM programs ORDER BY id').all());
}

function constraintsOf(programId: string): unknown[] {
  return db
    .prepare('SELECT id, ordinal, hard, raw_text FROM constraints WHERE program_id = ? ORDER BY ordinal')
    .all(programId);
}

function stored(programId: string): Program {
  const program = createProgramRepo(db).get(programId);
  if (program === undefined) throw new Error(`no ${programId}`);
  return program;
}

function auditRows(action?: string): Array<{ action: string; entity_id: string; detail: string }> {
  const sql =
    action === undefined
      ? 'SELECT action, entity_id, detail FROM audit_log ORDER BY id'
      : 'SELECT action, entity_id, detail FROM audit_log WHERE action = ? ORDER BY id';
  return (action === undefined ? db.prepare(sql).all() : db.prepare(sql).all(action)) as Array<{
    action: string;
    entity_id: string;
    detail: string;
  }>;
}

beforeEach(() => {
  db = openDatabase(join(temp('grantspotter-corrections-'), 'test.sqlite'));
  migrate(db);
});

afterEach(() => {
  db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a database seeded by the release before the correction', () => {
  const OLD_TEXT = 'PREVIOUS RELEASE. This is the sentence the older image shipped.';

  function seedPreviousRelease(): { dir: string; ledger: string } {
    const dir = previousRelease((record) => {
      if (record.id === SUBJECT) record.rawOtherText = OLD_TEXT;
    });
    const ledger = ledgerOf([dir, seedDir()]);
    expect(importSeedIfEmpty(db, { dir }).imported).toBe(true);
    expect(stored(SUBJECT).rawOtherText).toBe(OLD_TEXT);
    return { dir, ledger };
  }

  it('rewrites the field that still holds, byte for byte, what we shipped', () => {
    const { ledger } = seedPreviousRelease();
    const shipped = loadSeedCorpus(seedDir()).programs.find((p) => p.id === SUBJECT)!;

    const report = applySeedCorrections(db, { ledgerPath: ledger, nowISO: '2026-08-14T00:00:00.000Z' });

    expect(report.ran).toBe(true);
    expect(report.applied).toHaveLength(1);
    expect(report.applied[0]).toMatchObject({ programId: SUBJECT, path: 'rawOtherText', from: OLD_TEXT });
    expect(report.recordsChanged).toBe(1);
    expect(stored(SUBJECT).rawOtherText).toBe(shipped.rawOtherText);
  });

  it('leaves the field alone when one character of it is somebody else’s work', () => {
    const { ledger } = seedPreviousRelease();
    const edited = `${OLD_TEXT} `;
    db.prepare('UPDATE programs SET raw_other_text = ? WHERE id = ?').run(edited, SUBJECT);

    const report = applySeedCorrections(db, { ledgerPath: ledger, nowISO: '2026-08-14T00:00:00.000Z' });

    expect(report.applied).toEqual([]);
    expect(report.leftAlone).toContainEqual({
      programId: SUBJECT,
      path: 'rawOtherText',
      reason: 'not-a-value-this-project-shipped',
      storedSha256: digestOf(edited),
    });
    expect(stored(SUBJECT).rawOtherText).toBe(edited);
  });

  it('writes what it replaced into audit_log, in full, under the record’s own id', () => {
    const { ledger } = seedPreviousRelease();
    applySeedCorrections(db, { ledgerPath: ledger, nowISO: '2026-08-14T00:00:00.000Z' });

    const rows = auditRows('seed_correction.applied');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(SUBJECT);
    const detail = JSON.parse(rows[0]!.detail) as { path: string; replaced: string; replacedSha256: string };
    expect(detail.path).toBe('rawOtherText');
    expect(detail.replaced).toBe(OLD_TEXT);
    expect(detail.replacedSha256).toBe(digestOf(OLD_TEXT));
  });

  it('records the refusal too, once, however many times the container restarts', () => {
    const { ledger } = seedPreviousRelease();
    db.prepare('UPDATE programs SET raw_other_text = ? WHERE id = ?').run(`${OLD_TEXT}!`, SUBJECT);

    applySeedCorrections(db, { ledgerPath: ledger, nowISO: '2026-08-14T00:00:00.000Z' });
    const afterFirst = auditRows('seed_correction.left_alone');
    applySeedCorrections(db, { ledgerPath: ledger, nowISO: '2026-08-15T00:00:00.000Z' });
    const afterSecond = auditRows('seed_correction.left_alone');

    expect(afterFirst).toHaveLength(1);
    expect(afterSecond).toEqual(afterFirst);
    expect(JSON.parse(afterFirst[0]!.detail)).toMatchObject({
      path: 'rawOtherText',
      reason: 'not-a-value-this-project-shipped',
    });
  });

  it('changes nothing the second time it runs', () => {
    const { ledger } = seedPreviousRelease();
    applySeedCorrections(db, { ledgerPath: ledger, nowISO: '2026-08-14T00:00:00.000Z' });
    const after = rowsOf();
    const audit = auditRows();

    const second = applySeedCorrections(db, { ledgerPath: ledger, nowISO: '2026-08-15T00:00:00.000Z' });

    expect(second.applied).toEqual([]);
    expect(second.leftAlone).toEqual([]);
    expect(rowsOf()).toBe(after);
    expect(auditRows()).toEqual(audit);
  });

  it('recomputes the content hash and touches nothing else in trust', () => {
    const { ledger } = seedPreviousRelease();
    const before = stored(SUBJECT);
    // The operational state a "Verify now" or a review decision leaves behind, which a correction
    // to the record's prose must not disturb.
    const trust = { ...before.trust, status: 'dormant', lastVerifiedAt: '2026-08-09' };
    db.prepare('UPDATE programs SET trust = ?, status = ?, last_verified_at = ? WHERE id = ?').run(
      JSON.stringify(trust),
      'dormant',
      '2026-08-09',
      SUBJECT,
    );

    applySeedCorrections(db, { ledgerPath: ledger, nowISO: '2026-08-14T00:00:00.000Z' });

    const after = stored(SUBJECT);
    expect(after.trust.status).toBe('dormant');
    expect(after.trust.lastVerifiedAt).toBe('2026-08-09');
    expect(after.trust.sourceUrl).toBe(before.trust.sourceUrl);
    expect(after.trust.contentHash).toBe(hashProgram(after));
    const row = db.prepare('SELECT content_hash, status, last_verified_at FROM programs WHERE id = ?').get(SUBJECT) as {
      content_hash: string;
      status: string;
      last_verified_at: string;
    };
    expect(row.content_hash).toBe(hashProgram(after));
    expect(row.status).toBe('dormant');
    expect(row.last_verified_at).toBe('2026-08-09');
  });

  it('writes nothing at all in a dry run', () => {
    const { ledger } = seedPreviousRelease();
    const before = rowsOf();
    const report = applySeedCorrections(db, { ledgerPath: ledger, dryRun: true });
    expect(report.applied).toHaveLength(1);
    expect(rowsOf()).toBe(before);
    expect(auditRows()).toEqual([]);
  });

  it('writes nothing when the ledger is missing, because nothing can be proved', () => {
    const dir = previousRelease((record) => {
      if (record.id === SUBJECT) record.rawOtherText = OLD_TEXT;
    });
    importSeedIfEmpty(db, { dir });
    const before = rowsOf();

    const report = applySeedCorrections(db, { ledgerPath: join(temp('gs-empty-'), 'absent.tsv') });

    expect(report.ledgerSize).toBe(0);
    expect(report.applied).toEqual([]);
    expect(rowsOf()).toBe(before);
  });
});

describe('what it must never do', () => {
  it('never touches a record the shipped corpus does not contain', () => {
    const dir = previousRelease((record) => {
      if (record.id === SUBJECT) record.rawOtherText = 'PREVIOUS RELEASE.';
    });
    const ledger = ledgerOf([dir, seedDir()]);
    importSeedIfEmpty(db, { dir });

    const local: Program = { ...stored(SUBJECT), id: 'an-operators-own-record', rawOtherText: 'PREVIOUS RELEASE.' };
    createProgramRepo(db).upsert(local);
    const before = db.prepare('SELECT * FROM programs WHERE id = ?').get(local.id);

    applySeedCorrections(db, { ledgerPath: ledger });

    expect(db.prepare('SELECT * FROM programs WHERE id = ?').get(local.id)).toEqual(before);
  });

  it('never puts back a record somebody deleted', () => {
    const dir = previousRelease((record) => {
      if (record.id === SUBJECT) record.rawOtherText = 'PREVIOUS RELEASE.';
    });
    const ledger = ledgerOf([dir, seedDir()]);
    importSeedIfEmpty(db, { dir });
    createProgramRepo(db).remove(SUBJECT);
    const count = createProgramRepo(db).count();

    const report = applySeedCorrections(db, { ledgerPath: ledger });

    expect(report.absent).toBe(1);
    expect(createProgramRepo(db).count()).toBe(count);
    expect(createProgramRepo(db).get(SUBJECT)).toBeUndefined();
  });

  /**
   * The 2026-08-13 correction DELETES three constraints whose `rawText` was this project's own
   * sentence. Deleting one changes who the matcher calls eligible, so it is reported and left,
   * and the constraint rows are still there afterwards.
   */
  it('never deletes a constraint the corpus dropped — it reports it', () => {
    const dir = previousRelease((record) => {
      if (record.id !== SUBJECT) return;
      record.constraints = [
        {
          id: 'club-grant-invented',
          hard: true,
          fallbackRank: 0,
          rawText: 'The club must be ARRL-affiliated (previous release; a rule we wrote ourselves).',
          spec: { axis: 'arrl_membership', required: true, minYears: 0 },
        },
      ];
    });
    const ledger = ledgerOf([dir, seedDir()]);
    importSeedIfEmpty(db, { dir });
    const before = constraintsOf(SUBJECT);
    expect(before).toHaveLength(1);

    const report = applySeedCorrections(db, { ledgerPath: ledger });

    expect(report.leftAlone).toContainEqual(
      expect.objectContaining({ programId: SUBJECT, path: 'constraints', reason: 'eligibility-rules-differ' }),
    );
    expect(constraintsOf(SUBJECT)).toEqual(before);
  });

  it('never rewrites a note whose recurrence or funder-stated window would move', () => {
    const subject = 'austin-arc-greenwood';
    const dir = previousRelease((record) => {
      if (record.id !== subject) return;
      const deadline = record.deadline as { note: string };
      deadline.note = deadline.note.replace('window=05-01..07-31', 'window=04-01..06-30');
    });
    const ledger = ledgerOf([dir, seedDir()]);
    importSeedIfEmpty(db, { dir });
    const noteBefore = stored(subject).deadline.note;

    const report = applySeedCorrections(db, { ledgerPath: ledger });

    expect(report.leftAlone).toContainEqual(
      expect.objectContaining({
        programId: subject,
        path: 'deadline.note',
        reason: 'changes-what-the-record-means',
      }),
    );
    expect(stored(subject).deadline.note).toBe(noteBefore);
  });

  it('rewrites the prose of a note whose recurrence stays byte-identical', () => {
    const subject = 'austin-arc-greenwood';
    const dir = previousRelease((record) => {
      if (record.id !== subject) return;
      const deadline = record.deadline as { note: string };
      deadline.note = `${deadline.note} A sentence the previous release carried.`;
    });
    const ledger = ledgerOf([dir, seedDir()]);
    importSeedIfEmpty(db, { dir });
    const shipped = loadSeedCorpus(seedDir()).programs.find((p) => p.id === subject)!;

    const report = applySeedCorrections(db, { ledgerPath: ledger });

    expect(report.applied).toContainEqual(
      expect.objectContaining({ programId: subject, path: 'deadline.note' }),
    );
    expect(stored(subject).deadline.note).toBe(shipped.deadline.note);
  });

  it('opens no statement against programs, constraints, funders or cycles except one UPDATE', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./corrections.ts', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm, ' ');
    expect(source).not.toMatch(/DELETE\s+FROM/i);
    expect(source).not.toMatch(/INSERT\s+INTO\s+(programs|constraints|funders|cycles)/i);
    expect(source).not.toMatch(/UPDATE\s+(constraints|funders|cycles)/i);
    expect([...source.matchAll(/UPDATE\s+programs/gi)]).toHaveLength(1);
  });

  /**
   * The line the whole design rests on: a correction may change what a record SAYS and may never
   * change what it MEANS. Measured, not asserted in prose — every correctable field of every
   * record in the corpus is replaced with different text, and every verdict the matcher gives is
   * compared before and after.
   */
  it('cannot change any answer the matcher gives, for any record in the corpus', () => {
    const corpus = loadSeedCorpus(seedDir()).programs;
    const profiles: Profile[] = [
      { kind: 'student', state: 'TX', licenseClass: 'GENERAL', degreeLevel: 'BACH' },
      { kind: 'student', state: 'CA', licenseClass: 'NONE', degreeLevel: 'GRAD' },
      { kind: 'organization', entity: 'club_501c3', state: 'FL' },
      { kind: 'organization', entity: 'university', state: 'NY' },
    ];
    const at = '2026-09-01T00:00:00.000Z';
    const rewritten = corpus.map((program) => {
      let next = program;
      for (const path of CORRECTABLE_PATHS) {
        if (valueAt(next, path) === undefined) continue;
        switch (path) {
          case 'summary':
            next = { ...next, summary: 'Rewritten.' };
            break;
          case 'rawOtherText':
            next = { ...next, rawOtherText: 'Rewritten.' };
            break;
          case 'amount.amountRaw':
            next = { ...next, amount: { ...next.amount, amountRaw: 'Rewritten.' } };
            break;
          case 'amount.awardCountRaw':
            next = { ...next, amount: { ...next.amount, awardCountRaw: 'Rewritten.' } };
            break;
          case 'deadline.note':
            // The prose after the directive, which is all a correction may move here.
            next = { ...next, deadline: { ...next.deadline, note: `${next.deadline.note} Rewritten.` } };
            break;
          case 'aiPolicy.quote':
            next = { ...next, aiPolicy: { ...next.aiPolicy, quote: 'Rewritten.' } };
            break;
          case 'fundingRestrictions':
            next = { ...next, fundingRestrictions: ['Rewritten.'] };
            break;
        }
      }
      return next;
    });

    for (const profile of profiles) {
      expect([...matchAll(profile, rewritten, at)]).toEqual([...matchAll(profile, corpus, at)]);
    }
    for (let i = 0; i < corpus.length; i += 1) {
      expect(meaningOf(rewritten[i]!)).toBe(meaningOf(corpus[i]!));
    }
  });
});

describe('a fresh install', () => {
  it('has nothing to correct, and nothing is written', () => {
    importSeedIfEmpty(db, { dir: seedDir() });
    const before = rowsOf();

    const report = applySeedCorrections(db);

    expect(report.ran).toBe(true);
    expect(report.applied).toEqual([]);
    expect(report.leftAlone).toEqual([]);
    expect(report.examined).toBe(loadSeedCorpus(seedDir()).programs.length);
    expect(report.absent).toBe(0);
    expect(rowsOf()).toBe(before);
    expect(auditRows()).toEqual([]);
  });
});

describe('the plan, as a pure decision', () => {
  const corpus = loadSeedCorpus(seedDir()).programs;
  const subject = corpus.find((p) => p.id === SUBJECT)!;

  it('says nothing about a record that already matches the corpus', () => {
    expect(planForProgram(subject, subject, new ShippedValues())).toEqual({
      corrections: [],
      leftAlone: [],
    });
  });

  it('will not write into a field this database does not carry', () => {
    // `aiPolicy.quote` is the optional one: a funder who published no AI policy has no quote, and
    // an absent field is not an empty one — there are no bytes to prove untouched.
    const withoutQuote: Program = { ...subject, aiPolicy: { stance: 'unaddressed' } };
    const shipped: Program = { ...subject, aiPolicy: { stance: 'unaddressed', quote: 'A sentence.' } };
    const plan = planForProgram(withoutQuote, shipped, new ShippedValues());
    expect(plan.corrections).toEqual([]);
    expect(plan.leftAlone).toContainEqual(
      expect.objectContaining({ path: 'aiPolicy.quote', reason: 'field-absent-here' }),
    );
  });

  it('will not clear a field the corpus stopped carrying', () => {
    const holdsQuote: Program = { ...subject, aiPolicy: { stance: 'unaddressed', quote: 'A sentence.' } };
    const shipped: Program = { ...subject, aiPolicy: { stance: 'unaddressed' } };
    const plan = planForProgram(holdsQuote, shipped, new ShippedValues());
    expect(plan.corrections).toEqual([]);
    expect(plan.leftAlone).toContainEqual(
      expect.objectContaining({ path: 'aiPolicy.quote', reason: 'corpus-no-longer-carries-this-field' }),
    );
  });
});
