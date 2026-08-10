import { describe, expect, it } from 'vitest';
import {
  CHOSEN_CODE_MAX_DAYS,
  CHOSEN_CODE_MAX_INPUT,
  CHOSEN_CODE_MAX_USES,
  CHOSEN_CODE_MIN_LENGTH,
  describeEnrollmentCodeFold,
  describeEnrollmentCodeStripped,
  ENROLLMENT_CODE_ALPHABET,
  ENROLLMENT_CODE_DROPPED_LETTERS,
  ENROLLMENT_CODE_FOLD,
  exhaustionChance,
  labelRepeatsChosenCode,
  MEASURED_GUESSES_PER_DAY,
  normalizeEnrollmentCode,
} from '../src/enrollmentCode.js';

describe('the one reading of an enrollment code', () => {
  it('drops everything a person can add to a code without changing it', () => {
    const canonical = normalizeEnrollmentCode('K7QF2-9XMPT-3RJVH-8WCND');
    expect(canonical).toBe('K7QF29XMPT3RJVH8WCND');
    for (const variant of [
      'k7qf2-9xmpt-3rjvh-8wcnd',
      'K7QF29XMPT3RJVH8WCND',
      ' K7QF2 9XMPT 3RJVH 8WCND ',
      'K7QF2-9XMPT-3RJVH-8WCND\n',
    ]) {
      expect(normalizeEnrollmentCode(variant)).toBe(canonical);
    }
  });

  it('folds the confusable letters onto the digits they are mistaken for', () => {
    expect(normalizeEnrollmentCode('O1IL')).toBe('0111');
  });

  /**
   * THE FOURTH EXCLUDED LETTER, WHICH IS NOT EXCLUDED THE WAY THE OTHER THREE ARE.
   *
   * `U` is in neither the alphabet nor the fold, so it is deleted — and for as long as the server
   * was the only thing that made codes that could not happen, because the generator cannot emit
   * one. The moment an officer types the most obvious code for an autumn intake, the code they
   * think they made and the code this deployment stores are different strings.
   */
  it('deletes U outright, so an autumn intake is not the code the officer typed', () => {
    expect(normalizeEnrollmentCode('W1MX-AUTUMN-2026')).toBe('W1MXATMN2026');
    // Two spellings a person would never call the same, and one code — the same trap the fold
    // makes, reached by a letter nothing folds.
    expect(normalizeEnrollmentCode('W1MX-ATMN-2026')).toBe(
      normalizeEnrollmentCode('W1MX-AUTUMN-2026'),
    );
    // It shortens the code, which is the part that matters: the floor is measured after this runs.
    expect(normalizeEnrollmentCode('W1MX-AUTUMN-2026')).toHaveLength(12);
  });

  /**
   * THE PROPERTY THAT MAKES A CHOSEN CODE ABLE TO COLLIDE, stated as a test rather than as a
   * comment, because everything downstream — the refusal, the preview, the audit row — exists only
   * because of it. Two strings a person would never call the same are the same code.
   */
  it('makes two different-looking chosen codes into one code', () => {
    expect(normalizeEnrollmentCode('W1MX-FALL-2026')).toBe(
      normalizeEnrollmentCode('WIMX-FA11-2O26'),
    );
    expect(normalizeEnrollmentCode('W1MX-FALL-2026')).toBe('W1MXFA112026');
  });

  it('cannot emit a character the alphabet does not contain', () => {
    const noise = 'W1MX-FALL-2026 !@#£$%^&*()_+=[]{};:\'"\\|,.<>/?`~ uU iI lL oO';
    for (const character of normalizeEnrollmentCode(noise)) {
      expect(ENROLLMENT_CODE_ALPHABET, character).toContain(character);
    }
  });

  it('is empty when nothing recognisable is left, which is not a code', () => {
    expect(normalizeEnrollmentCode('----')).toBe('');
    expect(normalizeEnrollmentCode('!!! ??')).toBe('');
  });
});

describe('the sentence that explains the fold', () => {
  /**
   * `api/enrollment.ts` and `components/EnrollmentCodes.tsx` both print this to an administrator.
   * Neither writes the words out, so a change to `ENROLLMENT_CODE_FOLD` cannot leave either of them
   * describing a fold the server no longer performs — which is the exact way product copy about a
   * security property goes quietly wrong.
   */
  it('names every folded letter and the digit it becomes', () => {
    const sentence = describeEnrollmentCodeFold();
    for (const [letter, digit] of Object.entries(ENROLLMENT_CODE_FOLD)) {
      expect(sentence, letter).toContain(`${letter} counts as ${digit}`);
    }
    expect(sentence).toBe('O counts as 0, I counts as 1, L counts as 1, and U is dropped');
  });

  /**
   * THE CLAUSE THAT WAS MISSING, AND THE ONLY VERSION OF THIS TEST WORTH HAVING.
   *
   * Asserting the words "U is dropped" would pass just as happily against a hard-coded sentence.
   * What has to hold is that the sentence and the NORMALISER agree, so this asks the normaliser
   * which letters it destroys and requires each one to be named. A letter removed from the alphabet
   * tomorrow without being given a fold fails here, in core, before it can reach a screen.
   */
  it('accounts for every letter the normaliser does not pass through', () => {
    const sentence = describeEnrollmentCodeFold();
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const normalised = normalizeEnrollmentCode(letter);
      if (normalised === letter) continue;
      expect(sentence, letter).toContain(letter);
      // Deleted and folded are different fates and the sentence has to tell them apart: a person
      // who is told "U counts as V" has been misled in a new way rather than not misled.
      if (normalised === '') expect(sentence, letter).toContain(`${letter} is dropped`);
      else expect(sentence, letter).toContain(`${letter} counts as ${normalised}`);
    }
  });

  /** Derived from the alphabet and the fold, so it cannot be the one list somebody forgets. */
  it('derives the dropped letters instead of listing them', () => {
    expect(ENROLLMENT_CODE_DROPPED_LETTERS).toBe('U');
    for (const letter of ENROLLMENT_CODE_DROPPED_LETTERS) {
      expect(normalizeEnrollmentCode(letter), letter).toBe('');
    }
  });

  /**
   * THE SECOND SENTENCE, WHICH IS THE ONE ATTACHED TO A NUMBER.
   *
   * "That code is 12 characters once … are taken out" is the refusal an administrator argues with,
   * and a list that omits `U` makes the count unreachable: `W1MX-AUTUMN-2026` is fourteen of the
   * characters they typed and twelve of the ones the floor measures. This holds the list to what the
   * normaliser actually removes.
   */
  it('lists everything taken out before a code is measured', () => {
    const stripped = describeEnrollmentCodeStripped();
    expect(stripped).toBe('capitals, dashes, spaces and U');
    for (const letter of ENROLLMENT_CODE_DROPPED_LETTERS) {
      expect(stripped, letter).toContain(letter);
    }
    // The claim the sentence is attached to: what comes out is shorter by exactly those letters.
    const typed = 'W1MX-AUTUMN-2026';
    expect(normalizeEnrollmentCode(typed)).toHaveLength(
      [...typed].filter((c) => /[0-9A-Z]/.test(c) && !ENROLLMENT_CODE_DROPPED_LETTERS.includes(c))
        .length,
    );
  });
});

/**
 * THE FLOOR, AND THE CLAIM MADE ABOUT IT — WHICH IS NOT THE CLAIM THAT WAS MADE HERE ON 2026-08-10.
 *
 * WHAT THIS BLOCK USED TO ASSERT, AND WHY IT IS NOT SIMPLY BEING RELAXED. It recomputed the floor
 * from the guess rate and pinned it from BOTH sides — twelve clears one-in-a-million and eleven
 * does not — so that lowering the constant would fail here with the arithmetic in front of the
 * reader. That is a good test of a derived number and the number is no longer derived. The
 * wrong-code path now answers through a deployment-wide ceiling instead of a per-address budget a
 * caller could rotate past (`MEASURED_GUESSES_PER_DAY`), and at 23,040 a day the shortest length
 * that clears one-in-a-million is NINE. The lower assertion, unchanged, would now demand that
 * `CHOSEN_CODE_MIN_LENGTH` be LOWERED to nine.
 *
 * IT IS NOT WEAKENED, IT IS POINTED AT THE CLAIM THE PRODUCT NOW MAKES. Twelve is kept and is
 * deliberately no longer the arithmetic minimum, so what has to be pinned is the MARGIN — the floor
 * must sit strictly above the length the odds alone would justify — plus the thing the old test
 * could not express and the product got wrong: clearing the floor is not a property of a code.
 * `W1MX-SPRING-2027` clears it by two characters and was found on the seventh guess.
 */
describe('the floor under a code an administrator chooses', () => {
  const TARGET_ODDS = 1e6;
  const guessesPerYear = MEASURED_GUESSES_PER_DAY * CHOSEN_CODE_MAX_DAYS;
  const oddsAt = (length: number) =>
    Math.pow(ENROLLMENT_CODE_ALPHABET.length, length) / guessesPerYear;

  /** The shortest length a year at the ceiling cannot get through with a one-in-a-million chance. */
  function arithmeticFloor(): number {
    for (let length = 1; length <= CHOSEN_CODE_MAX_INPUT; length += 1) {
      if (oddsAt(length) > TARGET_ODDS) return length;
    }
    throw new Error('no length in range clears the target odds');
  }

  it('is above the length the odds alone would justify, and knows by how much', () => {
    // Nine, at the shipped ceiling. Asserted so that a change to the ceiling that quietly moves the
    // whole derivation is visible here rather than only in a comment.
    expect(arithmeticFloor()).toBe(9);
    expect(CHOSEN_CODE_MIN_LENGTH).toBeGreaterThan(arithmeticFloor());
    // And the floor really does clear the target it is a margin over, from the same arithmetic.
    expect(oddsAt(CHOSEN_CODE_MIN_LENGTH)).toBeGreaterThan(TARGET_ODDS);
  });

  it('leaves room for the memorable codes it exists to allow', () => {
    // The shape the feature was asked for. If the floor ever rules this out it has stopped being a
    // floor and started being a ban.
    expect(normalizeEnrollmentCode('W1MX-FALL-2026').length).toBeGreaterThanOrEqual(
      CHOSEN_CODE_MIN_LENGTH,
    );
    // And the shape it exists to refuse.
    expect(normalizeEnrollmentCode('W1MX2026').length).toBeLessThan(CHOSEN_CODE_MIN_LENGTH);
  });

  /**
   * THE PROPERTY THE OLD DERIVATION IMPLIED AND THE PRODUCT REPEATED: that a code clearing the
   * floor is a code that has been made safe. It is not, it never was, and this is the measurement
   * that says so — sixteen characters as typed, fourteen stored, over the floor, seventh guess.
   */
  it('does not make a code that clears it hard to guess', () => {
    const found = normalizeEnrollmentCode('W1MX-SPRING-2027');
    expect(found.length).toBeGreaterThan(CHOSEN_CODE_MIN_LENGTH);
    // Exhaustive search says one in 1.4e14. Somebody who had heard of the club needed seven tries.
    expect(oddsAt(found.length)).toBeGreaterThan(1e14);
  });

  it('accepts a code as long as the input bound allows', () => {
    expect(CHOSEN_CODE_MAX_INPUT).toBeGreaterThan(CHOSEN_CODE_MIN_LENGTH);
  });
});

/**
 * THE OTHER TWO BOUNDS ON A CHOSEN CODE, which are what is actually load-bearing now that the floor
 * is admitted not to be.
 */
describe('how far a code an administrator chooses may reach', () => {
  it('caps the accounts one chosen code can make well below the generated ceiling', () => {
    // A club intake of thirty is the intended use; the ceiling is six of those and is a number an
    // operator can review by hand on the day a code turns out to have been guessed.
    expect(CHOSEN_CODE_MAX_USES).toBeGreaterThan(30);
    expect(CHOSEN_CODE_MAX_USES).toBeLessThan(1000);
  });

  it('will not let a chosen code outlive the year its odds are quoted against', () => {
    expect(CHOSEN_CODE_MAX_DAYS).toBe(365);
  });
});

/**
 * THE ODDS THE REFUSAL QUOTES. They are computed from the ceiling rather than typed into a
 * sentence, so the refusal cannot go on quoting a number after the constant behind it has changed —
 * which is exactly what happened to the sentence these replaced: it quoted 1,862 wrong codes a
 * second, from a limiter that had been keyed on a header the caller wrote.
 */
describe('what a year of guessing is worth against a code of a given length', () => {
  it('quotes the odds the derivation table gives', () => {
    expect(exhaustionChance(8)).toBe('with about one chance in 130,745');
    expect(exhaustionChance(9)).toBe('with about one chance in 4,183,834');
    expect(exhaustionChance(12)).toBe('with about one chance in 137,095,879,068');
  });

  it('says "with certainty" only where a year really does cover the whole space', () => {
    const perYear = MEASURED_GUESSES_PER_DAY * CHOSEN_CODE_MAX_DAYS;
    // 32^4 is 1.0e6 and a year at the ceiling is 8.4e6, so every four-character code can be tried
    // and then some. Five is 3.4e7 and cannot, so it gets a probability instead of a verdict.
    expect(Math.pow(ENROLLMENT_CODE_ALPHABET.length, 4)).toBeLessThan(perYear);
    expect(exhaustionChance(4)).toBe('with certainty');
    expect(exhaustionChance(5)).not.toBe('with certainty');
  });

  it('groups its digits without depending on the host having ICU data', () => {
    // `toLocaleString` would render this differently on a small-icu build, so the sentence an
    // administrator reads would depend on how their image was compiled.
    expect(exhaustionChance(12)).toContain('137,095,879,068');
  });
});

describe('a label that gives the code away', () => {
  it('catches the label that IS the code, however either is spelled', () => {
    expect(labelRepeatsChosenCode('W1MX-FALL-2026', 'W1MX-FALL-2026')).toBe(true);
    // The fold runs on both sides, so a label spelled the other way is caught too.
    expect(labelRepeatsChosenCode('WIMX FA11 2O26', 'W1MX-FALL-2026')).toBe(true);
  });

  it('catches the label that merely contains the code', () => {
    expect(labelRepeatsChosenCode('W1MX-FALL-2026 intake', 'W1MX-FALL-2026')).toBe(true);
  });

  it('leaves an ordinary label alone', () => {
    expect(labelRepeatsChosenCode('W1MX autumn 2026 intake', 'W1MX-FALL-2026')).toBe(false);
  });

  /**
   * A code that normalises to nothing is not a code, and `''.includes('')` is true — so without the
   * guard in `labelRepeatsChosenCode` every label on the generated path would be reported as
   * repeating a code that does not exist.
   */
  it('says nothing about a label when there is no code to repeat', () => {
    expect(labelRepeatsChosenCode('W1MX autumn 2026 intake', '----')).toBe(false);
    expect(labelRepeatsChosenCode('', '')).toBe(false);
  });
});
