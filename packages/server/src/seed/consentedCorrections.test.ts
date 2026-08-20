/**
 * THE SECOND DOOR, MEASURED ON A DATABASE SHAPED LIKE A RUNNING DEPLOYMENT.
 *
 * Every test here seeds a real, migrated, foreign-keys-on database from a PREVIOUS RELEASE of the
 * corpus — the shipped corpus with one or two facts wound back — runs the BOOT reconcile first,
 * exactly as `index.ts` does, and only then asks what is left. That order is the claim: what this
 * door offers is precisely what the automatic one refuses, and nothing else.
 *
 * The three winds-back are the three real defects the live instance is serving:
 *   - a constraint whose SPEC is narrower than the funder's own sentence (the DARA shape),
 *   - a `deadline.note` asserting a close time the funder never published (the ARRL shape),
 *   - a record the corpus has since added, which the importer will not write into a non-empty
 *     database.
 *
 * They are synthesised here rather than checked out of git so that this file keeps testing the
 * MECHANISM after `data/seed` moves on.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile } from '@grantspotter/core';
import type { Db } from '../db/migrate.js';
import { migrate, openDatabase } from '../db/migrate.js';
import { createProfileRepo } from '../db/repositories/profiles.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { createUserRepo } from '../db/repositories/users.js';
import { applySeedCorrections } from './corrections.js';
import { applyConsented, pendingChanges, verdictLabel } from './consentedCorrections.js';
import { importSeedIfEmpty } from './import.js';
import { loadSeedCorpus, seedDir } from './load.js';
import {
  ShippedValues,
  digestOf,
  formatShippedValues,
  witnessedValuesOf,
} from './shippedValues.js';

const NOW = '2026-08-20T00:00:00.000Z';

/** The record whose eligibility RULE the previous release got wrong. */
const RULE_SUBJECT = 'arrl-cat-the-arrl-general-fund-scholarship';
/** The record whose `deadline.note` asserts a close time its own prose denies. */
const DEADLINE_SUBJECT = 'arrl-foundation-scholarships';
/** The record the corpus has since added, and which no importer will write. */
const NEW_SUBJECT = 'arrl-foundation-special-funds';

/** A licensed Technician. Refused by an EXTRA floor; not refused by the TECH one that ships. */
const TECHNICIAN: Profile = {
  kind: 'student',
  callsign: 'W4EXAMPLE',
  licenseClass: 'TECH',
  licensedSince: '2020-02-01T00:00:00.000Z',
  state: 'FL',
  callDistrict: '4',
  fieldOfStudy: 'Electronics Technology',
  degreeLevel: 'BACH',
  accredited: true,
  partTime: false,
  gpa: 3.4,
  citizenship: 'US_CITIZEN',
  birthDate: '2004-06-01T00:00:00.000Z',
  stage: 'UNDERGRAD',
};

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

interface RawConstraint {
  id: string;
  spec: Record<string, unknown>;
}

/**
 * A copy of the shipped corpus with `mutate` applied to every record — "the release before this
 * one". It goes through `loadSeedCorpus`'s full validation on import, so a wind-back that would
 * not have been shippable fails the test rather than quietly producing an unreal database.
 */
function previousRelease(mutate: (record: Record<string, unknown>) => void): string {
  const dir = temp('grantspotter-consented-corpus-');
  for (const file of readdirSync(seedDir())) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(seedDir(), file), 'utf8')) as SeedFile;
    const kept: Array<Record<string, unknown>> = [];
    for (const record of parsed.programs ?? []) {
      mutate(record);
      if (record.id !== DROPPED) kept.push(record);
    }
    if (parsed.programs !== undefined) parsed.programs = kept;
    writeFileSync(join(dir, file), JSON.stringify(parsed, null, 2));
  }
  return dir;
}

/** Set by `withoutTheNewRecord` so `previousRelease` can drop a record as well as edit one. */
let DROPPED: string | null = null;

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
  const file = join(temp('grantspotter-consented-ledger-'), 'shipped-values.tsv');
  writeFileSync(file, formatShippedValues(values));
  return file;
}

/** The three winds-back, together: this is the deployment the live instance actually is. */
function theReleaseBefore(): { dir: string; ledgerPath: string } {
  DROPPED = NEW_SUBJECT;
  const dir = previousRelease((record) => {
    if (record.id === RULE_SUBJECT) {
      // A SPEC NARROWER THAN THE SENTENCE ABOVE IT. The displayed sentence is untouched, which is
      // the whole shape of the defect: the funder's words say one thing and the rule says another.
      for (const constraint of record.constraints as RawConstraint[]) {
        if (constraint.spec.axis === 'license') constraint.spec.licenseMin = 'EXTRA';
      }
    }
    if (record.id === DEADLINE_SUBJECT) {
      const deadline = record.deadline as { note: string };
      deadline.note = deadline.note.replace(
        /(RECUR annual_window tz=\S+ window=\S+)/,
        '$1 close=12:00',
      );
    }
  });
  DROPPED = null;
  return { dir, ledgerPath: ledgerOf([dir, seedDir()]) };
}

/**
 * Seed from a previous release and run the BOOT reconcile, exactly as `index.ts` does.
 *
 * WHAT IT RETURNS IS ONLY THE LEDGER, and the omission is the point: everything downstream
 * reconciles against `seedDir()` — the corpus in the image this code is part of — because that is
 * what a deployment does. Handing a test the previous-release directory as well would let it
 * compare the old corpus against itself, find nothing, and pass every assertion vacuously.
 */
function deploymentSeededBefore(): { ledgerPath: string } {
  const release = theReleaseBefore();
  importSeedIfEmpty(db, { dir: release.dir });
  applySeedCorrections(db, { nowISO: NOW, ledgerPath: release.ledgerPath });
  return { ledgerPath: release.ledgerPath };
}

function saveProfile(profile: Profile): string {
  const user = createUserRepo(db).create({
    email: `member${String(Math.random()).slice(2)}@example.org`,
    passwordHash: 'not-a-real-hash',
    role: 'member',
    displayName: '',
  });
  createProfileRepo(db).upsert(user.id, profile);
  return user.id;
}

function anAdmin(): string {
  return createUserRepo(db).create({
    email: `admin${String(Math.random()).slice(2)}@example.org`,
    passwordHash: 'not-a-real-hash',
    role: 'admin',
    displayName: '',
  }).id;
}

function everyRow(): string {
  return JSON.stringify([
    db.prepare('SELECT * FROM programs ORDER BY id').all(),
    db.prepare('SELECT * FROM constraints ORDER BY id').all(),
    db.prepare('SELECT * FROM funders ORDER BY id').all(),
  ]);
}

function auditRows(action: string): Array<{ actor_user_id: string | null; entity_id: string; detail: string }> {
  return db
    .prepare('SELECT actor_user_id, entity_id, detail FROM audit_log WHERE action = ? ORDER BY id')
    .all(action) as Array<{ actor_user_id: string | null; entity_id: string; detail: string }>;
}

beforeEach(() => {
  db = openDatabase(join(temp('grantspotter-consented-db-'), 'grantspotter.sqlite'));
  migrate(db);
});

afterEach(() => {
  db.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('what the second door offers', () => {
  it('offers exactly what the boot reconcile refused, and nothing it applied', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });

    expect(plan.ran).toBe(true);
    expect(plan.rules.map((p) => p.programId)).toContain(RULE_SUBJECT);
    expect(plan.wording.map((p) => p.programId)).toContain(DEADLINE_SUBJECT);
    expect(plan.additions.map((p) => p.programId)).toEqual([NEW_SUBJECT]);

    // The boot path already applied every correction that does not move meaning, so nothing it
    // touched can still be outstanding: a `deadline.note` whose PROSE changed is not in this list.
    expect(plan.wording.length).toBeGreaterThan(0);
    for (const proposal of plan.wording) {
      const stored = createProgramRepo(db).get(proposal.programId)!;
      expect(stored.deadline.note).toBe(proposal.from);
    }
  });

  it('shows the funder’s own sentence behind an eligibility rule, and every field that moves', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const proposal = plan.rules.find((p) => p.programId === RULE_SUBJECT)!;

    const change = proposal.changes.find((c) => c.fields.some((f) => f.field === 'spec.licenseMin'))!;
    expect(change.change).toBe('changed');
    expect(change.fields).toContainEqual({
      field: 'spec.licenseMin',
      before: '"EXTRA"',
      after: '"TECH"',
    });
    // THE SENTENCE IS THE DATABASE'S, not the corpus's: it is the text under which a member is
    // being refused right now, and it is what the operator has to read the rule against.
    const stored = createProgramRepo(db).get(RULE_SUBJECT)!;
    const constraint = stored.constraints.find((c) => c.id === change.constraintId)!;
    expect(change.sentence).toBe(constraint.rawText);
    expect(change.sentence).not.toBe('');
  });

  it('measures who moves against the applicant profiles saved on this instance', () => {
    const release = deploymentSeededBefore();
    saveProfile(TECHNICIAN);
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const proposal = plan.rules.find((p) => p.programId === RULE_SUBJECT)!;

    expect(plan.profilesMeasured).toBe(1);
    expect(proposal.impact).toEqual({
      profilesMeasured: 1,
      moves: [{ before: 'refused', after: 'eligible', count: 1 }],
    });
  });

  /**
   * THE HALF THAT IS EASY TO GET WRONG, AND THIS PROJECT HAS GOT IT WRONG BEFORE.
   *
   * `scripts/profile-corpus.ts` once reported eligibility figures against a population 23% larger
   * than the one a user can reach, and its own comment records the lesson: an over-reporting
   * instrument is worse than none because it manufactures confidence. An instance with no saved
   * profiles must therefore say it measured nothing — never fill the space with invented students.
   */
  it('measures nothing, and says so, when no applicant profile is saved here', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });

    expect(plan.profilesMeasured).toBe(0);
    // NOT VACUOUS. An earlier draft of this file handed `pendingChanges` the previous release as
    // its corpus, so it compared that corpus against itself, offered nothing, and passed nine
    // assertions that iterate over an empty list. Every loop below is guarded by a count.
    expect(plan.rules.length + plan.wording.length + plan.additions.length).toBeGreaterThan(1);
    for (const proposal of [...plan.rules, ...plan.wording, ...plan.additions]) {
      expect(proposal.impact).toEqual({ profilesMeasured: 0, moves: [] });
    }
  });

  it('names the deadline a note moves, and the records that move with it', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const proposal = plan.wording.find((p) => p.programId === DEADLINE_SUBJECT)!;

    expect(proposal.path).toBe('deadline.note');
    expect(proposal.from).toContain('close=12:00');
    expect(proposal.to).not.toContain('close=12:00');
    const move = proposal.deadline!;
    expect(move.before).not.toBe(move.after);
    expect(move.nextCloseBefore).not.toBe(move.nextCloseAfter);
    // The ARRL Foundation cycle is the one 112 catalogue entries inherit. A change to it is not a
    // change to one record, and an operator who is not told that is being asked to consent blind.
    expect(move.inheritedBy).toBeGreaterThan(1);
  });
});

describe('what the second door refuses', () => {
  it('never offers a field somebody here has edited, and never writes one', () => {
    const release = deploymentSeededBefore();
    const programs = createProgramRepo(db);
    const before = programs.get(DEADLINE_SUBJECT)!;
    programs.upsert({
      ...before,
      deadline: { ...before.deadline, note: `${before.deadline.note} An operator's own sentence.` },
    });

    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    expect(plan.wording.map((p) => p.programId)).not.toContain(DEADLINE_SUBJECT);
    expect(plan.notOffered).toContainEqual(
      expect.objectContaining({
        programId: DEADLINE_SUBJECT,
        path: 'deadline.note',
        reason: 'not-a-value-this-project-shipped',
      }),
    );
  });

  it('refuses to rewrite rules it cannot prove GrantSpotter shipped', () => {
    const release = deploymentSeededBefore();
    const withLedger = pendingChanges(db, { ...release, nowISO: NOW });
    const proposal = withLedger.rules.find((p) => p.programId === RULE_SUBJECT)!;

    // The same database, reconciled against a ledger that proves nothing.
    const emptyLedger = join(temp('grantspotter-empty-ledger-'), 'shipped-values.tsv');
    writeFileSync(emptyLedger, formatShippedValues(new ShippedValues()));

    const blind = pendingChanges(db, { ledgerPath: emptyLedger, nowISO: NOW });
    expect(blind.rules).toEqual([]);

    const before = everyRow();
    const result = applyConsented(db, {
      ledgerPath: emptyLedger,
      act: 'correct',
      proposalIds: [proposal.id],
      userId: anAdmin(),
      nowISO: NOW,
    });
    expect(result.applied).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(everyRow()).toBe(before);
  });

  it('refuses an id it does not recognise, and writes nothing', () => {
    const release = deploymentSeededBefore();
    const before = everyRow();
    const result = applyConsented(db, {
      ...release,
      act: 'correct',
      proposalIds: ['not-a-proposal-anybody-was-shown'],
      userId: anAdmin(),
      nowISO: NOW,
    });
    expect(result.ran).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.refused[0]!.why).toMatch(/no longer being offered/);
    expect(everyRow()).toBe(before);
  });

  /**
   * ADDING A PROGRAMME IS NOT CORRECTING ONE, and the rule lives in the server rather than in the
   * page: a script, a stale tab or a second admin console cannot post an addition to the
   * corrections door and have it obeyed.
   */
  it('will not add a programme through the corrections door', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const addition = plan.additions[0]!;

    const before = everyRow();
    const result = applyConsented(db, {
      ...release,
      act: 'correct',
      proposalIds: [addition.id],
      userId: anAdmin(),
      nowISO: NOW,
    });
    expect(result.applied).toEqual([]);
    expect(result.refused[0]!.why).toMatch(/not a correction/);
    expect(everyRow()).toBe(before);
    expect(createProgramRepo(db).get(NEW_SUBJECT)).toBeUndefined();
  });

  it('will not correct a record through the addition door', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const proposal = plan.rules.find((p) => p.programId === RULE_SUBJECT)!;

    const before = everyRow();
    const result = applyConsented(db, {
      ...release,
      act: 'add',
      proposalIds: [proposal.id],
      userId: anAdmin(),
      nowISO: NOW,
    });
    expect(result.applied).toEqual([]);
    expect(result.refused[0]!.why).toMatch(/not an addition/);
    expect(everyRow()).toBe(before);
  });

  /**
   * The one property that makes every other refusal in this file worth stating: the boot path is
   * not weakened by any of it. `index.ts` never imports this module, so nothing here can run
   * without a request from a signed-in administrator.
   */
  it('is not reachable from the boot path', () => {
    const index = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(index).not.toContain('consentedCorrections');
    expect(index).toContain('applySeedCorrections');
  });

  /**
   * EVERY WRITE GOES THROUGH A REPOSITORY THE REST OF THE PRODUCT USES.
   *
   * `corrections.ts` earns its safety by holding exactly two hand-written UPDATEs and no other
   * verb, and `corrections.test.ts` reads its source to prove it. This file cannot make the same
   * claim — it has to replace a constraint array and insert a programme — so it makes a different
   * one: it writes no SQL of its own at all. Every mutation is `programs.upsert`,
   * `funders.upsert`, `appendAuditLog` or `reindexBrowse`, each already tested where it lives, and
   * none of them can reach a table this file has no business in.
   */
  it('opens no write statement of its own', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./consentedCorrections.ts', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm, ' ');
    expect(source).not.toMatch(/DELETE\s+FROM/i);
    expect(source).not.toMatch(/INSERT\s+INTO/i);
    expect(source).not.toMatch(/UPDATE\s+\w+\s+SET/i);
    // The one statement it does prepare, and it is a read.
    expect([...source.matchAll(/db\.prepare\(/g)]).toHaveLength(1);
    expect(source).toMatch(/SELECT data FROM profiles/);
  });
});

describe('applying what was consented to', () => {
  it('applies only the changes it was named, and leaves the rest outstanding', () => {
    const release = deploymentSeededBefore();
    saveProfile(TECHNICIAN);
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const proposal = plan.rules.find((p) => p.programId === RULE_SUBJECT)!;
    const outstanding = plan.rules.length + plan.wording.length;

    const result = applyConsented(db, {
      ...release,
      act: 'correct',
      proposalIds: [proposal.id],
      userId: anAdmin(),
      nowISO: NOW,
    });

    expect(result.ran).toBe(true);
    expect(result.applied.map((a) => a.programId)).toEqual([RULE_SUBJECT]);
    expect(result.refused).toEqual([]);
    expect(result.programsReindexed).toBeGreaterThan(0);

    const shipped = loadSeedCorpus(seedDir()).programs.find((p) => p.id === RULE_SUBJECT)!;
    const stored = createProgramRepo(db).get(RULE_SUBJECT)!;
    const license = stored.constraints.find((c) => c.spec.axis === 'license')!;
    expect(license.spec).toEqual(shipped.constraints.find((c) => c.spec.axis === 'license')!.spec);
    expect(verdictLabel({ kind: 'eligible' })).toBe('eligible');

    const after = pendingChanges(db, { ...release, nowISO: NOW });
    expect(after.rules.length + after.wording.length).toBe(outstanding - 1);
    expect(after.rules.map((p) => p.programId)).not.toContain(RULE_SUBJECT);
  });

  /**
   * THE SENTENCE DOES NOT MOVE WITH THE RULE. A displayed quotation is prose, and prose is
   * rewritten only under the byte-identity rule, by the other door, on its own evidence.
   */
  it('replaces the rules and keeps every sentence the database holds', () => {
    const release = deploymentSeededBefore();
    const programs = createProgramRepo(db);
    const before = programs.get(RULE_SUBJECT)!;
    const edited = before.constraints.map((c, i) =>
      i === 0 ? { ...c, rawText: 'A sentence an operator typed here.' } : c,
    );
    programs.upsert({ ...before, constraints: edited });

    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const proposal = plan.rules.find((p) => p.programId === RULE_SUBJECT)!;
    applyConsented(db, {
      ...release,
      act: 'correct',
      proposalIds: [proposal.id],
      userId: anAdmin(),
      nowISO: NOW,
    });

    const after = programs.get(RULE_SUBJECT)!;
    expect(after.constraints.map((c) => c.rawText)).toEqual(edited.map((c) => c.rawText));
    expect(after.constraints[0]!.rawText).toBe('A sentence an operator typed here.');
  });

  it('writes the whole of what it replaced to the audit log, under the admin who consented', () => {
    const release = deploymentSeededBefore();
    saveProfile(TECHNICIAN);
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const proposal = plan.rules.find((p) => p.programId === RULE_SUBJECT)!;
    const replaced = createProgramRepo(db).get(RULE_SUBJECT)!.constraints;
    const admin = anAdmin();

    applyConsented(db, {
      ...release,
      act: 'correct',
      proposalIds: [proposal.id],
      userId: admin,
      nowISO: NOW,
    });

    const rows = auditRows('seed_correction.consented_rules');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(RULE_SUBJECT);
    // NOT null. The boot path's rows have no actor because nobody caused them; this act has a
    // person behind it and the row has to name them.
    expect(rows[0]!.actor_user_id).toBe(admin);

    const detail = JSON.parse(rows[0]!.detail) as Record<string, unknown>;
    // The replaced text IN FULL: once the constraint rows are rewritten this is the only copy.
    for (const constraint of replaced) {
      expect(detail.replaced as string).toContain(JSON.stringify(constraint.rawText).slice(1, -1));
      expect(detail.replaced as string).toContain('"EXTRA"');
    }
    // And what the operator was told it would move, so the record says what they consented to.
    expect(detail.moves).toEqual([{ before: 'refused', after: 'eligible', count: 1 }]);
    expect(detail.profilesMeasured).toBe(1);
  });

  it('rewrites the deadline the boot path would not, and moves the projected close with it', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const proposal = plan.wording.find((p) => p.programId === DEADLINE_SUBJECT)!;

    const result = applyConsented(db, {
      ...release,
      act: 'correct',
      proposalIds: [proposal.id],
      userId: anAdmin(),
      nowISO: NOW,
    });

    expect(result.applied).toHaveLength(1);
    const stored = createProgramRepo(db).get(DEADLINE_SUBJECT)!;
    expect(stored.deadline.note).toBe(proposal.to);
    expect(stored.deadline.note).not.toContain('close=12:00');

    const detail = JSON.parse(auditRows('seed_correction.consented_wording')[0]!.detail) as {
      replaced: string;
    };
    expect(detail.replaced).toContain('close=12:00');
  });

  it('adds a programme through its own door, with the funder it needs', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const addition = plan.additions[0]!;
    const admin = anAdmin();

    const result = applyConsented(db, {
      ...release,
      act: 'add',
      proposalIds: [addition.id],
      userId: admin,
      nowISO: NOW,
    });

    expect(result.applied.map((a) => a.programId)).toEqual([NEW_SUBJECT]);
    const stored = createProgramRepo(db).get(NEW_SUBJECT)!;
    const shipped = loadSeedCorpus(seedDir()).programs.find((p) => p.id === NEW_SUBJECT)!;
    expect(stored.name).toBe(shipped.name);
    expect(stored.constraints).toHaveLength(shipped.constraints.length);

    const rows = auditRows('seed_correction.record_added');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(admin);
    // NOTHING WAS DESTROYED, said out loud rather than left as an absent key.
    expect((JSON.parse(rows[0]!.detail) as { replaced: unknown }).replaced).toBeNull();
  });

  /**
   * THE PROPERTY THAT MAKES THIS SAFE TO PUT IN FRONT OF SOMEBODY: pressing it twice does what
   * pressing it once did. After a change lands, the stored value IS the shipped value, so the
   * proposal no longer exists and its id refuses rather than resolving to something else.
   */
  it('changes nothing the second time', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const ids = [...plan.rules, ...plan.wording].map((p) => p.id);
    expect(ids.length).toBeGreaterThan(1);
    const admin = anAdmin();

    const first = applyConsented(db, {
      ...release,
      act: 'correct',
      proposalIds: ids,
      userId: admin,
      nowISO: NOW,
    });
    expect(first.applied.length).toBe(ids.length);
    const settled = everyRow();
    const auditedOnce = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number };

    const again = applyConsented(db, {
      ...release,
      act: 'correct',
      proposalIds: ids,
      userId: admin,
      nowISO: NOW,
    });
    expect(again.applied).toEqual([]);
    expect(again.refused).toHaveLength(ids.length);
    expect(everyRow()).toBe(settled);

    const stillOutstanding = pendingChanges(db, { ...release, nowISO: NOW });
    expect(stillOutstanding.rules).toEqual([]);
    expect(stillOutstanding.wording).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n).toBe(
      auditedOnce.n,
    );
  });

  /**
   * And the boot path, run again over a database this door has changed, has nothing to say about
   * it: the values it now holds are the shipped ones, so the automatic reconcile is a no-op rather
   * than a fight between the two doors.
   */
  it('leaves the boot reconcile with nothing to undo', () => {
    const release = deploymentSeededBefore();
    const plan = pendingChanges(db, { ...release, nowISO: NOW });
    const consented = applyConsented(db, {
      ...release,
      act: 'correct',
      proposalIds: [...plan.rules, ...plan.wording].map((p) => p.id),
      userId: anAdmin(),
      nowISO: NOW,
    });
    expect(consented.applied.length).toBeGreaterThan(1);
    const settled = everyRow();

    const report = applySeedCorrections(db, { ...release, nowISO: NOW });
    expect(report.ran).toBe(true);
    expect(report.applied).toEqual([]);
    expect(report.leftAlone).toEqual([]);
    expect(everyRow()).toBe(settled);
  });
});
