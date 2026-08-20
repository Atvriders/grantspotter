/**
 * THE SECOND DOOR: A CHANGE THE IMAGE CANNOT MAKE ON ITS OWN, MADE BY A PERSON WHO READ IT.
 *
 * `corrections.ts` is the first door, and it stays shut on exactly the things it is shut on now. It
 * rewrites a field only when the stored bytes are byte-for-byte a value this project shipped, and
 * only when the rewrite changes what a record SAYS and never what it MEANS. Both rules are right.
 * NEITHER IS RELAXED HERE, and the automatic path is not touched: this file has its own writes, its
 * own audit actions and its own entry point, and `index.ts` never calls it.
 *
 * WHAT THAT LEAVES STRANDED, WHICH IS WHY THIS FILE EXISTS. Measured on a database seeded from the
 * corpus of 2026-08-11 (commit 8d5c0a2) and reconciled against the corpus shipping today, the boot
 * path applies 113 corrections and then reports, correctly, that it will not apply:
 *
 *   - 88 records whose ELIGIBILITY RULES the corpus has changed. One of them is
 *     `dara-grantmaker-only-via-arrl`, whose `dara-institution` constraint is `degreeLevels:
 *     ["BACH"]` under the funder's sentence "Any licence class, any region, any field of study;
 *     must be enrolled at an accredited four-year institution." A sentence about the SCHOOL, read
 *     as a rule about the STUDENT: every graduate applicant is hard-refused a scholarship whose
 *     own quoted sentence does not refuse them.
 *   - 1 record, `arrl-foundation-scholarships`, whose `deadline.note` asserts `close=12:00` — a
 *     noon close — where the record's own prose says ARRL publishes no time of day. Deleting the
 *     directive moves the projected deadline, so `meaningOf` refuses it.
 *   - 1 record the corpus has ADDED, `arrl-foundation-special-funds`, which cannot arrive at all
 *     because `importSeedIfEmpty` will not write into a non-empty database.
 *
 * Every one of those is a correction this project believes in, computed at every boot, printed to
 * stdout, and thrown away. A boot must not silently change who is told they are eligible. An
 * operator may decide to.
 *
 * WHY A SCREEN AND NOT A CLI SUBCOMMAND. The alternative was weighed and is the wrong one here:
 *
 *   1. It has already been measured on this operator and it failed. `corrections.ts` records the
 *      result: "A SCRIPT THE OPERATOR RUNS is the status quo that failed. The owner pulled the
 *      image and got the code fixes and none of the data fixes, because nothing told them a script
 *      existed." The boot report prints these ninety lines TODAY, on every restart of the live
 *      instance, and the defects are still live. A second channel into the same unread stream is
 *      not a fix.
 *   2. The deployment is `docker compose pull && docker compose up -d` against a tracked compose
 *      file with no `.env`, and every other operator act in this product — accounts, sources,
 *      crawls, the review inbox, backup and restore — is a screen behind an admin login. There is
 *      no `bin` entry, no documented `docker compose exec`, and no `tsx` in the runtime image: a
 *      CLI would be a new deployment concept introduced for the one act that most needs an
 *      audience.
 *   3. The consent this needs is a READING act, over eighty-eight records, each with a rule diff
 *      and a measured verdict movement. That is a table, not a terminal.
 *   4. An SSH door authorises by host access. This changes what every member is told about their
 *      own eligibility, and the product already has the right grain — an admin role and an audit
 *      trail with an actor. A CLI would write `actor_user_id = NULL`, which is exactly the row the
 *      automatic path already writes and exactly the fact this act must not share with it.
 *
 * THE COST OF A SCREEN, STATED RATHER THAN HIDDEN: it needs somebody present, and until somebody
 * presses it the defect stays live. That cost is correct HERE and was not correct for the
 * automatic path. Everything in this file moves what a student is told about their own
 * eligibility; a silent boot-time change of that is the thing this codebase refuses everywhere. So
 * the button waits, the boot report names the screen it is on, and the screen carries a count.
 *
 * WHAT IS STILL REFUSED, WITH A PERSON PRESENT AND CONSENTING:
 *
 *   - A field whose stored bytes are NOT witnessed in `shipped-values.tsv`. Consent lets an
 *     operator change what a record MEANS. It does not let the image overwrite somebody's edit,
 *     because the operator consenting is not necessarily the person who made it, and an unwitnessed
 *     byte is the only evidence that anyone was ever here. `not-a-value-this-project-shipped` is
 *     never offered by either door.
 *   - Deleting a field the corpus no longer carries, and filling a field this record does not have.
 *     Both are `corrections.ts`'s refusals and both are kept.
 *   - Deleting a record. Nothing in this file removes a programme; the only removal it can perform
 *     is a constraint the corpus dropped, inside a rules change the operator read and accepted.
 *
 * AND ADDING A PROGRAMME IS A DIFFERENT ACT FROM CORRECTING ONE. It is not a correction: nothing is
 * being put right, a record is appearing in front of members that was not there before, and the
 * operator may have deleted it on purpose. So it has its own proposal kind, its own endpoint, its
 * own confirmation word and its own audit action, and "apply the corrections" can never carry one.
 */
import type { Database } from 'better-sqlite3';
import type { Constraint, Cycle, Profile, Program, Verdict } from '@grantspotter/core';
import {
  describeRecurrence,
  expandCycles,
  matchProgram,
  parseObservedWindow,
  parseRecurrence,
  profileSchema,
} from '@grantspotter/core';
import { reindexBrowse } from '../api/reindex.js';
import { appendAuditLog } from '../db/repositories/ingestion.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo, withContentHash } from '../db/repositories/programs.js';
import { meaningOf, planForProgram, withCorrection, LEFT_ALONE_PROSE } from './corrections.js';
import type { LeftAloneReason, SeedCorrection } from './corrections.js';
import { loadSeedCorpus, seedDir } from './load.js';
import type { SeedSourceKey } from './load.js';
import {
  canonicalJson,
  digestOf,
  loadShippedValues,
  shippedValuesPath,
  valueAt,
  type CorrectablePath,
} from './shippedValues.js';

/* ------------------------------------------------------------ what the operator is shown ------ */

/** The four verdicts, in the words the product uses, so a movement reads as a sentence. */
export function verdictLabel(verdict: Verdict): string {
  switch (verdict.kind) {
    case 'eligible':
      return 'eligible';
    case 'eligible_preferred':
      return 'eligible, and preferred';
    case 'ineligible':
      return 'refused';
    case 'unknown':
      return 'undecidable';
  }
}

/** The label an addition moves FROM: this instance does not hold the record at all. */
export const NOT_HELD_HERE = 'not listed on this instance';

export interface VerdictMove {
  before: string;
  after: string;
  count: number;
}

/**
 * WHAT MOVES, MEASURED AGAINST THE ONLY APPLICANTS THIS INSTANCE ACTUALLY HAS.
 *
 * The matcher is run over every applicant profile saved in this database, twice — against the
 * record as stored and against the record as the change would leave it — and the transitions are
 * counted. Nothing is sampled and no applicant is invented: this project has already paid for a
 * measuring instrument that reported against a population that did not exist
 * (`scripts/profile-corpus.ts` counted 197 records where a user could reach 152, and every
 * acceptance figure taken with it was wrong), and the lesson was that an over-reporting instrument
 * is worse than none because it manufactures confidence.
 *
 * So when an instance holds no profiles, `profilesMeasured` is 0 and `moves` is empty, and the
 * screen says exactly that rather than filling the space with fictional students. The rule change
 * itself is still shown in full, field by field, and is what the decision rests on.
 */
export interface ProfileImpact {
  profilesMeasured: number;
  moves: VerdictMove[];
}

/** One field of one constraint's RULE half, before and after. `null` means "not present". */
export interface RuleFieldChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface RuleChange {
  constraintId: string;
  change: 'added' | 'dropped' | 'changed';
  /**
   * THE FUNDER'S SENTENCE BEHIND THE RULE. For a changed or dropped constraint it is the sentence
   * THIS DATABASE displays today, not the corpus's — that is the text under which a member is
   * being refused right now, and it is what the operator has to read the rule against.
   */
  sentence: string;
  fields: RuleFieldChange[];
}

interface ProposalBase {
  /**
   * The consent token: a digest of exactly what is being proposed. An apply names the proposals it
   * consents to by this id and the server recomputes them, so consent is to a specific, unchanged
   * text and never to a count. If the corpus, the ledger or the stored record moves between the
   * reading and the pressing, the id no longer exists and the apply refuses instead of landing on
   * something the operator never saw.
   */
  id: string;
  programId: string;
  programName: string;
  funderName: string;
  sourceUrl: string;
  impact: ProfileImpact;
}

/** A correction the boot path computed, proved and refused because it moves the record's meaning. */
export interface WordingProposal extends ProposalBase {
  kind: 'wording';
  path: CorrectablePath;
  from: string;
  to: string;
  /** The date the corpus first carried the text being replaced. */
  fromFirstSeen: string;
  /** Present when the field is `deadline.note`: the calendar this moves. */
  deadline?: DeadlineMove;
}

export interface DeadlineMove {
  before: string;
  after: string;
  observedBefore: string | null;
  observedAfter: string | null;
  nextCloseBefore: string | null;
  nextCloseAfter: string | null;
  /** Records whose own deadline is inherited from this one, and which therefore move with it. */
  inheritedBy: number;
}

/** A change to what the matcher reasons over. The boot path witnesses these and never writes them. */
export interface RulesProposal extends ProposalBase {
  kind: 'rules';
  changes: RuleChange[];
}

/** A programme the corpus has added. NOT a correction; see the header. */
export interface RecordProposal extends ProposalBase {
  kind: 'record';
  summary: string;
  klass: string;
  applyUrl: string | null;
  amountRaw: string;
  deadlineNote: string;
  constraintCount: number;
  /** The funder this record needs, when this instance does not already hold it. */
  addsFunder: string | null;
}

export type Proposal = WordingProposal | RulesProposal | RecordProposal;

/** Something the reconcile saw and NEITHER door offers. Shown, so the list is a whole picture. */
export interface NotOffered {
  programId: string;
  path: string;
  reason: LeftAloneReason | 'already-here-under-another-id';
  why: string;
}

export interface PendingChanges {
  /** False when the plan could not be computed at all; nothing is offered and `error` says why. */
  ran: boolean;
  wording: WordingProposal[];
  rules: RulesProposal[];
  additions: RecordProposal[];
  notOffered: NotOffered[];
  /** Applicant profiles saved on this instance — the population every movement was measured on. */
  profilesMeasured: number;
  examined: number;
  ledgerSize: number;
  error?: string;
}

const NOT_OFFERED_PROSE: Record<NotOffered['reason'], string> = {
  ...LEFT_ALONE_PROSE,
  'already-here-under-another-id':
    'this instance already holds this programme under a different id — a crawl reached it before ' +
    'the corpus did — so adding it would put a second copy in front of members',
};

/** How far ahead the deadline preview projects. Long enough to catch one annual cycle either way. */
const HORIZON_DAYS = 400;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/** The rule half of one constraint, flattened one level, as comparable strings. */
function ruleFields(constraint: Constraint): Map<string, string> {
  const fields = new Map<string, string>();
  fields.set('hard', canonicalJson(constraint.hard));
  fields.set('fallbackRank', canonicalJson(constraint.fallbackRank));
  for (const [key, value] of Object.entries(constraint.spec as unknown as Record<string, unknown>)) {
    if (value === undefined) continue;
    fields.set(`spec.${key}`, canonicalJson(value));
  }
  return fields;
}

function diffRuleFields(
  before: Constraint | undefined,
  after: Constraint | undefined,
): RuleFieldChange[] {
  const from = before === undefined ? new Map<string, string>() : ruleFields(before);
  const to = after === undefined ? new Map<string, string>() : ruleFields(after);
  const changes: RuleFieldChange[] = [];
  for (const field of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const a = from.get(field) ?? null;
    const b = to.get(field) ?? null;
    if (a !== b) changes.push({ field, before: a, after: b });
  }
  return changes;
}

/**
 * The record as a rules change would leave it.
 *
 * THE SENTENCES DO NOT MOVE. Every constraint the corpus keeps carries the `rawText` THIS DATABASE
 * holds today, not the corpus's — because a displayed sentence is prose, and prose is only ever
 * rewritten under the byte-identity rule, by the other door, on its own evidence. A rules change
 * moves what the matcher reasons over and nothing else. A constraint the corpus ADDS is the one
 * exception and cannot be otherwise: there is no stored sentence to keep.
 */
export function withShippedRules(stored: Program, shipped: Program): Program {
  const storedById = new Map(stored.constraints.map((c) => [c.id, c]));
  return {
    ...stored,
    constraints: shipped.constraints.map((c) => {
      const here = storedById.get(c.id);
      return here === undefined ? c : { ...c, rawText: here.rawText };
    }),
  };
}

export function ruleChangesBetween(stored: Program, shipped: Program): RuleChange[] {
  const storedById = new Map(stored.constraints.map((c) => [c.id, c]));
  const shippedById = new Map(shipped.constraints.map((c) => [c.id, c]));
  const changes: RuleChange[] = [];
  for (const c of shipped.constraints) {
    const here = storedById.get(c.id);
    if (here === undefined) {
      changes.push({
        constraintId: c.id,
        change: 'added',
        sentence: c.rawText,
        fields: diffRuleFields(undefined, c),
      });
      continue;
    }
    const fields = diffRuleFields(here, c);
    if (fields.length > 0) {
      changes.push({ constraintId: c.id, change: 'changed', sentence: here.rawText, fields });
    }
  }
  for (const c of stored.constraints) {
    if (shippedById.has(c.id)) continue;
    changes.push({
      constraintId: c.id,
      change: 'dropped',
      sentence: c.rawText,
      fields: diffRuleFields(c, undefined),
    });
  }
  return changes;
}

/** Every applicant profile saved on this instance. A row that no longer validates is skipped. */
export function savedProfiles(db: Database): Profile[] {
  const rows = db.prepare('SELECT data FROM profiles ORDER BY id').all() as Array<{ data: string }>;
  const profiles: Profile[] = [];
  for (const row of rows) {
    const parsed = profileSchema.safeParse(JSON.parse(row.data));
    if (parsed.success) profiles.push(parsed.data);
  }
  return profiles;
}

/**
 * Keyed by a JSON pair rather than by a joined string: every verdict label may contain a space or
 * a comma, so a separator would have to be chosen for not appearing in any label — a rule nothing
 * enforces and the next label breaks.
 */
function impactOf(
  profiles: readonly Profile[],
  before: Program | undefined,
  after: Program,
  nowISO: string,
): ProfileImpact {
  const counts = new Map<string, number>();
  for (const profile of profiles) {
    const from =
      before === undefined ? NOT_HELD_HERE : verdictLabel(matchProgram(profile, before, nowISO));
    const to = verdictLabel(matchProgram(profile, after, nowISO));
    if (from === to) continue;
    const key = JSON.stringify([from, to]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const moves = [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = JSON.parse(key) as [string, string];
      return { before: from, after: to, count };
    })
    .sort((a, b) => b.count - a.count || a.before.localeCompare(b.before));
  return { profilesMeasured: profiles.length, moves };
}

function nextClose(program: Program, all: readonly Program[], nowISO: string): string | null {
  let cycles: Cycle[];
  try {
    cycles = expandCycles(program, [...all], nowISO, addDays(nowISO, HORIZON_DAYS));
  } catch {
    return null;
  }
  const closes = cycles
    .map((c) => c.closesAt)
    .filter((c): c is string => c !== undefined)
    .sort();
  return closes[0] ?? null;
}

function describeNote(note: string): string {
  try {
    return describeRecurrence(parseRecurrence(note)) ?? 'no repeating cycle';
  } catch (error) {
    return `unreadable repeat rule: ${(error as Error).message}`;
  }
}

function describeWindow(note: string): string | null {
  const window = parseObservedWindow(note);
  if (window === undefined) return null;
  return `${window.opensAt} to ${window.closesAt}`;
}

/** A stable id for one proposal, over exactly the bytes it proposes to move. */
function proposalId(parts: readonly string[]): string {
  return digestOf(JSON.stringify(parts)).slice(0, 32);
}

/* --------------------------------------------------------------------- the plan --------------- */

export interface PendingOptions {
  /** Seed corpus directory. Defaults to the shipped one. */
  dir?: string;
  /** Ledger path. Defaults to `<dir>/shipped-values.tsv`. */
  ledgerPath?: string;
  nowISO?: string;
}

/**
 * EVERYTHING THE IMAGE WOULD CHANGE AND CANNOT, WITH WHAT EACH CHANGE MOVES.
 *
 * Pure of writes: it reads the database, the corpus and the ledger, runs the real matcher and the
 * real recurrence parser, and returns. Calling it can no more alter this deployment than reading
 * the boot log can, which is what makes it safe to put behind a GET.
 *
 * It NEVER THROWS for a data reason, for the same reason `applySeedCorrections` does not: a
 * corrupt ledger or a corpus that will not load is a reason to offer nothing and say so, never a
 * reason to take an admin screen down.
 */
export function pendingChanges(db: Database, options: PendingOptions = {}): PendingChanges {
  const nowISO = options.nowISO ?? new Date().toISOString();
  const empty: PendingChanges = {
    ran: false,
    wording: [],
    rules: [],
    additions: [],
    notOffered: [],
    profilesMeasured: 0,
    examined: 0,
    ledgerSize: 0,
  };

  try {
    const dir = options.dir ?? seedDir();
    const corpus = loadSeedCorpus(dir);
    const ledger = loadShippedValues(options.ledgerPath ?? shippedValuesPath(dir));
    const programs = createProgramRepo(db);
    const funders = createFunderRepo(db);
    const profiles = savedProfiles(db);
    const all = programs.list();
    const funderNames = new Map(funders.list().map((f) => [f.id, f.name]));
    const corpusFunderNames = new Map(corpus.funders.map((f) => [f.id, f.name]));
    const inheritors = new Map<string, number>();
    for (const program of all) {
      const source = program.deadline.source;
      if (source.kind !== 'inherited') continue;
      inheritors.set(source.fromProgramId, (inheritors.get(source.fromProgramId) ?? 0) + 1);
    }

    const wording: WordingProposal[] = [];
    const rules: RulesProposal[] = [];
    const additions: RecordProposal[] = [];
    const notOffered: NotOffered[] = [];
    let examined = 0;

    for (const shipped of corpus.programs) {
      const stored = programs.get(shipped.id);
      if (stored === undefined) {
        const sourceKey = corpus.sourceKeys.get(shipped.id);
        const already =
          sourceKey === undefined
            ? undefined
            : programs.findBySourceKey(sourceKey.sourceId, sourceKey.externalKey);
        if (already !== undefined) {
          notOffered.push({
            programId: shipped.id,
            path: 'the whole record',
            reason: 'already-here-under-another-id',
            why: NOT_OFFERED_PROSE['already-here-under-another-id'],
          });
          continue;
        }
        additions.push({
          id: proposalId(['record', shipped.id, shipped.trust.contentHash]),
          kind: 'record',
          programId: shipped.id,
          programName: shipped.name,
          funderName: corpusFunderNames.get(shipped.funderId) ?? shipped.funderId,
          sourceUrl: shipped.trust.sourceUrl,
          summary: shipped.summary,
          klass: shipped.klass,
          applyUrl: shipped.applyUrl ?? null,
          amountRaw: shipped.amount.amountRaw,
          deadlineNote: shipped.deadline.note,
          constraintCount: shipped.constraints.length,
          addsFunder: funderNames.has(shipped.funderId)
            ? null
            : (corpusFunderNames.get(shipped.funderId) ?? shipped.funderId),
          impact: impactOf(profiles, undefined, shipped, nowISO),
        });
        continue;
      }
      examined += 1;

      const plan = planForProgram(stored, shipped, ledger);
      const storedMeaning = meaningOf(stored);
      const name = stored.name;
      const funderName = funderNames.get(stored.funderId) ?? stored.funderId;

      for (const correction of plan.corrections) {
        const after = withCorrection(stored, correction);
        // The corrections that do NOT move meaning are the first door's business and are applied
        // at the next boot without anybody being asked. Only the refused ones are offered here.
        if (meaningOf(after) === storedMeaning) continue;
        wording.push({
          id: proposalId(['wording', correction.programId, correction.path, correction.fromSha256, digestOf(correction.to)]),
          kind: 'wording',
          programId: correction.programId,
          programName: name,
          funderName,
          sourceUrl: stored.trust.sourceUrl,
          path: correction.path,
          from: correction.from,
          to: correction.to,
          fromFirstSeen: correction.fromFirstSeen,
          deadline:
            correction.path === 'deadline.note'
              ? {
                  before: describeNote(correction.from),
                  after: describeNote(correction.to),
                  observedBefore: describeWindow(correction.from),
                  observedAfter: describeWindow(correction.to),
                  nextCloseBefore: nextClose(stored, all, nowISO),
                  nextCloseAfter: nextClose(after, all, nowISO),
                  inheritedBy: inheritors.get(stored.id) ?? 0,
                }
              : undefined,
          impact: impactOf(profiles, stored, after, nowISO),
        });
      }

      for (const item of plan.leftAlone) {
        if (item.reason !== 'eligibility-rules-differ') {
          notOffered.push({
            programId: item.programId,
            path: item.path,
            reason: item.reason,
            why: NOT_OFFERED_PROSE[item.reason],
          });
          continue;
        }
        const after = withShippedRules(stored, shipped);
        rules.push({
          id: proposalId([
            'rules',
            stored.id,
            item.storedSha256 ?? '',
            digestOf(valueAt(shipped, 'constraints.rules') ?? ''),
          ]),
          kind: 'rules',
          programId: stored.id,
          programName: name,
          funderName,
          sourceUrl: stored.trust.sourceUrl,
          changes: ruleChangesBetween(stored, shipped),
          impact: impactOf(profiles, stored, after, nowISO),
        });
      }
    }

    return {
      ran: true,
      wording,
      rules,
      additions,
      notOffered,
      profilesMeasured: profiles.length,
      examined,
      ledgerSize: ledger.size,
    };
  } catch (error) {
    return { ...empty, error: (error as Error).message };
  }
}

/* ------------------------------------------------------------------- applying it -------------- */

/**
 * THE TWO ACTS, KEPT APART BY THE TYPE SYSTEM AND BY THE ROUTE.
 *
 * `correct` may carry `wording` and `rules` proposals and nothing else. `add` may carry `record`
 * proposals and nothing else. An id of the wrong kind is refused with the name of the other door
 * rather than quietly obeyed, because "apply the corrections" must never be able to put a
 * programme in front of members that was not there when the operator read the list.
 */
export type ConsentAct = 'correct' | 'add';

export interface ConsentOptions extends PendingOptions {
  act: ConsentAct;
  /** Exactly the proposals the operator read. Consent is to these ids, never to a count. */
  proposalIds: readonly string[];
  /** The admin who consented. This act has a person behind it; the boot path never does. */
  userId: string;
}

export interface AppliedChange {
  id: string;
  kind: Proposal['kind'];
  programId: string;
  programName: string;
  /** One sentence naming what moved, for the notice the operator reads afterwards. */
  what: string;
}

export interface RefusedChange {
  id: string;
  why: string;
}

export interface ConsentResult {
  /** False when nothing at all was attempted — a corpus that will not load, a bad ledger. */
  ran: boolean;
  applied: AppliedChange[];
  refused: RefusedChange[];
  /** Rows rebuilt in the browse projection, or `null` when nothing was written. */
  programsReindexed: number | null;
  error?: string;
}

const ACTION_FOR: Record<Proposal['kind'], string> = {
  wording: 'seed_correction.consented_wording',
  rules: 'seed_correction.consented_rules',
  record: 'seed_correction.record_added',
};

const KIND_OF_ACT: Record<ConsentAct, ReadonlyArray<Proposal['kind']>> = {
  correct: ['wording', 'rules'],
  add: ['record'],
};

function movesSentence(impact: ProfileImpact): string {
  if (impact.profilesMeasured === 0) return 'no applicant profile is saved here, so nothing was measured';
  if (impact.moves.length === 0) return `no verdict moved for any of the ${String(impact.profilesMeasured)} applicant profiles saved here`;
  return impact.moves
    .map((m) => `${String(m.count)} of ${String(impact.profilesMeasured)}: ${m.before} to ${m.after}`)
    .join('; ');
}

/**
 * APPLY EXACTLY WHAT WAS CONSENTED TO, HAVING PROVED IT IS STILL THAT.
 *
 * One transaction: every accepted change, every audit row and the browse rebuild land together or
 * none of them does. Nothing is trusted from the request except the ids — the plan is recomputed
 * here, from the corpus, the ledger and the database as they are at this instant, and an id that
 * no longer names a proposal is refused rather than resolved to the nearest thing.
 *
 * WHAT IT STILL WILL NOT DO, WITH CONSENT:
 *   - write a field whose stored bytes the ledger does not witness. `planForProgram` never offers
 *     one, and the re-read below proves the bytes again at write time.
 *   - delete a programme, a funder or a cycle. The only removal reachable from here is a
 *     constraint the corpus dropped, inside a rules change the operator read.
 *   - touch a record the shipped corpus does not contain.
 *   - destroy the replaced text. Every row it writes carries the whole of what it replaced.
 */
export function applyConsented(db: Database, options: ConsentOptions): ConsentResult {
  const nowISO = options.nowISO ?? new Date().toISOString();
  const wanted = new Set(options.proposalIds);
  const result: ConsentResult = { ran: false, applied: [], refused: [], programsReindexed: null };

  const plan = pendingChanges(db, options);
  if (!plan.ran) return { ...result, error: plan.error ?? 'The pending changes could not be computed.' };

  const byId = new Map<string, Proposal>();
  for (const proposal of [...plan.wording, ...plan.rules, ...plan.additions]) {
    byId.set(proposal.id, proposal);
  }

  const allowed = KIND_OF_ACT[options.act];
  /**
   * ONE SENTENCE FOR ONE FACT, said in the two places that fact can be discovered.
   *
   * An id that names no proposal and a record that is already here are the same event seen at two
   * moments: the plan was read, and then the world moved — most often because somebody, or the
   * operator's own double-click, already applied it. The second check is the narrow one that
   * matters, because between computing the plan and opening the transaction another process can
   * insert the record, and `programs.upsert` would overwrite it rather than refuse.
   */
  const NO_LONGER_OFFERED =
    'That change is no longer being offered — it has already been applied, or the record, ' +
    'the shipped corpus or the ledger moved between reading the list and pressing the ' +
    'button. Nothing was written; read the list again.';
  const chosen: Proposal[] = [];
  for (const id of wanted) {
    const proposal = byId.get(id);
    if (proposal === undefined) {
      result.refused.push({ id, why: NO_LONGER_OFFERED });
      continue;
    }
    if (!allowed.includes(proposal.kind)) {
      result.refused.push({
        id,
        why:
          proposal.kind === 'record'
            ? `Adding ${proposal.programId} is not a correction and cannot be applied here. It has its own list, its own confirmation and its own audit trail.`
            : `Correcting ${proposal.programId} is not an addition and cannot be applied here.`,
      });
      continue;
    }
    chosen.push(proposal);
  }
  if (chosen.length === 0) return { ...result, ran: true };

  try {
    const dir = options.dir ?? seedDir();
    const corpus = loadSeedCorpus(dir);
    const ledger = loadShippedValues(options.ledgerPath ?? shippedValuesPath(dir));
    const shippedById = new Map(corpus.programs.map((p) => [p.id, p]));
    const programs = createProgramRepo(db);
    const funders = createFunderRepo(db);

    db.transaction(() => {
      for (const proposal of chosen) {
        const shipped = shippedById.get(proposal.programId);
        if (shipped === undefined) {
          result.refused.push({ id: proposal.id, why: 'The shipped corpus no longer carries that record.' });
          continue;
        }

        if (proposal.kind === 'record') {
          if (programs.get(proposal.programId) !== undefined) {
            result.refused.push({ id: proposal.id, why: NO_LONGER_OFFERED });
            continue;
          }
          const funder = corpus.funders.find((f) => f.id === shipped.funderId);
          if (funders.get(shipped.funderId) === undefined) {
            if (funder === undefined) {
              result.refused.push({
                id: proposal.id,
                why: `The shipped corpus has no funder "${shipped.funderId}" for that record, so it cannot be added.`,
              });
              continue;
            }
            funders.upsert(funder);
          }
          const sourceKey: SeedSourceKey | undefined = corpus.sourceKeys.get(shipped.id);
          programs.upsert(withContentHash(shipped), sourceKey);
          appendAuditLog(db, {
            userId: options.userId,
            action: ACTION_FOR.record,
            entityType: 'program',
            entityId: shipped.id,
            detail: JSON.stringify({
              added: shipped.name,
              funderId: shipped.funderId,
              constraints: shipped.constraints.length,
              // NOTHING WAS REPLACED, said out loud rather than left as an absent key: every other
              // row this file writes carries the whole of the text it overwrote, and a reader of
              // the audit trail must be able to tell "nothing was destroyed" from "we did not say".
              replaced: null,
              moves: proposal.impact.moves,
              profilesMeasured: proposal.impact.profilesMeasured,
              why: 'An administrator read this record and consented to adding it. It did not exist on this instance.',
            }),
            atISO: nowISO,
          });
          result.applied.push({
            id: proposal.id,
            kind: 'record',
            programId: shipped.id,
            programName: shipped.name,
            what: `added, with ${String(shipped.constraints.length)} constraint(s) — ${movesSentence(proposal.impact)}`,
          });
          continue;
        }

        // A CORRECTION. The record is re-read here, inside the transaction, and the bytes this
        // proposal names are proved to still be there and still to be ours before anything moves.
        const stored = programs.get(proposal.programId);
        if (stored === undefined) {
          result.refused.push({ id: proposal.id, why: 'That record is no longer on this instance.' });
          continue;
        }

        if (proposal.kind === 'wording') {
          const here = valueAt(stored, proposal.path);
          if (here !== proposal.from) {
            result.refused.push({
              id: proposal.id,
              why: 'That field changed between reading the list and pressing the button; nothing was written.',
            });
            continue;
          }
          if (ledger.witness(stored.id, proposal.path, here) === undefined) {
            result.refused.push({
              id: proposal.id,
              why: 'Those bytes are not text GrantSpotter shipped, so they are not this image’s to replace.',
            });
            continue;
          }
          const correction: SeedCorrection = {
            programId: stored.id,
            path: proposal.path,
            from: proposal.from,
            to: proposal.to,
            fromSha256: digestOf(proposal.from),
            fromFirstSeen: proposal.fromFirstSeen,
          };
          const merged = withContentHash(withCorrection(stored, correction));
          programs.upsert(merged);
          appendAuditLog(db, {
            userId: options.userId,
            action: ACTION_FOR.wording,
            entityType: 'program',
            entityId: stored.id,
            detail: JSON.stringify({
              path: proposal.path,
              // IN FULL. Once the column is overwritten this row is the only remaining copy.
              replaced: proposal.from,
              replacedSha256: correction.fromSha256,
              replacedShippedOn: proposal.fromFirstSeen,
              now: proposal.to,
              deadline: proposal.deadline ?? null,
              moves: proposal.impact.moves,
              profilesMeasured: proposal.impact.profilesMeasured,
              why:
                'The automatic path proved these bytes were GrantSpotter’s own and refused the ' +
                'rewrite because it moves what the record MEANS. An administrator read what it ' +
                'moves and consented.',
            }),
            atISO: nowISO,
          });
          result.applied.push({
            id: proposal.id,
            kind: 'wording',
            programId: stored.id,
            programName: stored.name,
            what: `${proposal.path} rewritten — ${movesSentence(proposal.impact)}`,
          });
          continue;
        }

        const storedRules = valueAt(stored, 'constraints.rules');
        if (storedRules === undefined || ledger.witness(stored.id, 'constraints.rules', storedRules) === undefined) {
          result.refused.push({
            id: proposal.id,
            why:
              'This record’s eligibility rules are not the ones GrantSpotter shipped — somebody ' +
              'here changed them — so they are not this image’s to replace. Nothing was written.',
          });
          continue;
        }
        if (storedRules === valueAt(shipped, 'constraints.rules')) {
          result.refused.push({ id: proposal.id, why: 'Those rules already match the shipped corpus.' });
          continue;
        }
        const merged = withContentHash(withShippedRules(stored, shipped));
        programs.upsert(merged);
        appendAuditLog(db, {
          userId: options.userId,
          action: ACTION_FOR.rules,
          entityType: 'program',
          entityId: stored.id,
          detail: JSON.stringify({
            path: 'constraints.rules',
            // THE WHOLE CONSTRAINT ARRAY AS IT STOOD, sentences included. A dropped constraint's
            // only remaining copy is this row.
            replaced: canonicalJson(stored.constraints),
            replacedSha256: digestOf(storedRules),
            now: canonicalJson(merged.constraints),
            changes: proposal.changes,
            moves: proposal.impact.moves,
            profilesMeasured: proposal.impact.profilesMeasured,
            why:
              'The automatic path proved these rules were GrantSpotter’s own and never rewrites ' +
              'them, because they decide who is told they are eligible. An administrator read the ' +
              'change and consented.',
          }),
          atISO: nowISO,
        });
        result.applied.push({
          id: proposal.id,
          kind: 'rules',
          programId: stored.id,
          programName: stored.name,
          what: `eligibility rules updated — ${movesSentence(proposal.impact)}`,
        });
      }

      // IN THE SAME TRANSACTION. A verdict-moving change whose browse projection still holds the
      // old deadline or the old status is the derived-value lie this codebase refuses elsewhere,
      // and `restoreBackup` already established that a mid-process write rebuilds its own
      // projection rather than telling the operator to restart the server.
      if (result.applied.length > 0) result.programsReindexed = reindexBrowse(db, nowISO);
    })();

    result.ran = true;
    return result;
  } catch (error) {
    return {
      ran: false,
      applied: [],
      refused: [],
      programsReindexed: null,
      error: (error as Error).message,
    };
  }
}
