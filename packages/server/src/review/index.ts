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
import { expandCycles, hashProgram } from '@grantspotter/core';
import type { AiAssist } from '../ai/assist.js';
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

export function confidenceFor(
  tier: SourceTier,
  kind: ChangeKind,
  adjacencyScore?: number,
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

function reviewItemId(event: ChangeEvent): string {
  return `ri-${createHash('sha256').update(`${event.id}|${event.fieldPath ?? ''}`).digest('hex').slice(0, 20)}`;
}

/**
 * Nothing publishes unreviewed. Every ChangeEvent that carries a candidate Program becomes a
 * pending ReviewItem, unless its rejectKey is already in the reject memory. Signal-only events
 * (ARRL news RSS) and alarms (parse_yield_dropped) carry no candidate and produce no item —
 * they are read directly from change_events by the Inbox.
 */
export async function buildReviewItems(
  db: Database.Database,
  events: ChangeEvent[],
  candidatesById: Map<string, Program>,
  tier: SourceTier,
  sourceId: string,
  assist?: AiAssist,
): Promise<ReviewItem[]> {
  const out: ReviewItem[] = [];
  for (const event of events) {
    if (NO_CANDIDATE_KINDS.has(event.kind)) continue;
    if (!event.programId) continue;
    const candidate = candidatesById.get(event.programId);
    if (!candidate) continue;

    const rejectKey = rejectKeyFor(sourceId, candidate);
    if (isRejected(db, rejectKey)) continue;

    const deterministic = confidenceFor(tier, event.kind);
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
 * Projects `program`'s deadline into the `cycles` table against the CURRENTLY published corpus.
 * `deadline.source` may be `{kind:'inherited', fromProgramId}` — `expandCycles` resolves that
 * through `resolveDeadlineOwner`, which walks `allPublished` to find the owner and, per its own
 * contract, fabricates nothing when the owner is not (yet) published. That is correct here too: a
 * program approved before the program it inherits its deadline from just published gets no cycles
 * until it is next published again (e.g. the next time its content changes) — never a guessed
 * date.
 *
 * `removeEstimatedForProgram` before `upsertMany`, not a bare upsert, is what makes a re-publish
 * REPLACE rather than accumulate: a projected cycle's id is derived from its `closesAt`, so if the
 * RECUR note itself changes (a funder moves its deadline) the old dates would otherwise never be
 * removed. Observed cycles (`isEstimated: false` — nothing in this codebase writes those yet, per
 * `cycles.ts`'s own doc comment) are deliberately left untouched.
 */
function projectCycles(db: Database.Database, program: Program, nowISO: string): void {
  const allPublished = createProgramRepo(db).list();
  const projected = expandCycles(program, allPublished, nowISO, cycleHorizonEndISO(nowISO));
  const cycles = createCycleRepo(db);
  cycles.removeEstimatedForProgram(program.id);
  cycles.upsertMany(projected);
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
