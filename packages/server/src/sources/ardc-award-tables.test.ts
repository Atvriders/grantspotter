import { describe, expect, it } from 'vitest';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
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

  it('resolves a relative detail link to an absolute URL, and tolerates rows with no link', () => {
    expect(rows()[0].rawFields.detailUrl).toBe(
      'https://www.ardc.net/apply/grants/grant-hamsci-psws-expansion/',
    );
    expect(rows()[1].rawFields.detailUrl).toBeUndefined();
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
