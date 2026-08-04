import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import { NSF_AWARDS_URL, buildNsfAwardsRequest, parseNsfAwards } from '../federal/nsf.js';

const SOURCE_ID = 'nsf-awards';
const KEYWORDS = ['ionosphere', 'amateur radio', 'radio science', 'cubesat', 'spectrum education'];

export const nsfAwards: SourceModule = {
  id: SOURCE_ID,
  funderId: 'nsf',
  label: 'NSF Awards API (awarded history)',
  tier: 'A',
  klass: 'adjacent_stem',
  requests: KEYWORDS.map((keyword): FetchRequest => buildNsfAwardsRequest(keyword, 1)),
  expectedMinRecords: 1,
  notes:
    'AWARDED HISTORY, not open opportunities — every record is stamped recordType=past_award so ' +
    'it can never render as a live deadline, and normalize/ tags it do_not_publish. offset is ' +
    '1-based. TWO PREVIOUSLY DOCUMENTED "API FACTS" WERE RE-MEASURED AGAINST THE LIVE API ON ' +
    '2026-08-03 AND ARE NO LONGER TRUE. (1) printFields does NOT restrict the response: every ' +
    'award comes back with all 61 fields whether or not printFields is sent, and abstractText ' +
    'is present without it — so printFields is now inert, not load-bearing. (2) rpp is NOT ' +
    'capped at 25: rpp=100 returned exactly 100 awards. NSF_AWARDS_MAX_RPP (federal/nsf.ts) is ' +
    'therefore leaving three quarters of each keyword’s candidates unread. Raising it is a ' +
    'deliberate call about request size, not a bug fix, so it has been left at 25 and flagged ' +
    'rather than silently changed.',

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const byId = new Map<string, RawOpportunity>();
    for (const payload of payloads) {
      if (!payload.url.startsWith(NSF_AWARDS_URL) || payload.status !== 200) continue;
      for (const item of parseNsfAwards(payload.body)) {
        if (item.id === '' || byId.has(item.id)) continue;
        const scored = scoreAdjacency(
          [item.title, item.abstractText, item.fundProgramName].join('\n'),
        );
        if (scored.score < ADJACENCY_THRESHOLD) continue;
        byId.set(item.id, {
          sourceId: SOURCE_ID,
          externalKey: item.id,
          name: item.title,
          sourceUrl: `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${item.id}`,
          rawText: item.abstractText,
          rawFields: {
            recordType: 'past_award',
            deadlineKind: 'dormant',
            awardee: item.awardeeName,
            program: item.fundProgramName,
            startDate: item.startDate,
            endDate: item.expDate,
            adjacencyScore: String(scored.score),
            adjacencyHits: scored.hits.join(', '),
          },
        });
      }
    }
    return [...byId.values()];
  },
};
