import { describe, expect, it } from 'vitest';
import { fixturePayload, hasFixture, loadFixture } from '../../test/fixtures.js';
import { NSF_AWARDS_MAX_RPP, NSF_AWARDS_URL, buildNsfAwardsRequest, parseNsfAwards } from '../federal/nsf.js';
import { resolveRequests } from './types.js';
import { nsfAwards } from './nsf-awards.js';

const payload = () => fixturePayload('nsf-awards', 'awards-response.json', `${NSF_AWARDS_URL}?keyword=ionosphere`);

describe('buildNsfAwardsRequest', () => {
  // Re-measured against the live API 2026-08-03: printFields no longer restricts anything (the
  // response carries all 61 fields with or without it, abstractText included). It is sent as a
  // statement of what this source actually needs, not because the API honours it.
  it('still names the fields it depends on, even though the API now ignores printFields', () => {
    const url = new URL(buildNsfAwardsRequest('ionosphere', 1).url);
    const fields = (url.searchParams.get('printFields') ?? '').split(',');
    expect(fields).toContain('abstractText');
    expect(fields).toContain('awardeeName');
    expect(fields).toContain('fundProgramName');
  });

  // Also re-measured 2026-08-03: rpp=100 returns 100 awards, so this is a deliberate
  // request-size choice that under-collects, NOT the hard cap it was documented as.
  it('requests exactly NSF_AWARDS_MAX_RPP rows per page', () => {
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

/**
 * The REAL API, captured 2026-08-03: five requests, all HTTP 200,
 * `content-type: application/json`, 25 awards each. See fixtures/nsf-awards/README.md for the
 * one edit made to these files (125 personal email addresses and phone numbers redacted).
 */
describe('nsfAwards against the real captured API responses', () => {
  const KEYWORDS = ['ionosphere', 'amateur radio', 'radio science', 'cubesat', 'spectrum education'];
  const FILES: ReadonlyArray<readonly [string, string]> = [
    ['00-api-nsf-gov-services-v1-awards-json-keyword-ionosphere-printfields-id-2ctitle-2c.json', KEYWORDS[0]],
    ['01-api-nsf-gov-services-v1-awards-json-keyword-amateur-radio-printfields-id-2ctitle.json', KEYWORDS[1]],
    ['02-api-nsf-gov-services-v1-awards-json-keyword-radio-science-printfields-id-2ctitle.json', KEYWORDS[2]],
    ['03-api-nsf-gov-services-v1-awards-json-keyword-cubesat-printfields-id-2ctitle-2cabs.json', KEYWORDS[3]],
    ['04-api-nsf-gov-services-v1-awards-json-keyword-spectrum-education-printfields-id-2c.json', KEYWORDS[4]],
  ];
  const captured = () => FILES.every(([f]) => hasFixture('nsf-awards', f));
  const payloads = () =>
    FILES.map(([f, kw]) =>
      fixturePayload('nsf-awards', f, `${NSF_AWARDS_URL}?keyword=${encodeURIComponent(kw)}`),
    );

  it.runIf(captured())('gets 25 awards per keyword — the real page size', () => {
    for (const [f] of FILES) {
      expect(parseNsfAwards(loadFixture('nsf-awards', f))).toHaveLength(25);
    }
  });

  it.runIf(captured())('receives all 61 fields, not the 8 asked for in printFields', () => {
    // The fact that disproves the old "printFields DOES work here" note. If this ever drops to
    // 8, printFields started being honoured again and the notes need revisiting.
    const raw = JSON.parse(loadFixture('nsf-awards', FILES[0][0])) as {
      response: { award: Record<string, unknown>[] };
    };
    expect(Object.keys(raw.response.award[0]).length).toBe(61);
    expect(raw.response.award[0].abstractText).toBeTypeOf('string');
  });

  it.runIf(captured())('keeps 38 of the 125 real awards after adjacency scoring', () => {
    const raws = nsfAwards.parse(payloads());
    expect(raws).toHaveLength(38);
    expect(raws.length).toBeGreaterThanOrEqual(nsfAwards.expectedMinRecords);
    expect(new Set(raws.map((r) => r.externalKey)).size).toBe(38);
    for (const r of raws) {
      expect(Number(r.rawFields.adjacencyScore)).toBeGreaterThanOrEqual(6);
    }
  });

  it.runIf(captured())('reads two real awards exactly as NSF returned them', () => {
    const raws = nsfAwards.parse(payloads());

    const cubesat = raws.find((r) => r.externalKey === '2619842');
    expect(cubesat?.name).toBe(
      "MCA: Revolutionizing Space Weather Monitoring with CubeSats: Direct Probes of Energy Deposition into Earth's Upper Atmosphere",
    );
    expect(cubesat?.sourceUrl).toBe('https://www.nsf.gov/awardsearch/showAward?AWD_ID=2619842');
    expect(cubesat?.rawFields.awardee).toBe('University of Texas at Dallas');
    expect(cubesat?.rawFields.program).toBe('MAGNETOSPHERIC PHYSICS');
    expect(cubesat?.rawFields.startDate).toBe('10/01/2026');
    expect(cubesat?.rawFields.endDate).toBe('09/30/2029');
    expect(cubesat?.rawFields.adjacencyScore).toBe('18');
    expect(cubesat?.rawFields.adjacencyHits).toBe('cubesat, ionosphere, ionospheric, space weather');

    const lidar = raws.find((r) => r.externalKey === '2535493');
    expect(lidar?.name).toBe(
      'Lidar Investigation of Geospace-Atmosphere Temperature, Composition, Chemistry, and Dynamics at McMurdo, Antarctica',
    );
    expect(lidar?.rawFields.awardee).toBe('University of Colorado at Boulder');
    expect(lidar?.rawFields.adjacencyScore).toBe('8');
    expect(lidar?.rawFields.adjacencyHits).toBe('ionosphere, geospace');
  });

  it.runIf(captured())('stamps every real award past_award and dormant, never a live deadline', () => {
    // An NSF award with a START DATE IN THE FUTURE (10/01/2026) is still awarded money, not an
    // open call. Getting this wrong is what puts a closed grant in front of a professional.
    for (const r of nsfAwards.parse(payloads())) {
      expect(r.rawFields.recordType).toBe('past_award');
      expect(r.rawFields.deadlineKind).toBe('dormant');
    }
  });

  it.runIf(captured())('republishes no personal contact details from the real payload', () => {
    const serialised = JSON.stringify(nsfAwards.parse(payloads()));
    expect(serialised).not.toMatch(/@[a-z0-9-]+\.(edu|gov|org|com)\b/i);
  });
});
