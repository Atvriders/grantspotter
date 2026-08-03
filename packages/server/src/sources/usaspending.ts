import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import {
  USASPENDING_SEARCH_URL,
  buildUsaSpendingRequest,
  parseUsaSpending,
} from '../federal/usaSpending.js';

const SOURCE_ID = 'usaspending';
const KEYWORDS = ['amateur radio', 'ionospheric', 'radio spectrum education', 'cubesat ground station'];

const money = (n: number): string => `$${n.toLocaleString('en-US')}`;

export const usaSpending: SourceModule = {
  id: SOURCE_ID,
  funderId: 'federal',
  label: 'USAspending awarded-grant history',
  tier: 'A',
  klass: 'adjacent_stem',
  requests: KEYWORDS.map((keyword): FetchRequest => buildUsaSpendingRequest(keyword, 1)),
  expectedMinRecords: 1,
  notes:
    'AWARDED HISTORY for corroboration: it answers "has anyone like me ever actually won this?" ' +
    'and "how big is a realistic award?". award_type_codes is pinned to 02/03/04/05 (block, ' +
    'formula and project grants plus cooperative agreements); omitting it returns PROCUREMENT ' +
    'CONTRACTS (codes A-D), which no ham club can apply for. Every record is stamped ' +
    'recordType=past_award so it can never render as a live deadline.',

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const byId = new Map<string, RawOpportunity>();
    for (const payload of payloads) {
      if (!payload.url.startsWith(USASPENDING_SEARCH_URL) || payload.status !== 200) continue;
      for (const award of parseUsaSpending(payload.body)) {
        if (award.awardId === '' || byId.has(award.awardId)) continue;
        const scored = scoreAdjacency([award.description, award.awardingAgency].join('\n'));
        if (scored.score < ADJACENCY_THRESHOLD) continue;
        byId.set(award.awardId, {
          sourceId: SOURCE_ID,
          externalKey: award.awardId,
          name: `${award.awardingAgency}: ${award.description.slice(0, 120)}`,
          sourceUrl: `https://www.usaspending.gov/award/${encodeURIComponent(award.awardId)}`,
          rawText: award.description,
          rawFields: {
            recordType: 'past_award',
            deadlineKind: 'dormant',
            awardee: award.recipientName,
            startDate: award.startDate,
            endDate: award.endDate,
            adjacencyScore: String(scored.score),
            adjacencyHits: scored.hits.join(', '),
            ...(award.amount === undefined ? {} : { amountRaw: money(award.amount) }),
          },
        });
      }
    }
    return [...byId.values()];
  },
};
