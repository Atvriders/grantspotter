import { afterEach, describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { GRANTS_GOV_SEARCH_URL } from '../federal/grantsGov.js';
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
