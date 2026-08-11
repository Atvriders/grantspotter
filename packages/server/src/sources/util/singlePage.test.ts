import { describe, expect, it } from 'vitest';
import { isReadablePayload, pickPayload } from './payload.js';
import { makeSinglePageSource } from './singlePage.js';

const cfg = {
  id: 'demo-source',
  funderId: 'demo-funder',
  label: 'Demo',
  tier: 'C' as const,
  klass: 'ham_grant' as const,
  url: 'https://example.test/demo',
  name: 'Demo Program',
  externalKey: 'demo-program',
  fieldPatterns: {
    windows: /(February\s+1[^.]*?October\s+31)/i,
    amount: /(\$[\d,]+)/,
  },
  requiredFields: ['windows'],
  expectedMinRecords: 1,
};

const page = (body: string) => ({
  url: 'https://example.test/demo',
  status: 200,
  contentType: 'text/html',
  body,
  fetchedAt: '2026-08-02T00:00:00.000Z',
});

describe('makeSinglePageSource', () => {
  it('produces a SourceModule with the contract fields', () => {
    const m = makeSinglePageSource(cfg);
    expect(m.id).toBe('demo-source');
    expect(m.requests).toEqual([{ url: cfg.url, method: 'GET', accept: 'html' }]);
    expect(m.expectedMinRecords).toBe(1);
  });

  it('extracts every matching field over the flattened text', () => {
    const m = makeSinglePageSource(cfg);
    const raws = m.parse([page('<p>February 1 - 28, June 1 - 30, and October 31.</p><p>$3,000</p>')]);
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.windows).toContain('October 31');
    expect(raws[0].rawFields.amount).toBe('$3,000');
    expect(raws[0].externalKey).toBe('demo-program');
    expect(raws[0].name).toBe('Demo Program');
    expect(raws[0].rawText).toContain('February 1');
  });

  it('returns [] when a required field does not match, so the yield alarm fires', () => {
    const m = makeSinglePageSource(cfg);
    expect(m.parse([page('<p>nothing useful here</p>')])).toEqual([]);
  });

  it('returns [] when the payload is missing entirely', () => {
    expect(makeSinglePageSource(cfg).parse([])).toEqual([]);
  });

  it('omits an optional field that does not match rather than storing an empty string', () => {
    const m = makeSinglePageSource(cfg);
    const raws = m.parse([page('<p>February 1 - 28 ... October 31.</p>')]);
    expect(raws[0].rawFields.amount).toBeUndefined();
  });

  it('appends extraParse records after the main record', () => {
    const m = makeSinglePageSource({
      ...cfg,
      extraParse: (flat, _html, sourceUrl) =>
        flat.includes('Recipients')
          ? [
              {
                sourceId: cfg.id,
                externalKey: 'award:demo',
                name: 'Demo Award',
                rawFields: { recordType: 'past_award' },
                sourceUrl,
                rawText: 'Demo Award',
              },
            ]
          : [],
    });
    const raws = m.parse([page('<p>February 1 - 28 ... October 31.</p><h2>Recipients</h2>')]);
    expect(raws).toHaveLength(2);
    expect(raws[1].rawFields.recordType).toBe('past_award');
  });
});

/**
 * WHAT A PARSER MAY AND MAY NOT CONCLUDE FROM A REFUSAL.
 *
 * `pickPayload` has always skipped anything outside 200-299, so a 403 reaches a parser as "no
 * payload for this address" and the parser correctly produces nothing. That was never the defect.
 * The defect was that `crawl/runner.ts` then called `recordPollSuccess` because a `FetchedPayload`
 * had come back at all, so a refusal was stored as a successful poll of zero records — and drawn
 * on the Sources screen as a yield alarm, blaming a parser that had behaved exactly as designed.
 *
 * These tests pin BOTH sides of that seam: this layer's answer is still `[]` (it has no business
 * knowing why the page is absent), and the predicate that decides it is the exported one the
 * runner imports, so the two can no longer drift into disagreeing about what "we got the page"
 * means.
 */
describe('a payload outside 200-299 is not a page', () => {
  const answered = (status: number) => ({ ...page(''), status });

  it('is what isReadablePayload says, for every class of status', () => {
    expect(isReadablePayload(answered(200))).toBe(true);
    expect(isReadablePayload(answered(204))).toBe(true);
    expect(isReadablePayload(answered(299))).toBe(true);
    // A redirect we never followed to the end is not the page either: `Location` is an address,
    // not content, and the fetcher hands the 3xx back when a chain runs out of hops or of purse.
    expect(isReadablePayload(answered(301))).toBe(false);
    for (const status of [400, 401, 403, 404, 410, 418, 451]) {
      expect(isReadablePayload(answered(status))).toBe(false);
    }
  });

  it('makes pickPayload skip it, whatever the address matched', () => {
    expect(pickPayload([answered(403)], '/demo')).toBeUndefined();
    expect(pickPayload([answered(200)], '/demo')).toBeDefined();
  });

  it('still leaves the parser saying nothing more than "no page" — the runner decides why', () => {
    const m = makeSinglePageSource(cfg);
    const body = '<p>February 1 - 28, June 1 - 30, and October 31.</p><p>$3,000</p>';
    // The SAME body the parser reads happily at 200 yields nothing at 403, because the parse is
    // never offered a payload the site refused to serve.
    expect(m.parse([{ ...page(body), status: 200 }])).toHaveLength(1);
    expect(m.parse([{ ...page(body), status: 403 }])).toEqual([]);
  });
});
