/**
 * `DeadlineSpec.note` SPLIT INTO THE HALF A READER CAN USE AND THE HALF THEY CANNOT — for every
 * surface, not just the screen.
 *
 * The note really carries `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01
 * | Applications arriving after Sep 1 roll to the next Feb 1 cycle.` — a machine directive, a pipe,
 * then prose. `dates=02-01` is not a date anybody can read, and the directive is an internal
 * encoding this product emits (`server/src/normalize/deadline.ts`), never something a funder wrote.
 *
 * IT LIVES IN CORE BECAUSE FOUR SURFACES PRINT THAT FIELD AND THEY DO NOT SHARE A PACKAGE.
 * `cc64182` removed the directive from the record page (`web/src/lib/programWords.ts`), and it was
 * still leaving the building in the two files a student hands to a faculty advisor: measured on
 * the SHIPPED corpus (`data/seed/`, the one a fresh install serves), 7 of the 143 exported rows
 * carried `RECUR ` in the `deadlineNote` column of the CSV and in the same 7 cells of the XLSX; on
 * the fixture corpus, 6 of 150. A helper that only `web` can import is a helper the server writes
 * its own copy of — and `web -> core`, `server -> core`, with no edge between them, so core is the
 * one place both can reach. Core is also where the ONE parser already lives: nothing here
 * re-implements `parseRecurrence`.
 *
 * TWO RESTATEMENTS OF THIS LOGIC REMAIN IN THE TREE, and this module is where they should collapse
 * when they are next opened: `web/src/lib/programWords.ts`'s `readDeadlineNote` (the record page,
 * whose wording this file reproduces exactly so a spreadsheet and a record page cannot describe one
 * schedule in two ways) and `server/src/prompts/compose.ts`'s inline split (the model brief). They
 * are left alone here only because they are being edited in parallel work.
 *
 * A DIRECTIVE THAT DOES NOT PARSE IS DROPPED, NOT SHOWN. `parseRecurrence` throws on an unknown
 * zone, a malformed `MM-DD`, or a kind it does not know, and a half-understood schedule rendered as
 * if it were understood is the plausible-looking fact this product exists not to publish.
 */
import { parseRecurrence, RECURRENCE_PREFIX } from './deadline.js';
import type { MonthDay, Recurrence, TimeOfDay } from './deadline.js';

/**
 * Full month names, not `deadline.ts`'s `MONTH_SHORT`. A cycle label ("Feb 1, 2027 window") names
 * a dated occurrence in a tight cell; this names a rule a reader has to understand once. The
 * record page has said "February 1, April 1, July 1, September 1 each year" since `cc64182`, and
 * the file a student downloads has to say the same words as the page they read it on.
 */
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
export function describeRecurrence(r: Recurrence): string | undefined {
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
 * The two halves of a `DeadlineSpec.note`. A note with no directive is all prose, unchanged.
 *
 * The caller decides what to do with `rule`: the record page gives it its own "Repeats" row, the
 * spreadsheets give it its own column, and the packet brief prints it as a sentence. What no
 * caller may do is print `note` raw, which is what every one of them used to do.
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
