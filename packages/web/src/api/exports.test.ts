import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EMPTY_FILTERS, filtersToSearchParams } from '../lib/filterState.js';
import {
  browseFiltersToExportQuery, exportHref, getIcsToken, createIcsToken, revokeIcsToken,
  downloadDraftExport, restoreFromBackup,
} from './exports.js';

describe('browseFiltersToExportQuery', () => {
  it('is empty for empty filters', () => {
    expect(browseFiltersToExportQuery(EMPTY_FILTERS).toString()).toBe('');
  });

  it('sends the browse screen’s own key for every filter, in the browse screen’s own spelling', () => {
    const query = browseFiltersToExportQuery({
      ...EMPTY_FILTERS,
      entity: ['club_501c3', 'university'],
      deadlineFrom: '2026-09-01',
      deadlineTo: '2027-03-01',
    });
    expect(query.get('entity')).toBe('club_501c3,university');
    expect(query.get('deadlineFrom')).toBe('2026-09-01');
    expect(query.get('deadlineTo')).toBe('2027-03-01');
    // The second vocabulary is gone: these were the export's private spellings, and translating
    // into them by hand is how three filters came to be dropped on the way.
    expect(query.get('applicantEntities')).toBeNull();
    expect(query.get('closesAfter')).toBeNull();
  });

  it('passes q, klass, status and instrument through unchanged', () => {
    const query = browseFiltersToExportQuery({
      ...EMPTY_FILTERS, q: 'club', klass: ['ham_grant'], status: ['open'], instrument: ['cash_range'],
    });
    expect(query.get('q')).toBe('club');
    expect(query.get('klass')).toBe('ham_grant');
    expect(query.get('status')).toBe('open');
    expect(query.get('instrument')).toBe('cash_range');
  });

  /**
   * THE THREE FILTERS THAT USED TO REACH THE EXPORT AS NOTHING AT ALL.
   *
   * Measured on the live site: award amount Min = 5000 showed 17 programmes and produced three
   * BARE export links whose CSV held 143 — the whole corpus. Same for the matcher verdict. Same,
   * in the other direction, for the rolling checkbox, whose absence made a windowed export drop 22
   * rows the screen was showing in the checkbox's DEFAULT state.
   */
  it('carries the amount, the verdict and the rolling checkbox, which used to be dropped', () => {
    const query = browseFiltersToExportQuery({
      ...EMPTY_FILTERS,
      amountMin: 5000,
      amountMax: 20000,
      verdict: ['ineligible'],
      includeRolling: false,
      deadlineFrom: '2026-09-01',
    });
    expect(query.get('amountMin')).toBe('5000');
    expect(query.get('amountMax')).toBe('20000');
    expect(query.get('verdict')).toBe('ineligible');
    expect(query.get('includeRolling')).toBe('false');
  });

  /**
   * THE GUARD, AND THE REASON THIS FUNCTION IS DERIVED RATHER THAN WRITTEN OUT.
   *
   * A filter that exists on screen and reaches no export is the defect being closed, and it is
   * invisible from either side alone: the browse request is right, the export request is right for
   * the keys it knows, and nothing anywhere compares the two sets. So this compares them, over a
   * `UiFilters` with EVERY field set, and names the only keys allowed to differ. A filter added to
   * the browse screen fails here until somebody decides — in writing — which of the two it is.
   */
  it('sends every key the browse request sends, except the ones named here', () => {
    const everything = {
      klass: ['ham_grant' as const],
      entity: ['club_501c3' as const],
      instrument: ['cash_range' as const],
      status: ['open' as const],
      verdict: ['ineligible' as const],
      deadlineFrom: '2026-09-01',
      deadlineTo: '2027-03-01',
      includeRolling: false,
      amountMin: 5000,
      amountMax: 20000,
      q: 'club',
      sort: 'name' as const,
      page: 4,
    };
    const NOT_EXPORTED: Record<string, string> = {
      page: 'An export is every match. A page is a property of the screen, and shipping one would ' +
        'be 50 rows of a 139-row answer to somebody who never asked for a page.',
    };

    const browse = [...filtersToSearchParams(everything).keys()];
    const exported = new Set(browseFiltersToExportQuery(everything).keys());
    // The probe has to actually set everything, or the comparison is between two short lists.
    expect(browse.length).toBeGreaterThanOrEqual(13);
    const missing = browse.filter((key) => !exported.has(key) && NOT_EXPORTED[key] === undefined);
    expect(
      missing,
      'A filter the browse screen sends and the export does not is a file that disagrees with the ' +
        'count above the button. Carry it, or add it to NOT_EXPORTED with the reason.',
    ).toEqual([]);
    for (const key of Object.keys(NOT_EXPORTED)) expect(exported.has(key), key).toBe(false);
  });
});

describe('exportHref', () => {
  it('appends a query only when there is one', () => {
    expect(exportHref('/api/exports/opportunities.csv')).toBe('/api/exports/opportunities.csv');
    expect(exportHref('/api/exports/opportunities.csv', new URLSearchParams({ q: 'ardc' })))
      .toBe('/api/exports/opportunities.csv?q=ardc');
  });
});

describe('the ICS token endpoints', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads null when no feed exists yet rather than throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'not_found', message: 'none' }, requestId: 'r1' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));
    await expect(getIcsToken()).resolves.toBeNull();
  });

  it('creates a feed and returns the one-time URL', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ url: 'http://127.0.0.1:3030/calendar/abc.ics', token: 'abc' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await expect(createIcsToken()).resolves.toEqual({ url: 'http://127.0.0.1:3030/calendar/abc.ics', token: 'abc' });
    const [, createInit] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(createInit).toMatchObject({ method: 'POST' });
  });

  it('revokes with a DELETE', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await revokeIcsToken();
    const [, revokeInit] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(revokeInit).toMatchObject({ method: 'DELETE' });
  });
});

describe('downloadDraftExport', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts the applicationId and never the draft text', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(['x']), {
      status: 200,
      headers: { 'content-type': 'text/markdown', 'content-disposition': 'attachment; filename="d.md"' },
    }));
    await downloadDraftExport('md', { applicationId: 'a-1', programId: 'ardc-grants' });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/exports/draft.md');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ applicationId: 'a-1', programId: 'ardc-grants' });
    expect(String((init as RequestInit).body)).not.toContain('markdown');
  });

  it('surfaces the 409 message so the user is told which fact is unconfirmed', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'conflict', message: '2 unconfirmed factual assertion(s)' }, requestId: 'r2' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    await expect(downloadDraftExport('docx', { applicationId: 'a-1', programId: 'ardc-grants' }))
      .rejects.toThrow(/unconfirmed factual assertion/);
  });
});

describe('restoreFromBackup', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends the parsed file as JSON and returns the counts', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ tablesRestored: ['funders'], rowsRestored: 26 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const file = new File([JSON.stringify({ app: 'grantspotter', formatVersion: 1, exportedAt: '', tables: {} })],
      'backup.json', { type: 'application/json' });
    await expect(restoreFromBackup(file)).resolves.toEqual({ tablesRestored: ['funders'], rowsRestored: 26 });
  });
});
