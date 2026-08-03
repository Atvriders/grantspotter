import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import {
  GRANTS_GOV_FETCH_URL,
  GRANTS_GOV_KEYWORDS,
  GRANTS_GOV_SEARCH_URL,
  buildFetchOpportunityRequest,
  buildSearchRequest,
  parseGrantsGovMoney,
  parseOpportunityDetail,
  parseSearchResponse,
  toRawOpportunity,
} from './grantsGov.js';

const search = () => loadFixture('grants-gov-federal', 'search2-response.json');
const detail = () => loadFixture('grants-gov-federal', 'fetch-opportunity-354102.json');

describe('endpoints', () => {
  it('uses the key-free search2 and fetchOpportunity endpoints', () => {
    expect(GRANTS_GOV_SEARCH_URL).toBe('https://api.grants.gov/v1/api/search2');
    expect(GRANTS_GOV_FETCH_URL).toBe('https://api.grants.gov/v1/api/fetchOpportunity');
  });

  it('never references an RSS feed — all four return HTML, not XML', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./grantsGov.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/GGRSS|rss.*\.xml/i);
    expect(src).toMatch(/text\/html/);
  });

  it('carries a keyword set aimed at the adjacent money, not just "amateur radio"', () => {
    expect(GRANTS_GOV_KEYWORDS).toContain('amateur radio');
    expect(GRANTS_GOV_KEYWORDS.join('|')).toMatch(/spectrum|wireless|geospace|STEM/i);
  });
});

describe('buildSearchRequest', () => {
  it('POSTs a JSON body with the keyword, paging and posted/forecasted statuses', () => {
    const req = buildSearchRequest('amateur radio', 25, 0);
    expect(req.method).toBe('POST');
    expect(req.accept).toBe('json');
    expect(req.url).toBe(GRANTS_GOV_SEARCH_URL);
    expect(req.body).toMatchObject({
      keyword: 'amateur radio',
      rows: 25,
      startRecordNum: 0,
      oppStatuses: 'posted|forecasted',
    });
  });
});

describe('buildFetchOpportunityRequest', () => {
  it('POSTs the numeric opportunityId', () => {
    const req = buildFetchOpportunityRequest('354102');
    expect(req.url).toBe(GRANTS_GOV_FETCH_URL);
    expect(req.body).toEqual({ opportunityId: 354102 });
  });
});

describe('parseGrantsGovMoney', () => {
  it('returns undefined for the literal string "none", which Grants.gov emits constantly', () => {
    expect(parseGrantsGovMoney('none')).toBeUndefined();
    expect(parseGrantsGovMoney('None')).toBeUndefined();
  });

  it('returns undefined for empty, null and junk — never NaN and never 0', () => {
    expect(parseGrantsGovMoney('')).toBeUndefined();
    expect(parseGrantsGovMoney(null)).toBeUndefined();
    expect(parseGrantsGovMoney(undefined)).toBeUndefined();
    expect(parseGrantsGovMoney('not a number')).toBeUndefined();
  });

  it('parses real figures with and without separators', () => {
    expect(parseGrantsGovMoney('500000')).toBe(500000);
    expect(parseGrantsGovMoney('$1,250,000')).toBe(1250000);
    expect(parseGrantsGovMoney(75000)).toBe(75000);
  });

  it('keeps a genuine zero as 0, distinct from "none"', () => {
    expect(parseGrantsGovMoney('0')).toBe(0);
  });
});

describe('parseSearchResponse', () => {
  it('reads every hit with its dates, agency and CFDA list', () => {
    const hits = parseSearchResponse(search());
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({
      id: '354102',
      number: 'NSF 26-512',
      title: 'Geospace Facilities',
      agencyCode: 'NSF',
      closeDate: '11/14/2026',
      oppStatus: 'posted',
    });
    expect(hits[0].cfdaList).toEqual(['47.050']);
  });

  it('returns [] for an error envelope rather than throwing mid-crawl', () => {
    expect(parseSearchResponse('{"errorcode":1,"msg":"bad request"}')).toEqual([]);
    expect(parseSearchResponse('not json')).toEqual([]);
  });

  it('returns [] when handed the HTML SPA shell the RSS feeds serve', () => {
    expect(parseSearchResponse('<!DOCTYPE html><html><div id="root"></div></html>')).toEqual([]);
  });
});

describe('parseOpportunityDetail', () => {
  const d = () => parseOpportunityDetail(detail());

  it('turns "none" ceilings and floors into undefined', () => {
    expect(d()?.awardCeiling).toBeUndefined();
    expect(d()?.awardFloor).toBeUndefined();
  });

  it('reads the structured applicant types', () => {
    expect(d()?.applicantTypes).toEqual(
      expect.arrayContaining(['Public and State controlled institutions of higher education']),
    );
  });

  it('reads lastUpdatedDate, which is the cheap change-detection lever', () => {
    expect(d()?.lastUpdatedDate).toBe('Jul 21, 2026');
  });

  it('strips HTML out of the synopsis description', () => {
    expect(d()?.description).not.toContain('<p>');
    expect(d()?.description).toContain('ionospheric');
  });

  it('returns undefined for an error envelope', () => {
    expect(parseOpportunityDetail('{"errorcode":1}')).toBeUndefined();
  });
});

describe('toRawOpportunity', () => {
  it('builds a RawOpportunity keyed on the Grants.gov opportunity id', () => {
    const hit = parseSearchResponse(search())[0];
    const raw = toRawOpportunity(hit, parseOpportunityDetail(detail()));
    expect(raw.sourceId).toBe('grants-gov-federal');
    expect(raw.externalKey).toBe('354102');
    expect(raw.name).toBe('Geospace Facilities');
    expect(raw.sourceUrl).toContain('354102');
    expect(raw.rawFields.agency).toBe('National Science Foundation');
    expect(raw.rawFields.closeDate).toBe('11/14/2026');
    expect(raw.rawFields.applicantTypes).toContain('higher education');
    expect(raw.rawText).toContain('ionospheric');
  });

  it('omits amountRaw entirely when the ceiling is "none" rather than writing $0', () => {
    const hit = parseSearchResponse(search())[0];
    const raw = toRawOpportunity(hit, parseOpportunityDetail(detail()));
    expect(raw.rawFields.amountRaw ?? '').not.toContain('0');
  });

  it('works with no detail at all', () => {
    const raw = toRawOpportunity(parseSearchResponse(search())[1]);
    expect(raw.externalKey).toBe('354199');
    expect(raw.rawText).toContain('Advanced Technological Education');
  });
});
