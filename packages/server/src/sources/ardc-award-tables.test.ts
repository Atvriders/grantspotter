import { describe, expect, it } from 'vitest';
import { fixturePayload, hasFixture, loadFixture } from '../../test/fixtures.js';
import { ardcAwardTables, grantYearUrls, parseAwardTable } from './ardc-award-tables.js';

const URL_2026 = 'https://www.ardc.net/apply/grants/2026-grants/';
const html = () => loadFixture('ardc-award-tables', 'pathological.html');

describe('grantYearUrls', () => {
  it('covers 2019 through the current year inclusive', () => {
    const urls = grantYearUrls('2026-08-02T00:00:00.000Z');
    expect(urls).toHaveLength(8);
    expect(urls[0]).toBe('https://www.ardc.net/apply/grants/2019-grants/');
    expect(urls[7]).toBe(URL_2026);
  });

  it('grows automatically with the calendar — no annual code change', () => {
    expect(grantYearUrls('2031-01-01T00:00:00.000Z')).toHaveLength(13);
  });
});

describe('parseAwardTable', () => {
  const rows = () => parseAwardTable(html(), 2026, URL_2026);

  it('reads only the 4-column award table and skips the footer table', () => {
    expect(rows()).toHaveLength(3);
    expect(rows().map((r) => r.rawFields.grantee)).not.toContain('Contact us');
  });

  it('skips empty rows', () => {
    for (const r of rows()) expect(r.rawFields.grantee).not.toBe('');
  });

  it('captures date, grantee, project and amount verbatim', () => {
    const hamsci = rows()[0];
    expect(hamsci.rawFields.date).toBe('2026-04-02');
    expect(hamsci.rawFields.grantee).toBe('HamSCI');
    expect(hamsci.rawFields.project).toBe('Personal Space Weather Station expansion');
    expect(hamsci.rawFields.amountRaw).toBe('$77,000');
    expect(hamsci.rawFields.year).toBe('2026');
  });

  it('preserves the literal string TBD instead of coercing it to a number', () => {
    const ori = rows().find((r) => r.rawFields.grantee === 'Open Research Institute');
    expect(ori?.rawFields.amountRaw).toBe('TBD');
  });

  it('resolves a relative grantee link to an absolute URL, and tolerates rows with no link', () => {
    expect(rows()[0].rawFields.granteeUrl).toBe(
      'https://www.ardc.net/apply/grants/grant-hamsci-psws-expansion/',
    );
    expect(rows()[1].rawFields.granteeUrl).toBeUndefined();
  });

  it('never writes detailUrl, because normalize/ would turn it into the applyUrl', () => {
    for (const r of rows()) expect(r.rawFields.detailUrl).toBeUndefined();
  });

  it('marks every row as a past award so it never shows up as a live deadline', () => {
    for (const r of rows()) expect(r.rawFields.recordType).toBe('past_award');
  });

  it('builds a stable externalKey from year, grantee and project', () => {
    expect(rows()[0].externalKey).toBe('2026|HamSCI|Personal Space Weather Station expansion');
  });
});

describe('ardcAwardTables source module', () => {
  it('is Tier C with an expectedMinRecords tuned to eight years of tables', () => {
    expect(ardcAwardTables.tier).toBe('C');
    expect(ardcAwardTables.expectedMinRecords).toBe(40);
  });

  it('resolves its requests lazily from the current date', async () => {
    const requests = typeof ardcAwardTables.requests === 'function'
      ? await ardcAwardTables.requests()
      : ardcAwardTables.requests;
    expect(requests.length).toBeGreaterThanOrEqual(8);
    expect(requests[0].accept).toBe('html');
  });

  it('parses every year payload it is given', () => {
    const raws = ardcAwardTables.parse([
      fixturePayload('ardc-award-tables', 'pathological.html', URL_2026),
      fixturePayload('ardc-award-tables', 'pathological.html', 'https://www.ardc.net/apply/grants/2025-grants/'),
    ]);
    expect(raws).toHaveLength(6);
    expect(raws.filter((r) => r.rawFields.year === '2025')).toHaveLength(3);
  });

  it('ignores a 404 year page instead of failing the whole source', () => {
    const missing = {
      url: 'https://www.ardc.net/apply/grants/2019-grants/',
      status: 404,
      contentType: 'text/html',
      body: '<h1>Not found</h1>',
      fetchedAt: '2026-08-02T00:00:00.000Z',
    };
    expect(ardcAwardTables.parse([missing])).toEqual([]);
  });
});

/**
 * The REAL 2019-2026 pages, captured 2026-08-03 (all eight HTTP 200, text/html; charset=UTF-8).
 * The synthetic fixture above is an author agreeing with themselves; this block is the parser
 * agreeing with ardc.net. It is what caught the granteeUrl/detailUrl defect.
 */
describe('ardcAwardTables against the real captured award tables', () => {
  const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] as const;
  const FILES: ReadonlyArray<readonly [number, string]> = YEARS.map((y, i) => [
    y,
    `${String(i).padStart(2, '0')}-www-ardc-net-apply-grants-${y}-grants.html`,
  ]);
  const captured = () => FILES.every(([, f]) => hasFixture('ardc-award-tables', f));
  const payloads = () =>
    FILES.map(([y, f]) =>
      fixturePayload('ardc-award-tables', f, `https://www.ardc.net/apply/grants/${y}-grants/`),
    );

  it.runIf(captured())('reads all 424 awards, and the right number from each year page', () => {
    const raws = ardcAwardTables.parse(payloads());
    expect(raws).toHaveLength(424);
    const perYear = Object.fromEntries(
      YEARS.map((y) => [y, raws.filter((r) => r.rawFields.year === String(y)).length]),
    );
    // 2019 really does have only two rows — it was ARDC's first grant year, not a parse failure.
    expect(perYear).toEqual({
      2019: 2,
      2020: 21,
      2021: 68,
      2022: 90,
      2023: 70,
      2024: 55,
      2025: 77,
      2026: 41,
    });
    expect(raws.length).toBeGreaterThanOrEqual(ardcAwardTables.expectedMinRecords);
  });

  it.runIf(captured())('reads ARDC’s first two awards exactly as published', () => {
    const raws = ardcAwardTables.parse(payloads());
    expect(raws[0].externalKey).toBe('2019|ARISS|Next Generation Radio');
    expect(raws[0].name).toBe('ARISS — Next Generation Radio (2019)');
    expect(raws[0].rawFields.date).toBe('2019-09-01');
    expect(raws[0].rawFields.grantee).toBe('ARISS');
    expect(raws[0].rawFields.project).toBe('Next Generation Radio');
    expect(raws[0].rawFields.amountRaw).toBe('$110,000');
    expect(raws[0].rawFields.granteeUrl).toBe('https://www.ariss.org/');
    expect(raws[0].sourceUrl).toBe('https://www.ardc.net/apply/grants/2019-grants/');

    expect(raws[1].externalKey).toBe('2019|TAPR Inc|Student DCC Attendance Grants');
    expect(raws[1].rawFields.date).toBe('2019-08-01');
    expect(raws[1].rawFields.amountRaw).toBe('$10,000');
  });

  it.runIf(captured())('keeps every real award row distinct and fully populated', () => {
    const raws = ardcAwardTables.parse(payloads());
    expect(new Set(raws.map((r) => r.externalKey)).size).toBe(raws.length);
    for (const r of raws) {
      expect(r.rawFields.grantee).not.toBe('');
      expect(r.rawFields.project).not.toBe('');
      expect(r.rawFields.amountRaw).not.toBe('');
    }
  });

  it.runIf(captured())('stamps every real row past_award — none of this is an opportunity', () => {
    for (const r of ardcAwardTables.parse(payloads())) {
      expect(r.rawFields.recordType).toBe('past_award');
    }
  });

  it.runIf(captured())('never sends a grantee link out as detailUrl/applyUrl', () => {
    const raws = ardcAwardTables.parse(payloads());
    const linked = raws.filter((r) => r.rawFields.granteeUrl !== undefined);
    // 345 of the 424 rows are linked, across 256 distinct hosts, and NOT ONE is on ardc.net.
    expect(linked).toHaveLength(345);
    expect(new Set(linked.map((r) => new URL(r.rawFields.granteeUrl).hostname)).size).toBe(256);
    expect(linked.filter((r) => /(^|\.)ardc\.net$/.test(new URL(r.rawFields.granteeUrl).hostname)))
      .toHaveLength(0);
    for (const r of raws) expect(r.rawFields.detailUrl).toBeUndefined();
  });

  it.runIf(captured())('keeps TBD and foreign-currency amounts verbatim, never coerced', () => {
    const raws = ardcAwardTables.parse(payloads());
    expect(raws.filter((r) => r.rawFields.amountRaw === 'TBD')).toHaveLength(14);
    const amounts = new Set(raws.map((r) => r.rawFields.amountRaw));
    for (const literal of ['$200,000 (max)', '$15,262.50', '$558,761 CAD', '€14,000', '£153,234']) {
      expect(amounts).toContain(literal);
    }
  });

  it.runIf(captured())('keeps irregular real date strings verbatim rather than guessing', () => {
    const dates = new Set(ardcAwardTables.parse(payloads()).map((r) => r.rawFields.date));
    for (const literal of ['2019-09-01', '2021-12', 'Apr 2022', 'November 2023', 'May 2026']) {
      expect(dates).toContain(literal);
    }
  });

  it.runIf(captured())('ignores the 2-column tables that sit beside the real award tables', () => {
    // Six of the eight real pages carry a second, 2-column table. Nothing from one may appear.
    const raws = ardcAwardTables.parse(payloads());
    expect(raws.map((r) => r.rawFields.grantee)).not.toContain('');
    expect(raws.every((r) => r.rawText.split(' | ').length === 4)).toBe(true);
  });
});

describe('ardcAwardTables 404 handling', () => {
  it('ignores a 404 year page', () => {
    const missing = {
      url: 'https://www.ardc.net/apply/grants/2019-grants/',
      status: 404,
      contentType: 'text/html',
      body: '<h1>Not found</h1>',
      fetchedAt: '2026-08-02T00:00:00.000Z',
    };
    expect(ardcAwardTables.parse([missing])).toEqual([]);
  });
});
