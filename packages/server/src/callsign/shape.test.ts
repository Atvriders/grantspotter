import { describe, expect, it } from 'vitest';
import { classifyCallsign, normaliseCallsign, type CallsignShape } from './shape.js';

/**
 * THE THREE ANSWERS, AND WHY THERE HAD TO BE THREE.
 *
 * `callDistrictFromCallsign` says `undefined` for "issued somewhere else" and for "not a callsign",
 * and `callook.ts` read every one of those as the first. Measured against the running server on
 * 2026-08-09, before this module existed: `POST /api/callsign/lookup` answered `status: "not_us"`
 * for `N0CALLXX`, `W1AW/4`, `???`, `KANSAS`, `W5X5` and `K`, with the sentence "your licence is no
 * less valid for being issued somewhere this lookup cannot reach" — printed at a person who had
 * typed one letter too many into an American callsign.
 *
 * Every case below is a SHAPE rather than an example, because the defect was a shape being read as
 * a nationality. `foreign` is asserted alongside them all the way through: the split is only worth
 * anything if the answer this product got right before is still right.
 */

const US: [string, string][] = [
  ['the 1×2 that started this product', 'W1AW'],
  ['a 2×3', 'KH6ABC'],
  ['a 2×1', 'AB4Q'],
  ['a 1×1 special-event call', 'W1A'],
  ['the top of the A block, which is American and looks foreign', 'AL7ZZZ'],
  ['a 2×2 in the A block', 'AJ0ZZ'],
  ['lower case, as anybody actually types it', 'w1aw'],
  ['padded with the whitespace a copy-paste leaves behind', '  kh6abc '],
];

const FOREIGN: [string, string][] = [
  ['a single-letter European prefix', 'G0ABC'],
  ['a two-letter prefix', 'DL1ABC'],
  ['Japan', 'JA1XYZ'],
  ['Canada', 'VE3ABC'],
  ['South Africa', 'ZS6ABC'],
  ['a digit-first prefix', '2E0ABC'],
  ['another digit-first prefix', '9A1AA'],
  ['a three-character allocation', '3DA0RS'],
  ['a letter-digit prefix', 'E71ABC'],
  // AM-AZ is not the United States even though AA-AL is, and geo.ts is the one that knows.
  ['the part of the A block Argentina holds', 'AZ1ABC'],
];

const MALFORMED: [string, string][] = [
  // The report that started this: N0 IS a US prefix, and six suffix letters is not a US format.
  ['too long, on a US prefix', 'N0CALLXX'],
  ['too long, one letter over', 'W1AWXYZ'],
  ['too short — a prefix and a district and nothing else', 'W1'],
  ['too short — one letter', 'K'],
  ['no digit at all', 'ABCDEF'],
  ['no digit, and a word somebody might type into the wrong box', 'KANSAS'],
  ['two digits, one of them where a letter belongs', 'W5X5'],
  ['two digits together, which is a fat-fingered US call and not a foreign one', 'K12AB'],
  ['punctuation', '???'],
  ['a path, which is what a hostile caller sends', '../../etc/passwd'],
  ['an operating suffix, which is not part of the callsign', 'W1AW/4'],
  ['a portable suffix', 'W1AW/P'],
  ['empty', ''],
  ['nothing but the whitespace a stray keypress leaves', '   '],
  ['an email address, because forms get the field above pasted into them', 'w1aw@example.org'],
  ['a callsign typed twice, which is what a double paste looks like', 'W1AWW1AW'],
];

describe('classifyCallsign: a callsign the FCC issues', () => {
  it.each(US)('reads %s as ours to ask about: %s', (_what, input) => {
    expect(classifyCallsign(input)).toBe<CallsignShape>('us');
  });
});

describe('classifyCallsign: a callsign somebody else issued', () => {
  it.each(FOREIGN)('reads %s as a callsign, and not ours: %s', (_what, input) => {
    expect(classifyCallsign(input)).toBe<CallsignShape>('foreign');
  });
});

describe('classifyCallsign: not a callsign at all', () => {
  /**
   * The assertion that IS the bug report. Every one of these used to be `foreign`, which the route
   * turns into "GrantSpotter can only look up United States callsigns automatically" — a claim
   * about a country, made about a string that names none.
   */
  it.each(MALFORMED)('refuses to guess a country for %s: %s', (_what, input) => {
    expect(classifyCallsign(input)).toBe<CallsignShape>('malformed');
  });

  it('never answers `foreign` for anything beginning with a US prefix block', () => {
    // K, N, W and AA-AL are American and nobody else's, so a broken string starting with one is a
    // mistyped American callsign however plausible it looks as somebody else's.
    for (const input of ['K12AB', 'N0CALLXX', 'W1AW/4', 'AL', 'AB1CDEF', 'NOTACALL']) {
      expect(classifyCallsign(input), input).not.toBe<CallsignShape>('foreign');
    }
  });
});

describe('normaliseCallsign', () => {
  it('takes out the whitespace and the case, and nothing else', () => {
    expect(normaliseCallsign('  w1 aw ')).toBe('W1AW');
    // NOT stripped: the record a stripped callsign would return is not the one that was asked for.
    expect(normaliseCallsign('w1aw/4')).toBe('W1AW/4');
  });

  it('is what makes a space in the input typing rather than a verdict', () => {
    // The one message that must never reach somebody holding a US licence.
    expect(classifyCallsign('W1 AW')).toBe<CallsignShape>('us');
  });
});
