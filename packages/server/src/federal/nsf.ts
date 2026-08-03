import type { FetchRequest } from '@grantspotter/core';
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

/**
 * NSF Awards API — AWARDED HISTORY, not open opportunities. Tier A (spec §7.5).
 *
 * Two undocumented facts:
 *  - `printFields` DOES work here despite what the documentation implies. Without it the
 *    response omits abstractText, which is the only field with enough prose to score adjacency.
 *  - `rpp` is HARD-CAPPED AT 25. Asking for 100 does not error; it silently returns 25, so a
 *    paginator that advances by its requested page size skips three quarters of the results and
 *    never notices. `offset` is 1-based.
 */
export const NSF_AWARDS_URL = 'https://api.nsf.gov/services/v1/awards.json';
export const NSF_AWARDS_MAX_RPP = 25;

export const NSF_AWARDS_PRINT_FIELDS: readonly string[] = Object.freeze([
  'id',
  'title',
  'abstractText',
  'awardeeName',
  'startDate',
  'expDate',
  'fundProgramName',
  'agency',
]);

export interface NsfAwardItem {
  id: string;
  title: string;
  abstractText: string;
  awardeeName: string;
  startDate: string;
  expDate: string;
  fundProgramName: string;
  agency: string;
}

export function buildNsfAwardsRequest(keyword: string, page: number): FetchRequest {
  const url = new URL(NSF_AWARDS_URL);
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('printFields', NSF_AWARDS_PRINT_FIELDS.join(','));
  url.searchParams.set('rpp', String(NSF_AWARDS_MAX_RPP));
  // 1-based, in steps of exactly NSF_AWARDS_MAX_RPP.
  url.searchParams.set('offset', String((Math.max(1, page) - 1) * NSF_AWARDS_MAX_RPP + 1));
  return { url: url.toString(), method: 'GET', accept: 'json' };
}

export function parseNsfAwards(json: string): NsfAwardItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const awards = ((parsed as { response?: { award?: unknown } }).response ?? {}).award;
  if (!Array.isArray(awards)) return [];
  return awards.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      id: String(row.id ?? ''),
      title: String(row.title ?? ''),
      abstractText: String(row.abstractText ?? ''),
      awardeeName: String(row.awardeeName ?? ''),
      startDate: String(row.startDate ?? ''),
      expDate: String(row.expDate ?? ''),
      fundProgramName: String(row.fundProgramName ?? ''),
      agency: String(row.agency ?? ''),
    };
  });
}
