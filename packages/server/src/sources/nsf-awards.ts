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
    'it can never render as a live deadline. Two undocumented API facts: printFields DOES work ' +
    'here despite the docs (without it abstractText is missing, and abstractText is the only ' +
    'field with enough prose to score adjacency), and rpp is HARD-CAPPED AT 25 — asking for 100 ' +
    'silently returns 25, so a paginator advancing by its requested page size skips three ' +
    'quarters of the results and never notices. offset is 1-based.',

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
