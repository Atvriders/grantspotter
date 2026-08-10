import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import {
  ExtractShapeError,
  GRANTS_GOV_EXTRACT_BASE,
  GRANTS_GOV_EXTRACT_RETENTION_DAYS,
  MAX_EXTRACT_XML_BYTES,
  extractUrlFor,
  extractUrlsFor,
  isReadableExtract,
  parseExtractXml,
  readExtract,
  unzipFirstEntry,
  usesDataDescriptor,
} from '../federal/grantsGovExtract.js';
import { resolveRequests } from './types.js';
import { grantsGovExtract } from './grants-gov-extract.js';

const NOW = '2026-08-02T00:00:00.000Z';
const zipBase64 = () => loadFixture('grants-gov-extract', '00-extract.zip.b64');
/** The shape Grants.gov actually sends: sizes in a trailing descriptor, zeroes in the header. */
const streamedZipBase64 = () => loadFixture('grants-gov-extract', '01-extract-streamed.zip.b64');
const realBytes = (file: string) =>
  Buffer.from(loadFixture('grants-gov-extract', file), 'base64');

/**
 * A one-member STORED (uncompressed) archive, base64'd — the third writer shape, built here rather
 * than committed because the only test that needs it needs to choose the XML inside it. Also the
 * only coverage of `unzipFirstEntry`'s `method === 0` branch.
 */
function storedZip(xml: string): string {
  const name = Buffer.from('GrantsDBExtract20260802v2.xml', 'ascii');
  const data = Buffer.from(xml, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0, 10); // method: stored
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]).toString('base64');
}

const payload = (over: { status?: number; body?: string } = {}) => ({
  url: extractUrlFor(new Date(NOW)),
  status: over.status ?? 200,
  contentType: 'application/zip',
  body: over.body ?? zipBase64(),
  fetchedAt: NOW,
});

describe('extractUrlFor', () => {
  it('builds the date-stamped v2 filename in UTC', () => {
    expect(extractUrlFor(new Date('2026-08-02T23:30:00.000Z'))).toBe(
      `${GRANTS_GOV_EXTRACT_BASE}GrantsDBExtract20260802v2.zip`,
    );
  });

  it('zero-pads the month and day', () => {
    expect(extractUrlFor(new Date('2026-01-05T00:00:00.000Z'))).toContain('GrantsDBExtract20260105v2.zip');
  });
});

describe('extractUrlsFor', () => {
  it('walks back over the seven-day rolling retention window, newest first', () => {
    const urls = extractUrlsFor(new Date(NOW));
    expect(urls).toHaveLength(GRANTS_GOV_EXTRACT_RETENTION_DAYS);
    expect(urls[0]).toContain('20260802');
    expect(urls[1]).toContain('20260801');
    expect(urls[6]).toContain('20260727');
  });
});

describe('unzipFirstEntry', () => {
  it('inflates the single XML member without a zip dependency', () => {
    const xml = unzipFirstEntry(zipBase64()).toString('utf8');
    expect(xml).toContain('<OpportunityID>354102</OpportunityID>');
    expect(xml).toContain('Geospace Facilities');
  });

  /**
   * IT RETURNS BYTES, and that is the whole reason a 305 MiB member can be read on a small box.
   * `.toString('utf8')` on the live archive mints a second 305 MiB copy of the corpus that exists
   * only to be scanned once, and it was one of the four simultaneous copies behind the measured
   * 2,940 MB peak. Pinned as a type-level fact because "it happens to be a Buffer today" is exactly
   * the kind of thing a later convenience edit turns back into a string.
   */
  it('hands back the member as bytes, never as one enormous string', () => {
    expect(Buffer.isBuffer(unzipFirstEntry(zipBase64()))).toBe(true);
  });

  it('throws a named error on something that is not a ZIP', () => {
    expect(() => unzipFirstEntry(Buffer.from('nope').toString('base64'))).toThrow(/ZIP/i);
  });

  /**
   * THE DEFECT THIS MODULE SHIPPED WITH, and the only fixture shape that can catch it.
   *
   * A streaming writer does not know the compressed size when it writes the local file header, so
   * it writes zeroes there and restates the real numbers in a data descriptor after the deflate
   * stream. The reader used to take its length from the local header, slice `0` bytes, and throw —
   * on every archive Grants.gov has ever served. See fixtures/grants-gov-extract/README.md for the
   * 2026-08-10 measurement of the live file and the 59 bytes of it committed beside this test.
   */
  it('inflates an archive whose local header states no size, because the real one does not', () => {
    const zip = Buffer.from(streamedZipBase64(), 'base64');
    expect(zip.readUInt16LE(6)).toBe(0x0808);
    expect(zip.readUInt32LE(18)).toBe(0); // compressed size, in the local header
    expect(zip.readUInt32LE(22)).toBe(0); // uncompressed size, in the local header

    const xml = unzipFirstEntry(streamedZipBase64());
    expect(xml.toString('utf8')).toContain('<OpportunityID>354102</OpportunityID>');
    expect(xml.toString('utf8')).toContain('Geospace Facilities');
    // Byte-identical to the seekable archive: the two fixtures differ only in how they say how
    // long the member is, which is the whole point of having both.
    expect(xml.equals(unzipFirstEntry(zipBase64()))).toBe(true);
  });

  it('names ZIP64 rather than reading a sentinel as a four-gigabyte length', () => {
    const zip = Buffer.from(streamedZipBase64(), 'base64');
    const eocd = zip.length - 22;
    const central = zip.readUInt32LE(eocd + 16);
    zip.writeUInt32LE(0xffffffff, central + 20); // compressed size
    expect(() => unzipFirstEntry(zip.toString('base64'))).toThrow(/ZIP64/);
  });

  /**
   * A CEILING THAT REPORTS ITSELF. The inflated member is the one allocation in this reader that
   * scales with the federal corpus, and `parse` is synchronous, so there is a size above which
   * reading a day would cost the machine more than the day is worth. Above it the day must be a
   * READ FAILURE naming both numbers — never zero records, which is the 651b9f3 defect in
   * different clothing.
   *
   * Driven through the central directory's stated size rather than by building a half-gigabyte
   * fixture: that field is what the reader consults before it allocates anything, which is the
   * property under test.
   */
  it('refuses an archive that states more XML than the ceiling, by name', () => {
    const zip = Buffer.from(streamedZipBase64(), 'base64');
    const central = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(MAX_EXTRACT_XML_BYTES + 1, central + 24); // uncompressed size
    expect(() => unzipFirstEntry(zip.toString('base64'))).toThrow(/MAX_EXTRACT_XML_BYTES/);
  });

  /**
   * ...AND THE STATED SIZE IS NOT BELIEVED ON ITS OWN. It is a number in a file a stranger wrote,
   * so the same ceiling is handed to zlib as `maxOutputLength`. Here the central directory says the
   * member is 8 bytes and the deflate stream really holds hundreds: the read still stops at the
   * ceiling, and says which of the two numbers was the lie.
   *
   * The ceiling is injected because the shipped one is 512 MiB and proving this at that value means
   * allocating half a gigabyte inside the unit suite. Same value, same code path, smaller number.
   */
  it('holds the ceiling against the inflate itself, not only against the stated size', () => {
    const zip = Buffer.from(streamedZipBase64(), 'base64');
    const central = zip.readUInt32LE(zip.length - 22 + 16);
    const real = zip.readUInt32LE(central + 24);
    expect(real).toBeGreaterThan(64);
    zip.writeUInt32LE(8, central + 24); // the archive now understates its member by ~two orders
    const b64 = zip.toString('base64');
    // Under the injected ceiling by its own account, so the first gate lets it through...
    expect(() => unzipFirstEntry(b64, 64)).toThrow(/inflated past/);
    // ...and the honest number would have been refused by the first gate instead.
    expect(() => unzipFirstEntry(zipBase64(), 64)).toThrow(/states \d+ bytes of XML/);
  });
});

/**
 * Verbatim bytes of the LIVE archive, 2026-08-10 — 59 from its head and 113 from its tail. Neither
 * is a working ZIP (the 77.9 MB between them is not committed), so these assert on the frame only.
 * They are here so that the fact the reader now depends on is pinned to the real file rather than
 * to a generator this repository also owns.
 */
describe('the live archive frame (REAL bytes)', () => {
  const head = realBytes('real-local-file-header.b64');
  const tail = realBytes('real-central-directory.b64');

  it('states its sizes AFTER the data, and so states zero in the local header', () => {
    expect(head.readUInt32LE(0)).toBe(0x04034b50);
    expect(usesDataDescriptor(head)).toBe(true);
    expect(head.readUInt16LE(6)).toBe(0x0808);
    expect(head.readUInt32LE(14)).toBe(0); // crc-32
    expect(head.readUInt32LE(18)).toBe(0); // compressed size
    expect(head.readUInt32LE(22)).toBe(0); // uncompressed size
    expect(head.subarray(30).toString('ascii')).toBe('GrantsDBExtract20260809v2.xml');
  });

  it('carries the true sizes in its central directory, which is where the reader looks', () => {
    // Layout of the committed 113 bytes: data descriptor (16), central directory record (75),
    // end-of-central-directory (22).
    const central = 16;
    const eocd = 91;
    expect(tail.readUInt32LE(0)).toBe(0x08074b50);
    expect(tail.readUInt32LE(central)).toBe(0x02014b50);
    expect(tail.readUInt16LE(central + 8)).toBe(0x0808);
    expect(tail.readUInt32LE(central + 20)).toBe(77_899_502); // compressed
    expect(tail.readUInt32LE(central + 24)).toBe(319_892_165); // uncompressed
    expect(tail.readUInt32LE(central + 42)).toBe(0); // local header offset
    expect(tail.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(tail.readUInt16LE(eocd + 10)).toBe(1); // one member, as the reader assumes
  });
});

describe('parseExtractXml', () => {
  it('reads every opportunity in the archive', () => {
    const rows = parseExtractXml(unzipFirstEntry(zipBase64()).toString('utf8'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      opportunityId: '354102',
      opportunityNumber: 'NSF 26-512',
      agencyName: 'National Science Foundation',
      oppStatus: 'posted',
    });
  });

  it('returns [] for junk rather than throwing', () => {
    expect(parseExtractXml('')).toEqual([]);
    expect(parseExtractXml('<html><body>nope</body></html>')).toEqual([]);
  });

  /**
   * THE DOCUMENT IS CUT AT RECORD BOUNDARIES AND PARSED A MEBIBYTE AT A TIME, so the seam between
   * two batches is a place a record can be lost or read twice. There is no such seam in any
   * committed fixture — they hold three records — so this builds a document that crosses several,
   * and pins the count, the order and the last record, which is the one a fencepost error eats.
   *
   * `pad` is inside a field rather than between records: whitespace between elements would let a
   * batch boundary fall somewhere harmless, and the point is to make it fall inside the run.
   */
  it('loses no record, and repeats none, across the batch boundaries', () => {
    const pad = 'x'.repeat(4096);
    const records = Array.from(
      { length: 800 },
      (_, i) =>
        `<OpportunitySynopsisDetail_1_0><OpportunityID>${String(900000 + i)}</OpportunityID>` +
        `<OpportunityTitle>Programme ${String(i)}</OpportunityTitle>` +
        `<Description>${pad}</Description></OpportunitySynopsisDetail_1_0>`,
    ).join('');
    // Comfortably more than one 1 MiB batch, so the seam is exercised several times over.
    expect(Buffer.byteLength(records, 'utf8')).toBeGreaterThan(3 * 1024 * 1024);

    const rows = parseExtractXml(`<Grants>${records}</Grants>`);
    expect(rows).toHaveLength(800);
    expect(rows[0]?.opportunityId).toBe('900000');
    expect(rows[799]?.opportunityId).toBe('900799');
    expect(new Set(rows.map((r) => r.opportunityId)).size).toBe(800);
    expect(rows[400]?.description).toBe(pad);
  });

  /**
   * The 892 `OpportunityForecastDetail_1_0` elements in the live file are FORECASTS, not posted
   * opportunities, and the old whole-document `$('OpportunitySynopsisDetail_1_0')` selector ignored
   * them by name. The scanner ignores them by falling between one record's end tag and the next
   * record's start tag, which is a different mechanism and therefore worth its own test — a
   * boundary walk that swallowed the text between records would read a forecast's fields as part
   * of the record before it.
   */
  it('skips the forecast records that sit between the posted ones', () => {
    const rows = parseExtractXml(
      '<Grants>' +
        '<OpportunitySynopsisDetail_1_0><OpportunityID>1</OpportunityID>' +
        '<OpportunityTitle>Posted</OpportunityTitle></OpportunitySynopsisDetail_1_0>' +
        '<OpportunityForecastDetail_1_0><OpportunityID>2</OpportunityID>' +
        '<OpportunityTitle>Forecast</OpportunityTitle></OpportunityForecastDetail_1_0>' +
        '<OpportunitySynopsisDetail_1_0><OpportunityID>3</OpportunityID>' +
        '<OpportunityTitle>Also posted</OpportunityTitle></OpportunitySynopsisDetail_1_0>' +
        '</Grants>',
    );
    expect(rows.map((r) => r.opportunityId)).toEqual(['1', '3']);
    expect(rows.map((r) => r.title)).toEqual(['Posted', 'Also posted']);
  });

  /**
   * A SHAPE THIS READER DOES NOT CUT ON IS AN OUTAGE, NOT A SMALLER CORPUS.
   *
   * Cutting the document on the bare `<OpportunitySynopsisDetail_1_0>` / `</…>` spelling is what
   * replaces the whole-document DOM, and it is an assumption about somebody else's file (measured
   * true of the live one on 2026-08-10: 164,460 occurrences of the name, exactly two per record).
   * If Grants.gov ever adds an attribute, a scanner that simply failed to match would report a
   * corpus that had shrunk, or splice two records together and read the outer one's fields — a
   * wrong answer delivered quietly, which is the whole class of defect this module has already
   * shipped once.
   */
  it('names a start or end tag it does not recognise instead of quietly reading fewer records', () => {
    expect(() =>
      parseExtractXml(
        '<Grants><OpportunitySynopsisDetail_1_0 xmlns="urn:x"><OpportunityID>1</OpportunityID>' +
          '</OpportunitySynopsisDetail_1_0></Grants>',
      ),
    ).toThrow(ExtractShapeError);
    expect(() =>
      parseExtractXml(
        '<Grants><OpportunitySynopsisDetail_1_0 xmlns="urn:x"><OpportunityID>1</OpportunityID>' +
          '</OpportunitySynopsisDetail_1_0></Grants>',
      ),
    ).toThrow(/not a bare start tag/);
    expect(() =>
      parseExtractXml('<Grants><OpportunitySynopsisDetail_1_0><OpportunityID>1</OpportunityID>'),
    ).toThrow(/never closed/);
    expect(() =>
      parseExtractXml(
        '<Grants><OpportunitySynopsisDetail_1_0><OpportunityID>1</OpportunityID>' +
          '</OpportunitySynopsisDetail_1_0 ></Grants>',
      ),
    ).toThrow(/not a bare end tag/);
  });
});

/**
 * The frame check the CRAWL uses to decide whether it still needs the other six days of the
 * retention window. It must be right about the two cases that matter — an intact archive and a
 * download cut short — and it must not inflate anything to be right about them.
 */
describe('isReadableExtract', () => {
  it('accepts both writer shapes of a whole archive', () => {
    expect(isReadableExtract(zipBase64())).toBe(true);
    expect(isReadableExtract(streamedZipBase64())).toBe(true);
  });

  it('rejects a short download, which is the day the window exists to walk past', () => {
    const zip = Buffer.from(streamedZipBase64(), 'base64');
    const central = zip.readUInt32LE(zip.length - 22 + 16);
    // Same archive, claiming a member longer than the bytes that arrived.
    zip.writeUInt32LE(zip.readUInt32LE(central + 20) + 4096, central + 20);
    expect(isReadableExtract(zip.toString('base64'))).toBe(false);
  });

  it('rejects an empty body and something that is not a ZIP at all', () => {
    expect(isReadableExtract('')).toBe(false);
    expect(isReadableExtract(Buffer.from('<html>404</html>').toString('base64'))).toBe(false);
  });

  /**
   * AN ARCHIVE TOO BIG FOR THE CEILING STILL ANSWERS. It is not a bad DAY — every other day of the
   * window is the same corpus and exactly as large — so walking back six more days would download
   * 467 MB to fail six more times. It stops the walk here and `readExtract` refuses it by name,
   * which is the message that reaches `sources.last_error`.
   */
  it('answers for an archive that is intact but larger than the reader will inflate', () => {
    const zip = Buffer.from(streamedZipBase64(), 'base64');
    const central = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE(MAX_EXTRACT_XML_BYTES + 1, central + 24);
    const b64 = zip.toString('base64');
    expect(isReadableExtract(b64)).toBe(true);
    expect(() => {
      readExtract(b64, () => undefined);
    }).toThrow(/MAX_EXTRACT_XML_BYTES/);
  });
});

describe('grantsGovExtract module', () => {
  it('is Tier A and issues exactly one request per retention day, no keywords involved', async () => {
    expect(grantsGovExtract.tier).toBe('A');
    expect(grantsGovExtract.klass).toBe('adjacent_stem');
    const requests = await resolveRequests(grantsGovExtract);
    expect(requests).toHaveLength(GRANTS_GOV_EXTRACT_RETENTION_DAYS);
    for (const r of requests) {
      expect(r.method).toBe('GET');
      expect(r.accept).toBe('binary');
      expect(r.url.startsWith(GRANTS_GOV_EXTRACT_BASE)).toBe(true);
    }
  });

  it('keeps the adjacent opportunities and drops the radiation-oncology one', () => {
    const raws = grantsGovExtract.parse([payload()]);
    const keys = raws.map((r) => r.externalKey);
    expect(keys).toContain('354102');
    expect(keys).toContain('354777');
    expect(keys).not.toContain('351020');
  });

  it('uses only the newest payload that actually arrived — a 404 on today is not a failure', () => {
    const stale = { ...payload(), url: `${GRANTS_GOV_EXTRACT_BASE}GrantsDBExtract20260801v2.zip` };
    const missingToday = { ...payload({ status: 404, body: '' }) };
    const raws = grantsGovExtract.parse([missingToday, stale]);
    expect(raws.length).toBeGreaterThan(0);
  });

  it('keeps the same records from the streamed archive the live feed actually serves', () => {
    const keys = grantsGovExtract
      .parse([payload({ body: streamedZipBase64() })])
      .map((r) => r.externalKey);
    expect(keys).toEqual(grantsGovExtract.parse([payload()]).map((r) => r.externalKey));
    expect(keys).toContain('354102');
  });

  /**
   * "THE BUCKET IS GONE" IS NOT "THE FEED IS EMPTY" EITHER — the half of this that 651b9f3 left
   * open, and the reason this assertion is the reverse of what it used to be.
   *
   * It used to read `expect(parse([404])).toEqual([])`, "returns [] when every retention day 404s,
   * without throwing", and that assertion was wrong. 651b9f3 separated "we could not read any of
   * the archives" from "the corpus was empty" and stopped there, so the OTHER way of getting
   * nothing — no archive at all — still produced the same `[]` a quiet corpus produces, still
   * recorded a poll SUCCESS with zero records, and still left source health green. A single 404 is
   * ordinary (today's file is published on Grants.gov's schedule, not ours) and is tested as such
   * two cases above. Seven of them is the bucket, the path or the date-stamped filename having
   * moved, i.e. a whole federal feed gone, and there is no day of the year on which Grants.gov
   * publishes no extract at all.
   *
   * The message names the statuses because the operator's next question is "moved, or down?".
   */
  it('throws when NO day of the retention window returned a body, rather than reporting zero', () => {
    const days = extractUrlsFor(new Date(NOW)).map((url) => ({
      ...payload({ status: 404, body: '' }),
      url,
    }));
    expect(() => grantsGovExtract.parse(days)).toThrow(/read failure, not an empty feed/);
    expect(() => grantsGovExtract.parse(days)).toThrow(/GrantsDBExtract20260802v2\.zip 404/);
  });

  /**
   * "WE COULD NOT READ ANY OF THEM" IS NOT "THERE WAS NOTHING IN THEM". This used to swallow every
   * unzip failure and return [], so a reader that was broken against every archive in the retention
   * window reported the same empty array a genuinely quiet corpus would — and did, nightly, for the
   * life of the module. Throwing routes it to `recordPollFailure`, i.e. the `failing` health state,
   * which says what happened.
   */
  it('throws when every archive that arrived was unreadable, instead of reporting zero', () => {
    const junk = Buffer.from('PK\x03\x04 and then nonsense').toString('base64');
    expect(() => grantsGovExtract.parse([payload({ body: junk })])).toThrow(/ZIP/i);
  });

  it('still skips ONE unreadable day when another day reads', () => {
    const junk = { ...payload({ body: Buffer.from('PK\x03\x04nope').toString('base64') }) };
    const good = { ...payload(), url: `${GRANTS_GOV_EXTRACT_BASE}GrantsDBExtract20260801v2.zip` };
    expect(grantsGovExtract.parse([junk, good]).length).toBeGreaterThan(0);
  });

  it('does not throw for an archive that reads and legitimately holds nothing adjacent', () => {
    const xml =
      '<?xml version="1.0"?><Grants><OpportunitySynopsisDetail_1_0>' +
      '<OpportunityID>351020</OpportunityID><OpportunityTitle>Radiation Oncology Outcomes' +
      '</OpportunityTitle><AgencyName>Department of Health and Human Services</AgencyName>' +
      '<Description>Clinical outcomes research in survivorship care.</Description>' +
      '</OpportunitySynopsisDetail_1_0></Grants>';
    expect(grantsGovExtract.parse([payload({ body: storedZip(xml) })])).toEqual([]);
  });

  /**
   * ONE DAY IS THE WHOLE CORPUS, so the seven requests are alternatives and the crawl takes the
   * first that answers. `crawl/runner.ts` asks this after every payload; what it costs the module
   * to answer is a ZIP frame read, and what it saves is six requests of 77,899,674 bytes each.
   */
  describe('answeredBy', () => {
    it('answers for a whole archive and not for a 404, an empty body or a short download', () => {
      expect(grantsGovExtract.answeredBy(payload())).toBe(true);
      expect(grantsGovExtract.answeredBy(payload({ body: streamedZipBase64() }))).toBe(true);
      expect(grantsGovExtract.answeredBy(payload({ status: 404, body: '' }))).toBe(false);
      expect(grantsGovExtract.answeredBy(payload({ status: 200, body: '' }))).toBe(false);
      expect(
        grantsGovExtract.answeredBy(payload({ body: Buffer.from('PK\x03\x04no').toString('base64') })),
      ).toBe(false);
    });

    it('does not answer for a payload from somewhere else entirely', () => {
      expect(
        grantsGovExtract.answeredBy({ ...payload(), url: 'https://example.test/other.zip' }),
      ).toBe(false);
    });
  });

  it('marks records with the extract as their provenance so a reviewer can tell them apart', () => {
    for (const raw of grantsGovExtract.parse([payload()])) {
      expect(raw.rawFields.federalSource).toBe('daily-extract');
      expect(raw.sourceUrl).toContain('grants.gov/search-results-detail/');
    }
  });
});
