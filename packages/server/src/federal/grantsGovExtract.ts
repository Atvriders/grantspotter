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
 * 319,892,165 bytes of XML, 82,230 `OpportunitySynopsisDetail_1_0` elements, 89 of which clear
 * ADJACENCY_THRESHOLD.
 *
 * WHAT IT COSTS TO READ, AND WHY THE READER IS SHAPED THE WAY IT IS. Correctness came first
 * (651b9f3, the local-header size bug) and it was bought at a price nobody measured: reading one
 * of these files peaked at **2,940 MB of RSS** — measured end to end against the real archive on
 * this host, `records=89 wall=29.53s VmHWM=2940MB` — against a V8 heap ceiling of 4,144 MB. Four
 * copies of the corpus were alive at once: the 103,866,232-character base64 body, the 77.9 MB
 * archive it decodes to, the 319,892,165-byte inflated member, a 305 MiB JS string of the same
 * bytes, and on top of all of it a cheerio DOM of the WHOLE document plus 82,230 fully-populated
 * record objects. On the small self-hosted box this product is built for, that is an OOM waiting
 * for a slightly larger corpus, and an OOM in the nightly crawl is worse than a missing record.
 *
 * So: no whole-document string, no whole-document DOM, and no list of every record. `readExtract`
 * walks the inflated bytes, cuts them at record boundaries, parses 128 KiB of records at a time and
 * hands each one to a callback that is expected to keep the few it wants and drop the rest — and
 * the inflate itself no longer costs twice the member (see `inflateEntry`'s `chunkSize`). Measured
 * the same way afterwards: `records=89 wall=26.31s VmHWM=684MB`.
 *
 * WHAT IS STILL BIG, said plainly. Two things, and neither is hidden.
 *
 * The inflated member is one 305 MiB allocation, because `node:zlib` has no synchronous streaming
 * inflate and `SourceModule.parse` is synchronous. 618 MB of the 684 above is the moment it lands —
 * the base64 body, the archive it decodes to, and the member — and everything after that adds 66.
 * Removing it needs either an async `parse` (a change to the shared `SourceModule` contract) or a
 * pure-JS inflater, which the parser-layer import allow-list in `sources/registry.test.ts` does not
 * permit. Making it the LAST big allocation was the goal.
 *
 * And the wall clock is ~26 s, of which ~10.5 s is this file — decode, inflate and scan, the total
 * in the table under BATCH_BYTES. The rest is `scoreAdjacency` running over all 82,230 records,
 * which is the price of a bulk feed nobody wrote keywords for.
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

/**
 * Newest first. Yesterday's file is still there; last week's is not.
 *
 * THESE SEVEN URLS ARE ALTERNATIVES, NOT A SET. Each one is a full snapshot of the same corpus, so
 * the window exists only to find a day that answers — the crawl stops at the first archive whose
 * frame reads and never asks for the other six. See `sources/grants-gov-extract.ts`'s `answeredBy`
 * and `crawl/runner.ts`'s `AlternativeRequestsSource`.
 */
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

/**
 * The most inflated XML one day of the extract may hold before this reader refuses it BY NAME.
 *
 * 512 MiB. The live member measured 319,892,165 bytes (305.1 MiB) on 2026-08-10, so this is 1.68x
 * today's corpus — room for roughly 139,000 opportunities against today's 82,230, at the 3,838
 * bytes the average record occupies in the live file (measured; the largest is 27,997).
 *
 * WHY THERE IS A CEILING AT ALL. The inflated member is the one allocation left in this reader that
 * scales with the feed (see the header note), and a `parse` that quietly asks for whatever the
 * archive claims is a machine this product does not own. Above the ceiling the day is a READ
 * FAILURE with a message naming the two numbers — which lands in `sources.last_error` and shows the
 * source as `failing` — and NOT an empty feed. A ceiling that reports "0 records" would be the
 * 651b9f3 defect wearing a different hat.
 *
 * It is also enforced against the INFLATE itself and not only against the size the archive states,
 * because the stated size is a number in a file a stranger wrote.
 */
export const MAX_EXTRACT_XML_BYTES = 512 * 1024 * 1024;

/**
 * How much record XML is handed to cheerio at once.
 *
 * The DOM for one batch is the only DOM alive at a time, so this is the knob that used to be "the
 * whole document". Measured over the real 2026-08-10 member on this host, walking all 82,230
 * records and reporting VmHWM for the whole read (the inflated member alone accounts for 618 MB of
 * every figure here):
 *
 *     1 MiB    301 parses   746 MB   10.49 s
 *   256 KiB  1,194 parses   660 MB   10.37 s
 *   128 KiB  2,365 parses   640 MB   10.52 s
 *    64 KiB  4,646 parses   627 MB   10.67 s
 *
 * Wall clock is flat across the range and the peak has stopped moving by 128 KiB, which is where
 * this sits: ~33 records per parse, and 4.6x the largest single record in the live file (27,997
 * bytes), so a batch is always several whole records.
 */
const BATCH_BYTES = 128 * 1024;

/** Offset of the end-of-central-directory record, or -1. Scanned backwards: the comment is last. */
function findEndOfCentralDirectory(buf: Buffer): number {
  const earliest = Math.max(0, buf.length - END_OF_CENTRAL_DIRECTORY_LEN - MAX_ZIP_COMMENT);
  for (let at = buf.length - END_OF_CENTRAL_DIRECTORY_LEN; at >= earliest; at -= 1) {
    if (buf.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY_SIG) return at;
  }
  return -1;
}

/** Where the archive's single member is and how big it is, all read from the central directory. */
interface ExtractEntry {
  /** APPNOTE compression method: 0 stored, 8 deflated. Nothing else is supported. */
  method: number;
  /** Offset of the member's first data byte within the archive. */
  start: number;
  compressedSize: number;
  /** What the central directory says will come out. Believed only as far as the ceiling. */
  uncompressedSize: number;
}

/**
 * Find the archive's single member THROUGH THE CENTRAL DIRECTORY, and prove the frame is intact
 * without inflating a byte. No zip dependency enters the tree.
 *
 * THE SIZE COMES FROM THE CENTRAL DIRECTORY BECAUSE THE LOCAL HEADER'S IS ZERO. This used to read
 * `compressedSize` out of the local file header at offset 18, which is correct for an archive
 * written by a tool that knew the size before it started writing, and is wrong for every archive
 * written by one that streamed. Grants.gov streams. Measured against the live file on 2026-08-10 —
 * `curl -r 0-58 …/GrantsDBExtract20260809v2.zip`, and the 59 bytes are committed at
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
 *
 * EVERY CHECK HERE IS CHEAP AND NONE OF THEM INFLATE, which is what lets `isReadableExtract` ask
 * "is this day worth reading?" before the crawl decides whether it still needs the other six.
 */
function locateFirstEntry(buf: Buffer): ExtractEntry {
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
  const uncompressedSize = buf.readUInt32LE(centralAt + 24);
  const localAt = buf.readUInt32LE(centralAt + 42);
  // ZIP64 puts the real numbers in an extra field this reader does not walk. Named, not guessed:
  // the sentinel read as a length is a 4 GB subarray, and the failure would look like corruption.
  if (
    compressedSize === ZIP64_SENTINEL ||
    uncompressedSize === ZIP64_SENTINEL ||
    localAt === ZIP64_SENTINEL
  ) {
    throw new Error('ZIP64 archive: sizes live in an extra field this reader does not read');
  }
  if (
    localAt + LOCAL_FILE_HEADER_LEN > buf.length ||
    buf.readUInt32LE(localAt) !== LOCAL_FILE_HEADER_SIG
  ) {
    throw new Error('ZIP entry does not start at the offset its central directory gives');
  }
  if (method !== 0 && method !== 8) {
    throw new Error(`unsupported ZIP compression method ${String(method)}`);
  }
  // The LOCAL name and extra lengths, not the central ones: APPNOTE 4.4.28 lets the two extra
  // fields differ, and it is the local one that sits between the header and the bytes we want.
  const nameLength = buf.readUInt16LE(localAt + 26);
  const extraLength = buf.readUInt16LE(localAt + 28);
  const start = localAt + LOCAL_FILE_HEADER_LEN + nameLength + extraLength;
  // A SHORT DOWNLOAD IS CAUGHT HERE, and that is the whole reason the retention window still has
  // six other days in it: this is the failure that means "ask yesterday instead", as distinct from
  // "this reader is broken", which every day failing the same way means.
  if (start + compressedSize > buf.length) {
    throw new Error(
      `truncated ZIP archive: entry claims ${String(compressedSize)} compressed bytes, ` +
        `${String(Math.max(0, buf.length - start))} are present`,
    );
  }
  return { method, start, compressedSize, uncompressedSize };
}

/**
 * Does an intact, readable one-member archive live in this base64 body? NOTHING IS INFLATED.
 *
 * This is what the crawl asks after each day of the retention window, so that a nightly run
 * downloads ONE archive instead of seven. It answers the only question the window exists to
 * answer — "did this day give us a file we can read?" — and it answers it from the frame: the
 * signatures, the central directory, and whether the member's stated length is actually present.
 * A day cut short by a dropped connection fails here and the walk carries on to yesterday.
 *
 * It deliberately does NOT judge the size of what would come out. An archive too large for
 * MAX_EXTRACT_XML_BYTES is not a bad DAY — every other day of the window is the same corpus and
 * would be exactly as large — so it answers here, stops the walk, and is refused by name in
 * `readExtract` where the operator can see which number was exceeded.
 */
export function isReadableExtract(base64: string): boolean {
  try {
    locateFirstEntry(Buffer.from(base64, 'base64'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The archive's single member, inflated, as BYTES — never as a JS string.
 *
 * It returns a Buffer and not a string on purpose. `.toString('utf8')` on the live member mints a
 * second 305 MiB copy of the corpus that exists only to be scanned once and thrown away, and it was
 * one of the four copies behind the 2,940 MB peak this file's header records. `scanRecords` reads
 * the bytes directly and turns only one batch of records at a time into text.
 */
export function unzipFirstEntry(base64: string, maxXmlBytes = MAX_EXTRACT_XML_BYTES): Buffer {
  const buf = Buffer.from(base64, 'base64');
  const entry = locateFirstEntry(buf);
  return inflateEntry(buf, entry, maxXmlBytes);
}

/**
 * `maxXmlBytes` defaults to MAX_EXTRACT_XML_BYTES and is a parameter for exactly one reason: the
 * second gate below cannot otherwise be tested. Proving that a LYING central directory is caught by
 * the inflate itself needs a member that really does exceed the ceiling, and at the shipped value
 * that is a half-gigabyte allocation inside the unit suite. Same argument, and the same shape, as
 * `robotsTtlMs` in fetcher/index.ts.
 */
function inflateEntry(buf: Buffer, entry: ExtractEntry, maxXmlBytes: number): Buffer {
  if (entry.uncompressedSize > maxXmlBytes) {
    throw new Error(
      `extract member states ${String(entry.uncompressedSize)} bytes of XML, above this reader's ` +
        `${String(maxXmlBytes)}-byte ceiling (MAX_EXTRACT_XML_BYTES). Refused rather than ` +
        'allocated: this is a read failure, not an empty feed.',
    );
  }
  const body = buf.subarray(entry.start, entry.start + entry.compressedSize);
  if (entry.method === 0) return body;
  try {
    // `chunkSize` IS WHY THIS DOES NOT COST TWICE THE MEMBER. `zlibBufferSync` inflates into
    // `chunkSize` buffers, collects them in an array and `Buffer.concat`s at the end — so the
    // default 16 KiB chunk means the whole output exists twice at the moment it is joined, and the
    // live member measured a 541 MB step for a 320 MB result. One chunk large enough for the whole
    // member skips the join entirely: node returns the single buffer as-is. The central directory
    // has already told us exactly how big it is, and the ceiling above has already agreed to it.
    // Measured on the live archive: 419 MB peak and 725 ms, against 854 MB and 1,251 ms.
    // An archive that understates its own member simply gets the old two-buffer path back.
    return inflateRawSync(body, {
      chunkSize: Math.max(64, entry.uncompressedSize),
      maxOutputLength: maxXmlBytes,
    });
  } catch (err) {
    // The stated size is a number in a file a stranger wrote, so the ceiling is enforced against
    // the inflate as well. zlib reports the overrun as ERR_BUFFER_TOO_LARGE; say what it means.
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(
        `extract member inflated past this reader's ${String(maxXmlBytes)}-byte ceiling ` +
          `(MAX_EXTRACT_XML_BYTES) while its central directory stated only ` +
          `${String(entry.uncompressedSize)} bytes.`,
      );
    }
    throw err;
  }
}

/**
 * Does this archive's first entry state its sizes only AFTER the data (APPNOTE 4.4.4 bit 3)?
 *
 * Exported for the test that pins the shape of the real Grants.gov file against the 59 committed
 * bytes of its local header. Nothing in the read path branches on it — see `locateFirstEntry`.
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

const RECORD_NAME = 'OpportunitySynopsisDetail_1_0';
/** `<OpportunitySynopsisDetail_1_0`, with no `>`: see the shape check in `scanRecords`. */
const RECORD_OPEN = Buffer.from(`<${RECORD_NAME}`, 'utf8');
const RECORD_CLOSE = Buffer.from(`</${RECORD_NAME}`, 'utf8');
const GT = 0x3e;

/**
 * The element name the reader cuts on is spelled some way this reader does not handle.
 *
 * A SEPARATE, NAMED FAILURE RATHER THAN A QUIET MISS, because the alternative is the worst thing
 * this file could do. Cutting the document at `<OpportunitySynopsisDetail_1_0>` and
 * `</OpportunitySynopsisDetail_1_0>` is what replaces a whole-document DOM, and it assumes a bare
 * start tag and a bare end tag — which is what Grants.gov writes today (measured 2026-08-10:
 * 164,460 occurrences of the name in the live member, exactly two per record, no attributes, no
 * self-closing form, no CDATA and no comments anywhere in the file). If that ever changes, a
 * scanner that simply did not match would report a smaller corpus, or splice two records into one
 * and read the outer one's fields — a wrong answer delivered quietly. This makes it an outage.
 */
export class ExtractShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractShapeError';
  }
}

/**
 * Walk `xml` for complete `OpportunitySynopsisDetail_1_0` elements and hand each one to `onRecord`.
 *
 * ONE BATCH OF RECORDS IS PARSED AT A TIME AND THE CALLER IS EXPECTED TO KEEP ALMOST NONE OF THEM.
 * That is the whole memory design: the caller (`sources/grants-gov-extract.ts`) scores each record
 * for adjacency and keeps 89 of 82,230, so nothing but one BATCH_BYTES-sized DOM and the survivors
 * is ever alive. Returning an array instead — which is what this used to do, via `cheerio.load` over the
 * entire 305 MiB document — costs a DOM of the whole corpus AND 82,230 fully-populated record
 * objects carrying every Description string in the federal government.
 *
 * The 892 `OpportunityForecastDetail_1_0` elements in the same file are skipped by falling between
 * one record's end and the next record's start; they are forecasts, not posted opportunities.
 */
function scanRecords(xml: Buffer, onRecord: (record: ExtractOpportunity) => void): void {
  let batch: string[] = [];
  let batchBytes = 0;

  const flush = (): void => {
    if (batch.length === 0) return;
    // A run of sibling elements with no common root: htmlparser2 in xmlMode parses a fragment, and
    // `$(RECORD_NAME)` finds each of them, exactly as it did when the root was <Grants>.
    const $ = cheerio.load(batch.join(''), { xmlMode: true });
    batch = [];
    batchBytes = 0;
    $(RECORD_NAME).each((_, el) => {
      const $el = $(el);
      const text = (tag: string): string => $el.find(tag).first().text().trim();
      const opportunityId = text('OpportunityID');
      if (opportunityId === '') return;
      onRecord({
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
  };

  let at = 0;
  for (;;) {
    const open = xml.indexOf(RECORD_OPEN, at);
    if (open === -1) break;
    const afterName = open + RECORD_OPEN.length;
    if (xml[afterName] !== GT) {
      throw new ExtractShapeError(
        `<${RECORD_NAME} at byte ${String(open)} is not a bare start tag (attributes, or a ` +
          'self-closing element). This reader cuts the document on the bare form; see ' +
          'ExtractShapeError.',
      );
    }
    const close = xml.indexOf(RECORD_CLOSE, afterName);
    if (close === -1) {
      throw new ExtractShapeError(
        `<${RECORD_NAME}> at byte ${String(open)} is never closed: the archive is truncated or ` +
          'the element name has changed.',
      );
    }
    const end = close + RECORD_CLOSE.length;
    if (xml[end] !== GT) {
      throw new ExtractShapeError(
        `</${RECORD_NAME} at byte ${String(close)} is not a bare end tag. This reader cuts the ` +
          'document on the bare form; see ExtractShapeError.',
      );
    }
    batch.push(xml.toString('utf8', open, end + 1));
    batchBytes += end + 1 - open;
    if (batchBytes >= BATCH_BYTES) flush();
    at = end + 1;
  }
  flush();
}

/**
 * Read one day's archive, from the base64 body the fetcher produced, one record at a time.
 *
 * THE ONLY PRODUCTION READ PATH, and the only thing that inflates. Every failure it can have —
 * not a ZIP, truncated, ZIP64, an unsupported method, over the ceiling, an element shape this
 * reader does not cut on — throws. None of them returns an empty result, because "we could not
 * read it" and "there was nothing in it" are the two facts this product exists to keep apart.
 */
export function readExtract(
  base64: string,
  onRecord: (record: ExtractOpportunity) => void,
  maxXmlBytes = MAX_EXTRACT_XML_BYTES,
): void {
  scanRecords(unzipFirstEntry(base64, maxXmlBytes), onRecord);
}

/**
 * Every record in a run of extract XML, collected.
 *
 * The convenience form of `scanRecords`, for callers holding a small document — the committed
 * fixtures, and the tests that read them. The production path does NOT use it: collecting 82,230
 * records is one of the things `readExtract` exists to avoid.
 */
export function parseExtractXml(xml: string): ExtractOpportunity[] {
  const out: ExtractOpportunity[] = [];
  scanRecords(Buffer.from(xml, 'utf8'), (record) => out.push(record));
  return out;
}
