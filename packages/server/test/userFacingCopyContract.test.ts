import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectAssertionCorpus,
  collectUserFacingCopy,
  isAsserted,
  REPO_ROOT,
  type CopySite,
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
 * only guards the census itself against going quiet):
 *
 *   1. THE ONE-NUMBER RULE. No sentence may say when to come back. The only statement of when in
 *      this product is `retryAfterSec`, rendered through `lib/retryAfter.ts`. Rewording a refusal
 *      cannot trip this; inventing a wait is the only thing that can. There is no allowlist,
 *      because after 2026-08-12 there is nothing to allow.
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
 */

const copy = collectUserFacingCopy();
const corpus = collectAssertionCorpus();
const unasserted = copy.filter((site) => !isAsserted(site, corpus));

function show(site: CopySite): string {
  return `${site.file}:${String(site.line)} [${site.kind}] ${site.text.slice(0, 140)}`;
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
 * WHY THE INTERPOLATED FORM PASSES. `` `Try again in ${humanRetryAfter(wait)}.` `` has literal runs
 * "Try again in " and "." — a retry cue and no duration, because the duration is a value. That is
 * the shape this rule exists to leave standing, and it is the only one.
 */
const COME_BACK_LATER = /\btry again\b|\bcome back\b|\bretry\b|\bwait\b|\bcheck back\b/;
const HOW_LONG =
  /\bshortly\b|\bin a (?:moment|minute|while|bit|sec)\b|\ba (?:few|couple of) (?:seconds|minutes|hours|days)\b|\bin about\b|\b\d+\s*(?:second|minute|hour|day)s?\b|\ban hour\b|\ba minute\b|\bsoon\b|\bpresently\b/;

describe('no sentence may say when to come back', () => {
  it('states the wait only as the number the system computed', () => {
    const promises: string[] = [];
    for (const site of copy) {
      for (const chunk of site.chunks) {
        if (COME_BACK_LATER.test(chunk) && HOW_LONG.test(chunk)) promises.push(show(site));
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
   * The rule demonstrated firing, in both directions. A guard nobody has watched work is a guard
   * that may match nothing at all — the failure `contactUrlEntryPointContract.test.ts` was walked
   * past three separate ways while green.
   */
  it('is a rule about promises, not about the word "minutes"', () => {
    const violates = (text: string): boolean => COME_BACK_LATER.test(text) && HOW_LONG.test(text);

    // The five sentences that shipped.
    expect(violates('you have used your verification allowance for this hour. try again shortly.')).toBe(true);
    expect(violates('you already verified this recently. try again in about an hour')).toBe(true);
    expect(violates('too many attempts. wait a minute and try again.')).toBe(true);
    expect(violates('it is unreadable for a few minutes. try again shortly.')).toBe(true);
    expect(violates('try again in 15 minutes.')).toBe(true);

    // The forms that are honest, and must stay legal.
    expect(violates('try again in ')).toBe(false); // …${humanRetryAfter(wait)}.
    expect(violates('too many sign-in attempts. try again later.')).toBe(false);
    expect(violates('you have used every verification in your hourly allowance.')).toBe(false);
    expect(violates('deadlines within 30 days of today')).toBe(false);
    expect(violates('expect a decision in 60 to 90 days.')).toBe(false);
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
 * `templates/slots.ts` is 75 of the 335 on its own: the writing desk's slot labels and hints, a
 * flat table of static strings. It is left as one entry rather than broken up because copying 75
 * strings into a test file would move the number without looking at anything — the useful test
 * for that file is that every slot a template references has a label and a hint, which is a
 * different test than this one is asking for.
 */
const UNASSERTED_BUDGET: ReadonlyMap<string, number> = new Map(
  Object.entries({
    'packages/core/src/maidenhead.ts': 1,
    'packages/server/src/api/adminUsersRouter.ts': 2,
    'packages/server/src/api/applications.ts': 2,
    'packages/server/src/api/calendarRouter.ts': 1,
    'packages/server/src/api/channelRouter.ts': 1,
    'packages/server/src/api/exports.ts': 1,
    'packages/server/src/api/prompts.ts': 2,
    'packages/server/src/api/sourcesRouter.ts': 2,
    'packages/server/src/api/templates.ts': 1,
    'packages/server/src/api/watchRouter.ts': 1,
    'packages/server/src/config.ts': 6,
    'packages/server/src/db/repositories/applications.ts': 1,
    'packages/server/src/seed/load.ts': 2,
    'packages/server/src/sources/ardc-award-tables.ts': 1,
    'packages/server/src/sources/arrl-news-rss.ts': 1,
    'packages/server/src/sources/arrl-pages.ts': 1,
    'packages/server/src/sources/grants-gov-extract.ts': 1,
    'packages/server/src/sources/grants-gov-federal.ts': 1,
    'packages/server/src/sources/manual-tier-d.ts': 1,
    'packages/server/src/sources/nsf-awards.ts': 1,
    'packages/server/src/sources/nsf-funding-rss.ts': 1,
    'packages/server/src/sources/tier-c-b.ts': 1,
    'packages/server/src/templates/slots.ts': 75,
    'packages/web/src/App.tsx': 1,
    'packages/web/src/api/client.ts': 1,
    'packages/web/src/components/AgendaList.tsx': 8,
    'packages/web/src/components/AppShell.tsx': 2,
    'packages/web/src/components/CallsignLookup.tsx': 34,
    'packages/web/src/components/CopyPromptButton.tsx': 2,
    'packages/web/src/components/DisputedPanel.tsx': 2,
    'packages/web/src/components/DraftGaps.tsx': 1,
    'packages/web/src/components/FactChecklist.tsx': 6,
    'packages/web/src/components/FilterPanel.tsx': 3,
    'packages/web/src/components/IneligibilityDrawer.tsx': 4,
    'packages/web/src/components/MonthGrid.tsx': 3,
    'packages/web/src/components/NavDrawer.tsx': 2,
    'packages/web/src/components/ProgramTable.tsx': 1,
    'packages/web/src/components/ProseCheckPanel.tsx': 5,
    'packages/web/src/components/ProvenanceTable.tsx': 6,
    'packages/web/src/components/SlotForm.tsx': 2,
    'packages/web/src/components/SourceLink.tsx': 3,
    'packages/web/src/components/StatusPill.tsx': 3,
    'packages/web/src/components/VerdictBadge.tsx': 2,
    'packages/web/src/lib/callsignFill.ts': 1,
    'packages/web/src/lib/filterState.ts': 13,
    'packages/web/src/lib/profileFields.ts': 13,
    'packages/web/src/lib/safety.ts': 1,
    'packages/web/src/routes/Admin.tsx': 12,
    'packages/web/src/routes/Applications.tsx': 7,
    'packages/web/src/routes/Browse.tsx': 7,
    'packages/web/src/routes/Calendar.tsx': 14,
    'packages/web/src/routes/Enroll.tsx': 1,
    'packages/web/src/routes/Exports.tsx': 11,
    'packages/web/src/routes/FirstRun.tsx': 3,
    'packages/web/src/routes/Inbox.tsx': 9,
    'packages/web/src/routes/Login.tsx': 2,
    'packages/web/src/routes/Opportunity.tsx': 9,
    'packages/web/src/routes/Profile.tsx': 11,
    'packages/web/src/routes/Sources.tsx': 7,
    'packages/web/src/routes/Templates.tsx': 4,
    'packages/web/src/routes/Watchlist.tsx': 12,
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
  it('number 335 of 1,320 today, and that ceiling only falls', () => {
    expect(copy.length).toBeGreaterThanOrEqual(1320);
    expect(unasserted.length).toBeLessThanOrEqual(335);
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
