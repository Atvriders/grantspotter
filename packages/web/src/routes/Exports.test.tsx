import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ExportsRoute } from './Exports.js';
import { ExportMenu } from '../components/ExportMenu.js';
import { EMPTY_FILTERS } from '../lib/filterState.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ExportMenu', () => {
  it('carries the current browse filters into every download link', () => {
    render(
      <MemoryRouter>
        <ExportMenu filters={{ ...EMPTY_FILTERS, q: 'club', klass: ['ham_grant'], entity: ['club_501c3'] }} />
      </MemoryRouter>,
    );
    const csv = screen.getByRole('link', { name: /csv/i });
    expect(csv).toHaveAttribute('href', expect.stringContaining('/api/exports/opportunities.csv?'));
    expect(csv.getAttribute('href')).toContain('q=club');
    expect(csv.getAttribute('href')).toContain('klass=ham_grant');
    expect(csv.getAttribute('href')).toContain('applicantEntities=club_501c3');
    expect(screen.getByRole('link', { name: /xlsx/i }).getAttribute('href')).toContain('opportunities.xlsx?');
  });

  it('says out loud that the download is the filtered view, not the whole corpus', () => {
    render(<MemoryRouter><ExportMenu filters={EMPTY_FILTERS} /></MemoryRouter>);
    expect(screen.getByText(/exports exactly what the filters above are showing/i)).toBeInTheDocument();
  });
});

describe('ExportsRoute', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('offers the opportunity, eligibility and calendar downloads', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: /opportunities \(csv\)/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /opportunities \(xlsx\)/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /eligibility report \(csv\)/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /printable eligibility report/i })).toBeInTheDocument();
    // Anchored: there are two one-off links, the whole corpus and the watchlist.
    expect(screen.getByRole('link', { name: /^one-off \.ics$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^one-off \.ics \(watchlist only\)$/i })).toBeInTheDocument();
  });

  it('shows the subscribe URL exactly once, after creating a feed', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404))
      .mockResolvedValueOnce(jsonResponse({ url: 'http://127.0.0.1:3030/calendar/abc.ics', token: 'abc' }));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

    await userEvent.click(await screen.findByRole('button', { name: /create a calendar feed/i }));
    const field = await screen.findByLabelText(/subscribe url/i);
    expect(field).toHaveValue('http://127.0.0.1:3030/calendar/abc.ics');
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it('reports that a feed already exists without pretending to know the URL', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ hasToken: true }));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/a calendar feed already exists/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rotate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  it('explains what PDF means here instead of offering a fake PDF button', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/Print \/ Save as PDF/)).toBeInTheDocument();
  });

  it('says most calendar dates are projected, not funder-published', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/4 of the 243 dated windows/i)).toBeInTheDocument();
  });

  it('says that the subscribable feed narrows to the watchlist once something is starred', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/feed follows your watchlist/i)).toBeInTheDocument();
    // The URL staying the same is the surprising half, and it is the half a subscriber needs.
    expect(screen.getByText(/URL does not change/i)).toBeInTheDocument();
  });

  it('surfaces a 409 from the eligibility export as the profile prompt', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ hasToken: true }));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/needs a profile/i)).toBeInTheDocument();
  });
});
