/**
 * THE SELECTION, AS A UNIT: what a query string means, and which records come back.
 *
 * `parityWithBrowse.test.ts` proves the thing that matters — the file and the screen agree — over
 * the real corpus through both routers. This proves the pieces that a corpus-scale equality would
 * be a slow and indirect way to state: the query vocabulary (including the retired spellings that
 * still arrive in bookmarked URLs), the gate that runs on whatever the projection hands back, and
 * the verdict rule for a user who has no profile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Profile } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { ardcGrants, seedFixtureCorpus, seedTestUser } from '../test/fixtures/programs.js';
import { createProgramRepo, withContentHash } from '../db/repositories/programs.js';
import { reindexBrowse } from '../api/reindex.js';
import { DEFAULT_FILTERS } from '../api/browseTypes.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import { parseExportQuery, selectExportPrograms } from './selection.js';

const NOW = '2026-08-02T12:00:00.000Z';

const STUDENT: Profile = {
  kind: 'student',
  callsign: 'W8UM',
  licenseClass: 'GENERAL',
  licensedSince: '2023-05-01',
  state: 'MI',
  degreeLevel: 'BACH',
  institution: 'Example State University',
  accredited: true,
  partTime: false,
  citizenship: 'US_CITIZEN',
  stage: 'UNDERGRAD',
} as Profile;

let db: Database.Database;

const select = (query: Record<string, unknown>, profile?: Profile): string[] =>
  selectExportPrograms(db, parseExportQuery(query), { profile, nowISO: NOW }).map((p) => p.id);

beforeAll(() => {
  db = openTestDb();
  seedFixtureCorpus(db);
  seedTestUser(db, 'u-member');
  reindexBrowse(db, NOW);
});

afterAll(() => {
  db.close();
});

describe('parseExportQuery', () => {
  it('reads the browse screen’s own query string, dropping values this build does not offer', () => {
    const filters = parseExportQuery({ klass: 'ham_grant,not_a_class', amountMin: '5000' });
    expect(filters.klass).toEqual(['ham_grant']);
    expect(filters.amountMin).toBe(5000);
  });

  it('keeps the rolling default that the export used to have no spelling for at all', () => {
    // The measured defect: 139 on screen, 117 in the file, with the checkbox in its default
    // state. `includeRolling` is true unless the string 'false' says otherwise.
    expect(parseExportQuery({}).includeRolling).toBe(true);
    expect(parseExportQuery({ includeRolling: 'false' }).includeRolling).toBe(false);
  });

  it('maps the retired export spellings onto the browse keys they always meant', () => {
    const filters = parseExportQuery({
      closesAfter: '2026-09-01',
      closesBefore: '2026-12-31',
      applicantEntities: 'club_501c3',
    });
    expect(filters.deadlineFrom).toBe('2026-09-01');
    expect(filters.deadlineTo).toBe('2026-12-31');
    expect(filters.entity).toEqual(['club_501c3']);
  });

  it('never lets a legacy spelling override the browse key beside it', () => {
    expect(
      parseExportQuery({ deadlineFrom: '2026-09-01', closesAfter: '2000-01-01' }).deadlineFrom,
    ).toBe('2026-09-01');
  });

  it('ignores a key the browse screen has no filter for', () => {
    // `tags` was an ExportFilter-only axis. Dropping it can only narrow nothing and widen nothing:
    // the suppression gate is not a filter option, so nothing was reachable through it either way.
    expect(parseExportQuery({ tags: DO_NOT_PUBLISH_TAG })).toEqual({
      ...DEFAULT_FILTERS,
      deadlineFrom: undefined,
      deadlineTo: undefined,
      amountMin: undefined,
      amountMax: undefined,
      q: undefined,
    });
  });
});

describe('selectExportPrograms', () => {
  it('returns the publishable corpus for an empty query', () => {
    expect(select({}).length).toBe(5);
  });

  it('applies the filters the browse projection indexes', () => {
    expect(select({ klass: 'ham_scholarship' }).length).toBeGreaterThan(0);
    expect(select({ klass: 'ham_scholarship' })).not.toContain(ardcGrants.id);
    expect(select({ q: 'ardc' })).toContain(ardcGrants.id);
    expect(select({ q: 'ardc' }).length).toBeLessThan(5);
  });

  /**
   * THE GATE, ON THE PATH THE SELECTION TAKES. `reindexBrowse` refuses to project a suppressed
   * record, so the hazard is not a fresh one — it is a record reclassified AFTER its projection row
   * was written, which is the state a live database is in between the reclassification and the
   * next reindex. The export reads that row and must still refuse the record.
   */
  describe('a record reclassified after it was projected', () => {
    const suppressed = { ...ardcGrants, tags: [...ardcGrants.tags, DO_NOT_PUBLISH_TAG] };

    beforeAll(() => {
      createProgramRepo(db).upsert(withContentHash(suppressed));
    });

    afterAll(() => {
      createProgramRepo(db).upsert(withContentHash(ardcGrants));
    });

    it('is still projected, which is what makes this a real hazard rather than a hypothetical', () => {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM program_search WHERE program_id = ?')
        .get(ardcGrants.id) as { n: number };
      expect(row.n).toBe(1);
    });

    it('is dropped from an unfiltered export', () => {
      expect(select({})).not.toContain(ardcGrants.id);
      expect(select({}).length).toBe(4);
    });

    it('cannot be talked back in by a search that matches only it', () => {
      expect(select({ q: ardcGrants.id })).toEqual([]);
    });

    it('cannot be talked back in by naming its suppression tag', () => {
      expect(select({ tags: DO_NOT_PUBLISH_TAG })).not.toContain(ardcGrants.id);
      expect(select({ q: DO_NOT_PUBLISH_TAG })).toEqual([]);
    });
  });

  /**
   * The verdict is the one filter whose answer depends on who is asking, so it is the one whose
   * absent-profile case has to be decided rather than defaulted. An empty file is the honest
   * answer; the whole corpus under an "Eligible" heading is not.
   */
  describe('the matcher verdict', () => {
    it('selects nothing at all when there is no profile to match against', () => {
      expect(select({ verdict: 'eligible' })).toEqual([]);
      expect(select({ verdict: 'eligible,ineligible,unknown,eligible_preferred' })).toEqual([]);
    });

    it('leaves every other filter alone when no verdict was asked for', () => {
      expect(select({}, undefined).length).toBe(5);
    });

    it('partitions the corpus for a user who has one', () => {
      const kinds = ['eligible', 'eligible_preferred', 'ineligible', 'unknown'];
      const selected = kinds.flatMap((kind) => select({ verdict: kind }, STUDENT));
      // Every programme lands in exactly one verdict bucket, and the buckets add up to the corpus.
      expect(selected.length).toBe(5);
      expect(new Set(selected).size).toBe(5);
    });
  });
});
