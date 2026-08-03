import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { NSF_FEED_URLS, parseNsfFeed } from '../federal/nsf.js';

const SOURCE_ID = 'nsf-funding-rss';

export const nsfFundingRss: SourceModule = {
  id: SOURCE_ID,
  funderId: 'nsf',
  label: 'NSF funding RSS (3 feeds)',
  tier: 'B',
  klass: 'adjacent_stem',
  requests: NSF_FEED_URLS.map((url) => ({ url, method: 'GET' as const, accept: 'xml' as const })),
  expectedMinRecords: 10,
  notes:
    'The only working .gov funding RSS. The upcoming feed is pinned to the hyphenated ' +
    'funding-upcoming/rss.xml form because the published URL 301-chains twice. Items are ' +
    'scored by federal/adjacency.ts before they reach the review queue — the genuinely ' +
    'winnable federal money is adjacent (geospace, ECCS, ATE, Noyce), not "amateur radio".',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    for (const payload of payloads) {
      if (payload.status !== 200) continue;
      if (!NSF_FEED_URLS.some((url) => payload.url === url)) continue;
      for (const item of parseNsfFeed(payload.body, payload.url)) {
        out.push({
          sourceId: SOURCE_ID,
          externalKey: item.guid || item.link,
          name: item.title,
          rawFields: { link: item.link, pubDate: item.pubDate, feedUrl: item.feedUrl },
          sourceUrl: item.link,
          rawText: [item.title, item.description].filter(Boolean).join('\n'),
        });
      }
    }
    return out;
  },
};
