import { afterEach, describe, expect, it } from 'vitest';
import { fixturePayload, hasFixture, loadFixture } from '../../test/fixtures.js';
import { GRANTS_GOV_SEARCH_URL, parseSearchResponse } from '../federal/grantsGov.js';
import { SIMPLER_GRANTS_SEARCH_URL } from '../federal/simplerGrants.js';
import { resolveRequests } from './types.js';
import { grantsGovFederal } from './grants-gov-federal.js';

const searchPayload = () =>
  fixturePayload('grants-gov-federal', 'search2-response.json', GRANTS_GOV_SEARCH_URL);
const detailPayload = () =>
  fixturePayload(
    'grants-gov-federal',
    'fetch-opportunity-354102.json',
    'https://api.grants.gov/v1/api/fetchOpportunity#354102',
  );

describe('grantsGovFederal module shape', () => {
  it('is Tier A, adjacent_stem, and issues one search per keyword', async () => {
    delete process.env.SIMPLER_GRANTS_API_KEY; // the search2-only baseline
    expect(grantsGovFederal.tier).toBe('A');
    expect(grantsGovFederal.klass).toBe('adjacent_stem');
    // `requests` is a function (the optional Simpler leg is decided at resolve time), so it is
    // resolved rather than read as an array.
    const requests = await resolveRequests(grantsGovFederal);
    expect(requests.length).toBeGreaterThanOrEqual(5);
    for (const r of requests) {
      expect(r.url).toBe(GRANTS_GOV_SEARCH_URL);
      expect(r.method).toBe('POST');
    }
  });

  it('warns in notes about the four HTML-serving RSS feeds', () => {
    expect(grantsGovFederal.notes).toMatch(/RSS/);
    expect(grantsGovFederal.notes).toMatch(/text\/html/);
    expect(grantsGovFederal.notes).toMatch(/never errors/i);
  });
});

describe('followUp', () => {
  it('hydrates only the hits that clear the adjacency threshold', () => {
    const requests = grantsGovFederal.followUp([searchPayload()]);
    const ids = requests.map((r) => (r.body as { opportunityId: number }).opportunityId);
    expect(ids).toContain(354102); // Geospace Facilities
    expect(ids).toContain(354199); // Advanced Technological Education
    expect(ids).not.toContain(351020); // Radiation Oncology
  });

  it('caps the nightly detail fetches so a broad keyword cannot become a 250-request crawl', () => {
    const many = {
      ...searchPayload(),
      body: JSON.stringify({
        errorcode: 0,
        data: {
          hitCount: 60,
          oppHits: Array.from({ length: 60 }, (_, i) => ({
            id: String(400000 + i),
            number: `N-${i}`,
            title: 'Amateur radio ionospheric STEM education',
            agency: 'NSF',
            agencyCode: 'NSF',
            openDate: '',
            closeDate: '',
            oppStatus: 'posted',
            docType: 'synopsis',
            cfdaList: [],
          })),
        },
      }),
    };
    expect(grantsGovFederal.followUp([many]).length).toBeLessThanOrEqual(25);
  });

  it('returns [] when the search payload is missing or errored', () => {
    expect(grantsGovFederal.followUp([])).toEqual([]);
    expect(
      grantsGovFederal.followUp([{ ...searchPayload(), body: '{"errorcode":1}' }]),
    ).toEqual([]);
  });

  it('deduplicates ids that appear under more than one keyword', () => {
    const requests = grantsGovFederal.followUp([searchPayload(), searchPayload()]);
    const ids = requests.map((r) => (r.body as { opportunityId: number }).opportunityId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parse', () => {
  it('emits only adjacent records and stamps the score and hits for the reviewer', () => {
    const raws = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    const geospace = raws.find((r) => r.externalKey === '354102');
    expect(geospace).toBeDefined();
    expect(Number(geospace?.rawFields.adjacencyScore)).toBeGreaterThanOrEqual(6);
    expect(geospace?.rawFields.adjacencyHits).toMatch(/ionospheric|geospace/);
  });

  it('drops the radiology hit even though it reached the parse stage', () => {
    const raws = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    expect(raws.map((r) => r.externalKey)).not.toContain('351020');
  });

  it('re-scores using the hydrated description, which is far richer than the title', () => {
    const withDetail = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    const withoutDetail = grantsGovFederal.parse([searchPayload()]);
    const a = withDetail.find((r) => r.externalKey === '354102');
    const b = withoutDetail.find((r) => r.externalKey === '354102');
    expect(Number(a?.rawFields.adjacencyScore)).toBeGreaterThan(Number(b?.rawFields.adjacencyScore ?? 0));
  });

  it('returns [] when there is no search payload', () => {
    expect(grantsGovFederal.parse([])).toEqual([]);
  });
});

describe('Simpler.Grants.gov is optional (spec §7.5)', () => {
  const simplerPayload = () =>
    fixturePayload('grants-gov-federal', 'simpler-search-response.json', SIMPLER_GRANTS_SEARCH_URL);

  afterEach(() => {
    delete process.env.SIMPLER_GRANTS_API_KEY;
  });

  it('without a key: search2 only, and every federal record is still found', async () => {
    delete process.env.SIMPLER_GRANTS_API_KEY;
    const requests = await resolveRequests(grantsGovFederal);
    expect(requests.every((r) => r.url === GRANTS_GOV_SEARCH_URL)).toBe(true);
    const raws = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    expect(raws.map((r) => r.externalKey)).toContain('354102');
  });

  it('with a key: Simpler searches are added and relevance is blended, not gated', async () => {
    process.env.SIMPLER_GRANTS_API_KEY = 'test-key';
    const requests = await resolveRequests(grantsGovFederal);
    expect(requests.some((r) => r.url === SIMPLER_GRANTS_SEARCH_URL)).toBe(true);

    const withoutSimpler = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    const withSimpler = grantsGovFederal.parse([searchPayload(), detailPayload(), simplerPayload()]);
    // Same records either way — the key changes ranking, never membership.
    expect(withSimpler.map((r) => r.externalKey).sort()).toEqual(
      withoutSimpler.map((r) => r.externalKey).sort(),
    );
    const a = withSimpler.find((r) => r.externalKey === '354102');
    const b = withoutSimpler.find((r) => r.externalKey === '354102');
    expect(Number(a?.rawFields.adjacencyScore)).toBeGreaterThan(Number(b?.rawFields.adjacencyScore));
    expect(a?.rawFields.adjacencyHits).toContain('simpler:');
  });
});

/**
 * The REAL search2 + fetchOpportunity API, captured 2026-08-03: five POST searches and the one
 * follow-up detail fetch they earned, all HTTP 200, `content-type: application/json`.
 *
 * This is also the standing evidence for the RSS warning in `notes`: search2 answers with real
 * JSON, while all four advertised Grants.gov feeds answer 200 with an HTML SPA shell.
 */
describe('grantsGovFederal against the real captured API responses', () => {
  const SEARCH_FILES = [
    '00-api-grants-gov-v1-api-search2.json',
    '01-api-grants-gov-v1-api-search2.json',
    '02-api-grants-gov-v1-api-search2.json',
    '03-api-grants-gov-v1-api-search2.json',
    '04-api-grants-gov-v1-api-search2.json',
  ] as const;
  const DETAIL_FILE = '05-api-grants-gov-v1-api-fetchopportunity.json';
  const captured = () =>
    SEARCH_FILES.every((f) => hasFixture('grants-gov-federal', f)) &&
    hasFixture('grants-gov-federal', DETAIL_FILE);
  const searches = () =>
    SEARCH_FILES.map((f) => fixturePayload('grants-gov-federal', f, GRANTS_GOV_SEARCH_URL));
  const detail = () =>
    fixturePayload(
      'grants-gov-federal',
      DETAIL_FILE,
      'https://api.grants.gov/v1/api/fetchOpportunity',
    );

  it.runIf(captured())('reads 128 distinct real hits across the five keyword searches', () => {
    const ids = new Set<string>();
    for (const f of SEARCH_FILES) {
      const hits = parseSearchResponse(loadFixture('grants-gov-federal', f));
      expect(hits).toHaveLength(50); // rows: 50, and every keyword filled the page
      for (const h of hits) ids.add(h.id);
    }
    expect(ids.size).toBe(128);
  });

  it.runIf(captured())('decodes HTML entities out of real hit titles', () => {
    // 8 of the 128 real titles carry entities. Undecoded, the reviewer reads "&ndash;".
    const titles = SEARCH_FILES.flatMap((f) =>
      parseSearchResponse(loadFixture('grants-gov-federal', f)).map((h) => h.title),
    );
    for (const t of titles) expect(t).not.toMatch(/&(?:[a-z]+|#\d+);/i);
    expect(titles).toContain(
      'Public Wireless Supply Chain Innovation Fund Grant Program – Solutions for AI-Native RAN',
    );
    expect(titles).toContain(
      'Boosting Innovative GEOINT - Science & Technology Broad Agency Announcement (BIG-ST BAA)',
    );
    expect(titles).toContain(
      "Improving global health security in Côte d'Ivoire to stop the spread of infectious disease",
    );
  });

  it.runIf(captured())('hydrates exactly one of the 128 real hits', () => {
    // Honest yield: the federal sweep is meant to surface 10-30 relevant opportunities A YEAR.
    const followUps = grantsGovFederal.followUp(searches());
    expect(followUps).toHaveLength(1);
    expect((followUps[0].body as { opportunityId: number }).opportunityId).toBe(363179);
  });

  it.runIf(captured())('emits the one real open opportunity, read exactly as published', () => {
    const raws = grantsGovFederal.parse([...searches(), detail()]);
    expect(raws).toHaveLength(1);
    const ntia = raws[0];
    expect(ntia.externalKey).toBe('363179');
    expect(ntia.name).toBe(
      'Public Wireless Supply Chain Innovation Fund Grant Program – Solutions for AI-Native RAN',
    );
    expect(ntia.sourceUrl).toBe('https://www.grants.gov/search-results-detail/363179');
    expect(ntia.rawFields.opportunityNumber).toBe('NTIA-PWSCIF-26-01');
    expect(ntia.rawFields.agencyCode).toBe('DOC-NTIA');
    expect(ntia.rawFields.oppStatus).toBe('posted');
    expect(ntia.rawFields.openDate).toBe('07/14/2026');
    expect(ntia.rawFields.closeDate).toBe('09/09/2026');
    expect(ntia.rawFields.responseDate).toBe('Sep 09, 2026 12:00:00 AM EDT');
    expect(ntia.rawFields.cfda).toBe('11.038');
    expect(ntia.rawFields.adjacencyScore).toBe('6');
    expect(ntia.rawFields.adjacencyHits).toBe(
      'Public Wireless Supply Chain Innovation Fund, PWSCIF',
    );
    // "none" award ceilings must not become "$0": this real record has no figure at all.
    expect(ntia.rawFields.amountRaw).toBeUndefined();
  });

  it.runIf(captured())('would emit nothing without the halved follow-up threshold', () => {
    // The only real record scores 3 on title+agency and only reaches 6 — exactly the threshold
    // — once the synopsis is hydrated. Raising FOLLOWUP_THRESHOLD to ADJACENCY_THRESHOLD would
    // silently take this source to zero records a year.
    expect(grantsGovFederal.parse(searches())).toHaveLength(0);
    expect(grantsGovFederal.parse([...searches(), detail()])).toHaveLength(1);
  });

  it.runIf(captured())('leaves the real open opportunity publishable, unlike the award sources', () => {
    const raws = grantsGovFederal.parse([...searches(), detail()]);
    expect(raws[0].rawFields.recordType).toBeUndefined();
    expect(raws[0].rawFields.deadlineKind).toBeUndefined();
  });
});
