import * as cheerio from 'cheerio';
import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';

const SOURCE_ID = 'ardc-award-tables';
const FIRST_YEAR = 2019;

export function grantYearUrls(nowISO: string): string[] {
  const currentYear = new Date(nowISO).getUTCFullYear();
  const urls: string[] = [];
  for (let year = FIRST_YEAR; year <= currentYear; year += 1) {
    urls.push(`https://www.ardc.net/apply/grants/${year}-grants/`);
  }
  return urls;
}

const YEAR_FROM_URL = /\/(\d{4})-grants\/?$/;

/**
 * Each ardc.net/apply/grants/{YYYY}-grants/ page carries one 4-column table:
 * Date | Grantee | Project | Amount. A footer table with a different column count must not be
 * mistaken for the award table.
 *
 * Amounts are kept VERBATIM and never coerced. The real 2019-2026 capture contains "TBD" (14
 * rows, in 2025 as well as 2026), "$200,000 (max)", "$15,262.50", "$558,761 CAD", "$11,550 CHF",
 * "£153,234", "€163.400" (European decimal separator) and "€8,000 /$8,700 US dollars". An
 * unknown or foreign amount must render as written, with a source link, rather than silently
 * become $0 or a wrong-currency number.
 *
 * Dates are equally irregular and equally verbatim: "2019-09-01", "2021-12", "Apr 2022",
 * "November 2023", "May 2026".
 *
 * `granteeUrl`, NOT `detailUrl` — REAL-CAPTURE FIX (2026-08-03). Where the grantee cell is
 * linked (345 of 424 rows) the link goes to THE GRANTEE'S OWN SITE, across 256 distinct hosts:
 * arrl.org, sites.google.com, facebook.com, github.com, a university department page. Not one
 * single row links to ardc.net, and there is no such thing as the "/grant-{slug}/ detail page"
 * this parser was originally written against. The name matters because `normalize/` reads
 * `rawFields.detailUrl` as the program's applyUrl (`formUrl ?? detailUrl ?? sourceUrl`), so
 * under the old name a past award's "where to apply" link was a recipient's Facebook page.
 * Under `granteeUrl` the fallback correctly yields the ARDC year page, and the grantee link is
 * still kept as evidence of who was funded.
 */
export function parseAwardTable(html: string, year: number, sourceUrl: string): RawOpportunity[] {
  const $ = cheerio.load(html);
  const out: RawOpportunity[] = [];

  $('table').each((_, table) => {
    const rows = $(table).find('tr');
    // Only the award table has four cells per row.
    const isAwardTable = rows.toArray().some((tr) => $(tr).find('td, th').length === 4);
    if (!isAwardTable) return;

    rows.each((__, tr) => {
      const cells = $(tr).find('td');
      if (cells.length !== 4) return; // skips the header row, which uses <th>
      const date = $(cells[0]).text().trim();
      const grantee = $(cells[1]).text().trim();
      const project = $(cells[2]).text().trim();
      const amountRaw = $(cells[3]).text().trim();
      if (grantee === '' && project === '') return;

      const href = $(cells[1]).find('a').attr('href');
      const rawFields: Record<string, string> = {
        recordType: 'past_award',
        year: String(year),
        date,
        grantee,
        project,
        amountRaw,
      };
      if (href) rawFields.granteeUrl = new URL(href, sourceUrl).toString();

      out.push({
        sourceId: SOURCE_ID,
        externalKey: `${year}|${grantee}|${project}`,
        name: `${grantee} — ${project} (${year})`,
        rawFields,
        sourceUrl,
        rawText: [date, grantee, project, amountRaw].filter(Boolean).join(' | '),
      });
    });
  });

  return out;
}

export const ardcAwardTables: SourceModule = {
  id: SOURCE_ID,
  funderId: 'ardc',
  label: 'ARDC per-year award tables',
  tier: 'C',
  klass: 'ham_grant',
  requests: (): Promise<FetchRequest[]> =>
    Promise.resolve(
      grantYearUrls(new Date().toISOString()).map((url) => ({
        url,
        method: 'GET' as const,
        accept: 'html' as const,
      })),
    ),
  expectedMinRecords: 40,
  notes:
    'Past awards, not opportunities: every record carries recordType=past_award and normalize/ ' +
    'gives it status=closed and the do_not_publish tag, so it never appears as a live deadline ' +
    'and never enters the review queue. Eight years of 4-column tables (Date | Grantee | ' +
    'Project | Amount) at /apply/grants/{YYYY}-grants/ — 424 awards as captured on 2026-08-03, ' +
    'growing every year (2019 genuinely has only 2 rows; it was ARDC’s first year). Where the ' +
    'grantee cell is linked it links to the GRANTEE’s own site, not to anything on ardc.net, so ' +
    'it is stored as granteeUrl and deliberately not as the applyUrl-bearing detailUrl. Amounts ' +
    'and dates are wildly irregular and kept verbatim (TBD, "(max)", CAD/CHF/EUR/GBP, ' +
    '"Apr 2022"). A funder’s actual grant history is the best available evidence of what that ' +
    'funder funds.',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    for (const payload of payloads) {
      if (payload.status !== 200) continue;
      const m = YEAR_FROM_URL.exec(new URL(payload.url).pathname);
      if (!m) continue;
      out.push(...parseAwardTable(payload.body, Number.parseInt(m[1], 10), payload.url));
    }
    return out;
  },
};
