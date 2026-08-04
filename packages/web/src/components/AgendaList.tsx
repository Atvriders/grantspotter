import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type {
  ApplicantEntity,
  Cycle,
  Instrument,
  OpportunityClass,
  ProgramStatus,
  Verdict,
} from '@grantspotter/core';
import { formatDate, NO_DATE } from '../lib/trust.js';
import { StatusPill } from './StatusPill.js';
import { TrustBadge } from './TrustBadge.js';
import './calendar.css';

/**
 * PLAN-LOCAL mirror of the server's `CalendarDeadlineSource` (`api/calendarRouter.ts`).
 *
 * `'stated'` — this programme published the window itself. `'inherited'` — the date was read off
 * ANOTHER programme's record, which is named, because 112 of the 150 publishable programmes ride
 * the ARRL Foundation scholarship portal's single window and a date with no attribution asserts
 * that the funder in front of you published it.
 */
export type CalendarDeadlineSource =
  | { kind: 'stated' }
  | { kind: 'inherited'; fromProgramId: string; fromProgramName: string };

/**
 * PLAN-LOCAL mirror of the server's `CalendarEntry` (`api/calendarRouter.ts`).
 *
 * It is a hand-written copy because the import direction is one-way — `web -> core`, never
 * `web -> server` — so the wire shape is restated here rather than imported. Two fields the brief
 * for this task omitted are present because they are on the wire and because Plan 3's global
 * constraints make them mandatory on this surface: `status` ("`unknown` renders as a real,
 * labelled state" — it is 118 of the 150 records) and `lastVerifiedAt` ("every user-facing date
 * renders with its provenance; no bare dates" — a calendar is nothing but dates).
 */
export interface CalendarEntry {
  cycle: Cycle;
  programId: string;
  programName: string;
  funderName: string;
  klass: OpportunityClass;
  instrument: Instrument;
  applicantEntities: ApplicantEntity[];
  /**
   * `false` means the FUNDER PUBLISHED this window; `true` means GrantSpotter projected it from a
   * recurrence rule. Telling the two apart is the entire reason this screen exists.
   *
   * The count that used to sit in this sentence ("four of the corpus's 244 cycles") is gone
   * rather than corrected. `data/seed/` — the corpus a fresh install actually gets — holds 3
   * records declaring a funder-published window, and how many of them are still a FUTURE cycle
   * depends on the day you ask: 2 on 2026-08-04, 0 from 2026-10-01, when the ARISS and Yaesu
   * windows have closed. `Calendar` derives the split from the entries it renders for exactly
   * this reason.
   */
  isEstimated: boolean;
  /**
   * WHOSE deadline this is. Orthogonal to `isEstimated`, which says how the date was ARRIVED at:
   * an inherited date can be projected or funder-published, and both facts are rendered.
   */
  deadlineSource: CalendarDeadlineSource;
  prepLeadDays: number;
  prepStartAt: string | null;
  prepNote: string;
  decisionLagMinDays: number | null;
  decisionLagMaxDays: number | null;
  watched: boolean;
  verdictKind: Verdict['kind'] | null;
  status: ProgramStatus;
  lastVerifiedAt: string;
}

/** PLAN-LOCAL mirror of the server's `UndatedProgram`. */
export interface UndatedProgram {
  programId: string;
  programName: string;
  funderName: string;
  deadlineKind: string;
  deadlineNote: string;
  status: ProgramStatus;
  lastVerifiedAt: string;
}

export const INSTRUMENT_WORDS: Record<Instrument, string> = {
  cash_range: 'Cash range',
  cash_fixed: 'Fixed cash award',
  cash_tiered_blocks: 'Tiered cash blocks',
  in_kind_equipment: 'Equipment in kind',
  in_kind_service: 'Service in kind',
  discounted_purchase: 'Discounted purchase',
  per_member_rebate: 'Per-member rebate',
  tuition_coverage: 'Tuition coverage',
  unknown: 'Instrument unknown',
};

const VERDICT_WORDS: Record<Verdict['kind'], { word: string; className: string }> = {
  eligible: { word: 'Eligible', className: 'verdict-eligible' },
  eligible_preferred: { word: 'Preferred', className: 'verdict-preferred' },
  ineligible: { word: 'Ineligible', className: 'verdict-ineligible' },
  // "Waiting on", never "becomes an answer": the matcher short-circuits per axis, so filling one
  // field moves an `unknown` to a different `unknown` as often as it resolves anything.
  unknown: { word: 'Waiting on your profile', className: 'verdict-unknown' },
};

/**
 * A zone of `''` — or none at all — means NOT RECORDED, and is rendered in UTC and SAID to be.
 * Substituting the browser's zone would manufacture a calendar day nobody observed.
 */
export function zoneLabel(timeZone: string | null | undefined): string {
  const zone = (timeZone ?? '').trim();
  return zone === '' ? 'UTC — no zone recorded' : zone;
}

function zoneOrUtc(timeZone: string | null | undefined): string | null {
  const zone = (timeZone ?? '').trim();
  return zone === '' ? null : zone;
}

/**
 * The calendar day an instant falls on IN THE CYCLE'S OWN ZONE, as `YYYY-MM-DD`, or null.
 *
 * This is the join between an instant and a cell. A deadline is stored as the UTC instant of a
 * 23:59 LOCAL wall time, so `2027-03-01T04:59:00.000Z` (America/New_York) is the funder's
 * 28 February — placing it by its UTC day moves it a whole month.
 */
export function localDay(
  iso: string | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  const day = formatDate(iso, zoneOrUtc(timeZone));
  return day === NO_DATE ? null : day;
}

/**
 * How one cycle's dates read: a WINDOW when the funder printed both ends, a DEADLINE when it
 * printed only a due date.
 *
 * The two IEEE programmes are the reason this is not one shape. mtt.org prints "must be received
 * by October 1" and states no opening; rendering that as an `Oct 1 – Oct 1` window would read
 * `closed` on 364 days a year and would assert an opening date IEEE has never published.
 */
export function cycleSpan(cycle: Cycle): string {
  const opens = localDay(cycle.opensAt, cycle.timezone);
  const closes = localDay(cycle.closesAt, cycle.timezone);
  if (opens !== null && closes !== null) return `${opens} – ${closes} window`;
  if (closes !== null) return `${closes} deadline`;
  if (opens !== null) return `${opens} opens, no close published`;
  return `${NO_DATE} no date published`;
}

/** Share of the prep runway already spent, or null when there is no runway to draw. */
export function elapsedPercent(entry: CalendarEntry, nowISO: string): number | null {
  if (entry.prepStartAt === null || entry.cycle.closesAt === undefined) return null;
  const start = Date.parse(entry.prepStartAt);
  const end = Date.parse(entry.cycle.closesAt);
  const now = Date.parse(nowISO);
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(now)) return null;
  if (end <= start) return null;
  return Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
}

function runwayPhrase(entry: CalendarEntry, nowISO: string): string {
  const pct = elapsedPercent(entry, nowISO);
  const closesAt = entry.cycle.closesAt;
  if (pct === null || closesAt === undefined) return '';
  const left = Math.ceil((Date.parse(closesAt) - Date.parse(nowISO)) / 86_400_000);
  if (pct <= 0) return ' The runway has not started yet.';
  if (left <= 0) return ' The close date has passed.';
  return ` ${left} day${left === 1 ? '' : 's'} of runway left.`;
}

export interface AgendaListProps {
  entries: CalendarEntry[];
  now?: string;
}

export function AgendaList({ entries, now }: AgendaListProps): JSX.Element {
  const nowISO = now ?? new Date().toISOString();

  if (entries.length === 0) {
    return (
      <p className="cal-empty card">
        No dated cycles fall inside this window. That is a statement about the window, not about
        the corpus — programs with no published deadline are listed below it.
      </p>
    );
  }

  return (
    <ul className="agenda" aria-label="Agenda">
      {entries.map((entry) => {
        const elapsed = elapsedPercent(entry, nowISO);
        const verdict = entry.verdictKind === null ? null : VERDICT_WORDS[entry.verdictKind];
        return (
          <li key={entry.cycle.id} className={`card${entry.isEstimated ? ' estimated' : ''}`}>
            <div className="when">
              <div>{cycleSpan(entry.cycle)}</div>
              <span className="zone">Dates in {zoneLabel(entry.cycle.timezone)}</span>
              <span
                className={`provenance ${entry.isEstimated ? 'projected' : 'published'}`}
                /*
                  "Four of the corpus's cycles are of this kind" used to close the second arm. The
                  number was wrong for every corpus in the tree (243, 244 and 252 were all
                  committed for the same claim), and on the corpus that ships it is not a constant
                  at all: the three seed records that declare a funder-published window resolve to
                  2 future cycles on 2026-08-04 and to 0 from 2026-10-01. `Calendar` prints the
                  split it counted from the entries it is holding, one screen up, which is where a
                  figure can be true for whatever is loaded; a per-row `title` repeated on every
                  card is not that place.
                */
                title={
                  entry.isEstimated
                    ? 'GrantSpotter projected this date forward from a recurrence rule. The funder has not announced it.'
                    : 'The funder published this window itself. It is not projected from a recurrence rule.'
                }
              >
                {entry.isEstimated ? 'Projected, not observed' : 'Funder-published'}
              </span>

              {/*
                WHOSE date this is, said on every row rather than only on the odd ones. 112 of the
                150 publishable programmes hold no deadline of their own; printing that date with
                no attribution asserts that the funder named on this card published it. The owner
                is LINKED because the row's practical advice is "the thing you actually submit to
                is over there" — one ARRL portal application covers 111 of these catalog entries.
              */}
              <span className="source">
                {entry.deadlineSource.kind === 'inherited' ? (
                  <>
                    Date inherited from{' '}
                    <Link to={`/o/${entry.deadlineSource.fromProgramId}`}>
                      {entry.deadlineSource.fromProgramName}
                    </Link>
                  </>
                ) : (
                  'Deadline stated by this programme'
                )}
              </span>
            </div>

            <div>
              <Link to={`/o/${entry.programId}`} className="agenda-name">
                {entry.programName}
              </Link>
              <div className="eyebrow">
                {entry.funderName} · {INSTRUMENT_WORDS[entry.instrument]}
              </div>

              <div className="meta">
                <StatusPill status={entry.status} />
                <TrustBadge lastVerifiedAt={entry.lastVerifiedAt} now={nowISO} />
                {verdict !== null && (
                  <span
                    className={`badge ${verdict.className}`}
                    role="img"
                    aria-label={`Eligibility: ${verdict.word}`}
                  >
                    {verdict.word}
                  </span>
                )}
                {entry.watched && <span className="watching">Watching</span>}
              </div>

              <p className="prep">
                {entry.prepStartAt !== null && (
                  <strong>Start by {localDay(entry.prepStartAt, entry.cycle.timezone)}</strong>
                )}
                {entry.prepStartAt !== null && ` — ${entry.prepLeadDays} days ahead. `}
                {entry.prepNote}
                {entry.decisionLagMinDays !== null &&
                  entry.decisionLagMaxDays !== null &&
                  ` Expect a decision in ${entry.decisionLagMinDays} to ${entry.decisionLagMaxDays} days.`}
                {runwayPhrase(entry, nowISO)}
              </p>

              {elapsed !== null && (
                <div
                  className="lead-bar"
                  style={{ '--elapsed': `${elapsed.toFixed(1)}%` } as CSSProperties}
                  aria-hidden="true"
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
