import { describe, expect, it } from 'vitest';
import {
  CHOSEN_CODE_MAX_DAYS,
  CHOSEN_CODE_MAX_INPUT,
  CHOSEN_CODE_MIN_LENGTH,
  describeEnrollmentCodeFold,
  ENROLLMENT_CODE_ALPHABET,
  ENROLLMENT_CODE_FOLD,
  exhaustionChance,
  labelRepeatsChosenCode,
  MEASURED_GUESSES_PER_SECOND,
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
    expect(sentence).toBe('O counts as 0, I counts as 1, and L counts as 1');
  });
});

/**
 * THE FLOOR, HELD TO ITS OWN DERIVATION.
 *
 * `CHOSEN_CODE_MIN_LENGTH` is not a preference: it is the shortest length at which a year of the
 * guess rate measured on this project's own server (1,862 wrong codes a second, 2026-08-10, with
 * the per-origin limiter defeated by rotating the reported origin) leaves worse than a one-in-a-
 * million chance of exhaustive search finding the code. This test recomputes that rather than
 * asserting `12`, so lowering the constant fails HERE with the arithmetic in front of the reader.
 */
describe('the floor under a code an administrator chooses', () => {
  const TARGET_ODDS = 1e6;

  it('is the shortest length that survives a year of the measured guess rate', () => {
    const guessesPerYear = MEASURED_GUESSES_PER_SECOND * 86_400 * CHOSEN_CODE_MAX_DAYS;
    const oddsAt = (length: number) =>
      Math.pow(ENROLLMENT_CODE_ALPHABET.length, length) / guessesPerYear;

    expect(oddsAt(CHOSEN_CODE_MIN_LENGTH)).toBeGreaterThan(TARGET_ODDS);
    expect(oddsAt(CHOSEN_CODE_MIN_LENGTH - 1)).toBeLessThan(TARGET_ODDS);
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

  it('accepts a code as long as the input bound allows', () => {
    expect(CHOSEN_CODE_MAX_INPUT).toBeGreaterThan(CHOSEN_CODE_MIN_LENGTH);
  });
});

/**
 * THE ODDS THE REFUSAL QUOTES, which are the only reason an administrator has to believe the floor.
 * They are computed from the measured rate rather than typed into a sentence, so the refusal cannot
 * go on quoting a number after the constant behind it has changed.
 */
describe('what a year of guessing is worth against a code of a given length', () => {
  it('quotes the odds the derivation table gives', () => {
    expect(exhaustionChance(8)).toBe('with about one chance in 19');
    expect(exhaustionChance(10)).toBe('with about one chance in 19,174');
    expect(exhaustionChance(11)).toBe('with about one chance in 613,569');
    expect(exhaustionChance(12)).toBe('with about one chance in 19,634,211');
  });

  it('says "with certainty" only where a year really does cover the whole space', () => {
    const perYear = MEASURED_GUESSES_PER_SECOND * 86_400 * CHOSEN_CODE_MAX_DAYS;
    // 32^7 is 3.4e10 and a year is 5.9e10, so every seven-character code can be tried and then
    // some. Eight is 1.1e12 and cannot, so it gets a probability instead of a verdict.
    expect(Math.pow(ENROLLMENT_CODE_ALPHABET.length, 7)).toBeLessThan(perYear);
    expect(exhaustionChance(7)).toBe('with certainty');
    expect(exhaustionChance(8)).not.toBe('with certainty');
  });

  it('groups its digits without depending on the host having ICU data', () => {
    // `toLocaleString` would render this differently on a small-icu build, so the sentence an
    // administrator reads would depend on how their image was compiled.
    expect(exhaustionChance(12)).toContain('19,634,211');
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
