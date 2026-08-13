/**
 * THE EXPORT NOTE, READ THE WAY A USER READS IT.
 *
 * `test/cycleCountCopy.test.ts` sweeps the SOURCE for a hard-coded cycle count. This asserts the
 * same rule one layer down, on the rendered DOM, because the two can disagree: a figure assembled
 * at render time out of pieces (`{'4 of '}{total} cycles`) is invisible to a source sweep and is
 * exactly what a determined edit would produce. The sentence a user actually reads is the artefact
 * that has to be honest, so the sentence a user actually reads is what this looks at.
 *
 * This component had no test at all while it was printing "only 4 of 243 cycles in this corpus are
 * dates a funder has actually published" — a figure six files agreed on, six other files
 * contradicted with "4 of 244", and the shipping corpus matched in neither version.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EMPTY_FILTERS } from '../lib/filterState.js';
import { ExportMenu } from './ExportMenu.js';

function renderMenu(): void {
  render(<ExportMenu filters={{ ...EMPTY_FILTERS, q: 'club', status: ['open'] }} />);
}

describe('ExportMenu', () => {
  it('offers the three formats the browse view exports', () => {
    renderMenu();
    for (const label of ['CSV', 'XLSX', 'Deadlines (.ics)']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('carries the browse filters into every download link', () => {
    renderMenu();
    for (const label of ['CSV', 'XLSX', 'Deadlines (.ics)']) {
      const href = screen.getByRole('link', { name: label }).getAttribute('href') ?? '';
      expect(href).toContain('q=club');
      expect(href).toContain('status=open');
    }
  });

  /**
   * THE THREE FILTERS THE LINKS USED TO DROP. On the live site, Award amount Min = 5000 produced
   * three BARE export URLs beside a screen reading 17 programmes, and the CSV behind them held the
   * whole corpus. The `.ics` is listed here with the other two on purpose: it was the link that
   * ignored its query string even when the query string was right.
   */
  it('carries the amount, the verdict and the rolling checkbox into every link, the .ics included', () => {
    render(
      <ExportMenu
        filters={{
          ...EMPTY_FILTERS,
          amountMin: 5000,
          verdict: ['ineligible'],
          includeRolling: false,
          deadlineFrom: '2026-09-01',
        }}
      />,
    );
    for (const label of ['CSV', 'XLSX', 'Deadlines (.ics)']) {
      const href = screen.getByRole('link', { name: label }).getAttribute('href') ?? '';
      expect(href, label).toContain('amountMin=5000');
      expect(href, label).toContain('verdict=ineligible');
      expect(href, label).toContain('includeRolling=false');
      expect(href, label).toContain('deadlineFrom=2026-09-01');
    }
  });

  /** Every match, not the fifty rows on screen — and the page number is the one key left behind. */
  it('never sends the page the user happens to be looking at', () => {
    render(<ExportMenu filters={{ ...EMPTY_FILTERS, page: 3, q: 'club' }} />);
    const href = screen.getByRole('link', { name: 'CSV' }).getAttribute('href') ?? '';
    expect(href).toContain('q=club');
    expect(href).not.toContain('page=');
  });

  it('says what the file contains that the page does not, and what a calendar cannot carry', () => {
    renderMenu();
    const note = screen.getByText(/exports exactly what the filters above are showing/i);
    // The two things the sentence was silent about while it was true of nothing.
    expect(note).toHaveTextContent(/every match, not just the page on screen/i);
    expect(note).toHaveTextContent(/a calendar can only carry what has a date/i);
    expect(
      screen.getByText(/matcher-verdict filter is honoured/i),
    ).toHaveTextContent(/with no profile saved, filtering by verdict exports nothing/i);
  });

  it('keeps the published/projected distinction in the note', () => {
    renderMenu();
    const note = screen.getByText(/every date in the calendar file/i);
    expect(note).toHaveTextContent(/the funder published/i);
    expect(note).toHaveTextContent(/projected from the recurrence/i);
  });

  it('states no count of cycles, because the count moves with the wall clock', () => {
    renderMenu();
    // Measured over `data/seed/` through the ICS route's own two-year window: 252 cycles with 2
    // funder-published on 2026-08-04, 250 with 1 on 2026-10-01, 248 with 0 on 2027-02-01. Any
    // literal printed here is false within months of its own commit.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\b(?:\d{1,4}|one|two|three|four)\b[^.!?]{0,50}?\b(?:cycles|windows|deadlines)\b/i);
  });
});
