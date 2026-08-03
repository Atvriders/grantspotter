import type { FetchRequest, FetchedPayload, RawOpportunity } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import {
  SIMPLER_GRANTS_SEARCH_URL,
  type SimplerGrantsHit,
  blendSimplerRelevance,
  parseSimplerResponse,
  simplerSearchRequests,
} from '../federal/simplerGrants.js';
import {
  GRANTS_GOV_KEYWORDS,
  GRANTS_GOV_SEARCH_URL,
  type GrantsGovDetail,
  type GrantsGovHit,
  buildFetchOpportunityRequest,
  buildSearchRequest,
  parseOpportunityDetail,
  parseSearchResponse,
  toRawOpportunity,
} from '../federal/grantsGov.js';
import type { FollowUpSource } from './types.js';

const SOURCE_ID = 'grants-gov-federal';
/** Hard cap on nightly detail fetches so a broad keyword cannot become a 250-request crawl. */
const MAX_DETAIL_FETCHES = 25;
/**
 * The search-hit title + agency is a much thinner signal than the hydrated description (e.g.
 * "Geospace Facilities" / "National Science Foundation" scores only 3 — a single Tier-2 term —
 * on title+agency alone, but its full synopsis is rich with ionospheric/space-weather/geospace
 * language and clears ADJACENCY_THRESHOLD easily). followUp() therefore uses a deliberately
 * lower bar so a promising thin signal is not discarded before the rich description can be
 * read; parse() re-scores against the hydrated text and is the strict, authoritative gate.
 */
const FOLLOWUP_THRESHOLD = Math.ceil(ADJACENCY_THRESHOLD / 2);

function hitsFrom(payloads: FetchedPayload[]): GrantsGovHit[] {
  const byId = new Map<string, GrantsGovHit>();
  for (const payload of payloads) {
    if (!payload.url.startsWith(GRANTS_GOV_SEARCH_URL) || payload.status !== 200) continue;
    for (const hit of parseSearchResponse(payload.body)) {
      if (hit.id !== '') byId.set(hit.id, hit);
    }
  }
  return [...byId.values()];
}

function detailsFrom(payloads: FetchedPayload[]): Map<string, GrantsGovDetail> {
  const out = new Map<string, GrantsGovDetail>();
  for (const payload of payloads) {
    if (!payload.url.includes('fetchOpportunity') || payload.status !== 200) continue;
    const detail = parseOpportunityDetail(payload.body);
    if (detail?.opportunityId) out.set(detail.opportunityId, detail);
  }
  return out;
}

/**
 * Optional (spec §7.5). Keyed by opportunity NUMBER, which is the only identifier the two APIs
 * share — Simpler does not echo the legacy numeric opportunity id. Empty map when no key is set
 * or no Simpler payload arrived, and every caller must behave identically in that case.
 */
function simplerHitsFrom(payloads: FetchedPayload[]): Map<string, SimplerGrantsHit> {
  const out = new Map<string, SimplerGrantsHit>();
  for (const payload of payloads) {
    if (!payload.url.startsWith(SIMPLER_GRANTS_SEARCH_URL) || payload.status !== 200) continue;
    for (const hit of parseSimplerResponse(payload.body)) {
      if (hit.opportunityNumber !== '') out.set(hit.opportunityNumber, hit);
    }
  }
  return out;
}

export const grantsGovFederal: FollowUpSource = {
  id: SOURCE_ID,
  funderId: 'federal',
  label: 'Grants.gov federal adjacency sweep',
  tier: 'A',
  klass: 'adjacent_stem',
  // A function, not a literal array: the optional Simpler.Grants.gov leg is decided at resolve
  // time. With no SIMPLER_GRANTS_API_KEY this is exactly the search2-only list it always was.
  requests: async (): Promise<FetchRequest[]> => [
    ...GRANTS_GOV_KEYWORDS.map((keyword) => buildSearchRequest(keyword, 50, 0)),
    ...simplerSearchRequests(GRANTS_GOV_KEYWORDS),
  ],
  // Honest, not aspirational: this sweep surfaces roughly 10-30 genuinely relevant federal
  // opportunities A YEAR out of ~5,000 posted, so a typical night yields zero and that is
  // correct behaviour, not a failure. expectedMinRecords stays 0 so parse_yield_dropped never
  // cries wolf on this source (global constraint: "An empty scrape is not a failure").
  expectedMinRecords: 0,
  notes:
    'Federal sweep via the key-free POST search2 endpoint. DO NOT ADD ANY GRANTS.GOV RSS FEED: ' +
    'all four advertised feeds return HTTP 200 with content-type text/html — a ~27 KB SPA ' +
    'shell, not XML — so a naive poller finds zero items forever and never errors. Relevance ' +
    'is scored, not keyword-matched: "amateur radio" returns 57 hits and "cubesat" returns 1, ' +
    'while the genuinely winnable money is adjacent (NSF geospace/ECCS/ATE/Noyce, NASA Space ' +
    'Grant and MUREP, NTIA PWSCIF). awardCeiling and awardFloor are frequently the literal ' +
    'string "none" and are never coerced to 0. Nothing here publishes: federal candidates ' +
    'enter the same human review queue as everything else.',

  followUp(payloads: FetchedPayload[]): FetchRequest[] {
    return hitsFrom(payloads)
      .filter((hit) => scoreAdjacency(`${hit.title}\n${hit.agency}`).score >= FOLLOWUP_THRESHOLD)
      .slice(0, MAX_DETAIL_FETCHES)
      .map((hit) => buildFetchOpportunityRequest(hit.id));
  },

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const details = detailsFrom(payloads);
    const simpler = simplerHitsFrom(payloads);
    const out: RawOpportunity[] = [];
    for (const hit of hitsFrom(payloads)) {
      const detail = details.get(hit.id);
      // Re-score with the hydrated description, which is far richer than the title alone.
      const deterministic = scoreAdjacency(
        [hit.title, hit.agency, detail?.description ?? '', detail?.applicantTypes.join(' ') ?? ''].join(
          '\n',
        ),
      );
      if (deterministic.score < ADJACENCY_THRESHOLD) continue;
      // Optional lift only (spec §7.5): with no key `simpler` is empty and this is the identity.
      const scored = blendSimplerRelevance(deterministic, simpler.get(hit.number));
      const raw = toRawOpportunity(hit, detail);
      out.push({
        ...raw,
        rawFields: {
          ...raw.rawFields,
          adjacencyScore: String(scored.score),
          adjacencyHits: scored.hits.join(', '),
        },
      });
    }
    return out;
  },
};
