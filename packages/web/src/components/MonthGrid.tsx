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
    <div className="month-frame">
      <table className="month-grid" role="grid" aria-label={title}>
        <thead>
          <tr role="row">
            {DOW.map(([short, long]) => (
              <th key={short} className="dow" scope="col" role="columnheader">
                <abbr title={long}>{short}</abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, weekIndex) => (
            <tr key={`week-${String(weekIndex)}`} role="row">
              {week.map((day, dayIndex) => {
                if (day === null) {
                  return (
                    <td
                      key={`pad-${String(weekIndex)}-${String(dayIndex)}`}
                      className="day pad"
                      role="gridcell"
                    />
                  );
                }
                const key = cellDay(day);
                const label = `${day.getUTCDate()} ${monthName} ${year}`;
                return (
                  <td
                    key={key}
                    className={`day${key === todayKey ? ' today' : ''}`}
                    role="gridcell"
                    aria-label={label}
                  >
                    <span className="num">{day.getUTCDate()}</span>

                    {(closesOn.get(key) ?? []).map((entry) => (
                      <Link
                        key={`close-${entry.cycle.id}`}
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
                        }, ${INSTRUMENT_WORDS[entry.instrument]}`}
                      >
                        {entry.programName}
                      </Link>
                    ))}

                    {(opensOn.get(key) ?? []).map((entry) => (
                      <Link
                        key={`open-${entry.cycle.id}`}
                        to={`/o/${entry.programId}`}
                        className="opens-mark"
                        aria-label={`${entry.programName}: funder-published window opens today`}
                      >
                        Opens: {entry.programName}
                      </Link>
                    ))}

                    {(prepsOn.get(key) ?? []).map((entry) => (
                      <Link
                        key={`prep-${entry.cycle.id}`}
                        to={`/o/${entry.programId}`}
                        className="prep-mark"
                        aria-label={`Start preparing ${entry.programName}, ${String(
                          entry.prepLeadDays,
                        )} days before it ${cycleSpan(entry.cycle)}`}
                      >
                        Start preparing: {entry.programName}
                      </Link>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!marksInMonth && (
        <p className="month-empty">
          Nothing falls in {title} — no deadline, no window opening and no prep start. That is what
          this window returned, not a claim that no funder has a date here.
        </p>
      )}
    </div>
  );
}
