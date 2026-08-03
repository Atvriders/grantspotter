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
 * Date | Grantee | Project | Amount. Some rows link the grantee cell to a /grant-{slug}/
 * detail page, some do not. 2026 amounts are partly the literal string "TBD" — kept verbatim,
 * never coerced to a number or dropped, because that string is real source data: an unknown
 * amount should render as "amount unknown" with a source link rather than silently become $0.
 * A footer table with a different column count must not be mistaken for the award table.
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
      if (href) rawFields.detailUrl = new URL(href, sourceUrl).toString();

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
    'gives it status=closed, so it never appears as a live deadline. Eight-plus years of ' +
    '4-column tables (Date | Grantee | Project | Amount) at /apply/grants/{YYYY}-grants/. ' +
    'Some rows link to a /grant-{slug}/ detail page, some do not. 2026 amounts are partly the ' +
    'literal string "TBD" and are kept verbatim. A funder’s actual grant history is the best ' +
    'available evidence of what that funder funds.',
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
