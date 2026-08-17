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
import { hashProgram, matchProgram } from '@grantspotter/core';
import type { Db } from '../db/migrate.js';
import { migrate, openDatabase } from '../db/migrate.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { applySeedCorrections, meaningOf, planForProgram } from './corrections.js';
import { importSeedIfEmpty } from './import.js';
import { loadSeedCorpus, seedDir } from './load.js';
import { matcherReadingOf } from './matcherReading.js';
import {
  CORRECTABLE_PATHS,
  ShippedValues,
  constraintRawTextPath,
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

/**
 * A record whose constraints are WRITTEN IN data/seed, not synthesised by the loader.
 *
 * `loadSeedCorpus` mints constraints of its own — `applicantEntities` becomes one, with an empty
 * `rawText` because no funder wrote it — so a record can carry constraints that appear nowhere in
 * the JSON. `previousRelease` edits the JSON, so a test that winds a sentence back has to pick a
 * record where there is a sentence in the file to wind back.
 */
function seedRecordWithWrittenConstraints(atLeast: number): { id: string; constraintIds: string[] } {
  for (const file of readdirSync(seedDir()).sort()) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(seedDir(), file), 'utf8')) as SeedFile;
    for (const record of parsed.programs ?? []) {
      const constraints = (record.constraints ?? []) as Array<{ id: string }>;
      if (constraints.length >= atLeast) {
        return { id: record.id as string, constraintIds: constraints.map((c) => c.id) };
      }
    }
  }
  throw new Error(`no seed record carries ${String(atLeast)} written constraint(s)`);
}

const SWEEP_PROFILES: Profile[] = [
  { kind: 'student', state: 'TX', licenseClass: 'GENERAL', degreeLevel: 'BACH' },
  { kind: 'student', state: 'CA', licenseClass: 'NONE', degreeLevel: 'GRAD' },
  { kind: 'student', state: 'OH', licenseClass: 'EXTRA', degreeLevel: 'BACH', fieldOfStudy: 'Music', activityKinds: [] },
  { kind: 'organization', entity: 'club_501c3', state: 'FL' },
  { kind: 'organization', entity: 'university', state: 'NY' },
];

/**
 * WHAT THE PRODUCT TELLS AN APPLICANT, separated from the sentence it prints beside it.
 *
 * `Verdict` for `ineligible` is `{ reasons: Constraint[] }` — the constraint OBJECTS, sentence
 * included — so comparing whole verdicts cannot distinguish "this correction changed who is
 * eligible" from "this correction changed a quotation", which is the only distinction that
 * matters here. This keeps the answer: the verdict kind, the preference rank and what met it, the
 * profile fields the product says are missing, and the IDS of the rules that refused.
 */
function answersOf(profile: Profile, programs: Program[], at: string): string[] {
  return programs.map((program) => {
    const verdict = matchProgram(profile, program, at);
    switch (verdict.kind) {
      case 'eligible':
        return `${program.id}|eligible`;
      case 'eligible_preferred':
        return `${program.id}|preferred|${String(verdict.rank)}|${[...verdict.met].sort().join(',')}`;
      case 'unknown':
        return `${program.id}|unknown|${[...verdict.missingProfileFields].sort().join(',')}`;
      case 'ineligible':
        return `${program.id}|ineligible|${verdict.reasons.map((r) => r.id).sort().join(',')}`;
    }
  });
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
      expect.objectContaining({
        programId: SUBJECT,
        path: 'constraints.rules',
        reason: 'eligibility-rules-differ',
      }),
    );
    expect(constraintsOf(SUBJECT)).toEqual(before);
    // ...and the sentence half of the split does not sneak the deletion through the back door:
    // the constraint the corpus dropped has no correctable sentence path at all, because it does
    // not exist on both sides.
    expect(report.applied.filter((c) => c.programId === SUBJECT)).toEqual([]);
  });

  /**
   * THE SPLIT, ON A DATABASE. `constraints` used to be one witnessed-only path, so a corrected
   * quotation could never reach a running deployment — the reconcile reported it and, by design,
   * refused to write it. These four tests are the two halves after the split: the sentence moves
   * under the same byte-identity rule as every other displayed field, and the rules do not move at
   * all.
   */
  it('rewrites a displayed sentence that still holds, byte for byte, what we shipped', () => {
    const { id: subject, constraintIds } = seedRecordWithWrittenConstraints(1);
    const targetId = constraintIds[0]!;
    const shipped = loadSeedCorpus(seedDir()).programs.find((p) => p.id === subject)!;
    const shippedText = shipped.constraints.find((c) => c.id === targetId)!.rawText;
    const dir = previousRelease((record) => {
      if (record.id !== subject) return;
      const constraints = record.constraints as Array<{ id: string; rawText: string }>;
      constraints.find((c) => c.id === targetId)!.rawText =
        'A sentence this project wrote and printed under a heading promising the funder’s own words.';
    });
    const ledger = ledgerOf([dir, seedDir()]);
    importSeedIfEmpty(db, { dir });
    expect(stored(subject).constraints.find((c) => c.id === targetId)!.rawText).not.toBe(shippedText);

    const report = applySeedCorrections(db, { ledgerPath: ledger });

    expect(report.applied).toContainEqual(
      expect.objectContaining({ programId: subject, path: constraintRawTextPath(targetId) }),
    );
    expect(stored(subject).constraints.find((c) => c.id === targetId)!.rawText).toBe(shippedText);
    // The rules half did not move, and neither did any other sentence on the record.
    expect(stored(subject).constraints.map((c) => ({ ...c, rawText: '' }))).toEqual(
      shipped.constraints.map((c) => ({ ...c, rawText: '' })),
    );
    // `content_hash` is computed over the constraints, so it has to follow the sentence.
    expect(stored(subject).trust.contentHash).toBe(hashProgram(shipped));
    expect(stored(subject).constraints).toEqual(shipped.constraints);
  });

  it('leaves a hand-edited sentence alone — and still corrects the others beside it', () => {
    const { id: subject, constraintIds } = seedRecordWithWrittenConstraints(2);
    const [firstId, secondId] = [constraintIds[0]!, constraintIds[1]!];
    const shipped = loadSeedCorpus(seedDir()).programs.find((p) => p.id === subject)!;
    const dir = previousRelease((record) => {
      if (record.id !== subject) return;
      for (const c of record.constraints as Array<{ rawText: string }>) {
        c.rawText = `Previously shipped: ${c.rawText}`;
      }
    });
    // The ledger proves the PREVIOUS release, so both sentences are provably ours...
    const ledger = ledgerOf([dir, seedDir()]);
    importSeedIfEmpty(db, { dir });
    // ...and then the operator rewrites exactly one of them.
    const at = stored(subject).constraints.findIndex((c) => c.id === secondId);
    const rows = db
      .prepare('SELECT id FROM constraints WHERE program_id = ? ORDER BY ordinal')
      .all(subject) as Array<{ id: string }>;
    const operatorText = `Previously shipped: ${shipped.constraints.find((c) => c.id === secondId)!.rawText} (corrected locally.)`;
    db.prepare('UPDATE constraints SET raw_text = ? WHERE id = ?').run(operatorText, rows[at]!.id);

    const report = applySeedCorrections(db, { ledgerPath: ledger });

    const now = stored(subject).constraints;
    expect(now.find((c) => c.id === firstId)!.rawText).toBe(
      shipped.constraints.find((c) => c.id === firstId)!.rawText,
    );
    expect(now.find((c) => c.id === secondId)!.rawText).toBe(operatorText);
    expect(report.leftAlone).toContainEqual(
      expect.objectContaining({
        programId: subject,
        path: constraintRawTextPath(secondId),
        reason: 'not-a-value-this-project-shipped',
      }),
    );
    expect(report.applied).toContainEqual(
      expect.objectContaining({ programId: subject, path: constraintRawTextPath(firstId) }),
    );
  });

  /**
   * The one that makes the split honest. `rawText` is NOT inert: `matchProgram` threads it into
   * `evaluateConstraint`, which asks whether the funder called their own list illustrative. A
   * correction that moves that reading would move a verdict, so it is refused like a note whose
   * dates move — even though every byte of it is provably ours.
   */
  it('refuses a sentence rewrite that would change what the matcher reads out of it', () => {
    const subject = loadSeedCorpus(seedDir()).programs.find(
      (p) => p.constraints.length >= 1 && !matcherReadingOf(p.constraints[0]!.rawText).openedTheList,
    )!;
    const target = subject.constraints[0]!;
    const dir = previousRelease((record) => {
      if (record.id !== subject.id) return;
      const constraints = record.constraints as Array<{ id: string; rawText: string }>;
      const was = constraints.find((c) => c.id === target.id)!;
      was.rawText = `${was.rawText} Such as the examples above.`;
    });
    const ledger = ledgerOf([dir, seedDir()]);
    importSeedIfEmpty(db, { dir });
    const before = stored(subject.id).constraints.find((c) => c.id === target.id)!.rawText;
    expect(matcherReadingOf(before).openedTheList).toBe(true);

    const report = applySeedCorrections(db, { ledgerPath: ledger });

    expect(report.leftAlone).toContainEqual(
      expect.objectContaining({
        programId: subject.id,
        path: constraintRawTextPath(target.id),
        reason: 'changes-what-the-record-means',
      }),
    );
    expect(stored(subject.id).constraints.find((c) => c.id === target.id)!.rawText).toBe(before);
  });

  it('never lets a sentence rewrite reach hard, fallback_rank or spec', () => {
    const subject = seedRecordWithWrittenConstraints(2);
    const dir = previousRelease((record) => {
      if (record.id !== subject.id) return;
      for (const c of record.constraints as Array<{ rawText: string }>) {
        c.rawText = `Previously shipped: ${c.rawText}`;
      }
    });
    const ledger = ledgerOf([dir, seedDir()]);
    importSeedIfEmpty(db, { dir });
    const rulesBefore = db
      .prepare('SELECT id, ordinal, hard, fallback_rank, axis, spec FROM constraints ORDER BY id')
      .all();

    const report = applySeedCorrections(db, { ledgerPath: ledger });

    expect(report.applied.length).toBeGreaterThan(0);
    expect(
      db.prepare('SELECT id, ordinal, hard, fallback_rank, axis, spec FROM constraints ORDER BY id').all(),
    ).toEqual(rulesBefore);
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

  /**
   * `constraints` USED TO BE UNOPENABLE, AND NOW IT IS OPENED — for exactly one column.
   *
   * The old rule ("this file never names the constraints table") was a blunt way of guaranteeing
   * the sharp one: no write may reach `hard`, `fallback_rank` or `spec`, because those are what
   * the matcher reasons over. Splitting the displayed sentence out means one UPDATE now names the
   * table, so the guarantee has to be stated at the granularity it was always about. It is
   * narrower than the rule it replaces, not weaker: `raw_text` is the only column any constraint
   * write may set, that write is keyed by row id AND program id, and it still carries the stored
   * bytes in its WHERE clause.
   */
  it('opens no statement against programs, constraints, funders or cycles except two UPDATEs', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./corrections.ts', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm, ' ');
    expect(source).not.toMatch(/DELETE\s+FROM/i);
    expect(source).not.toMatch(/INSERT\s+INTO\s+(programs|constraints|funders|cycles)/i);
    expect(source).not.toMatch(/UPDATE\s+(funders|cycles)/i);
    expect([...source.matchAll(/UPDATE\s+programs/gi)]).toHaveLength(1);

    const constraintWrites = [...source.matchAll(/UPDATE\s+constraints\s+SET\s+([^']*)'/gi)];
    expect(constraintWrites).toHaveLength(1);
    // Exactly one column, and it is the sentence. Nothing the matcher reads is assignable.
    const assigned = constraintWrites[0]![1]!;
    expect(assigned).toMatch(/^\s*raw_text\s*=\s*@to\s+WHERE\s/i);
    for (const column of ['hard', 'fallback_rank', 'spec', 'axis', 'ordinal', 'program_id', 'id']) {
      expect(assigned.slice(0, assigned.toUpperCase().indexOf('WHERE'))).not.toContain(column);
    }
    // And it is still a byte-identity write, on one row of one program.
    expect(assigned).toMatch(/WHERE\s+id\s*=\s*@rowId\s+AND\s+program_id\s*=\s*@programId\s+AND\s+raw_text\s*=\s*@from/i);
  });

  /**
   * The line the whole design rests on: a correction may change what a record SAYS and may never
   * change what it MEANS. Measured, not asserted in prose — every correctable field of every
   * record in the corpus is replaced with different text, and every verdict the matcher gives is
   * compared before and after.
   */
  it('cannot change any answer the matcher gives, for any record in the corpus', () => {
    const corpus = loadSeedCorpus(seedDir()).programs;
    const profiles = SWEEP_PROFILES;
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
      // EVERY DISPLAYED SENTENCE TOO — the half of `constraints` this round split out. Rewritten
      // the way the fence permits: a different sentence carrying the same reading. That is what a
      // correction to a quotation IS, and the assertions below are the claim that it moves nothing.
      next = {
        ...next,
        constraints: next.constraints.map((c) => ({
          ...c,
          rawText: matcherReadingOf(c.rawText).openedTheList
            ? 'Rewritten, and the funder’s list is illustrative — such as the following.'
            : 'Rewritten.',
        })),
      };
      return next;
    });

    for (const profile of profiles) {
      expect(answersOf(profile, rewritten, at)).toEqual(answersOf(profile, corpus, at));
    }
    for (let i = 0; i < corpus.length; i += 1) {
      expect(meaningOf(rewritten[i]!)).toBe(meaningOf(corpus[i]!));
    }
  });

  /**
   * ...AND THE SAME SWEEP MUST BE ABLE TO FAIL. A test that rewrites text and finds every answer
   * unchanged proves nothing unless the instrument would have noticed. `Verdict` for `ineligible`
   * carries `reasons: Constraint[]` — the constraint objects themselves — so a naive deep-equal
   * changes whenever any displayed byte does, which is why `answersOf` projects the ANSWER: the
   * kind, the rank, the missing fields, and the ids of the rules that refused. This is that
   * projection being shown to move.
   */
  it('would have noticed: the same comparison moves when a sentence changes the matcher’s reading', () => {
    const corpus = loadSeedCorpus(seedDir()).programs;
    const at = '2026-09-01T00:00:00.000Z';
    const opened = corpus.map((program) => ({
      ...program,
      constraints: program.constraints.map((c) => ({
        ...c,
        rawText: `${c.rawText} Including but not limited to the above.`,
      })),
    }));

    let moved = 0;
    for (const profile of SWEEP_PROFILES) {
      const before = answersOf(profile, corpus, at);
      const after = answersOf(profile, opened, at);
      for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);

    // And `meaningOf` — the write-time fence — refuses every one of those records rather than
    // relying on this sweep to have been run.
    const refused = corpus.filter((p, i) => meaningOf(opened[i]!) !== meaningOf(p));
    expect(refused.length).toBeGreaterThan(0);
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
