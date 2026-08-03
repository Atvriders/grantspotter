import type { SourceModule } from '@grantspotter/core';
import { ardcAwardTables } from './ardc-award-tables.js';
import { ardcGrants } from './ardc-grants.js';
import { arrlNewsRss } from './arrl-news-rss.js';
import { arrlScholarshipDescriptions } from './arrl-scholarship-descriptions.js';
import { nsfFundingRss } from './nsf-funding-rss.js';
import { TIER_C_B_SOURCES } from './tier-c-b.js';
import { yaesuDr2x } from './yaesu-dr2x.js';

/**
 * The complete source registry. 27 modules (Tasks 7-15, 24, 27 and 28 push into it).
 *
 * DO NOT add any Grants.gov RSS feed here. All four advertised feeds
 * (https://grants.gov/rss/GGRSSSynopsisNew.xml and siblings) return HTTP 200 with
 * content-type text/html — a ~27 KB single-page-app shell, not XML. A naive poller finds
 * zero items forever and never errors. Use POST https://api.grants.gov/v1/api/search2,
 * which is key-free and returns real JSON (see sources/grants-gov-federal.ts).
 *
 * DO NOT add farweb.org, candid.org, fconline.foundationcenter.org, grantwatch.com,
 * grantstation.com or instrumentl.com. They are refused inside the fetcher.
 */
const MODULES: SourceModule[] = [
  ardcGrants,
  ardcAwardTables,
  arrlNewsRss,
  arrlScholarshipDescriptions,
  nsfFundingRss,
  ...TIER_C_B_SOURCES,
  yaesuDr2x,
];

export const SOURCES: readonly SourceModule[] = MODULES;

export function listSourceIds(): string[] {
  return MODULES.map((m) => m.id);
}

export function getSource(id: string): SourceModule {
  const found = MODULES.find((m) => m.id === id);
  if (!found) {
    throw new Error(`unknown source id "${id}"; known ids: ${listSourceIds().join(', ') || '(none)'}`);
  }
  return found;
}
