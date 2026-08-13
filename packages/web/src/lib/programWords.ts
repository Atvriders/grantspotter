/**
 * THE ENUM VALUES A READER IS ALLOWED TO SEE, AND THE ENGLISH THEY ARE SEEN AS.
 *
 * Contract §3's unions are storage identifiers. `n_fixed_dates`, `cash_range`, `seed_import` and
 * `permitted_with_disclosure` are how this product writes a fact down; they are not how it says
 * one. The record page printed all four of them raw — "Pattern: n_fixed_dates", "Instrument:
 * cash_range", "Method: seed_import", "Stance: permitted_with_disclosure" — beside the Browse
 * facet list, which has rendered the SAME instrument enum as "Cash range" since Plan 3. A product
 * that owns a translation table and does not use it on the one screen where a student decides
 * whether to spend an application fee is not short of a table; it is short of using it.
 *
 * `Record<Union, string>`, not `Record<string, string>`, on every map here. A value added to
 * `DeadlineKind`, `AiStance` or `VerificationMethod` fails to compile in this file rather than
 * reaching a reader as a bare identifier — which is the failure mode being closed, so it may not be
 * left to a lookup that falls back to the raw key.
 *
 * `Instrument` is deliberately ABSENT. `lib/filterState.ts` already holds `INSTRUMENT_LABELS` and
 * the record page now imports it; adding a third map (`AgendaList.INSTRUMENT_WORDS` is the second)
 * would be this file's own subject matter repeated.
 */
import type { AiStance, DeadlineKind, VerificationMethod } from '@grantspotter/core';
import { RECURRENCE_PREFIX, parseRecurrence } from '@grantspotter/core';
import type { MonthDay, Recurrence, TimeOfDay } from '@grantspotter/core';

/**
 * How a deadline REPEATS, in words.
 *
 * Moved here from `routes/Calendar.tsx`, where it was a `Record<string, string>` with a
 * `?? kind` fallback serving the undated list, and where the record page could not reach it.
 * Typing it against the union is the half that was missing: the fallback meant a new kind would
 * have reached that list as a raw identifier too, silently.
 */
export const DEADLINE_KIND_WORDS: Record<DeadlineKind, string> = {
  rolling: 'Rolling — accepts applications year-round',
  unpublished: 'No deadline published',
  no_application_exists: 'No application exists',
  dormant: 'Dormant — no live cycle',
  ad_hoc: 'Ad hoc — announced when it happens',
  inherited: 'Inherits another program’s deadline',
  quarterly_rewritten: 'Rewritten quarterly',
  n_fixed_dates: 'Fixed dates each year',
  n_fixed_windows: 'Several application windows each year',
  annual_window: 'One application window each year',
};

/**
 * The same words, for a caller holding a `string` rather than a `DeadlineKind`.
 *
 * `AgendaList.UndatedProgram` — the plan-local mirror of the server's wire shape — declares
 * `deadlineKind: string`, so the calendar's undated list cannot index the map directly. It gets a
 * guard rather than a cast: an unrecognised kind is SAID to be unrecognised and shown as the token
 * it is, which is a different statement from printing the token as though it were English. The
 * record page holds a real `DeadlineKind` and indexes the map directly, so a value added to the
 * union still fails to compile there.
 */
export function deadlineKindWords(kind: string): string {
  return Object.prototype.hasOwnProperty.call(DEADLINE_KIND_WORDS, kind)
    ? DEADLINE_KIND_WORDS[kind as DeadlineKind]
    : `Deadline pattern GrantSpotter does not recognise (${kind})`;
}

/**
 * What a funder has said about applicants using AI, in words rather than in the stance token.
 *
 * `unaddressed` is the one that most needed saying: 142 of the 143 shipped records carry it, and
 * "Stance: unaddressed" reads as a judgement the funder made. It is the absence of one.
 */
export const AI_STANCE_WORDS: Record<AiStance, string> = {
  permitted: 'This funder permits applicants to use AI.',
  permitted_with_disclosure: 'This funder permits AI use and asks to be told about it.',
  discouraged: 'This funder discourages applicants from using AI.',
  prohibited: 'This funder prohibits applicants from using AI.',
  unaddressed: 'This funder has published no position on applicants using AI.',
};

/**
 * WHERE THIS RECORD'S VALUES CAME FROM, said as a provenance rather than as a pipeline stage.
 *
 * `seed_import` is not "imported from the seed" to anybody outside this repository; it is "shipped
 * with GrantSpotter and not re-fetched since", which is a fact about how much to trust the row.
 */
export const VERIFICATION_METHOD_WORDS: Record<VerificationMethod, string> = {
  live_fetch: 'Fetched from the funder’s own page',
  api: 'Read from the funder’s API',
  manual_curation: 'Entered by hand from the funder’s page',
  seed_import: 'Shipped with GrantSpotter and not re-fetched since',
};

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

function monthDay(md: MonthDay): string {
  return `${MONTHS[md.month - 1] ?? String(md.month)} ${String(md.day)}`;
}

function timeOfDay(t: TimeOfDay): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

/** The recurrence rule in English, or `undefined` when there is no rule to describe. */
function describeRecurrence(r: Recurrence): string | undefined {
  switch (r.kind) {
    case 'none':
      return undefined;
    case 'n_fixed_dates':
      return `${r.dates.map(monthDay).join(', ')} each year, closing at ${timeOfDay(
        r.closeTime,
      )} ${r.timezone}`;
    case 'n_fixed_windows':
      return `${r.windows
        .map((w) => `${monthDay(w.open)} to ${monthDay(w.close)}`)
        .join('; ')} each year, ${timeOfDay(r.openTime)} to ${timeOfDay(r.closeTime)} ${
        r.timezone
      }`;
    case 'annual_window':
      return `${monthDay(r.window.open)} to ${monthDay(r.window.close)} each year, ${timeOfDay(
        r.openTime,
      )} to ${timeOfDay(r.closeTime)} ${r.timezone}`;
  }
}

export interface DeadlineNote {
  /** The funder-facing sentences the note carries. `''` when the note is only a directive. */
  prose: string;
  /** The recurrence rule in English, when one is encoded and parses. */
  rule?: string;
}

/**
 * `DeadlineSpec.note` SPLIT INTO THE HALF A READER CAN USE AND THE HALF THEY CANNOT.
 *
 * The note really carries `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01
 * | Applications arriving after Sep 1 roll to the next Feb 1 cycle.` — a machine directive, a pipe,
 * then prose. The record page printed the whole string, so the first thing under "Note" on six of
 * the 150 publishable records was `RECUR`, `tz=` and `dates=02-01`: an internal encoding, in front
 * of the reader with the most at stake.
 *
 * `packages/server/src/prompts/compose.ts` already parses it exactly this way before putting a
 * deadline into an application brief, and states the reason there: "`dates=02-01` is not a date
 * anybody can read". The rule that a model is not asked to interpret is not one a student should be
 * either. The logic is restated rather than imported because `web` never imports `server`; both
 * sides read it through core's `parseRecurrence`, which is the one parser.
 *
 * A DIRECTIVE THAT DOES NOT PARSE IS DROPPED, NOT SHOWN. `parseRecurrence` throws on an unknown
 * zone, a malformed `MM-DD`, or a kind it does not know, and a half-understood schedule rendered as
 * if it were understood is the plausible-looking fact this product exists not to publish. The
 * caller still has `DEADLINE_KIND_WORDS[kind]`, which says how the deadline repeats without
 * claiming to know when.
 */
export function readDeadlineNote(note: string): DeadlineNote {
  const trimmed = note.trim();
  if (!trimmed.startsWith(RECURRENCE_PREFIX)) return { prose: trimmed };

  const bar = trimmed.indexOf('|');
  const prose = bar === -1 ? '' : trimmed.slice(bar + 1).trim();
  try {
    const rule = describeRecurrence(parseRecurrence(trimmed));
    return rule === undefined ? { prose } : { prose, rule };
  } catch {
    return { prose };
  }
}
