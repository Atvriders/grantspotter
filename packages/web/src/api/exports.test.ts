import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EMPTY_FILTERS } from '../lib/filterState.js';
import {
  browseFiltersToExportQuery, exportHref, getIcsToken, createIcsToken, revokeIcsToken,
  downloadDraftExport, restoreFromBackup,
} from './exports.js';

describe('browseFiltersToExportQuery', () => {
  it('is empty for empty filters', () => {
    expect(browseFiltersToExportQuery(EMPTY_FILTERS).toString()).toBe('');
  });

  it('renames entity to applicantEntities and the deadline window to closesAfter/closesBefore', () => {
    const query = browseFiltersToExportQuery({
      ...EMPTY_FILTERS,
      entity: ['club_501c3', 'university'],
      deadlineFrom: '2026-09-01',
      deadlineTo: '2027-03-01',
    });
    expect(query.get('applicantEntities')).toBe('club_501c3,university');
    expect(query.get('closesAfter')).toBe('2026-09-01');
    expect(query.get('closesBefore')).toBe('2027-03-01');
    expect(query.get('entity')).toBeNull();
    expect(query.get('deadlineFrom')).toBeNull();
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

  it('drops browse-only keys the export endpoint does not understand', () => {
    const query = browseFiltersToExportQuery({ ...EMPTY_FILTERS, verdict: ['ineligible'], page: 4, sort: 'name' });
    expect(query.toString()).toBe('');
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
