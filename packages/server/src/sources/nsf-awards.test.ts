import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { NSF_AWARDS_MAX_RPP, NSF_AWARDS_URL, buildNsfAwardsRequest, parseNsfAwards } from '../federal/nsf.js';
import { resolveRequests } from './types.js';
import { nsfAwards } from './nsf-awards.js';

const payload = () => fixturePayload('nsf-awards', 'awards-response.json', `${NSF_AWARDS_URL}?keyword=ionosphere`);

describe('buildNsfAwardsRequest', () => {
  it('asks for printFields explicitly — it works despite the docs', () => {
    const url = new URL(buildNsfAwardsRequest('ionosphere', 1).url);
    const fields = (url.searchParams.get('printFields') ?? '').split(',');
    expect(fields).toContain('abstractText');
    expect(fields).toContain('awardeeName');
    expect(fields).toContain('fundProgramName');
  });

  it('never requests more than 25 rows — rpp is hard-capped and silently truncates', () => {
    const url = new URL(buildNsfAwardsRequest('ionosphere', 1).url);
    expect(Number(url.searchParams.get('rpp'))).toBe(NSF_AWARDS_MAX_RPP);
    expect(NSF_AWARDS_MAX_RPP).toBe(25);
  });

  it('pages with a 1-based offset in steps of exactly 25', () => {
    expect(new URL(buildNsfAwardsRequest('x', 1).url).searchParams.get('offset')).toBe('1');
    expect(new URL(buildNsfAwardsRequest('x', 2).url).searchParams.get('offset')).toBe('26');
    expect(new URL(buildNsfAwardsRequest('x', 3).url).searchParams.get('offset')).toBe('51');
  });

  it('is a GET for JSON', () => {
    const req = buildNsfAwardsRequest('ionosphere', 1);
    expect(req.method).toBe('GET');
    expect(req.accept).toBe('json');
  });
});

describe('parseNsfAwards', () => {
  it('reads every printField back', () => {
    const items = parseNsfAwards(payload().body);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: '2334891', awardeeName: 'University of Example', fundProgramName: 'Aeronomy' });
    expect(items[0].abstractText).toMatch(/ionosonde/);
  });

  it('returns [] for junk rather than throwing', () => {
    expect(parseNsfAwards('not json')).toEqual([]);
    expect(parseNsfAwards('{"response":{}}')).toEqual([]);
  });
});

describe('nsfAwards module', () => {
  it('is Tier A adjacent_stem and issues one request per keyword', async () => {
    expect(nsfAwards.tier).toBe('A');
    expect(nsfAwards.klass).toBe('adjacent_stem');
    const requests = await resolveRequests(nsfAwards);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const r of requests) expect(r.url.startsWith(NSF_AWARDS_URL)).toBe(true);
  });

  it('keeps only the adjacent award and marks it a past award, never a live deadline', () => {
    const raws = nsfAwards.parse([payload()]);
    expect(raws.map((r) => r.externalKey)).toEqual(['2334891']);
    expect(raws[0].rawFields.recordType).toBe('past_award');
    expect(Number(raws[0].rawFields.adjacencyScore)).toBeGreaterThanOrEqual(6);
  });

  it('drops the protein-folding award', () => {
    expect(nsfAwards.parse([payload()]).map((r) => r.externalKey)).not.toContain('2210044');
  });

  it('deduplicates an award that matched more than one keyword', () => {
    expect(nsfAwards.parse([payload(), payload()])).toHaveLength(1);
  });

  it('returns [] with no payloads', () => {
    expect(nsfAwards.parse([])).toEqual([]);
  });
});
