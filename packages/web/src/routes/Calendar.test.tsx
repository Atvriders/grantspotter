import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Calendar } from './Calendar.js';

const NOW = '2026-08-02T12:00:00.000Z';

/**
 * The shape `GET /api/calendar` actually returns (`CalendarResponse` in
 * `packages/server/src/api/calendarRouter.ts`), not the shape the brief transcribed. Every entry
 * carries `status` and `lastVerifiedAt`, and every undated row carries `funderName` and
 * `lastVerifiedAt` as well — the calendar is nothing but dates, so Plan 3's "no bare dates" and
 * "`unknown` is a rendered state" constraints are unmeetable without them.
 *
 * The two entries are the two kinds the corpus holds: one of the FOUR funder-published cycles and
 * one of the 240 projected ones.
 */
const RESPONSE = {
  from: '2026-08-02T12:00:00.000Z',
  to: '2027-08-02T12:00:00.000Z',
  entries: [
    {
      cycle: {
        id: 'c1',
        programId: 'arrl-foundation-scholarship',
        opensAt: '2026-10-30T00:00:00.000Z',
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
      prepNote: 'The ARRL application needs a transcript and references.',
      decisionLagMinDays: null,
      decisionLagMaxDays: null,
      watched: false,
      verdictKind: 'eligible',
      status: 'unknown',
      lastVerifiedAt: '2026-07-20T00:00:00.000Z',
    },
    {
      cycle: {
        id: 'c2',
        programId: 'ardc-grants',
        closesAt: '2027-02-01T00:00:00.000Z',
        timezone: 'UTC',
        label: 'Feb 2027 cycle',
        isEstimated: true,
      },
      programId: 'ardc-grants',
      programName: 'ARDC Grants Program',
      funderName: 'Amateur Radio Digital Communications',
      klass: 'ham_grant',
      instrument: 'cash_range',
      applicantEntities: ['university', 'club_via_fiscal_sponsor'],
      isEstimated: true,
      deadlineSource: { kind: 'stated' },
      prepLeadDays: 45,
      prepStartAt: '2026-12-18T00:00:00.000Z',
      prepNote: 'ARDC evaluates for 60 to 120 days after a cycle closes.',
      decisionLagMinDays: 60,
      decisionLagMaxDays: 120,
      watched: true,
      verdictKind: 'unknown',
      status: 'unknown',
      lastVerifiedAt: '2026-07-28T00:00:00.000Z',
    },
  ],
  undated: [
    {
      programId: 'arrl-club-grant',
      programName: 'ARRL Club Grant Program',
      funderName: 'ARRL',
      deadlineKind: 'unpublished',
      deadlineNote: 'The deadline is not published on the page.',
      status: 'unknown',
      lastVerifiedAt: '2026-07-11T00:00:00.000Z',
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

function stub(body: unknown = RESPONSE, ok = true, status = 200): void {
  fetchMock = vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  stub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderCalendar() {
  return render(
    <MemoryRouter>
      <Calendar now={NOW} />
    </MemoryRouter>,
  );
}

describe('Calendar', () => {
  it('offers both month and agenda views', async () => {
    renderCalendar();
    expect(await screen.findByRole('tab', { name: /month/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /agenda/i })).toBeInTheDocument();
  });

  it('starts on the agenda, which is the view that answers "what next"', async () => {
    renderCalendar();
    const agenda = await screen.findByRole('list', { name: /agenda/i });
    expect(within(agenda).getByText(/ARRL Foundation Scholarship Program/)).toBeInTheDocument();
  });

  it('asks the API for an explicit window rather than relying on its default', async () => {
    renderCalendar();
    await screen.findByRole('list', { name: /agenda/i });
    const url = String((fetchMock.mock.calls[0] as [string])[0]);
    expect(url).toMatch(/^\/api\/calendar\?/);
    expect(url).toContain(`from=${encodeURIComponent(NOW)}`);
    expect(url).toContain('to=');
  });

  it('states the prep start date and the reason, not just the deadline', async () => {
    renderCalendar();
    expect(await screen.findByText(/start by 2026-11-30/i)).toBeInTheDocument();
    expect(screen.getByText(/transcript and references/i)).toBeInTheDocument();
  });

  it('states the ARDC decision lag so the user can plan around it', async () => {
    renderCalendar();
    expect(await screen.findByText(/decision in 60 to 120 days/i)).toBeInTheDocument();
  });

  it('labels an estimated cycle as projected in words', async () => {
    renderCalendar();
    const agenda = await screen.findByRole('list', { name: /agenda/i });
    expect(within(agenda).getByText(/projected, not observed/i)).toBeInTheDocument();
    expect(within(agenda).getByText(/funder-published/i)).toBeInTheDocument();
  });

  it('counts the two kinds, because 4 of 244 cycles being the funder’s own is the point', async () => {
    renderCalendar();
    expect(await screen.findByText(/1 funder-published, 1 projected/i)).toBeInTheDocument();
  });

  /**
   * TASK 21. The single most misleading number on this page used to be the entry count itself:
   * "127 dated cycles" reads as 127 things to prepare, when 112 of them are one ARRL portal
   * application. The summary now says how many entries ride somebody else's date and names the
   * programme most of them ride, so the size of the wall is qualified where the size is stated.
   */
  it('says how many entries ride another programme’s deadline, and name the one they ride', async () => {
    stub({
      ...RESPONSE,
      entries: [
        RESPONSE.entries[0],
        ...Array.from({ length: 4 }, (_, i) => ({
          ...RESPONSE.entries[1],
          cycle: { ...RESPONSE.entries[1]!.cycle, id: `rider-${String(i)}` },
          programId: `rider-${String(i)}`,
          programName: `Rider ${String(i)}`,
          deadlineSource: {
            kind: 'inherited',
            fromProgramId: 'arrl-foundation-scholarship',
            fromProgramName: 'ARRL Foundation Scholarship Program',
          },
        })),
      ],
    });
    renderCalendar();
    const summary = await screen.findByText(/4 of them inherit/i);
    expect(summary).toHaveTextContent(/ARRL Foundation Scholarship Program/);
    expect(summary).toHaveTextContent(/5 dated cycles/i);
  });

  /** With nothing inherited there is nothing to qualify, and the sentence stays off the page. */
  it('says nothing about inheritance when no entry inherits anything', async () => {
    renderCalendar();
    await screen.findByRole('list', { name: /agenda/i });
    expect(screen.queryByText(/inherit/i)).not.toBeInTheDocument();
  });

  it('lists the undated programs so they are not silently dropped', async () => {
    renderCalendar();
    const undated = await screen.findByRole('region', { name: /no dated cycle/i });
    expect(within(undated).getByText(/ARRL Club Grant Program/)).toBeInTheDocument();
    expect(within(undated).getByText(/not published on the page/)).toBeInTheDocument();
  });

  /**
   * `undated` is HORIZON-wide, not window-scoped (Task 11). Twenty-eight programmes are undated in
   * every window. A user looking at September must not read this list as "undated in September".
   */
  it('says the undated list is corpus-wide, not a property of the month on screen', async () => {
    renderCalendar();
    const undated = await screen.findByRole('region', { name: /no dated cycle/i });
    expect(within(undated).getByText(/whichever month you are looking at/i)).toBeInTheDocument();
  });

  it('switches to the month grid', async () => {
    renderCalendar();
    await userEvent.click(await screen.findByRole('tab', { name: /month/i }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('opens the month grid on the month containing "now"', async () => {
    renderCalendar();
    await userEvent.click(await screen.findByRole('tab', { name: /month/i }));
    expect(await screen.findByRole('table', { name: /August 2026/ })).toBeInTheDocument();
  });

  it('steps forward and backward across a year boundary', async () => {
    renderCalendar();
    await userEvent.click(await screen.findByRole('tab', { name: /month/i }));
    const next = screen.getByRole('button', { name: /next month/i });
    for (let i = 0; i < 5; i += 1) await userEvent.click(next);
    expect(await screen.findByRole('table', { name: /January 2027/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /previous month/i }));
    expect(await screen.findByRole('table', { name: /December 2026/ })).toBeInTheDocument();
  });

  /**
   * An empty grid for a month OUTSIDE the fetched window would read as "no deadlines" when the
   * truth is "nobody asked". Silence reading as an assertion is the defect class this project has
   * paid for most often.
   */
  it('says a month outside the fetched window was never asked about', async () => {
    renderCalendar();
    await userEvent.click(await screen.findByRole('tab', { name: /month/i }));
    const prev = screen.getByRole('button', { name: /previous month/i });
    await userEvent.click(prev);
    expect(await screen.findByText(/outside the window/i)).toBeInTheDocument();
  });

  it('offers a legend explaining the instrument colours', async () => {
    renderCalendar();
    const legend = await screen.findByRole('region', { name: /legend/i });
    expect(within(legend).getByText(/cash range/i)).toBeInTheDocument();
    expect(within(legend).getByText(/projected, not observed/i)).toBeInTheDocument();
  });

  it('reports a transport failure as a failure to reach the API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderCalendar();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
  });

  it('says the window is empty rather than rendering nothing at all', async () => {
    stub({ ...RESPONSE, entries: [], undated: [] });
    renderCalendar();
    expect(await screen.findByText(/no dated cycles fall inside this window/i)).toBeInTheDocument();
  });

  it('never links a blocked host', async () => {
    renderCalendar();
    await screen.findByRole('list', { name: /agenda/i });
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/farweb\.org|candid\.org|grantwatch/);
    }
  });
});

/**
 * The screen with NO `now` prop — which is the only way the router ever renders it, and the one
 * configuration nothing above covers.
 *
 * Every test in the block above passes `now={NOW}`. That fixes the timestamp, which is exactly
 * the input that was never broken. Rendered as the app renders it, `nowISO` was
 * `new Date().toISOString()` evaluated in the render body and interpolated into the `/api/calendar`
 * query string; since that string is `useApi`'s effect dependency, every response re-rendered the
 * screen, the clock moved a millisecond, and the new URL was fetched. In Chromium against the real
 * corpus: 41 requests of 168 kB in 15 seconds and no `networkidle`, forever.
 */
describe('Calendar with no injected clock', () => {
  function renderWithRealClock() {
    return render(
      <MemoryRouter>
        <Calendar />
      </MemoryRouter>,
    );
  }

  it('asks for its window ONCE and never re-asks for a window a millisecond wider', async () => {
    renderWithRealClock();
    await screen.findByRole('list', { name: /agenda/i });

    // Real elapsed time, not fake timers: the loop is driven by the wall clock advancing between
    // renders, and freezing the clock is precisely what would hide it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Two re-renders that mint nothing new — with the defect, each one changed the URL.
    await userEvent.click(screen.getByRole('tab', { name: /month/i }));
    await userEvent.click(screen.getByRole('tab', { name: /agenda/i }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const urls = fetchMock.mock.calls
      .map((call) => String((call as [string])[0]))
      .filter((url) => url.startsWith('/api/calendar'));

    expect(new Set(urls).size, `the window drifted across renders: ${urls.join(' | ')}`).toBe(1);
    expect(urls).toHaveLength(1);
  });

  it('holds the window it opened with, so a month step is measured against a fixed horizon', async () => {
    renderWithRealClock();
    await screen.findByRole('list', { name: /agenda/i });
    const first = String((fetchMock.mock.calls[0] as [string])[0]);

    await userEvent.click(screen.getByRole('tab', { name: /month/i }));
    await userEvent.click(await screen.findByRole('button', { name: /next month/i }));
    await userEvent.click(screen.getByRole('button', { name: /next month/i }));

    const urls = fetchMock.mock.calls
      .map((call) => String((call as [string])[0]))
      .filter((url) => url.startsWith('/api/calendar'));
    expect(urls).toEqual([first]);
  });
});
