import { type RssItem, parseRssItems } from '../sources/util/rss.js';

/**
 * The only working .gov funding RSS found in the whole research pass.
 *
 * The third URL is deliberately the hyphenated `funding-upcoming` form WITH a `/rss.xml` path
 * segment. The URL NSF publishes 301-chains twice before landing here; pointing at the
 * published form costs two redirects on every poll and breaks the moment the chain changes.
 * Do not "fix" it.
 */
export const NSF_FEED_URLS: readonly string[] = Object.freeze([
  'https://www.nsf.gov/rss/rss_www_funding.xml',
  'https://www.nsf.gov/rss/rss_www_funding_pgm_annc_inf.xml',
  'https://www.nsf.gov/rss/rss_www_funding-upcoming/rss.xml',
]);

export interface NsfItem extends RssItem {
  feedUrl: string;
}

export function parseNsfFeed(xml: string, feedUrl: string): NsfItem[] {
  return parseRssItems(xml).map((item) => ({ ...item, feedUrl }));
}
