import {
  CHOSEN_CODE_MAX_DAYS,
  CHOSEN_CODE_MAX_USES,
  CHOSEN_CODE_MIN_LENGTH,
  describeEnrollmentCodeStripped,
  exhaustionChance,
  groupThousands,
  labelRepeatsChosenCode,
  MEASURED_GUESSES_PER_DAY,
  normalizeEnrollmentCode,
} from '@grantspotter/core';

/**
 * EVERY RULE THAT APPLIES TO A CODE SOMEBODY TYPED, AND THE SENTENCES THAT REFUSE ONE — IN ONE
 * PLACE, BECAUSE THERE ARE NOW TWO WAYS TO TYPE ONE.
 *
 * All of this lived inside `api/enrollment.ts` and was right there while the admin console was the
 * only thing that could hand this product a code an officer had chosen. `ENROLLMENT_CODE` in
 * `docker-compose.yml` is the second, and a code that arrives from a file is a chosen code with a
 * YAML file around it: the same twelve-character floor, the same 200-use ceiling, the same 365-day
 * life, the same objection to a label that repeats the code. Nothing about arriving from a file
 * makes any of those less true.
 *
 * SO THE RULES MOVED HERE RATHER THAN BEING RESTATED, and this is the shape `config.ts` already
 * argues for at length under `assertUsableContactUrl` — ONE predicate, called by every path, rather
 * than a comment asking each path to remember. The measured lesson recorded there is this
 * repository's: for two commits the CONTACT_URL rules lived inside `loadConfig`, two scripts never
 * called it, and values the server refuses went out on the wire. A second copy of the floor would
 * fail the same way and worse, because the thing on the other side of it creates accounts.
 *
 * WHAT IS PURE HERE AND WHY THAT MATTERS. This module imports core and nothing else — no express,
 * no database, no `node:crypto`. That is what lets `config.ts` call it during `loadConfig`, which
 * is where the two other compose values are refused, without dragging better-sqlite3 into the
 * import graph of the two scripts in `scripts/` that also load config.
 *
 * The rules that need a DATABASE to decide — does this code already exist, is it revoked — are not
 * here. They cannot be answered by a pure function and they are not configuration errors; see
 * `auth/envEnrollmentCode.ts`, which is deliberate about answering them WITHOUT refusing to boot.
 */

/**
 * The upper bounds on a code, and neither is arbitrary.
 *
 * `maxUses` at 10,000: a club intake is tens and a conference badge run is hundreds, so anything
 * past this is a typo (a missing decimal point, a pasted phone number) and a typo that mints a
 * practically unlimited credential should be refused rather than honoured. An admin who genuinely
 * wants no limit says so explicitly with `null`, which is a different and visible decision.
 *
 * `expiresInDays` at 3,650: ten years is longer than any intake and shorter than forever, and
 * `null` again says forever explicitly.
 *
 * BOTH ARE THE GENERATED PATH'S CEILINGS. A code somebody TYPED is held to
 * `CHOSEN_CODE_MAX_USES` (200) and `CHOSEN_CODE_MAX_DAYS` (365) instead, which is what the two
 * refusals below are about. These two stay because `api/enrollment.ts` bounds its request schema
 * with them before it knows which kind of code it is being asked for.
 */
export const MAX_USES_CEILING = 10_000;
export const MAX_EXPIRY_DAYS = 3650;

/**
 * THE FLOOR, EXPLAINED WITHOUT THE IMPLICATION THAT CLEARING IT IS AN ACHIEVEMENT.
 *
 * WHAT THIS SENTENCE USED TO SAY AND WHY IT WAS WITHDRAWN. It derived twelve from a measured
 * 1,862 wrong codes a second, which was true of the server as it then stood — the wrong-code budget
 * was keyed on an address the caller could write, so it was not in anybody's way. Two things about
 * that are now different. The rate is a ceiling instead of a throughput
 * (`MEASURED_GUESSES_PER_DAY`, and `api/auth.ts` for the three rungs that produce it), so the
 * arithmetic behind twelve no longer lands on twelve. And the sentence's own logic was the problem
 * rather than its number: it answered "why twelve?" so thoroughly that it read as "twelve is
 * enough". MEASURED on 2026-08-10, `W1MX-SPRING-2027` — fourteen characters after normalisation,
 * comfortably over the floor — was found on the seventh guess.
 *
 * SO THE REFUSAL LEADS WITH THE THING THAT IS TRUE AT EVERY LENGTH and gives the number second.
 * `exhaustionChance` still supplies the odds, because a refusal that asserts without arithmetic is
 * a refusal a reader is right to distrust, and it is labelled as what it is: the chance of somebody
 * working through every code, which is not how any of these are found.
 */
export function tooShortRefusal(normalized: string): string {
  const length = String(normalized.length);
  const floor = String(CHOSEN_CODE_MIN_LENGTH);
  return (
    // `describeEnrollmentCodeStripped()` and not a written-out list: `U` is deleted by the
    // normaliser too, so a hand-written "capitals, dashes and spaces" quoted a length the reader
    // could not arrive at — `W1MX-AUTUMN-2026` is fourteen of those characters and twelve of these.
    `That code is ${length} characters once ${describeEnrollmentCodeStripped()} are taken out, and ` +
    `a code ` +
    `you choose has to be at least ${floor}. What the floor rules out is somebody working through ` +
    'every possible code: GrantSpotter answers at most 240 wrong codes every fifteen minutes ' +
    `across the whole server — ${groupThousands(MEASURED_GUESSES_PER_DAY)} a day, however many ` +
    'addresses they use — and a year of that gets through a code of ' +
    // "a code of N characters" rather than "a N-character code", so the sentence does not have to
    // pick between "a" and "an" from a number whose spoken form it cannot see.
    `${length} characters ${exhaustionChance(normalized.length)}, against a code of ${floor} ` +
    `characters ${exhaustionChance(CHOSEN_CODE_MIN_LENGTH)}. That is the whole of what ${floor} ` +
    'buys. It is not a measure of how hard your code is to GUESS, and no length is: in testing, ' +
    'W1MX-SPRING-2027 was found on the seventh attempt by somebody trying a callsign with a ' +
    'season and a year. Pick something a person outside your club would have no reason to try, ' +
    'give it a short life and a number of uses, and treat it as a convenience rather than a secret.'
  );
}

/**
 * WHY A CODE SOMEBODY TYPED HAS TO SAY HOW MANY PEOPLE IT IS FOR.
 *
 * The refusal names the thing it is bounding rather than the rule it is enforcing, because the
 * administrator reading it is about to choose the number and the only question that helps them is
 * "how many people am I giving this to?".
 */
export const NO_MAX_USES_REFUSAL =
  'A code you choose has to say how many accounts it may create, and this one was given no limit. ' +
  'A generated code is twenty random characters and nobody can arrive at it; one you can read out ' +
  'is one somebody can guess, and the number of uses is what decides how much a lucky guess is ' +
  'worth — in testing, a guessed code with no limit went on making member accounts until the test ' +
  'stopped asking. Put the size of the intake here. Thirty is the usual answer, you can issue ' +
  `another code in ten seconds if more people turn up, and the most a chosen code may have is ` +
  `${String(CHOSEN_CODE_MAX_USES)}.`;

export function tooManyUsesRefusal(asked: number): string {
  return (
    `A code you choose may create at most ${String(CHOSEN_CODE_MAX_USES)} accounts and this one ` +
    `asks for ${String(asked)}. That ceiling is about the day one of these is guessed rather than ` +
    'about the day it is used: it is what an administrator can review by hand, and past a hall ' +
    'full of people a code is not being read out any more, it is being published. A generated ' +
    `code can still have ${String(MAX_USES_CEILING)}, or no limit at all.`
  );
}

export const NO_EXPIRY_REFUSAL =
  'A code you choose has to expire, and this one was given no expiry. A generated code is twenty ' +
  'random characters and can safely live forever; a code an officer can read out at a meeting is ' +
  'one that gets read out at a meeting — written on a whiteboard, photographed, forwarded, left ' +
  'in a club chat that outlives the intake. An expiry is the only bound on that which does not ' +
  `depend on somebody remembering to revoke it. Give it a number of days, up to ` +
  `${String(CHOSEN_CODE_MAX_DAYS)}.`;

export function expiryTooLongRefusal(days: number): string {
  return (
    `A code you choose may live at most ${String(CHOSEN_CODE_MAX_DAYS)} days and this one asks ` +
    `for ${String(days)}. A code that gets read out gets forwarded, photographed and left in a ` +
    'club chat, and the chance of that only grows with time — an expiry is the one bound on it ' +
    'that does not depend on somebody remembering. A generated code can still have ten years, ' +
    'because nobody is passing one of those around by mouth. Issuing a new chosen code next year ' +
    'takes ten seconds.'
  );
}

export const LABEL_REPEATS_CODE_REFUSAL =
  'The label repeats the code. The label is stored exactly as you type it, shown in the table on ' +
  'this screen, and written to the audit log — which is read by more people, and kept for longer, ' +
  'than anything else here. A label containing the code would therefore store the code in the ' +
  'clear in three places, which is the one thing this design exists to avoid: only a keyed digest of a ' +
  'code is ever kept. Name the intake, not the code.';

/** What one caller is asking this product to store, before anything is written. */
export interface ChosenCodeProposal {
  /** The code as the person typed it. Normalisation happens here, not at the call site. */
  code: string;
  label: string;
  /** `null` is "no limit", and for a chosen code that is one of the things refused below. */
  maxUses: number | null;
  /** `null` is "never expires", refused for the same reason. */
  expiresInDays: number | null;
}

/**
 * WHY THIS PROPOSAL IS REFUSED, IN WORDS, OR `null` IF IT IS NOT.
 *
 * THE ORDER IS THE ORDER AN ADMINISTRATOR WANTS TO HEAR ABOUT THEM and it is load-bearing rather
 * than tidy: what is wrong with the code itself first, then how far it reaches — how long it may
 * live and how many accounts it may make — then the label. `api/enrollment.ts` checked them in
 * exactly this order before this function existed and `api/enrollment.test.ts` pins several of the
 * resulting sentences against specific bodies, so a reordering here changes which refusal a caller
 * who got two things wrong is told about.
 *
 * NONE OF THESE IS A RULE ABOUT ISSUING A CREDENTIAL IN GENERAL. Every one is about the single
 * property that differs between a code this server generated and a code a person chose: a chosen
 * code can be guessed. The generated path does not call this function at all.
 *
 * THE TWO REACH RULES CARRY THE WEIGHT. A floor cannot stop a code being guessed; how long it lasts
 * and how much it is worth when it is are the two things that CAN be bounded, so both are required
 * and neither is silently defaulted — including when the code comes from a file, where the
 * temptation to default them quietly is strongest because there is no form to fill in.
 */
export function refuseChosenCode(proposal: ChosenCodeProposal): string | null {
  const normalized = normalizeEnrollmentCode(proposal.code);
  if (normalized.length < CHOSEN_CODE_MIN_LENGTH) return tooShortRefusal(normalized);
  if (proposal.expiresInDays === null) return NO_EXPIRY_REFUSAL;
  if (proposal.expiresInDays > CHOSEN_CODE_MAX_DAYS) {
    return expiryTooLongRefusal(proposal.expiresInDays);
  }
  if (proposal.maxUses === null) return NO_MAX_USES_REFUSAL;
  if (proposal.maxUses > CHOSEN_CODE_MAX_USES) return tooManyUsesRefusal(proposal.maxUses);
  // Checked only for a chosen code because it cannot happen otherwise: on the generated path the
  // label is written before the code exists, so an administrator could not repeat it if they tried.
  if (labelRepeatsChosenCode(proposal.label, proposal.code)) return LABEL_REPEATS_CODE_REFUSAL;
  return null;
}

/**
 * THE LABEL EVERY CODE SET IN `docker-compose.yml` CARRIES, AND WHY THE STRING IS LOAD-BEARING
 * RATHER THAN DECORATIVE.
 *
 * IT IS THE IDENTITY. `enrollment_codes` stores a digest and no code, so at the next boot there is
 * no way to ask "which row is the one the file put here?" except by something the row carries. This
 * label is that something: `auth/envEnrollmentCode.ts` finds the file's row by matching it exactly.
 * That is what lets a boot tell "the operator changed the value" apart from "the operator issued a
 * second code in the app", which is the whole difference between retiring the right row and
 * retiring somebody else's.
 *
 * A COLUMN WAS THE OTHER CANDIDATE and would have been a fourth migration on this table. It was not
 * chosen for a reason that is about the product rather than the schema: the label is the one field
 * an administrator ALREADY SEES. A code appears in their table that they did not issue and cannot
 * reissue, and the row itself has to tell them where it came from and which file to edit. A hidden
 * boolean would have made the machine's identity precise and left the person looking at an
 * unexplained row — "a control whose operation cannot be seen cannot be operated", which is the
 * argument migration 092 makes for storing `chosen` at all.
 *
 * SO THE IDENTITY IS PROTECTED WHERE IT IS SPENDABLE. `api/enrollment.ts` refuses this label from
 * an administrator, case-folded, because an admin who typed it would otherwise create a row that
 * the next boot would treat as the file's and retire.
 */
export const ENV_CODE_LABEL = 'Set in docker-compose.yml (ENROLLMENT_CODE)';

/** Is this label the one reserved for the compose file's own code? Case-folded, trimmed. */
export function isEnvCodeLabel(label: string): boolean {
  return label.trim().toLowerCase() === ENV_CODE_LABEL.toLowerCase();
}

export const RESERVED_LABEL_REFUSAL =
  `“${ENV_CODE_LABEL}” is the label GrantSpotter gives the code set in the ENROLLMENT_CODE line ` +
  'of docker-compose.yml, and it is how the next boot recognises that row as the file\'s own. A ' +
  'code issued here under that label would be withdrawn the next time this server started, ' +
  'because the file would not name it. Name the intake instead — the label is what tells you ' +
  'which of your codes is which six months from now.';

/**
 * THE BOUNDS A CODE FROM THE COMPOSE FILE GETS WHEN THE OPERATOR DOES NOT SAY, AND WHY THERE ARE
 * DEFAULTS HERE AT ALL WHEN THE ADMIN CONSOLE REFUSES TO GUESS.
 *
 * THE CONSOLE'S REFUSAL IS RIGHT AND DOES NOT TRANSFER. `NO_MAX_USES_REFUSAL` argues that a silent
 * default would put the surprise on the thirty-first student, who reads "that code has already been
 * used the number of times it was issued for" as the product being broken, whereas a refusal at
 * issue time is read by the one person who can answer it. That argument turns entirely on there
 * being a form in front of that person with an empty box in it. There is no box in a YAML file.
 * Refusing to boot until the operator adds two more lines would be the same rule enforced against
 * somebody who has not been asked a question.
 *
 * SO THE ANSWER IS NOT "NO BOUND", IT IS "A STATED BOUND". Both values are written out in
 * `docker-compose.yml` as literal lines next to the code rather than left to these constants, so
 * the operator SEES what their code is bounded by while they are typing it and can change either
 * without knowing this file exists. These defaults are what a compose file that predates the
 * feature — or an `npm run dev` shell — falls back to, and the boot log prints the numbers that
 * were actually used either way. A compose-set code never becomes the one chosen code with no
 * bound.
 *
 * THIRTY, because that is the number this product already tells administrators is the usual answer
 * for a club intake, in `NO_MAX_USES_REFUSAL`, and two constants disagreeing about the ordinary
 * case would be this codebase's most-repeated defect in miniature.
 *
 * NINETY DAYS, and deliberately not the 365 the ceiling allows. A default that takes the maximum is
 * a default that has not been chosen. Ninety is one academic term, which is the unit the intake
 * this product is for actually runs in — a club recruits at the start of a semester, not once a
 * year — and it is short enough that a code left in a file somebody forgot about stops working
 * before the next intake arrives. The operator who wants a year says 365 on the next line.
 */
export const ENV_CODE_DEFAULT_MAX_USES = 30;
export const ENV_CODE_DEFAULT_DAYS = 90;

/**
 * WHAT `ENROLLMENT_CODE` AND ITS TWO COMPANIONS COME TO ONCE THE LOADER HAS READ THEM — a value
 * this process has already refused every way it knows how, carried on `AppConfig` beside
 * `sessionSecret` and `contactUrl`.
 *
 * `code` IS THE OPERATOR'S OWN STRING, unnormalised, because that is what has to be hashed: the
 * fold happens inside `hashEnrollmentCode`, and a second normalisation on the way in would be a
 * second place for the two to disagree. The normalised form is not carried here for the same
 * reason it is never printed — nothing downstream needs it, and a credential deserves as few
 * copies as it can be given.
 *
 * `maxUses` AND `days` ARE NEVER UNDEFINED. They are the defaults above when the operator says
 * nothing, and a compose-set code therefore cannot exist without both bounds. That is the invariant
 * the whole of the previous docblock is about.
 */
export interface EnvEnrollmentCode {
  code: string;
  maxUses: number;
  days: number;
}

/**
 * The label check for the compose path, which needs its own sentence rather than
 * `LABEL_REPEATS_CODE_REFUSAL`.
 *
 * SAME HAZARD, OPPOSITE REMEDY, and that is why the sentence is not shared. The hazard is identical:
 * the label is stored as written, shown in the admin table and written to the audit log, so a label
 * containing the code puts the code in the clear in three places. But the console's advice — "Name
 * the intake, not the code" — is advice the operator cannot take, because they do not choose this
 * label; `ENV_CODE_LABEL` does. The only thing they can change is the code. A shared sentence here
 * would be a refusal that tells somebody to edit a field they cannot reach.
 *
 * It fires only for a code that is a contiguous run inside the normalised label, which takes a
 * deliberately strange choice — the check is here because it costs one function call and because
 * "that cannot happen" is how the premise under a comment stops being true.
 */
export const ENV_LABEL_REPEATS_CODE_REFUSAL =
  `The code in ENROLLMENT_CODE appears inside “${ENV_CODE_LABEL}”, which is the label GrantSpotter ` +
  'gives it. That label is shown in the admin table and written to the audit log, so this code ' +
  'would be stored in the clear beside the digest of itself, which is the one thing this design ' +
  'exists to avoid. The label is not yours to change, so change the code.';
