import { describe, expect, it } from 'vitest';
import { fixturePayload, hasFixture, loadFixture } from '../../test/fixtures.js';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import { NSF_FEED_URLS } from '../federal/nsf.js';
import { nsfFundingRss } from './nsf-funding-rss.js';

describe('nsfFundingRss', () => {
  it('is a Tier B adjacent-STEM source over exactly the three pinned feed URLs', () => {
    expect(nsfFundingRss.tier).toBe('B');
    expect(nsfFundingRss.klass).toBe('adjacent_stem');
    expect(nsfFundingRss.expectedMinRecords).toBe(10);
    const urls = (nsfFundingRss.requests as { url: string }[]).map((r) => r.url);
    expect(urls).toEqual([...NSF_FEED_URLS]);
  });

  it('ignores a payload whose URL is not one of the three pinned feeds', () => {
    expect(
      nsfFundingRss.parse([
        fixturePayload('nsf-funding-rss', 'pathological.xml', 'https://www.nsf.gov/rss/other.xml'),
      ]),
    ).toEqual([]);
  });

  it('ignores a non-200 feed', () => {
    expect(
      nsfFundingRss.parse([
        {
          url: NSF_FEED_URLS[0],
          status: 503,
          contentType: 'text/html',
          body: '<html>down</html>',
          fetchedAt: '2026-08-02T00:00:00.000Z',
        },
      ]),
    ).toEqual([]);
  });

  it('returns [] when a feed URL serves an HTML shell behind a 200', () => {
    expect(
      nsfFundingRss.parse([
        {
          url: NSF_FEED_URLS[0],
          status: 200,
          contentType: 'text/html',
          body: '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
          fetchedAt: '2026-08-02T00:00:00.000Z',
        },
      ]),
    ).toEqual([]);
  });
});

/**
 * The REAL three feeds, captured 2026-08-03. All three: HTTP 200,
 * `content-type: application/rss+xml; charset=utf-8`, opening `<?xml version="1.0"
 * encoding="utf-8"?>\n<rss version="2.0" ...>`. These are genuine feeds — the check that matters,
 * given all four advertised Grants.gov feeds return 200 with text/html and an SPA shell.
 */
describe('nsfFundingRss against the three real captured feeds', () => {
  const FILES: ReadonlyArray<readonly [string, string]> = [
    ['00-www-nsf-gov-rss-rss-www-funding-xml.xml', NSF_FEED_URLS[0]],
    ['01-www-nsf-gov-rss-rss-www-funding-pgm-annc-inf-xml.xml', NSF_FEED_URLS[1]],
    ['02-www-nsf-gov-rss-rss-www-funding-upcoming-rss-xml.xml', NSF_FEED_URLS[2]],
  ];
  const captured = () => FILES.every(([f]) => hasFixture('nsf-funding-rss', f));
  const payloads = () => FILES.map(([f, url]) => fixturePayload('nsf-funding-rss', f, url));

  it.runIf(captured())('is RSS on the wire on all three feeds, not an HTML shell', () => {
    for (const [f] of FILES) {
      const body = loadFixture('nsf-funding-rss', f);
      expect(body).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>\s*<rss version="2\.0"/);
      expect(body).not.toMatch(/<!DOCTYPE html>/i);
    }
  });

  it.runIf(captured())('parses 45 real items — 20 + 15 + 10 across the three feeds', () => {
    const raws = nsfFundingRss.parse(payloads());
    expect(raws).toHaveLength(45);
    expect(raws.length).toBeGreaterThanOrEqual(nsfFundingRss.expectedMinRecords);
    expect(NSF_FEED_URLS.map((u) => raws.filter((r) => r.rawFields.feedUrl === u).length)).toEqual([
      20, 15, 10,
    ]);
    expect(new Set(raws.map((r) => r.externalKey)).size).toBe(45);
  });

  it.runIf(captured())('reads two real solicitations exactly as NSF published them', () => {
    const raws = nsfFundingRss.parse(payloads());

    expect(raws[0].name).toBe(
      'U.S. National Science Foundation State and Regional Artificial Intelligence Infrastructure Hubs:',
    );
    expect(raws[0].externalKey).toBe(
      'https://www.nsf.gov/funding/opportunities/us-national-science-foundation-state-regional-artificial/nsf26-513',
    );
    expect(raws[0].sourceUrl).toBe(raws[0].externalKey);
    expect(raws[0].rawFields.pubDate).toBe('Fri, 31 Jul 2026 09:21:49 -0400');
    expect(raws[0].rawFields.feedUrl).toBe(NSF_FEED_URLS[0]);

    const reu = raws.find((r) => r.name === 'Research Experiences for Undergraduates (REU)');
    expect(reu?.externalKey).toBe(
      'https://www.nsf.gov/funding/opportunities/reu-research-experiences-undergraduates/nsf23-601',
    );
    expect(reu?.rawFields.feedUrl).toBe(NSF_FEED_URLS[2]);
  });

  it.runIf(captured())('leaves pubDate empty for the two feeds that do not publish one', () => {
    // Real shape: only rss_www_funding.xml carries <pubDate>. The other 25 items have none, and
    // inventing one would be worse than recording its absence.
    const raws = nsfFundingRss.parse(payloads());
    expect(raws.filter((r) => r.rawFields.pubDate === '')).toHaveLength(25);
    for (const r of raws.filter((r) => r.rawFields.feedUrl === NSF_FEED_URLS[0])) {
      expect(r.rawFields.pubDate).not.toBe('');
    }
  });

  it.runIf(captured())('keeps the upcoming feed’s real due date in the text it carries', () => {
    // rss_www_funding-upcoming states the deadline only as prose inside <description>.
    const raws = nsfFundingRss.parse(payloads());
    const math = raws.find((r) => r.name === 'Mathematical Sciences Infrastructure Program');
    expect(math?.rawText).toContain('Full Proposal Target Date: August 4, 2026');
    expect(math?.rawText).toContain('Program Guidelines: PD 20-1260');
  });

  /**
   * REMEDIATION 2026-08-03. This source used to emit its 45 real items unscored, and all 45
   * reached the human review queue every night while not one of them was adjacent to amateur
   * radio. Every item now carries its score, and NOTHING is dropped here — the queue gate lives
   * one stage downstream in `review/buildReviewItems`.
   *
   * The split matters and is the whole design: `parse()`'s length is what `detectYieldDrop`
   * compares against `expectedMinRecords`, so a source that filters its own sub-threshold items
   * reports a yield of 0 on a quiet night and becomes indistinguishable from a feed that broke.
   * `crawl/runner.test.ts` holds the end-to-end proof of both halves (queue 45 -> 0; a broken feed
   * still raises `parse_yield_dropped`).
   */
  it.runIf(captured())('scores every real item and drops none of them', () => {
    const raws = nsfFundingRss.parse(payloads());
    expect(raws).toHaveLength(45);
    for (const r of raws) expect(r.rawFields.adjacencyScore).toBeDefined();

    // The score written into rawFields is the score of the text the item actually carries.
    for (const r of raws) {
      expect(Number(r.rawFields.adjacencyScore)).toBe(scoreAdjacency(r.rawText ?? '').score);
    }
  });

  it.runIf(captured())('finds not one adjacent item in the whole real capture', () => {
    // The measurement the fix rests on: the best of the 45 scores 1 (Gravitational Physics,
    // Chemical Oceanography, SBIR), against a threshold of 6. If this ever stops being true the
    // gate downstream will start letting items through, which is exactly what it should do.
    const raws = nsfFundingRss.parse(payloads());
    const best = Math.max(...raws.map((r) => Number(r.rawFields.adjacencyScore)));
    expect(best).toBe(1);
    expect(best).toBeLessThan(ADJACENCY_THRESHOLD);
    expect(raws.filter((r) => Number(r.rawFields.adjacencyScore) >= ADJACENCY_THRESHOLD)).toEqual([]);
    expect(nsfFundingRss.notes).toMatch(/SCORED BUT NOT FILTERED HERE/);
  });

  it.runIf(captured())('leaves the parse yield at 45, which is what the alarm watches', () => {
    // Filtering the 45 down to 0 inside parse() would have suppressed the noise AND disabled
    // detectYieldDrop, making a broken feed look exactly like a quiet night.
    const raws = nsfFundingRss.parse(payloads());
    expect(raws.length).toBeGreaterThanOrEqual(nsfFundingRss.expectedMinRecords);
    expect(raws).toHaveLength(45);
  });
});
