import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Program, Verdict } from '@grantspotter/core';
import { VerdictBadge } from './VerdictBadge.js';
import { TrustBadge } from './TrustBadge.js';
import { StatusPill } from './StatusPill.js';
import { formatDate } from '../lib/trust.js';
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
 */
function DeadlineCell({ row }: { row: ProgramRow }): JSX.Element {
  const day = formatDate(row.nextClosesAt, row.nextTimezone);
  return (
    <td className="num">
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
    </td>
  );
}

function ProgramCell({ row }: { row: ProgramRow }): JSX.Element {
  return (
    <td>
      <span className="row-name">
        <Link to={`/o/${row.program.id}`}>{row.program.name}</Link>
        <span className="row-funder">{row.funderName}</span>
      </span>
      {/*
        The compromised-domain record. It is published ON PURPOSE — ARRL, QCWA and club pages
        still tell applicants to "apply at the FAR website", and this row is what intercepts that
        instruction. So it has to READ as a warning, and the host itself appears nowhere: not as a
        link, not as text. The only link on this row is the in-app record.
      */}
      {row.program.tags.includes(SAFETY_WARNING_TAG) && (
        <p className="row-danger" role="note" aria-label="Safety warning">
          Safety warning — this funder&rsquo;s former application domain was taken over and now
          redirects elsewhere. Do not visit it. Open the record for where to apply instead.
        </p>
      )}
      {row.program.trust.staleMirrorWarning !== undefined && (
        <p className="row-warning">{row.program.trust.staleMirrorWarning}</p>
      )}
    </td>
  );
}

/**
 * The constraint drawer. `VerdictBadge` sets `aria-expanded` when `onExplain` is supplied, and an
 * `aria-expanded="true"` that reveals nothing is a promise the interface does not keep — so the
 * funder's own wording for each unmet constraint is what opens.
 */
function ReasonsRow({ verdict }: { verdict: Verdict }): JSX.Element | null {
  if (verdict.kind !== 'ineligible') return null;
  return (
    <tr>
      <td className="reasons-cell" colSpan={COLUMN_COUNT}>
        <ul className="reasons-list">
          {verdict.reasons.map((reason) => (
            <li key={reason.id}>
              {reason.rawText}
              <span className="reasons-axis">{reason.spec.axis}</span>
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

export function ProgramTable({
  rows,
  now,
  onExplain,
  expandedId,
  emptyNote,
}: ProgramTableProps): JSX.Element {
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
            <th scope="col" className="num">
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
                <DeadlineCell row={row} />
                <td className="num">{row.program.amount.amountRaw}</td>
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
