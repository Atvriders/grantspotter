/**
 * WHAT AN ENROLMENT CODE IS REDUCED TO BEFORE ANYTHING IS DONE WITH IT, AND WHY THAT LIVES HERE.
 *
 * The fold and the alphabet used to live in `packages/server/src/db/repositories/enrollmentCodes.ts`
 * beside the generator and the digest, which was right while a code was only ever produced by the
 * server. It is not right now that an administrator can type one: the browser has to show them the
 * form their code will actually be stored as BEFORE they save it, and `web -> server` is illegal
 * in this repository. So the normalisation moved to core, which both sides may import, and the
 * server re-exports it so nothing that already imported it had to change.
 *
 * The generator and the SHA-256 stayed in the server. They need `node:crypto`, core takes no
 * runtime dependency but zod (`test/purity.test.ts`), and neither is a thing a browser should be
 * able to do.
 */

/**
 * Crockford's base32: the ten digits and the twenty-two letters left after removing `I`, `L`, `O`
 * and `U`. The first three are the shapes that get confused with `1` and `0`; `U` is dropped so a
 * random twenty characters cannot spell something an officer would not want to read out.
 */
export const ENROLLMENT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The letters that are FOLDED rather than refused, because a code is read off a whiteboard.
 *
 * This map is the single definition. Both the refusals in `api/enrollment.ts` and the live preview
 * in `components/EnrollmentCodes.tsx` describe it to a person by calling
 * `describeEnrollmentCodeFold()` below rather than by writing the sentence out, so a change here
 * cannot leave either of them telling an administrator something that is no longer true.
 */
export const ENROLLMENT_CODE_FOLD: Readonly<Record<string, string>> = {
  O: '0',
  I: '1',
  L: '1',
};

/**
 * The one form a code is ever hashed in.
 *
 * Case is folded, the transcription confusions are folded, and everything that is not in the
 * alphabet — the dashes the generator writes, the spaces a person types, the newline an email
 * client wrapped in — is dropped. Dropping unknown characters rather than rejecting them is
 * deliberate: the alternative is a validation error that says "that is not a valid code" for a
 * trailing space, which is useless to the person and is a second answer an attacker could tell
 * apart from "wrong code".
 */
export function normalizeEnrollmentCode(raw: string): string {
  let out = '';
  for (const character of raw.toUpperCase()) {
    const folded = ENROLLMENT_CODE_FOLD[character] ?? character;
    if (ENROLLMENT_CODE_ALPHABET.includes(folded)) out += folded;
  }
  return out;
}

/** "O counts as 0, I counts as 1, and L counts as 1" — built from the map, never written out. */
export function describeEnrollmentCodeFold(): string {
  const parts = Object.entries(ENROLLMENT_CODE_FOLD).map(([from, to]) => `${from} counts as ${to}`);
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * HOW FAST THIS SERVER ANSWERS A WRONG CODE, AND HOW THE NUMBER WAS GOT.
 *
 * MEASURED 2026-08-10 on the project's own hardware, against the BUILT server in its own process:
 * 18,877 wrong codes at `POST /api/auth/enroll` answered in 10.14 s across 256 keep-alive
 * connections, every one of them a 401. 1,862 a second, 1.6e8 a day.
 *
 * THE LIMITER WAS NOT DEFEATED BY A TRICK; IT WAS NOT IN THE WAY. It is keyed on the caller's
 * reported origin, so the probe rotated `X-Forwarded-For` and every request got a fresh budget. A
 * second measurement on the same build confirms the limiter itself is exactly as documented — from
 * ONE address, ten wrong codes were answered and the eleventh was 429, which is 960 a day. Both
 * numbers are true and the larger one is the one a floor has to survive: behind the documented
 * single proxy `req.ip` is the real client, and one IPv6 allocation is more addresses than an
 * attacker can use.
 *
 * That is not a hole being papered over. `ENROLLMENT_MAX_FAILURES` in `api/auth.ts` says the same
 * thing in its own words and concludes, correctly, that unlimited guesses at 2^100 are worth
 * nothing. The limiter's job is to make casual guessing pointless and serious guessing loud — it
 * writes an audit row when it closes — and it was never a cap on the total. What changes with a
 * chosen code is only that the thing being guessed is no longer 2^100.
 */
export const MEASURED_GUESSES_PER_SECOND = 1862;

/**
 * THE FLOOR ON A CODE AN ADMINISTRATOR CHOOSES, IN CHARACTERS AFTER NORMALISATION, AND THE
 * ARITHMETIC THAT PUT IT AT TWELVE. It is not a password-policy habit and it is not a round number.
 *
 * `MEASURED_GUESSES_PER_SECOND` is 5.87e10 guesses in the 365 days `CHOSEN_CODE_MAX_DAYS` allows a
 * chosen code to live. Against exhaustive search of the 32-character alphabet above:
 *
 *   length   space     chance of a hit inside one year at the measured rate
 *   8        1.10e12   1 in 19
 *   10       1.13e15   1 in 19,174
 *   11       3.60e16   1 in 613,569
 *   12       1.15e18   1 in 19,634,211
 *
 * Twelve is the SHORTEST length at which a year of that costs worse than one in a million, and that
 * is the whole derivation. `W1MX2026` — the example this feature was asked for — is eight, and one
 * in nineteen is not a security control.
 *
 * WHY THE NUMBER IS ROBUST. Everything else in the derivation is a judgement, and `log32` makes the
 * answer barely care: moving the one-in-a-million target to one in a billion adds two characters,
 * and moving the maximum life from 90 days to ten years moves it by less than one. Doubling the
 * measured rate moves it by 0.14 of a character.
 *
 * WHAT TWELVE DOES NOT BUY, and this is the half that has to be said out loud in the product rather
 * than left here. Twelve characters is at MOST 60 bits and a human-chosen twelve is nothing like
 * it: `W1MXFALL2026` is a callsign somebody already knows, a season and a year, which is a handful
 * of guesses to anyone who has heard of the club. This floor rules out working through every
 * possible code. It does not, and no floor can, rule out being guessed.
 */
export const CHOSEN_CODE_MIN_LENGTH = 12;

/**
 * THE LONGEST A CHOSEN CODE MAY LIVE, AND WHY A CHOSEN CODE MUST HAVE AN EXPIRY AT ALL WHEN A
 * GENERATED ONE NEED NOT.
 *
 * NOT BECAUSE OF GUESSING. At twelve characters, exhausting the space at the measured 1.6e8 a day
 * takes twenty million years, so an unbounded life would survive brute force perfectly well and an
 * argument from brute force would be dishonest.
 *
 * BECAUSE OF DISCLOSURE, which is the risk a chosen code is deliberately taking on. The entire
 * reason to type your own is that it will be SAID: read out at a meeting, written on a whiteboard,
 * printed at the bottom of a flyer, pasted into a club Discord that outlives the intake. A
 * generated code is copied from a screen into a password manager by one person; a memorable one is
 * broadcast, and broadcast material does not come back. That risk only grows with time, and this
 * product has exactly two bounds on it: revocation, which needs somebody to remember, and expiry,
 * which does not. Requiring the one that does not depend on memory is the whole of the argument.
 *
 * A YEAR, and not ten as the generated path allows, for two reasons that agree. `CHOSEN_CODE_MIN_LENGTH`
 * is derived AGAINST a life — a longer life needs a longer code — and a year is where twelve lands;
 * rather than a sliding scale of length against days, the product fixes the pair and says so. And a
 * code called `W1MX-FALL-2026` should not still be working in 2031.
 *
 * `maxUses` IS NOT REQUIRED, deliberately, and the reason is that it would not be a bound on this
 * threat: a wrong guess spends no use, so a code with `maxUses: 30` can be guessed at exactly as
 * hard as one without. It bounds the CONSEQUENCE, not the attack, and it is worth recommending for
 * that — but this codebase has already shipped a bound imposed for a threat it did not address
 * (the disclosure limiter that answered 429 and closed a club's intake), and the lesson recorded
 * there is not to do it twice.
 */
export const CHOSEN_CODE_MAX_DAYS = 365;

/**
 * The longest string the code field will accept BEFORE normalisation, which is a different quantity
 * from the floor: dashes, spaces and case survive as far as this bound and are gone after it. It
 * exists so that a paste accident is refused as a paste accident rather than stored as a credential
 * nobody can read out, which is the one thing a chosen code was for.
 */
export const CHOSEN_CODE_MAX_INPUT = 96;

/**
 * A whole number with thousands separators, for a sentence a person reads.
 *
 * NOT `toLocaleString`, which depends on the ICU data the host image happens to ship: on a
 * small-icu build the same refusal would read `1862` on one deployment and `1,862` on another, and
 * a number's punctuation is not something a deployment should get to disagree about.
 */
export function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * WHAT A YEAR OF THE MEASURED GUESS RATE IS WORTH AGAINST A CODE OF THIS LENGTH, in words an
 * administrator can act on.
 *
 * COMPUTED RATHER THAN WRITTEN OUT, and that is the point of it existing. The refusal in
 * `api/enrollment.ts` used to say "at 8 characters a year of that finds this code; at 12 it does
 * not", which is an overstatement and an understatement in one sentence: eight characters is one
 * chance in nineteen, not a certainty, and twelve is one in twenty million, not merely "not". A
 * refusal that rounds a probability into a verdict is a refusal the reader is right to distrust.
 *
 * "A certainty" is used only where it is literally true — where a year of guessing covers the whole
 * space at least once — and nowhere else.
 */
export function exhaustionChance(length: number): string {
  const perYear = MEASURED_GUESSES_PER_SECOND * 86_400 * CHOSEN_CODE_MAX_DAYS;
  const space = Math.pow(ENROLLMENT_CODE_ALPHABET.length, length);
  if (space <= perYear) return 'with certainty';
  return `with about one chance in ${groupThousands(Math.round(space / perYear))}`;
}

/**
 * Does the label give the code away?
 *
 * THE HAZARD IS NEW WITH CHOSEN CODES AND IS NOT HYPOTHETICAL. The label is stored as typed, shown
 * in the admin table, and written to `audit_log` — which is read by more people and kept for longer
 * than anything else this router writes. An administrator naming a code after itself
 * ("W1MX-FALL-2026") would therefore put the credential in cleartext in three places, which is
 * precisely the thing storing only a SHA-256 exists to prevent. It cannot happen on the generated
 * path, because the label is written before the code exists.
 *
 * CONTAINMENT, NOT EQUALITY, and it is compared after normalisation on both sides: "W1MX-FALL-2026
 * intake" normalises to `W1MXFA112026`+`1NTAKE`, which still hands over the code.
 */
export function labelRepeatsChosenCode(label: string, chosen: string): boolean {
  const code = normalizeEnrollmentCode(chosen);
  if (code === '') return false;
  return normalizeEnrollmentCode(label).includes(code);
}
