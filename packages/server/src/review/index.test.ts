import Database from 'better-sqlite3';
import type { ChangeEvent, Program } from '@grantspotter/core';
import { hashProgram } from '@grantspotter/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureIngestionSchema } from '../db/ingestSchema.js';
import { migrate } from '../db/migrate.js';
import { isRejected, listProgramsBySource, listReviewItems } from '../db/repositories/ingestion.js';
import {
  approveReviewItem,
  buildReviewItems,
  confidenceFor,
  editReviewItem,
  listInbox,
  provenanceFor,
  rejectKeyFor,
  rejectReviewItem,
  sourceKeyFor,
} from './index.js';

const NOW = '2026-08-02T00:00:00.000Z';

function program(over: Partial<Program> = {}): Program {
  return {
    id: 'qcwa--qcwa-memorial-scholarship--11223344',
    funderId: 'qcwa',
    name: 'QCWA Memorial Scholarship',
    klass: 'ham_scholarship',
    summary: 'A $3,000 scholarship.',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_fixed', amountRaw: '$3,000', awardCountRaw: '19' },
    deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'owner' }, note: '' },
    applyVia: 'external_spa_portal',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
      lastVerifiedAt: NOW,
      verificationMethod: 'live_fetch',
      contentHash: 'h',
    },
    rawOtherText: 'Sponsored by an active QCWA member.',
    tags: ['source:qcwa', 'key:qcwa-memorial-scholarship'],
    ...over,
  };
}

const event = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  id: 'evt-1',
  sourceId: 'qcwa',
  programId: program().id,
  kind: 'new',
  after: program(),
  detectedAt: NOW,
  ...over,
});

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db); // Plan 1 owns every CONTRACT §6 table
  ensureIngestionSchema(db);
  db.prepare(
    'INSERT INTO funders (id, name, homepage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('qcwa', 'Quarter Century Wireless Association', 'https://www.qcwa.org/', NOW, NOW);
  // review_items.change_event_id references change_events(id) — foreign keys are ON, so every
  // event id a test passes to buildReviewItems must exist here first, including the re-surfaced
  // 'evt-9' used by the reject-memory tests below.
  db.prepare(
    'INSERT INTO change_events (id, source_id, program_id, kind, detected_at) VALUES (?, ?, ?, ?, ?)',
  ).run('evt-1', 'qcwa', program().id, 'new', NOW);
  db.prepare(
    'INSERT INTO change_events (id, source_id, program_id, kind, detected_at) VALUES (?, ?, ?, ?, ?)',
  ).run('evt-v', 'qcwa', program().id, 'vanished', NOW);
  db.prepare(
    'INSERT INTO change_events (id, source_id, program_id, kind, detected_at) VALUES (?, ?, ?, ?, ?)',
  ).run('evt-9', 'qcwa', program().id, 'amount_changed', NOW);
});

describe('sourceKeyFor', () => {
  it('reads the source key back out of the tags normalizeRaw stamped', () => {
    expect(sourceKeyFor(program())).toEqual({
      sourceId: 'qcwa',
      externalKey: 'qcwa-memorial-scholarship',
    });
  });

  it('returns undefined for a hand-curated record that no source produced', () => {
    expect(sourceKeyFor(program({ tags: [] }))).toBeUndefined();
    expect(sourceKeyFor(program({ tags: ['source:qcwa'] }))).toBeUndefined();
  });
});

describe('rejectKeyFor', () => {
  it('is stable for identical content', () => {
    expect(rejectKeyFor('qcwa', program())).toBe(rejectKeyFor('qcwa', program()));
  });

  it('ignores lastVerifiedAt, so an unchanged candidate stays suppressed', () => {
    const later = program({ trust: { ...program().trust, lastVerifiedAt: '2026-09-01T00:00:00.000Z' } });
    expect(rejectKeyFor('qcwa', later)).toBe(rejectKeyFor('qcwa', program()));
  });

  it('changes when the content actually changes, so a real change resurfaces', () => {
    const moved = program({ amount: { ...program().amount, amountRaw: '$4,000' } });
    expect(rejectKeyFor('qcwa', moved)).not.toBe(rejectKeyFor('qcwa', program()));
    expect(hashProgram(moved)).not.toBe(hashProgram(program()));
  });

  it('is namespaced by source', () => {
    expect(rejectKeyFor('other-source', program())).not.toBe(rejectKeyFor('qcwa', program()));
  });
});

describe('confidenceFor', () => {
  it('trusts a real API more than a scraped page and a human most of all', () => {
    expect(confidenceFor('D', 'new')).toBeGreaterThan(confidenceFor('A', 'new'));
    expect(confidenceFor('A', 'new')).toBeGreaterThan(confidenceFor('C', 'new'));
    expect(confidenceFor('C', 'new')).toBeGreaterThan(confidenceFor('B', 'new'));
  });

  it('drops confidence for a parse_yield_dropped alarm, which always needs a human', () => {
    expect(confidenceFor('C', 'parse_yield_dropped')).toBeLessThan(0.3);
  });

  it('scales a federal candidate by its adjacency score and clamps to 0..1', () => {
    expect(confidenceFor('A', 'new', 0)).toBe(0);
    expect(confidenceFor('A', 'new', 6)).toBeCloseTo(0.5, 5);
    expect(confidenceFor('A', 'new', 100)).toBe(1);
  });

  it('always returns a value in 0..1', () => {
    for (const tier of ['A', 'B', 'C', 'D'] as const) {
      for (const kind of ['new', 'vanished', 'deadline_changed'] as const) {
        const c = confidenceFor(tier, kind);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('buildReviewItems', () => {
  const candidates = () => new Map([[program().id, program()]]);

  it('creates one pending item per event that has a candidate', async () => {
    const items = await buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    expect(items).toHaveLength(1);
    expect(items[0].decision).toBe('pending');
    expect(items[0].changeEventId).toBe('evt-1');
    expect(items[0].candidate).toEqual(program());
    expect(listReviewItems(db, 'pending')).toHaveLength(1);
  });

  it('creates NO review item for a signal-style event with no candidate', async () => {
    const items = await buildReviewItems(
      db,
      [event({ programId: undefined, after: undefined })],
      new Map(),
      'B',
      'arrl-news-rss',
    );
    expect(items).toEqual([]);
  });

  it('creates NO review item for parse_yield_dropped — that is an alarm, not a candidate', async () => {
    const items = await buildReviewItems(
      db,
      [event({ id: 'evt-2', kind: 'parse_yield_dropped', programId: undefined, after: undefined })],
      new Map(),
      'C',
      'qcwa',
    );
    expect(items).toEqual([]);
  });

  it('suppresses a candidate whose rejectKey was already rejected', async () => {
    const first = await buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    rejectReviewItem(db, first[0].id, 'user-1', NOW, 'not relevant');
    const second = await buildReviewItems(db, [event({ id: 'evt-9' })], candidates(), 'C', 'qcwa');
    expect(second).toEqual([]);
    expect(listReviewItems(db, 'pending')).toHaveLength(0);
  });

  it('does NOT suppress a candidate whose content actually changed', async () => {
    const first = await buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    rejectReviewItem(db, first[0].id, 'user-1', NOW, 'not relevant');
    const moved = program({ amount: { ...program().amount, amountRaw: '$4,000' } });
    const second = await buildReviewItems(
      db,
      [event({ id: 'evt-9', kind: 'amount_changed', after: moved })],
      new Map([[moved.id, moved]]),
      'C',
      'qcwa',
    );
    expect(second).toHaveLength(1);
  });

  it('gives each item a deterministic id derived from the change event', async () => {
    const a = await buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    const b = await buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    expect(a[0].id).toBe(b[0].id);
    expect(listReviewItems(db)).toHaveLength(1);
  });

  it('uses the deterministic confidence when no assist is supplied', async () => {
    const [item] = await buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    expect(item.confidence).toBe(confidenceFor('C', 'new'));
  });

  it('lets an enabled assist refine the confidence, and ignores it when it returns undefined', async () => {
    const refining = { isEnabled: () => true, parseAssist: async () => [], preScore: async () => 0.33 };
    const silent = { isEnabled: () => true, parseAssist: async () => [], preScore: async () => undefined };
    const [a] = await buildReviewItems(db, [event()], candidates(), 'C', 'qcwa', refining);
    expect(a.confidence).toBeCloseTo(0.33, 5);
    db.exec('DELETE FROM review_items');
    const [b] = await buildReviewItems(db, [event({ id: 'evt-9' })], candidates(), 'C', 'qcwa', silent);
    expect(b.confidence).toBe(confidenceFor('C', 'new'));
  });
});

describe('approve / reject / edit', () => {
  const seed = async () =>
    (await buildReviewItems(db, [event()], new Map([[program().id, program()]]), 'C', 'qcwa'))[0];

  it('approve is the ONLY path that writes into the published corpus', async () => {
    const item = await seed();
    expect(listProgramsBySource(db, 'qcwa')).toEqual([]);
    const published = approveReviewItem(db, item.id, 'user-1', NOW);
    expect(published).toEqual(program());
    expect(listProgramsBySource(db, 'qcwa')).toHaveLength(1);
  });

  it('approve writes the source key, so tomorrow’s crawl sees the record as existing', async () => {
    approveReviewItem(db, (await seed()).id, 'user-1', NOW);
    expect(
      db.prepare('SELECT source_id, external_key FROM programs WHERE id = ?').get(program().id),
    ).toEqual({ source_id: 'qcwa', external_key: 'qcwa-memorial-scholarship' });
    // The whole point: listProgramsBySource is what diffPrograms uses as `previous`.
    expect(listProgramsBySource(db, 'qcwa')).toHaveLength(1);
  });

  it('approve records who and when, and writes the provenance trail', async () => {
    const item = await seed();
    approveReviewItem(db, item.id, 'user-1', NOW);
    const trail = provenanceFor(db, item.id);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('review.approve');
    expect(trail[0].userId).toBe('user-1');
    expect(trail[0].detail).toContain('new');
  });

  it('reject remembers the key and does not publish', async () => {
    const item = await seed();
    rejectReviewItem(db, item.id, 'user-1', NOW, 'past award, not an opportunity');
    expect(listProgramsBySource(db, 'qcwa')).toEqual([]);
    expect(isRejected(db, item.rejectKey ?? '')).toBe(true);
    expect(provenanceFor(db, item.id)[0].detail).toContain('past award');
  });

  it('edit publishes the corrected candidate and stores it back on the item', async () => {
    const item = await seed();
    const corrected = program({ name: 'QCWA Memorial Scholarship Fund' });
    const published = editReviewItem(db, item.id, 'user-1', NOW, corrected);
    expect(published.name).toBe('QCWA Memorial Scholarship Fund');
    expect(listProgramsBySource(db, 'qcwa')[0].name).toBe('QCWA Memorial Scholarship Fund');
    expect(listInbox(db, 'edited')).toHaveLength(1);
  });

  it('a vanished candidate is removed from the corpus on approval', async () => {
    const item = await seed();
    approveReviewItem(db, item.id, 'user-1', NOW);
    const vanish = (
      await buildReviewItems(
        db,
        [event({ id: 'evt-v', kind: 'vanished', before: program(), after: undefined })],
        new Map([[program().id, program()]]),
        'C',
        'qcwa',
      )
    )[0];
    approveReviewItem(db, vanish.id, 'user-1', NOW);
    expect(listProgramsBySource(db, 'qcwa')).toEqual([]);
  });

  it('refuses to act on an unknown item id', () => {
    expect(() => approveReviewItem(db, 'nope', 'user-1', NOW)).toThrow(/nope/);
    expect(() => rejectReviewItem(db, 'nope', 'user-1', NOW, 'x')).toThrow(/nope/);
  });
});

describe('listInbox', () => {
  it('returns everything by default and filters when asked', async () => {
    const item = (await buildReviewItems(db, [event()], new Map([[program().id, program()]]), 'C', 'qcwa'))[0];
    expect(listInbox(db)).toHaveLength(1);
    expect(listInbox(db, 'pending')).toHaveLength(1);
    approveReviewItem(db, item.id, 'user-1', NOW);
    expect(listInbox(db, 'pending')).toHaveLength(0);
    expect(listInbox(db, 'approved')).toHaveLength(1);
  });
});
