import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GROUP_MIN, MonthGrid, groupByDeadlineOwner, monthMatrix } from './MonthGrid.js';
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
    deadlineSource: { kind: 'stated' },
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
    deadlineSource: { kind: 'stated' },
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
    deadlineSource: { kind: 'stated' },
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
    deadlineSource: { kind: 'stated' },
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
    expect(screen.getByRole('table', { name: /December 2026/ })).toBeInTheDocument();
  });

  it('places a deadline on its day', () => {
    renderGrid();
    const cell = screen.getByRole('cell', { name: /30 December 2026/ });
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
    const cell = screen.getByRole('cell', { name: /16 December 2026/ });
    expect(within(cell).getByText(/start preparing/i)).toBeInTheDocument();
    expect(within(cell).getByText(/NCDXF Grants/)).toBeInTheDocument();
    // One December prep start in the fixture, so one marker on the whole grid.
    expect(screen.getAllByText(/start preparing/i)).toHaveLength(1);
  });

  it('marks the day a funder-published window opens', () => {
    renderGrid();
    // Anchored: /7 December 2026/ also matches the 17th and the 27th.
    const cell = screen.getByRole('cell', { name: /^7 December 2026$/ });
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
    const feb = screen.getByRole('cell', { name: /28 February 2027/ });
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
    const cells = screen.getAllByRole('cell');
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

/**
 * TASK 21 — THE 113-CHIP DAY.
 *
 * The real corpus puts 113 entries on 2026-12-30, and 112 of them inherit that date from one
 * record: the ARRL Foundation scholarship portal. Rendered as 113 independent chips the cell says
 * "113 deadlines that happen to coincide", which is false and is also unusable — the one thing a
 * planner needs to see, that clearing ONE portal deadline is what clears all of them, is the one
 * thing buried.
 *
 * The fixture is built at the real size on purpose. A 5-entry stand-in would have passed against a
 * renderer that still emitted 113 chips.
 */
const OWNER_ID = 'arrl-foundation-scholarship';
const OWNER_NAME = 'ARRL Foundation Scholarship Program';

function denseDecember(): CalendarEntry[] {
  const owner: CalendarEntry = {
    ...entries[0]!,
    cycle: { ...entries[0]!.cycle, id: 'owner-cycle', isEstimated: true },
    isEstimated: true,
    deadlineSource: { kind: 'stated' },
  };
  const riders = Array.from({ length: 112 }, (_, i): CalendarEntry => ({
    ...owner,
    cycle: { ...owner.cycle, id: `rider-${String(i)}`, programId: `rider-${String(i)}` },
    programId: `rider-${String(i)}`,
    programName: `Rider Scholarship ${String(i)}`,
    deadlineSource: { kind: 'inherited', fromProgramId: OWNER_ID, fromProgramName: OWNER_NAME },
  }));
  return [owner, ...riders];
}

describe('groupByDeadlineOwner', () => {
  it('folds the riders of one owner together and leaves self-stated entries alone', () => {
    const { solo, groups } = groupByDeadlineOwner(denseDecember());
    expect(solo.map((e) => e.programId)).toEqual([OWNER_ID]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ownerId).toBe(OWNER_ID);
    expect(groups[0]!.ownerName).toBe(OWNER_NAME);
    expect(groups[0]!.entries).toHaveLength(112);
  });

  /**
   * A disclosure costs a click and a line of chrome. Below `GROUP_MIN` riders that is more
   * attention than the chips it would fold, so a small group stays as chips — each of which still
   * names its owner in its own accessible name. The rule is about LAYOUT, never about what is said.
   */
  it('leaves a group smaller than the threshold as ordinary chips', () => {
    const dense = denseDecember();
    const small = [dense[0]!, ...dense.slice(1, GROUP_MIN)];
    const { solo, groups } = groupByDeadlineOwner(small);
    expect(groups).toHaveLength(0);
    expect(solo).toHaveLength(GROUP_MIN);
  });

  it('never loses or duplicates an entry, whatever the shape', () => {
    const dense = denseDecember();
    const { solo, groups } = groupByDeadlineOwner(dense);
    const seen = [...solo, ...groups.flatMap((g) => g.entries)].map((e) => e.cycle.id);
    expect(new Set(seen).size).toBe(dense.length);
    expect(seen).toHaveLength(dense.length);
  });

  it('keeps riders of different owners in different groups', () => {
    const dense = denseDecember();
    const other = dense.slice(1, 5).map(
      (e, i): CalendarEntry => ({
        ...e,
        cycle: { ...e.cycle, id: `other-${String(i)}` },
        programId: `other-${String(i)}`,
        deadlineSource: { kind: 'inherited', fromProgramId: 'ncdxf-grants', fromProgramName: 'NCDXF Grants' },
      }),
    );
    const { groups } = groupByDeadlineOwner([...dense, ...other]);
    expect(groups.map((g) => g.ownerId).sort()).toEqual(['arrl-foundation-scholarship', 'ncdxf-grants']);
  });
});

describe('MonthGrid — a day 113 entries deep', () => {
  function renderDense() {
    return render(
      <MemoryRouter>
        <MonthGrid year={2026} month={12} entries={denseDecember()} now={NOW} />
      </MemoryRouter>,
    );
  }

  function decemberThirtieth(): HTMLElement {
    return screen.getByRole('cell', { name: /^30 December 2026$/ });
  }

  it('shows the owner’s own deadline as a chip and folds the 112 that ride it', () => {
    renderDense();
    const cell = decemberThirtieth();
    // The chips a reader has to take in at a glance: the portal deadline, and one group.
    expect(cell.querySelectorAll(':scope > a.chip')).toHaveLength(1);
    // Anchored to the START of the accessible name: every one of the 112 folded chips also
    // CONTAINS the owner's name, which is the point of the fix and would otherwise match here.
    expect(
      within(cell).getByRole('link', { name: new RegExp(`^${OWNER_NAME}:`), hidden: true }),
    ).toHaveAttribute('href', `/o/${OWNER_ID}`);
    expect(cell.querySelectorAll('details.chip-group')).toHaveLength(1);
  });

  /**
   * THE FAILURE THIS MUST NOT REPRODUCE. `undated` once reported 147 of 150 programmes as
   * deadline-less because a window-scoped count was rendered as a corpus-wide claim; a "+N more"
   * that swallowed 112 chips would be the same lie in the other direction. The count and the owner
   * are both in the visible summary, so the cell states its own size before anything is opened.
   */
  it('states how many it folded, and whose date they ride, without being opened', () => {
    renderDense();
    const summary = within(decemberThirtieth()).getByText(/112 programmes ride/i);
    expect(summary).toHaveTextContent(OWNER_NAME);
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary.closest('details')).not.toHaveAttribute('open');
  });

  /** Folded is not dropped: all 113 links are in the cell, reachable, before any interaction. */
  it('keeps every one of the 113 entries in the day, not merely the visible ones', () => {
    renderDense();
    expect(decemberThirtieth().querySelectorAll('a[href^="/o/"]')).toHaveLength(113);
  });

  it('opens to reveal every rider as its own link', async () => {
    renderDense();
    const cell = decemberThirtieth();
    await userEvent.click(within(cell).getByText(/112 programmes ride/i));
    expect(cell.querySelector('details.chip-group')).toHaveAttribute('open');
    expect(within(cell).getByRole('link', { name: /Rider Scholarship 0:/ })).toHaveAttribute(
      'href',
      '/o/rider-0',
    );
  });

  it('says in words that one date moves all of them, which is the reason to group at all', () => {
    renderDense();
    expect(within(decemberThirtieth()).getByText(/one date, 112 applications/i)).toBeInTheDocument();
  });

  /** Every rider names its owner whether it was folded or not. Grouping is layout, not the claim. */
  it('names the owner in each folded chip’s accessible name', () => {
    renderDense();
    const chip = within(decemberThirtieth()).getByRole('link', {
      name: /Rider Scholarship 3:/,
      hidden: true,
    });
    expect(chip).toHaveAccessibleName(new RegExp(`inherited from ${OWNER_NAME}`, 'i'));
  });

  /**
   * The prep overlay stacks exactly as hard: all 113 share a prep start of 2026-11-30, so November
   * would have carried 113 "Start preparing" rows. The same fold applies, with its own wording.
   */
  it('folds the prep overlay on the day 113 runways start', () => {
    render(
      <MemoryRouter>
        <MonthGrid year={2026} month={11} entries={denseDecember()} now={NOW} />
      </MemoryRouter>,
    );
    const cell = screen.getByRole('cell', { name: /^30 November 2026$/ });
    expect(cell.querySelectorAll(':scope > a.prep-mark')).toHaveLength(1);
    expect(within(cell).getByText(/112 programmes ride/i)).toBeInTheDocument();
    expect(cell.querySelectorAll('a[href^="/o/"]')).toHaveLength(113);
  });

  /**
   * THE TWO CYCLE KINDS MUST SURVIVE THE FOLD. `isEstimated` is the distinction this whole screen
   * exists for — 4 of 244 cycles are funder-published — and a folded chip is still a chip: dashed
   * when projected, "projected, not observed" in its accessible name, and NO opening mark, because
   * a projected opening is a projection of a projection.
   */
  it('keeps projected and funder-published distinct inside a fold', () => {
    const dense = denseDecember();
    // Ten of the riders become windows the funder actually printed. 17:00Z is midday on the 30th
    // in New York, so both ends land on the day under test in the cycle's own zone.
    const published = dense.slice(1, 11).map(
      (e): CalendarEntry => ({
        ...e,
        cycle: { ...e.cycle, opensAt: '2026-12-30T17:00:00.000Z', isEstimated: false },
        isEstimated: false,
      }),
    );
    render(
      <MemoryRouter>
        <MonthGrid
          year={2026}
          month={12}
          entries={[dense[0]!, ...published, ...dense.slice(11)]}
          now={NOW}
        />
      </MemoryRouter>,
    );
    const cell = screen.getByRole('cell', { name: /^30 December 2026$/ });

    const projected = within(cell).getByRole('link', {
      name: /Rider Scholarship 100: 2026-12-30/,
      hidden: true,
    });
    expect(projected).toHaveClass('estimated');
    expect(projected).toHaveAccessibleName(/projected, not observed/i);

    const stated = within(cell).getByRole('link', {
      name: /Rider Scholarship 5: 2026-12-30/,
      hidden: true,
    });
    expect(stated).not.toHaveClass('estimated');
    expect(stated).toHaveAccessibleName(/funder-published/i);
    expect(stated).not.toHaveAccessibleName(/projected/i);

    // Ten funder-published windows open on this day; the 102 projected cycles contribute no
    // opening mark at all — a projected opening is a projection of a projection.
    expect(cell.querySelectorAll('a.opens-mark')).toHaveLength(10);
  });
});

/**
 * THE PREP MARK CARRIES THE SAME DISTINCTION THE CHIP DOES — close-out review finding I2.
 *
 * `CloseChip` has said "projected, not observed" since Task 20; `PrepMark` said nothing, and a
 * prep mark is the mark on this page a planner ACTS on: it is an instruction to start work.
 * Measured against the real corpus, a 12-month window holds 127 calendar entries of which 123 are
 * projected and 4 are funder-published, and `MonthGrid` pushes a prep mark for EVERY entry — so
 * 123 of 127 prep marks were unqualified instructions to prepare for a date no funder announced.
 *
 * The marker is carried in the VISIBLE TEXT, before the programme name, not only in a class and
 * not only at the end: `.prep-mark` is `white-space: nowrap; text-overflow: ellipsis`, so a
 * suffix is exactly what a narrow cell truncates away.
 */
describe('MonthGrid — a prep mark never hides that its date is projected', () => {
  it('says projected on the prep mark of a projected cycle, in visible text and in its name', () => {
    renderGrid();
    const cell = screen.getByRole('cell', { name: /^16 December 2026$/ });
    const mark = within(cell).getByRole('link', { name: /start preparing/i });
    expect(mark).toHaveTextContent(/projected/i);
    expect(mark).toHaveAccessibleName(/projected, not observed/i);
    expect(mark).toHaveClass('estimated');
  });

  it('does not call a funder-published prep mark projected', () => {
    render(
      <MemoryRouter>
        <MonthGrid year={2026} month={11} entries={entries} now={NOW} />
      </MemoryRouter>,
    );
    const cell = screen.getByRole('cell', { name: /^30 November 2026$/ });
    const mark = within(cell).getByRole('link', { name: /start preparing/i });
    expect(mark).toHaveTextContent(/ARRL Foundation Scholarship Program/);
    expect(mark).not.toHaveTextContent(/projected/i);
    expect(mark).toHaveAccessibleName(/funder-published/i);
    expect(mark).not.toHaveClass('estimated');
  });

  /** The fold is layout. It may not launder a projection into an unqualified instruction. */
  it('keeps the marker on every prep mark inside a fold', () => {
    render(
      <MemoryRouter>
        <MonthGrid year={2026} month={11} entries={denseDecember()} now={NOW} />
      </MemoryRouter>,
    );
    const cell = screen.getByRole('cell', { name: /^30 November 2026$/ });
    const marks = cell.querySelectorAll('a.prep-mark');
    expect(marks).toHaveLength(113);
    for (const mark of marks) {
      expect(mark.textContent ?? '').toMatch(/projected/i);
      expect(mark.getAttribute('aria-label') ?? '').toMatch(/projected, not observed/i);
    }
  });
});
