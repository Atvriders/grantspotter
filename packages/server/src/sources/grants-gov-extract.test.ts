import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import {
  GRANTS_GOV_EXTRACT_BASE,
  GRANTS_GOV_EXTRACT_RETENTION_DAYS,
  extractUrlFor,
  extractUrlsFor,
  parseExtractXml,
  unzipFirstEntry,
} from '../federal/grantsGovExtract.js';
import { resolveRequests } from './types.js';
import { grantsGovExtract } from './grants-gov-extract.js';

const NOW = '2026-08-02T00:00:00.000Z';
const zipBase64 = () => loadFixture('grants-gov-extract', '00-extract.zip.b64');

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

  it('returns [] when every retention day 404s, without throwing', () => {
    expect(grantsGovExtract.parse([payload({ status: 404, body: '' })])).toEqual([]);
  });

  it('marks records with the extract as their provenance so a reviewer can tell them apart', () => {
    for (const raw of grantsGovExtract.parse([payload()])) {
      expect(raw.rawFields.federalSource).toBe('daily-extract');
      expect(raw.sourceUrl).toContain('grants.gov/search-results-detail/');
    }
  });
});
