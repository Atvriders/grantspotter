import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../store/useApi.js';
import { formatDate } from '../lib/trust.js';
import {
  AgendaList,
  type CalendarEntry,
  type UndatedProgram,
} from '../components/AgendaList.js';
import { MonthGrid } from '../components/MonthGrid.js';
import { StatusPill } from '../components/StatusPill.js';
import { TrustBadge } from '../components/TrustBadge.js';
/*
  The deadline-pattern words moved to `lib/programWords.ts` so the record page could read the same
  table — it was printing `n_fixed_dates` raw — and so they could be typed `Record<DeadlineKind,
  string>`. The local copy was `Record<string, string>` with a `?? kind` fallback, which meant a
  kind nobody had written words for reached this list as a bare identifier and nothing failed.
*/
import { deadlineKindWords, readDeadlineNote } from '../lib/programWords.js';
import '../components/calendar.css';

/** PLAN-LOCAL mirror of the server's `CalendarResponse` (`api/calendarRouter.ts`). */
interface CalendarResponse {
  from: string;
  to: string;
  entries: CalendarEntry[];
  undated: UndatedProgram[];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The server's own default horizon, stated rather than relied upon. */
const WINDOW_DAYS = 365;

const LEGEND = [
  { className: 'inst-cash_range', label: 'Cash range, fixed cash or tiered blocks' },
  { className: 'inst-in_kind_equipment', label: 'Equipment or service in kind' },
  { className: 'inst-discounted_purchase', label: 'Discounted purchase or per-member rebate' },
  { className: 'inst-tuition_coverage', label: 'Tuition coverage' },
  { className: 'inst-unknown', label: 'Instrument unknown' },
];

/**
 * How much of this window is one date wearing many hats.
 *
 * The entry count is the most misleading number on this page taken alone: over twelve months the
 * real corpus returns 127 dated cycles, of which 112 are the SAME ARRL Foundation portal deadline
 * inherited by 112 catalog entries. "127 cycles" reads as 127 things to prepare; it is 16.
 * `total` is how many entries ride somebody else's date, and `top` is the owner most of them ride.
 */
function ridership(entries: CalendarEntry[]): {
  total: number;
  top: { id: string; name: string; count: number } | null;
} {
  const byOwner = new Map<string, { id: string; name: string; count: number }>();
  let total = 0;
  for (const entry of entries) {
    if (entry.deadlineSource.kind !== 'inherited') continue;
    total += 1;
    const { fromProgramId, fromProgramName } = entry.deadlineSource;
    const seen = byOwner.get(fromProgramId);
    if (seen === undefined) {
      byOwner.set(fromProgramId, { id: fromProgramId, name: fromProgramName, count: 1 });
    } else {
      seen.count += 1;
    }
  }
  let top: { id: string; name: string; count: number } | null = null;
  for (const owner of byOwner.values()) {
    if (top === null || owner.count > top.count) top = owner;
  }
  return { total, top };
}

/**
 * The calendar (spec §11.1).
 *
 * It renders what `GET /api/calendar` returns and DERIVES NO CYCLES OF ITS OWN. The server merges
 * two channels — `expandCycles` (projected) and `observedCycles` (the four windows a funder
 * actually published) — and re-deriving either here would be a second, freely-diverging answer to
 * the one question this screen exists to answer honestly.
 */
export function Calendar({ now }: { now?: string }): JSX.Element {
  /*
   * READ THIS BEFORE INLINING IT BACK INTO `nowISO`.
   *
   * This was `now ?? new Date().toISOString()`, evaluated in the render body, and it made the
   * page request `/api/calendar` FOREVER. Measured in Chromium against the real corpus: 41
   * requests of 168 kB each in 15 seconds, ~460 kB/s for as long as the tab stayed open, and the
   * page therefore never reached `networkidle`.
   *
   * The loop is closed by the query string. `nowISO` is interpolated into `from`/`to` below, that
   * string is the `path` argument to `useApi`, and `path` is in the hook's effect dependencies —
   * correctly, since a different URL is a different question. So: render mints a timestamp →
   * fetch → response → `setData` → re-render → the clock has moved a millisecond → a URL that
   * has never been fetched → fetch. Nothing in it is a retry or a poll; each pass is a first
   * request for a window one millisecond wide of the last.
   *
   * No component test could see it: every one of them passes a fixed `now`, which is exactly the
   * branch that was never broken. `App.test.tsx` renders this route with no prop, but its
   * `settle()` helper drains a bounded five passes and a bounded drain of an unbounded loop
   * terminates and passes.
   *
   * A `useState` initializer runs once per mount, so the window is now the moment the screen was
   * opened and stays that moment. That is also the honest reading: "the next 365 days" is a
   * question asked once, and re-asking it every few hundred milliseconds against a corpus whose
   * fastest-moving record changes weekly answers nothing.
   */
  const [openedAt] = useState(() => new Date().toISOString());
  const nowISO = now ?? openedAt;
  const [view, setView] = useState<'agenda' | 'month'>('agenda');
  const [cursor, setCursor] = useState(() => {
    const d = new Date(nowISO);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  });

  // An EXPLICIT window, not the server's default. The month grid can be stepped anywhere, and the
  // only way it can say "this month was never asked about" is if the page knows what it asked for.
  const params = new URLSearchParams({
    from: nowISO,
    to: new Date(Date.parse(nowISO) + WINDOW_DAYS * 86_400_000).toISOString(),
  });
  const { data, loading, error } = useApi<CalendarResponse>(`/api/calendar?${params.toString()}`);

  /**
   * Left/Right move between the two tabs, which is what `role="tab"` promises a keyboard user.
   * Two tabs, so either arrow toggles; `preventDefault` stops the browser scrolling the page
   * sideways under the widget.
   */
  function onTabKey(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setView((current) => (current === 'agenda' ? 'month' : 'agenda'));
  }

  function step(delta: number): void {
    setCursor((c) => {
      const raw = c.month + delta;
      return {
        year: c.year + Math.floor((raw - 1) / 12),
        month: ((raw - 1 + 12) % 12) + 1,
      };
    });
  }

  const monthTitle = `${MONTHS[cursor.month - 1] ?? ''} ${cursor.year}`;
  const published = data?.entries.filter((e) => !e.isEstimated).length ?? 0;
  const projected = data?.entries.filter((e) => e.isEstimated).length ?? 0;
  const riding = ridership(data?.entries ?? []);

  return (
    <>
      <p className="eyebrow">Deadlines and lead time</p>
      <h1 style={{ marginBottom: 'var(--s-4)' }}>Calendar</h1>

      {/*
        A REAL tabs widget, not two buttons wearing `role="tab"`.

        `role="tab"` is a promise: assistive technology announces "tab 1 of 2", and a keyboard user
        is entitled to expect arrow keys to move between the tabs while Tab moves PAST them into
        the panel. This tablist shipped with none of that — no roving `tabindex`, no arrow keys,
        no `aria-controls`, and no `tabpanel` for either tab to control — so the announcement was
        the only part of the pattern that was true. It now matches the profile editor's tabs,
        which got this right, and the audit in `test/a11y.test.tsx` keeps the `aria-controls`
        honest: it names a panel only while that panel is the one in the DOM.
      */}
      <div className="cal-tabs" role="tablist" aria-label="Calendar view">
        {(['agenda', 'month'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`cal-tab-${tab}`}
            aria-selected={view === tab}
            aria-controls={view === tab ? 'cal-panel' : undefined}
            tabIndex={view === tab ? 0 : -1}
            onKeyDown={onTabKey}
            onClick={() => {
              setView(tab);
            }}
          >
            {tab === 'agenda' ? 'Agenda' : 'Month'}
          </button>
        ))}
      </div>

      <section className="legend card" aria-label="Legend">
        {LEGEND.map((item) => (
          <span key={item.className} className="legend-item">
            <span className={`chip ${item.className}`} aria-hidden="true">
              &nbsp;
            </span>
            {item.label}
          </span>
        ))}
        <span className="legend-item">
          <span className="chip inst-unknown estimated" aria-hidden="true">
            &nbsp;
          </span>
          Dashed edge means projected, not observed
        </span>
        <span className="legend-item">
          <span className="chip inst-unknown ent-individual" aria-hidden="true">
            &nbsp;
          </span>
          Dotted underline means individuals may apply
        </span>
      </section>

      {loading && <p className="eyebrow">Loading…</p>}

      {error !== null && (
        <p role="alert" className="cal-notice">
          {error.status === 0
            ? 'GrantSpotter could not reach the API, so the calendar could not be loaded. That is a failure to ask, not an answer that there are no deadlines.'
            : `The calendar could not be loaded (${error.code}). ${error.message}`}
        </p>
      )}

      {data !== null && (
        <p className="cal-summary">
          {data.entries.length} dated {data.entries.length === 1 ? 'cycle' : 'cycles'} between{' '}
          {formatDate(data.from)} and {formatDate(data.to)} — {published} funder-published,{' '}
          {projected} projected. A projected date was worked out from a recurrence rule; the funder
          has not announced it.
          {riding.total > 0 && riding.top !== null && (
            <>
              {' '}
              {riding.total} of them inherit their date from another programme rather than
              publishing one, so this is a shorter list than it looks: {riding.top.count} ride{' '}
              <Link to={`/o/${riding.top.id}`}>{riding.top.name}</Link>, and clearing that one
              deadline is what clears all of them.
            </>
          )}
        </p>
      )}

      <div id="cal-panel" role="tabpanel" aria-labelledby={`cal-tab-${view}`}>
        {data !== null && view === 'agenda' && <AgendaList entries={data.entries} now={nowISO} />}

        {data !== null && view === 'month' && (
          <>
            <div className="cal-nav">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  step(-1);
                }}
              >
                Previous month
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  step(1);
                }}
              >
                Next month
              </button>
              <span className="cal-month-name">{monthTitle}</span>
            </div>

            {/*
              THE "OUTSIDE THE WINDOW" NOTICE THAT STOOD HERE IS NOW `MonthGrid`'s, and it is the
              same sentence — see `MonthGrid`'s `monthCoverage`.

              It fired only when the month was ENTIRELY outside the requested window, and the
              months at each END of that window are the ones the reader actually meets: a 365-day
              request opens and closes mid-month, so August 2027 had 18 of its 31 days never asked
              about, no banner, and a grid that said "that is what this window returned". One
              component now answers "how much of this month was asked about" for all three cases —
              all of it, some of it, none of it — because two components each holding half of that
              answer is how the straddling case came to belong to neither.
            */}
            <MonthGrid
              year={cursor.year}
              month={cursor.month}
              entries={data.entries}
              now={nowISO}
              windowFrom={data.from}
              windowTo={data.to}
            />
          </>
        )}
      </div>

      {data !== null && data.undated.length > 0 && (
        <section className="cal-panel card" aria-label="Programs with no dated cycle">
          <h2>No dated cycle</h2>
          <p>
            {data.undated.length} {data.undated.length === 1 ? 'program is' : 'programs are'} real
            but hold no date to put on a calendar. Rolling programs accept applications year-round;
            unpublished ones simply do not state a deadline. This list is corpus-wide — it is the
            same list whichever month you are looking at, so its size says nothing about the month
            on screen.
          </p>
          <ul>
            {data.undated.map((program) => {
              /*
                THE FIFTH SURFACE THE MACHINE DIRECTIVE REACHED, and the only one no corpus check
                could see.

                `GET /api/calendar` sends `undated[].deadlineNote` as `program.deadline.note`
                VERBATIM — the same whole string `GET /api/programs/:id` sends — and that string
                really carries `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,…`
                in front of whatever the funder wrote. The record page has split it since cc64182
                and the Inbox since 313f4c7; this list printed it whole.

                NO RECORD IN EITHER CORPUS ROUTES ONE HERE TODAY, which is why three rounds of
                measuring the corpus never saw it: a directive that parses projects a cycle, and a
                programme with a cycle is not undated. `core/test/cycles.test.ts` pins the shape
                that gets here anyway — a directive "pasted here by accident" onto a kind that
                projects nothing — and a curator who does that puts `dates=02-01` on this page.

                So the reader runs regardless of whether today's data needs it, and the rule gets
                its own line rather than being dropped: this panel exists to say what a programme
                with no date on the calendar does instead, and "February 1, April 1, July 1,
                September 1 each year" is exactly that answer.
              */
              const note = readDeadlineNote(program.deadlineNote);
              return (
                <li key={program.programId}>
                  <Link to={`/o/${program.programId}`}>{program.programName}</Link>
                  <div className="meta">
                    <span>{program.funderName}</span>
                    <span className="data">
                      {deadlineKindWords(program.deadlineKind)}
                    </span>
                    <StatusPill status={program.status} />
                    <TrustBadge lastVerifiedAt={program.lastVerifiedAt} now={nowISO} />
                  </div>
                  {note.rule !== undefined && <p className="prep">Repeats: {note.rule}</p>}
                  {note.prose !== '' && <p className="prep">{note.prose}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
