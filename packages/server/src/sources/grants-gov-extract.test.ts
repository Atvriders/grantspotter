import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import {
  GRANTS_GOV_EXTRACT_BASE,
  GRANTS_GOV_EXTRACT_RETENTION_DAYS,
  extractUrlFor,
  extractUrlsFor,
  parseExtractXml,
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
    const xml = unzipFirstEntry(zipBase64());
    expect(xml).toContain('<OpportunityID>354102</OpportunityID>');
    expect(xml).toContain('Geospace Facilities');
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
    expect(xml).toContain('<OpportunityID>354102</OpportunityID>');
    expect(xml).toContain('Geospace Facilities');
    // Byte-identical to the seekable archive: the two fixtures differ only in how they say how
    // long the member is, which is the whole point of having both.
    expect(xml).toBe(unzipFirstEntry(zipBase64()));
  });

  it('names ZIP64 rather than reading a sentinel as a four-gigabyte length', () => {
    const zip = Buffer.from(streamedZipBase64(), 'base64');
    const eocd = zip.length - 22;
    const central = zip.readUInt32LE(eocd + 16);
    zip.writeUInt32LE(0xffffffff, central + 20); // compressed size
    expect(() => unzipFirstEntry(zip.toString('base64'))).toThrow(/ZIP64/);
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
    const rows = parseExtractXml(unzipFirstEntry(zipBase64()));
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

  it('returns [] when every retention day 404s, without throwing', () => {
    expect(grantsGovExtract.parse([payload({ status: 404, body: '' })])).toEqual([]);
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

  it('marks records with the extract as their provenance so a reviewer can tell them apart', () => {
    for (const raw of grantsGovExtract.parse([payload()])) {
      expect(raw.rawFields.federalSource).toBe('daily-extract');
      expect(raw.sourceUrl).toContain('grants.gov/search-results-detail/');
    }
  });
});
