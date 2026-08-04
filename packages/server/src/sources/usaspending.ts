import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import {
  USASPENDING_SEARCH_URL,
  buildUsaSpendingRequest,
  parseUsaSpending,
} from '../federal/usaSpending.js';

const SOURCE_ID = 'usaspending';

/**
 * `filters.keywords` is a PHRASE match, not an AND over the words. Measured against the live API
 * on 2026-08-03: "cubesat" -> hits, "ground station" -> hits, "cubesat ground station" -> 0;
 * "radio spectrum" -> hits, "spectrum education" -> 0, "radio spectrum education" -> 0.
 *
 * Two of the four original keywords were exactly those dead multi-word phrases, so half this
 * source's request budget was spent on searches that could only ever return an empty list — and
 * an empty list is HTTP 200, so nothing ever complained. Every keyword here has been confirmed
 * to return a non-empty result set; do not lengthen one into a phrase without re-checking it.
 */
const KEYWORDS = ['amateur radio', 'ionospheric', 'radio spectrum', 'ground station'];

const money = (n: number): string => `$${n.toLocaleString('en-US')}`;
const AWARD_PAGE = 'https://www.usaspending.gov/award/';

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
    'recordType=past_award so it can never render as a live deadline. Two facts confirmed ' +
    'against the live API on 2026-08-03: keywords are PHRASE matches (a multi-word keyword that ' +
    'is not a literal phrase returns 0 forever, with a 200), and the award permalink segment is ' +
    'generated_internal_id, not the FAIN — /award/<FAIN> is a dead SPA page that still returns ' +
    '200. The API also caps time_period at 2007-10-01 and says so in `messages`.',

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
          // permalinkId, never awardId — see UsaSpendingAward.permalinkId. When the API stops
          // volunteering generated_internal_id (it is returned unrequested, so it can), link to
          // the award search rather than mint a URL that 200s and shows nothing.
          sourceUrl:
            award.permalinkId === ''
              ? 'https://www.usaspending.gov/search'
              : `${AWARD_PAGE}${encodeURIComponent(award.permalinkId)}`,
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
