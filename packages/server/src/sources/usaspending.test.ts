import { describe, expect, it } from 'vitest';
import { fixturePayload, hasFixture, loadFixture } from '../../test/fixtures.js';
import {
  USASPENDING_GRANT_TYPE_CODES,
  USASPENDING_SEARCH_URL,
  buildUsaSpendingRequest,
  parseUsaSpending,
} from '../federal/usaSpending.js';
import { resolveRequests } from './types.js';
import { usaSpending } from './usaspending.js';

const payload = () => fixturePayload('usaspending', 'spending-by-award.json', USASPENDING_SEARCH_URL);

describe('buildUsaSpendingRequest', () => {
  it('filters to grants and cooperative agreements, EXCLUDING contracts', () => {
    const body = buildUsaSpendingRequest('amateur radio', 1).body as {
      filters: { award_type_codes: string[] };
    };
    expect(body.filters.award_type_codes).toEqual(['02', '03', '04', '05']);
    expect(USASPENDING_GRANT_TYPE_CODES).toEqual(['02', '03', '04', '05']);
    // A, B, C, D are procurement contracts. A ham club cannot apply for a contract.
    for (const contractCode of ['A', 'B', 'C', 'D']) {
      expect(body.filters.award_type_codes).not.toContain(contractCode);
    }
  });

  it('is a POST for JSON and pages explicitly', () => {
    const req = buildUsaSpendingRequest('amateur radio', 3);
    expect(req.url).toBe(USASPENDING_SEARCH_URL);
    expect(req.method).toBe('POST');
    expect(req.accept).toBe('json');
    expect((req.body as { page: number }).page).toBe(3);
  });
});

describe('parseUsaSpending', () => {
  it('reads the award rows', () => {
    const rows = parseUsaSpending(payload().body);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ awardId: '2334891', amount: 412500 });
  });

  it('returns [] for junk rather than throwing', () => {
    expect(parseUsaSpending('not json')).toEqual([]);
    expect(parseUsaSpending('{"results":"nope"}')).toEqual([]);
  });
});

describe('usaSpending module', () => {
  it('is Tier A adjacent_stem', async () => {
    expect(usaSpending.tier).toBe('A');
    expect(usaSpending.klass).toBe('adjacent_stem');
    expect((await resolveRequests(usaSpending)).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the adjacent grant and drops the defence procurement line', () => {
    const raws = usaSpending.parse([payload()]);
    expect(raws.map((r) => r.externalKey)).toEqual(['2334891']);
  });

  it('marks every record a past award so it never renders as a live deadline', () => {
    for (const raw of usaSpending.parse([payload()])) {
      expect(raw.rawFields.recordType).toBe('past_award');
    }
  });

  it('carries the award amount verbatim for the reviewer', () => {
    expect(usaSpending.parse([payload()])[0].rawFields.amountRaw).toBe('$412,500');
  });

  it('links to the award search, not a minted /award/<FAIN>, when the API omits the permalink', () => {
    // The synthetic fixture predates generated_internal_id. A missing permalink must never be
    // papered over with the FAIN: /award/<FAIN> is a dead page that still answers 200.
    expect(usaSpending.parse([payload()])[0].sourceUrl).toBe('https://www.usaspending.gov/search');
  });
});

/**
 * The REAL API, captured 2026-08-03: four POSTs, all HTTP 200, `content-type: application/json`.
 */
describe('usaSpending against the real captured API responses', () => {
  const FILES = [
    '00-api-usaspending-gov-api-v2-search-spending-by-award.json',
    '01-api-usaspending-gov-api-v2-search-spending-by-award.json',
    '02-api-usaspending-gov-api-v2-search-spending-by-award.json',
    '03-api-usaspending-gov-api-v2-search-spending-by-award.json',
  ] as const;
  const captured = () => FILES.every((f) => hasFixture('usaspending', f));
  const payloads = () => FILES.map((f) => fixturePayload('usaspending', f, USASPENDING_SEARCH_URL));

  it.runIf(captured())('keeps 45 real awards after adjacency scoring', () => {
    const raws = usaSpending.parse(payloads());
    expect(raws).toHaveLength(45);
    expect(raws.length).toBeGreaterThanOrEqual(usaSpending.expectedMinRecords);
    expect(new Set(raws.map((r) => r.externalKey)).size).toBe(45);
  });

  it.runIf(captured())('reads two real awards exactly as USAspending returned them', () => {
    const raws = usaSpending.parse(payloads());

    const scranton = raws.find((r) => r.externalKey === '2045755');
    expect(scranton?.name).toBe(
      'National Science Foundation: CAREER: AMATEUR RADIO AS A TOOL FOR STUDYING TRAVELING IONOSPHERIC DISTURBANCES AND ATMOSPHERE-IONOSPHERE COUPLING',
    );
    expect(scranton?.sourceUrl).toBe('https://www.usaspending.gov/award/ASST_NON_2045755_049');
    expect(scranton?.rawFields.awardee).toBe('UNIVERSITY OF SCRANTON');
    expect(scranton?.rawFields.amountRaw).toBe('$715,457');
    expect(scranton?.rawFields.startDate).toBe('2021-06-01');
    expect(scranton?.rawFields.endDate).toBe('2026-05-31');
    expect(scranton?.rawFields.adjacencyHits).toBe('amateur radio, ionosphere, ionospheric');

    const eclipse = raws.find((r) => r.externalKey === '80NSSC23K1322');
    expect(eclipse?.sourceUrl).toBe(
      'https://www.usaspending.gov/award/ASST_NON_80NSSC23K1322_080',
    );
    expect(eclipse?.rawFields.amountRaw).toBe('$296,281');
    expect(eclipse?.rawFields.adjacencyHits).toBe('amateur radio, ionospheric');
  });

  it.runIf(captured())('addresses every real award by permalink id, never by FAIN', () => {
    // /award/<FAIN> 404s at the API while the SPA still renders 200: a link that looks fine and
    // goes nowhere. Every real sourceUrl must carry a generated_internal_id.
    for (const r of usaSpending.parse(payloads())) {
      expect(r.sourceUrl).toMatch(/^https:\/\/www\.usaspending\.gov\/award\/[A-Z]+_[A-Z]+_/);
      expect(r.sourceUrl).not.toBe(`https://www.usaspending.gov/award/${r.externalKey}`);
    }
  });

  it.runIf(captured())('stamps every real award past_award and dormant', () => {
    for (const r of usaSpending.parse(payloads())) {
      expect(r.rawFields.recordType).toBe('past_award');
      expect(r.rawFields.deadlineKind).toBe('dormant');
    }
  });

  it.runIf(captured())('drops the rail and aviation grants the broad keywords pull in', () => {
    // "radio spectrum" and "ground station" both top out at a commuter railroad and an Alaskan
    // air route by award size. Adjacency scoring, not the keyword, is what keeps them out.
    const raws = usaSpending.parse(payloads());
    const names = raws.map((r) => r.name).join('\n');
    expect(names).not.toMatch(/NORTHEAST ILLINOIS RAILROAD|NOME TO HOMER/i);
    for (const r of raws) expect(Number(r.rawFields.adjacencyScore)).toBeGreaterThanOrEqual(6);
  });

  it.runIf(captured())('gets a non-empty result set from every configured keyword', () => {
    // The defect this guards: "radio spectrum education" and "cubesat ground station" were
    // phrase-matched to zero rows, forever, behind a 200.
    for (const f of FILES) {
      const results = (JSON.parse(loadFixture('usaspending', f)) as { results: unknown[] }).results;
      expect(results.length).toBeGreaterThan(0);
    }
  });
});
