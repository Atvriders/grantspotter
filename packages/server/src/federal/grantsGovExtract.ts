import { inflateRawSync } from 'node:zlib';
import * as cheerio from 'cheerio';

/**
 * The Grants.gov DAILY XML EXTRACT — spec §7.4's replacement for the four broken RSS feeds,
 * and the bulk backbone behind the targeted `search2` probe in federal/grantsGov.ts.
 *
 * search2 is keyword-driven, so it can only find what we thought to ask for. The extract is the
 * whole posted corpus in one file, which is what lets the adjacency scorer surface a programme
 * nobody wrote a keyword for.
 *
 * Facts: ~77.85 MB compressed, so ONE request per night, never one per keyword. Retention is a
 * ~7-day rolling window with no index page, so we walk back day by day and treat 404s as normal.
 * The name is UTC-date-stamped and the `v2` is part of the filename.
 *
 * This lives in federal/, not sources/, because it needs node:zlib and `sources/*` must not.
 */
export const GRANTS_GOV_EXTRACT_BASE =
  'https://prod-grants-gov-chatbot.s3.amazonaws.com/extracts/';
export const GRANTS_GOV_EXTRACT_RETENTION_DAYS = 7;

export function extractUrlFor(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${GRANTS_GOV_EXTRACT_BASE}GrantsDBExtract${yyyy}${mm}${dd}v2.zip`;
}

/** Newest first. Yesterday's file is still there; last week's is not. */
export function extractUrlsFor(today: Date, days = GRANTS_GOV_EXTRACT_RETENTION_DAYS): string[] {
  const out: string[] = [];
  for (let back = 0; back < days; back += 1) {
    out.push(extractUrlFor(new Date(today.getTime() - back * 86_400_000)));
  }
  return out;
}

/**
 * Minimal ZIP reader: the archive holds exactly one deflated member, so we read the first local
 * file header and inflate. No zip dependency enters the tree for one known-shape archive.
 */
export function unzipFirstEntry(base64: string): string {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('not a ZIP archive: missing local file header signature');
  }
  const method = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const nameLength = buf.readUInt16LE(26);
  const extraLength = buf.readUInt16LE(28);
  const start = 30 + nameLength + extraLength;
  const body = buf.subarray(start, start + compressedSize);
  if (method === 0) return body.toString('utf8');
  if (method !== 8) throw new Error(`unsupported ZIP compression method ${method}`);
  return inflateRawSync(body).toString('utf8');
}

export interface ExtractOpportunity {
  opportunityId: string;
  opportunityNumber: string;
  title: string;
  agencyName: string;
  description: string;
  postDate: string;
  closeDate: string;
  oppStatus: string;
}

export function parseExtractXml(xml: string): ExtractOpportunity[] {
  if (!/<\s*OpportunitySynopsisDetail_1_0\b/i.test(xml)) return [];
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: ExtractOpportunity[] = [];
  $('OpportunitySynopsisDetail_1_0').each((_, el) => {
    const $el = $(el);
    const text = (tag: string): string => $el.find(tag).first().text().trim();
    const opportunityId = text('OpportunityID');
    if (opportunityId === '') return;
    out.push({
      opportunityId,
      opportunityNumber: text('OpportunityNumber'),
      title: text('OpportunityTitle'),
      agencyName: text('AgencyName'),
      description: text('Description'),
      postDate: text('PostDate'),
      closeDate: text('CloseDate'),
      oppStatus: text('OppStatus'),
    });
  });
  return out;
}
