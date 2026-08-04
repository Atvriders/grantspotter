import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { scoreAdjacency } from '../federal/adjacency.js';
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
    'form because the published URL 301-chains twice. SCORED BUT NOT FILTERED HERE (fixed ' +
    '2026-08-03): every item is scored by federal/adjacency.ts and carries its score in ' +
    'rawFields.adjacencyScore, but NOTHING is dropped from parse() — the review-queue gate lives ' +
    'in review/buildReviewItems instead, deliberately. On the 2026-08-03 capture all 45 real ' +
    'items score 1 or 0 against a threshold of 6 (best: Gravitational Physics, Chemical ' +
    'Oceanography, SBIR), so all 45 used to reach the human queue every night and now none do. ' +
    'Filtering inside parse() would have been the obvious fix and is the WRONG one: parse()’s ' +
    'length is what detectYieldDrop watches against expectedMinRecords, so a source that drops ' +
    'its own sub-threshold items reports a yield of 0 on a quiet night and becomes ' +
    'indistinguishable from a feed that broke. Feed shapes differ: only rss_www_funding.xml ' +
    'carries pubDate, and rss_www_funding-upcoming states the actual deadline only as prose ' +
    'inside the description ("Full Proposal Target Date: August 4, 2026").',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    for (const payload of payloads) {
      if (payload.status !== 200) continue;
      if (!NSF_FEED_URLS.some((url) => payload.url === url)) continue;
      for (const item of parseNsfFeed(payload.body, payload.url)) {
        const rawText = [item.title, item.description].filter(Boolean).join('\n');
        // Scored over exactly the text the feed publishes. NSF's <description> is a real synopsis
        // on all three feeds, so this is the richest signal available without a detail fetch —
        // and the score must be computed on every item, including the ones that will be gated
        // out downstream, because "45 items, all scoring 1" and "0 items" are the two outcomes
        // this source has to keep telling apart.
        const scored = scoreAdjacency(rawText);
        out.push({
          sourceId: SOURCE_ID,
          externalKey: item.guid || item.link,
          name: item.title,
          rawFields: {
            link: item.link,
            pubDate: item.pubDate,
            feedUrl: item.feedUrl,
            adjacencyScore: String(scored.score),
            adjacencyHits: scored.hits.join(', '),
          },
          sourceUrl: item.link,
          rawText,
        });
      }
    }
    return out;
  },
};
