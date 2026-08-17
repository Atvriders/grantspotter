/**
 * HOW A SHIPPED DATA CORRECTION REACHES A DEPLOYMENT WITHOUT OVERWRITING A HUMAN.
 *
 * `importSeedIfEmpty` will not write into a database that already holds programs. That refusal is
 * right — it is what stops an image upgrade from destroying an operator's curation — and its
 * consequence is that a correction to shipped seed data can never arrive. On 2026-08-13 that
 * consequence had a cost a student could read: 31 records whose panel is headed "Text from the
 * source that no field on this page models. It is reproduced exactly" were printing this project's
 * own notes, the fix was committed, the image was pulled, and every one of those records was still
 * wrong on the live site.
 *
 * THE RULE, AND IT IS THE WHOLE DESIGN: a field is rewritten only when the value it holds today is
 * byte-for-byte a value THIS PROJECT SHIPPED. `shippedValues.ts` holds the digests that prove it.
 * A byte of difference — an operator's edit, an approved crawl candidate, a hand-repair — means
 * somebody has been here, and the field is left exactly as it is and reported. There is no
 * "probably fine", no fuzzy match, no timestamp heuristic: either we can prove the bytes are ours,
 * or we do not touch them.
 *
 * WHERE IT RUNS: at boot, from `index.ts`, after `migrate()` and `importSeedIfEmpty()` and before
 * `reindexBrowse()` (so a corrected `deadline.note` is reprojected in the same boot). The three
 * alternatives were weighed and are worth recording, because the next maintainer will ask:
 *
 *   - A NUMBERED MIGRATION cannot do this job. `migrate.ts` executes `.sql` files and nothing
 *     else: no corpus loader, no validator, no `hashProgram` to recompute `content_hash`, no
 *     `canonicalJson` to compare a field inside a JSON column. It would have to carry both the old
 *     and the new text inline as string literals — shipping the sentences we are apologising for
 *     back into the image — and it is forward-only, so every future correction needs another file
 *     and the pattern grows without bound. Its one advantage, that it runs exactly once, we get
 *     for free below: after a correction the stored value IS the shipped value, so the second run
 *     finds nothing to do.
 *   - A SCRIPT THE OPERATOR RUNS is the status quo that failed. The owner pulled the image and got
 *     the code fixes and none of the data fixes, because nothing told them a script existed.
 *   - AN ADMIN ACTION is visible and consented, and needs somebody to press it. Students were
 *     reading invented "verbatim" text while the button waited. Consent for a rewrite whose entire
 *     definition is "restore the value we shipped, and only if it is still exactly that" is
 *     already given by pulling the image; what the operator is owed is not a button but the TRUTH
 *     about what changed, which is why nothing here is silent (see `formatSeedCorrectionReport`
 *     and the `audit_log` rows below).
 *
 * WHAT IT MUST NEVER DO — each of these is enforced by code in this file, not by this comment:
 *
 *   1. Never write a value that is not provably ours. `ledger.witness()` gates every write, and
 *      the UPDATE repeats the check as a WHERE clause on the exact column bytes it read.
 *   2. Never change what a record MEANS — only what it says. `meaningOf()` is compared before and
 *      after every single correction, and a correction that moves the matcher's inputs, the
 *      calendar's recurrence, the funder-stated window, the status, the entities, the amounts or
 *      the constraints is dropped and reported.
 *   3. Never insert or delete a program, funder, constraint or cycle, and never change what a
 *      constraint REQUIRES. Exactly two statements here write: an UPDATE of named `programs`
 *      columns on one id, and an UPDATE of `constraints.raw_text` — the sentence a record
 *      DISPLAYS — on one id. There is no INSERT and no DELETE, which is why a corpus that drops a
 *      constraint is still reported and not obeyed, and no write can reach `hard`, `fallback_rank`
 *      or `spec` (`corrections.test.ts` scans this file's source for the absence of the other
 *      verbs and for the shape of the one constraint write).
 *   4. Never touch a record the shipped corpus does not contain. The loop is over the corpus.
 *   5. Never touch trust beyond `contentHash`, which is derived and must stay true.
 *   6. Never be silent. Every applied and every refused correction is printed at boot and written
 *      to `audit_log` under the program's own id.
 *   7. Never take the site down. A bad ledger or an unexpected throw fails the whole reconcile
 *      inside one transaction and is reported by the caller; the server still starts.
 */
import type { Database } from 'better-sqlite3';
import type { Program, Recurrence } from '@grantspotter/core';
import { hashProgram, parseObservedWindow, parseRecurrence } from '@grantspotter/core';
import { appendAuditLog } from '../db/repositories/ingestion.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { loadSeedCorpus, seedDir } from './load.js';
import { matcherReadingOf } from './matcherReading.js';
import {
  CORRECTABLE_PATHS,
  ShippedValues,
  canonicalJson,
  constraintIdOfRawTextPath,
  constraintRawTextPath,
  digestOf,
  loadShippedValues,
  shippedValuesPath,
  valueAt,
  type CorrectablePath,
  type FixedCorrectablePath,
  type WitnessedPath,
} from './shippedValues.js';

/* --------------------------------------------------------------- what a record MEANS ---------- */

/**
 * Everything about a record that something in this product REASONS OVER, with the prose a
 * correction is allowed to rewrite blanked out.
 *
 * Compare this before and after a correction and it answers the only question that matters at
 * write time: did rewriting a sentence change an answer this product gives? The matcher's inputs
 * (the constraint RULES, `applicantEntities`, `klass`, `tags`) are in here because a rewrite must
 * never move an eligibility verdict. The parsed recurrence and the funder-stated window are in
 * here because `deadline.note` is prose that also carries the `RECUR` micro-format `expandCycles`
 * projects a calendar from and the sentence `parseObservedWindow` reads dates out of — so a note
 * whose PROSE changes is a correction, and a note whose DATES change is a different act that a
 * human has to perform.
 *
 * `constraints[].rawText` IS THE THIRD OF THESE AND THE ONE THAT WAS MISSED. It is the displayed
 * sentence, so a correction must be allowed to rewrite it — and it is ALSO threaded into
 * `evaluateConstraint`, which asks it whether the funder called their own list illustrative. Two
 * axes act on the answer. So the sentence is blanked here exactly like a note's prose, and the
 * matcher's reading of it is compared exactly like a note's directive: `matcherReadingOf` asks the
 * real matcher, so this cannot drift out of step with what the matcher actually does. A rewrite
 * that keeps the reading is a correction; a rewrite that moves it is a different act, refused and
 * reported, and a human decides.
 *
 * `trust.contentHash` is blanked because it is derived from the record and a correction is
 * required to recompute it. Everything else in `trust` — status, lastVerifiedAt,
 * verificationMethod, sourceUrl — is operational state and is compared.
 */
export function meaningOf(program: Program): string {
  const stripped: Program = {
    ...program,
    summary: '',
    rawOtherText: '',
    amount: { ...program.amount, amountRaw: '', awardCountRaw: '' },
    deadline: { ...program.deadline, note: '' },
    aiPolicy: { ...program.aiPolicy, quote: '' },
    fundingRestrictions: [],
    constraints: program.constraints.map((c) => ({ ...c, rawText: '' })),
    trust: { ...program.trust, contentHash: '' },
  };
  return canonicalJson({
    record: stripped,
    recurrence: safeRecurrence(program.deadline.note),
    observedWindow: parseObservedWindow(program.deadline.note) ?? null,
    // Keyed by constraint id, not by position, so this compares the reading of THE SAME SENTENCE
    // before and after rather than of whatever sentence happens to sit at that index.
    constraintReadings: program.constraints.map((c) => ({
      id: c.id,
      ...matcherReadingOf(c.rawText),
    })),
  });
}

/**
 * `parseRecurrence` throws on a malformed directive. A throw is itself a meaning: "this note
 * projects no calendar, and here is why". Two notes that throw the same message mean the same
 * thing; a note that stops throwing has changed what it means and must be refused like any other.
 */
function safeRecurrence(note: string): Recurrence | { kind: 'unparseable'; message: string } {
  try {
    return parseRecurrence(note);
  } catch (error) {
    return { kind: 'unparseable', message: (error as Error).message };
  }
}

/* --------------------------------------------------------------------- the plan --------------- */

export interface SeedCorrection {
  programId: string;
  path: CorrectablePath;
  /** The exact bytes found in the database — proved ours by the ledger. */
  from: string;
  /** The exact bytes the shipped corpus carries now. */
  to: string;
  fromSha256: string;
  /** The date the corpus first carried the value being replaced. */
  fromFirstSeen: string;
}

export type LeftAloneReason =
  /** The stored bytes are not any value this project shipped: somebody here changed them. */
  | 'not-a-value-this-project-shipped'
  /** The corpus has a value for a field this record does not carry: nothing to prove untouched. */
  | 'field-absent-here'
  /** The corpus dropped an optional field this record still carries. */
  | 'corpus-no-longer-carries-this-field'
  /** The corpus changed eligibility rules. This path never does that. */
  | 'eligibility-rules-differ'
  /** Applying it would change an answer the product gives, not just a sentence it prints. */
  | 'changes-what-the-record-means'
  /** The row moved between the read and the write. Nothing was written. */
  | 'row-changed-underneath';

export interface SeedLeftAlone {
  programId: string;
  path: WitnessedPath;
  reason: LeftAloneReason;
  /** Digest of what the database holds, so two different edits are two different audit rows. */
  storedSha256: string | null;
}

export interface SeedCorrectionPlan {
  corrections: SeedCorrection[];
  leftAlone: SeedLeftAlone[];
}

/**
 * The decision, as a pure function of (what this database holds, what the corpus ships, what we
 * can prove we shipped). No SQL, no clock, no environment — so every branch below is testable
 * without a database, and the write path further down has no decisions left to make.
 */
export function planForProgram(
  stored: Program,
  shipped: Program,
  ledger: ShippedValues,
): SeedCorrectionPlan {
  const corrections: SeedCorrection[] = [];
  const leftAlone: SeedLeftAlone[] = [];

  // THE SENTENCES, ONE CONSTRAINT AT A TIME, AND ONLY WHERE BOTH SIDES HAVE THAT CONSTRAINT.
  // A constraint on one side only is not a sentence to correct: it is the corpus adding or
  // dropping a RULE, which is the `constraints.rules` difference reported at the bottom of this
  // function. Generating a path for it as well would print the same fact twice under two names.
  const storedIds = new Set(stored.constraints.map((c) => c.id));
  const sentencePaths = shipped.constraints
    .filter((c) => storedIds.has(c.id))
    .map((c) => constraintRawTextPath(c.id));

  for (const path of [...CORRECTABLE_PATHS, ...sentencePaths]) {
    const storedValue = valueAt(stored, path);
    const shippedValue = valueAt(shipped, path);
    if (storedValue === shippedValue) continue;
    if (shippedValue === undefined) {
      leftAlone.push({
        programId: stored.id,
        path,
        reason: 'corpus-no-longer-carries-this-field',
        storedSha256: storedValue === undefined ? null : digestOf(storedValue),
      });
      continue;
    }
    if (storedValue === undefined) {
      leftAlone.push({ programId: stored.id, path, reason: 'field-absent-here', storedSha256: null });
      continue;
    }
    const witness = ledger.witness(stored.id, path, storedValue);
    if (witness === undefined) {
      leftAlone.push({
        programId: stored.id,
        path,
        reason: 'not-a-value-this-project-shipped',
        storedSha256: digestOf(storedValue),
      });
      continue;
    }
    corrections.push({
      programId: stored.id,
      path,
      from: storedValue,
      to: shippedValue,
      fromSha256: witness.sha256,
      fromFirstSeen: witness.firstSeen,
    });
  }

  // WITNESSED, NEVER WRITTEN. A record still carrying exactly the constraint RULES we shipped,
  // against a corpus that has changed them, is the operator's to decide: added, dropped, hardened
  // or re-ranked rules are what the matcher reasons over, and rewriting them at boot would change
  // who is told they are eligible. Rules that do NOT match the ledger are the operator's own work
  // and are not remarked on at all.
  //
  // The displayed sentences are excluded from this value (see `valueAt`), so correcting a
  // quotation neither triggers this report nor silences it: the rules half is compared on its own
  // terms, before and after, and a record whose sentences we have just rewritten still reports its
  // rules difference on the next boot exactly as it did on this one.
  const storedRules = valueAt(stored, 'constraints.rules');
  const shippedRules = valueAt(shipped, 'constraints.rules');
  if (
    storedRules !== undefined &&
    shippedRules !== undefined &&
    storedRules !== shippedRules &&
    ledger.witness(stored.id, 'constraints.rules', storedRules) !== undefined
  ) {
    leftAlone.push({
      programId: stored.id,
      path: 'constraints.rules',
      reason: 'eligibility-rules-differ',
      storedSha256: digestOf(storedRules),
    });
  }

  return { corrections, leftAlone };
}

/* ------------------------------------------------------------------- applying it -------------- */

/** The one column each fixed correctable path lives in. Nothing else in `programs` is ever written. */
const COLUMN_FOR: Record<FixedCorrectablePath, string> = {
  summary: 'summary',
  rawOtherText: 'raw_other_text',
  'amount.amountRaw': 'amount',
  'amount.awardCountRaw': 'amount',
  'deadline.note': 'deadline',
  'aiPolicy.quote': 'ai_policy',
  fundingRestrictions: 'funding_restrictions',
};

const READ_COLUMNS = [
  'summary',
  'raw_other_text',
  'amount',
  'deadline',
  'ai_policy',
  'funding_restrictions',
  'trust',
  'content_hash',
] as const;

type ReadColumn = (typeof READ_COLUMNS)[number];
type RawRow = Record<ReadColumn, string>;

/** Applies one correction to a copy of the record, for the meaning check and the new hash. */
function withCorrection(program: Program, correction: SeedCorrection): Program {
  const constraintId = constraintIdOfRawTextPath(correction.path);
  if (constraintId !== undefined) {
    return {
      ...program,
      constraints: program.constraints.map((c) =>
        c.id === constraintId ? { ...c, rawText: correction.to } : c,
      ),
    };
  }
  switch (correction.path as FixedCorrectablePath) {
    case 'summary':
      return { ...program, summary: correction.to };
    case 'rawOtherText':
      return { ...program, rawOtherText: correction.to };
    case 'amount.amountRaw':
      return { ...program, amount: { ...program.amount, amountRaw: correction.to } };
    case 'amount.awardCountRaw':
      return { ...program, amount: { ...program.amount, awardCountRaw: correction.to } };
    case 'deadline.note':
      return { ...program, deadline: { ...program.deadline, note: correction.to } };
    case 'aiPolicy.quote':
      return { ...program, aiPolicy: { ...program.aiPolicy, quote: correction.to } };
    case 'fundingRestrictions':
      return { ...program, fundingRestrictions: JSON.parse(correction.to) as string[] };
  }
}

/**
 * Applies one correction to the RAW column text, which is what actually gets written.
 *
 * It works on the bytes read out of SQLite rather than on a re-serialised zod object, so a column
 * this correction does not name keeps its exact stored form, key order and all — and so the WHERE
 * guard below can compare against something byte-identical to what is on disk.
 */
function withCorrectionInColumns(columns: RawRow, correction: SeedCorrection): RawRow {
  const next: RawRow = { ...columns };
  switch (correction.path as FixedCorrectablePath) {
    case 'summary':
      next.summary = correction.to;
      return next;
    case 'rawOtherText':
      next.raw_other_text = correction.to;
      return next;
    case 'amount.amountRaw': {
      const amount = JSON.parse(columns.amount) as Record<string, unknown>;
      amount.amountRaw = correction.to;
      next.amount = JSON.stringify(amount);
      return next;
    }
    case 'amount.awardCountRaw': {
      const amount = JSON.parse(columns.amount) as Record<string, unknown>;
      amount.awardCountRaw = correction.to;
      next.amount = JSON.stringify(amount);
      return next;
    }
    case 'deadline.note': {
      const deadline = JSON.parse(columns.deadline) as Record<string, unknown>;
      deadline.note = correction.to;
      next.deadline = JSON.stringify(deadline);
      return next;
    }
    case 'aiPolicy.quote': {
      const aiPolicy = JSON.parse(columns.ai_policy) as Record<string, unknown>;
      aiPolicy.quote = correction.to;
      next.ai_policy = JSON.stringify(aiPolicy);
      return next;
    }
    case 'fundingRestrictions':
      next.funding_restrictions = JSON.stringify(JSON.parse(correction.to) as string[]);
      return next;
  }
}

export interface SeedCorrectionReport {
  /** True when the reconcile completed. False when it threw and nothing at all was written. */
  ran: boolean;
  applied: SeedCorrection[];
  leftAlone: SeedLeftAlone[];
  /** Shipped records this database holds. */
  examined: number;
  /** Shipped records this database does not hold — deleted or retired here. Never re-inserted. */
  absent: number;
  /** Distinct records whose rows were rewritten. */
  recordsChanged: number;
  /** Digests in the ledger. Zero means nothing can be proved and nothing is written. */
  ledgerSize: number;
  error?: string;
}

export interface SeedCorrectionOptions {
  /** Seed corpus directory. Defaults to the shipped one. */
  dir?: string;
  /** Ledger path. Defaults to `<dir>/shipped-values.tsv`. */
  ledgerPath?: string;
  nowISO?: string;
  /** Decide and report, write nothing. */
  dryRun?: boolean;
}

const ACTION_APPLIED = 'seed_correction.applied';
const ACTION_LEFT_ALONE = 'seed_correction.left_alone';

interface SentenceRow {
  id: string;
  raw_text: string;
}

/**
 * Thrown to roll one record's SAVEPOINT back, never seen outside this file. A sentinel object
 * rather than an `Error` subclass so `error !== ROW_MOVED` is an identity test: any OTHER throw —
 * a corrupt column, a bug here — must not be mistaken for a moved row and swallowed as one, and is
 * rethrown to fail the whole reconcile with `ran: false`.
 */
const ROW_MOVED = { rowMoved: true } as const;

/**
 * The reconcile. One transaction: either every correction and every audit row lands, or none does.
 *
 * It NEVER THROWS for a data reason. A malformed ledger, a corpus that will not load, a record
 * that will not parse — each of those is a reason to write nothing and say so, not a reason to
 * stop a deployment from starting. `report.ran === false` with `report.error` set is what the
 * caller prints.
 */
export function applySeedCorrections(
  db: Database,
  options: SeedCorrectionOptions = {},
): SeedCorrectionReport {
  const dir = options.dir ?? seedDir();
  const nowISO = options.nowISO ?? new Date().toISOString();
  const report: SeedCorrectionReport = {
    ran: false,
    applied: [],
    leftAlone: [],
    examined: 0,
    absent: 0,
    recordsChanged: 0,
    ledgerSize: 0,
  };

  try {
    const corpus = loadSeedCorpus(dir);
    const ledger = loadShippedValues(options.ledgerPath ?? shippedValuesPath(dir));
    report.ledgerSize = ledger.size;
    const programs = createProgramRepo(db);

    const readStmt = db.prepare(
      `SELECT ${READ_COLUMNS.join(', ')} FROM programs WHERE id = ?`,
    );
    const sentenceReadStmt = db.prepare(
      'SELECT id, raw_text FROM constraints WHERE program_id = ? ORDER BY ordinal',
    );
    // THE ONLY STATEMENT IN THIS FILE THAT WRITES A CONSTRAINT, and it sets exactly one column.
    // No INSERT, no DELETE, nothing that could add, drop or re-rank a rule: this rewrites the
    // sentence a record DISPLAYS and can reach nothing the matcher reasons over.
    const sentenceWriteStmt = db.prepare(
      'UPDATE constraints SET raw_text = @to WHERE id = @rowId AND program_id = @programId AND raw_text = @from',
    );
    const auditSeenStmt = db.prepare(
      'SELECT 1 FROM audit_log WHERE action = ? AND entity_id = ? AND detail = ? LIMIT 1',
    );

    db.transaction(() => {
      for (const shipped of corpus.programs) {
        const stored = programs.get(shipped.id);
        if (stored === undefined) {
          report.absent += 1;
          continue;
        }
        report.examined += 1;

        const plan = planForProgram(stored, shipped, ledger);
        report.leftAlone.push(...plan.leftAlone);
        if (plan.corrections.length === 0) continue;

        const columns = readStmt.get(shipped.id) as RawRow | undefined;
        if (columns === undefined) {
          for (const correction of plan.corrections) {
            report.leftAlone.push({
              programId: correction.programId,
              path: correction.path,
              reason: 'row-changed-underneath',
              storedSha256: correction.fromSha256,
            });
          }
          continue;
        }

        // MEANING IS CHECKED PER CORRECTION, not per record: one rewrite that would move a date
        // must not take the other four rewrites on the same record down with it.
        const storedMeaning = meaningOf(stored);
        let merged = stored;
        let mergedColumns = columns;
        const accepted: SeedCorrection[] = [];
        for (const correction of plan.corrections) {
          const candidate = withCorrection(merged, correction);
          if (meaningOf(candidate) !== storedMeaning) {
            report.leftAlone.push({
              programId: correction.programId,
              path: correction.path,
              reason: 'changes-what-the-record-means',
              storedSha256: correction.fromSha256,
            });
            continue;
          }
          merged = candidate;
          if (constraintIdOfRawTextPath(correction.path) === undefined) {
            mergedColumns = withCorrectionInColumns(mergedColumns, correction);
          }
          accepted.push(correction);
        }
        if (accepted.length === 0) continue;

        const trust = JSON.parse(columns.trust) as Record<string, unknown>;
        trust.contentHash = hashProgram(merged);
        const newTrust = JSON.stringify(trust);
        const newHash = hashProgram(merged);

        // A DISPLAYED SENTENCE LIVES IN A DIFFERENT TABLE FROM THE REST OF THE RECORD, and both
        // halves of a record's rewrite have to land or neither may. `content_hash` is computed
        // over the constraints too (core/hash.ts sorts them by id and hashes `rawText`), so a
        // programs row that landed beside a constraints row that did not would leave the record
        // claiming a hash of text it does not hold — the derived-value lie `hashProgram` exists to
        // prevent. So the two writes go in a nested transaction, which better-sqlite3 issues as a
        // SAVEPOINT: one record's writes roll back together and the reconcile carries on with the
        // next record.
        const sentences = accepted.filter((c) => constraintIdOfRawTextPath(c.path) !== undefined);
        const columnCorrections = accepted.filter(
          (c) => constraintIdOfRawTextPath(c.path) === undefined,
        );

        // The columns this record's accepted corrections actually touch, and nothing else. A
        // record whose only corrections are sentences touches NO `programs` column of its own —
        // just `trust`, `content_hash` and `updated_at`, which every correction moves.
        const touched = [
          ...new Set(columnCorrections.map((c) => COLUMN_FOR[c.path as FixedCorrectablePath])),
        ];
        const sets = [...touched.map((c) => `${c} = @new_${c}`), 'trust = @new_trust', 'content_hash = @new_content_hash', 'updated_at = @now'];
        // THE SECOND HALF OF THE PROOF. The ledger says these bytes were ours when we read them;
        // this says they are still those bytes at the instant we write. A row that moved in
        // between changes nothing and is reported.
        const wheres = [
          'id = @id',
          ...touched.map((c) => `${c} = @old_${c}`),
          'trust = @old_trust',
          'content_hash = @old_content_hash',
        ];
        const params: Record<string, string> = {
          id: shipped.id,
          now: nowISO,
          new_trust: newTrust,
          old_trust: columns.trust,
          new_content_hash: newHash,
          old_content_hash: columns.content_hash,
        };
        for (const column of touched) {
          params[`new_${column}`] = mergedColumns[column as ReadColumn];
          params[`old_${column}`] = columns[column as ReadColumn];
        }

        if (options.dryRun === true) {
          report.applied.push(...accepted);
          report.recordsChanged += 1;
          continue;
        }

        const updateStmt = db.prepare(
          `UPDATE programs SET ${sets.join(', ')} WHERE ${wheres.join(' AND ')}`,
        );
        const writeWholeRecord = db.transaction(() => {
          if (updateStmt.run(params).changes !== 1) throw ROW_MOVED;
          if (sentences.length === 0) return;
          // The row ids are read rather than reconstructed: `constraints.id` is stored under a
          // program-scoped key whose shape is `constraints.ts`'s private business, and both
          // queries are `ORDER BY ordinal`, so position is the link that cannot go stale.
          const rows = sentenceReadStmt.all(shipped.id) as SentenceRow[];
          if (rows.length !== stored.constraints.length) throw ROW_MOVED;
          for (const correction of sentences) {
            const constraintId = constraintIdOfRawTextPath(correction.path);
            const at = stored.constraints.findIndex((c) => c.id === constraintId);
            const row = at < 0 ? undefined : rows[at];
            if (row === undefined) throw ROW_MOVED;
            // THE SECOND HALF OF THE PROOF, for the sentence table too: the ledger said these
            // bytes were ours when we read them, and this says they are still those bytes now.
            const written = sentenceWriteStmt.run({
              rowId: row.id,
              programId: shipped.id,
              from: correction.from,
              to: correction.to,
            }).changes;
            if (written !== 1) throw ROW_MOVED;
          }
        });

        try {
          writeWholeRecord();
        } catch (error) {
          if (error !== ROW_MOVED) throw error;
          for (const correction of accepted) {
            report.leftAlone.push({
              programId: correction.programId,
              path: correction.path,
              reason: 'row-changed-underneath',
              storedSha256: correction.fromSha256,
            });
          }
          continue;
        }
        report.applied.push(...accepted);
        report.recordsChanged += 1;

        for (const correction of accepted) {
          // The replaced text goes in the audit row IN FULL. It is the operator's data, it is the
          // only remaining copy once the column is overwritten, and a record of a rewrite that
          // does not say what was rewritten is not a record.
          appendAuditLog(db, {
            userId: null,
            action: ACTION_APPLIED,
            entityType: 'program',
            entityId: correction.programId,
            detail: JSON.stringify({
              path: correction.path,
              replaced: correction.from,
              replacedSha256: correction.fromSha256,
              replacedShippedOn: correction.fromFirstSeen,
              now: correction.to,
              why: 'The value held here was byte-for-byte the text GrantSpotter shipped, so no edit of yours was overwritten.',
            }),
            atISO: nowISO,
          });
        }
      }

      if (options.dryRun === true) return;
      for (const item of report.leftAlone) {
        const detail = JSON.stringify({
          path: item.path,
          reason: item.reason,
          storedSha256: item.storedSha256,
          why: LEFT_ALONE_PROSE[item.reason],
        });
        // Deduped: this row is written once per distinct stored value, not once per boot.
        if (auditSeenStmt.get(ACTION_LEFT_ALONE, item.programId, detail) !== undefined) continue;
        appendAuditLog(db, {
          userId: null,
          action: ACTION_LEFT_ALONE,
          entityType: 'program',
          entityId: item.programId,
          detail,
          atISO: nowISO,
        });
      }
    })();

    report.ran = true;
    return report;
  } catch (error) {
    return {
      ...report,
      ran: false,
      applied: [],
      leftAlone: [],
      recordsChanged: 0,
      error: (error as Error).message,
    };
  }
}

/* ---------------------------------------------------------------- what the operator reads ----- */

export const LEFT_ALONE_PROSE: Record<LeftAloneReason, string> = {
  'not-a-value-this-project-shipped':
    'your copy is not the text GrantSpotter shipped — somebody here edited it, or it came from a ' +
    'release older than data/seed/shipped-values.tsv — so the correction was not applied',
  'field-absent-here':
    'this record does not carry that field here, so there is nothing to prove untouched',
  'corpus-no-longer-carries-this-field':
    'the shipped corpus dropped this field; removing data is not something this path does',
  'eligibility-rules-differ':
    'the shipped corpus added, dropped or changed one of this record’s eligibility RULES (not just ' +
    'the sentence it displays). A correction may change what a record says, never what it means, ' +
    'so nothing was touched',
  'changes-what-the-record-means':
    'applying it would have changed a date, an amount or an eligibility answer, not just wording',
  'row-changed-underneath': 'the row changed between the read and the write; nothing was written',
};

/**
 * The boot report. Every rewritten field and every refusal is named, because a silent data rewrite
 * on boot is precisely what this codebase refuses elsewhere — and because "31 records changed" with
 * no ids is not something an operator can check.
 */
export function formatSeedCorrectionReport(report: SeedCorrectionReport): string[] {
  if (!report.ran) {
    return [
      `[seed] SHIPPED-DATA CORRECTIONS DID NOT RUN and nothing was written: ${report.error ?? 'unknown error'}`,
    ];
  }
  if (report.applied.length === 0 && report.leftAlone.length === 0) {
    return [
      `[seed] Shipped-data corrections: none outstanding. ${String(report.examined)} shipped ` +
        `records checked against ${String(report.ledgerSize)} recorded values.`,
    ];
  }

  const lines: string[] = [
    `[seed] Shipped-data corrections: ${String(report.applied.length)} field(s) on ` +
      `${String(report.recordsChanged)} record(s) rewritten, ${String(report.leftAlone.length)} ` +
      `left alone, out of ${String(report.examined)} shipped records checked. A field is ` +
      'rewritten only when it still holds, byte for byte, the text GrantSpotter shipped.',
  ];
  const byRecord = new Map<string, string[]>();
  for (const item of report.applied) {
    const paths = byRecord.get(item.programId) ?? [];
    paths.push(item.path);
    byRecord.set(item.programId, paths);
  }
  for (const [programId, paths] of byRecord) {
    lines.push(`[seed]   corrected ${programId}: ${paths.join(', ')}`);
  }
  for (const item of report.leftAlone) {
    lines.push(
      `[seed]   left alone ${item.programId} ${item.path} — ${LEFT_ALONE_PROSE[item.reason]}`,
    );
  }
  if (report.applied.length > 0 || report.leftAlone.length > 0) {
    lines.push(
      '[seed]   Each line above is also in audit_log under that record’s id, with the exact ' +
        'text that was replaced.',
    );
  }
  return lines;
}
