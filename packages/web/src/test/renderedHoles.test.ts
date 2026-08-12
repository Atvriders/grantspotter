import { describe, expect, it } from 'vitest';
import { findRenderedHole, spokenText } from './setup.js';

/**
 * THE GUARD THAT SWEEPS EVERY WEB TEST, DEMONSTRATED FIRING.
 *
 * `setup.ts` reads `document.body` after every test in this project and refuses a rendered
 * `undefined` / `null` / `NaN` / `Infinity` / `[object Object]`. It is registered rather than
 * called, which is what makes it cover 51 files and 1,300 tests for free — and is also what makes
 * it invisible. A scanner nobody has watched fail is indistinguishable from one that matches
 * nothing at all: `contactUrlEntryPointContract.test.ts` in this same repo was walked past three
 * separate ways while green, and each hole was only found because somebody wrote an offender and
 * checked that it was reported.
 *
 * So this file writes the offenders. Every ASSERTED-WRONG case below is a sentence that actually
 * shipped, or the exact shape of one, and every ASSERTED-FINE case is a sentence in this product
 * today that must keep passing.
 */
describe('the after-every-test sweep for rendered holes', () => {
  /**
   * Round two. `frameFor('found', callsign)` built `FCC record for ${callsign}` from a record
   * whose `callsign` field had not arrived; the panel headed itself with the word "undefined" and
   * every test around it was green, because they asserted that a heading EXISTED.
   */
  it('catches the heading that named nobody', () => {
    expect(findRenderedHole('FCC record for undefined')).toBe('undefined');
  });

  it('catches a value read off a record that was null', () => {
    expect(findRenderedHole('Verified by null, on 2026-08-01.')).toBe('null');
  });

  /**
   * `retryAfter.ts`'s own docblock names this one: "try again in NaN seconds is worse than no
   * advice". `retryAfterSecOf` refuses a non-finite number for exactly this reason, and this is
   * what a screen that skipped it would print.
   */
  it('catches an arithmetic result that was not a number', () => {
    expect(findRenderedHole('Try again in NaN seconds.')).toBe('NaN');
  });

  it('catches an object interpolated where its field belonged', () => {
    expect(findRenderedHole('Deleted [object Object]. Removed with it: 3 watches.')).toBe(
      '[object Object]',
    );
  });

  it('catches a division that ran off the end', () => {
    expect(findRenderedHole('Infinity days of runway left.')).toBe('Infinity');
  });

  /**
   * The one exemption, and the proof it is too narrow to hide anything. `CallsignLookup` prints
   * "the body was “null”" about a 200 whose JSON payload really was `null`; that is a quotation of
   * the wire, not a hole. Wrapping quotes around a SENTENCE containing the token buys nothing.
   */
  it('allows a bare scalar quoted as itself, and nothing wider', () => {
    expect(findRenderedHole('The API answered — the body was “null” — so nothing is reported.')).toBe(
      null,
    );
    expect(findRenderedHole('“Verified undefined”')).toBe('undefined');
    expect(findRenderedHole('“undefined and 3 others”')).toBe('undefined');
  });

  /** Words that contain a token are words. A guard that fires on prose gets switched off. */
  it('does not fire on English that happens to contain the letters', () => {
    for (const sentence of [
      'That membership was annulled before the deadline.',
      'The club operates from Nanaimo, British Columbia.',
      'This programme is nullable in name only.',
      'An undefinedish claim is not a word, but this one has a suffix.',
    ]) {
      expect(findRenderedHole(sentence)).toBe(null);
    }
  });

  /**
   * `textContent` does not include attribute values, so a hole in an `aria-label` is a hole only a
   * screen-reader user meets. `TrustBadge` builds one from three interpolations
   * (`Verified {source}, on {date}.`), which is the shape that produced the round-two heading.
   */
  it('reads the attributes a screen reader speaks, not just the text', () => {
    // Built detached, not rendered: a hole left standing in `document.body` would be caught by
    // the very sweep this file is about, and reported against whichever test ran next.
    const tree = document.createElement('div');
    const badge = document.createElement('span');
    badge.setAttribute('aria-label', `Verified ${String(undefined)}, on 2026-08-01.`);
    badge.textContent = 'Verified';
    tree.append(badge);

    expect(findRenderedHole(tree.textContent ?? '')).toBe(null);
    expect(spokenText(tree).map(findRenderedHole).filter((hole) => hole !== null)).toEqual([
      'undefined',
    ]);
  });
});
