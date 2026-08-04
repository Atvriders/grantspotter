import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import {
  ardcGrants,
  chicagoFmScholarship,
  seedFixtureCorpus,
} from '../test/fixtures/programs.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import { reindexBrowse } from './reindex.js';

const NOW = '2026-08-02T12:00:00.000Z';

describe('reindexBrowse', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  it('projects every program into program_search', () => {
    const count = reindexBrowse(db, NOW);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM program_search').get() as { n: number };
    expect(count).toBe(5);
    expect(rows.n).toBe(5);
  });

  it('denormalizes the funder name so browse never joins at query time', () => {
    reindexBrowse(db, NOW);
    const row = db
      .prepare('SELECT funder_name FROM program_search WHERE program_id = ?')
      .get('ardc-grants') as { funder_name: string };
    expect(row.funder_name).toBe('Amateur Radio Digital Communications');
  });

  it('explodes applicantEntities into facet rows', () => {
    reindexBrowse(db, NOW);
    const facets = db
      .prepare(
        `SELECT facet_value FROM program_facets
          WHERE program_id = ? AND facet_kind = 'entity' ORDER BY facet_value`,
      )
      .all('ardc-grants') as Array<{ facet_value: string }>;
    expect(facets.map((f) => f.facet_value)).toEqual([
      'club_501c3',
      'club_via_fiscal_sponsor',
      'school_lea',
      'university',
      'university_dept',
    ]);
  });

  it('resolves the next close date for a program that inherits its deadline', () => {
    // QCWA rides the ARRL Foundation scholarship cycle: 111 catalog entries
    // share ONE deadline (spec §4.3). Its projection must carry a real date.
    reindexBrowse(db, NOW);
    const row = db
      .prepare('SELECT next_closes_at FROM program_search WHERE program_id = ?')
      .get('qcwa-memorial-scholarship') as { next_closes_at: string | null };
    expect(row.next_closes_at).toBe('2026-12-30T17:00:00.000Z');
  });

  it('is idempotent — reindexing twice does not duplicate facets', () => {
    reindexBrowse(db, NOW);
    reindexBrowse(db, NOW);
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM program_facets WHERE program_id = 'ardc-grants'`)
      .get() as { n: number };
    expect(n.n).toBe(5 + 2); // 5 entities + 2 tags
  });

  it('carries lastVerifiedAt through so the amber badge can be filtered on', () => {
    reindexBrowse(db, NOW);
    const row = db
      .prepare('SELECT last_verified_at FROM program_search WHERE program_id = ?')
      .get('chicago-fm-club-scholarship') as { last_verified_at: string };
    expect(row.last_verified_at).toBe('2026-01-05T00:00:00.000Z');
  });

  /**
   * `status: 'unknown'` renders as a real, labelled state and "a blank cell for
   * `status` is a bug" (plan Global Constraints). The corpus carries seven real
   * status values, not two, and the projection is where they would be flattened
   * into open/closed if anyone were tempted.
   */
  it('projects the real status of every program, including unknown and discontinued', () => {
    reindexBrowse(db, NOW);
    const rows = db
      .prepare('SELECT program_id, status FROM program_search ORDER BY program_id')
      .all() as Array<{ program_id: string; status: string }>;
    expect(Object.fromEntries(rows.map((r) => [r.program_id, r.status]))).toEqual({
      'ardc-grants': 'open',
      'arrl-club-grant': 'unknown',
      'arrl-foundation-scholarship': 'open',
      'chicago-fm-club-scholarship': 'discontinued',
      'qcwa-memorial-scholarship': 'open',
    });
  });

  it('lowercases the haystack so a free-text query never has to case-fold in SQL', () => {
    reindexBrowse(db, NOW);
    const hit = db
      .prepare(`SELECT program_id FROM program_search WHERE haystack LIKE '%fiscal sponsor%'`)
      .all() as Array<{ program_id: string }>;
    expect(hit.map((r) => r.program_id)).toEqual(['ardc-grants']);
  });

  it('projects a dormant program with no cycle rather than dropping it', () => {
    reindexBrowse(db, NOW);
    const row = db
      .prepare(
        `SELECT deadline_kind, next_opens_at, next_closes_at, next_is_estimated
           FROM program_search WHERE program_id = ?`,
      )
      .get(chicagoFmScholarship.id) as {
      deadline_kind: string;
      next_opens_at: string | null;
      next_closes_at: string | null;
      next_is_estimated: number;
    };
    expect(row).toEqual({
      deadline_kind: 'dormant',
      next_opens_at: null,
      next_closes_at: null,
      next_is_estimated: 0,
    });
  });

  /**
   * `cycles` holds both projected and funder-stated windows and the distinction
   * is meaningful to a user: "Sep 1 (estimated from a recurring rule)" is a
   * different claim from "Sep 30, the date the funder published". The
   * projection carries `next_is_estimated` precisely so the browse row can say
   * which one it is, so both halves need a test.
   */
  it('marks a deadline projected from a RECUR rule as estimated', () => {
    reindexBrowse(db, NOW);
    const row = db
      .prepare('SELECT next_closes_at, next_is_estimated FROM program_search WHERE program_id = ?')
      .get(ardcGrants.id) as { next_closes_at: string; next_is_estimated: number };
    // ARDC's four fixed dates, tz America/Los_Angeles: the next one after
    // 2026-08-02 is Sep 1, closing at 23:59 PDT.
    expect(row.next_closes_at).toBe('2026-09-02T06:59:00.000Z');
    expect(row.next_is_estimated).toBe(1);
  });

  it('keeps a window the funder actually published marked NOT estimated', () => {
    createFunderRepo(db).upsert({
      id: 'ariss',
      name: 'Amateur Radio on the International Space Station',
      homepage: 'https://www.ariss.org/',
    });
    createProgramRepo(db).upsert(observedWindowProgram());

    reindexBrowse(db, NOW);
    const row = db
      .prepare('SELECT next_opens_at, next_closes_at, next_is_estimated FROM program_search WHERE program_id = ?')
      .get('ariss-contact-window') as {
      next_opens_at: string | null;
      next_closes_at: string;
      next_is_estimated: number;
    };
    expect(row.next_opens_at).toBe('2026-09-01T00:00:00.000Z');
    expect(row.next_closes_at).toBe('2026-09-30T23:59:59.999Z');
    expect(row.next_is_estimated).toBe(0);
  });

  /**
   * 545 records in the real corpus are stored evidence, not opportunities: past
   * ARDC/NSF/USAspending awards and the 37 already-funded ARRL clubs. They are
   * kept on purpose (a funder's grant history is the best evidence of who it
   * funds) and must never surface as something to apply for. The rule is NOT
   * reimplemented here — `isDoNotPublish` is the single shared predicate, so
   * the projection cannot drift from `buildReviewItems` and the approve path.
   */
  it('never projects a do_not_publish record into the browse surface', () => {
    createProgramRepo(db).upsert(pastAwardProgram());
    expect(createProgramRepo(db).count()).toBe(6);

    const count = reindexBrowse(db, NOW);

    expect(count).toBe(5);
    const present = db
      .prepare('SELECT 1 FROM program_search WHERE program_id = ?')
      .get('ardc-past-award-2024');
    expect(present).toBeUndefined();
    const facets = db
      .prepare('SELECT 1 FROM program_facets WHERE program_id = ?')
      .all('ardc-past-award-2024');
    expect(facets).toEqual([]);
    // …and it is still STORED. Suppression hides it from browse, it does not
    // destroy the evidence.
    expect(createProgramRepo(db).get('ardc-past-award-2024')).toBeDefined();
  });
});

/**
 * A genuinely empty migrated database — nothing seeded, no hand-written INSERT.
 *
 * Plan 1's `programs.funder_id` is a real foreign key and `openDatabase` sets
 * `PRAGMA foreign_keys = ON`, so a fixture that writes programs without first
 * writing their funders fails on a fresh install and passes anywhere a previous
 * test happened to leave a `funders` row behind. That exact bug shipped once in
 * this repo — the first approve on a fresh install crashed — and it was hidden
 * because every test that touched it hand-wrote the parent INSERT.
 */
describe('reindexBrowse on a database that has only ever been migrated', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('starts with no funders and no programs — migrations seed neither', () => {
    expect(createFunderRepo(db).count()).toBe(0);
    expect(createProgramRepo(db).count()).toBe(0);
  });

  it('projects nothing, and does not throw, when there is nothing to project', () => {
    expect(reindexBrowse(db, NOW)).toBe(0);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM program_search').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('seeds its own funder parents, so the corpus loads with foreign keys ON', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    seedFixtureCorpus(db);
    expect(createFunderRepo(db).count()).toBe(4);
    expect(reindexBrowse(db, NOW)).toBe(5);
  });
});

/** A one-off window ARISS actually published: one dated window, no successor invented. */
function observedWindowProgram(): Program {
  return {
    id: 'ariss-contact-window',
    funderId: 'ariss',
    name: 'ARISS Contact Proposal Window',
    klass: 'adjacent_stem',
    summary: 'A single proposal window, with the dates the funder itself published.',
    applicantEntities: ['school_lea'],
    amount: { instrument: 'in_kind_service', amountRaw: 'Not applicable', awardCountRaw: 'Varies' },
    deadline: {
      kind: 'ad_hoc',
      source: { kind: 'self' },
      note:
        'Irregular windows announced by the funder. Application window published by the funder: ' +
        'opens 2026-09-01, closes 2026-09-30.',
    },
    applyVia: 'page_form',
    applyUrl: 'https://www.ariss.org/apply',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.ariss.org/apply',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      verificationMethod: 'live_fetch',
      contentHash: 'f1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    },
    rawOtherText: '',
    tags: ['adjacent'],
  };
}

/** Money already handed out. Stored as evidence; never an opportunity. */
function pastAwardProgram(): Program {
  return {
    ...ardcGrants,
    id: 'ardc-past-award-2024',
    name: 'ARDC 2024 award to a university club',
    summary: 'A grant that was already made in 2024. Evidence of who ARDC funds, not an opening.',
    trust: {
      ...ardcGrants.trust,
      status: 'closed',
      contentHash: '01b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    },
    tags: ['grant', 'ardc', 'past_award', DO_NOT_PUBLISH_TAG],
  };
}
