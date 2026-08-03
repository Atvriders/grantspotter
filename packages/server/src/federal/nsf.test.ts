import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import { NSF_FEED_URLS, parseNsfFeed } from './nsf.js';

describe('NSF_FEED_URLS', () => {
  it('lists exactly the three working NSF funding feeds', () => {
    expect(NSF_FEED_URLS).toHaveLength(3);
  });

  it('pins the upcoming feed to the hyphen + /rss.xml form — the published URL 301-chains twice', () => {
    expect(NSF_FEED_URLS).toContain('https://www.nsf.gov/rss/rss_www_funding-upcoming/rss.xml');
    for (const url of NSF_FEED_URLS) expect(url.startsWith('https://www.nsf.gov/rss/')).toBe(true);
  });
});

describe('parseNsfFeed', () => {
  it('stamps every item with the feed it came from', () => {
    const items = parseNsfFeed(
      loadFixture('nsf-funding-rss', 'pathological.xml'),
      NSF_FEED_URLS[0],
    );
    expect(items).toHaveLength(2);
    expect(items[0].feedUrl).toBe(NSF_FEED_URLS[0]);
    expect(items[0].title).toBe('Advanced Technological Education (ATE)');
  });
});
