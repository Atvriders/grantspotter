import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../../test/fixtures.js';
import { parseRssItems } from './rss.js';

const xml = () => loadFixture('arrl-news-rss', 'pathological.xml');

describe('parseRssItems', () => {
  it('reads every item in document order', () => {
    const items = parseRssItems(xml());
    expect(items).toHaveLength(4);
    expect(items[0].title).toBe('ARRL Foundation Scholarship Applications Open October 30');
  });

  it('unwraps CDATA and strips HTML out of the description', () => {
    const items = parseRssItems(xml());
    expect(items[0].description).toBe('Applications close December 30 at 12:00 PM EST.');
  });

  it('falls back to the link when an item has no guid', () => {
    const items = parseRssItems(xml());
    expect(items[3].guid).toBe('http://www.arrl.org/news/club-grant-deadline');
  });

  it('keeps pubDate verbatim', () => {
    expect(parseRssItems(xml())[0].pubDate).toBe('Mon, 27 Oct 2026 14:00:00 -0400');
  });

  it('returns [] for an HTML page masquerading as a feed', () => {
    expect(parseRssItems('<!DOCTYPE html><html><body><div id="root"></div></body></html>')).toEqual(
      [],
    );
  });

  it('returns [] for empty or malformed input', () => {
    expect(parseRssItems('')).toEqual([]);
    expect(parseRssItems('<rss><channel>')).toEqual([]);
  });
});
