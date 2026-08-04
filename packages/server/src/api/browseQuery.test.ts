import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { arrlScholarship, seedFixtureCorpus } from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { reindexBrowse } from './reindex.js';
import { queryProgramIds, hydratePrograms } from './browseQuery.js';
import { DEFAULT_FILTERS, type BrowseFilters } from './browseTypes.js';

const NOW = '2026-08-02T12:00:00.000Z';

function filters(patch: Partial<BrowseFilters> = {}): BrowseFilters {
  return { ...DEFAULT_FILTERS, ...patch };
}

describe('queryProgramIds', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterAll(() => {
    db.close();
  });

  it('returns everything with no filters', () => {
    const { ids, total } = queryProgramIds(db, filters());
    expect(total).toBe(5);
    expect(ids).toHaveLength(5);
  });

  it('filters by opportunity class', () => {
    const { ids } = queryProgramIds(db, filters({ klass: ['ham_grant'] }));
    expect(ids.sort()).toEqual(['ardc-grants', 'arrl-club-grant']);
  });

  it('filters by applicant entity through the facet table', () => {
    const { ids } = queryProgramIds(db, filters({ entity: ['university'] }));
    expect(ids).toEqual(['ardc-grants']);
  });

  it('ORs multiple entities rather than ANDing them', () => {
    const { ids } = queryProgramIds(db, filters({ entity: ['university', 'individual'] }));
    expect(ids.sort()).toEqual([
      'ardc-grants',
      'arrl-foundation-scholarship',
      'chicago-fm-club-scholarship',
      'qcwa-memorial-scholarship',
    ]);
  });

  it('filters by instrument', () => {
    const { ids } = queryProgramIds(db, filters({ instrument: ['cash_fixed'] }));
    expect(ids).toEqual(['qcwa-memorial-scholarship']);
  });

  it('filters by status, including the real "unknown" state', () => {
    const { ids } = queryProgramIds(db, filters({ status: ['unknown'] }));
    expect(ids).toEqual(['arrl-club-grant']);
  });

  it('filters by an overlapping amount range', () => {
    // ARDC 1285-258000 and Club Grant 1000-25000 both straddle 20000.
    const { ids } = queryProgramIds(db, filters({ amountMin: 20000, amountMax: 30000 }));
    expect(ids.sort()).toEqual(['ardc-grants', 'arrl-club-grant', 'arrl-foundation-scholarship']);
  });

  it('drops rolling and undated programs when a deadline window is set', () => {
    const { ids } = queryProgramIds(
      db,
      filters({
        deadlineFrom: '2026-12-01T00:00:00.000Z',
        deadlineTo: '2027-01-15T00:00:00.000Z',
        includeRolling: false,
      }),
    );
    expect(ids.sort()).toEqual(['arrl-foundation-scholarship', 'qcwa-memorial-scholarship']);
  });

  it('keeps rolling and undated programs when includeRolling is true', () => {
    const { ids } = queryProgramIds(
      db,
      filters({
        deadlineFrom: '2026-12-01T00:00:00.000Z',
        deadlineTo: '2027-01-15T00:00:00.000Z',
        includeRolling: true,
      }),
    );
    expect(ids).toContain('arrl-club-grant'); // deadline_kind = 'unpublished'
  });

  /**
   * The false positive half of the `UNDATED_KINDS` deviation documented in browseQuery.ts.
   * QCWA is `kind: 'inherited'` — the kind the brief listed as undated — and it carries a real
   * 2026-12-30 close inherited from the ARRL Foundation window. `includeRolling` means "keep
   * programs with NO date", not "keep programs whose kind is usually undated", so a program that
   * HAS a date must still be judged on that date. Domain fact 5 makes this the corpus's largest
   * cohort: 111 catalog entries inherit that one deadline.
   */
  it('still applies the window to a dated program whose kind is usually undated', () => {
    const { ids } = queryProgramIds(
      db,
      filters({
        deadlineFrom: '2027-02-01T00:00:00.000Z',
        deadlineTo: '2027-03-01T00:00:00.000Z',
        includeRolling: true,
      }),
    );
    expect(ids).not.toContain('qcwa-memorial-scholarship');
    // …while the genuinely undated ones are still kept, which is what the flag asks for.
    expect(ids.sort()).toEqual(['arrl-club-grant', 'chicago-fm-club-scholarship']);
  });

  /**
   * The false negative half, and the more damaging one. A program whose kind is `annual_window`
   * but whose note is prose rather than core's `RECUR` micro-format projects no cycle at all, so
   * it is undated in fact while its kind says otherwise. Matching on the kind list dropped it
   * from a windowed search even with `includeRolling: true` — the flag that exists to keep it.
   */
  it('keeps a program that is undated in fact even when its kind says it should be dated', () => {
    const db2 = openTestDb();
    try {
      seedFixtureCorpus(db2);
      createProgramRepo(db2).upsert({
        ...arrlScholarship,
        id: 'prose-only-annual',
        name: 'Prose Only Annual Window',
        deadline: {
          kind: 'annual_window',
          source: { kind: 'self' },
          note: 'Applications are accepted each autumn; watch the club newsletter for the date.',
        },
      });
      reindexBrowse(db2, NOW);

      const projected = db2
        .prepare('SELECT deadline_kind, next_closes_at FROM program_search WHERE program_id = ?')
        .get('prose-only-annual');
      expect(projected).toEqual({ deadline_kind: 'annual_window', next_closes_at: null });

      const { ids } = queryProgramIds(
        db2,
        filters({
          deadlineFrom: '2026-12-01T00:00:00.000Z',
          deadlineTo: '2027-01-15T00:00:00.000Z',
          includeRolling: true,
        }),
      );
      expect(ids).toContain('prose-only-annual');
    } finally {
      db2.close();
    }
  });

  it('searches the haystack case-insensitively', () => {
    const { ids } = queryProgramIds(db, filters({ q: 'QUARTER CENTURY' }));
    expect(ids).toEqual(['qcwa-memorial-scholarship']);
  });

  it('escapes LIKE wildcards in the query string', () => {
    const { ids } = queryProgramIds(db, filters({ q: '100%' }));
    expect(ids).toEqual([]);
  });

  /**
   * DEVIATION FROM THE TASK BRIEF, and why (2026-08-03).
   *
   * The brief asserts `ids[0] === 'arrl-foundation-scholarship'` while giving, in the same brief,
   * an ORDER BY of `next_closes_at IS NULL ASC, next_closes_at ASC, name ASC` — soonest deadline
   * first. Those two cannot both be true. ARDC closes 2026-09-02T06:59:00.000Z (the date Task 2's
   * `reindex.test.ts` pins for its four fixed dates in America/Los_Angeles); the ARRL Foundation
   * window closes 2026-12-30T17:00:00.000Z. Sorting by deadline therefore leads with ARDC, and
   * `arrl-foundation-scholarship` is second.
   *
   * Resolved towards the SQL, because the SQL is the behaviour being specified and it is the
   * correct behaviour: a deadline sort that did not lead with the soonest deadline would be the
   * bug. The whole order is asserted rather than just the ends, so a future change to the sort
   * cannot pass by accident — including the name tiebreak between the two 2026-12-30 programs,
   * which is the only reason their relative order is defined at all.
   */
  it('sorts by deadline with undated programs last', () => {
    const { ids } = queryProgramIds(db, filters({ sort: 'deadline' }));
    expect(ids).toEqual([
      'ardc-grants', // 2026-09-02
      'arrl-foundation-scholarship', // 2026-12-30, tied with QCWA, wins on name
      'qcwa-memorial-scholarship', // 2026-12-30, inherited from the row above
      'arrl-club-grant', // undated: kind 'unpublished'
      'chicago-fm-club-scholarship', // undated: kind 'dormant'
    ]);
    expect(ids.at(-1)).toBe('chicago-fm-club-scholarship');
  });

  it('sorts by amount descending', () => {
    const { ids } = queryProgramIds(db, filters({ sort: 'amount_desc' }));
    expect(ids[0]).toBe('ardc-grants');
  });

  it('paginates and still reports the unpaginated total', () => {
    const { ids, total } = queryProgramIds(db, filters({ sort: 'name', page: 2, pageSize: 2 }));
    expect(total).toBe(5);
    expect(ids).toHaveLength(2);
  });
});

describe('hydratePrograms', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterAll(() => {
    db.close();
  });

  it('returns full Program objects keyed by id, with the projection dates', () => {
    const map = hydratePrograms(db, ['qcwa-memorial-scholarship']);
    const hit = map.get('qcwa-memorial-scholarship');
    expect(hit?.program.name).toBe('QCWA Memorial Scholarship Fund');
    expect(hit?.funderName).toBe('Quarter Century Wireless Association');
    expect(hit?.nextClosesAt).toBe('2026-12-30T17:00:00.000Z');
    // The frame that instant is a wall time in (migration 037). Without it the row cannot be
    // rendered as a calendar day at all — see `deadlineRendering.test.ts` for the rendered days.
    expect(hit?.nextTimezone).toBe('America/New_York');
    expect(hit?.program.trust.disputed).toBeUndefined();
  });

  it('returns an empty map for an empty id list without issuing a query', () => {
    expect(hydratePrograms(db, []).size).toBe(0);
  });
});
