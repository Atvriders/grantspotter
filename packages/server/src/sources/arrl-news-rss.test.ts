import { describe, expect, it } from 'vitest';
import { fixturePayload, hasFixture, loadFixture } from '../../test/fixtures.js';
import { arrlNewsRss, isGrantRelevantText } from './arrl-news-rss.js';

const FEED = 'http://www.arrl.org/news/rss';
const payload = () => fixturePayload('arrl-news-rss', 'pathological.xml', FEED);

describe('isGrantRelevantText', () => {
  it('matches grant, scholarship, deadline, funding and award language', () => {
    expect(isGrantRelevantText('Club Grant Program Deadline Extended')).toBe(true);
    expect(isGrantRelevantText('Scholarship applications open')).toBe(true);
    expect(isGrantRelevantText('Yasme Foundation announces supporting grants')).toBe(true);
    expect(isGrantRelevantText('ARDC funding for the Teachers Institute')).toBe(true);
  });

  it('does not match ordinary club news', () => {
    expect(isGrantRelevantText('November Sweepstakes Results Posted')).toBe(false);
    expect(isGrantRelevantText('Field Day logs are due')).toBe(false);
  });
});

describe('arrlNewsRss', () => {
  it('is a signal-only Tier B source', () => {
    expect(arrlNewsRss.signalOnly).toBe(true);
    expect(arrlNewsRss.tier).toBe('B');
    expect(arrlNewsRss.expectedMinRecords).toBe(5);
  });

  it('parses EVERY item so a broken feed trips the yield alarm', () => {
    expect(arrlNewsRss.parse([payload()])).toHaveLength(4);
  });

  it('uses the guid as externalKey so an item is never re-signalled', () => {
    const raws = arrlNewsRss.parse([payload()]);
    expect(raws[0].externalKey).toBe('arrl-news-88121');
    expect(new Set(raws.map((r) => r.externalKey)).size).toBe(4);
  });

  it('marks the grant, Yasme and deadline items relevant and the contest item not', () => {
    const raws = arrlNewsRss.parse([payload()]);
    expect(raws.filter((r) => arrlNewsRss.isRelevant(r)).map((r) => r.name)).toEqual([
      'ARRL Foundation Scholarship Applications Open October 30',
      'Yasme Foundation Announces Supporting Grants',
      'Club Grant Program Deadline Extended',
    ]);
  });

  it('explains in notes why this feed carries Yasme', () => {
    expect(arrlNewsRss.notes).toMatch(/Yasme/);
    expect(arrlNewsRss.notes).toMatch(/403/);
  });

  it('returns [] when the feed serves HTML instead of XML', () => {
    expect(
      arrlNewsRss.parse([
        { url: FEED, status: 200, contentType: 'text/html', body: '<html></html>', fetchedAt: '2026-08-02T00:00:00.000Z' },
      ]),
    ).toEqual([]);
  });
});

/**
 * The REAL feed, captured 2026-08-03: HTTP 200, `content-type: application/rss+xml`, 11,215
 * bytes, opening `<?xml version="1.0" encoding="UTF-8" ?><rss version="2.0">`. Genuinely a feed —
 * this is the check that Grants.gov fails and that no amount of green synthetic tests would show.
 */
describe('arrlNewsRss against the real captured feed', () => {
  const FILE = '00-www-arrl-org-news-rss.xml';
  const captured = () => hasFixture('arrl-news-rss', FILE);
  const real = () => fixturePayload('arrl-news-rss', FILE, FEED);

  it.runIf(captured())('is served as XML, not an HTML shell behind a 200', () => {
    const body = loadFixture('arrl-news-rss', FILE);
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8" ?><rss version="2.0">')).toBe(true);
    expect(body).not.toMatch(/<!DOCTYPE html>/i);
  });

  it.runIf(captured())('parses every one of the 15 real items', () => {
    const raws = arrlNewsRss.parse([real()]);
    expect(raws).toHaveLength(15);
    expect(raws.length).toBeGreaterThanOrEqual(arrlNewsRss.expectedMinRecords);
    expect(new Set(raws.map((r) => r.externalKey)).size).toBe(15);
  });

  it.runIf(captured())('reads two real items exactly as ARRL published them', () => {
    const raws = arrlNewsRss.parse([real()]);
    expect(raws[0].name).toBe('The ARRL Solar Update');
    expect(raws[0].externalKey).toBe('http://www.arrl.org/news/view/the-arrl-solar-update-40');
    expect(raws[0].sourceUrl).toBe('http://www.arrl.org/news/view/the-arrl-solar-update-40');
    expect(raws[0].rawFields.pubDate).toBe('Sat, 01 Aug 2026 11:44:00 -0500');
    expect(raws[0].rawFields.description).toMatch(/^Solar activity has remained at low levels\./);

    expect(raws[2].name).toBe('DXer and DXpeditioner Kan Mizoguchi, JA1BK, Silent Key');
    expect(raws[2].externalKey).toBe(
      'http://www.arrl.org/news/view/dxer-and-dxpeditioner-kan-mizoguchi-ja1bk-silent-key',
    );
    expect(raws[2].rawFields.pubDate).toBe('Thu, 23 Jul 2026 08:39:00 -0500');
  });

  it.runIf(captured())('survives the three real items published with <description />', () => {
    // Real feed quirk, not a parse failure: three items carry a self-closing description.
    const raws = arrlNewsRss.parse([real()]);
    const empty = raws.filter((r) => r.rawFields.description === '');
    expect(empty).toHaveLength(3);
    for (const r of empty) {
      expect(r.name).not.toBe('');
      expect(r.rawText).toBe(r.name);
    }
  });

  it.runIf(captured())('finds no grant signal in this window, and says so rather than guessing', () => {
    // Honest result: ~10-20 actionable events a year, and late Jun-Aug 2026 contained none of
    // them. A signal source that matched something here would be matching noise.
    const raws = arrlNewsRss.parse([real()]);
    expect(raws.filter((r) => arrlNewsRss.isRelevant(r))).toHaveLength(0);
  });
});
