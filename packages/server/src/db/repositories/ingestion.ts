import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ChangeEvent,
  ChangeKind,
  FetchedPayload,
  Program,
  ReviewDecision,
  ReviewItem,
  SourceModule,
} from '@grantspotter/core';
import { programSchema } from '@grantspotter/core';
import type { ProgramSourceKey } from './programs.js';
import { createProgramRepo } from './programs.js';

/**
 * RESOLUTIONS R4. Source health lives on Plan 1's `sources` table — there is no `source_health`.
 * Field names track the columns exactly: lastPolledAt (last_polled_at), lastRecordCount
 * (last_record_count).
 */
export interface SourceHealthRow {
  sourceId: string;
  lastPolledAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastRecordCount?: number;
  expectedMinRecords: number;
  consecutiveFailures: number;
}

const orUndefined = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

/** JSON Program column (review_items.candidate_json) — validated with core's schema, not a hand-rolled one. */
const parseCandidate = (json: string): Program => programSchema.parse(JSON.parse(json));
const serializeCandidate = (p: Program): string => JSON.stringify(p);

/**
 * `programs.upsert` targets `ON CONFLICT(id)` only (Plan 1 Task 13). The partial unique index
 * `programs_source_key` on (source_id, external_key) is NOT an upsert conflict target, so a write
 * that reuses another row's source key — a crawler that missed `findBySourceKey()` and minted a
 * fresh id instead of resolving the existing one — fails loudly with
 * `SQLITE_CONSTRAINT_UNIQUE: programs.source_id, programs.external_key` rather than silently
 * duplicating the record. That is the correct failure, but the crawl runner needs to catch it
 * for one source without the whole nightly run crashing. `upsertProgram` recognizes the
 * constraint by its SQLite error code (not by driver-specific type-checking better-sqlite3's
 * internal SqliteError) and rethrows it as this named, catchable error carrying the ids involved.
 */
export class ProgramUpsertConflictError extends Error {
  readonly programId: string;
  readonly sourceId: string;
  readonly externalKey: string;
  constructor(programId: string, sourceId: string, externalKey: string, cause: unknown) {
    super(
      `Program "${programId}" conflicts with an existing row already registered under ` +
        `source "${sourceId}" / external key "${externalKey}". The crawl runner should have ` +
        `resolved this id via findBySourceKey() before upserting; catch this error and skip ` +
        `the record rather than let it crash the run.`,
      { cause },
    );
    this.name = 'ProgramUpsertConflictError';
    this.programId = programId;
    this.sourceId = sourceId;
    this.externalKey = externalKey;
  }
}

/** True for the exact UNIQUE violation on `programs_source_key` (source_id, external_key). */
function isSourceKeyConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    err.message.includes('programs.source_id, programs.external_key')
  );
}

/**
 * RESOLUTIONS R1: `programs` is Plan 1's normalized table and `createProgramRepo` is the only
 * thing that knows its column list. These three wrappers exist because the crawl runner needs a
 * by-source query, which ProgramRepo does not expose; they add no shape knowledge of their own.
 */
export function upsertProgram(
  db: Database.Database,
  p: Program,
  sourceKey?: ProgramSourceKey,
): void {
  try {
    createProgramRepo(db).upsert(p, sourceKey);
  } catch (err) {
    if (sourceKey !== undefined && isSourceKeyConflict(err)) {
      throw new ProgramUpsertConflictError(p.id, sourceKey.sourceId, sourceKey.externalKey, err);
    }
    throw err;
  }
}

export function listProgramsBySource(db: Database.Database, sourceId: string): Program[] {
  const repo = createProgramRepo(db);
  const ids = db
    .prepare('SELECT id FROM programs WHERE source_id = ? ORDER BY id')
    .all(sourceId) as Array<{ id: string }>;
  const out: Program[] = [];
  for (const { id } of ids) {
    const program = repo.get(id);
    if (program !== undefined) out.push(program);
  }
  return out;
}

export function deleteProgram(db: Database.Database, id: string): void {
  createProgramRepo(db).remove(id);
}

export function insertSnapshot(
  db: Database.Database,
  sourceId: string,
  payload: FetchedPayload,
  filePath?: string,
): void {
  db.prepare(
    `INSERT INTO snapshots (source_id, url, status, content_type, body_sha256, body_bytes, file_path, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceId,
    payload.url,
    payload.status,
    payload.contentType,
    createHash('sha256').update(payload.body).digest('hex'),
    Buffer.byteLength(payload.body, 'utf8'),
    filePath ?? null,
    payload.fetchedAt,
  );
}

export function insertChangeEvents(db: Database.Database, events: ChangeEvent[]): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO change_events (id, source_id, program_id, kind, before_json, after_json, field_path, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: ChangeEvent[]) => {
    for (const e of rows) {
      stmt.run(
        e.id,
        e.sourceId,
        e.programId ?? null,
        e.kind,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after),
        e.fieldPath ?? null,
        e.detectedAt,
      );
    }
  });
  tx(events);
}

export function listChangeEvents(db: Database.Database, limit: number): ChangeEvent[] {
  const rows = db
    .prepare('SELECT * FROM change_events ORDER BY detected_at DESC, id LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const event: ChangeEvent = {
      id: r.id as string,
      sourceId: r.source_id as string,
      kind: r.kind as ChangeKind,
      detectedAt: r.detected_at as string,
    };
    if (r.program_id) event.programId = r.program_id as string;
    if (r.field_path) event.fieldPath = r.field_path as string;
    if (r.before_json) event.before = JSON.parse(r.before_json as string);
    if (r.after_json) event.after = JSON.parse(r.after_json as string);
    return event;
  });
}

function toReviewItem(r: Record<string, unknown>): ReviewItem {
  const item: ReviewItem = {
    id: r.id as string,
    changeEventId: r.change_event_id as string,
    candidate: parseCandidate(r.candidate_json as string),
    decision: r.decision as ReviewDecision,
    confidence: r.confidence as number,
  };
  const decidedBy = orUndefined(r.decided_by);
  if (decidedBy) item.decidedBy = decidedBy;
  const decidedAt = orUndefined(r.decided_at);
  if (decidedAt) item.decidedAt = decidedAt;
  const rejectKey = orUndefined(r.reject_key);
  if (rejectKey) item.rejectKey = rejectKey;
  return item;
}

export function insertReviewItem(db: Database.Database, item: ReviewItem): void {
  db.prepare(
    `INSERT OR REPLACE INTO review_items (id, change_event_id, candidate_json, decision, decided_by, decided_at, confidence, reject_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.changeEventId,
    serializeCandidate(item.candidate),
    item.decision,
    item.decidedBy ?? null,
    item.decidedAt ?? null,
    item.confidence,
    item.rejectKey ?? null,
  );
}

export function listReviewItems(db: Database.Database, decision?: ReviewDecision): ReviewItem[] {
  const rows = (
    decision
      ? db.prepare('SELECT * FROM review_items WHERE decision = ? ORDER BY id').all(decision)
      : db.prepare('SELECT * FROM review_items ORDER BY id').all()
  ) as Array<Record<string, unknown>>;
  return rows.map(toReviewItem);
}

export function getReviewItem(db: Database.Database, id: string): ReviewItem | undefined {
  const row = db.prepare('SELECT * FROM review_items WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toReviewItem(row) : undefined;
}

export function setReviewDecision(
  db: Database.Database,
  id: string,
  decision: ReviewDecision,
  decidedBy: string,
  decidedAtISO: string,
  candidate?: Program,
): void {
  if (candidate) {
    db.prepare(
      'UPDATE review_items SET decision=?, decided_by=?, decided_at=?, candidate_json=? WHERE id=?',
    ).run(decision, decidedBy, decidedAtISO, serializeCandidate(candidate), id);
    return;
  }
  db.prepare('UPDATE review_items SET decision=?, decided_by=?, decided_at=? WHERE id=?').run(
    decision,
    decidedBy,
    decidedAtISO,
    id,
  );
}

export function rememberReject(
  db: Database.Database,
  rejectKey: string,
  decidedBy: string,
  atISO: string,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO review_rejects (reject_key, decided_by, decided_at) VALUES (?, ?, ?)',
  ).run(rejectKey, decidedBy, atISO);
}

export function isRejected(db: Database.Database, rejectKey: string): boolean {
  return (
    db.prepare('SELECT 1 FROM review_rejects WHERE reject_key = ?').get(rejectKey) !== undefined
  );
}

/**
 * RESOLUTIONS R4. Health is written to `sources`, which is where Plan 3's Sources page reads it
 * from. `recordPollStart` also REGISTERS the source, so a module added to the registry appears on
 * the health page after its first poll without anyone hand-seeding a row.
 */
export function recordPollStart(
  db: Database.Database,
  source: SourceModule,
  atISO: string,
): void {
  db.prepare(
    `INSERT INTO sources (id, label, tier, funder_id, klass, expected_min_records, last_polled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label=excluded.label,
       tier=excluded.tier,
       funder_id=excluded.funder_id,
       klass=excluded.klass,
       expected_min_records=excluded.expected_min_records,
       last_polled_at=excluded.last_polled_at`,
  ).run(
    source.id,
    source.label,
    source.tier,
    source.funderId,
    source.klass,
    source.expectedMinRecords,
    atISO,
  );
}

export function recordPollSuccess(
  db: Database.Database,
  sourceId: string,
  lastRecordCount: number,
  atISO: string,
): void {
  db.prepare(
    `UPDATE sources
       SET last_success_at = ?, last_record_count = ?, consecutive_failures = 0, last_error = NULL
     WHERE id = ?`,
  ).run(atISO, lastRecordCount, sourceId);
}

export function recordPollFailure(
  db: Database.Database,
  sourceId: string,
  error: string,
  _atISO: string,
): void {
  db.prepare(
    `UPDATE sources
       SET last_error = ?, consecutive_failures = consecutive_failures + 1
     WHERE id = ?`,
  ).run(error, sourceId);
}

export function listSourceHealth(db: Database.Database): SourceHealthRow[] {
  const rows = db
    .prepare(
      `SELECT id, expected_min_records, consecutive_failures, last_polled_at, last_success_at,
              last_error, last_record_count
         FROM sources ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const row: SourceHealthRow = {
      sourceId: r.id as string,
      expectedMinRecords: (r.expected_min_records as number) ?? 0,
      consecutiveFailures: (r.consecutive_failures as number) ?? 0,
    };
    const lastPolledAt = orUndefined(r.last_polled_at);
    if (lastPolledAt) row.lastPolledAt = lastPolledAt;
    const lastSuccessAt = orUndefined(r.last_success_at);
    if (lastSuccessAt) row.lastSuccessAt = lastSuccessAt;
    const lastError = orUndefined(r.last_error);
    if (lastError) row.lastError = lastError;
    if (typeof r.last_record_count === 'number') row.lastRecordCount = r.last_record_count;
    return row;
  });
}

export function appendAuditLog(
  db: Database.Database,
  entry: {
    /**
     * `null` for an event no signed-in person caused. `audit_log.actor_user_id` has always been
     * nullable (001-init.sql) and has no foreign key; this type simply said `string` because until
     * self-service enrolment every audited act was performed by an account. The refused-enrolment
     * row written by `api/auth.ts` is the first that is not: its actor is an anonymous caller
     * holding a code, and naming any user there — the code's issuer, say — would be a false
     * statement in the one record that exists to be believed.
     */
    userId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    detail: string;
    atISO: string;
  },
): void {
  // Plan 1's column is `actor_user_id` and the timestamp column is `at`.
  db.prepare(
    'INSERT INTO audit_log (at, actor_user_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(entry.atISO, entry.userId, entry.action, entry.entityType, entry.entityId, entry.detail);
}

export function listAuditLog(
  db: Database.Database,
  entityId: string,
): Array<{ userId: string; action: string; detail: string; atISO: string }> {
  const rows = db
    .prepare(
      'SELECT actor_user_id, action, detail, at FROM audit_log WHERE entity_id = ? ORDER BY id',
    )
    .all(entityId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: r.actor_user_id as string,
    action: r.action as string,
    detail: r.detail as string,
    atISO: r.at as string,
  }));
}
