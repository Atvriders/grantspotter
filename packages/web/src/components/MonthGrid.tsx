import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { INSTRUMENT_WORDS, cycleSpan, localDay, type CalendarEntry } from './AgendaList.js';
import { formatDate } from '../lib/trust.js';
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

/**
 * WHAT A MARK SAYS WHEN THE CELL IS TOO NARROW FOR ALL OF IT — which is every cell, at every width.
 *
 * MEASURED in Chromium against the shipped corpus, October 2026, before this component existed:
 * 4 of 4 marks were clipped at a 1400px viewport (147px of cell, 174-342px of text) and 4 of 4 at
 * 900px and at 375px (80px of cell — the grid is at its 672px `min-width` and the frame scrolls).
 * The cells read "IEEE M…", "Start pre…", "ARRL A…". `PrepMark`'s own doc-comment claimed the
 * marker had been moved in FRONT of the programme name "so it would survive truncation"; at 80px
 * the ellipsis lands inside the word "preparing", so what it survived was nothing. The
 * projected/funder-published qualifier — the distinction this whole screen exists to draw — went
 * with it on every mark on the page.
 *
 * THE FIX IS STRUCTURAL, NOT A WIDTH. No cell width makes "Start preparing (projected date): IEEE
 * MTT-S Undergraduate Scholarship" fit seven-across, and widening the grid until it did would put
 * a month behind two screens of sideways scrolling. So the mark is split into parts that truncate
 * differently:
 *
 *   - `.mark-kind` and `.mark-flag` WRAP and never ellipse. They are short, fixed strings — "Closes",
 *     "Opens", "Start preparing", "Projected date", "Funder-published" — so the qualifier is
 *     guaranteed to be readable in full at any cell width the grid can produce.
 *   - `.mark-name` is the ONE part that still ellipses, because a programme name is unbounded and
 *     something has to give. Nothing is lost by it: the full name is in the link's accessible
 *     name, in the `title` a pointer user gets, and spelled out in the Agenda tab beside this one,
 *     which is this screen's default for exactly that reason.
 *
 * The claim this component may now make is therefore the narrow one: a reader can always tell WHAT
 * KIND of mark this is and WHETHER ITS DATE WAS PUBLISHED, and may have to open the link or the
 * agenda to learn which programme it belongs to.
 */
function MarkBody({
  kind,
  flag,
  name,
}: {
  kind: string;
  flag: string;
  name: string;
}): JSX.Element {
  return (
    <>
      <span className="mark-kind">{kind}</span>
      <span className="mark-flag">{flag}</span>
      <span className="mark-name" title={name}>
        {name}
      </span>
    </>
  );
}

/** The two words, in one place, so no mark can say "projected" where another says "published". */
function provenanceWord(entry: CalendarEntry): string {
  return entry.isEstimated ? 'Projected date' : 'Funder-published';
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
      {/*
        "Closes" is new visible text. A chip used to be the programme name alone, and carried its
        projected/published state in a dashed outline and in its accessible name — so a sighted
        reader who cannot see a 1px dashed edge against a tinted chip had no way to tell the 123
        projected marks in a 12-month window from the 4 the funder published. It is a word now, on
        the same footing as the prep mark's.
      */}
      <MarkBody kind="Closes" flag={provenanceWord(entry)} name={entry.programName} />
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
      {/* `MonthGrid` pushes an opens mark only for `!isEstimated`, so this flag is not a branch:
          a projected window's opening is a projection of a projection and is never drawn. */}
      <MarkBody kind="Opens" flag="Funder-published" name={entry.programName} />
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
 * THE MARKER IS ON ITS OWN LINE, WHICH DOES NOT TRUNCATE. This comment used to claim the marker
 * had been moved in front of the programme name "so it would survive truncation", and that was
 * false as built: the whole mark was one `white-space: nowrap` line with `text-overflow: ellipsis`,
 * so at the grid's own minimum cell — 80px of text, measured — the ellipsis landed inside the word
 * "preparing" and the qualifier never rendered at any viewport width tested (375, 900 and 1400 all
 * clipped 4 of 4 marks). Moving a word to the front of a string does not protect it from a
 * truncation that starts before it ends; only giving it a box that does not truncate does. See
 * `MarkBody`. The `estimated` class matches `CloseChip`'s so a projected mark is stylable by the
 * same rule; the words, not the styling, are what carry the claim.
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
      <MarkBody
        kind="Start preparing"
        flag={provenanceWord(entry)}
        name={entry.programName}
      />
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
  /** The `from` this page put on the wire, as an ISO instant. */
  windowFrom: string;
  /** The `to` this page put on the wire, as an ISO instant. */
  windowTo: string;
}

export interface MonthCoverage {
  /** Days of this month that intersected the requested window at all. */
  askedDays: number;
  /** Days in the month. */
  totalDays: number;
  /** First and last day-of-month that were asked about, or null when none were. */
  firstAsked: number | null;
  lastAsked: number | null;
}

/**
 * HOW MUCH OF THIS MONTH THE PAGE ACTUALLY ASKED THE API ABOUT.
 *
 * THE DEFECT THIS EXISTS FOR. `Calendar` requests a 365-day window from the moment the screen was
 * opened, so the month at each end of it is a PART month. Measured on 2026-08-13 against the
 * shipped corpus, the calendar requested 2026-08-13 to 2027-08-13 and the grid for August 2027
 * printed "Nothing falls in August 2027 — no deadline, no window opening and no prep start. That
 * is what this window returned, not a claim that no funder has a date here." Eighteen of that
 * month's thirty-one days had never been asked about. The second sentence is the one that makes
 * the first safe — "that is what this window returned" — and it was doing the opposite: vouching
 * for an answer about 31 days when the question covered 13. `Calendar`'s "outside the window"
 * banner does not fire either, because the month is not outside it; it straddles the edge, which
 * was the one case neither surface had.
 *
 * INTERSECTION, NOT CONTAINMENT. A day counts as asked about if any part of it fell inside the
 * window. That is the right test for the claim being made, because the claim is the NEGATIVE one —
 * "these days were never requested" — and a day the request touched at all is not one nobody asked
 * about. It also makes `askedDays === 0` exactly `Calendar`'s own outside-the-window test, so the
 * two surfaces cannot disagree about which months are outside.
 *
 * UTC days, like the cells. `MonthGrid` lays out `Date.UTC` midnights and places entries by the
 * cycle's own zone, so a mark can sit in a cell whose UTC day is an hour outside the window. This
 * function is about what the PAGE ASKED FOR, not about where a mark landed, and that question has
 * no timezone in it.
 */
export function monthCoverage(
  year: number,
  month: number,
  windowFrom: string,
  windowTo: string,
): MonthCoverage {
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = Date.parse(windowFrom);
  const to = Date.parse(windowTo);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    // An unparseable window is not a claim that nothing was asked. Treat the month as fully
    // covered so the reassurance below reads exactly as it did before this function existed.
    return { askedDays: totalDays, totalDays, firstAsked: 1, lastAsked: totalDays };
  }

  let askedDays = 0;
  let firstAsked: number | null = null;
  let lastAsked: number | null = null;
  for (let day = 1; day <= totalDays; day += 1) {
    const start = Date.UTC(year, month - 1, day);
    const end = start + 86_400_000;
    if (end > from && start < to) {
      askedDays += 1;
      firstAsked ??= day;
      lastAsked = day;
    }
  }
  return { askedDays, totalDays, firstAsked, lastAsked };
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
export function MonthGrid({
  year,
  month,
  entries,
  now,
  windowFrom,
  windowTo,
}: MonthGridProps): JSX.Element {
  const weeks = monthMatrix(year, month);
  const monthName = MONTHS[month - 1] ?? '';
  const title = `${monthName} ${year}`;
  const todayKey = (now ?? new Date().toISOString()).slice(0, 10);
  const coverage = monthCoverage(year, month, windowFrom, windowTo);
  const unasked = coverage.totalDays - coverage.askedDays;

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
      {/*
        WHAT THE GRID DOES AND DOES NOT COVER, ABOVE THE GRID, because it governs how everything
        below it may be read. Rendered only when the month is not fully inside the window — a month
        the page asked about end to end has nothing to qualify.

        This paragraph MOVED HERE from `routes/Calendar.tsx`, where it fired only for a month
        entirely outside the window. Keeping it there and adding the straddling case here would put
        two components in charge of one claim, and the failure this closes is precisely two
        surfaces each covering the half of the truth the other did not.
      */}
      {unasked > 0 && (
        /*
          TWO STATES, TWO VOLUMES. A month with NO day inside the window is a grid that answers
          nothing, and takes `.cal-notice`'s amber — the same treatment the sentence had in
          `Calendar`. A month that straddles the edge did return real answers for the days it
          covers, so it takes the muted note the scroll hint uses: an amber banner on the month a
          reader lands on (the current month is always part-covered, its unasked days being the
          ones already past) would spend the loud style on the least alarming case there is.
        */
        <p className={coverage.askedDays === 0 ? 'cal-notice month-coverage' : 'month-coverage'}>
          {coverage.askedDays === 0
            ? `${title} is outside the window this page asked the API for (${formatDate(
                windowFrom,
              )} to ${formatDate(
                windowTo,
              )}). An empty grid here means nobody asked, not that no funder has a date that month.`
            : `Of ${title}, this page asked the API about ${String(
                coverage.firstAsked ?? 1,
              )}–${String(coverage.lastAsked ?? coverage.totalDays)} only. The other ${String(
                unasked,
              )} ${
                unasked === 1 ? 'day' : 'days'
              } were never requested, so nothing on this grid — a mark or a gap — says anything about them.`}
        </p>
      )}
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
      {/*
        THE REASSURANCE MAY ONLY VOUCH FOR THE DAYS THAT WERE ASKED ABOUT.

        "That is what this window returned" is what makes "nothing falls here" safe to print, and
        on a month straddling the edge of the window it was vouching for 31 days on the strength of
        a question about 13. The subject is now the covered part, and the note above says how big
        that part is.

        Suppressed entirely when NOTHING was asked: there is no returned answer to report, the note
        above has already said so, and an emptiness with no question behind it is not a finding.
      */}
      {!marksInMonth && coverage.askedDays > 0 && (
        <p className="month-empty">
          Nothing falls in{' '}
          {unasked === 0 ? title : `the part of ${title} this window covers`} — no deadline, no
          window opening and no prep start. That is what this window returned, not a claim that no
          funder has a date here.
        </p>
      )}
    </>
  );
}
