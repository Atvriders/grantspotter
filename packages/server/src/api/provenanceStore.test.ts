import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { RawOpportunity } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus } from '../test/fixtures/programs.js';
import { fixturePayload } from '../../test/fixtures.js';
import { parseScholarshipCatalog } from '../sources/arrl-scholarship-descriptions.js';
import { fieldPathForLabel, recordProvenance, loadProvenance } from './provenanceStore.js';

const NOW = '2026-08-02T12:00:00.000Z';

/**
 * A RawOpportunity as the ARRL scholarship parser emits it. The label typos are
 * real - `R egion` and `License   Requirement` were observed in the live page,
 * which is why the parser matches by label regex over flattened text.
 */
const raw: RawOpportunity = {
  sourceId: 'arrl-scholarship-descriptions',
  externalKey: 'ARRL Foundation Scholarship Program',
  name: 'ARRL Foundation Scholarship Program',
  rawFields: {
    'Award Amount': '$500 - $25,000',
    'License Requirement': 'Any class of FCC amateur radio license',
    'R egion': 'Any',
    'Number of Awards': '170+',
  },
  sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
  rawText: 'Award Amount: $500 - $25,000 • License Requirement: Any class ...',
};

describe('fieldPathForLabel', () => {
  /**
   * DEVIATION FROM THE TASK BRIEF (2026-08-03), found by running the brief's map
   * against the real captured ARRL catalog rather than against its own fixture.
   * The parser emits `applyUrl` for 14 of the shipped sources and
   * `normalize/index.ts` reads it as the apply address; under the brief's
   * eighteen-label map it normalized to no entry and landed in `rawOtherText`,
   * so the ONE field the ingestion remediation was about — 76% of records once
   * carried an apply url their own page contradicted, and 345 ARDC awards
   * pointed applicants at a grant recipient's Facebook page — was the one the
   * provenance panel would have mislabelled as prose.
   */
  it('files the apply address under applyUrl, not under rawOtherText', () => {
    expect(fieldPathForLabel('applyUrl')).toBe('applyUrl');
    expect(fieldPathForLabel('formUrl')).toBe('applyUrl');
    expect(fieldPathForLabel('detailUrl')).toBe('applyUrl');
  });

  it('maps the vocabulary the shipped sources actually emit', () => {
    expect(fieldPathForLabel('amountRaw')).toBe('amount.amountRaw');
    expect(fieldPathForLabel('applyNote')).toBe('applyContact');
    expect(fieldPathForLabel('restrictions')).toBe('fundingRestrictions');
    expect(fieldPathForLabel('sustainment')).toBe('obligations');
    expect(fieldPathForLabel('closesAt')).toBe('deadline.note');
    expect(fieldPathForLabel('applicantTypes')).toBe('applicantEntities');
  });

  /**
   * `recordType` is OUR classification of a page, not a sentence on it. Filing
   * it under `rawOtherText` would print this pipeline's own words in the place
   * reserved for the funder's.
   */
  it('keeps this pipeline\'s own bookkeeping out of the funder\'s field paths', () => {
    expect(fieldPathForLabel('recordType')).toBe('internal.recordtype');
    expect(fieldPathForLabel('adjacencyScore')).toBe('internal.adjacencyscore');
    expect(fieldPathForLabel('whyManual')).toBe('internal.whymanual');
  });
});

describe('recordProvenance', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  it('stores one row per raw field, verbatim', () => {
    const n = recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-1', raw, NOW);
    expect(n).toBe(4);
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    const region = rows.find((r) => r.rawLabel === 'R egion');
    expect(region?.rawValue).toBe('Any');
    expect(region?.snapshotId).toBe('snap-1');
    expect(region?.fetchedAt).toBe(NOW);
  });

  it('maps known raw labels onto the Program field path they populated', () => {
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-1', raw, NOW);
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    const amount = rows.find((r) => r.rawLabel === 'Award Amount');
    expect(amount?.fieldPath).toBe('amount.amountRaw');
  });

  it('normalizes the typo\'d ARRL labels seen in the wild onto the same field path', () => {
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-1', raw, NOW);
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    expect(rows.find((r) => r.rawLabel === 'R egion')?.fieldPath).toBe('constraints.geography');
    expect(rows.find((r) => r.rawLabel === 'License Requirement')?.fieldPath)
      .toBe('constraints.license');
  });

  it('falls back to a rawFields path for a label it does not recognise', () => {
    const odd: RawOpportunity = { ...raw, rawFields: { 'Ham Family Preference': 'Yes' } };
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', null, odd, NOW);
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    expect(rows[0]?.fieldPath).toBe('rawOtherText');
  });

  it('replaces the previous provenance for the same source instead of appending', () => {
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-1', raw, NOW);
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-2', raw, '2026-09-01T00:00:00.000Z');
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.snapshotId === 'snap-2')).toBe(true);
  });

  /**
   * DEVIATION FROM THE TASK BRIEF (2026-08-03), and the reason the table has an
   * eighth column. The brief takes a whole `RawOpportunity` — whose `sourceUrl`
   * IS the page the parser read the value off — and stores everything but that.
   * A row would then say "Award Amount = $500 - $25,000, source
   * arrl-scholarship-descriptions" with no address a reader could open.
   *
   * `snapshotId` does not close the gap. It is nullable by the brief's own
   * design, the brief's fourth test passes `null` deliberately, and Task 10 —
   * the ONLY production caller of `recordProvenance` in this plan — passes
   * `null` on every single verify (`recordProvenance(db, programId, source.id,
   * null, match, attemptedAt)`). So on the write path that actually runs, a
   * url-less row is not the exception, it is every row.
   *
   * This is the exact failure class the ingestion remediation was about: 76% of
   * records once advertised an apply url their own page contradicted, and 345
   * ARDC awards pointed applicants at a recipient's Facebook page. The answer to
   * that is a value a professional can trace back to a captured page, so the
   * page's address travels with the value.
   */
  it('records the url of the page the value was read off, so a reader can check it', () => {
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-1', raw, NOW);
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    expect(rows).not.toHaveLength(0);
    for (const row of rows) {
      expect(row.sourceUrl).toBe('http://www.arrl.org/scholarship-descriptions');
    }
  });

  /**
   * The end-to-end claim, against the real committed capture rather than a
   * hand-written fixture: parse the ARRL page bytes in `fixtures/`, record what
   * the parser read, and assert every stored value is findable in those bytes.
   *
   * A hand-written fixture is what let a "must remain on the air for 12 months"
   * obligation ship while appearing zero times in the funder's 145 KB page, so
   * the provenance story is tested against the capture, not against a story
   * about the capture.
   */
  it('stores only values that occur in the captured page bytes', () => {
    const payload = fixturePayload(
      'arrl-scholarship-descriptions',
      '00-www-arrl-org-scholarship-descriptions.html',
      'http://www.arrl.org/scholarship-descriptions',
    );
    const parsed = parseScholarshipCatalog(payload.body, payload.url).entries;
    expect(parsed.length).toBeGreaterThan(100);

    // Text values survive tag-stripping; url values live inside an href, so the
    // raw bytes are checked too. A value must be findable in one or the other.
    const flattened = payload.body
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
    const collapsedBody = payload.body.replace(/\s+/g, ' ');
    const inPage = (value: string) => {
      // The parser joins a multi-line field with newlines, so both sides get the
      // same whitespace collapse; nothing else about the value is touched.
      const v = value.replace(/\s+/g, ' ').trim();
      return flattened.includes(v) || collapsedBody.includes(v);
    };

    let checked = 0;
    for (const entry of parsed.slice(0, 20)) {
      recordProvenance(db, 'arrl-foundation-scholarship', entry.sourceId, null, entry, NOW);
      const rows = loadProvenance(db, 'arrl-foundation-scholarship');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.sourceUrl).toBe('http://www.arrl.org/scholarship-descriptions');
        // `internal.*` is this pipeline's own classification, not a reading of
        // the page; everything else claims to be the funder's own words and so
        // must actually occur in the funder's own bytes.
        if (row.fieldPath.startsWith('internal.')) continue;
        expect(
          inPage(row.rawValue),
          `"${row.rawLabel}" = "${row.rawValue}" does not occur in the captured page`,
        ).toBe(true);
        checked += 1;
      }
    }
    // Vacuity guard: a loop that checked nothing would pass every assertion above.
    expect(checked).toBeGreaterThan(60);
  });
});
