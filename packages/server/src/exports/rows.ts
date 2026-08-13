/**
 * THE ONE FUNNEL EVERY EXPORT FORMAT GOES THROUGH.
 *
 * DEVIATION FROM THE TASK BRIEF (a third module, deliberately). The brief put the row shaping
 * inside `csv.ts` as `programToCsvRow`. Tasks 2-10 add XLSX, ICS, DOCX, Markdown, a ZIP packet and
 * a JSON backup, and every one of them needs the same three answers CSV needs:
 *
 *   1. WHICH RECORDS MAY LEAVE — `isDoNotPublish`, applied unconditionally.
 *   2. WHAT A PROJECTED DATE IS CALLED, versus one the funder actually published.
 *   3. WHAT AN UNSTATED OBLIGATION IS CALLED, versus one the funder said was not required.
 *
 * If those live in `csv.ts`, the next format either imports from a sibling format (which reads as
 * an accident and invites deletion) or answers them again. Answering them again is precisely how
 * the suppression boundary leaked four times in this repo, and how 144 of 150 records once
 * published the claim "this funder does not require cost sharing" that no funder had made.
 *
 * So the row model lives here, `buildExportRows` is the only way to obtain one, and the gate is
 * inside it. A format that renders `ExportRow`s cannot render a suppressed record, cannot present
 * a projection as a funder's word, and cannot turn silence into a "no", because it never gets the
 * chance to decide.
 */
import type { Cycle, Funder, Program } from '@grantspotter/core';
import { obligationState, readDeadlineNote } from '@grantspotter/core';
import { exportablePrograms } from './filter.js';

/**
 * The export column vocabulary, in order. `PROGRAM_CSV_COLUMNS` is this list; XLSX, DOCX and
 * Markdown pick from it by name and label it with {@link EXPORT_FIELD_LABELS}.
 */
export const EXPORT_FIELDS = [
  'id',
  'funder',
  'name',
  'summary',
  'class',
  'status',
  'applicantEntities',
  'instrument',
  'amountMin',
  'amountMax',
  'amountRaw',
  'awardCount',
  'deadlineKind',
  'deadlineBasis',
  'nextOpens',
  'nextCloses',
  'nextClosesUtc',
  'timezone',
  'cycleLabel',
  'deadlineRule',
  'deadlineNote',
  'costShareRequired',
  'coFunderPreference',
  'indirectCostCapPct',
  'aiPolicy',
  'applyVia',
  'applyUrl',
  'applyContact',
  'restrictions',
  'sourceUrl',
  'lastVerifiedAt',
  'verificationMethod',
  'disputed',
  'tags',
] as const;

export type ExportField = (typeof EXPORT_FIELDS)[number];

/** Human column headings, for the formats that show them to a reader rather than to a parser. */
export const EXPORT_FIELD_LABELS: Readonly<Record<ExportField, string>> = Object.freeze({
  id: 'ID',
  funder: 'Funder',
  name: 'Programme',
  summary: 'Summary',
  class: 'Class',
  status: 'Status',
  applicantEntities: 'Who may apply',
  instrument: 'Instrument',
  amountMin: 'Amount min',
  amountMax: 'Amount max',
  amountRaw: 'Amount (as published)',
  awardCount: 'Awards (as published)',
  deadlineKind: 'Deadline kind',
  deadlineBasis: 'Deadline basis',
  nextOpens: 'Next opens (funder’s day)',
  nextCloses: 'Next closes (funder’s day)',
  nextClosesUtc: 'Next closes (UTC instant)',
  timezone: 'Funder time zone',
  cycleLabel: 'Cycle',
  deadlineRule: 'Repeats',
  deadlineNote: 'Deadline note',
  costShareRequired: 'Cost share',
  coFunderPreference: 'Co-funder',
  indirectCostCapPct: 'Indirect cost cap %',
  aiPolicy: 'AI policy',
  applyVia: 'Apply via',
  applyUrl: 'Apply URL',
  applyContact: 'Apply contact',
  restrictions: 'Funding restrictions',
  sourceUrl: 'Source URL',
  lastVerifiedAt: 'Last verified',
  verificationMethod: 'Verification method',
  disputed: 'Disputed',
  tags: 'Tags',
});

/**
 * What the `deadlineBasis` cell says. Almost every exported deadline is computed from a recurrence
 * rule rather than published by its funder. Exported without the distinction, a projection becomes
 * an authoritative-looking deadline in a spreadsheet — and an applicant plans around it. The
 * projected wording names the source of the guess ON PURPOSE: a bare "estimated" reads as a hedge,
 * "estimated by GrantSpotter, not the funder" reads as an instruction to go and check.
 *
 * THE TWO CORPORA, because "the committed corpus" used to stand here unqualified and meant
 * whichever one the reader assumed:
 *
 *   - the FIXTURE corpus (`scripts/profile-corpus.ts` over `fixtures/`, fixed clock 2026-08-02):
 *     243 cycles, 4 funder-published — the figure `exports/corpus.test.ts` asserts, and the one
 *     every export byte-proof in this directory is measured against;
 *   - the SEED corpus (`data/seed/`), which is what a fresh install actually serves: 3 of its 143
 *     records declare a funder-published window, and through the ICS route's own two-year window
 *     that is 252 cycles with 2 funder-published on 2026-08-04, 250 with 1 on 2026-10-01 and 248
 *     with 0 on 2027-02-01.
 *
 * No count is quoted in any string a user reads, here or in `packages/web`, precisely because the
 * second list moves on its own.
 */
export const DEADLINE_BASIS_PUBLISHED = 'funder-published';
export const DEADLINE_BASIS_PROJECTED = 'projected (estimated by GrantSpotter, not the funder)';

export interface ExportRow {
  /** The programme itself, for the prose formats that need more than a flat cell. */
  readonly program: Program;
  readonly funderName: string;
  /** The soonest-closing cycle, or `undefined` when the programme has none. */
  readonly nextCycle: Cycle | undefined;
  /** Every {@link ExportField}, rendered. Never `undefined`; an absent value is `''`. */
  readonly cells: Readonly<Record<ExportField, string>>;
}

const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = DAY_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  let made: Intl.DateTimeFormat;
  try {
    // `en-CA` is the locale whose numeric date IS `YYYY-MM-DD` — the same choice
    // `packages/web/src/lib/trust.ts` makes, so the file and the screen agree.
    made = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    made = dayFormatter('UTC');
  }
  DAY_FORMATTERS.set(timeZone, made);
  return made;
}

/**
 * The calendar day an instant belongs to IN THE FUNDER'S OWN ZONE.
 *
 * A deadline is stored as the UTC instant of a 23:59 LOCAL wall time. The ARRL's "closes 28
 * February 2027" (America/New_York) is `2027-03-01T04:59:00.000Z`. Rendered in UTC that prints
 * **2027-03-01** — one day LATE, which tells an applicant they have a day they do not have. Five
 * programmes in the committed corpus render a different day without their zone.
 *
 * Semantics match `formatDate` in `packages/web/src/lib/trust.ts` exactly, and `rows.test.ts`
 * pins them against it, EXCEPT for the empty case: the screen shows an em dash because a blank
 * table cell reads as an oversight, while a CSV cell must be empty so a spreadsheet's date column
 * stays a date column. An absent or unparseable value is never rendered as a date.
 */
export function funderLocalDay(
  iso: string | null | undefined,
  timeZone: string | null | undefined,
): string {
  if (iso === null || iso === undefined || iso === '') return '';
  // A date-only string IS a calendar day already; re-zoning it would move it backwards a day in
  // any western zone — the same defect, in the opposite direction.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  // Null/empty means NO ZONE WAS RECORDED, which renders UTC. It is never an instruction to
  // substitute the server's zone, which would manufacture a day nobody observed.
  return dayFormatter(timeZone === null || timeZone === undefined || timeZone === '' ? 'UTC' : timeZone).format(
    new Date(parsed),
  );
}

/**
 * Tri-state, spelled out. `obligationState` is core's own reader and the switch below is
 * exhaustiveness-checked, so a fourth state cannot be added without this failing to compile.
 * ABSENT IS NOT A SOFT NO: across the corpus `costShareRequired` is unstated on 148 of 150 and
 * `false` on zero, and "the funder has not said" is a different instruction to an applicant than
 * "the funder says it is not required".
 */
function renderObligation(value: boolean | undefined, yes: string, no: string): string {
  switch (obligationState(value)) {
    case 'yes':
      return yes;
    case 'no':
      return no;
    case 'unstated':
      return 'unstated';
  }
}

/**
 * The soonest-closing cycle. Cycles that state a close date sort first and win; a cycle with only
 * an open date is a fallback, not a deadline. Ties break on id so two runs produce the same file.
 */
function nextCycle(cycles: readonly Cycle[] | undefined): Cycle | undefined {
  if (cycles === undefined || cycles.length === 0) return undefined;
  const key = (c: Cycle): string => c.closesAt ?? c.opensAt ?? '';
  return [...cycles].sort((a, b) => {
    const closing = Number(b.closesAt !== undefined) - Number(a.closesAt !== undefined);
    if (closing !== 0) return closing;
    const byDate = key(a).localeCompare(key(b));
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  })[0];
}

function buildRow(program: Program, funderName: string, cycles: readonly Cycle[] | undefined): ExportRow {
  const next = nextCycle(cycles);
  /*
    THE MACHINE DIRECTIVE DOES NOT GO IN THE FILE, AND THE SCHEDULE IT ENCODES DOES.

    `deadlineNote` was `program.deadline.note` — the whole string — so the cell a student reads
    began `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 |` on 7 of the
    143 rows a fresh install exports and 6 of the 150 the fixtures produce, in the CSV and in the
    XLSX alike. `cc64182` took that identifier off the record page; a spreadsheet is where the same
    record gets forwarded to a faculty advisor, so it was the surface with the widest audience and
    the least chance of anybody asking what `dates=02-01` meant.

    Dropping the directive alone would have thrown the schedule away with it — the dated columns
    beside this one carry only the NEXT cycle, so "the first of February, April, July and
    September, every year" exists nowhere else in the file. So the two halves are separated rather
    than one being deleted: `deadlineRule` is the rule in English (`readDeadlineNote`, core's
    reader, the same sentence the record page's "Repeats" row prints), `deadlineNote` is what the
    funder actually wrote. Both are empty when there is nothing to say; a note with no directive is
    unchanged prose in the column it has always been in.
  */
  const note = readDeadlineNote(program.deadline.note);
  const cells: Record<ExportField, string> = {
    id: program.id,
    funder: funderName,
    name: program.name,
    summary: program.summary,
    class: program.klass,
    status: program.trust.status,
    applicantEntities: program.applicantEntities.join('; '),
    instrument: program.amount.instrument,
    amountMin: program.amount.amountMin === undefined ? '' : String(program.amount.amountMin),
    amountMax: program.amount.amountMax === undefined ? '' : String(program.amount.amountMax),
    amountRaw: program.amount.amountRaw,
    awardCount: program.amount.awardCountRaw,
    deadlineKind: program.deadline.kind,
    deadlineBasis:
      next === undefined ? '' : next.isEstimated ? DEADLINE_BASIS_PROJECTED : DEADLINE_BASIS_PUBLISHED,
    nextOpens: funderLocalDay(next?.opensAt, next?.timezone),
    nextCloses: funderLocalDay(next?.closesAt, next?.timezone),
    nextClosesUtc: next?.closesAt ?? '',
    timezone: next?.timezone ?? '',
    cycleLabel: next?.label ?? '',
    deadlineRule: note.rule ?? '',
    deadlineNote: note.prose,
    costShareRequired: renderObligation(program.obligations.costShareRequired, 'required', 'not required'),
    coFunderPreference: renderObligation(
      program.obligations.coFunderPreference,
      'preferred',
      'not preferred',
    ),
    indirectCostCapPct:
      program.obligations.indirectCostCapPct === undefined
        ? ''
        : String(program.obligations.indirectCostCapPct),
    aiPolicy: program.aiPolicy.stance,
    applyVia: program.applyVia,
    applyUrl: program.applyUrl ?? '',
    applyContact: program.applyContact ?? '',
    restrictions: program.fundingRestrictions.join('; '),
    sourceUrl: program.trust.sourceUrl,
    lastVerifiedAt: program.trust.lastVerifiedAt,
    verificationMethod: program.trust.verificationMethod,
    disputed: program.trust.disputed === undefined ? '' : 'yes',
    tags: program.tags.join('; '),
  };
  return { program, funderName, nextCycle: next, cells };
}

/**
 * Programmes to rendered rows. THE SUPPRESSION GATE RUNS FIRST AND IS NOT OPTIONAL — see
 * `exportablePrograms`. Callers that have already filtered lose nothing: the gate is idempotent.
 *
 * A funder id with no matching `Funder` yields an empty funder name rather than throwing. A user
 * pressing Export must not receive a 500 because one row's funder row is missing; the id is still
 * in the `id` column.
 */
export function buildExportRows(
  programs: readonly Program[],
  funders: readonly Funder[],
  cyclesByProgramId: ReadonlyMap<string, Cycle[]>,
): ExportRow[] {
  const names = new Map(funders.map((f) => [f.id, f.name]));
  return exportablePrograms(programs).map((program) =>
    buildRow(program, names.get(program.funderId) ?? '', cyclesByProgramId.get(program.id)),
  );
}
