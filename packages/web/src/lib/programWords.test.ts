import { describe, it, expect } from 'vitest';
import { aiStanceSchema, deadlineKindSchema, verificationMethodSchema } from '@grantspotter/core';
import {
  AI_STANCE_WORDS,
  DEADLINE_KIND_WORDS,
  VERIFICATION_METHOD_WORDS,
  deadlineKindWords,
  joinDeadlineNote,
  readDeadlineNote,
} from './programWords.js';

/**
 * THE TABLES BETWEEN WHAT THIS PRODUCT STORES AND WHAT IT SAYS.
 *
 * MEASURED on the deployed build before these existed: the record page printed `n_fixed_dates`,
 * `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01`, `cash_range`,
 * `live_fetch` and `unaddressed` at a reader deciding whether to spend an application fee.
 *
 * Every string is named here, one at a time, rather than asserted as a shape. A map whose values
 * are checked only for existence is a map whose values nobody has read, and the whole class of
 * defect this repository keeps finding is a sentence nobody read in the state that produces it.
 */
describe('DEADLINE_KIND_WORDS', () => {
  it.each([
    ['n_fixed_dates', 'Fixed dates each year'],
    ['n_fixed_windows', 'Several application windows each year'],
    ['annual_window', 'One application window each year'],
    ['rolling', 'Rolling — accepts applications year-round'],
    ['quarterly_rewritten', 'Rewritten quarterly'],
    ['ad_hoc', 'Ad hoc — announced when it happens'],
    ['inherited', 'Inherits another program’s deadline'],
    ['unpublished', 'No deadline published'],
    ['no_application_exists', 'No application exists'],
    ['dormant', 'Dormant — no live cycle'],
  ] as const)('says %s as "%s"', (kind, words) => {
    expect(DEADLINE_KIND_WORDS[kind]).toBe(words);
  });

  /**
   * TOTAL OVER THE UNION, derived from core's own enum rather than from a list retyped here. This
   * is what the map being `Record<DeadlineKind, string>` buys, checked at run time as well: the
   * copy of this table that used to live in `Calendar.tsx` was `Record<string, string>` with a
   * `?? kind` fallback, so a kind nobody had written words for reached the undated list as a bare
   * identifier and nothing failed anywhere.
   */
  it('covers every kind core defines, with no extras', () => {
    expect(Object.keys(DEADLINE_KIND_WORDS).sort()).toEqual([...deadlineKindSchema.options].sort());
  });

  it('names no kind after its own identifier', () => {
    for (const [kind, words] of Object.entries(DEADLINE_KIND_WORDS)) {
      expect(words, `${kind} still reads as its own token`).not.toContain(kind);
      expect(words).not.toMatch(/_/);
    }
  });
});

describe('deadlineKindWords', () => {
  it('answers with the same words the map holds', () => {
    expect(deadlineKindWords('n_fixed_dates')).toBe('Fixed dates each year');
  });

  /**
   * The calendar's undated list is typed `deadlineKind: string` — a plan-local mirror of the wire
   * shape — so it cannot index the map. It gets a guard rather than a cast: an unrecognised kind
   * is SAID to be unrecognised, which is a different statement from printing the token as though
   * it were English.
   */
  it('says a kind it does not know is one it does not know, and shows the token', () => {
    expect(deadlineKindWords('biennial_lottery')).toBe(
      'Deadline pattern GrantSpotter does not recognise (biennial_lottery)',
    );
  });
});

describe('AI_STANCE_WORDS', () => {
  it.each([
    ['permitted', 'This funder permits applicants to use AI.'],
    ['permitted_with_disclosure', 'This funder permits AI use and asks to be told about it.'],
    ['discouraged', 'This funder discourages applicants from using AI.'],
    ['prohibited', 'This funder prohibits applicants from using AI.'],
    ['unaddressed', 'This funder has published no position on applicants using AI.'],
  ] as const)('says %s as "%s"', (stance, words) => {
    expect(AI_STANCE_WORDS[stance]).toBe(words);
  });

  it('covers every stance core defines, with no extras', () => {
    expect(Object.keys(AI_STANCE_WORDS).sort()).toEqual([...aiStanceSchema.options].sort());
  });

  /**
   * `unaddressed` is 149 of the 150 publishable records, and the one that most needed saying:
   * "Stance: unaddressed" reads as a judgement the funder made, and it is the absence of one. The
   * words may not turn that absence into either an allowance or a prohibition.
   */
  it('reads the silent case as silence, never as permission or prohibition', () => {
    expect(AI_STANCE_WORDS.unaddressed).toMatch(/published no position/);
    expect(AI_STANCE_WORDS.unaddressed).not.toMatch(/permit|prohibit|allow|forbid/i);
  });
});

describe('VERIFICATION_METHOD_WORDS', () => {
  it.each([
    ['live_fetch', 'Fetched from the funder’s own page'],
    ['api', 'Read from the funder’s API'],
    ['manual_curation', 'Entered by hand from the funder’s page'],
    ['seed_import', 'Shipped with GrantSpotter and not re-fetched since'],
  ] as const)('says %s as "%s"', (method, words) => {
    expect(VERIFICATION_METHOD_WORDS[method]).toBe(words);
  });

  it('covers every method core defines, with no extras', () => {
    expect(Object.keys(VERIFICATION_METHOD_WORDS).sort()).toEqual(
      [...verificationMethodSchema.options].sort(),
    );
  });
});

/**
 * `DeadlineSpec.note` really carries a machine directive, a pipe, then prose. Six of the 150
 * publishable records are in that shape, and on every one of them the first thing under "Note" on
 * the record page was `RECUR`.
 */
describe('readDeadlineNote', () => {
  const ARDC =
    'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | ' +
    'Applications arriving after Sep 1 roll to the next Feb 1 cycle. ARDC evaluates for 60–120 days.';

  it('keeps a note with no directive exactly as the funder’s own sentence', () => {
    const note = 'The funder has never published a deadline for this program.';
    expect(readDeadlineNote(note)).toEqual({ prose: note });
  });

  it('drops the directive and keeps the prose after the pipe', () => {
    expect(readDeadlineNote(ARDC).prose).toBe(
      'Applications arriving after Sep 1 roll to the next Feb 1 cycle. ARDC evaluates for 60–120 days.',
    );
  });

  it('turns the directive’s parameters into a sentence a reader can check', () => {
    expect(readDeadlineNote(ARDC).rule).toBe(
      'February 1, April 1, July 1, September 1 each year, closing at 23:59 America/Los_Angeles',
    );
  });

  it('reads a window rule as a span rather than as two bare month-days', () => {
    expect(
      readDeadlineNote('RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00')
        .rule,
    ).toBe('October 30 to December 30 each year, 00:00 to 12:00 America/New_York');
  });

  it('reads several windows a year as several spans', () => {
    expect(
      readDeadlineNote(
        'RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30 | Two a year.',
      ).rule,
    ).toBe(
      'February 1 to February 28; June 1 to June 30 each year, 00:00 to 23:59 America/New_York',
    );
  });

  /**
   * A DIRECTIVE THAT DOES NOT PARSE IS DROPPED, NOT GUESSED AT. `parseRecurrence` throws on an
   * unknown zone, a malformed `MM-DD`, or a kind it does not know. A half-understood schedule
   * rendered as though it were understood is the plausible-looking fact this product exists not to
   * publish, and the caller still has the deadline KIND, which says how it repeats without
   * claiming to know when.
   */
  it('offers no rule at all when the directive does not parse', () => {
    const read = readDeadlineNote('RECUR n_fixed_dates tz=Mars/Olympus dates=02-01 | Ask them.');
    expect(read.rule).toBeUndefined();
    expect(read.prose).toBe('Ask them.');
  });

  it('leaves nothing behind when the directive was the whole note', () => {
    expect(readDeadlineNote('RECUR n_fixed_dates tz=UTC dates=02-01').prose).toBe('');
  });
});

/**
 * THE DIRECTIVE VERBATIM, AND WHY A READER'S SPLIT NEEDED AN INVERSE.
 *
 * `readDeadlineNote` was written for surfaces that PRINT the note, and for those `rule` is the
 * whole answer: a directive that does not parse is dropped, because a half-understood schedule
 * rendered as if it were understood is the thing this product exists not to publish.
 *
 * The Inbox's edit panel is the first caller that has to put the note back TOGETHER — it hands the
 * prose to an administrator to rewrite — and for that caller "dropped" means "deleted from the
 * corpus". So the split now also returns the bytes, whether or not they parse, and the join is
 * here rather than at the call site because a surface that splits by one rule and rejoins by
 * another loses the pipe, or doubles it, or drops the directive on an empty note.
 */
describe('readDeadlineNote’s directive, and joinDeadlineNote', () => {
  const ARDC_DIRECTIVE = 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01';
  const ARDC = `${ARDC_DIRECTIVE} | Applications arriving after Sep 1 roll to the next Feb 1 cycle.`;

  it('returns the directive verbatim, with the prefix and without the bar', () => {
    expect(readDeadlineNote(ARDC).directive).toBe(ARDC_DIRECTIVE);
  });

  it('returns no directive for a note that carries none', () => {
    expect(readDeadlineNote('The funder has never published a deadline.').directive).toBeUndefined();
  });

  it('returns a directive it could not read, because that is the one nobody can retype', () => {
    const read = readDeadlineNote('RECUR n_fixed_dates tz=Mars/Olympus dates=02-01 | Ask them.');
    expect(read.rule).toBeUndefined();
    expect(read.directive).toBe('RECUR n_fixed_dates tz=Mars/Olympus dates=02-01');
  });

  it('round-trips a note through the split and the join unchanged', () => {
    const read = readDeadlineNote(ARDC);
    expect(joinDeadlineNote({ directive: read.directive, prose: read.prose })).toBe(ARDC);
  });

  it('rejoins a directive-only note as the directive alone, with no dangling bar', () => {
    expect(joinDeadlineNote({ directive: ARDC_DIRECTIVE, prose: '' })).toBe(ARDC_DIRECTIVE);
    expect(joinDeadlineNote({ directive: ARDC_DIRECTIVE, prose: '   ' })).toBe(ARDC_DIRECTIVE);
  });

  it('rejoins prose with no directive as the prose alone', () => {
    expect(joinDeadlineNote({ prose: 'Closes Dec 30.' })).toBe('Closes Dec 30.');
  });
});
