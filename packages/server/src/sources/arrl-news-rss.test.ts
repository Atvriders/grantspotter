import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
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
