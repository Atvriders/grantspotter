import { afterEach, describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import {
  SIMPLER_GRANTS_SEARCH_URL,
  blendSimplerRelevance,
  parseSimplerResponse,
  simplerAuthHeaders,
  simplerSearchRequests,
} from './simplerGrants.js';

afterEach(() => {
  delete process.env.SIMPLER_GRANTS_API_KEY;
});

describe('the key is optional and never a hard dependency', () => {
  it('issues no request at all when SIMPLER_GRANTS_API_KEY is absent', () => {
    delete process.env.SIMPLER_GRANTS_API_KEY;
    expect(simplerSearchRequests(['amateur radio'])).toEqual([]);
    expect(simplerAuthHeaders()).toEqual({});
  });

  it('treats an empty or whitespace key as absent', () => {
    process.env.SIMPLER_GRANTS_API_KEY = '   ';
    expect(simplerSearchRequests(['amateur radio'])).toEqual([]);
  });

  it('issues one POST per keyword when the key is present', () => {
    process.env.SIMPLER_GRANTS_API_KEY = 'test-key';
    const requests = simplerSearchRequests(['amateur radio', 'cubesat']);
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.url).toBe(SIMPLER_GRANTS_SEARCH_URL);
      expect(r.method).toBe('POST');
      expect(r.accept).toBe('json');
    }
    expect(JSON.stringify(requests[0].body)).toContain('amateur radio');
  });

  it('supplies the X-Auth header by host, because FetchRequest has no header field', () => {
    process.env.SIMPLER_GRANTS_API_KEY = 'test-key';
    expect(simplerAuthHeaders()).toEqual({
      'api.simpler.grants.gov': { 'X-Auth': 'test-key' },
    });
  });
});

describe('parseSimplerResponse', () => {
  const body = () => loadFixture('grants-gov-federal', 'simpler-search-response.json');

  it('reads the opportunity number, title, agency, summary and relevancy', () => {
    const hits = parseSimplerResponse(body());
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      opportunityNumber: 'NSF 26-512',
      title: 'Geospace Facilities',
      agency: 'National Science Foundation',
      relevancy: 0.91,
    });
    expect(hits[0].summary).toMatch(/incoherent scatter radar/);
  });

  it('returns [] for junk instead of throwing — this path must never break a crawl', () => {
    expect(parseSimplerResponse('not json')).toEqual([]);
    expect(parseSimplerResponse('{}')).toEqual([]);
    expect(parseSimplerResponse('{"data":"nope"}')).toEqual([]);
  });
});

describe('blendSimplerRelevance', () => {
  const base = { score: 6, hits: ['ionospheric'] };

  it('is the identity when there is no Simpler hit — the deterministic score stands alone', () => {
    expect(blendSimplerRelevance(base, undefined)).toEqual(base);
  });

  it('lifts a highly-relevant record and names the reason', () => {
    const blended = blendSimplerRelevance(base, {
      opportunityNumber: 'NSF 26-512',
      title: 'Geospace Facilities',
      agency: 'NSF',
      summary: '',
      relevancy: 0.91,
    });
    expect(blended.score).toBeGreaterThan(base.score);
    expect(blended.hits).toContain('simpler:0.91');
  });

  it('never lowers the deterministic score, so the key cannot hide an opportunity', () => {
    const blended = blendSimplerRelevance(base, {
      opportunityNumber: 'X',
      title: 'X',
      agency: 'X',
      summary: '',
      relevancy: 0,
    });
    expect(blended.score).toBeGreaterThanOrEqual(base.score);
  });
});
