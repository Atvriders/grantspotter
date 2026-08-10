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
 * MEASURED AGAINST THE LIVE FILE, 2026-08-10 (`GrantsDBExtract20260809v2.zip`, HTTP 200,
 * `content-type: application/zip`): 77,899,674 bytes on the wire, one deflated member holding
 * 319,892,165 bytes of XML, 82,230 `OpportunitySynopsisDetail_1_0` elements. The "~77.85 MB" above
 * is the compressed figure only; the ~305 MiB that comes out of it is what `parseExtractXml` has to
 * hold, and it is the reason this file is read once per run and not once per keyword.
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

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIRECTORY_SIG = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIG = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_LEN = 22;
const CENTRAL_DIRECTORY_LEN = 46;
const LOCAL_FILE_HEADER_LEN = 30;
/** A 32-bit field set to all-ones means "the real value is in a ZIP64 extra field". */
const ZIP64_SENTINEL = 0xffffffff;
/** APPNOTE 4.4.4 bit 3: the sizes in the LOCAL header are zero and follow the data instead. */
const FLAG_DATA_DESCRIPTOR = 0x0008;
/** The comment is a `uint16` count of bytes, so the EOCD starts at most this far from the end. */
const MAX_ZIP_COMMENT = 0xffff;

/** Offset of the end-of-central-directory record, or -1. Scanned backwards: the comment is last. */
function findEndOfCentralDirectory(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - END_OF_CENTRAL_DIRECTORY_LEN - MAX_ZIP_COMMENT);
  for (let at = buf.length - END_OF_CENTRAL_DIRECTORY_LEN; at >= earliest; at -= 1) {
    if (buf.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY_SIG) return at;
  }
  return -1;
}

/**
 * Minimal ZIP reader: the archive holds exactly one deflated member, so we find that member
 * through the CENTRAL DIRECTORY and inflate it. No zip dependency enters the tree.
 *
 * THE SIZE COMES FROM THE CENTRAL DIRECTORY BECAUSE THE LOCAL HEADER'S IS ZERO. This function used
 * to read `compressedSize` out of the local file header at offset 18, which is correct for an
 * archive written by a tool that knew the size before it started writing, and is wrong for every
 * archive written by one that streamed. Grants.gov streams. Measured against the live file on
 * 2026-08-10 — `curl -r 0-58 …/GrantsDBExtract20260809v2.zip`, and the 59 bytes are committed at
 * `fixtures/grants-gov-extract/real-local-file-header.b64`:
 *
 *     general purpose bit flag  0x0808   (bit 3: sizes follow the data; bit 11: UTF-8 name)
 *     crc-32                    0
 *     compressed size           0
 *     uncompressed size         0
 *
 * so `buf.subarray(start, start + 0)` was an EMPTY buffer, `inflateRawSync` threw "unexpected end
 * of file", and `sources/grants-gov-extract.ts` caught that as "a truncated day, skip it" — for
 * every one of the seven days in the retention window, every night, since the module shipped. The
 * source reported `Parsed 0 records` against a feed holding 82,230 opportunities. The committed
 * fixture never caught it because `scripts/make-extract-fixture.mjs` builds its archive with the
 * sizes filled in, which is the one field the real file does not fill in.
 *
 * The central directory is written AFTER the data, so its copy of the size is always the real one —
 * true for a streamed archive and for a seekable one alike, which is why this reads it
 * unconditionally rather than branching on the flag.
 */
export function unzipFirstEntry(base64: string): string {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < LOCAL_FILE_HEADER_LEN || buf.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIG) {
    throw new Error('not a ZIP archive: missing local file header signature');
  }
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd === -1) {
    throw new Error('not a ZIP archive: no end-of-central-directory record');
  }
  const entries = buf.readUInt16LE(eocd + 10);
  if (entries < 1) throw new Error('ZIP archive holds no entries');
  const centralAt = buf.readUInt32LE(eocd + 16);
  if (
    centralAt + CENTRAL_DIRECTORY_LEN > buf.length ||
    buf.readUInt32LE(centralAt) !== CENTRAL_DIRECTORY_SIG
  ) {
    throw new Error('ZIP central directory is missing or misplaced');
  }

  const method = buf.readUInt16LE(centralAt + 10);
  const compressedSize = buf.readUInt32LE(centralAt + 20);
  const localAt = buf.readUInt32LE(centralAt + 42);
  // ZIP64 puts the real numbers in an extra field this reader does not walk. Named, not guessed:
  // the sentinel read as a length is a 4 GB subarray, and the failure would look like corruption.
  if (compressedSize === ZIP64_SENTINEL || localAt === ZIP64_SENTINEL) {
    throw new Error('ZIP64 archive: sizes live in an extra field this reader does not read');
  }
  if (
    localAt + LOCAL_FILE_HEADER_LEN > buf.length ||
    buf.readUInt32LE(localAt) !== LOCAL_FILE_HEADER_SIG
  ) {
    throw new Error('ZIP entry does not start at the offset its central directory gives');
  }
  // The LOCAL name and extra lengths, not the central ones: APPNOTE 4.4.28 lets the two extra
  // fields differ, and it is the local one that sits between the header and the bytes we want.
  const nameLength = buf.readUInt16LE(localAt + 26);
  const extraLength = buf.readUInt16LE(localAt + 28);
  const start = localAt + LOCAL_FILE_HEADER_LEN + nameLength + extraLength;
  const body = buf.subarray(start, start + compressedSize);
  if (body.length !== compressedSize) {
    throw new Error(
      `truncated ZIP archive: entry claims ${String(compressedSize)} compressed bytes, ` +
        `${String(body.length)} are present`,
    );
  }
  if (method === 0) return body.toString('utf8');
  if (method !== 8) throw new Error(`unsupported ZIP compression method ${String(method)}`);
  return inflateRawSync(body).toString('utf8');
}

/**
 * Does this archive's first entry state its sizes only AFTER the data (APPNOTE 4.4.4 bit 3)?
 *
 * Exported for the test that pins the shape of the real Grants.gov file against the 59 committed
 * bytes of its local header. Nothing in the read path branches on it — see `unzipFirstEntry`.
 */
export function usesDataDescriptor(localFileHeader: Buffer): boolean {
  return (localFileHeader.readUInt16LE(6) & FLAG_DATA_DESCRIPTOR) !== 0;
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
