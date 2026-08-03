import Database from 'better-sqlite3';
import type { ChangeEvent, Program, ReviewItem, SourceModule } from '@grantspotter/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { MissingSchemaError, ensureIngestionSchema } from '../ingestSchema.js';
import {
  appendAuditLog,
  deleteProgram,
  getReviewItem,
  insertChangeEvents,
  insertReviewItem,
  insertSnapshot,
  isRejected,
  listAuditLog,
  listChangeEvents,
  listProgramsBySource,
  listReviewItems,
  listSourceHealth,
  ProgramUpsertConflictError,
  recordPollFailure,
  recordPollStart,
  recordPollSuccess,
  rememberReject,
  setReviewDecision,
  upsertProgram,
} from './ingestion.js';

const NOW = '2026-08-02T00:00:00.000Z';

function program(over: Partial<Program> = {}): Program {
  return {
    id: 'qcwa--qcwa-memorial-scholarship--11223344',
    funderId: 'qcwa',
    name: 'QCWA Memorial Scholarship',
    klass: 'ham_scholarship',
    summary: 'A $3,000 scholarship requiring a QCWA sponsor.',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_fixed', amountMin: 3000, amountMax: 3000, amountRaw: '$3,000', awardCountRaw: '19' },
    deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'owner' }, note: '' },
    applyVia: 'external_spa_portal',
    applyUrl: 'https://www.qcwa.org/scholarship-program.htm',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
      lastVerifiedAt: NOW,
      verificationMethod: 'live_fetch',
      contentHash: 'hash-1',
    },
    rawOtherText: 'Applicant must be sponsored by an active QCWA member.',
    tags: ['source:qcwa'],
    ...over,
  };
}

const KEY = { sourceId: 'qcwa', externalKey: 'qcwa-memorial-scholarship' };

const qcwaSource: SourceModule = {
  id: 'qcwa',
  funderId: 'qcwa',
  label: 'QCWA Scholarship Program',
  tier: 'C',
  klass: 'ham_scholarship',
  requests: [],
  parse: () => [],
  expectedMinRecords: 1,
};

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  // Plan 1's migrations own every CONTRACT §6 table. Plan 2 never recreates one.
  migrate(db);
  ensureIngestionSchema(db);
  // funders.created_at / updated_at are NOT NULL with no DEFAULT in 001-init.sql — real
  // timestamps, not omitted columns, are required here.
  db.prepare(
    'INSERT INTO funders (id, name, homepage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('qcwa', 'Quarter Century Wireless Association', 'https://www.qcwa.org/', NOW, NOW);
});

describe('ensureIngestionSchema', () => {
  it('is idempotent — running it three times is harmless', () => {
    expect(() => {
      ensureIngestionSchema(db);
      ensureIngestionSchema(db);
    }).not.toThrow();
  });

  it('creates the one plan-local table and no CONTRACT §6 table', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const before = new Set(
      (fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>).map((r) => r.name),
    );
    ensureIngestionSchema(fresh);
    const after = (
      fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(after.filter((n) => !before.has(n))).toEqual(['review_rejects']);
    expect(after).not.toContain('source_health'); // RESOLUTIONS R4
  });

  it('throws MissingSchemaError instead of silently shadowing a Plan 1 table', () => {
    const bare = new Database(':memory:');
    let thrown: unknown;
    try {
      ensureIngestionSchema(bare);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MissingSchemaError);
    expect((thrown as MissingSchemaError).table).toBe('programs');
  });

  it('names the missing column when a Plan 1 table lost one', () => {
    const partial = new Database(':memory:');
    migrate(partial);
    partial.exec('ALTER TABLE sources DROP COLUMN last_record_count');
    expect(() => ensureIngestionSchema(partial)).toThrow(/sources\.last_record_count/);
  });

  it('requires sources.enabled — the column runCrawl gates on (RESOLUTIONS R20)', () => {
    const partial = new Database(':memory:');
    migrate(partial);
    partial.exec('ALTER TABLE sources DROP COLUMN enabled');
    expect(() => ensureIngestionSchema(partial)).toThrow(/sources\.enabled/);
  });

  it('does not re-declare an index Plan 1 already owns (RESOLUTIONS R23)', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const sqlFor = (name: string): string =>
      (
        fresh.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?").get(name) as
          | { sql: string | null }
          | undefined
      )?.sql ?? '';
    const plan1Definition = sqlFor('idx_snapshots_source');
    expect(plan1Definition).toContain('snapshots'); // Plan 1 really created it
    expect(plan1Definition).not.toMatch(/DESC/);
    ensureIngestionSchema(fresh);
    // Unchanged: SQLite matches IF NOT EXISTS on the name, so a second definition under the same
    // name would be a silent no-op. Plan 2 must not ship one.
    expect(sqlFor('idx_snapshots_source')).toBe(plan1Definition);
  });
});

describe('program repository — delegates to Plan 1 (RESOLUTIONS R1)', () => {
  it('upserts through createProgramRepo and reads back by source_id', () => {
    upsertProgram(db, program(), KEY);
    const rows = listProgramsBySource(db, 'qcwa');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(program());
  });

  it('writes the source key into programs.source_id / programs.external_key', () => {
    upsertProgram(db, program(), KEY);
    const row = db.prepare('SELECT source_id, external_key FROM programs WHERE id = ?').get(
      program().id,
    ) as { source_id: string; external_key: string };
    expect(row).toEqual({ source_id: 'qcwa', external_key: 'qcwa-memorial-scholarship' });
  });

  it('populates every normalized column — there is no doc/data blob', () => {
    upsertProgram(db, program(), KEY);
    const cols = (db.pragma('table_info(programs)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['summary', 'amount', 'obligations', 'trust']));
    expect(cols).not.toContain('doc');
    expect(cols).not.toContain('data');
    const row = db.prepare('SELECT summary, amount FROM programs WHERE id = ?').get(program().id) as {
      summary: string;
      amount: string;
    };
    expect(row.summary).toContain('$3,000');
    expect(JSON.parse(row.amount).amountRaw).toBe('$3,000');
  });

  it('upsert replaces rather than duplicating, and keeps the source key when omitted', () => {
    upsertProgram(db, program(), KEY);
    upsertProgram(db, program({ name: 'QCWA Memorial Scholarship (renamed)' }));
    const rows = listProgramsBySource(db, 'qcwa');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toContain('renamed');
  });

  it('deletes', () => {
    upsertProgram(db, program(), KEY);
    deleteProgram(db, program().id);
    expect(listProgramsBySource(db, 'qcwa')).toEqual([]);
  });

  it('surfaces a stale source-key upsert as a catchable, identifiable error, not a crash', () => {
    upsertProgram(db, program(), KEY);
    // A different id reusing the same (source_id, external_key) simulates a crawl runner that
    // missed findBySourceKey() and minted a fresh id instead of resolving the existing one.
    const collider = program({ id: 'a-different-minted-id' });
    let thrown: unknown;
    try {
      upsertProgram(db, collider, KEY);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProgramUpsertConflictError);
    expect((thrown as ProgramUpsertConflictError).programId).toBe('a-different-minted-id');
    expect((thrown as ProgramUpsertConflictError).sourceId).toBe('qcwa');
    expect((thrown as ProgramUpsertConflictError).externalKey).toBe('qcwa-memorial-scholarship');
    // The original program is untouched — the conflicting write never landed.
    expect(listProgramsBySource(db, 'qcwa')).toHaveLength(1);
  });
});

describe('snapshots', () => {
  it('stores the fetch envelope and the on-disk path, not the body twice', () => {
    recordPollStart(db, qcwaSource, NOW); // snapshots.source_id references sources(id)
    insertSnapshot(
      db,
      'qcwa',
      { url: 'https://www.qcwa.org/scholarship-program.htm', status: 200, contentType: 'text/html', body: '<p>x</p>', fetchedAt: NOW },
      '/data/snapshots/qcwa/abc/2026.html',
    );
    const row = db.prepare('SELECT * FROM snapshots').get() as Record<string, unknown>;
    expect(row.source_id).toBe('qcwa');
    expect(row.status).toBe(200);
    expect(row.file_path).toBe('/data/snapshots/qcwa/abc/2026.html');
    expect(row.body_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('change events', () => {
  const event: ChangeEvent = {
    id: 'evt-1',
    sourceId: 'qcwa',
    programId: program().id,
    kind: 'deadline_changed',
    before: { kind: 'annual_window' },
    after: { kind: 'inherited' },
    detectedAt: NOW,
    fieldPath: 'deadline',
  };

  it('inserts and reads back with before/after JSON intact', () => {
    insertChangeEvents(db, [event]);
    const rows = listChangeEvents(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(event);
  });

  it('is idempotent on the same event id', () => {
    insertChangeEvents(db, [event, event]);
    expect(listChangeEvents(db, 10)).toHaveLength(1);
  });

  it('returns newest first', () => {
    insertChangeEvents(db, [
      { ...event, id: 'a', detectedAt: '2026-08-01T00:00:00.000Z' },
      { ...event, id: 'b', detectedAt: '2026-08-02T00:00:00.000Z' },
    ]);
    expect(listChangeEvents(db, 10).map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('review items and reject memory', () => {
  const item: ReviewItem = {
    id: 'ri-1',
    changeEventId: 'evt-1',
    candidate: program(),
    decision: 'pending',
    confidence: 0.75,
    rejectKey: 'rk-1',
  };

  beforeEach(() => {
    // review_items.change_event_id REFERENCES change_events(id) in Plan 1's DDL.
    insertChangeEvents(db, [
      { id: 'evt-1', sourceId: 'qcwa', kind: 'deadline_changed', detectedAt: NOW },
    ]);
  });

  it('inserts, lists and filters by decision', () => {
    insertReviewItem(db, item);
    expect(listReviewItems(db)).toHaveLength(1);
    expect(listReviewItems(db, 'pending')).toHaveLength(1);
    expect(listReviewItems(db, 'approved')).toHaveLength(0);
    expect(getReviewItem(db, 'ri-1')?.candidate).toEqual(program());
  });

  it('records a decision with who and when', () => {
    insertReviewItem(db, item);
    setReviewDecision(db, 'ri-1', 'approved', 'user-1', NOW);
    const after = getReviewItem(db, 'ri-1');
    expect(after?.decision).toBe('approved');
    expect(after?.decidedBy).toBe('user-1');
    expect(after?.decidedAt).toBe(NOW);
  });

  it('stores an edited candidate when the reviewer changed it', () => {
    insertReviewItem(db, item);
    setReviewDecision(db, 'ri-1', 'edited', 'user-1', NOW, program({ name: 'Corrected name' }));
    expect(getReviewItem(db, 'ri-1')?.candidate.name).toBe('Corrected name');
  });

  it('remembers a rejection so an identical candidate never resurfaces', () => {
    expect(isRejected(db, 'rk-1')).toBe(false);
    rememberReject(db, 'rk-1', 'user-1', NOW);
    expect(isRejected(db, 'rk-1')).toBe(true);
    expect(isRejected(db, 'rk-2')).toBe(false);
  });

  it('tolerates remembering the same reject twice', () => {
    rememberReject(db, 'rk-1', 'user-1', NOW);
    expect(() => rememberReject(db, 'rk-1', 'user-1', NOW)).not.toThrow();
  });
});

describe('source health lives on the `sources` table — RESOLUTIONS R4', () => {
  const other = (id: string, expectedMinRecords = 1): SourceModule => ({
    ...qcwaSource,
    id,
    label: id,
    expectedMinRecords,
  });

  it('writes to the same columns Plan 3’s Sources page reads', () => {
    recordPollStart(db, qcwaSource, NOW);
    recordPollSuccess(db, 'qcwa', 1, NOW);
    const row = db
      .prepare(
        `SELECT last_polled_at, last_success_at, last_record_count, consecutive_failures,
                expected_min_records, last_error FROM sources WHERE id = ?`,
      )
      .get('qcwa') as Record<string, unknown>;
    expect(row.last_polled_at).toBe(NOW);
    expect(row.last_success_at).toBe(NOW);
    expect(row.last_record_count).toBe(1);
    expect(row.expected_min_records).toBe(1);
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_error).toBeNull();
  });

  it('records a poll start, then a success, and clears the failure counter', () => {
    recordPollStart(db, qcwaSource, NOW);
    recordPollSuccess(db, 'qcwa', 1, NOW);
    const [row] = listSourceHealth(db);
    expect(row.sourceId).toBe('qcwa');
    expect(row.lastPolledAt).toBe(NOW);
    expect(row.lastSuccessAt).toBe(NOW);
    expect(row.lastRecordCount).toBe(1);
    expect(row.expectedMinRecords).toBe(1);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastError).toBeUndefined();
  });

  it('registers a source it has never seen, and refreshes label/tier on the next poll', () => {
    recordPollStart(db, other('ncdxf-grants'), NOW);
    expect(
      db.prepare('SELECT label, tier, funder_id, klass FROM sources WHERE id = ?').get('ncdxf-grants'),
    ).toEqual({ label: 'ncdxf-grants', tier: 'C', funder_id: 'qcwa', klass: 'ham_scholarship' });
  });

  it('counts consecutive failures and keeps the last error', () => {
    recordPollStart(db, other('ncdxf-grants'), NOW);
    recordPollFailure(db, 'ncdxf-grants', 'HTTP 500', NOW);
    recordPollFailure(db, 'ncdxf-grants', 'timeout', NOW);
    const [row] = listSourceHealth(db);
    expect(row.consecutiveFailures).toBe(2);
    expect(row.lastError).toBe('timeout');
    expect(row.lastSuccessAt).toBeUndefined();
  });

  it('resets the failure counter on the next success', () => {
    recordPollStart(db, other('s'), NOW);
    recordPollFailure(db, 's', 'boom', NOW);
    recordPollSuccess(db, 's', 3, NOW);
    expect(listSourceHealth(db)[0].consecutiveFailures).toBe(0);
  });

  it('lists every tracked source', () => {
    recordPollStart(db, other('a'), NOW);
    recordPollStart(db, other('b', 2), NOW);
    expect(listSourceHealth(db).map((r) => r.sourceId).sort()).toEqual(['a', 'b']);
  });
});

describe('audit log', () => {
  it('appends and reads back the provenance trail for one entity', () => {
    appendAuditLog(db, {
      userId: 'user-1',
      action: 'review.approve',
      entityType: 'review_item',
      entityId: 'ri-1',
      detail: 'approved deadline_changed for QCWA',
      atISO: NOW,
    });
    const rows = listAuditLog(db, 'ri-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('review.approve');
    expect(rows[0].userId).toBe('user-1');
  });

  it('writes Plan 1’s column name — the column is actor_user_id, not user_id', () => {
    appendAuditLog(db, { userId: 'u', action: 'a', entityType: 't', entityId: 'x', detail: 'd', atISO: NOW });
    const row = db.prepare('SELECT actor_user_id FROM audit_log WHERE entity_id = ?').get('x') as {
      actor_user_id: string;
    };
    expect(row.actor_user_id).toBe('u');
  });

  it('does not return another entity’s entries', () => {
    appendAuditLog(db, { userId: 'u', action: 'a', entityType: 't', entityId: 'x', detail: 'd', atISO: NOW });
    expect(listAuditLog(db, 'y')).toEqual([]);
  });
});
