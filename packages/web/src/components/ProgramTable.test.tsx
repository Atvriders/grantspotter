import { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ProgramTable, PROGRAMME_TABLE_MIN_PX } from './ProgramTable.js';
import type { ProgramRow } from './ProgramTable.js';
import {
  ARRL_FOUNDATION_ROW,
  ARRL_GRANTS_ROW,
  CHICAGO_FM_ROW,
  FAR_SAFETY_ROW,
  NO_ZONE_ROW,
  makeProgram,
  makeRow,
} from '../test/programRowFixtures.js';
import { restoreViewport, setViewportWidth } from '../test/viewport.js';

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

  /**
   * The applicant-entity reason is composed by `matcher.ts`, not read off a page, so it carries an
   * empty `rawText`. This list used to print `reason.rawText` bare, which would now open an
   * `aria-expanded="true"` onto a blank line — the same unkept promise the drawer exists to avoid
   * — and before the matcher fix printed a fabricated funder sentence containing an enum
   * identifier. It shows the software's own sentence, marked as the software's.
   */
  it('opens a composed reason as GrantSpotter’s own, never as a blank line', async () => {
    function AuthoredHarness(): JSX.Element {
      const [expandedId, setExpandedId] = useState<string | null>(null);
      const row: ProgramRow = {
        ...CHICAGO_FM_ROW,
        verdict: {
          kind: 'ineligible',
          reasons: [
            {
              id: `${CHICAGO_FM_ROW.program.id}:applicant-entity`,
              hard: true,
              fallbackRank: 0,
              rawText: '',
              spec: {
                axis: 'other',
                note:
                  'GrantSpotter, not the funder: this record lists who may apply as individuals, ' +
                  'and your profile applies as a club that is its own 501(c)(3).',
              },
            },
          ],
        },
      };
      return (
        <ProgramTable
          rows={[row]}
          now={NOW}
          expandedId={expandedId}
          onExplain={(id) => setExpandedId(id)}
        />
      );
    }
    const { container } = render(
      <MemoryRouter>
        <AuthoredHarness />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: /ineligible/i }));
    const item = container.querySelector('.reasons-list li')!;
    expect(item.textContent).toContain('GrantSpotter, not the funder');
    expect(item.textContent).toContain('applies as a club that is its own 501(c)(3)');
    expect(within(item as HTMLElement).getByText('Who may apply')).toBeInTheDocument();
    expect(item.textContent).not.toContain('accepts applications from');
    expect(item.textContent).not.toMatch(/[a-z]+_[a-z]+_[a-z]/);
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

/**
 * THE ROW THAT CARRIES EVERY HONESTY MARKER AT ONCE.
 *
 * No single row in the shipped corpus does, so the fixture assembles them: a projected close date
 * (`est.`), a cycle whose zone was never recorded (`UTC`), a real status, a `lastVerifiedAt` old
 * enough to be amber, a disputed block, a stale-mirror warning and the compromised-domain tag.
 * The disputed wording is the ARRL Club Grant's own, from `data/seed/programs.negatives.json`.
 *
 * `amountRaw` is the Yaesu record's actual prose, because a sentence in the amount column is what
 * blew this table to 2,563 px in the first place.
 */
const EVERY_MARKER_ROW: ProgramRow = makeRow({
  program: makeProgram({
    id: 'every-marker',
    name: 'ARRL Club Grant Program',
    amount: {
      instrument: 'unknown',
      amountRaw:
        'The new program price is either $1,450.00 or $2,300.00 depending on configuration, ' +
        'and the club pays shipping.',
      awardCountRaw: 'Not published',
    },
    trust: {
      status: 'dormant',
      sourceUrl: 'https://www.arrl.org/club-grant-program',
      lastVerifiedAt: '2026-01-05T00:00:00.000Z',
      verificationMethod: 'manual_curation',
      contentHash: 'every',
      staleMirrorWarning:
        'Still listed by 7 or more third-party aggregators, which mirror stale ARRL data.',
      disputed: {
        note: 'Three independent readings of the ARRL Club Grant cycle, and the page publishes no deadline field.',
        claims: [
          { claim: 'Dormant: the page shows only 2024 results.', sourceUrl: 'https://example.org/a' },
          { claim: 'Autumn window: September 7 to November 4.', sourceUrl: 'https://example.org/b' },
          { claim: 'February / June / October cycles.', sourceUrl: 'https://example.org/c' },
        ],
      },
    },
    tags: ['ham', 'grant', 'arrl', 'disputed', 'safety_warning'],
  }),
  funderName: 'ARRL Foundation',
  verdict: { kind: 'unknown', missingProfileFields: ['is501c3'] },
  nextClosesAt: '2027-03-01T04:59:00.000Z',
  nextIsEstimated: true,
  nextTimezone: null,
});

/**
 * Every marker, as the query that finds it.
 *
 * The list is shared by the wide and the narrow assertion below, and that sharing IS the test:
 * a marker dropped from one layout fails against the list the other layout still satisfies. It is
 * written as queries rather than as class names because what has to survive is the marker a
 * READER gets — the word, or the accessible name — not the element that happens to carry it.
 */
const HONESTY_MARKERS: Array<[string, () => HTMLElement]> = [
  ['the "est." projected-date prefix', () => screen.getByText('est.')],
  [
    'the projected-date explanation, announced and not merely titled',
    () => screen.getByLabelText(/projected from a recurrence rule.*not published by the funder/i),
  ],
  ['the UTC zone mark', () => screen.getByText('UTC')],
  [
    'the missing-zone explanation',
    () => screen.getByLabelText(/time zone was not recorded.*shown in utc/i),
  ],
  ['the status pill', () => screen.getByLabelText('Status: dormant')],
  [
    'the lastVerifiedAt badge, amber and dated',
    () => screen.getByLabelText(/unverified\. last checked 2026-01-05/i),
  ],
  ['the disputed marker', () => screen.getByRole('note', { name: /disputed/i })],
  ['the safety warning', () => screen.getByRole('note', { name: /safety warning/i })],
  ['the stale-mirror warning', () => screen.getByText(/mirror stale ARRL data/i)],
  ['the verdict badge', () => screen.getByLabelText(/^Unknown, needs /)],
];

describe('ProgramTable honesty markers survive the narrow layout', () => {
  afterEach(() => {
    restoreViewport();
  });

  it('renders a table above the width the table fits at', () => {
    setViewportWidth(PROGRAMME_TABLE_MIN_PX);
    renderTable([EVERY_MARKER_ROW]);
    expect(screen.getByRole('table', { name: /opportunities/i })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /opportunities/i })).not.toBeInTheDocument();
  });

  it('stacks into records below it', () => {
    setViewportWidth(PROGRAMME_TABLE_MIN_PX - 1);
    renderTable([EVERY_MARKER_ROW]);
    expect(screen.getByRole('list', { name: /opportunities/i })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  for (const [what, find] of HONESTY_MARKERS) {
    it(`keeps ${what} at 320 px`, () => {
      setViewportWidth(320);
      renderTable([EVERY_MARKER_ROW]);
      expect(find()).toBeInTheDocument();
    });

    it(`keeps ${what} in the table too`, () => {
      setViewportWidth(1280);
      renderTable([EVERY_MARKER_ROW]);
      expect(find()).toBeInTheDocument();
    });
  }

  /**
   * The rule the brief states and this file has to hold to: when space runs out the AMOUNT is what
   * gives ground, and the markers never do. On the narrowest layout nothing gives ground at all,
   * because a stack has no column to lose — so the amount is here in full, prose and all, and
   * carries none of the table's clipping.
   */
  it('keeps the funder’s full wording of the amount on the narrow card, unclipped', () => {
    setViewportWidth(320);
    const { container } = renderTable([EVERY_MARKER_ROW]);
    expect(
      screen.getByText(/The new program price is either \$1,450\.00 or \$2,300\.00/),
    ).toBeInTheDocument();
    expect(container.querySelector('.amount-clip')).toBeNull();
  });

  /**
   * In the table it IS clipped, to four lines — and the clip is visual only. jsdom computes no
   * layout, so what is asserted is the thing a clip could get wrong: that the sentence a screen
   * reader reads, and the sentence a `Ctrl-F` finds, is still the whole one.
   */
  it('clips the amount in the table without removing a word of it from the document', () => {
    setViewportWidth(1280);
    const { container } = renderTable([EVERY_MARKER_ROW]);
    const clip = container.querySelector('.amount-clip');
    expect(clip).not.toBeNull();
    expect(clip?.textContent).toBe(EVERY_MARKER_ROW.program.amount.amountRaw);
  });

  it('opens the constraint drawer on a record card, not only in a table row', async () => {
    setViewportWidth(320);
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
    render(
      <MemoryRouter>
        <Expandable />
      </MemoryRouter>,
    );
    const badge = screen.getByRole('button', { name: /ineligible/i });
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(badge);
    expect(screen.getByText('This program is discontinued.')).toBeInTheDocument();
  });
});
