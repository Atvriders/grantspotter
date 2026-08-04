import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ProgramTable } from './ProgramTable.js';
import type { ProgramRow } from './ProgramTable.js';
import {
  ARRL_FOUNDATION_ROW,
  ARRL_GRANTS_ROW,
  CHICAGO_FM_ROW,
  FAR_SAFETY_ROW,
  NO_ZONE_ROW,
} from '../test/programRowFixtures.js';

const NOW = '2026-08-02T12:00:00.000Z';

function renderTable(rows: ProgramRow[]) {
  return render(
    <MemoryRouter>
      <ProgramTable rows={rows} now={NOW} />
    </MemoryRouter>,
  );
}

function rowFor(name: string | RegExp): HTMLElement {
  const cell = screen.getByRole('link', { name }).closest('tr');
  if (cell === null) throw new Error('row not found');
  return cell;
}

describe('ProgramTable deadlines', () => {
  /**
   * THE DEFECT THIS TABLE EXISTS TO NOT REPEAT. A deadline is the UTC instant of a LOCAL 23:59
   * wall time. The ARRL's February 2027 window closes `2027-03-01T04:59:00.000Z`, which IS the
   * 28th of February to the funder who published it. Printed in UTC it reads 2027-03-01 — one day
   * LATE, which tells an applicant they have a day the ARRL does not accept.
   */
  it("renders the funder's own calendar day, not the UTC day", () => {
    renderTable([ARRL_GRANTS_ROW]);
    const row = rowFor('ARRL Amateur Radio Grants');
    expect(within(row).getByText('2027-02-28')).toBeInTheDocument();
    expect(within(row).queryByText('2027-03-01')).not.toBeInTheDocument();
  });

  /**
   * A null zone is the projection saying "not recorded". Rendering UTC is the honest reading of an
   * instant with no frame; passing it off as the funder's day is not. So the cell says UTC out
   * loud rather than letting the reader assume the date was localised.
   */
  it('labels a zoneless deadline as UTC instead of implying the funder published that day', () => {
    renderTable([NO_ZONE_ROW]);
    const row = rowFor('Zoneless programme');
    expect(within(row).getByText('2027-03-01')).toBeInTheDocument();
    expect(within(row).getByText('UTC')).toBeInTheDocument();
    expect(
      within(row).getByLabelText(/time zone was not recorded.*shown in utc/i),
    ).toBeInTheDocument();
  });

  it('does not label a zoned deadline as UTC', () => {
    renderTable([ARRL_GRANTS_ROW]);
    expect(within(rowFor('ARRL Amateur Radio Grants')).queryByText('UTC')).not.toBeInTheDocument();
  });

  it('renders an em dash for a program with no next deadline', () => {
    renderTable([CHICAGO_FM_ROW]);
    expect(within(rowFor('Chicago FM Club Scholarship')).getByText('—')).toBeInTheDocument();
  });
});

describe('ProgramTable estimated flag', () => {
  /**
   * `nextIsEstimated` is `false` only where the funder published that window, and that is the rare
   * case: on `data/seed/`, the corpus a fresh install gets, the browse projection resolves a next
   * close date for 121 of 143 programs and 2 of those are funder-published today — 0 from
   * 2026-10-01, when the ARISS and Yaesu windows close. A projected date shown as authoritative is
   * the failure this project spent the most effort eliminating, so BOTH states are marked: absence
   * of a mark would be indistinguishable from a mark nobody thought to add.
   */
  it('marks a projected deadline as an estimate, announced not just titled', () => {
    renderTable([ARRL_GRANTS_ROW]);
    const row = rowFor('ARRL Amateur Radio Grants');
    expect(within(row).getByText('est.')).toBeInTheDocument();
    expect(
      within(row).getByLabelText(/projected from a recurrence rule.*not published by the funder/i),
    ).toBeInTheDocument();
  });

  it('marks a funder-published deadline as published rather than leaving it unmarked', () => {
    renderTable([ARRL_FOUNDATION_ROW]);
    const row = rowFor('ARRL Foundation Scholarship Program');
    expect(within(row).getByText('published')).toBeInTheDocument();
    expect(within(row).getByLabelText(/published by the funder/i)).toBeInTheDocument();
  });

  it('marks nothing at all when there is no deadline to qualify', () => {
    renderTable([CHICAGO_FM_ROW]);
    const row = rowFor('Chicago FM Club Scholarship');
    expect(within(row).queryByText('est.')).not.toBeInTheDocument();
    expect(within(row).queryByText('published')).not.toBeInTheDocument();
  });
});

describe('ProgramTable honesty surfaces', () => {
  it('renders status "discontinued" rather than an empty cell', () => {
    renderTable([CHICAGO_FM_ROW]);
    expect(screen.getByLabelText('Status: discontinued')).toBeInTheDocument();
  });

  it('renders the stale-mirror warning inline on the row that carries it', () => {
    renderTable([ARRL_FOUNDATION_ROW, CHICAGO_FM_ROW]);
    const row = rowFor('Chicago FM Club Scholarship');
    expect(within(row).getByText(/mirror stale ARRL data/i)).toBeInTheDocument();
    expect(
      within(rowFor('ARRL Foundation Scholarship Program')).queryByText(/mirror stale/i),
    ).not.toBeInTheDocument();
  });

  it('renders the amber unverified badge on a record older than 90 days', () => {
    renderTable([CHICAGO_FM_ROW]);
    expect(screen.getByLabelText(/unverified\. last checked 2026-01-05/i)).toBeInTheDocument();
  });

  /** `verdict === null` is "nobody matched you", a different claim from a computed `unknown`. */
  it('distinguishes no-profile from a computed unknown verdict', () => {
    renderTable([FAR_SAFETY_ROW, ARRL_GRANTS_ROW]);
    expect(screen.getByLabelText('No profile set')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Unknown, needs /)).toBeInTheDocument();
  });
});

describe('ProgramTable safety warning', () => {
  /**
   * `farweb.org` was taken over between 2025-10-17 and 2026-02-10 and now redirects to a gambling
   * site, while ARRL, QCWA and club pages still say "apply at the FAR website". The corpus keeps
   * the record ON PURPOSE to intercept that instruction — so the row has to READ as a warning, and
   * the one thing it must never be is a link to that host.
   */
  it('flags a safety_warning record as a warning', () => {
    renderTable([FAR_SAFETY_ROW]);
    const row = rowFor(/Foundation for Amateur Radio/);
    expect(within(row).getByRole('note', { name: /safety warning/i })).toBeInTheDocument();
  });

  it('never emits a link to the compromised host', () => {
    const { container } = renderTable([FAR_SAFETY_ROW]);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    // The row IS linked — to the in-app record. `far-farweb-org-compromised` is the programme id
    // and legitimately contains "farweb"; the host `farweb.org` is what must never appear.
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((href) => href.startsWith('/'))).toBe(true);
    expect(container.innerHTML).not.toContain('farweb.org');
  });

  it('leaves an ordinary record unflagged', () => {
    renderTable([ARRL_FOUNDATION_ROW]);
    expect(screen.queryByRole('note', { name: /safety warning/i })).not.toBeInTheDocument();
  });
});

describe('ProgramTable constraint drawer', () => {
  function Expandable(): JSX.Element {
    const [expandedId, setExpandedId] = useState<string | null>(null);
    return (
      <ProgramTable
        rows={[CHICAGO_FM_ROW]}
        now={NOW}
        expandedId={expandedId}
        onExplain={(id) => setExpandedId((current) => (current === id ? null : id))}
      />
    );
  }

  function renderExpandable() {
    return render(
      <MemoryRouter>
        <Expandable />
      </MemoryRouter>,
    );
  }

  /**
   * `VerdictBadge` sets `aria-expanded` as soon as `onExplain` is supplied. An `aria-expanded`
   * that never reveals anything is a promise the interface does not keep — and the census link
   * beside it says "see the specific constraint for each", so the constraint has to be there.
   */
  it('starts collapsed and says so', () => {
    renderExpandable();
    expect(screen.getByRole('button', { name: /ineligible/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('This program is discontinued.')).not.toBeInTheDocument();
  });

  it("opens the funder's own wording for every unmet constraint", async () => {
    renderExpandable();
    await userEvent.click(screen.getByRole('button', { name: /ineligible/i }));
    expect(screen.getByRole('button', { name: /ineligible/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('This program is discontinued.')).toBeInTheDocument();
  });

  it('closes again on a second press', async () => {
    renderExpandable();
    const badge = screen.getByRole('button', { name: /ineligible/i });
    await userEvent.click(badge);
    await userEvent.click(badge);
    expect(screen.queryByText('This program is discontinued.')).not.toBeInTheDocument();
  });

  it('renders no drawer for a verdict that has no reasons to give', async () => {
    function EligibleHarness(): JSX.Element {
      const [expandedId, setExpandedId] = useState<string | null>(null);
      return (
        <ProgramTable
          rows={[ARRL_GRANTS_ROW]}
          now={NOW}
          expandedId={expandedId}
          onExplain={(id) => setExpandedId(id)}
        />
      );
    }
    const { container } = render(
      <MemoryRouter>
        <EligibleHarness />
      </MemoryRouter>,
    );
    // An `unknown` verdict renders as a span, not a button, so there is nothing to open.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelector('.reasons-cell')).toBeNull();
  });
});

describe('ProgramTable empty state', () => {
  it('shows an empty state rather than a bare table', () => {
    renderTable([]);
    expect(screen.getByText(/no opportunities match these filters/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the caller-supplied note beside the empty state', () => {
    render(
      <MemoryRouter>
        <ProgramTable rows={[]} now={NOW} emptyNote="No profile is set, so no verdict matches." />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no profile is set, so no verdict matches/i)).toBeInTheDocument();
  });
});

describe('ProgramTable amount', () => {
  it('renders the funder’s own words for an unpublished amount', () => {
    renderTable([CHICAGO_FM_ROW]);
    expect(screen.getByText('Not published')).toBeInTheDocument();
  });

  it('renders the raw award range rather than a reformatted number', () => {
    renderTable([ARRL_FOUNDATION_ROW]);
    expect(screen.getByText('$500 - $25,000')).toBeInTheDocument();
  });
});
