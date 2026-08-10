import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { INSTRUMENT_WORDS, cycleSpan, localDay, type CalendarEntry } from './AgendaList.js';
import './calendar.css';

const DOW = [
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
  ['Sun', 'Sunday'],
] as const;

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

/**
 * Whole Monday-first weeks, padded with null so no other month's dates leak in.
 *
 * The pad is null rather than the neighbouring month's day because a grid that quietly shows
 * 30 November in a December view invites the reader to place a deadline in the wrong month — and
 * this screen's entire job is that a date lands where the funder put it.
 */
export function monthMatrix(year: number, month: number): Array<Array<Date | null>> {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const leading = (first.getUTCDay() + 6) % 7; // Monday = 0

  const cells: Array<Date | null> = new Array<Date | null>(leading).fill(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(Date.UTC(year, month - 1, day)));
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: Array<Array<Date | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The cell key for a `Date` produced by `monthMatrix`, which is always a UTC midnight. */
function cellDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/**
 * How many entries must ride ONE owner's date before they are folded into a disclosure.
 *
 * Below this the disclosure costs a click and a line of chrome for less than it hides, so a small
 * group stays as ordinary marks. The threshold governs LAYOUT ONLY: every inherited mark names its
 * owner in its accessible name whether it was folded or not.
 */
export const GROUP_MIN = 3;

export interface OwnerGroup {
  ownerId: string;
  ownerName: string;
  entries: CalendarEntry[];
}

export interface DayBuckets {
  /** Rendered one mark each, in the order the server sent them. */
  solo: CalendarEntry[];
  /** Rendered as one disclosure each, in order of first appearance. */
  groups: OwnerGroup[];
}

/**
 * Split one day's marks into "stands on its own" and "rides somebody else's date".
 *
 * THE PROBLEM THIS SOLVES. 112 of the 150 publishable programmes inherit their deadline from the
 * ARRL Foundation scholarship portal, so 2026-12-30 carries 113 entries of which 112 are one portal
 * date. Rendered flat, the cell claims 113 independent deadlines that happen to coincide — and
 * buries the only thing a planner needs from it: that clearing ONE deadline clears all of them, and
 * that a change to that single owner moves every one.
 *
 * WHAT THIS IS NOT. It is not "+N more". Nothing is dropped, nothing is capped, and the count and
 * the owner are both in the visible summary before anything is opened, so the day can never look
 * emptier than it is — that specific failure (a September view reporting 147 of 150 programmes as
 * deadline-less) is the one the `undated` fix already had to correct once.
 *
 * Membership is by object identity, not by `cycle.id`, so a duplicated id could never silently
 * swallow a mark.
 */
export function groupByDeadlineOwner(
  entries: CalendarEntry[],
  minToFold: number = GROUP_MIN,
): DayBuckets {
  const byOwner = new Map<string, OwnerGroup>();
  const order: string[] = [];

  for (const entry of entries) {
    if (entry.deadlineSource.kind !== 'inherited') continue;
    const { fromProgramId, fromProgramName } = entry.deadlineSource;
    let group = byOwner.get(fromProgramId);
    if (group === undefined) {
      group = { ownerId: fromProgramId, ownerName: fromProgramName, entries: [] };
      byOwner.set(fromProgramId, group);
      order.push(fromProgramId);
    }
    group.entries.push(entry);
  }

  const folded = new Set<CalendarEntry>();
  const groups: OwnerGroup[] = [];
  for (const id of order) {
    const group = byOwner.get(id);
    if (group === undefined || group.entries.length < minToFold) continue;
    groups.push(group);
    for (const entry of group.entries) folded.add(entry);
  }

  return { solo: entries.filter((entry) => !folded.has(entry)), groups };
}

/** What an inherited mark adds to its accessible name. Empty for a self-stated one. */
function sourceSuffix(entry: CalendarEntry): string {
  return entry.deadlineSource.kind === 'inherited'
    ? `, date inherited from ${entry.deadlineSource.fromProgramName}`
    : '';
}

function CloseChip({ entry }: { entry: CalendarEntry }): JSX.Element {
  return (
    <Link
      to={`/o/${entry.programId}`}
      className={[
        'chip',
        `inst-${entry.instrument}`,
        entry.applicantEntities.includes('individual') ? 'ent-individual' : '',
        entry.isEstimated ? 'estimated' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={`${entry.programName}: ${cycleSpan(entry.cycle)}, ${
        entry.isEstimated ? 'projected, not observed' : 'funder-published'
      }, ${INSTRUMENT_WORDS[entry.instrument]}${sourceSuffix(entry)}`}
    >
      {entry.programName}
    </Link>
  );
}

function OpensMark({ entry }: { entry: CalendarEntry }): JSX.Element {
  return (
    <Link
      to={`/o/${entry.programId}`}
      className="opens-mark"
      aria-label={`${entry.programName}: funder-published window opens today${sourceSuffix(entry)}`}
    >
      Opens: {entry.programName}
    </Link>
  );
}

/**
 * The day to start work — and, when the deadline it counts back from was never announced, that
 * fact, said in the mark itself.
 *
 * A prep mark is the one mark on this page a planner ACTS on: it is an instruction to begin.
 * `CloseChip` has carried "projected, not observed" since Task 20; this carried nothing, so
 * "Start preparing X, 45 days before it 2027-02-28 deadline" read as an unqualified instruction
 * built on a date the funder never published. In a real 12-month window that is 123 of 127
 * entries — 4 cycles in this corpus are funder-published.
 *
 * THE MARKER GOES BEFORE THE PROGRAMME NAME, in visible text. `.prep-mark` is `white-space:
 * nowrap` with `text-overflow: ellipsis`, so a qualifier appended after a long programme name is
 * exactly what a narrow cell truncates away — the marker would disappear precisely where the cell
 * is tightest. The `estimated` class matches `CloseChip`'s so a projected mark is stylable by the
 * same rule; the sentence, not the styling, is what carries the claim.
 */
function PrepMark({ entry }: { entry: CalendarEntry }): JSX.Element {
  return (
    <Link
      to={`/o/${entry.programId}`}
      className={['prep-mark', entry.isEstimated ? 'estimated' : ''].filter(Boolean).join(' ')}
      aria-label={`Start preparing ${entry.programName}, ${String(
        entry.prepLeadDays,
      )} days before it ${cycleSpan(entry.cycle)}, ${
        entry.isEstimated ? 'projected, not observed' : 'funder-published'
      }${sourceSuffix(entry)}`}
    >
      {entry.isEstimated ? 'Start preparing (projected date): ' : 'Start preparing: '}
      {entry.programName}
    </Link>
  );
}

/**
 * A fold, whose SUMMARY states its own size and names the date everything inside it rides.
 *
 * The summary is the whole honesty argument for grouping at all: a reader who never opens it still
 * knows exactly how many marks this day holds and which single deadline governs them.
 */
function OwnerFold({
  group,
  note,
  children,
}: {
  group: OwnerGroup;
  note: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <details className="chip-group">
      <summary>
        {group.entries.length} programmes ride {group.ownerName}’s deadline
      </summary>
      {/*
        No "open the owner" link here on purpose: the owner's own mark is already in this cell in
        every case the corpus produces, and a second link to the same target would double every
        chip count taken off this grid.
      */}
      <div className="chip-group-body">
        <p className="chip-group-note">{note}</p>
        {children}
      </div>
    </details>
  );
}

export interface MonthGridProps {
  year: number;
  month: number;
  entries: CalendarEntry[];
  now?: string;
}

/**
 * One month, with three kinds of mark on it.
 *
 * A CHIP is a close date. A PREP MARK is the day to start work, which is usually in an earlier
 * month than the deadline it belongs to — that is the whole point of the overlay, and it is why
 * this component is given the entire window's entries rather than only the ones closing here.
 * An OPENS MARK is the day a funder-published window opens.
 *
 * Every instant is placed by its day IN THE CYCLE'S OWN TIMEZONE (`localDay`), never by its UTC
 * day. A 23:59-local deadline stored as `2027-03-01T04:59:00.000Z` belongs to February.
 */
export function MonthGrid({ year, month, entries, now }: MonthGridProps): JSX.Element {
  const weeks = monthMatrix(year, month);
  const monthName = MONTHS[month - 1] ?? '';
  const title = `${monthName} ${year}`;
  const todayKey = (now ?? new Date().toISOString()).slice(0, 10);

  const closesOn = new Map<string, CalendarEntry[]>();
  const prepsOn = new Map<string, CalendarEntry[]>();
  const opensOn = new Map<string, CalendarEntry[]>();

  const push = (bucket: Map<string, CalendarEntry[]>, key: string | null, entry: CalendarEntry) => {
    if (key === null) return;
    const list = bucket.get(key);
    if (list === undefined) bucket.set(key, [entry]);
    else list.push(entry);
  };

  for (const entry of entries) {
    push(closesOn, localDay(entry.cycle.closesAt, entry.cycle.timezone), entry);
    push(prepsOn, localDay(entry.prepStartAt, entry.cycle.timezone), entry);
    // Only a funder-published window has an opening worth marking; a projected cycle's opening is
    // a projection of a projection.
    if (!entry.isEstimated) {
      push(opensOn, localDay(entry.cycle.opensAt, entry.cycle.timezone), entry);
    }
  }

  const marksInMonth = weeks
    .flat()
    .filter((day): day is Date => day !== null)
    .some((day) => {
      const key = cellDay(day);
      return closesOn.has(key) || prepsOn.has(key) || opensOn.has(key);
    });

  return (
    /*
     * THIS ONE STAYS A GRID, and scrolls sideways inside its own frame.
     *
     * A month is a spatial object: "the deadline is the Friday after the one I am already
     * preparing for" is a fact about where two marks sit relative to each other, and there is no
     * stack of cards that carries it. Shrinking the grid instead — which is what happened before
     * this frame scrolled — put seven columns into a 320 px screen and produced 39 px cells whose
     * marks were 22 px of ellipsis. That is not a denser month view; it is a month view with the
     * marks removed.
     *
     * The frame therefore holds the grid at the width where its cells are still legible (see
     * `.month-grid`'s `min-width` in `calendar.css`) and scrolls to it. `tabIndex` because a
     * region that scrolls has to be reachable by a keyboard with no scroll wheel, and
     * `role="region"` with a name so landing on it is announced as something.
     *
     * The Agenda tab beside this one is the surface where every mark is spelled out in full, and
     * it is the default for exactly that reason.
     */
    <>
      <div className="month-frame" role="region" aria-label={`${title}, scrollable`} tabIndex={0}>
        {/*
          A TABLE, not a `role="grid"`.

          Task 20 put `role="grid"` here because its brief's queries asked for it, and flagged at
          the time that `role="table"` was the honest answer. It is, and the reason is not
          pedantry: `grid` is a COMPOSITE WIDGET role. It obliges the author to ship two-dimensional
          arrow-key navigation over a roving tabindex, and it changes what assistive technology
          tells the user — a thing to enter and drive, rather than a table to read. This month view
          ships no such navigation and needs none: it is a static arrangement of dates whose only
          interactive contents are ordinary links, which the browser already reaches with Tab.
          `role="grid"` therefore advertised a keyboard contract that did not exist.

          The `role` attributes are DELETED rather than replaced with `role="table"` / `"row"` /
          `"columnheader"` / `"cell"`, because `<table>`, `<tr>`, `<th scope="col">` and `<td>`
          already carry exactly those implicit roles. Restating them adds a second place for the
          semantics to drift from the markup. `aria-label` stays: the month and year are the one
          thing the element cannot name itself.

          `test/a11y.test.tsx` fails any `role="grid"` with no focusable cell, so this cannot
          quietly come back.
        */}
        <table className="month-grid" aria-label={title}>
          <thead>
            <tr>
              {DOW.map(([short, long]) => (
                <th key={short} className="dow" scope="col">
                  <abbr title={long}>{short}</abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, weekIndex) => (
              <tr key={`week-${String(weekIndex)}`}>
                {week.map((day, dayIndex) => {
                  if (day === null) {
                    return (
                      <td key={`pad-${String(weekIndex)}-${String(dayIndex)}`} className="day pad" />
                    );
                  }
                  const key = cellDay(day);
                  const label = `${day.getUTCDate()} ${monthName} ${year}`;
                  const closes = groupByDeadlineOwner(closesOn.get(key) ?? []);
                  const opens = groupByDeadlineOwner(opensOn.get(key) ?? []);
                  const preps = groupByDeadlineOwner(prepsOn.get(key) ?? []);
                  return (
                    <td
                      key={key}
                      className={`day${key === todayKey ? ' today' : ''}`}
                      aria-label={label}
                    >
                      <span className="num">{day.getUTCDate()}</span>

                      {closes.solo.map((entry) => (
                        <CloseChip key={`close-${entry.cycle.id}`} entry={entry} />
                      ))}
                      {closes.groups.map((group) => (
                        <OwnerFold
                          key={`close-group-${group.ownerId}`}
                          group={group}
                          note={`One date, ${String(group.entries.length)} applications. They are not ${String(
                            group.entries.length,
                          )} deadlines: ${group.ownerName} sets this date, so clearing that one is what clears all of them, and a change to it moves every one.`}
                        >
                          {group.entries.map((entry) => (
                            <CloseChip key={`close-${entry.cycle.id}`} entry={entry} />
                          ))}
                        </OwnerFold>
                      ))}

                      {opens.solo.map((entry) => (
                        <OpensMark key={`open-${entry.cycle.id}`} entry={entry} />
                      ))}
                      {opens.groups.map((group) => (
                        <OwnerFold
                          key={`open-group-${group.ownerId}`}
                          group={group}
                          note={`One window opening, ${String(
                            group.entries.length,
                          )} applications: ${group.ownerName} published this date and they all read it off that record.`}
                        >
                          {group.entries.map((entry) => (
                            <OpensMark key={`open-${entry.cycle.id}`} entry={entry} />
                          ))}
                        </OwnerFold>
                      ))}

                      {preps.solo.map((entry) => (
                        <PrepMark key={`prep-${entry.cycle.id}`} entry={entry} />
                      ))}
                      {preps.groups.map((group) => (
                        <OwnerFold
                          key={`prep-group-${group.ownerId}`}
                          group={group}
                          note={`One runway, ${String(
                            group.entries.length,
                          )} applications. They start on the same day because they end on the same day — ${
                            group.ownerName
                          }'s.`}
                        >
                          {group.entries.map((entry) => (
                            <PrepMark key={`prep-${entry.cycle.id}`} entry={entry} />
                          ))}
                        </OwnerFold>
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/*
        BOTH OF THESE SIT OUTSIDE THE FRAME, and that is not tidiness.

        The frame is a horizontal scroller holding a grid that is at least 672 px wide, so anything
        inside it is 672 px wide too — a sentence in there would be a sentence the reader has to
        scroll sideways to finish. Neither of them is a cell of the month anyway: one is a
        statement about how the grid is being shown, the other a statement about what the window
        returned.
      */}
      <p className="month-scroll-note">
        Seven day columns, and they do not shrink below the width their marks need. On a narrow
        screen the grid scrolls sideways inside its frame — the rest of the week is to the right.
      </p>
      {!marksInMonth && (
        <p className="month-empty">
          Nothing falls in {title} — no deadline, no window opening and no prep start. That is what
          this window returned, not a claim that no funder has a date here.
        </p>
      )}
    </>
  );
}
