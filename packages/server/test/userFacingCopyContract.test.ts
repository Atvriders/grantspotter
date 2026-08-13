import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  censusUserFacingCopy,
  collectAssertionCorpus,
  DROP_REASONS,
  isAsserted,
  isKnownUnreadPosition,
  normalizeCopy,
  UNREAD_POSITIONS,
  REPO_ROOT,
  type CopySite,
  type DroppedString,
} from './helpers/userFacingCopy.js';

/**
 * EVERY SENTENCE THIS SOFTWARE SAYS TO A PERSON MUST BE TRUE IN THE STATE THAT PRODUCED IT.
 *
 * That is the standard this project holds, and four rounds of adversarial review have now found
 * the same defect wearing four sets of clothes:
 *
 *   round 1  a burst refusal promising a one-second wait for a fifteen-minute lockout
 *   round 1  "No account has been created" printed while two hundred rows were being created
 *   round 2  "FCC record for undefined", and a rung named "your network" behind a tunnel that
 *            has no such thing
 *   round 3  "GrantSpotter could not be reached" about a 200 that was mid-answer
 *   round 4  "the record either did not state it, or you changed what it said" — about a record
 *            that stated it, to an applicant who changed nothing
 *
 * IN ALMOST EVERY CASE NO TEST ASSERTED THAT SENTENCE AT ALL. The components were tested. Their
 * branching, their markup, their landmarks and their contrast ratios were tested. The words were
 * the one part nobody read, and the words are the product: a funding desk whose entire premise is
 * that it never states what it cannot source.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS, AND THE ONE DESIGN DECISION BEHIND IT
 *
 * A guard over copy can fail in two different ways, and only one of them survives contact with a
 * codebase people are still writing:
 *
 *   A guard that fails when a sentence CHANGES — a snapshot, a golden file, a catalogue of every
 *   string — is deleted, or blanket-re-blessed, the first afternoon somebody edits copy. It
 *   generates work in exact proportion to how much honest editing is going on, so it punishes the
 *   behaviour it wants and gets switched off. `cycleCountCopy.test.ts` in `packages/web` says the
 *   same thing about the comment that used to stand in for it.
 *
 *   A guard that fails when a sentence is WRONG costs nothing to rewording and everything to
 *   lying. It is the only kind worth building.
 *
 * The three checks this file makes are all of the second kind (a fourth `describe`, first below,
 * guards the census itself against going quiet AND against going blind):
 *
 *   1. THE ONE-NUMBER RULE. No sentence may say when to come back. The only statement of when in
 *      this product is `retryAfterSec`, rendered through `lib/retryAfter.ts`. Rewording a refusal
 *      cannot trip this; inventing a wait is the only thing that can. It is run over every string
 *      the walk touched — the counted sentences, the drops and the blind-spot ledger — because a
 *      rule that only reaches what a prose heuristic approved has a hole shaped like that
 *      heuristic's mistakes. That widening found five live violations in `callsign/callook.ts`,
 *      after the commit that built this rule said there was nothing left to allow.
 *
 *   2. THE UNASSERTED BUDGET. A per-file count of sentences no test names, which may go down and
 *      may not go up. Editing an asserted sentence does not change a count. Adding a sentence
 *      nobody looks at does — which is the hole this round exists to close.
 *
 *   3. THE SWEEP IS INSTALLED. Every browser spec must arm the rendered-hole observer, so a new
 *      spec cannot quietly opt out of the check that catches "FCC record for undefined".
 *
 * The census that all three read is `helpers/userFacingCopy.ts` — a TypeScript-AST parse of every
 * product source file, not a grep. It lives beside `contactUrlEntryPointContract.test.ts`,
 * `vitestCoverageContract.test.ts` and `tsconfigCoverage.test.ts` because it is the same kind of
 * object: a repo-wide invariant that reads what actually runs rather than a description of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND THE FIFTH ROUND'S FINDING, WHICH IS ABOUT THIS FILE RATHER THAN ABOUT THE PRODUCT.
 *
 * All three checks above were built on 2026-08-12 over a census that could not see a single
 * interpolated sentence. The placeholder the census wrote into its own text — `{}` — is refused by
 * its own CSS-selector rule, so every template literal carrying a substitution was classified as a
 * stylesheet and discarded in silence. 0 of 1,323 recorded sites contained the marker the type's
 * docblock promised. The one-number rule iterated a set that could not contain an invented wait
 * written as a template; the budget's headline understated the debt by 84; and the paragraph
 * headed "WHY THE INTERPOLATED FORM PASSES" described chunk analysis over sites that were never
 * collected — a docblock asserting a mechanism that did not run, which is the exact defect class
 * this whole week has been about.
 *
 * The lesson is not "fix the placeholder". It is that a counter which can exclude something
 * without saying so will eventually exclude the thing that matters, and stay green while it does.
 * `helpers/userFacingCopy.ts` no longer excludes anything silently: every string it walks is a
 * counted site, a drop with a reason from a closed set, or an entry in a named blind-spot
 * position, and `accounts for every string it walked` asserts the arithmetic.
 */

const census = censusUserFacingCopy();
const copy = census.sites;
const corpus = collectAssertionCorpus();
const unasserted = copy.filter((site) => !isAsserted(site, corpus));

function show(site: CopySite): string {
  return `${site.file}:${String(site.line)} [${site.kind}] ${site.text.slice(0, 140)}`;
}

function showDrop(drop: DroppedString): string {
  return `${drop.file}:${String(drop.line)} [${drop.reason}${
    drop.detail === null ? '' : `/${drop.detail}`
  }] ${drop.text.slice(0, 140)}`;
}

describe('the census itself', () => {
  /**
   * A SCANNER'S FAILURE MODE IS THAT IT GOES QUIET, and every other check in this file is a
   * statement about `copy`. If the walk stops descending, or the parser stops recognising JSX, or
   * a rename empties `PRODUCT_TREES`, then "no violations" and "nothing was read" look identical
   * from the outside — which is precisely how `tsconfigCoverage`'s invariant sat empty for a whole
   * plan while being cited as one of this project's guarantees.
   *
   * The floors are set an order of magnitude below what is measured today, so ordinary deletion
   * cannot trip them and a scanner that has broken cannot slip past them.
   */
  it('actually read the product, in all three trees', () => {
    expect(copy.length, 'the copy census collapsed — see helpers/userFacingCopy.ts').toBeGreaterThan(
      800,
    );
    expect(corpus.fileCount, 'the assertion corpus collapsed').toBeGreaterThan(150);

    const trees = new Set(copy.map((site) => site.file.split('/').slice(0, 3).join('/')));
    expect(trees).toContain('packages/web/src');
    expect(trees).toContain('packages/server/src');
    expect(trees).toContain('packages/core/src');
  });

  /**
   * The reverse check: a census that matched EVERYTHING would make the budget below vacuous in the
   * other direction. `import` specifiers, class names, SQL and CSS selectors are not sentences,
   * and a few known non-sentences are named here so that a widened heuristic is noticed.
   */
  it('does not mistake machinery for prose', () => {
    const texts = copy.map((site) => site.text);
    for (const notASentence of [
      'a[href], button:not([disabled])',
      'input, textarea, select',
      'application/json',
    ]) {
      expect(texts, `"${notASentence}" is not a sentence a person reads`).not.toContain(notASentence);
    }
  });

  /**
   * THE CHECK THAT WOULD HAVE CAUGHT THE DEFECT THIS ROUND REPAIRED, AND THE REASON IT IS HERE.
   *
   * Round four built this census, counted 1,320 sentences, read the 335 no test named and fixed
   * eight. It also, silently, could not see a single interpolated sentence. `record` was handed
   * `chunks.join('{}')` to judge, `machineryRule` refuses a brace because a brace is how a CSS rule
   * body is spelled, and so EVERY template literal carrying a substitution was classified as a
   * stylesheet and discarded without a word. Measured at abffd25: **0 of 1,323 sites contained the
   * `{}` that `CopySite.text`'s own docblock promised would be there.**
   *
   * That is the worst shape a bug can take in a counter. Nothing failed. The total looked healthy.
   * The class it dropped was the class most likely to be wrong — an interpolated sentence is one
   * whose words were chosen for a value the runtime does not have to supply, which is exactly what
   * "FCC record for undefined" was — and `CallsignLookup.tsx`'s "FCC record for {}", the round-two
   * defect this whole census was built to find, was among the missing.
   *
   * So the property is asserted rather than assumed, in both directions: sentences with a
   * substitution exist in quantity, AND one specific sentence known to carry one is present. A
   * future separator that trips a machinery rule turns this red on the first run.
   */
  it('can see an interpolated sentence', () => {
    const interpolated = copy.filter((site) => site.text.includes('{}'));
    expect(
      interpolated.length,
      'The census recorded no sentence with a substitution in it. That is what a placeholder ' +
        'colliding with a machinery rule looks like from the outside: a healthy total, and a ' +
        'whole class of copy — the class most likely to be false — invisible. See ' +
        '`proseCandidate` in helpers/userFacingCopy.ts.',
    ).toBeGreaterThan(120);

    const roundTwo = copy.filter(
      (site) =>
        site.file === 'packages/web/src/components/CallsignLookup.tsx' &&
        site.chunks.some((chunk) => chunk.includes('fcc record for')),
    );
    expect(
      roundTwo.map(show),
      'Round two’s own defect — "FCC record for undefined" — is written as an interpolation, ' +
        'and the census must be able to see the sentence that produced it.',
    ).not.toEqual([]);
  });

  /**
   * EVERY STRING THE WALK TOUCHED IS ACCOUNTED FOR, BY ARITHMETIC.
   *
   * A counter that silently omits is worse than no counter, because the number gets quoted — and
   * the placeholder bug proved that a scanner can drop a whole class of thing while every test
   * around it stays green. The repair is structural, not a second heuristic: `extractFromFile`
   * either records a site or records a drop with a named reason, so a future early `return` in the
   * cascade breaks a sum rather than shaving a total nobody is watching.
   *
   * Three things are asserted, and the third is the loud one:
   *
   *   the identity           sites + drops = candidates in a position this census reads
   *   the closed vocabulary  every drop reason is one of `DROP_REASONS`, every blind-spot entry is
   *                          one of `UNREAD_POSITIONS` — so a NEW kind of exclusion fails here
   *                          until somebody names it and writes down why nobody reads it
   *   nothing unclassified   a string that reached the end of the cascade without a decision.
   *                          This must be empty. It is the failure mode the census had.
   */
  it('accounts for every string it walked, and refuses to shrug at one', () => {
    expect(
      census.sites.length + census.drops.length,
      'A string in a read position was neither counted nor dropped, so it left the census by a ' +
        'path that records nothing. Find the branch in `extractFromFile` that returns without ' +
        'calling `record`.',
    ).toBe(census.considered);

    expect(census.considered).toBeGreaterThan(2000);
    expect(census.stringishNodes).toBeGreaterThan(census.considered);

    const strangeDrops = census.drops.filter(
      (drop) => !(DROP_REASONS as readonly string[]).includes(drop.reason),
    );
    expect(strangeDrops.map(showDrop), 'a drop reason outside the closed set').toEqual([]);

    const strangePositions = census.unread.filter((entry) => !isKnownUnreadPosition(entry.reason));
    expect(
      strangePositions.map(showDrop),
      'A string was excluded from the census for a reason not on `UNREAD_POSITIONS`. Add it to ' +
        'that list with a sentence saying why a person cannot read what sits there — the list is ' +
        'the census admitting where it does not look, and an unnamed exclusion is the thing this ' +
        'round exists to make impossible.',
    ).toEqual([]);

    const unclassified = census.drops.filter(
      (drop) => drop.reason === 'unclassified' || drop.detail === 'unclassified',
    );
    expect(
      unclassified.map(showDrop),
      'The census met a string it could not classify and fell through to `unclassified`. It is ' +
        'reported rather than dropped on purpose: a counter that quietly excludes what it does ' +
        'not understand reports a number that is wrong in the direction nobody checks.',
    ).toEqual([]);
  });

  /**
   * THE BLIND SPOT, PUBLISHED RATHER THAN PINNED.
   *
   * `Census.unread` is every string that reads as English by this module's own rules and sits
   * somewhere this census does not look. It is 1,461 entries at abffd25 and most of them are
   * machinery that happens to scan as prose. Some are not: `api/auth.ts` keeps its refusals as
   * module constants, so `ACCOUNT_DISABLED` and "Too many failed sign-ins for this email address
   * from this connection." are sentences a person reads that no census has counted.
   *
   * IT IS NOT RATCHETED BY COUNT, DELIBERATELY. The counts move whenever anybody writes a SQL
   * statement or an analyst note, and a number that must be bumped during ordinary work is a
   * number that gets bumped without being read — the first kind of guard, the kind this file's
   * header says gets switched off. What is ratcheted is the NAMES, above: the shape of the blind
   * spot is fixed, its volume is not. And the one-number rule below is run over this bucket as
   * well as over the sites, so the part of it that can actually harm a reader is governed by
   * content even where it is not governed by count.
   */
  it('knows the size of its own blind spot', () => {
    expect(
      census.unread.length,
      'the blind-spot ledger is empty, which means it stopped being collected',
    ).toBeGreaterThan(500);
    const positions = new Set(census.unread.map((entry) => entry.reason.split(':')[0]));
    for (const named of ['bare-literal-outside-the-browser', 'sql-statement', 'log-line']) {
      expect(positions, `${named} is no longer being recorded`).toContain(named);
    }
    expect(new Set(UNREAD_POSITIONS).size, 'UNREAD_POSITIONS has a duplicate').toBe(
      UNREAD_POSITIONS.length,
    );
  });
});

/**
 * THE ONE-NUMBER RULE.
 *
 * `api/auth.ts` states it, in a docblock headed "NOT ONE WORD ABOUT HOW LONG, IN ANY OF THE THREE
 * SENTENCES BELOW":
 *
 *     Every refusal this function produces travels with `details.retryAfterSec`, and every client
 *     that shows one prints that number… There is one number, it is `retryAfterSec`, and these
 *     sentences say what happened rather than when to come back.
 *
 * `lib/retryAfter.ts` states the other half: "read the server's number, and if it did not send
 * one, say nothing about time at all rather than inventing a figure."
 *
 * Both were written down, and on 2026-08-12 seven sentences in five files still broke them:
 *
 *   components/VerifyButton.tsx   "Try again in about an hour"  over a wait of 60 seconds
 *   components/VerifyButton.tsx   "Try again shortly."          over a wait of 58 minutes
 *   components/CallsignLookup.tsx "unreadable for a few minutes. Try again shortly"
 *   routes/Enroll.tsx             "Wait a moment and try again" for a request that never landed
 *   routes/Enroll.tsx             "Try again in a moment."      for a 5xx of unknown duration
 *   api/callsign.ts               "Try again shortly"           beside the number it had computed
 *   routes/FirstRun.tsx           "Wait a minute and try again." on an arm nobody could reach
 *
 * Not one of them was asserted by any test. This is the assertion.
 *
 * WHY TWO CUES AND NOT ONE. Matching a bare duration would fire on "Deadlines within 30 days" and
 * "ARRL member since", which are facts about the corpus rather than promises about the future, and
 * a guard that fires on honest prose is a guard somebody deletes. A violation needs BOTH a
 * come-back-later cue and a length-of-time cue in the SAME literal run — which is what a promise
 * about when to return is, and what nothing else is.
 *
 * WHY THE INTERPOLATED FORM PASSES, AND THE FACT THAT UNTIL 2026-08-12 IT DID NOT PASS — IT WAS
 * NEVER LOOKED AT. `` `Try again in ${humanRetryAfter(wait)}.` `` has literal runs "Try again in "
 * and "." — a retry cue and no duration, because the duration is a value. That is the shape this
 * rule exists to leave standing, and it is the only one. But this paragraph described a mechanism
 * that did not run: the census classified every interpolated sentence as a CSS selector and never
 * recorded one, so "chunk analysis over an interpolated sentence" was a claim about an empty set.
 * Demonstrated below on the census itself, which holds 189 sentences carrying a substitution at
 * abffd25 and has held no fewer since.
 *
 * WHAT IT IS RUN OVER, WHICH IS THE OTHER HALF OF THE SAME LESSON. Sites, drops AND the blind-spot
 * ledger — every string the walk touched, not only the ones it decided were copy. The rule used to
 * iterate `copy` alone, which made its reach a consequence of a prose heuristic rather than of the
 * rule itself, and `packages/server/src/callsign/callook.ts` is what that cost: five refusals
 * saying "try again in a moment" and "Try again shortly", written as bare literals in the server
 * tree, in a position the census does not read. They were live at abffd25 and the commit that
 * built this rule said "there is now nothing to allowlist". There was. It was somewhere the rule
 * could not look.
 */
const COME_BACK_LATER = /\btry again\b|\bcome back\b|\bretry\b|\bwait\b|\bcheck back\b/;

/**
 * AND THE HOLE IN THE HOW-LONG HALF, WHICH WAS SHAPED LIKE THE DIGIT `1`.
 *
 * Until 2026-08-12 the only counted duration this half recognised was `\d+\s*(?:second|minute|
 * hour|day)s?` — a NUMERAL. `Try again in five minutes.` therefore passed the guard completely:
 * "try again" is a come-back cue, "five minutes" is a duration, and neither `\bshortly\b` nor
 * `\bin a moment\b` nor the numeral branch matches it. That is not a hypothetical shape. The
 * product spells its durations out in words nearly everywhere it states one — `api/auth.ts` says
 * "fifteen minutes" three times, `prepLead.ts` says "thirty days" and "roughly two months",
 * `callook.ts` says "under five minutes" — so the ONE form the rule could see was the one form
 * this codebase does not habitually write.
 *
 * MEASURED before adding the branch, over every string the census walk touches (sites, drops and
 * the blind-spot ledger, 3,000-odd runs): 14 runs carry a spelled-out duration and NOT ONE of them
 * also carries a come-back cue, so the widening added zero violations and zero exemptions on the
 * day it landed. It costs the honest sentences nothing, which is the test of a rule worth having:
 * "NCDXF asks for roughly two months of lead", "thirty days is GrantSpotter's default", "seven day
 * columns" and "at least six weeks' lead" are all facts about a funder or a layout, and none of
 * them tells anybody when to come back.
 */
const HOW_LONG =
  /\bshortly\b|\bin a (?:moment|minute|while|bit|sec)\b|\ba (?:few|couple of) (?:seconds|minutes|hours|days)\b|\bin about\b|\b\d+\s*(?:second|minute|hour|day)s?\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|half an?|several)\s+(?:second|minute|hour|day|week|month)s?\b|\ban hour\b|\ba minute\b|\bsoon\b|\bpresently\b/;

function promisesATime(text: string): boolean {
  return COME_BACK_LATER.test(text) && HOW_LONG.test(text);
}

describe('no sentence may say when to come back', () => {
  it('states the wait only as the number the system computed', () => {
    const promises: string[] = [];
    for (const site of copy) {
      for (const chunk of site.chunks) {
        if (promisesATime(chunk)) promises.push(show(site));
      }
    }

    expect(
      promises,
      'A sentence tells the reader how long to wait. The only statement of when in this product ' +
        'is `retryAfterSec`, rendered by `packages/web/src/lib/retryAfter.ts` — which says ' +
        'nothing at all when the server sent no usable number, because a duration nobody measured ' +
        'is worse than no advice. Say what happened, and let the number say when.',
    ).toEqual([]);
  });

  /**
   * THE SAME RULE, OVER THE STRINGS THE CENSUS DOES NOT COUNT.
   *
   * A guard whose reach is decided by a prose heuristic is a guard with a hole shaped exactly like
   * that heuristic's mistakes, and this one had two: interpolated sentences (invisible until this
   * round) and every bare literal in the server tree (invisible still). A promise about when to
   * come back is recognisable from the characters alone, so there is no reason for this rule to
   * wait for the census to decide a string is copy first.
   */
  it('reaches into the strings the census does not count', () => {
    const promises: string[] = [];
    for (const entry of [...census.drops, ...census.unread]) {
      const run = normalizeCopy(entry.text);
      if (promisesATime(run)) promises.push(showDrop(entry));
    }

    expect(
      promises,
      'A promise about when to come back is sitting somewhere the census does not read — a bare ' +
        'literal in the server, an object value, a log line. Position is not a defence: the ' +
        'reader sees the sentence either way. Say what happened, and let `retryAfterSec` say when.',
    ).toEqual([]);
  });

  /**
   * THE ALLOWLIST IS GONE, AND SO ARE THE FIVE SENTENCES IT NAMED.
   *
   * A `KNOWN_UNGOVERNED` list stood here, holding five live invented waits in
   * `packages/server/src/callsign/callook.ts` — four "try again in a moment" over, respectively, a
   * request that timed out, a transport failure of unknown cause, a body that stopped arriving and
   * a connection dropped mid-answer, none of which says anything whatever about when the source
   * will next answer; and one "Try again shortly" sitting two clauses away from callook's OWN
   * published figure for the same event. They were listed rather than fixed because that file
   * belonged to another agent, with a second test asserting that no entry outlived its defect.
   *
   * They are fixed in this commit and the list is DELETED rather than emptied. An empty allowlist
   * is an invitation: it leaves a place to write "not my territory" and stay green, and the
   * ratchet test that guarded it can only guard entries somebody chose to write down. The
   * instruction survives in all five ("try again, or type your details in and carry on"); the
   * duration this software invented does not; and the UPDATING message now quotes callook's
   * five-minute reload figure, attributed to callook inside the sentence, and adds nothing of its
   * own on top of it.
   *
   * `states the wait only as the number the system computed` and `reaches into the strings the
   * census does not count`, above, are what enforce this, with nothing subtracted from either.
   */

  /**
   * The rule demonstrated firing, in both directions. A guard nobody has watched work is a guard
   * that may match nothing at all — the failure `contactUrlEntryPointContract.test.ts` was walked
   * past three separate ways while green.
   */
  it('is a rule about promises, not about the word "minutes"', () => {
    const violates = promisesATime;

    // The five sentences that shipped.
    expect(violates('you have used your verification allowance for this hour. try again shortly.')).toBe(true);
    expect(violates('you already verified this recently. try again in about an hour')).toBe(true);
    expect(violates('too many attempts. wait a minute and try again.')).toBe(true);
    expect(violates('it is unreadable for a few minutes. try again shortly.')).toBe(true);
    expect(violates('try again in 15 minutes.')).toBe(true);

    // The five that shipped in `callsign/callook.ts`, fixed in this commit. Kept as cases rather
    // than as an allowlist, so the exact sentences that were live cannot be written again.
    expect(
      violates(
        'the source being slow, not anything to do with your callsign - try again in a moment,',
      ),
    ).toBe(true);
    expect(violates('network, not your callsign - try again in a moment, or type your details in and')).toBe(true);
    expect(
      violates('minutes. nothing is wrong with your callsign. try again shortly, or type your details'),
    ).toBe(true);
    // ...and the wording that replaced them, which keeps the instruction and drops the invention.
    expect(violates('not anything to do with your callsign - try again, or type your details in and carry on.')).toBe(false);
    expect(
      violates(
        'it says the reload usually takes under five minutes. nothing is wrong with your callsign.',
      ),
    ).toBe(false);

    /*
     * THE HOLE SHAPED LIKE THE DIGIT `1`, DEMONSTRATED.
     *
     * Every one of these was legal until 2026-08-12: the counted-duration branch recognised a
     * NUMERAL and nothing else, so a wait written the way this codebase habitually writes waits —
     * in words — walked straight through a rule whose whole subject is invented waits. Watch it
     * fail on the numeral and pass on the word, and you have watched the guard not work.
     */
    expect(violates('try again in five minutes.')).toBe(true);
    expect(violates('please wait thirty seconds and try again.')).toBe(true);
    expect(violates('come back in two hours.')).toBe(true);
    expect(violates('retry in several days.')).toBe(true);

    // The forms that are honest, and must stay legal.
    expect(violates('try again in ')).toBe(false); // …${humanRetryAfter(wait)}.
    expect(violates('too many sign-in attempts. try again later.')).toBe(false);
    expect(violates('you have used every verification in your hourly allowance.')).toBe(false);
    expect(violates('deadlines within 30 days of today')).toBe(false);
    expect(violates('expect a decision in 60 to 90 days.')).toBe(false);

    /*
     * And the spelled-out durations that ARE in the product today, none of which tells anybody
     * when to come back. Widening the rule may not cost these anything; if it ever does, the
     * widening is wrong, not the sentence. Measured: 14 runs carry a spelled-out duration and none
     * pairs it with a come-back cue.
     */
    expect(violates("ncdxf asks for roughly two months of lead before it can act on a request.")).toBe(false);
    expect(violates("thirty days is grantspotter's default,")).toBe(false);
    expect(violates('seven day columns, and they do not shrink below the width their marks need.')).toBe(false);
    expect(violates("event and travel process needing at least six weeks' lead and a maximum of three")).toBe(false);
    expect(violates('one award also accepts applicants within three months of citizenship.')).toBe(false);
  });

  /**
   * THE MECHANISM THE DOCBLOCK CLAIMS, EXECUTED.
   *
   * "WHY THE INTERPOLATED FORM PASSES" above describes chunk analysis over a sentence with a
   * substitution in it. Until 2026-08-12 that paragraph described nothing: the census held zero
   * such sentences, so the rule had never once been applied to one and the honest form it claims
   * to protect had never been protected. This is that paragraph turned into an assertion — over
   * the REAL census rather than over strings written here, because strings written here are what
   * the docblock already was.
   */
  it('applies chunk by chunk to the interpolated sentences the census now holds', () => {
    const interpolated = copy.filter((site) => site.text.includes('{}'));
    expect(interpolated.length).toBeGreaterThan(120);

    // The honest form, as the census actually stores it: literal runs, the value absent.
    const honest = copy.filter((site) =>
      site.chunks.some((chunk) => /\btry again in\s*$/.test(chunk)),
    );
    expect(
      honest.map(show),
      '`Try again in ${humanRetryAfter(wait)}.` is the one legal way to state a wait, and the ' +
        'census must be holding at least one of them for this rule to have been exercised on the ' +
        'shape it exists to leave standing.',
    ).not.toEqual([]);
    for (const site of honest) {
      for (const chunk of site.chunks) expect(promisesATime(chunk)).toBe(false);
    }

    // And the shape that must NOT pass, written as an interpolation. Before this round the census
    // recorded no such site at all, so this sentence could be added to any web file and the rule
    // above would not have seen it.
    const planted = ['too many attempts. try again in about an hour, ', '.'];
    expect(planted.some(promisesATime)).toBe(true);
  });
});

/**
 * THE UNASSERTED BUDGET.
 *
 * WHAT A NUMBER HERE MEANS: how many distinct sentences in that file no test anywhere in this
 * repository names. "Names" is measured in `helpers/userFacingCopy.ts` — a sixteen-character run
 * of the sentence appearing inside a string or regex literal of some test — so `/could not be
 * reached/i` counts and a passing mention in a comment does not.
 *
 * WHY PER-FILE COUNTS AND NOT A LIST OF SENTENCES. This is the whole design. A list would have to
 * be edited every time anybody rewords anything, which makes it the first kind of guard — the kind
 * that gets bulk-re-blessed and stops meaning anything. A COUNT is invariant under rewording: edit
 * an unasserted sentence and the count is unchanged; edit an asserted one and the count rises,
 * which is correct, because you have just changed what the software says to a person and no test
 * noticed. The failure message tells you which sentence it was.
 *
 * THESE NUMBERS MAY GO DOWN AND MAY NOT GO UP. Down is the point. A file at 0 has every sentence
 * it says named by some test; deleting the entry is then the last step of the work.
 *
 * WHAT THE NUMBERS ARE NOT. They are not a measure of how good the tests are — naming a sentence
 * is not the same as checking it is true in the state that produced it, and the seven findings
 * this round is about were all the second thing. They are a measure of how much copy is
 * completely unlooked-at, which is where every one of those findings was hiding.
 *
 * `templates/slots.ts` is 75 of these on its own: the writing desk's slot labels and hints, a
 * flat table of static strings. It is left as one entry rather than broken up because copying 75
 * strings into a test file would move the number without looking at anything — the useful test
 * for that file is that every slot a template references has a label and a hint, which is a
 * different test than this one is asking for.
 *
 * THE ACCIDENTAL CREDIT, MEASURED 2026-08-13, AND WHY A NUMBER HERE GOING DOWN IS NOT PROOF.
 *
 * `isAsserted` credits a sentence when any SIXTEEN-CHARACTER run of it appears inside any string
 * or regex literal in any test file. Sixteen characters of ordinary English is not evidence that
 * anybody looked at the sentence, and on this corpus it demonstrably is not:
 *
 *   `seed/load.ts`'s "duplicate funder id in the seed corpus." and "duplicate program id in the
 *   seed corpus." were both scored ASSERTED. No test named either. The run that credited them was
 *   " the seed corpus", which occurs in `seed/funderVoice.test.ts` inside
 *   `/\bseed (?:record|corpus|import)\b/` — a detector for maintainer notes in a funder-voice
 *   field. That regex was added on 2026-08-13 for an unrelated defect, and it silently retired two
 *   entries of this file's debt on its way past.
 *
 * The effect is not confined to those two. Measured over the whole census on 2026-08-13: of 1,249
 * sites scored asserted, 613 are credited by a longest single-literal run SHORTER THAN TWENTY
 * CHARACTERS, and 745 by a run covering less than half the sentence. So a budget that falls is not
 * by itself proof that the sentences it counted are now looked at — it may only mean somebody
 * elsewhere wrote a literal that happens to share a fragment.
 *
 * IT IS LEFT AS IT IS, DELIBERATELY, AND WHAT TO DO INSTEAD. Raising the bar to a half-sentence
 * match would re-score 745 sites at once and force a re-baseline of some seventy budget entries —
 * a bulk re-blessing, which is the exact failure mode the top of this file exists to avoid, and
 * which would drown the real signal for a round or more. The bar is also genuinely hard to set:
 * a test asserting `/could not be read/i` against "Your saved profile could not be read. Re-save
 * it from the profile editor." IS looking at that sentence, and covers 27 of its 71 characters.
 * The rule this round adopts instead is procedural and costs nothing: WHEN A BUDGET FALLS AND
 * NOBODY IN THE ROUND CLAIMS THE WORK, CHECK WHAT CREDITED IT BEFORE LOWERING THE NUMBER — and if
 * the credit is an accident, write the assertion rather than bank the discount. That is what
 * `seed/loadCorpus.test.ts` is; it took the entry to a genuine 0.
 *
 * WHY THE TOTAL WENT UP ON 2026-08-12 WITHOUT ANYBODY WRITING A SENTENCE. It went from 335 to 413,
 * and every one of the additions was already shipping — 84 of them measured against abffd25,
 * before this tree moved under the measurement. The census could not see them: an interpolated
 * sentence was classified as a CSS selector by the census's own placeholder, and a JSX attribute
 * whose name was not on a list written in advance was discarded unread. Both are repaired in
 * `helpers/userFacingCopy.ts`, so "335 of 1,320" was never the debt — it was the debt minus the
 * part the counter could not see, which is the worst kind of number to have quoted. The headline
 * below now says what was measured after the counter was fixed.
 */
const UNASSERTED_BUDGET: ReadonlyMap<string, number> = new Map(
  Object.entries({
    'packages/core/src/maidenhead.ts': 5,
    'packages/server/src/api/adminUsersRouter.ts': 3,
    'packages/server/src/api/applications.ts': 2,
    'packages/server/src/api/calendarRouter.ts': 1,
    'packages/server/src/api/channelRouter.ts': 1,
    'packages/server/src/api/exports.ts': 1,
    'packages/server/src/api/inboxRouter.ts': 2,
    'packages/server/src/api/profileRouter.ts': 2,
    'packages/server/src/api/programDetail.ts': 1,
    'packages/server/src/api/programsRouter.ts': 1,
    'packages/server/src/api/prompts.ts': 2,
    'packages/server/src/api/sourcesRouter.ts': 4,
    'packages/server/src/api/templates.ts': 2,
    'packages/server/src/api/verifyRouter.ts': 1,
    'packages/server/src/api/watchRouter.ts': 2,
    'packages/server/src/auth/middleware.ts': 1,
    'packages/server/src/config.ts': 7,
    'packages/server/src/db/repositories/applications.ts': 1,
    'packages/server/src/fetcher/index.ts': 1,
    'packages/server/src/review/index.ts': 1,
    // 4 until 2026-08-13, then deleted at 0. `seed/loadCorpus.test.ts` now reads all four of the
    // loader's refusals in the state that produces each one. Two of the four had been scored as
    // asserted since the day before WITHOUT ANY TEST NAMING THEM — see THE ACCIDENTAL CREDIT below.
    'packages/server/src/sources/ardc-award-tables.ts': 1,
    'packages/server/src/sources/arrl-news-rss.ts': 1,
    'packages/server/src/sources/arrl-pages.ts': 1,
    'packages/server/src/sources/grants-gov-extract.ts': 1,
    'packages/server/src/sources/grants-gov-federal.ts': 1,
    'packages/server/src/sources/manual-tier-d.ts': 1,
    'packages/server/src/sources/nsf-awards.ts': 1,
    'packages/server/src/sources/nsf-funding-rss.ts': 1,
    'packages/server/src/sources/tier-c-b.ts': 1,
    // 75 until 2026-08-13. `prose/facts.test.ts` now fills the budget skeleton through the real
    // slot pipeline and reads `**Total project cost**` back out of the draft, which is the hint at
    // slots.ts:54 in the state a student sees it — one sentence off the debt, so the budget moves.
    'packages/server/src/templates/slots.ts': 74,
    'packages/web/src/api/client.ts': 1,
    'packages/web/src/App.tsx': 1,
    'packages/web/src/components/AgendaList.tsx': 10,
    'packages/web/src/components/AppShell.tsx': 2,
    'packages/web/src/components/CallsignLookup.tsx': 40,
    'packages/web/src/components/CompletenessMeter.tsx': 1,
    'packages/web/src/components/CopyPromptButton.tsx': 3,
    'packages/web/src/components/DisputedPanel.tsx': 2,
    'packages/web/src/components/DraftGaps.tsx': 1,
    // 6 until 2026-08-13: the panel's opening line is now asserted, having been rewritten when the
    // list stopped carrying values quoted from shipped templates ("these are the ones this draft
    // asserts in your own words").
    'packages/web/src/components/FactChecklist.tsx': 5,
    'packages/web/src/components/FilterPanel.tsx': 3,
    'packages/web/src/components/IneligibilityDrawer.tsx': 7,
    'packages/web/src/components/MonthGrid.tsx': 4,
    'packages/web/src/components/NavDrawer.tsx': 2,
    'packages/web/src/components/ProgramTable.tsx': 1,
    'packages/web/src/components/ProseCheckPanel.tsx': 5,
    'packages/web/src/components/ProvenanceTable.tsx': 6,
    'packages/web/src/components/SlotForm.tsx': 2,
    'packages/web/src/components/SourceLink.tsx': 4,
    'packages/web/src/components/StatusPill.tsx': 3,
    'packages/web/src/components/TrustBadge.tsx': 2,
    'packages/web/src/components/VerdictBadge.tsx': 3,
    'packages/web/src/lib/callsignFill.ts': 1,
    'packages/web/src/lib/contrast.ts': 1,
    'packages/web/src/lib/filterState.ts': 13,
    'packages/web/src/lib/profileFields.ts': 13,
    'packages/web/src/lib/safety.ts': 1,
    'packages/web/src/routes/Admin.tsx': 15,
    // 10 until 2026-08-13, then 9. "Start a new draft or open an existing one." is now read by a
    // test — `Applications.test.tsx`'s "offers the section buttons switched off while no draft is
    // open" — because that sentence became load-bearing: the three template groups are disabled
    // while no draft exists, and it is the sentence that says why. An off control with nothing
    // explaining it would be the same silence in a different shape, so the test asserts the
    // control and the sentence together. One sentence off the debt, so the budget moves.
    'packages/web/src/routes/Applications.tsx': 9,
    'packages/web/src/routes/Browse.tsx': 4,
    'packages/web/src/routes/Calendar.tsx': 9,
    'packages/web/src/routes/Enroll.tsx': 2,
    // 11 until 2026-08-13, then 10. The export controls were rebuilt: five `<a download>` anchors
    // became buttons that read the response, so the screen now says what landed on disk, what was
    // refused, and — per control, in that control's own words — what "nothing matched" means. Every
    // one of those sentences is read by a test that renders the state producing it
    // (`routes/Exports.test.tsx`), including the no-profile warning that now replaces two live
    // controls. The one sentence that carried this entry down is the profile refusal's second half;
    // nothing here was banked from another round's literals — the empty-export copy was reworded
    // off "nothing was saved" precisely BECAUSE asserting that phrase credited two of
    // `routes/Watchlist.tsx`'s sentences by accident, which is the discount this file's header
    // forbids taking.
    'packages/web/src/routes/Exports.tsx': 10,
    'packages/web/src/routes/FirstRun.tsx': 4,
    // 12 until 2026-08-13, then 10. The queue's deadline-note line and its edit panel were rebuilt
    // — the `RECUR` directive is no longer printed at a member and no longer pre-filled into the
    // box an administrator is invited to rewrite — and every sentence on the new panel is read by
    // a test that renders the state producing it. Two of the sentences already there ("Deadline
    // note:" and the edit hint) were rewritten in the same pass and are now asserted too.
    'packages/web/src/routes/Inbox.tsx': 10,
    'packages/web/src/routes/Login.tsx': 3,
    'packages/web/src/routes/Opportunity.tsx': 7,
    'packages/web/src/routes/Profile.tsx': 16,
    'packages/web/src/routes/Sources.tsx': 8,
    'packages/web/src/routes/Templates.tsx': 6,
    'packages/web/src/routes/Watchlist.tsx': 24,
  }),
);

describe('sentences no test names', () => {
  it('are not added to a file that had none, and do not grow in a file that had some', () => {
    const byFile = new Map<string, CopySite[]>();
    for (const site of unasserted) {
      const list = byFile.get(site.file);
      if (list === undefined) byFile.set(site.file, [site]);
      else list.push(site);
    }

    const grown: string[] = [];
    for (const [file, sites] of byFile) {
      const allowed = UNASSERTED_BUDGET.get(file) ?? 0;
      if (sites.length <= allowed) continue;
      grown.push(
        `${file}: ${String(sites.length)} unasserted, budget ${String(allowed)}\n` +
          sites.map((site) => `      ${show(site)}`).join('\n'),
      );
    }

    expect(
      grown,
      'A sentence a person reads is named by no test in this repository. Every defect four ' +
        'rounds of review have found here was a sentence that was false in the state that ' +
        'produced it, and almost none of them were asserted anywhere. Write an assertion that ' +
        'renders the state and reads the words — not a snapshot of the string — or, if the ' +
        'sentence is genuinely unreachable or genuinely static, raise the budget in ' +
        'userFacingCopyContract.test.ts and say in the commit why looking at it is not worth it.',
    ).toEqual([]);
  });

  /**
   * The ratchet's other tooth. Without this, a budget entry outlives the work that earned it: the
   * file gets covered, the number stays, and the next unasserted sentence added to it is free.
   */
  it('leave no slack behind once a file is covered', () => {
    const counted = new Map<string, number>();
    for (const site of unasserted) counted.set(site.file, (counted.get(site.file) ?? 0) + 1);

    const slack: string[] = [];
    for (const [file, allowed] of UNASSERTED_BUDGET) {
      const actual = counted.get(file) ?? 0;
      if (actual < allowed) slack.push(`${file}: budget ${String(allowed)}, actually ${String(actual)}`);
    }

    expect(
      slack,
      'These budgets are larger than the debt they describe. Lower them to what is measured (or ' +
        'delete the entry at 0): a budget with slack in it is a place the next unasserted ' +
        'sentence lands for free.',
    ).toEqual([]);
  });

  /**
   * The headline, asserted rather than described, so that the figure quoted in the round's notes
   * cannot drift from the figure the suite measures. The bound is one-sided on purpose: driving it
   * down is the work, and it must not need an edit here to do so.
   */
  /**
   * The headline, asserted rather than described, so the figure quoted in the round's notes cannot
   * drift from the figure the suite measures — and so that the previous headline, "335 of 1,320",
   * cannot be repeated now that it is known to have been 335 of the 1,320 the counter could see.
   */
  it('number 413 of 1,541 today, and that ceiling only falls', () => {
    expect(copy.length).toBeGreaterThanOrEqual(1541);
    expect(unasserted.length).toBeLessThanOrEqual(413);
  });
});

/**
 * THE SWEEP IS INSTALLED.
 *
 * `e2e/renderedHoles.ts` arms a MutationObserver that refuses a rendered `undefined` / `null` /
 * `NaN` / `Infinity` / `[object Object]` in any state the page passes through — the round-two
 * "FCC record for undefined" defect, caught in the one place where the words on screen were
 * produced by the real server's real answer rather than by a stub the test wrote itself.
 *
 * A spec opts in by importing it, which means a spec can be written that does not. This fails by
 * name when one is, for the same reason `contactUrlEntryPointContract.test.ts` enumerates entry
 * points rather than fixing today's two scripts: the defect is structural, and the next spec is
 * written by somebody who has not read this file.
 */
describe('the browser sweep for rendered holes', () => {
  it('is armed by every spec that drives a page', () => {
    const e2eDir = path.join(REPO_ROOT, 'e2e');
    const specs = readdirSync(e2eDir).filter((name) => name.endsWith('.spec.ts'));
    expect(specs.length, 'no e2e specs were found — the walk is looking in the wrong place').toBeGreaterThan(4);

    const missing: string[] = [];
    for (const name of specs) {
      const source = readFileSync(path.join(e2eDir, name), 'utf8');
      // A spec that never navigates cannot render anything. `api.spec.ts` drives the HTTP API
      // alone and is the one such file today.
      if (!source.includes('.goto(')) continue;
      if (!source.includes("from './renderedHoles.js'")) missing.push(`e2e/${name}`);
    }

    expect(
      missing,
      'This spec navigates a browser and does not arm the rendered-hole sweep. Add ' +
        "`import { installRenderedHoleSweep } from './renderedHoles.js';` and call it at module " +
        'top level, or — for a spec that opens its own contexts in `beforeAll` — call ' +
        '`armRenderedHoleSweep(context)` and `expectNoRenderedHoles(page)`.',
    ).toEqual([]);
  });
});
