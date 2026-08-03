import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import {
  GRANTS_GOV_EXTRACT_BASE,
  extractUrlsFor,
  parseExtractXml,
  unzipFirstEntry,
} from '../federal/grantsGovExtract.js';

const SOURCE_ID = 'grants-gov-extract';

/** `MMDDYYYY` as published in the extract, to ISO `YYYY-MM-DD`. '' when absent or malformed. */
function isoDate(mmddyyyy: string): string {
  if (!/^\d{8}$/.test(mmddyyyy)) return '';
  return `${mmddyyyy.slice(4)}-${mmddyyyy.slice(0, 2)}-${mmddyyyy.slice(2, 4)}`;
}

export const grantsGovExtract: SourceModule = {
  id: SOURCE_ID,
  funderId: 'federal',
  label: 'Grants.gov daily XML extract (bulk backbone)',
  tier: 'A',
  klass: 'adjacent_stem',
  // A function so the date window is computed at crawl time, not at module load.
  requests: async (): Promise<FetchRequest[]> =>
    extractUrlsFor(new Date()).map((url) => ({ url, method: 'GET', accept: 'binary' })),
  expectedMinRecords: 1,
  notes:
    'Spec §7.4 names this file as the replacement for the four broken Grants.gov RSS feeds, ' +
    'alongside search2. search2 is keyword-driven and can only find what we thought to ask for; ' +
    'this is the whole posted corpus in one ~77.85 MB file, which is what lets the adjacency ' +
    'scorer surface a programme nobody wrote a keyword for. Retention is a ~7-day rolling ' +
    'window with no index page, so the module requests today and walks back a week and treats ' +
    '404s as normal — a missing day is not a failure. ONE request per day of the window, never ' +
    'one per keyword.',

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    // Newest successful payload wins; the rest of the retention window is redundant.
    const usable = payloads
      .filter((p) => p.url.startsWith(GRANTS_GOV_EXTRACT_BASE) && p.status === 200 && p.body !== '')
      .sort((a, b) => b.url.localeCompare(a.url));
    for (const payload of usable) {
      let rows: ReturnType<typeof parseExtractXml>;
      try {
        rows = parseExtractXml(unzipFirstEntry(payload.body));
      } catch {
        continue; // a truncated or non-ZIP body is just a day we skip
      }
      const out: RawOpportunity[] = [];
      for (const row of rows) {
        const scored = scoreAdjacency([row.title, row.agencyName, row.description].join('\n'));
        if (scored.score < ADJACENCY_THRESHOLD) continue;
        out.push({
          sourceId: SOURCE_ID,
          externalKey: row.opportunityId,
          name: row.title,
          sourceUrl: `https://grants.gov/search-results-detail/${row.opportunityId}`,
          rawText: row.description,
          rawFields: {
            federalSource: 'daily-extract',
            opportunityNumber: row.opportunityNumber,
            agency: row.agencyName,
            postDate: isoDate(row.postDate),
            closeDate: isoDate(row.closeDate),
            oppStatus: row.oppStatus,
            adjacencyScore: String(scored.score),
            adjacencyHits: scored.hits.join(', '),
          },
        });
      }
      if (out.length > 0) return out;
    }
    return [];
  },
};
