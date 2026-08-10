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
 * and `U`. The first three are the shapes that get confused with `1` and `0`; `U` is out so a
 * random twenty characters cannot spell something an officer would not want to read out.
 *
 * THE FOUR ARE NOT EXCLUDED THE SAME WAY, AND UNTIL AN ADMINISTRATOR COULD TYPE A CODE IT DID NOT
 * MATTER WHICH. `I`, `L` and `O` are FOLDED by the map below, so somebody who writes down the `0`
 * they saw as an `O` still gets in. `U` folds onto nothing, so `normalizeEnrollmentCode` DELETES
 * it — `W1MX-AUTUMN-2026` is stored as `W1MXATMN2026`, which is not the code the officer thinks
 * they made, and every sentence this product printed about normalisation used to omit that.
 *
 * The generator has never been able to emit a `U`, which is exactly why the omission survived: the
 * deletion could not fire on any code this software produced. It fires on the first code a person
 * types. `ENROLLMENT_CODE_DROPPED_LETTERS` below is derived from this constant and the fold rather
 * than written down, and `describeEnrollmentCodeFold()` says it out loud.
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
 * The letters a person can type that VANISH — excluded from the alphabet and given no fold.
 *
 * `U` today, and the constant is DERIVED rather than listed so it cannot be the one place somebody
 * forgets. Take away a letter's place in the alphabet without giving it a fold and it appears here,
 * and therefore in `describeEnrollmentCodeFold()`, and therefore in the browser and in the
 * refusals, on the same edit.
 *
 * WHY DELETED AND NOT REFUSED, which is a real choice and was made rather than inherited. Folding
 * `U` onto something is the option there is no honest candidate for: it is not a shape that gets
 * confused with a digit, which is the entire basis on which `I`, `L` and `O` fold. Refusing a code
 * that contains one would turn `W1MX-AUTUMN-2026` — the most natural thing an officer would type —
 * into an error, and would have to refuse it at REDEMPTION too, where a second answer that is not
 * "wrong code" is a free bit for somebody guessing. Deleting it is what the normaliser already does
 * to every dash, space and stray keystroke, and it costs nothing as long as it is SAID: the console
 * shows the stored form before the administrator saves, and the sentence below names the letter.
 *
 * Only letters. Digits are all in the alphabet, and the punctuation a person adds is not something
 * anybody needs told about — "capitals, dashes and spaces are ignored" already covers it.
 */
export const ENROLLMENT_CODE_DROPPED_LETTERS: string = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
  .filter(
    (letter) =>
      !ENROLLMENT_CODE_ALPHABET.includes(letter) && !Object.hasOwn(ENROLLMENT_CODE_FOLD, letter),
  )
  .join('');

/**
 * The one form a code is ever hashed in.
 *
 * Case is folded, the transcription confusions are folded, and everything that is not in the
 * alphabet — the dashes the generator writes, the spaces a person types, the newline an email
 * client wrapped in, AND ANY LETTER IN `ENROLLMENT_CODE_DROPPED_LETTERS` — is dropped. Dropping
 * unknown characters rather than rejecting them is deliberate: the alternative is a validation
 * error that says "that is not a valid code" for a trailing space, which is useless to the person
 * and is a second answer an attacker could tell apart from "wrong code".
 *
 * THE LETTER IS THE PART WORTH NAMING SEPARATELY. A dropped dash changes nothing anybody believes
 * about their code; a dropped `U` changes what the code IS, and the list above reads like it is
 * only about punctuation. `W1MX-AUTUMN-2026` comes out of here as `W1MXATMN2026`.
 */
export function normalizeEnrollmentCode(raw: string): string {
  let out = '';
  for (const character of raw.toUpperCase()) {
    const folded = ENROLLMENT_CODE_FOLD[character] ?? character;
    if (ENROLLMENT_CODE_ALPHABET.includes(folded)) out += folded;
  }
  return out;
}

/**
 * "O counts as 0, I counts as 1, L counts as 1, and U is dropped" — built from the two constants
 * above, never written out, and printed verbatim by both `api/enrollment.ts` and
 * `components/EnrollmentCodes.tsx`.
 *
 * THE LAST CLAUSE IS THE ONE THAT WAS MISSING. The sentence described the fold and stopped, so
 * every place it appears told an administrator about three letters and said nothing about the
 * fourth — the only one whose treatment SHORTENS their code. It is assembled from
 * `ENROLLMENT_CODE_DROPPED_LETTERS`, so it cannot fall behind the normaliser again.
 */
export function describeEnrollmentCodeFold(): string {
  const parts = Object.entries(ENROLLMENT_CODE_FOLD).map(([from, to]) => `${from} counts as ${to}`);
  const dropped = [...ENROLLMENT_CODE_DROPPED_LETTERS];
  if (dropped.length === 1) parts.push(`${dropped[0]} is dropped`);
  else if (dropped.length > 1) {
    parts.push(`${dropped.slice(0, -1).join(', ')} and ${dropped[dropped.length - 1]} are dropped`);
  }
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * "capitals, dashes, spaces and U" — everything taken out of a code before it is measured or
 * hashed, in the form a sentence can drop into.
 *
 * IT EXISTS BECAUSE THE HAND-WRITTEN VERSION WAS SHORT BY A LETTER, in the two sentences where the
 * omission actually costs somebody something: the refusal in `api/enrollment.ts` that tells an
 * administrator how long their code really is, and the hint under the code field. Both said "once
 * capitals, dashes and spaces are taken out" and then quoted a length that had also had a LETTER
 * taken out of it, so an officer typing `W1MX-AUTUMN-2026` counts fourteen, is told twelve, and has
 * a list in front of them that accounts for neither.
 *
 * Built from `ENROLLMENT_CODE_DROPPED_LETTERS`, and it reads exactly as it always did on a
 * deployment where no letter is dropped.
 */
export function describeEnrollmentCodeStripped(): string {
  const items = ['capitals', 'dashes', 'spaces', ...ENROLLMENT_CODE_DROPPED_LETTERS];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * HOW MANY WRONG CODES THIS SERVER WILL ANSWER IN A DAY, AND HOW THE NUMBER WAS GOT.
 *
 * IT USED TO BE A THROUGHPUT AND IT IS NOW A CEILING, which is the whole of what changed on
 * 2026-08-10. The constant here was `MEASURED_GUESSES_PER_SECOND = 1862`, and it was honest: the
 * wrong-code budget was keyed on the caller's reported origin, so a probe that rotated
 * `X-Forwarded-For` got a fresh budget per request and the limiter was not defeated so much as not
 * in the way. Re-measured on this host against the built server before the fix: 20,008 wrong codes
 * at `POST /api/auth/enroll` in 10.12 s across 256 keep-alive connections, every one a 401 — 1,977
 * a second, 1.7e8 a day, and no rows in `audit_log` at all.
 *
 * A FLOOR DERIVED AGAINST THAT NUMBER WAS THE WRONG INSTRUMENT, so the number was changed instead.
 * `api/auth.ts` now answers a wrong code through three ceilings rather than one: ten per address,
 * a hundred and twenty per source network as the TCP peer reports it, and TWO HUNDRED AND FORTY
 * DEPLOYMENT-WIDE with no key at all. The last is unforgeable because there is nothing in it to
 * forge, and it is the one this constant records: 240 in each fifteen-minute window, 96 windows a
 * day.
 *
 * MEASURED after the fix, same host, same harness, same ten seconds: one machine rotating
 * `X-Forwarded-For` across 256 connections was answered 120 times and refused 17,582 times, and
 * left one audit row rather than none; two source networks together were answered 240 and refused
 * 18,002, and left three. See `api/auth.ts` for what each rung costs the people it is not aimed at,
 * and `api/enroll.test.ts` ("what the product says the ceiling is") for the assertion that ties
 * this figure to the shipped ceiling so the two cannot drift.
 */
export const MEASURED_GUESSES_PER_DAY = 23_040;

/**
 * THE FLOOR ON A CODE AN ADMINISTRATOR CHOOSES, IN CHARACTERS AFTER NORMALISATION — AND THE
 * ARITHMETIC NO LONGER PUTS IT AT TWELVE. That sentence is the point of this comment.
 *
 * `MEASURED_GUESSES_PER_DAY` is 8,409,600 guesses in the 365 days `CHOSEN_CODE_MAX_DAYS` allows a
 * chosen code to live. Against exhaustive search of the 32-character alphabet above:
 *
 *   length   space     chance of a hit inside one year at the ceiling
 *   8        1.10e12   1 in 130,745
 *   9        3.52e13   1 in 4,183,834
 *   12       1.15e18   1 in 137,095,879,068
 *
 * By the rule that put this constant at twelve — the shortest length costing worse than one in a
 * million — the answer is now NINE. It stays at twelve, and the honest reason is not arithmetic.
 *
 * WHAT THE ARITHMETIC WAS EVER ABOUT. It rules out working through every possible code, and that
 * was never how a chosen code is found. MEASURED on 2026-08-10 against the built server:
 * `W1MX-SPRING-2027` — sixteen characters, clears this floor and would clear any floor a product
 * could impose without banning memorable codes outright — was found on the SEVENTH guess from one
 * address, by trying a club callsign with a season and a year. Lowering the constant to nine would
 * be defensible on the numbers and would say something false by implication: that the number is
 * what protects you.
 *
 * SO WHAT TWELVE IS FOR, exactly and only: it is the shortest length at which the exhaustive-search
 * argument is comfortably true rather than marginally true, with three characters of margin against
 * every judgement in the derivation — the one-in-a-million target, the 365-day life, and a ceiling
 * a future deployment might have reason to raise. Moving the target to one in a billion adds two
 * characters; a ten-year life adds one; `log32` is what makes those cheap.
 *
 * WHAT IT DOES NOT BUY, and this is the half that has to be said in the product rather than left
 * here. Twelve characters is at MOST 60 bits and a human-chosen twelve is nothing like it.
 * `W1MXFALL2026` is a callsign somebody already knows, a season and a year. CLEARING THIS FLOOR IS
 * NOT A PROPERTY OF A CODE; it is the absence of one particular way of being wrong. What bounds a
 * chosen code is the ceiling above, the audit rows `api/auth.ts` writes when guessing is going on,
 * `CHOSEN_CODE_MAX_DAYS`, and `CHOSEN_CODE_MAX_USES` — a floor is on that list nowhere.
 */
export const CHOSEN_CODE_MIN_LENGTH = 12;

/**
 * THE LONGEST A CHOSEN CODE MAY LIVE, AND WHY A CHOSEN CODE MUST HAVE AN EXPIRY AT ALL WHEN A
 * GENERATED ONE NEED NOT.
 *
 * NOT BECAUSE OF GUESSING. At twelve characters, exhausting the space at the ceiling takes far
 * longer than anybody's lifetime, so an unbounded life would survive brute force perfectly well and
 * an argument from brute force would be dishonest.
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
 * `maxUses` USED TO BE OPTIONAL HERE and now is not; see `CHOSEN_CODE_MAX_USES`, which answers this
 * paragraph's own objection to it rather than overruling it.
 */
export const CHOSEN_CODE_MAX_DAYS = 365;

/**
 * THE MOST ACCOUNTS ONE CHOSEN CODE MAY EVER CREATE — and a chosen code must now say how many it is
 * for, where before it could be issued with no limit at all.
 *
 * THE PARAGRAPH ABOVE USED TO REFUSE TO DO THIS, in these words: a wrong guess spends no use, so
 * `maxUses` bounds the CONSEQUENCE and not the attack, and this codebase has already shipped a
 * bound imposed for a threat it did not address. Every clause of that is still true and the
 * conclusion no longer follows, because what changed is what "the attack" means. When the argument
 * was written the belief underneath it was that a chosen code clearing the floor could not
 * realistically be found, so bounding the consequence was ceremony. MEASURED on 2026-08-10 against
 * the built server: `W1MX-SPRING-2027` was found on the seventh guess, and the code then minted 60
 * more member accounts as fast as they could be asked for, until the harness stopped asking.
 * Bounding the consequence is what is left when the attack cannot be prevented — that is not the
 * same move as bounding a consequence INSTEAD of addressing a threat, which is what the lesson was
 * about.
 *
 * THE OTHER HALF OF THAT LESSON IS OBEYED RATHER THAN NOTED: a limit that refuses legitimate work
 * is a defect. Two things follow. It is REQUIRED AND REFUSED IN WORDS, never silently defaulted to
 * thirty — a default would put the surprise on the thirty-first student, who has done nothing
 * wrong and reads "that code has already been used the number of times it was issued for" as the
 * product being broken, whereas a refusal at issue time is read by the one person who can answer
 * it. And the ceiling is set where a real intake cannot reach it.
 *
 * TWO HUNDRED. The intended use is a club intake of thirty. The largest thing a code still gets
 * READ OUT to — the reason to type your own at all — is a hall: a hamfest forum, a field day, a
 * conference session, which is hundreds. Two hundred is six intakes and is also about as many
 * accounts as an operator can review by hand in one sitting, which is the number that matters on
 * the day one of these is found. A generated code keeps `MAX_USES_CEILING` (10,000) and keeps
 * `null`: nobody can guess twenty random characters, and an intake bigger than a hall should be
 * using one.
 */
export const CHOSEN_CODE_MAX_USES = 200;

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
 * small-icu build the same refusal would read `23040` on one deployment and `23,040` on another,
 * and a number's punctuation is not something a deployment should get to disagree about.
 */
export function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * WHAT A YEAR AT THE CEILING IS WORTH AGAINST A CODE OF THIS LENGTH, in words an administrator can
 * act on — and it is worth only what exhaustive search is worth, which is the trap in reading it.
 *
 * COMPUTED RATHER THAN WRITTEN OUT, and that is the point of it existing. The refusal in
 * `api/enrollment.ts` used to say "at 8 characters a year of that finds this code; at 12 it does
 * not", which is an overstatement and an understatement in one sentence. A refusal that rounds a
 * probability into a verdict is a refusal the reader is right to distrust.
 *
 * "A certainty" is used only where it is literally true — where a year of guessing covers the whole
 * space at least once — and nowhere else.
 *
 * WHAT THE CALLER MUST NOT LET IT IMPLY. This is the chance of finding a code by trying all of
 * them, and nobody attacks a chosen code that way: `W1MX-SPRING-2027` is one chance in 1.4e14 by
 * this function and was found in seven guesses in testing. Every sentence built from this number
 * in the product says so in the same breath.
 */
export function exhaustionChance(length: number): string {
  const perYear = MEASURED_GUESSES_PER_DAY * CHOSEN_CODE_MAX_DAYS;
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
