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
    'one per keyword. WHAT THAT COSTS, measured 2026-08-10: each day of the window is its own ' +
    'copy of the whole corpus at 77,899,674 bytes, the runner fetches every request before it ' +
    'parses any of them, and only the newest readable one is used — so a nightly run downloads ' +
    'up to ~545 MB from this bucket and discards six sevenths of it. The archive is written by a ' +
    'STREAMING writer (its local file headers state no sizes), which is why the reader takes its ' +
    'lengths from the central directory; see fixtures/grants-gov-extract/README.md.',

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    // Newest successful payload wins; the rest of the retention window is redundant.
    const usable = payloads
      .filter((p) => p.url.startsWith(GRANTS_GOV_EXTRACT_BASE) && p.status === 200 && p.body !== '')
      .sort((a, b) => b.url.localeCompare(a.url));
    // WHY THE FAILURES ARE REMEMBERED. Skipping a day we could not read is right — one truncated
    // download out of seven is not an outage — but the `catch { continue }` this used to be turned
    // "we could not read ANY of the seven" into an empty array, which is the same value a genuinely
    // quiet day returns. That is the exact conflation this product exists to refuse, and it is what
    // hid the local-header size bug (see `unzipFirstEntry`) behind a `Parsed 0 records` alarm for
    // the whole life of the module. A reader that failed on every archive it was given is a broken
    // reader, and the honest health state for it is `failing`, which is what throwing produces.
    let lastUnreadable: unknown;
    let readAny = false;
    for (const payload of usable) {
      let rows: ReturnType<typeof parseExtractXml>;
      try {
        rows = parseExtractXml(unzipFirstEntry(payload.body));
        readAny = true;
      } catch (err) {
        lastUnreadable = err;
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
      // Read, and holding nothing we score as adjacent. A real answer about the corpus, so the loop
      // keeps walking back — an older archive is a superset far more often than not.
    }
    // One archive we could read is enough to know the reader is not the problem, whatever the other
    // six days did. Zero of them, with days that answered 200, is not an empty corpus.
    if (!readAny && lastUnreadable !== undefined) throw lastUnreadable;
    return [];
  },
};
