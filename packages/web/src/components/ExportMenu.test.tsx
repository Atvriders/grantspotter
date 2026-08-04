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
