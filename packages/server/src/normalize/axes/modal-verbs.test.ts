// `preference.ts`'s MODAL VOCABULARY — "should" is a recommendation, "must" is a requirement.
//
// THE DEFECT. `isPreferenceText` knew the preference NOUNS ("preference", "preferably",
// "encouraged") and none of the modal verbs, so a funder who wrote its recommendation the ordinary
// English way had it published as a hard bar. MARCO and York both say
//
//     "Applicants SHOULD be able to describe how they have engaged in volunteer and/or public
//      service activities making use of Amateur Radio."
//
// and `spec.activityKinds` is an allow-list the matcher enforces, so both awards came out
// `ineligible` on `ham_activity` for EVERY licensed individual profile. Neither award states any
// other ham-activity rule; the bar was built entirely out of the word "should".
//
// THE TWO OPPOSITE FAILURES THIS FILE GUARDS, because this classifier is shared by all 13 axes and
// has been broken in both directions inside the same month:
//
//   OVER-SOFTENING erases a requirement, and `matcher.ts` never excludes on a soft constraint, so
//   the applicant gets no signal at all. Holt — "Any active Amateur Radio License Class for two
//   years, preference for General Class" — published NO licence floor and was shown to an
//   unlicensed applicant. Seven constraints were restored to hard by that fix and none of them may
//   move here.
//
//   OVER-HARDENING publishes a preference as a bar. CTRI's "if no suitable applicant is
//   identified, applicants from all regions will be considered" — the funder widening its own
//   eligibility — excluded every applicant outside New England.
//
// So a recommendation modal softens THE CLAUSE THAT CARRIES IT, never a neighbouring `must`. The
// mixed form is common in this corpus and the North Texas entry is the real one.
//
// Kept in its own file rather than appended to part1.test.ts / part2.test.ts, which
// concurrently-running agents are editing for other axes — the same reason preference-scope.test.ts
// and license.test.ts exist.
import type { Constraint, Program, StudentProfile, Verdict } from '@grantspotter/core';
import { matchAll } from '@grantspotter/core';
import { beforeAll, describe, expect, it } from 'vitest';
// The offline corpus loader: every committed REAL capture, parsed by its own source module and
// normalized exactly as the crawler does. Shared with the profiler and with
// licenseFloorContract.test.ts rather than reimplemented, so "the corpus" cannot mean two things.
import { PROFILE_NOW_ISO, PROFILES, loadCorpus } from '../../../../../scripts/profile-corpus.js';
import { extractLicense } from './license.js';
import {
  cascadeRank,
  isPreferenceText,
  makeConstraint,
  preferenceScope,
  requirementText,
} from './preference.js';

let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

/**
 * THE FIXTURE LOAD IS SETUP FOR THE WHOLE FILE, NOT PART OF ANY TEST'S TIME BUDGET. `loadCorpus`
 * re-parses every committed fixture — MEASURED at 2,374 ms on two cores on 2026-08-12 — and
 * without this hook that cost was charged to whichever `it` reached the corpus first, inside its
 * 5,000 ms default. `axes/spec-vs-sentence.test.ts` carries the measurement and the argument for
 * why the answer is a hook rather than a larger `testTimeout`; it is the file that went red first,
 * and every file in this list was sitting at about half the budget behind it.
 */
beforeAll(async () => {
  await corpus();
}, 120_000);

function programNamed(programs: Program[], needle: string): Program {
  const hit = programs.find((p) => p.name.includes(needle));
  if (hit === undefined) throw new Error(`no program whose name contains "${needle}"`);
  return hit;
}

function axisOf(program: Program, axis: string): Constraint[] {
  return program.constraints.filter((c) => c.spec.axis === axis);
}

/** A licensed individual — the population both awards were hidden from. */
const LICENSED_INDIVIDUAL =
  PROFILES.find((p) => p.key === 'ee-undergrad') ??
  (((): never => {
    throw new Error('the ee-undergrad profile is missing from scripts/profile-corpus.ts');
  })());

function verdictFor(programs: Program[], program: Program): Verdict {
  const verdict = matchAll(LICENSED_INDIVIDUAL.profile, programs, PROFILE_NOW_ISO).get(program.id);
  if (verdict === undefined) throw new Error(`no verdict for ${program.name}`);
  return verdict;
}

// ---------------------------------------------------------------- the two reported awards

describe('MARCO and York: a recommendation is not a requirement', () => {
  it('publishes their ham_activity constraint SOFT, from the real ARRL capture', async () => {
    const { programs } = await corpus();
    for (const needle of ['(MARCO) Scholarship', 'John C. York']) {
      const program = programNamed(programs, needle);
      const activity = axisOf(program, 'ham_activity');
      // The award does state an activity — the funder wants to read about it — so the constraint
      // is still published, with its kinds intact. It is the HARDNESS that was wrong.
      expect(activity, needle).toHaveLength(1);
      expect(activity[0].rawText, needle).toMatch(/should/i);
      expect(activity[0].spec, needle).toMatchObject({ activityKinds: ['public_service'] });
      expect(activity[0].hard, `${needle}: "should" is a recommendation, not a bar`).toBe(false);
      // Not a cascade — no fallback sentence anywhere in it — so it ranks as a primary preference.
      expect(activity[0].fallbackRank, needle).toBe(0);
    }
  });

  it('makes both reachable by a licensed individual applicant', async () => {
    const { programs } = await corpus();
    for (const needle of ['(MARCO) Scholarship', 'John C. York']) {
      const program = programNamed(programs, needle);
      const verdict = verdictFor(programs, program);
      // The whole point: before this fix both were `ineligible`, and the ONLY reason was the
      // ham_activity constraint built out of "should". This is a claim about REACHABILITY, so it
      // is asserted as one — the axis this file owns must not produce a refusal.
      expect(verdict.kind, `${needle}: ${JSON.stringify(verdict)}`).not.toBe('ineligible');
      if (verdict.kind === 'ineligible') {
        expect(verdict.reasons.map((r) => r.spec.axis)).not.toContain('ham_activity');
      }
      // ...and what it IS, is a different axis's answer to a different question. This applicant
      // studies Electrical Engineering and both awards are for the healing arts, under a sentence
      // that opens its own list ("including but not limited to"). Round eight stopped that reading
      // as a yes: it is the funder declining to close the list, which is `unknown` and not a bar.
      // Nothing here is a `ham_activity` verdict either way.
      expect(verdict.kind, needle).toBe('unknown');
      if (verdict.kind === 'unknown') expect(verdict.missingProfileFields, needle).toEqual([]);
    }
  });

  it('is the word "should" doing it, not anything else in the sentence', () => {
    // The same clause with the modal removed is a plain requirement, and stays hard. This is what
    // keeps the test from passing for some unrelated reason if the classifier is later widened.
    const recommended =
      'Applicants should be able to describe how they have engaged in volunteer and/or public ' +
      'service activities making use of Amateur Radio.';
    const required =
      'Applicants must be able to describe how they have engaged in volunteer and/or public ' +
      'service activities making use of Amateur Radio.';
    expect(isPreferenceText(recommended)).toBe(true);
    expect(isPreferenceText(required)).toBe(false);
  });
});

// ---------------------------------------------------------------- the vocabulary

describe('the modal vocabulary, as RFC 2119 spells it and these pages use it', () => {
  it('reads should / may / might / ought to as recommendations', () => {
    for (const text of [
      'Applicants should be active in public service.',
      'Applicants may apply while still in high school.',
      'Applicants might hold a General class license.',
      'Applicants ought to be members of a local club.',
      // The applicant named by a pronoun, which is how a page addressing the reader writes it.
      'You should be able to describe your on-the-air activity.',
    ]) {
      expect(isPreferenceText(text), text).toBe(true);
    }
  });

  it('reads must / shall / required as requirements', () => {
    for (const text of [
      'Applicants must be active in public service.',
      'Applicants shall hold a General class license.',
      'Applicants are required to be members of a local club.',
    ]) {
      expect(isPreferenceText(text), text).toBe(false);
    }
  });

  it('does NOT read a negated or restricted "may" as permission', () => {
    // "may not" / "may only" is a prohibition or a narrowing, not an option. Softening these would
    // publish a bar as an option, which is the recoverable direction — but they are not recommendations
    // and calling them one would be wrong about the English.
    for (const text of [
      'Applicants may not be related to a member of the board of directors.',
      'Applicants may only receive this scholarship once.',
      'Applicants may never have held a previous ARRL scholarship.',
    ]) {
      expect(isPreferenceText(text), text).toBe(false);
    }
  });

  it('does NOT read the NOUN "recommendation" as recommendation language', () => {
    // The single most dangerous string in this corpus for this fix: eight hard constraints across
    // six programs carry "letter(s) of recommendation" or "counselor or teacher recommendations",
    // where it names a document the funder REQUIRES. A `recommend\w*` stem would soften all of
    // them, including ARDC's — the largest programme in the corpus.
    for (const text of [
      'Three letters of recommendation must be provided from teachers, local radio club officers ' +
        "and/or others with familiarity with the applicant's character.",
      'Applicant must be performing at a high academic level or an at-risk youth with at least ' +
        'two counselor or teacher recommendations as to how and why they have turned their lives ' +
        'around.',
      'A number of scholarships require additional documents, such as a letter of recommendation ' +
        'from a sitting Officer of an ARRL-affiliated club.',
    ]) {
      expect(isPreferenceText(text), text).toBe(false);
    }
  });

  it('requires the modal to be talking about the APPLICANT', () => {
    // QCWA, verbatim from its `License Requirement` field. The subject is the APPLICATION and
    // "licensed radio amateurs" is an oblique phrase naming who does the requesting — the "should"
    // does not make the licence optional. Softening this deletes QCWA's licence floor outright,
    // which licenseFloorContract.test.ts RULE A and RULE B both catch.
    const qcwa =
      'Applications should be requested by interested licensed radio amateurs on or after ' +
      'October 31 of each year from the ARRL Foundation Committee.';
    expect(isPreferenceText(qcwa)).toBe(false);
    const licence = extractLicense({
      sourceId: 'qcwa',
      externalKey: 'k',
      name: 'n',
      rawFields: { 'License Requirement': qcwa },
      sourceUrl: 'https://example.test/x',
      rawText: qcwa,
    });
    expect(licence).toHaveLength(1);
    expect(licence[0].hard).toBe(true);
    expect(licence[0].spec).toMatchObject({ axis: 'license', licenseMin: 'TECH' });
    // Administrative "may" with a non-applicant subject is left alone for the same reason.
    expect(isPreferenceText('The committee may award more than one scholarship per year.')).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------- the mixed form

describe('the mixed form: a must clause and a should clause in one sentence', () => {
  const MIXED = 'Applicants must hold a valid licence and should be active in public service.';

  it('scopes the recommendation to its own clause and leaves the requirement standing', () => {
    const scope = preferenceScope(MIXED);
    expect(scope.governed).toEqual(['should be active in public service.']);
    expect(scope.ungoverned).toEqual(['Applicants must hold a valid licence and ']);
    // The requirement half survives verbatim, which is what every axis that reads its VALUES out
    // of this text depends on.
    expect(requirementText(MIXED)).toBe('Applicants must hold a valid licence');
    // The sentence as a whole is not preference prose: a requirement stands outside the scope.
    expect(isPreferenceText(MIXED)).toBe(false);
    expect(cascadeRank(MIXED)).toBe(0);
  });

  it('publishes the must clause hard and the should clause soft, from one sentence', () => {
    // Same sentence, two axes, two answers — which is what "scoped to the clause" has to mean once
    // it reaches published constraints.
    const text = 'Applicant must hold a valid amateur radio licence and should reside in Dallas County.';
    // The licence half binds: extractLicense reads its floor off `requirementText`, which is the
    // must clause with the should clause removed.
    const licence = extractLicense({
      sourceId: 'arrl-scholarship-descriptions',
      externalKey: 'k',
      name: 'n',
      rawFields: { 'License Requirement': text },
      sourceUrl: 'https://example.test/x',
      rawText: text,
    });
    expect(licence).toHaveLength(1);
    expect(licence[0].hard).toBe(true);
    expect(requirementText(text)).toBe('Applicant must hold a valid amateur radio licence');
    // The residence half does not: every value the geography spec spells out ("Dallas") is stated
    // only inside the should clause, so `specStatedOnlyAsPreference` refuses to publish a bar built
    // out of it. Without the modal in the vocabulary this same spec is a hard county bar.
    const preferred = makeConstraint(
      'geography',
      text,
      { axis: 'geography', geo: { type: 'county', values: ['Dallas'] } },
      0,
    );
    expect(preferred.hard).toBe(false);
  });

  it('is the real North Texas entry, whose two halves are stated exactly this way', () => {
    // Verbatim, fixtures/arrl-scholarship-descriptions, The North Texas Section Bob Nelson, KB5BNU,
    // Memorial Scholarship. "must have graduated … and may attend" — the graduation clause binds,
    // the attendance clause does not, and adding permissive "may" to the vocabulary must not cost
    // the funder its stated requirement.
    const text =
      'Applicant must have graduated high school located within the North Texas Section, and may ' +
      'attend college or university in this section. Additional applicants to be considered: ' +
      'North Texas residency, attending a school in another state, applicants of other Texas ' +
      'sections attending school in our state or out and Oklahoma residents attending school in ' +
      'Texas or another state.';
    expect(isPreferenceText(text)).toBe(false);
    expect(requirementText(text)).toMatch(
      /^Applicant must have graduated high school located within the North Texas Section/,
    );
  });

  it('does not let a recommendation reach back over a requirement without a hinge', () => {
    // No comma and no conjunction to hand the preference forward, so the marker sits in what the
    // scope rules call predicate position — where a marker governs its whole segment. A stated
    // requirement in front of it stops that, or "must submit a form" would vanish.
    const text = 'Applicants must submit a form that may be downloaded from the club website.';
    expect(isPreferenceText(text)).toBe(false);
    expect(requirementText(text)).toBe('Applicants must submit a form that');
  });
});

// ---------------------------------------------------------------- what must not move

describe('the restored hard licence floors survive the widened vocabulary', () => {
  it('Holt, NEAR-Fest and Carole Streeter still publish a hard floor', () => {
    const cases: ReadonlyArray<[string, string, string, number | undefined]> = [
      [
        'Michael/Mary Holt',
        'Any active Amateur Radio License Class for two years, preference for General Class',
        'TECH',
        24,
      ],
      [
        'NEAR-Fest',
        'First Preference given to Extra Class, Second Preference given to General Class, Third ' +
          'Preference Given to Technician Class. Applicants must have held an amateur radio ' +
          'license for a minimum of one year prior to date of application.',
        'TECH',
        12,
      ],
      [
        'Carole J. Streeter, KB9JBR',
        'Any class of active Amateur Radio license with preference for basic Morse code capability',
        'TECH',
        undefined,
      ],
    ];
    for (const [who, text, licenseMin, heldMonthsMin] of cases) {
      const cs = extractLicense({
        sourceId: 'arrl-scholarship-descriptions',
        externalKey: 'k',
        name: 'n',
        rawFields: { 'License Requirement': text },
        sourceUrl: 'https://example.test/x',
        rawText: text,
      });
      expect(cs, who).toHaveLength(1);
      expect(cs[0].hard, who).toBe(true);
      expect(cs[0].spec, who).toMatchObject(
        heldMonthsMin === undefined
          ? { axis: 'license', licenseMin }
          : { axis: 'license', licenseMin, heldMonthsMin },
      );
    }
  });

  it('every individual-facing licence constraint in the real corpus is still hard', async () => {
    // The corpus-wide version of the same statement, so a future widening of this vocabulary
    // cannot soften a floor on a program nobody thought to name. `licenseMin: NONE` is North
    // Fulton, whose ARRL catalog value is literally the bare word "None" — an answer, not a gap.
    const { programs } = await corpus();
    const soft = programs
      .filter((p) => p.applicantEntities.includes('individual'))
      .flatMap((p) => axisOf(p, 'license').filter((c) => !c.hard).map((c) => `${p.name}: ${c.rawText}`));
    expect(soft).toEqual([]);
  });
});

describe('and the stated fallbacks stay soft', () => {
  it('CTRI keeps its cascade soft at fallbackRank 1', () => {
    const text =
      'ARRL New England Division (Connecticut, Rhode Island, Vermont, Maine, New Hampshire); if ' +
      'no suitable applicant identified, applicants from all regions will be considered';
    expect(isPreferenceText(text)).toBe(true);
    expect(cascadeRank(text)).toBe(1);
  });

  it('the canonical Louisiana cascade keeps its rank', () => {
    const text =
      'Preference will be given to applicants residing in Louisiana. If no qualified applicant ' +
      'is identified, the scholarship may be awarded to an applicant from the Delta Division ' +
      '(Arkansas, Louisiana, Mississippi, Tennessee).';
    expect(isPreferenceText(text)).toBe(true);
    expect(cascadeRank(text)).toBe(1);
    expect(requirementText(text)).toBe('');
  });
});

// ---------------------------------------------------------------- the corpus-wide account

/**
 * EVERY CONSTRAINT THIS CHANGE MOVES, BY NAME.
 *
 * The sweep over all 111 real ARRL catalogue entries (and the other 38 real programs beside them)
 * moved exactly three constraints from hard to soft and nothing else: no constraint appeared, none
 * vanished, and no `spec` changed anywhere in the corpus. Pinning the list here is what makes a
 * later widening of the modal vocabulary visible as a diff instead of as a silent re-classification
 * — which is precisely how "should" came to be a bar in the first place.
 */
describe('the corpus-wide account of what the modal vocabulary softens', () => {
  /**
   * Attribution, computed rather than guessed: a constraint's softness is due to the MODAL
   * vocabulary exactly when the classifier calls it preference prose as written and calls it a
   * requirement once the modals are deleted from the same text. Everything else — a preference
   * noun, an explicit cascade — answers the same either way and is not this change's doing.
   */
  const MODALS = /\b(?:should|might|ought to)\b|\bmay\b(?!\s+(?:not|never|no|only)\b)/gi;
  /** `other.ts` and `financialNeed.ts` never call `makeConstraint`; both are hard-coded soft. */
  const NEVER_CLASSIFIED = new Set(['other', 'financial_need']);

  it('softens exactly the constraints it is claimed to, and they are these two', async () => {
    const { programs } = await corpus();
    const softenedByModal = programs
      .flatMap((p) => p.constraints.map((c) => ({ p, c })))
      .filter(({ c }) => !NEVER_CLASSIFIED.has(c.spec.axis) && !c.hard)
      .filter(
        ({ c }) => isPreferenceText(c.rawText) && !isPreferenceText(c.rawText.replace(MODALS, '')),
      )
      .map(({ p, c }) => `${p.name} :: ${c.spec.axis}`)
      .sort();
    expect(softenedByModal).toEqual([
      'The John C. York, KE5V, Scholarship :: ham_activity',
      'The Medical Amateur Radio Council (MARCO) Scholarship :: ham_activity',
    ]);
    // ECARS WAS THE THIRD AND ITS SENTENCE IS STILL HERE. It no longer appears in the list above
    // because `age_stage` publishes nothing for it at all (see the case below), not because the
    // modal vocabulary stopped reading it — so the claim is asserted on the sentence itself,
    // taken out of the record rather than retyped.
    const ecars = programNamed(programs, 'East Coast Amateur Radio Service');
    const sentence = ecars.constraints
      .map((c) => c.rawText)
      .find((t) => /older applicants retraining in a changing job market/i.test(t));
    if (sentence === undefined) throw new Error('ECARS no longer carries the funder wording anywhere');
    expect(isPreferenceText(sentence)).toBe(true);
    expect(isPreferenceText(sentence.replace(MODALS, ''))).toBe(false);
  });

  it('ECARS: the funder widens its own band, and the widening is not the preference', async () => {
    // "Applicant should generally be between the ages of 17 and 25 at the time of the award, BUT
    // OLDER APPLICANTS RETRAINING IN A CHANGING JOB MARKET WILL BE CONSIDERED." A hard age band
    // read off that sentence excluded exactly the applicants its second half invites — and a
    // PREFERENCE read off it credited only those applicants, which is the same sentence read
    // backwards: `stages: ['RETRAINING_ADULT']` made a 41-year-old returner `eligible_preferred`
    // and left the 20-year-old undergraduate the funder actually prefers merely `eligible`.
    //
    // The band itself lives in no field of `ConstraintSpec` here, so the only part of the
    // sentence this axis could publish was its EXCEPTION. It publishes nothing instead: a
    // preference the funder never stated is not a safer error than a bar it never stated, merely
    // a quieter one, and a soft constraint refuses nobody either way.
    const { programs } = await corpus();
    const ecars = programNamed(programs, 'East Coast Amateur Radio Service');
    expect(axisOf(ecars, 'age_stage')).toEqual([]);
    // THE FUNDER'S WORDING IS NOT LOST WITH IT. The same sentence is still on the record, on the
    // axis for "a requirement no schema captures", so the applicant still reads what ECARS said.
    const carrying = ecars.constraints.filter((c) =>
      /older applicants retraining in a changing job market/i.test(c.rawText),
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0].hard).toBe(false);
    // Its licence floor is untouched: ECARS still requires an active licence, so the unlicensed
    // profile is still excluded from it — on the axis the funder actually states as a requirement.
    const licence = axisOf(ecars, 'license');
    expect(licence).toHaveLength(1);
    expect(licence[0].hard).toBe(true);
  });
});

// A type-level pin: the profile the eligibility assertions above use really is a licensed one.
const _licensed: StudentProfile = LICENSED_INDIVIDUAL.profile as StudentProfile;
if (_licensed.licenseClass === undefined || _licensed.licenseClass === 'NONE') {
  throw new Error('the eligibility assertions need a LICENSED individual profile');
}
