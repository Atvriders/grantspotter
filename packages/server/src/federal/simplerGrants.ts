import type { FetchRequest } from '@grantspotter/core';

/**
 * Spec §7.5. Simpler.Grants.gov is the modern rewrite of the Grants.gov API. Its key is free
 * (Login.gov issues it), and it is OPTIONAL AND NEVER A HARD DEPENDENCY: with a key the federal
 * sweep ranks better, without one it behaves exactly as it always did. Nothing about which
 * opportunities are discovered depends on it — only their ordering.
 *
 * This is the single module in the server that reads SIMPLER_GRANTS_API_KEY. It is read at call
 * time, never at module load, so a test can set and unset it.
 */
export const SIMPLER_GRANTS_SEARCH_URL = 'https://api.simpler.grants.gov/v1/opportunities/search';
const SIMPLER_GRANTS_HOST = 'api.simpler.grants.gov';

export interface SimplerGrantsHit {
  opportunityNumber: string;
  title: string;
  agency: string;
  summary: string;
  relevancy: number; // 0..1 as reported by the API
}

export function simplerGrantsApiKey(): string | undefined {
  const key = process.env.SIMPLER_GRANTS_API_KEY ?? '';
  return key.trim() === '' ? undefined : key.trim();
}

/**
 * FetchRequest (CONTRACT §3) carries no headers, so the X-Auth credential is supplied at the
 * transport layer through FetchOptions.headersByHost. Empty object when there is no key, which
 * means the fetcher adds nothing.
 */
export function simplerAuthHeaders(): Record<string, Record<string, string>> {
  const key = simplerGrantsApiKey();
  return key === undefined ? {} : { [SIMPLER_GRANTS_HOST]: { 'X-Auth': key } };
}

/** [] when there is no key — no key means no call, ever. */
export function simplerSearchRequests(keywords: readonly string[]): FetchRequest[] {
  if (simplerGrantsApiKey() === undefined) return [];
  return keywords.map((keyword) => ({
    url: SIMPLER_GRANTS_SEARCH_URL,
    method: 'POST',
    accept: 'json',
    body: {
      query: keyword,
      filters: { opportunity_status: { one_of: ['posted', 'forecasted'] } },
      pagination: {
        page_offset: 1,
        page_size: 25,
        sort_order: [{ order_by: 'relevancy', sort_direction: 'descending' }],
      },
    },
  }));
}

/** Junk in, [] out. A malformed optional response must never break a crawl. */
export function parseSimplerResponse(json: string): SimplerGrantsHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: SimplerGrantsHit[] = [];
  for (const entry of data) {
    const row = entry as Record<string, unknown>;
    const summary = (row.summary ?? {}) as Record<string, unknown>;
    const relevancy = Number(row.relevancy_score);
    out.push({
      opportunityNumber: String(row.opportunity_number ?? ''),
      title: String(row.opportunity_title ?? ''),
      agency: String(row.agency_name ?? ''),
      summary: String(summary.summary_description ?? ''),
      relevancy: Number.isFinite(relevancy) ? Math.min(1, Math.max(0, relevancy)) : 0,
    });
  }
  return out;
}

/**
 * Blends the API's own relevancy into the deterministic adjacency score. Additive and
 * non-negative BY CONSTRUCTION: supplying a key can only raise a record's rank, never lower it,
 * so a missing or degraded Simpler response can never hide an opportunity a user would have seen.
 */
export function blendSimplerRelevance(
  base: { score: number; hits: string[] },
  hit: SimplerGrantsHit | undefined,
): { score: number; hits: string[] } {
  if (hit === undefined) return base;
  const bonus = Math.round(hit.relevancy * 4 * 100) / 100; // 0..4, two decimals
  if (bonus <= 0) return base;
  return {
    score: base.score + bonus,
    hits: [...base.hits, `simpler:${hit.relevancy}`],
  };
}
