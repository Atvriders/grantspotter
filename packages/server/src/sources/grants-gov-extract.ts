import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import {
  GRANTS_GOV_EXTRACT_BASE,
  extractUrlsFor,
  isReadableExtract,
  readExtract,
} from '../federal/grantsGovExtract.js';

const SOURCE_ID = 'grants-gov-extract';

/** `MMDDYYYY` as published in the extract, to ISO `YYYY-MM-DD`. '' when absent or malformed. */
function isoDate(mmddyyyy: string): string {
  if (!/^\d{8}$/.test(mmddyyyy)) return '';
  return `${mmddyyyy.slice(4)}-${mmddyyyy.slice(0, 2)}-${mmddyyyy.slice(2, 4)}`;
}

/**
 * Every day of the retention window that a crawl actually asked for and got a body from, newest
 * first. A day that 404s carries no body and is not one of these; a day that 200s is.
 */
function usablePayloads(payloads: FetchedPayload[]): FetchedPayload[] {
  return payloads
    .filter((p) => p.url.startsWith(GRANTS_GOV_EXTRACT_BASE) && p.status === 200 && p.body !== '')
    .sort((a, b) => b.url.localeCompare(a.url));
}

/**
 * `crawl/runner.ts` calls the extra method below `AlternativeRequestsSource` and finds it
 * structurally. The interface is NOT imported from there, and the reason is a rule this file lives
 * under: `sources/registry.test.ts` follows every relative import out of `sources/` and fails if
 * the walk reaches `db/` or `api/`, which importing the crawl runner would immediately do. The
 * shape is pinned instead by a test — `crawl/runner.test.ts` asserts the registry's copy of this
 * module is recognised — so a rename on either side is a red, not a silent loss of the early stop.
 */
export const grantsGovExtract: SourceModule & {
  answeredBy(payload: FetchedPayload): boolean;
} = {
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
    'scorer surface a programme nobody wrote a keyword for. Retention is a ~7-day rolling window ' +
    'with no index page, so the module offers today and the six days behind it and treats 404s as ' +
    'normal — a missing day is not a failure. THE SEVEN ARE ALTERNATIVES, NOT A SET: each is a ' +
    'full snapshot of the same corpus, so the crawl stops at the first one whose archive frame ' +
    'reads (`answeredBy`) and never requests the rest. A healthy night is therefore ONE request ' +
    'and 77,899,674 bytes off this bucket, not seven and ~545 MB — which is what it was until ' +
    'the runner learned to stop. The archive is written by a STREAMING writer (its local file ' +
    'headers state no sizes), which is why the reader takes its lengths from the central ' +
    'directory; see fixtures/grants-gov-extract/README.md.',

  /**
   * Does this day answer the question the retention window exists to ask?
   *
   * Frame only — `isReadableExtract` inflates nothing (see its note). A 404, an empty body or an
   * archive cut short by a dropped connection is not an answer, and the crawl walks back to
   * yesterday. Anything else stops the walk, because every remaining day is a copy of the same
   * corpus and downloading six more of them buys nothing but 467 MB of traffic and disk.
   *
   * WHAT THE FRAME CANNOT SEE, said plainly: an archive whose header, central directory and length
   * all agree but whose deflate stream is corrupt inside. That day now ends the walk and then fails
   * in `parse`, where the old behaviour would have tried yesterday's file. The trade is deliberate.
   * The failure the window exists for is a SHORT read — the download that stopped early — and that
   * one is caught here, from the length. Corruption inside a complete object served by S3 is not a
   * thing the seven-day walk was protecting against, and paying six 77.9 MB requests every night to
   * insure against it is the cost this whole change exists to stop paying. It is also not silent:
   * `parse` throws, and the source reads `failing` with the reason.
   */
  answeredBy(payload: FetchedPayload): boolean {
    return (
      payload.url.startsWith(GRANTS_GOV_EXTRACT_BASE) &&
      payload.status === 200 &&
      payload.body !== '' &&
      isReadableExtract(payload.body)
    );
  },

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    // Newest successful payload wins. Normally there is exactly one, because `answeredBy` stopped
    // the crawl at it; more than one means the newer days did not answer.
    const usable = usablePayloads(payloads);
    // WHY THE FAILURES ARE REMEMBERED. Skipping a day we could not read is right — one truncated
    // download out of seven is not an outage — but the `catch { continue }` this used to be turned
    // "we could not read ANY of the seven" into an empty array, which is the same value a genuinely
    // quiet day returns. That is the exact conflation this product exists to refuse, and it is what
    // hid the local-header size bug (see `locateFirstEntry`) behind a `Parsed 0 records` alarm for
    // the whole life of the module. A reader that failed on every archive it was given is a broken
    // reader, and the honest health state for it is `failing`, which is what throwing produces.
    let lastUnreadable: unknown;
    let readAny = false;
    for (const payload of usable) {
      const out: RawOpportunity[] = [];
      try {
        // Scored and discarded one record at a time. `readExtract` never builds a list of all
        // 82,230 and this loop keeps 89 of them, which is the reason a 305 MiB corpus can be read
        // on a small box at all — see the header of federal/grantsGovExtract.ts.
        readExtract(payload.body, (row) => {
          const scored = scoreAdjacency([row.title, row.agencyName, row.description].join('\n'));
          if (scored.score < ADJACENCY_THRESHOLD) return;
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
        });
        readAny = true;
      } catch (err) {
        lastUnreadable = err;
        continue; // a truncated or non-ZIP body is just a day we skip
      }
      if (out.length > 0) return out;
      // Read, and holding nothing we score as adjacent. A real answer about the corpus, so the loop
      // keeps walking back — an older archive is a superset far more often than not.
    }
    // One archive we could read is enough to know the reader is not the problem, whatever the other
    // six days did. Zero of them, with days that answered 200, is not an empty corpus.
    if (readAny) return [];
    if (lastUnreadable !== undefined) throw lastUnreadable;
    // AND NEITHER IS ZERO DAYS THAT ANSWERED AT ALL, which is the half of this that 651b9f3 left
    // open. Every day 404ing means the bucket, the path or the filename convention has moved — a
    // whole federal feed gone — and returning [] reported that as "the federal corpus is empty
    // tonight", the same sentence a working reader over an empty corpus would produce. There is no
    // day of the year on which Grants.gov publishes no extract, so this is never a quiet Tuesday.
    const statuses = payloads
      .filter((p) => p.url.startsWith(GRANTS_GOV_EXTRACT_BASE))
      .map((p) => `${p.url.slice(GRANTS_GOV_EXTRACT_BASE.length)} ${String(p.status)}`);
    throw new Error(
      `no day of the Grants.gov extract retention window returned a body: ` +
        `${statuses.length === 0 ? '(no extract request was made)' : statuses.join(', ')}. ` +
        'The bucket, the path or the date-stamped filename has moved; this is a read failure, ' +
        'not an empty feed.',
    );
  },
};
