import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
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
});
