import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ChangeEvent,
  ChangeKind,
  Program,
  ReviewDecision,
  ReviewItem,
  SourceTier,
} from '@grantspotter/core';
import { expandCycles, hashProgram, observedCycles, resolveDeadlineOwner } from '@grantspotter/core';
import type { AiAssist } from '../ai/assist.js';
import { ADJACENCY_THRESHOLD } from '../federal/adjacency.js';
import type { CycleRepo } from '../db/repositories/cycles.js';
import { createCycleRepo } from '../db/repositories/cycles.js';
import {
  appendAuditLog,
  deleteProgram,
  getReviewItem,
  insertReviewItem,
  isRejected,
  listAuditLog,
  listReviewItems,
  rememberReject,
  setReviewDecision,
  upsertProgram,
} from '../db/repositories/ingestion.js';
import type { ProgramSourceKey } from '../db/repositories/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { DO_NOT_PUBLISH_TAG, isDoNotPublish } from '../normalize/index.js';

/**
 * RESOLUTIONS R1/R9. CONTRACT §3 gives neither Program nor ReviewItem a field for the source
 * record they came from, so normalizeRaw stamps `source:<sourceId>` and `key:<externalKey>` into
 * Program.tags and this reads them back on the way into `programs.source_id` /
 * `programs.external_key`. Hand-curated records that no source module produced have no `key:`
 * tag and correctly get `undefined`, which upsert treats as "leave whatever is stored".
 */
export function sourceKeyFor(program: Program): ProgramSourceKey | undefined {
  const sourceTag = program.tags.find((t) => t.startsWith('source:'));
  const keyTag = program.tags.find((t) => t.startsWith('key:'));
  if (sourceTag === undefined || keyTag === undefined) return undefined;
  return { sourceId: sourceTag.slice('source:'.length), externalKey: keyTag.slice('key:'.length) };
}

/**
 * Reject memory. hashProgram excludes TrustFields, so a candidate that is content-identical to
 * one the reviewer already rejected stays suppressed forever, while a candidate whose deadline,
 * amount, eligibility or status actually moved gets a NEW key and correctly resurfaces.
 * Without this, a source the reviewer judged noise reappears every single night and the inbox
 * stops being read — which defeats the entire trust design.
 */
export function rejectKeyFor(sourceId: string, program: Program): string {
  return createHash('sha256')
    .update(`${sourceId}|${program.id}|${hashProgram(program)}`)
    .digest('hex');
}

const TIER_CONFIDENCE: Record<SourceTier, number> = { A: 0.85, B: 0.5, C: 0.7, D: 0.95 };

/**
 * REMEDIATION (2026-08-03). `adjacencyScore` was `adjacencyScore?: number` — OPTIONAL — and the
 * one production call site (`buildReviewItems` below) passed two arguments. The branch under it
 * had therefore never executed even once, while `grants-gov-extract`, `grants-gov-federal`,
 * `nsf-awards` and `usaspending` all faithfully computed the number and wrote it into
 * `rawFields.adjacencyScore`, from where `normalizeRaw` discarded it. A relevance signal written
 * by four sources reached nothing.
 *
 * The parameter is now REQUIRED-BUT-NULLABLE rather than optional, and that is the actual fix to
 * the defect class at this seam: an optional parameter lets a call site silently mean "I have no
 * opinion", which is indistinguishable from "I forgot", and no test and no compiler can tell the
 * two apart. `number | undefined` forces every caller to state which one it means, so `tsc` — not
 * a reviewer's memory — is what catches the next call site that drops the signal.
 *
 * `undefined` means "this source computes no adjacency score", which every ham-specific source
 * legitimately does. It must never be conflated with a score of 0, which means "scored, and
 * scored nothing".
 */
export function confidenceFor(
  tier: SourceTier,
  kind: ChangeKind,
  adjacencyScore: number | undefined,
): number {
  if (adjacencyScore !== undefined) {
    return Math.min(1, Math.max(0, adjacencyScore / 12));
  }
  if (kind === 'parse_yield_dropped') return 0.1;
  const base = TIER_CONFIDENCE[tier];
  if (kind === 'vanished') return Math.max(0, base - 0.2);
  return base;
}

const NO_CANDIDATE_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['parse_yield_dropped']);

/**
 * REMEDIATION (2026-08-03): `do_not_publish` is enforced HERE, and this is why.
 *
 * The tag was written by `normalize/`'s `buildTags` and read by nothing at all — not
 * `diffPrograms`, not `buildReviewItems`, not the approve path. Four sources
 * (`arrl-club-grant`, `ardc-award-tables`, `nsf-awards`, `usaspending`) each carried a comment
 * promising that past awards "can never render as a live deadline"; none of that was true of the
 * running code. A real crawl of the committed club-grant fixture put 38 rows in the review queue:
 * the one real ARRL Club Grant Program and 37 clubs that had already RECEIVED money, each a
 * publishable `Program` with the same `klass` and `applicantEntities` as the real grant.
 *
 * WHY THE REVIEW QUEUE, AND NOT THE CRAWL. The crawl is where these records get STORED, and
 * storing them is correct and wanted: a funder's list of past recipients is the best available
 * evidence of who that funder actually funds. `runSource` calls `insertChangeEvents` (which
 * carries the whole normalized `Program` in `after_json`) before it ever calls
 * `buildReviewItems`, so suppressing here keeps every suppressed record fully stored and
 * retrievable through `listChangeEvents` while keeping it out of the human queue.
 *
 * WHY NOT ONLY THE APPROVE PATH. The harm the reviewer suffers is the QUEUE, not the publish: 37
 * historical awards sitting in an Inbox as apparent opportunities, each of which has to be clicked
 * into before it can be recognised as history. Gating only at approve would leave all 37 there.
 *
 * WHY BOTH, THEN. `buildReviewItems` is the only constructor of the queue, so it is the primary
 * gate. `approveReviewItem`/`editReviewItem` are documented as "the ONLY path that writes into the
 * published corpus", so they are the backstop — they catch review-item rows that were persisted by
 * a crawl that ran BEFORE this fix (which `buildReviewItems` will never see again), and they mean
 * that deleting either gate alone still leaves suppression enforced. A safety tag with exactly one
 * reader is one deletion away from being unread again, which is the defect class being closed here.
 *
 * `SUPPRESSION_EXEMPT_KINDS` is the one deliberate hole. A `vanished` event is a proposal to
 * REMOVE a program, not to publish one, so it is not an "apparent opportunity" and must not be
 * swallowed: it is the only reviewable path by which a record published before this fix can be
 * taken back out of the corpus. `approveReviewItem` handles `vanished` in its own branch, which
 * calls `deleteProgram` and never `upsertProgram`, so the backstop below sits strictly on the
 * publishing branch.
 */
const SUPPRESSION_EXEMPT_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['vanished']);

/**
 * REMEDIATION (2026-08-03) — the nightly `nsf-funding-rss` flood, and why the gate is HERE.
 *
 * `nsf-funding-rss` is the one federal source that carries OPEN solicitations rather than award
 * history, so `do_not_publish` is the wrong instrument for it: these are real opportunities, they
 * are simply not opportunities for a radio club. A real capture of its three feeds (2026-08-03)
 * holds 45 items and EVERY ONE scores 1 or 0 against `ADJACENCY_THRESHOLD` of 6 — the best three
 * are Gravitational Physics, Chemical Oceanography and SBIR. All 45 landed in the review queue,
 * every night, forever. A queue that is 45-out-of-45 noise trains its reader to approve without
 * reading, which destroys the entire reason for having a review step instead of auto-publishing.
 *
 * WHY NOT FILTER IN THE SOURCE'S `parse()`, WHICH IS WHERE THE OTHER FOUR SCORED SOURCES FILTER.
 * Because `parse()`'s return length IS the yield alarm. `runSource` feeds `raws.length` to
 * `detectYieldDrop` (against `expectedMinRecords: 10`) and to `recordPollSuccess`. A source that
 * drops sub-threshold items inside `parse()` reports a yield of 0 on a night when nothing is
 * adjacent — which is indistinguishable from NSF moving the feed, serving an SPA shell, or
 * renaming an element. That is exactly how `arrl-scholarship-program` parsed 0 records from its
 * own real page while the whole suite stayed green. Filtering here, one stage downstream, means
 * the source keeps parsing and REPORTING all 45, the alarm keeps watching the real number, and
 * only the human queue is spared.
 *
 * `vanished` is exempt for the same reason it is exempt from `do_not_publish`: it proposes a
 * REMOVAL, never a publication, and swallowing it would strand a record that is already published.
 *
 * A score of exactly `ADJACENCY_THRESHOLD` passes — the single real open federal call in the
 * committed captures (NTIA PWSCIF) scores exactly 6, so an off-by-one here silently empties the
 * federal sweep of its only true positive.
 *
 * EXPORTED so `scripts/profile-corpus.ts` can apply THIS predicate rather than restate the rule.
 * The profiler's corpus is defined as "the programs the product would actually SHOW", and it
 * already imports `isDoNotPublish` from `normalize/index.ts` for exactly that reason — but it
 * missed this second gate and so counted 197 programs where a user can reach 152, over-reporting
 * by 23% in the instrument every acceptance figure in Plan 2 was measured with. Sharing the
 * predicate is the fix; re-expressing `score < ADJACENCY_THRESHOLD` over there would have left the
 * same drift one edit away, including the off-by-one above.
 */
export function isBelowAdjacencyThreshold(score: number | undefined): boolean {
  return score !== undefined && score < ADJACENCY_THRESHOLD;
}

/** Thrown when something tries to publish a program tagged `do_not_publish`. */
export class SuppressedProgramError extends Error {
  readonly programId: string;
  constructor(program: Program, action: string) {
    super(
      `Refusing to ${action} program "${program.name}" (${program.id}): it is tagged ` +
        `"${DO_NOT_PUBLISH_TAG}", which means it is stored evidence (a past award, or a ` +
        `cross-check-only record) and not a funding opportunity. Publishing it would list ` +
        `history as live funding. If this record really is an opportunity, fix the source's ` +
        `recordType rather than stripping the tag.`,
    );
    this.name = 'SuppressedProgramError';
    this.programId = program.id;
  }
}

function reviewItemId(event: ChangeEvent): string {
  return `ri-${createHash('sha256').update(`${event.id}|${event.fieldPath ?? ''}`).digest('hex').slice(0, 20)}`;
}

/**
 * Nothing publishes unreviewed. Every ChangeEvent that carries a candidate Program becomes a
 * pending ReviewItem, unless its rejectKey is already in the reject memory. Signal-only events
 * (ARRL news RSS) and alarms (parse_yield_dropped) carry no candidate and produce no item —
 * they are read directly from change_events by the Inbox.
 *
 * `adjacencyByProgramId` carries `federal/adjacency.ts`'s weighted relevance score for the
 * candidates whose source computed one, keyed by the program id `normalizeRaw` minted for the
 * matching `RawOpportunity`. `crawl/runner.ts` is the only production caller and builds it there,
 * because that is the one place where a `RawOpportunity` and the `Program` it became are both in
 * hand: `normalizeRaw` drops `rawFields` wholesale, so by the time a candidate reaches this
 * function the score exists nowhere else.
 *
 * A missing entry means "this source computes no adjacency score" — true of every ham-specific
 * source, and of any candidate that came out of the database rather than tonight's parse (a
 * `vanished` candidate) — and leaves the tier/kind behaviour exactly as it was.
 */
export async function buildReviewItems(
  db: Database.Database,
  events: ChangeEvent[],
  candidatesById: Map<string, Program>,
  tier: SourceTier,
  sourceId: string,
  assist?: AiAssist,
  adjacencyByProgramId?: ReadonlyMap<string, number>,
): Promise<ReviewItem[]> {
  const out: ReviewItem[] = [];
  for (const event of events) {
    if (NO_CANDIDATE_KINDS.has(event.kind)) continue;
    if (!event.programId) continue;
    const candidate = candidatesById.get(event.programId);
    if (!candidate) continue;
    // The primary do_not_publish gate — see SUPPRESSION_EXEMPT_KINDS above. The record stays
    // stored: `runSource` already wrote it (and this whole candidate Program) into change_events.
    if (isDoNotPublish(candidate) && !SUPPRESSION_EXEMPT_KINDS.has(event.kind)) continue;

    // The adjacency gate — see `isBelowAdjacencyThreshold` above. Same shape as the line above it
    // and for the same reason: the record was already written to change_events by `runSource`
    // before this function was ever called, so it stays stored, scored and retrievable; only the
    // human queue is spared. `parsedCount`/source health still report the true parse yield.
    const adjacencyScore = adjacencyByProgramId?.get(event.programId);
    if (isBelowAdjacencyThreshold(adjacencyScore) && !SUPPRESSION_EXEMPT_KINDS.has(event.kind)) {
      continue;
    }

    const rejectKey = rejectKeyFor(sourceId, candidate);
    if (isRejected(db, rejectKey)) continue;

    const deterministic = confidenceFor(tier, event.kind, adjacencyScore);
    // Optional (spec §9). undefined whenever ANTHROPIC_API_KEY is absent or the call failed,
    // and then the deterministic number stands exactly as it did before this task existed.
    const assisted = assist === undefined ? undefined : await assist.preScore(candidate);
    const item: ReviewItem = {
      id: reviewItemId(event),
      changeEventId: event.id,
      candidate,
      decision: 'pending',
      confidence: assisted ?? deterministic,
      rejectKey,
    };
    insertReviewItem(db, item);
    out.push(item);
  }
  return out;
}

function require(db: Database.Database, itemId: string): ReviewItem {
  const item = getReviewItem(db, itemId);
  if (!item) throw new Error(`unknown review item "${itemId}"`);
  return item;
}

function kindOf(db: Database.Database, changeEventId: string): string {
  const row = db.prepare('SELECT kind FROM change_events WHERE id = ?').get(changeEventId) as
    | { kind: string }
    | undefined;
  return row?.kind ?? 'unknown';
}

/**
 * SEAM FIX (whole-branch review, 2026-08-02). `expandCycles` (core) and `createCycleRepo` had
 * zero production callers — only tests called them directly — so `cycles` stayed empty forever
 * and Plan 3's "next deadline" would render blank for every published program. `approveReviewItem`
 * / `editReviewItem` are "the ONLY path that writes into the published corpus" (see the comment
 * above), so this is the one place a program's cycle needs projecting: the moment its content
 * (including its `deadline`) is published.
 *
 * Horizon: long enough that every RECUR kind (n_fixed_dates, n_fixed_windows, annual_window) is
 * guaranteed at least one occurrence inside the window no matter where `nowISO` falls in the
 * yearly cycle, plus slack. `expandCycles` itself already widens its per-year scan by a year on
 * each side of [from, to], so 18 months of outer window is generous, not tight.
 */
export const CYCLE_HORIZON_MONTHS = 18;

export function cycleHorizonEndISO(nowISO: string): string {
  const horizon = new Date(nowISO);
  horizon.setUTCMonth(horizon.getUTCMonth() + CYCLE_HORIZON_MONTHS);
  return horizon.toISOString();
}

/**
 * REMEDIATION (2026-08-03). Deletes the `isEstimated: false` rows for one program — the mirror of
 * `CycleRepo.removeEstimatedForProgram`, and the half of "replace, never accumulate" that observed
 * cycles need now that something finally writes them.
 *
 * Without it, a funder that MOVES its stated window leaves the old row behind (the id carries the
 * close instant, so the new window upserts alongside rather than over it), and a funder that
 * WITHDRAWS its window leaves a deadline on the calendar that no page states any more — which is
 * the same failure as publishing a date nobody announced, one step removed.
 *
 * Raw SQL here rather than a `CycleRepo` method for the same reason `kindOf` above is raw SQL:
 * this file is the seam that AUTHORS cycles, and the delete exists only to serve the write below
 * it. `removeEstimatedForProgram` is its natural neighbour and the two belong on the repo together
 * whenever that file is next opened.
 */
function removeObservedForProgram(db: Database.Database, programId: string): void {
  db.prepare('DELETE FROM cycles WHERE program_id = ? AND is_estimated = 0').run(programId);
}

/**
 * Writes one program's cycles against `allPublished`: the recurrence PROJECTED forward
 * (`isEstimated: true`) plus the one window its funder actually STATED (`isEstimated: false`).
 *
 * Delete-then-upsert, not a bare upsert, is what makes a re-publish REPLACE rather than accumulate:
 * every cycle id is derived from its `closesAt`, so if the RECUR note or the stated window changes
 * (a funder moves its deadline) the old dates would otherwise never be removed.
 *
 * The two halves are deliberately separate calls into `core`. A `RECUR` directive is a rule and is
 * repeated into every year of the horizon; a stated window is one dated window and is written once,
 * with no successor invented for the years after it — see `observedCycles`. Merging them into one
 * `expandCycles` call is exactly the shortcut that would put a 2027 ARISS deadline on the calendar.
 */
function writeCyclesFor(
  cycles: CycleRepo,
  db: Database.Database,
  program: Program,
  allPublished: Program[],
  nowISO: string,
): void {
  const horizonEnd = cycleHorizonEndISO(nowISO);
  const projected = expandCycles(program, allPublished, nowISO, horizonEnd);
  const stated = observedCycles(program, allPublished, nowISO, horizonEnd);
  cycles.removeEstimatedForProgram(program.id);
  removeObservedForProgram(db, program.id);
  cycles.upsertMany([...projected, ...stated]);
}

/**
 * ROUND 2 (whole-branch review, 2026-08-03). `deadline.source` may be `{kind:'inherited',
 * fromProgramId}`, resolved through `resolveDeadlineOwner`, which fabricates nothing when the
 * owner is not (yet) published — correct per its own contract. But round 1 only re-projected the
 * ONE program being published, so whether a program that inherits its deadline from `justPublished`
 * ever got cycles depended entirely on approval ORDER: approve the dependent before its owner and
 * it stayed cycle-less forever, because nothing ever touched it again once the owner became
 * available. That is a product defect, not an edge case — 112 of 181 real ARRL-catalog candidates
 * inherit from `arrl-foundation-scholarships`, so the calendar for the majority of the corpus
 * depended on which Inbox row a human happened to click first, with no UI signal that order
 * mattered and no prompt to fix it.
 *
 * Fix: whenever a program publishes, also re-project every OTHER already-published program whose
 * deadline resolves (through `resolveDeadlineOwner`, following inherited chains) to the one just
 * published. Combined with the forward path in `projectCycles`, this makes `cycles` converge to
 * the identical result regardless of approval order — a dependent approved before its owner
 * self-heals the moment the owner is later published, with no manual republish required.
 */
function backfillInheritedDependents(
  cycles: CycleRepo,
  db: Database.Database,
  justPublished: Program,
  allPublished: Program[],
  nowISO: string,
): void {
  for (const other of allPublished) {
    if (other.id === justPublished.id) continue;
    if (other.deadline.source.kind !== 'inherited') continue;
    const owner = resolveDeadlineOwner(other, allPublished);
    if (owner.id !== justPublished.id) continue;
    writeCyclesFor(cycles, db, other, allPublished, nowISO);
  }
}

/**
 * Projects `program`'s deadline into the `cycles` table against the CURRENTLY published corpus,
 * then backfills every already-published program that inherits from it (round 2 — see
 * `backfillInheritedDependents`). `approveReviewItem` / `editReviewItem` are "the ONLY path that
 * writes into the published corpus" (see the comment below), so this is the one place a program's
 * cycle needs projecting: the moment its content (including its `deadline`) is published.
 */
function projectCycles(db: Database.Database, program: Program, nowISO: string): void {
  const allPublished = createProgramRepo(db).list();
  const cycles = createCycleRepo(db);
  writeCyclesFor(cycles, db, program, allPublished, nowISO);
  backfillInheritedDependents(cycles, db, program, allPublished, nowISO);
}

/**
 * ROUND 2 decision on the OTHER flagged residual: the 18-month horizon is not re-projected as time
 * passes, so a program nobody ever touches again (no crawl diff, no re-approval) slowly ages out of
 * its own calendar. DECISION: re-project rather than defer, because the fix is cheap (pure
 * computation plus a handful of small writes, safe at this corpus's scale — under 200 programs) and
 * "where programs are already refreshed" already exists: the nightly crawl. `crawl/runner.ts`'s
 * `runCrawl` calls this once, after every source has run, to re-project EVERY published program's
 * cycles forward from `nowISO` — independent of whether tonight's crawl produced any review items
 * for it. A single pass over the whole published corpus with a shared `allPublished` snapshot also
 * naturally handles every inherited chain correctly without needing the backfill logic above (every
 * program, owners included, is re-projected in the same pass).
 */
export function reprojectAllCycles(db: Database.Database, nowISO: string): void {
  const allPublished = createProgramRepo(db).list();
  const cycles = createCycleRepo(db);
  for (const program of allPublished) {
    writeCyclesFor(cycles, db, program, allPublished, nowISO);
  }
}

/** The ONLY path that writes into the published corpus. */
export function approveReviewItem(
  db: Database.Database,
  itemId: string,
  userId: string,
  nowISO: string,
): Program {
  const item = require(db, itemId);
  const kind = kindOf(db, item.changeEventId);
  if (kind === 'vanished') {
    deleteProgram(db, item.candidate.id); // cycles cascade via cycles.program_id ON DELETE CASCADE
  } else {
    // do_not_publish backstop on the publishing branch only: removing a suppressed record is
    // always allowed, adding one never is. Reached only by a review-item row persisted before
    // buildReviewItems started gating, since nothing creates such a row any more.
    if (isDoNotPublish(item.candidate)) throw new SuppressedProgramError(item.candidate, 'approve');
    upsertProgram(db, item.candidate, sourceKeyFor(item.candidate));
    projectCycles(db, item.candidate, nowISO);
  }
  setReviewDecision(db, itemId, 'approved', userId, nowISO);
  appendAuditLog(db, {
    userId,
    action: 'review.approve',
    entityType: 'review_item',
    entityId: itemId,
    detail: `approved ${kind} for ${item.candidate.name} (${item.candidate.id})`,
    atISO: nowISO,
  });
  return item.candidate;
}

export function rejectReviewItem(
  db: Database.Database,
  itemId: string,
  userId: string,
  nowISO: string,
  reason: string,
): void {
  const item = require(db, itemId);
  setReviewDecision(db, itemId, 'rejected', userId, nowISO);
  if (item.rejectKey) rememberReject(db, item.rejectKey, userId, nowISO);
  appendAuditLog(db, {
    userId,
    action: 'review.reject',
    entityType: 'review_item',
    entityId: itemId,
    detail: `rejected ${kindOf(db, item.changeEventId)} for ${item.candidate.name}: ${reason}`,
    atISO: nowISO,
  });
}

export function editReviewItem(
  db: Database.Database,
  itemId: string,
  userId: string,
  nowISO: string,
  edited: Program,
): Program {
  const item = require(db, itemId);
  // Same backstop as approve. The check is on `edited`, not on `item.candidate`: a reviewer who
  // has genuinely established that a record is an opportunity can strip the tag in the edit and
  // publish it, which keeps this a guardrail against silent publication rather than a lock a human
  // cannot reason their way past.
  if (isDoNotPublish(edited)) throw new SuppressedProgramError(edited, 'publish an edit of');
  upsertProgram(db, edited, sourceKeyFor(edited));
  projectCycles(db, edited, nowISO);
  setReviewDecision(db, itemId, 'edited', userId, nowISO, edited);
  appendAuditLog(db, {
    userId,
    action: 'review.edit',
    entityType: 'review_item',
    entityId: itemId,
    detail: `edited and published ${edited.name} (was "${item.candidate.name}")`,
    atISO: nowISO,
  });
  return edited;
}

export function listInbox(db: Database.Database, decision?: ReviewDecision): ReviewItem[] {
  return listReviewItems(db, decision);
}

export function provenanceFor(
  db: Database.Database,
  itemId: string,
): Array<{ userId: string; action: string; detail: string; atISO: string }> {
  return listAuditLog(db, itemId);
}
