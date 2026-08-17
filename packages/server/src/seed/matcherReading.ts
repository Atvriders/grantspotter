/**
 * WHAT THE MATCHER READS OUT OF A DISPLAYED SENTENCE — ASKED OF THE MATCHER, NOT REIMPLEMENTED.
 *
 * `Constraint.rawText` is the sentence printed under "ONE REQUIREMENT, AS THE FUNDER WROTE IT". It
 * is the display half of a constraint, and splitting it out of `constraints` (see
 * `shippedValues.ts`) is what lets a corrected quotation reach a running deployment.
 *
 * THAT SPLIT IS ONLY SAFE IF SOMETHING FENCES IT, BECAUSE `rawText` IS NOT INERT. It was believed
 * to be — "it is read by `hasFunderWording`, whose entire body is `rawText.trim() !== ''`, and
 * rendered" — and that is false. `matchProgram` threads it into `evaluateConstraint`, which asks
 * `funderOpenedTheList(rawText)`: did the funder say the list they just gave is illustrative
 * rather than complete? Two axes act on the answer. `field_of_study` widens its list; `ham_activity`
 * turns a refusal into `unknown`. MEASURED over the shipped corpus and the seven shipped profiles,
 * 1,001 (profile, programme) pairs: erasing every `rawText` moves 16 answers across 4 programmes,
 * and appending one open-list marker to every `rawText` moves 15 across 6. A rewrite that changed
 * that reading WOULD change who is told they are eligible.
 *
 * So the reconcile may not assume the sentence is display-only. It has to check, per correction,
 * the way `deadline.note` is checked: that note is prose which also carries the `RECUR` directive
 * and a funder-stated window, so `meaningOf` blanks the prose and compares the PARSE. This file is
 * the same move for `rawText`: blank the sentence, compare the READING.
 *
 * WHY IT IS A PROBE AND NOT A COPY OF THE REGEXES. `funderOpenedTheList` is private to
 * `matcher.ts`, and it should stay that way — CONTRACT §4 fixes the exported matcher surface, and
 * this package must not grow a second, drifting copy of the open-list vocabulary. A copy that fell
 * one idiom behind the matcher would let the reconcile rewrite a sentence it believed inert while
 * the matcher read it as an opening: a silent verdict change on a live deployment, which is the
 * exact failure class the reconcile exists to prevent. So the reading is taken FROM the matcher, by
 * asking it a question whose only possible cause is the open-list signal, through the exported
 * `evaluateConstraint`. The probe cannot drift, because it is not a description of the matcher —
 * it is the matcher.
 *
 * `matcherReading.test.ts` holds the two properties this rests on: the probe answers a table of
 * sentences the way the matcher's documented vocabulary says it must (so it is sensitive, not
 * stuck), and — the one that matters — replacing EVERY `rawText` in the shipped corpus with a
 * neutral sentence carrying the same reading moves no answer, for any shipped profile.
 */
import type { ConstraintSpec, Profile } from '@grantspotter/core';
import { evaluateConstraint } from '@grantspotter/core';

/**
 * A field list of exactly one made-up subject, so `readFieldRequirement` sees one INFORMATIVE
 * alternative. That matters: a spec naming no field at all is unrestricted, and the matcher
 * deliberately drops the widening there ("a widening opens a list, and with no list there is
 * nothing to open"), which would make the probe answer `false` for every sentence.
 */
const PROBE_SPEC: ConstraintSpec = {
  axis: 'field_of_study',
  fields: ['Aardvarkology'],
  excludedFields: [],
};

/**
 * An applicant studying something else, and NOTHING ELSE FILLED IN. `field_of_study` is the only
 * axis `PROBE_SPEC` engages, and this profile answers its question — so the result is `fail` when
 * the list is closed and is not `fail` when the funder opened it. No other axis can reach in.
 */
const PROBE_PROFILE: Profile = { kind: 'student', fieldOfStudy: 'Basket Weaving' };

/**
 * Fixed, because the probe must not depend on a clock. `field_of_study` reads no date; passing a
 * constant makes that explicit and keeps the reading reproducible across boots.
 */
const PROBE_NOW = '2026-01-01T00:00:00.000Z';

/**
 * Everything `matcher.ts` derives from a `rawText`, as a value that can be compared.
 *
 * Today that is one boolean. It is a record rather than a bare `boolean` so that the day the
 * matcher learns to read a second signal out of the sentence, this type gains a field and every
 * `meaningOf` comparison in `corrections.ts` starts fencing it without another edit.
 */
export interface MatcherReading {
  /** `funderOpenedTheList(rawText)` — "the list I just gave is illustrative, not complete". */
  openedTheList: boolean;
}

export function matcherReadingOf(rawText: string): MatcherReading {
  // A closed list refuses this applicant outright. Anything other than `fail` — the widened
  // `pass`, or an `unknown` a future matcher might prefer — means the sentence opened the list.
  return {
    openedTheList: evaluateConstraint(PROBE_SPEC, PROBE_PROFILE, PROBE_NOW, rawText).status !== 'fail',
  };
}
