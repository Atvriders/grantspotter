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
    'OPEN SOLICITATIONS — the one federal source here that is genuinely not award history, so ' +
    'it publishes rather than being suppressed. The only working .gov funding RSS: all three ' +
    'feeds really do return application/rss+xml (checked 2026-08-03), unlike every advertised ' +
    'Grants.gov feed. The upcoming feed is pinned to the hyphenated funding-upcoming/rss.xml ' +
    'form because the published URL 301-chains twice. NOT SCORED: unlike nsf-awards, ' +
    'usaspending and the two Grants.gov sources, this module runs no adjacency filter, so all ' +
    '45 items of a real capture reach the queue and on 2026-08-03 NONE of them cleared ' +
    'ADJACENCY_THRESHOLD (top score 1: Gravitational Physics, Chemical Oceanography, SBIR). ' +
    'The earlier claim that items "are scored by federal/adjacency.ts before they reach the ' +
    'review queue" was never implemented anywhere. Feed shapes differ: only rss_www_funding.xml ' +
    'carries pubDate, and rss_www_funding-upcoming states the actual deadline only as prose ' +
    'inside the description ("Full Proposal Target Date: August 4, 2026").',
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
