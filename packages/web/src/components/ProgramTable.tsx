import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Program, Verdict } from '@grantspotter/core';
import { VerdictBadge } from './VerdictBadge.js';
import { TrustBadge } from './TrustBadge.js';
import { StatusPill } from './StatusPill.js';
import { formatDate } from '../lib/trust.js';
import { useNarrowerThan } from '../lib/narrowLayout.js';
import './browse.css';

/** Mirrors `BrowseRow` in `packages/server/src/api/browseTypes.ts`. Web never imports server. */
export interface ProgramRow {
  program: Program;
  funderName: string;
  verdict: Verdict | null;
  nextOpensAt: string | null;
  nextClosesAt: string | null;
  nextIsEstimated: boolean;
  /**
   * IANA zone the two instants above are expressed in, or `null` when none was recorded.
   * REQUIRED, not optional: a deadline is the UTC instant of a LOCAL 23:59 wall time, so without
   * this the ARRL's 28 February 2027 close (`2027-03-01T04:59:00.000Z`) prints 2027-03-01 —
   * one day LATE, which hands an applicant a day the funder does not accept.
   */
  nextTimezone: string | null;
  watched: boolean;
}

export interface ProgramTableProps {
  rows: ProgramRow[];
  now: string;
  onExplain?: (programId: string) => void;
  expandedId?: string | null;
  /** Extra sentence for the empty state, when the caller knows WHY nothing matched. */
  emptyNote?: ReactNode;
}

/** Set by `normalize/index.ts` on the deliberately-published compromised-domain warning record. */
const SAFETY_WARNING_TAG = 'safety_warning';

const COLUMN_COUNT = 6;

/**
 * The first viewport width at which the six-column table fits without scrolling sideways.
 *
 * MEASURED, not chosen from a device list. In Chromium against the shipped 143-programme seed,
 * with the amount column allowed to wrap (see `.grid-table td.num.amount` in `browse.css`), this
 * table's min-content width is 666 px — below that its own columns start clipping their contents:
 *
 *   el.style.width = 'min-content'; Math.ceil(el.getBoundingClientRect().width)   // 666
 *
 * `.table-wrap` puts a 1 px hairline on each side of it, so the box has to be 668 px, and
 * `AppShell` spends `--rail-w` (208 px) plus `--s-5` of page padding on each side (48 px). The
 * table therefore first fits at 668 + 208 + 48 = 924, confirmed by sweeping the real page and
 * watching `.table-wrap`'s `scrollWidth` come level with its `clientWidth`.
 *
 * Below the shell's own 720 px switch the rail goes away and the sum is 668 + 48 = 716, so the
 * table would also technically fit in the 4 px band between 716 and 720. One threshold covers
 * both regimes and calls that band a phone, which at 716 px wide it is: the alternative is two
 * breakpoints, a layout that flips table -> cards -> table as a window widens, and a 666 px table
 * squeezed edge to edge on a device with no cursor.
 */
export const PROGRAMME_TABLE_MIN_PX = 924;

/**
 * `nextIsEstimated` is `false` only where the FUNDER published that window; everywhere else the
 * date is projected from a recurrence rule, and a projected date presented as authoritative is the
 * failure this project spent the most effort eliminating.
 *
 * Almost every row is a projection, and the size of "almost" is not a constant this comment can
 * hold. On the corpus a fresh install gets (`data/seed/`), the browse projection resolves a next
 * close date for 121 of 143 publishable programs, of which 2 are funder-published on 2026-08-04
 * and 0 from 2026-10-01 — the ARISS and Yaesu windows are the only two open, and they close.
 * Measured with `expandCycles` + `observedCycles` over `publishableSeedPrograms`, at
 * `reindex.ts`'s own 550-day horizon and its tie-break. A literal here would be false by October
 * without anybody touching the file, which is how the 243/244/252 contradiction got committed.
 *
 * BOTH states are marked, not just the projected one. An unmarked date is indistinguishable from
 * a date nobody got round to qualifying, and the reader cannot tell which they are looking at.
 * `role="img"` because an `aria-label` on a bare span is ignored by assistive technology — the
 * same reason the badge kit uses it.
 *
 * The marks live in their own component because BOTH layouts render them and neither may be
 * tidied into dropping one: the card is not a reduced table, it is the same facts stacked.
 */
function DeadlineMarks({ row }: { row: ProgramRow }): JSX.Element {
  const day = formatDate(row.nextClosesAt, row.nextTimezone);
  return (
    <>
      <span className="deadline-day">{day}</span>
      {row.nextClosesAt !== null && (
        <>
          {row.nextTimezone === null && (
            <span
              className="zone-mark"
              role="img"
              aria-label="Time zone was not recorded for this deadline. The date is shown in UTC, which can be one day later than the day the funder published."
              title="No time zone was recorded with this cycle, so the instant is rendered in UTC rather than guessed into a local zone. Check the funder's page for the day they publish."
            >
              UTC
            </span>
          )}
          {row.nextIsEstimated ? (
            <span
              className="estimated-mark"
              role="img"
              aria-label="Projected from a recurrence rule, not published by the funder."
              title="No funder page states this window. It is projected from the recurrence this program has followed, so treat it as a planning date and confirm before you rely on it."
            >
              est.
            </span>
          ) : (
            <span
              className="published-mark"
              role="img"
              aria-label="This window was published by the funder."
              title="The funder's own page states this window. It is not projected from a recurrence rule."
            >
              published
            </span>
          )}
        </>
      )}
    </>
  );
}

/**
 * Everything on this row that qualifies a claim rather than making one.
 *
 * The compromised-domain record is published ON PURPOSE — ARRL, QCWA and club pages still tell
 * applicants to "apply at the FAR website", and this row is what intercepts that instruction. So
 * it has to READ as a warning, and the host itself appears nowhere: not as a link, not as text.
 *
 * The disputed marker is here because the corpus HOLDS disputed records and browse used to say
 * nothing about them: `data/seed/programs.negatives.json` ships the ARRL Club Grant with three
 * mutually incompatible readings of its cycle and no funder-published deadline field, and a
 * browse row that prints one projected date for it, unqualified, is the exact claim the detail
 * page's `DisputedPanel` exists to refuse. It names the count and links nowhere new — the record
 * itself is one tap away and lists every reading with its own source.
 */
function RowWarnings({ row }: { row: ProgramRow }): JSX.Element | null {
  const disputed = row.program.trust.disputed;
  const staleMirror = row.program.trust.staleMirrorWarning;
  const safety = row.program.tags.includes(SAFETY_WARNING_TAG);
  if (!safety && staleMirror === undefined && disputed === undefined) return null;

  return (
    <>
      {safety && (
        <p className="row-danger" role="note" aria-label="Safety warning">
          Safety warning — this funder&rsquo;s former application domain was taken over and now
          redirects elsewhere. Do not visit it. Open the record for where to apply instead.
        </p>
      )}
      {disputed !== undefined && (
        <p className="row-disputed" role="note" aria-label="Disputed">
          Disputed — {disputed.claims.length} readings of this programme disagree. The record shows
          every one with its own source and picks none.
        </p>
      )}
      {staleMirror !== undefined && <p className="row-warning">{staleMirror}</p>}
    </>
  );
}

/** The award as the funder worded it. Never reformatted into a number the funder did not print. */
function amountOf(row: ProgramRow): string {
  return row.program.amount.amountRaw;
}

function ProgramCell({ row }: { row: ProgramRow }): JSX.Element {
  return (
    <td>
      <span className="row-name">
        <Link to={`/o/${row.program.id}`}>{row.program.name}</Link>
        <span className="row-funder">{row.funderName}</span>
      </span>
      <RowWarnings row={row} />
    </td>
  );
}

/**
 * The constraint drawer. `VerdictBadge` sets `aria-expanded` when `onExplain` is supplied, and an
 * `aria-expanded="true"` that reveals nothing is a promise the interface does not keep — so the
 * funder's own wording for each unmet constraint is what opens.
 */
function ReasonsList({ verdict }: { verdict: Verdict }): JSX.Element | null {
  if (verdict.kind !== 'ineligible') return null;
  return (
    <ul className="reasons-list">
      {verdict.reasons.map((reason) => (
        <li key={reason.id}>
          {reason.rawText}
          <span className="reasons-axis">{reason.spec.axis}</span>
        </li>
      ))}
    </ul>
  );
}

function ReasonsRow({ verdict }: { verdict: Verdict }): JSX.Element | null {
  if (verdict.kind !== 'ineligible') return null;
  return (
    <tr>
      <td className="reasons-cell" colSpan={COLUMN_COUNT}>
        <ReasonsList verdict={verdict} />
      </td>
    </tr>
  );
}

/**
 * ONE ROW, STACKED — the layout a club officer gets on a phone at a club meeting.
 *
 * This is not the table with columns hidden. A deadline row is a RECORD: the reader is holding
 * one programme at a time and deciding whether to act on it, not scanning a column of forty for
 * an outlier. So every field the table carries is here, and the honesty markers come FIRST,
 * immediately under the name — before the amount, before the prose. When a card is clipped by the
 * bottom of a phone screen, what has already been read is the status, the verdict and how old the
 * verification is, which is the ordering this product's whole argument depends on.
 *
 * Nothing is dropped at any width. That is the point of stacking rather than squeezing: a column
 * has to give something up when the viewport shrinks, and a stack does not.
 */
function ProgramRecord({
  row,
  now,
  onExplain,
  expanded,
}: {
  row: ProgramRow;
  now: string;
  onExplain?: (programId: string) => void;
  expanded: boolean;
}): JSX.Element {
  return (
    <li className="record card">
      <span className="row-name">
        <Link to={`/o/${row.program.id}`} className="record-name">
          {row.program.name}
        </Link>
        <span className="row-funder">{row.funderName}</span>
      </span>

      <div className="record-marks">
        <StatusPill status={row.program.trust.status} />
        <VerdictBadge
          verdict={row.verdict}
          onExplain={onExplain ? () => onExplain(row.program.id) : undefined}
          expanded={expanded}
        />
        <TrustBadge lastVerifiedAt={row.program.trust.lastVerifiedAt} now={now} />
      </div>

      {expanded && row.verdict !== null && (
        <div className="record-reasons">
          <ReasonsList verdict={row.verdict} />
        </div>
      )}

      <dl className="record-fields">
        <div className="record-field">
          <dt className="eyebrow">Closes</dt>
          <dd className="record-deadline">
            <DeadlineMarks row={row} />
          </dd>
        </div>
        <div className="record-field">
          <dt className="eyebrow">Amount</dt>
          <dd className="record-amount">{amountOf(row)}</dd>
        </div>
      </dl>

      <RowWarnings row={row} />
    </li>
  );
}

export function ProgramTable({
  rows,
  now,
  onExplain,
  expandedId,
  emptyNote,
}: ProgramTableProps): JSX.Element {
  const stacked = useNarrowerThan(PROGRAMME_TABLE_MIN_PX);

  if (rows.length === 0) {
    return (
      <div className="table-wrap">
        <div className="empty-state">
          <p>
            No opportunities match these filters. Widen the deadline window or clear a verdict
            filter.
          </p>
          {emptyNote !== undefined && <p className="empty-note">{emptyNote}</p>}
        </div>
      </div>
    );
  }

  if (stacked) {
    return (
      <ul className="record-list" aria-label="Opportunities">
        {rows.map((row) => (
          <ProgramRecord
            key={row.program.id}
            row={row}
            now={now}
            onExplain={onExplain}
            expanded={expandedId === row.program.id}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="table-wrap">
      <table className="grid-table" aria-label="Opportunities">
        <thead>
          <tr>
            <th scope="col">Program</th>
            <th scope="col">Verdict</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Closes
            </th>
            <th scope="col" className="amount">
              Amount
            </th>
            <th scope="col">Verified</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.program.id}>
              <tr>
                <ProgramCell row={row} />
                <td>
                  <VerdictBadge
                    verdict={row.verdict}
                    onExplain={onExplain ? () => onExplain(row.program.id) : undefined}
                    expanded={expandedId === row.program.id}
                  />
                </td>
                <td>
                  <StatusPill status={row.program.trust.status} />
                </td>
                {/*
                  `.deadline` lets the CELL break between the date and the mark that qualifies it.
                  Under `.num`'s blanket `nowrap` this column's min-content was 187 px — the date
                  and "published" welded onto one line — against 97 px for the date alone, and the
                  90 px difference is a quarter of the room the whole table was short of. The mark
                  is not dropped and is not clipped: it moves to the line below, and each mark is
                  individually `nowrap` so none of them can break mid-word.
                */}
                <td className="num deadline">
                  <DeadlineMarks row={row} />
                </td>
                {/*
                  NOT `.num`, which is the class for a date, a count and a figure: right-aligned,
                  monospaced and `white-space: nowrap`. `amountRaw` is the funder's own wording and
                  is frequently a sentence — "The new program price is either $1,450.00 or …" — and
                  under `nowrap` that single cell measured 1,905 px, which is what held this table
                  open at 2,563 px and took the whole page's horizontal scroll with it.

                  THE AMOUNT IS THE ONE THING ON THIS ROW ALLOWED TO GIVE GROUND, so in the table
                  it is clipped to four lines with a visible ellipsis. Measured on the shipped
                  corpus, the median `amountRaw` is 6 characters ("$3,000") and 25 of 143 run past
                  60, to a maximum of 430 — and unclipped those two dozen rows are several hundred
                  pixels tall each, which pushes the markers on every OTHER row off the screen. The
                  clip is visual only: the whole sentence stays in the DOM for a screen reader, the
                  record is one click away in the same row, and the record card layout shows it in
                  full because a stack has no column to run out of.
                */}
                <td className="amount">
                  <span className="amount-clip">{amountOf(row)}</span>
                </td>
                <td>
                  <TrustBadge lastVerifiedAt={row.program.trust.lastVerifiedAt} now={now} />
                </td>
              </tr>
              {expandedId === row.program.id && row.verdict !== null && (
                <ReasonsRow verdict={row.verdict} />
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
