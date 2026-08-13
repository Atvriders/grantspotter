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
    expect(csv.getAttribute('href')).toContain('entity=club_501c3');
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

  /**
   * BOTH URLs, because the user is now the one choosing the scope. Exactly one label says
   * "Subscribe URL" — the corpus-wide one, which is the default — so `getByLabel(/subscribe url/i)`
   * stays unambiguous for this suite and for e2e/flow.spec.ts, which reads that field to prove the
   * feed serves.
   */
  it('shows both subscribe URLs exactly once, after creating a feed', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404))
      .mockResolvedValueOnce(jsonResponse({ url: 'http://127.0.0.1:3030/calendar/abc.ics', token: 'abc' }));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

    await userEvent.click(await screen.findByRole('button', { name: /create a calendar feed/i }));
    const field = await screen.findByLabelText(/subscribe url/i);
    expect(field).toHaveValue('http://127.0.0.1:3030/calendar/abc.ics');
    expect(screen.getByLabelText(/watchlist feed/i)).toHaveValue(
      'http://127.0.0.1:3030/calendar/abc.ics?watched=1',
    );
    // Labelled with what each will contain, so the choice is made deliberately and not by default.
    expect(screen.getByText(/every deadline/i)).toBeInTheDocument();
    expect(screen.getByText(/only what you star/i)).toBeInTheDocument();
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it('reports that a feed already exists without pretending to know the URL', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ hasToken: true }));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/a calendar feed already exists/i)).toBeInTheDocument();
    // It cannot reprint the token, but it can say how to build the other URL out of one they have.
    expect(screen.getByText(/watchlist-only variant/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rotate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  it('explains what PDF means here instead of offering a fake PDF button', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/Print \/ Save as PDF/)).toBeInTheDocument();
  });

  /**
   * THIS REPLACES AN ASSERTION THAT PINNED A FALSE STATISTIC ON SCREEN. It required this route to
   * render "4 of the 243 dated windows in this corpus are dates a funder has actually published",
   * so the copy could not be corrected without correcting the test in the same commit — which is
   * how the sentence outlived the pass that removed it from the other five components.
   *
   * 4-of-243 is a real measurement of the FIXTURE corpus on a fixed clock, and a lie on this
   * screen, which a user reads against whatever corpus is installed. On `data/seed/` the figure is
   * not a constant at all: 252 cycles with 2 funder-published on 2026-08-04, 250 with 1 on
   * 2026-10-01, 248 with 0 on 2027-02-01, as `test/cycleCountCopy.test.ts` records.
   *
   * The assertion is not weakened, it is moved onto what is actually provable. The claim the
   * screen now makes — every date declares which kind it is, and a projection carries four marks —
   * is asserted here in both directions: the sentence must be present, AND no count of dated
   * things may be on screen. The second half is DOM-level on purpose. `cycleCountCopy` sweeps
   * SOURCE, so a figure assembled at render time (`{'4 of '}{total} windows`) is invisible to it
   * and would be exactly what a determined edit produces.
   */
  it('says every calendar date declares whether the funder published it, without counting them', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

    const note = await screen.findByText(/every date in these files/i);
    expect(note).toHaveTextContent(/the funder\s+published/i);
    expect(note).toHaveTextContent(/projected from the recurrence/i);
    // The four marks `exports/ics.ts` writes and `exports/ics.test.ts` proves, named as four
    // because they are four lines of code, not four rows of a corpus.
    expect(note).toHaveTextContent(/marked four ways/i);
    expect(note).toHaveTextContent(/\(estimated\)/i);
    expect(note).toHaveTextContent(/tentative status/i);

    const onScreen = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(
      onScreen,
      'A count of dated windows/cycles/events rendered here goes stale on its own clock. Say the ' +
        'distinction, which is proved, and leave the arithmetic to a screen that holds the rows.',
    ).not.toMatch(
      /\b(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s+(?:of|in)\s+[^.!?]{0,50}?)?\s+(?:cycles|windows|deadlines|dates|events|entries|items|records|rows|programmes|programs)\b/i,
    );
  });

  /**
   * THIS TEST REPLACES ONE THAT PINNED THE DEFECT'S OWN COPY. It asserted that this screen said
   * "the feed follows your watchlist" and that "the URL does not change" when it switches — both
   * accurate descriptions of a feed whose meaning moved underneath its subscriber, which is the
   * behaviour that has now been removed. The assertion was not weakened: the claim it checked is
   * gone from the product, and leaving it would have required the screen to keep describing a
   * failure mode instead of documenting a choice.
   */
  it('says there are two feed URLs and that each one keeps its meaning', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/two feed urls/i)).toBeInTheDocument();
    expect(screen.getByText(/plain URL carries every\s+publishable deadline/i)).toBeInTheDocument();
    expect(screen.getByText(/only the programmes you star/i)).toBeInTheDocument();
    // The half a subscriber needs: what they do later cannot rewrite what they already installed.
    expect(screen.getByText(/never empties the plain one/i)).toBeInTheDocument();
  });

  it('surfaces a 409 from the eligibility export as the profile prompt', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ hasToken: true }));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/needs a profile/i)).toBeInTheDocument();
  });
});
