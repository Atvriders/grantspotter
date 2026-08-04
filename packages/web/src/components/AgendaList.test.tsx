import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgendaList, type CalendarEntry } from './AgendaList.js';

const NOW = '2026-12-01T00:00:00.000Z';

function entry(over: Partial<CalendarEntry> = {}): CalendarEntry {
  const base: CalendarEntry = {
    cycle: {
      id: 'c1',
      programId: 'arrl-foundation-scholarship',
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
    prepNote: 'The single ARRL Foundation application needs a transcript and references.',
    decisionLagMinDays: null,
    decisionLagMaxDays: null,
    watched: false,
    verdictKind: 'eligible',
    status: 'unknown',
    lastVerifiedAt: '2026-11-20T00:00:00.000Z',
  };
  return { ...base, ...over };
}

function renderAgenda(entries: CalendarEntry[]) {
  return render(
    <MemoryRouter>
      <AgendaList entries={entries} now={NOW} />
    </MemoryRouter>,
  );
}

describe('AgendaList', () => {
  it('names the list so a screen reader can find it', () => {
    renderAgenda([entry()]);
    expect(screen.getByRole('list', { name: /agenda/i })).toBeInTheDocument();
  });

  it('says nothing is dated rather than rendering an empty list', () => {
    renderAgenda([]);
    expect(screen.getByText(/no dated cycles fall inside this window/i)).toBeInTheDocument();
  });

  /**
   * THE ONE-DAY-LATE DEFECT. A deadline is the UTC instant of a 23:59 LOCAL wall time, so
   * `2027-03-01T04:59:00.000Z` in America/New_York is the funder's 28 February. Printed in UTC it
   * gives the applicant a day they do not have — the exact direction of error this product exists
   * to prevent. The brief for this task called `formatDate(closesAt)` with no zone.
   */
  it('prints the funder’s calendar day, not the UTC one', () => {
    renderAgenda([
      entry({
        cycle: {
          id: 'c9',
          programId: 'arrl-grants',
          closesAt: '2027-03-01T04:59:00.000Z',
          timezone: 'America/New_York',
          label: 'Feb 2027 close',
          isEstimated: false,
        },
        prepStartAt: null,
      }),
    ]);
    expect(screen.getByText(/2027-02-28 deadline/)).toBeInTheDocument();
    expect(screen.queryByText(/2027-03-01/)).not.toBeInTheDocument();
  });

  it('names the zone the date is expressed in', () => {
    renderAgenda([entry()]);
    expect(screen.getByText(/America\/New_York/)).toBeInTheDocument();
  });

  /**
   * A `Cycle.timezone` that is missing means NOT RECORDED. Rendering UTC is the honest reading of
   * an instant whose frame nobody observed; silently substituting the browser's zone would
   * manufacture a calendar day out of nothing.
   */
  it('labels an unrecorded zone as UTC rather than guessing the browser’s', () => {
    renderAgenda([
      entry({
        cycle: { ...entry().cycle, timezone: '' },
      }),
    ]);
    expect(screen.getByText(/UTC — no zone recorded/i)).toBeInTheDocument();
  });

  /**
   * Two IEEE programmes are modelled as DEADLINES, not windows: mtt.org prints only "must be
   * received by October 1" and states no opening. A one-day window would read `closed` on 364 days
   * a year and would assert an opening date IEEE has never published.
   */
  it('renders a cycle with no opening as a deadline, not a one-day window', () => {
    renderAgenda([
      entry({
        cycle: {
          id: 'ieee',
          programId: 'ieee-mtts',
          closesAt: '2026-10-01T00:00:00.000Z',
          timezone: 'UTC',
          label: 'Due 1 October',
          isEstimated: true,
        },
        programId: 'ieee-mtts',
        programName: 'IEEE MTT-S Undergraduate Scholarship',
        prepStartAt: null,
      }),
    ]);
    expect(screen.getByText(/2026-10-01 deadline/i)).toBeInTheDocument();
    expect(screen.queryByText(/window/i)).not.toBeInTheDocument();
  });

  it('renders a funder-published window as a span with both ends', () => {
    renderAgenda([
      entry({
        cycle: {
          id: 'ariss',
          programId: 'ariss-proposals',
          opensAt: '2026-07-01T00:00:00.000Z',
          closesAt: '2026-09-30T00:00:00.000Z',
          timezone: 'UTC',
          label: 'ARISS window',
          isEstimated: false,
        },
        programId: 'ariss-proposals',
        programName: 'ARISS Contact Proposals',
        prepStartAt: null,
      }),
    ]);
    expect(screen.getByText(/2026-07-01\s*–\s*2026-09-30 window/i)).toBeInTheDocument();
  });

  /** The distinction this screen exists to preserve: 4 of 244 cycles are the funder's own. */
  it('separates funder-published from projected in words', () => {
    renderAgenda([entry({ cycle: { ...entry().cycle, isEstimated: false }, isEstimated: false })]);
    expect(screen.getByText(/funder-published/i)).toBeInTheDocument();
    expect(screen.queryByText(/projected, not observed/i)).not.toBeInTheDocument();
  });

  it('marks a projected cycle as projected, and styles it apart', () => {
    renderAgenda([
      entry({
        cycle: { ...entry().cycle, id: 'c2', isEstimated: true },
        isEstimated: true,
      }),
    ]);
    expect(screen.getByText(/projected, not observed/i)).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveClass('estimated');
  });

  it('states the prep start date, the lead and the reason', () => {
    renderAgenda([entry()]);
    expect(screen.getByText(/start by 2026-11-30/i)).toBeInTheDocument();
    expect(screen.getByText(/30 days ahead/i)).toBeInTheDocument();
    expect(screen.getByText(/transcript and references/i)).toBeInTheDocument();
  });

  it('states a decision lag when the funder published one', () => {
    renderAgenda([entry({ decisionLagMinDays: 60, decisionLagMaxDays: 120 })]);
    expect(screen.getByText(/decision in 60 to 120 days/i)).toBeInTheDocument();
  });

  it('says nothing about a decision when the funder published no lag', () => {
    renderAgenda([entry()]);
    expect(screen.queryByText(/decision in/i)).not.toBeInTheDocument();
  });

  /**
   * Plan 3 Global Constraints: "every user-facing date renders with its `lastVerifiedAt`
   * provenance — no bare dates", and "`status: 'unknown'` renders as a real, labelled state". The
   * calendar is nothing but dates, and 118 of 150 records carry `unknown`.
   */
  it('carries the status and the verification provenance of every dated claim', () => {
    renderAgenda([entry()]);
    const row = screen.getByRole('listitem');
    expect(within(row).getByRole('img', { name: /Status: unknown/i })).toBeInTheDocument();
    // Anchored — /Verified/ also matches the amber "Unverified" badge, which is a different claim.
    expect(within(row).getByRole('img', { name: /^Verified/ })).toBeInTheDocument();
  });

  it('renders the instrument in words rather than as an enum', () => {
    renderAgenda([entry({ instrument: 'per_member_rebate' })]);
    expect(screen.getByText(/per-member rebate/i)).toBeInTheDocument();
    expect(screen.queryByText(/per_member_rebate/)).not.toBeInTheDocument();
  });

  it('marks a watched program', () => {
    renderAgenda([entry({ watched: true })]);
    expect(screen.getByText(/watching/i)).toBeInTheDocument();
  });

  it('links to the opportunity and never to a blocked host', () => {
    renderAgenda([entry()]);
    expect(
      screen.getByRole('link', { name: /ARRL Foundation Scholarship Program/ }),
    ).toHaveAttribute('href', '/o/arrl-foundation-scholarship');
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org/);
    }
  });

  /**
   * TASK 21. 112 of the 150 publishable programmes hold no deadline of their own — they ride the
   * ARRL Foundation scholarship portal's single window. An agenda card that prints that date with
   * no attribution asserts that this funder published it, which this one did not. The owner is
   * named AND linked, because the row's practical advice is "the thing you actually submit to is
   * over there".
   */
  it('names and links the programme an inherited date came from', () => {
    renderAgenda([
      entry({
        cycle: { ...entry().cycle, id: 'qcwa' },
        programId: 'qcwa-memorial-scholarship',
        programName: 'QCWA Memorial Scholarship Fund',
        deadlineSource: {
          kind: 'inherited',
          fromProgramId: 'arrl-foundation-scholarship',
          fromProgramName: 'ARRL Foundation Scholarship Program',
        },
      }),
    ]);
    expect(screen.getByText(/inherited from/i)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /ARRL Foundation Scholarship Program/ }),
    ).toHaveAttribute('href', '/o/arrl-foundation-scholarship');
  });

  /** The other half of the same claim: a programme that stated its own date must not borrow one. */
  it('says a self-stated deadline is this programme’s own, and claims no inheritance', () => {
    renderAgenda([entry()]);
    expect(screen.getByText(/stated by this programme/i)).toBeInTheDocument();
    expect(screen.queryByText(/inherited from/i)).not.toBeInTheDocument();
  });

  it('keys rows by cycle so two cycles of one program both render', () => {
    renderAgenda([
      entry(),
      entry({
        cycle: { ...entry().cycle, id: 'c1b', closesAt: '2027-12-30T17:00:00.000Z' },
        isEstimated: true,
      }),
    ]);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
