import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MonthGrid, monthMatrix } from './MonthGrid.js';
import type { CalendarEntry } from './AgendaList.js';

const NOW = '2026-08-02T12:00:00.000Z';

/**
 * Four entries chosen to exercise the four things a month cell can hold, and NOT the brief's two.
 *
 * The brief's fixture rendered December 2026 with two entries whose prep starts fall in NOVEMBER
 * (2026-11-30) and OCTOBER (2026-10-17), and then asserted `getByText(/start preparing/i)` against
 * that month. No December cell could ever have held a start marker, so the brief's own test was
 * unsatisfiable by any correct implementation. `c3` exists to put exactly one prep start inside
 * the rendered month, and `c4` exists because a funder-published WINDOW has an opening day that a
 * month grid should show — the corpus's four published cycles include ARISS 2026-07-01/09-30.
 */
const entries: CalendarEntry[] = [
  {
    cycle: {
      id: 'c1',
      programId: 'arrl-foundation-scholarship',
      // 17:00Z on the 30th is midday on the 30th in New York: the same day either way. The
      // timezone still travels with it, because the cell it lands in is chosen with it.
      closesAt: '2026-12-30T17:00:00.000Z',
      timezone: 'America/New_York',
      label: 'Dec 2026 close',
      isEstimated: false,
    },
    programId: 'arrl-foundation-scholarship',
    programName: 'ARRL Foundation Scholarship Program',
    funderName: 'ARRL Foundation',
    klass: 'ham_scholarship',
    instrument: 'cash_range',
    applicantEntities: ['individual'],
    isEstimated: false,
    prepLeadDays: 30,
    prepStartAt: '2026-11-30T17:00:00.000Z',
    prepNote: 'Start about 30 days before the close.',
    decisionLagMinDays: null,
    decisionLagMaxDays: null,
    watched: true,
    verdictKind: 'eligible',
    status: 'unknown',
    lastVerifiedAt: '2026-07-20T00:00:00.000Z',
  },
  {
    cycle: {
      id: 'c2',
      programId: 'ardc-grants',
      closesAt: '2026-12-01T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Projected Dec cycle',
      isEstimated: true,
    },
    programId: 'ardc-grants',
    programName: 'ARDC Grants Program',
    funderName: 'Amateur Radio Digital Communications',
    klass: 'ham_grant',
    instrument: 'cash_range',
    applicantEntities: ['university'],
    isEstimated: true,
    prepLeadDays: 45,
    prepStartAt: '2026-10-17T00:00:00.000Z',
    prepNote: 'ARDC evaluates for 60 to 120 days.',
    decisionLagMinDays: 60,
    decisionLagMaxDays: 120,
    watched: false,
    verdictKind: 'unknown',
    status: 'unknown',
    lastVerifiedAt: '2026-07-28T00:00:00.000Z',
  },
  {
    cycle: {
      id: 'c3',
      programId: 'ncdxf-grants',
      closesAt: '2027-01-15T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Projected Jan cycle',
      isEstimated: true,
    },
    programId: 'ncdxf-grants',
    programName: 'NCDXF Grants',
    funderName: 'Northern California DX Foundation',
    klass: 'ham_grant',
    instrument: 'cash_range',
    applicantEntities: ['club_501c3'],
    isEstimated: true,
    prepLeadDays: 30,
    // Inside December, while the deadline itself is not. The whole point of the overlay.
    prepStartAt: '2026-12-16T00:00:00.000Z',
    prepNote: 'NCDXF asks for roughly two months of lead.',
    decisionLagMinDays: null,
    decisionLagMaxDays: null,
    watched: false,
    verdictKind: null,
    status: 'unknown',
    lastVerifiedAt: '2026-06-01T00:00:00.000Z',
  },
  {
    cycle: {
      id: 'c4',
      programId: 'ariss-proposals',
      opensAt: '2026-12-07T00:00:00.000Z',
      closesAt: '2027-01-05T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Published ARISS window',
      isEstimated: false,
    },
    programId: 'ariss-proposals',
    programName: 'ARISS Contact Proposals',
    funderName: 'ARISS-USA',
    klass: 'ham_grant',
    instrument: 'in_kind_service',
    applicantEntities: ['school_lea'],
    isEstimated: false,
    prepLeadDays: 45,
    prepStartAt: '2026-11-21T00:00:00.000Z',
    prepNote: 'ARISS proposal windows are rewritten quarterly.',
    decisionLagMinDays: null,
    decisionLagMaxDays: null,
    watched: false,
    verdictKind: null,
    status: 'open',
    lastVerifiedAt: '2026-07-31T00:00:00.000Z',
  },
];

function renderGrid(year = 2026, month = 12) {
  return render(
    <MemoryRouter>
      <MonthGrid year={year} month={month} entries={entries} now={NOW} />
    </MemoryRouter>,
  );
}

describe('monthMatrix', () => {
  it('returns whole weeks starting Monday', () => {
    const weeks = monthMatrix(2026, 12);
    expect(weeks[0]).toHaveLength(7);
    expect(weeks.flat().some((d) => d?.getUTCDate() === 1)).toBe(true);
  });

  it('pads leading and trailing cells with null rather than another month’s dates', () => {
    const weeks = monthMatrix(2026, 12);
    expect(weeks[0]![0]).toBeNull(); // 2026-12-01 is a Tuesday
    expect(weeks.flat().filter((d) => d !== null)).toHaveLength(31);
  });

  it('handles a month that starts on a Monday with no leading pad', () => {
    // 2027-02-01 is a Monday.
    const weeks = monthMatrix(2027, 2);
    expect(weeks[0]![0]?.toISOString().slice(0, 10)).toBe('2027-02-01');
    expect(weeks.flat().filter((d) => d !== null)).toHaveLength(28);
  });

  it('gives February its extra day in a leap year', () => {
    expect(monthMatrix(2028, 2).flat().filter((d) => d !== null)).toHaveLength(29);
  });
});

describe('MonthGrid', () => {
  it('renders a labelled grid for the month', () => {
    renderGrid();
    expect(screen.getByRole('grid', { name: /December 2026/ })).toBeInTheDocument();
  });

  it('places a deadline on its day', () => {
    renderGrid();
    const cell = screen.getByRole('gridcell', { name: /30 December 2026/ });
    expect(within(cell).getByText(/ARRL Foundation Scholarship/)).toBeInTheDocument();
  });

  it('marks an estimated cycle as projected, in words as well as style', () => {
    renderGrid();
    const chip = screen.getByRole('link', { name: /ARDC Grants Program.*projected/i });
    expect(chip).toHaveClass('estimated');
  });

  it('says funder-published, not merely "not projected", on an observed cycle', () => {
    renderGrid();
    const chip = screen.getByRole('link', { name: /ARRL Foundation Scholarship Program/ });
    expect(chip).toHaveAccessibleName(/funder-published/i);
    expect(chip).not.toHaveClass('estimated');
  });

  it('shows a start-preparing marker on the prep start day, even when the deadline is in another month', () => {
    renderGrid();
    const cell = screen.getByRole('gridcell', { name: /16 December 2026/ });
    expect(within(cell).getByText(/start preparing/i)).toBeInTheDocument();
    expect(within(cell).getByText(/NCDXF Grants/)).toBeInTheDocument();
    // One December prep start in the fixture, so one marker on the whole grid.
    expect(screen.getAllByText(/start preparing/i)).toHaveLength(1);
  });

  it('marks the day a funder-published window opens', () => {
    renderGrid();
    // Anchored: /7 December 2026/ also matches the 17th and the 27th.
    const cell = screen.getByRole('gridcell', { name: /^7 December 2026$/ });
    expect(within(cell).getByText(/opens/i)).toBeInTheDocument();
    expect(within(cell).getByText(/ARISS Contact Proposals/)).toBeInTheDocument();
  });

  /**
   * THE ONE-DAY-LATE DEFECT, IN THE OTHER DIMENSION. A deadline is the UTC instant of a 23:59
   * LOCAL wall time, so the ARRL's "closes 28 February 2027" (America/New_York) is stored
   * `2027-03-01T04:59:00.000Z`. Placed by its UTC day the chip lands in MARCH — not one cell
   * late, an entire month away from the month the funder published.
   */
  it('places a 23:59-local deadline in the funder’s month, not the UTC one', () => {
    const late: CalendarEntry = {
      ...entries[0]!,
      cycle: {
        id: 'c5',
        programId: 'arrl-grants',
        closesAt: '2027-03-01T04:59:00.000Z',
        timezone: 'America/New_York',
        label: 'Feb 2027 close',
        isEstimated: false,
      },
      programId: 'arrl-grants',
      programName: 'ARRL Amateur Radio Grants',
      prepStartAt: null,
    };

    const { unmount } = render(
      <MemoryRouter>
        <MonthGrid year={2027} month={2} entries={[late]} now={NOW} />
      </MemoryRouter>,
    );
    const feb = screen.getByRole('gridcell', { name: /28 February 2027/ });
    expect(within(feb).getByText(/ARRL Amateur Radio Grants/)).toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter>
        <MonthGrid year={2027} month={3} entries={[late]} now={NOW} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/ARRL Amateur Radio Grants/)).not.toBeInTheDocument();
  });

  it('pads with empty cells rather than with a neighbouring month’s days', () => {
    renderGrid();
    const cells = screen.getAllByRole('gridcell');
    expect(cells).toHaveLength(35); // December 2026 fits in five Monday-first weeks.
    expect(cells.filter((c) => c.getAttribute('aria-label') !== null)).toHaveLength(31);
    for (const cell of cells) {
      expect(cell.getAttribute('aria-label') ?? '').not.toMatch(/November|January/);
    }
  });

  it('links a chip to the opportunity and never to a blocked host', () => {
    renderGrid();
    const chip = screen.getByRole('link', { name: /ARDC Grants Program/ });
    expect(chip).toHaveAttribute('href', '/o/ardc-grants');
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org/);
    }
  });

  it('renders an empty month as a labelled emptiness rather than a blank slab', () => {
    render(
      <MemoryRouter>
        <MonthGrid year={2026} month={9} entries={[]} now={NOW} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/nothing falls in September 2026/i)).toBeInTheDocument();
  });
});
