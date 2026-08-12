/**
 * AN IMPERATIVE SENTENCE THAT NOTHING ENFORCES, AND THE HEADING IT IS PRINTED UNDER.
 *
 * This corpus files every `Other` field twice. `other.ts` keeps the funder's prose verbatim as a
 * catch-all constraint and hard-codes it SOFT — correctly, because `ConstraintTier.other` holds a
 * note and nothing a profile can be checked against. The ENFORCEMENT is meant to come from a real
 * axis reading the same sentence and publishing it hard beside the catch-all copy.
 *
 * MEASURED OVER THE 150 PUBLISHABLE PROGRAMMES: 35 soft constraints quote a sentence that says
 * "must"/"shall"/"required" and never says "prefer". For 27 of them a HARD constraint on the same
 * record quotes that same sentence, so the imperative is enforced and the soft copy costs nobody
 * anything. EIGHT were enforced nowhere, and the product printed all eight to the applicant under
 * "A preference you do not match cannot make you ineligible" — a sentence saying "must", presented
 * as optional.
 *
 * WHAT THE EIGHT LACKED WAS NOT A CLASSIFICATION RULE. It was an axis that recognised their
 * wording:
 *
 *   THREE WERE `membership.ts`, AND THEY ARE FIXED HERE. Its anchor read only "ARRL member(ship)"
 *   and not the of-phrase order the funder is equally likely to write, so "Must be a member of
 *   ARRL" (North Fulton), the same sentence in You've Got a Friend in Pennsylvania, and "must have
 *   been a member of the ARRL for a minimum of one year" (Hesselbrock) produced NO
 *   `arrl_membership` constraint at all — while "Must be an ARRL Member" (Metzger, Pautz) and
 *   "applicant must be an ARRL member" (Bennett) produced a hard one from the identical
 *   requirement. Same funder, same demand, two spellings, two different products.
 *
 *   TWO ARE `institution.ts`'s, AND THEY ARE STILL OPEN — see `STILL_UNENFORCED`.
 *
 *   THREE ARE NOBODY'S, and that is the honest answer for them rather than a gap: they name a
 *   PACKET ITEM or a condition on a PREVIOUS AWARDEE, and no field in CONTRACT §3 addresses either.
 *
 * The direction of every fix in this file is checked BOTH WAYS, because six rounds of hunting false
 * excludes here produced an overshoot into false includes and the correction overshot back. So the
 * cases below assert the verdict for an applicant who MEETS each sentence as well as for one who
 * does not, and `no applicant is refused for a question they were never asked` pins the answer for
 * the applicant who has simply not filled the field in — which must be `unknown`, never a refusal.
 */
import type { Constraint, Profile, Program, StudentProfile } from '@grantspotter/core';
import { matchProgram } from '@grantspotter/core';
import { beforeAll, describe, expect, it } from 'vitest';
// The offline corpus loader: every committed REAL capture, parsed by its own source module and
// normalized exactly as the crawler does. Shared with the profiler and with modal-verbs.test.ts
// rather than reimplemented, so "the corpus" cannot mean two things.
import { PROFILE_NOW_ISO as NOW, loadCorpus } from '../../../../../scripts/profile-corpus.js';
import { splitClauses } from './clauses.js';

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

// ---------------------------------------------------------------- the census

/**
 * "Must", "shall", "required" — the funder stating an obligation. `requires?` is included because
 * two records write the same demand as "the programme requires…"; the census is reported per
 * CLAUSE, not per constraint, so a multi-requirement field is not credited to one word.
 */
const IMPERATIVE = /\b(?:must|shall|required|requires|require)\b/i;
/**
 * `preference.ts`'s own preference vocabulary, verbatim. A soft constraint whose sentence DOES say
 * "preference" is soft for the reason it looks soft, and is not this rule's business.
 */
const PREFERENCE =
  /\b(?:preferences?|preferred|preferential(?:ly)?|prefers?|preferably|priority|favou?r(?:ed|s|ing)?|considered first|first consideration|is given to|encouraged)\b/i;

/**
 * Split the same way `preference.ts` splits a text into the spans it judges — `splitClauses`, then
 * ";" — so "an 'A' or equivalent GPA …; must be a member of ARRL" is read as the two separate
 * demands the funder wrote rather than as one blended sentence.
 */
function imperativeClauses(text: string): string[] {
  return splitClauses(text)
    .flatMap((clause) => clause.split(';'))
    .map((clause) => clause.trim())
    .filter((clause) => IMPERATIVE.test(clause) && !PREFERENCE.test(clause));
}

interface ImperativeCensus {
  soft: number;
  quotingAnImperative: number;
  backedByAHardSibling: number;
  enforcedNowhere: string[];
}

function readImperatives(programs: Program[]): ImperativeCensus {
  const census: ImperativeCensus = {
    soft: 0,
    quotingAnImperative: 0,
    backedByAHardSibling: 0,
    enforcedNowhere: [],
  };
  for (const program of programs) {
    const hard = program.constraints.filter((c) => c.hard);
    for (const c of program.constraints) {
      if (c.hard) continue;
      census.soft += 1;
      const clauses = imperativeClauses(c.rawText);
      if (clauses.length === 0) continue;
      census.quotingAnImperative += 1;
      // "The same sentence, published hard somewhere on this record" — a substring test against the
      // hard constraints' own rawText, so the backing has to be the funder's words and not merely
      // an axis that happens to be present.
      if (clauses.some((clause) => hard.some((h) => h.rawText.includes(clause)))) {
        census.backedByAHardSibling += 1;
        continue;
      }
      census.enforcedNowhere.push(`${program.name} [${c.spec.axis}] — ${JSON.stringify(clauses[0].slice(0, 80))}`);
    }
  }
  census.enforcedNowhere.sort();
  return census;
}

/**
 * THE RESIDUAL, NAMED — five sentences, in two kinds, and neither kind is `membership.ts`'s.
 *
 * TWO ARE `institution.ts`'s AND ARE DUE. Fort Meyers and The Free Family both file "Student must
 * be full time" under `Other`, and `matcher.ts` reads `!spec.partTimeOK` as exactly that
 * requirement — so the axis that could enforce it exists and the field it would set exists.
 * `extractInstitution` never sees the sentence: it reads only `rawFields.Institution` and
 * `rawFields['Field of Study']`, and its own comment claims `Other` "carr[ies] no institution
 * statement this misses". These two records are that claim being false. `FULL_TIME_REQUIRED` would
 * also have to read backwards ("Student must be full time" puts the enrolment word LAST), which is
 * safe here because `partTimePermitted` consults `PART_TIME_MENTIONED` first and the one award
 * aimed at part-time students — YLRL's "For part-time students working full-time" — is already
 * admitted by that earlier check.
 *
 * WHEN THAT LANDS, THESE TWO LINES GO RED AND MUST BE DELETED. That is the whole point of pinning
 * them: the previous round's close-out removed a 26-entry allowlist with the note that "an
 * allowlist that outlives its defect is how a fixed bug comes back", and a residual nobody is
 * forced to re-read is that allowlist again.
 *
 * THREE ARE NOBODY'S, and pinning them is the finding rather than a deferral. "must submit
 * documents of learning disability", "Must be recommended by a current member of the QCWA", "A
 * previous awardee must show evidence of satisfactory academic performance", "Previous awardees …
 * must submit a new application" — every one names a PACKET ITEM or a condition that applies only
 * to somebody who has already won. CONTRACT §3 has no field for either, for any applicant, ever, so
 * an axis that "enforced" them would refuse everybody forever. Soft is the right classification and
 * `other.ts` reached it correctly; what is wrong for these three is the HEADING the web layer
 * prints them under, which is `Opportunity.tsx`'s and not this package's.
 *
 * AND TWO MORE OF THAT SAME THIRD KIND ARRIVED WITH THE ROUND THAT UNDID THE `institution.ts`
 * REGRESSION, both on `recommendation` and both packet items:
 *
 *   ARRL Foundation        "A NUMBER OF scholarships require additional documents, SUCH AS a letter
 *   Scholarship Program     of recommendation from a sitting Officer of an ARRL-affiliated club."
 *   ARRL Foundation        "An applicant for a mini-grant must write a brief, but complete proposal
 *   Special Funds           INCLUDING SUCH ITEMS AS: * Names … of sponsors * Objectives …"
 *
 * Both were HARD until that round — a recommendation requirement fabricated out of the funder's own
 * hedge, and on the first record it was the ONLY constraint, which took the deadline owner for 112
 * catalogue entries to `unknown` for every student in every state. `recommendation.ts` now reads a
 * signal that survives only inside a list the funder opened as the example it is, and the
 * hand-reviewed `data/seed/programs.curated.json` has always carried the first of these as
 * `hard: false`. They belong to the "nobody's" kind above for the same reason the other three do:
 * a letter and a proposal are packet items, no field in CONTRACT §3 addresses either, and an axis
 * that "enforced" them would refuse everybody forever.
 *
 * They are NOT the class the ARRL-membership assertion below guards. That assertion read
 * `/\bARRL\b/` over the whole entry — which includes the PROGRAMME NAME, and 111 of the 150
 * programmes in this corpus are ARRL Foundation catalogue entries — so it fired on any unenforced
 * imperative filed under an ARRL-named record, whatever the sentence said. It now asks whether the
 * SENTENCE is about ARRL membership, which is the class it names.
 */
const ARRL_MEMBERSHIP_SENTENCE =
  /\bARRL\b[^\n]{0,40}?\bmember|\bmember(?:s|ship)?\b[^\n]{0,25}?\bARRL\b/i;
const STILL_UNENFORCED = [
  'ARRL Foundation Scholarship Program [recommendation] — "A number of scholarships require additional documents, such as a letter of recom"',
  'ARRL Foundation Special Funds [recommendation] — "An applicant for a mini-grant must write a brief, but complete proposal includin"',
  'The Challenge Met Scholarship [other] — "Applicants must submit documents of learning disability (by physician or school)"',
  'The Fort Meyers Amateur Radio Club Scholarship [other] — "Student must be full time"',
  'The Free Family [N3TG (sk), K3MAF, KC3YO, K4FRE, KB4HGU (sk), KB4HGV (sk)] Scholarship [other] — "Student must be full time"',
  'The Quarter Century Wireless Association, Inc. (QCWA) Scholarship [other] — "Must be recommended by a current member of the QCWA."',
  'The Robert A. Rodriguez K5AUW Scholarship [other] — "A previous awardee must show evidence of satisfactory academic performance."',
  'The YASME Foundation Scholarship [other] — "Previous awardees of a YASME Scholarship seeking renewal of must submit a new ap"',
];

describe('an imperative sentence that no constraint enforces', () => {
  it('is never an ARRL-membership sentence, and the residual is the two kinds named above', async () => {
    const { programs } = await corpus();
    const census = readImperatives(programs);
    // THE CLASS THIS ROUND CLOSED, as an empty equality rather than a count: a membership sentence
    // arriving here again fails with its own name and the funder's own words in the diff.
    expect(census.enforcedNowhere.filter((entry) => ARRL_MEMBERSHIP_SENTENCE.test(entry))).toEqual([]);
    expect(census.enforcedNowhere).toEqual(STILL_UNENFORCED);
    // Vacuity guard. Without it every assertion above passes on an empty census, which is the shape
    // three guards in this repository failed in three consecutive rounds.
    expect({
      soft: census.soft,
      quotingAnImperative: census.quotingAnImperative,
      backedByAHardSibling: census.backedByAHardSibling,
    // 127 / 35 / 29 until the two `recommendation` fabrications above stopped being hard: both
    // become soft constraints quoting an imperative, and neither gains a hard sibling, so all
    // three of the first bucket's numbers move by two and the residual grows by two.
    }).toEqual({ soft: 129, quotingAnImperative: 37, backedByAHardSibling: 29 });
    expect(census.backedByAHardSibling + census.enforcedNowhere.length).toBe(census.quotingAnImperative);
  });

  it('goes red if membership.ts forgets the word order again', async () => {
    const { programs } = await corpus();
    // The mutation is the anchor's old reading, applied to the corpus rather than to the regex:
    // drop every `arrl_membership` constraint whose sentence spells the requirement the of-phrase
    // way, and the census must accuse the records that lose it.
    const disarmed: Program[] = programs.map((p) => ({
      ...p,
      constraints: p.constraints.filter(
        (c) => !(c.spec.axis === 'arrl_membership' && /\bmember(?:s|ship)?\s+of\b/i.test(c.rawText)),
      ),
    }));
    const accused = readImperatives(disarmed).enforcedNowhere.filter((e) => ARRL_MEMBERSHIP_SENTENCE.test(e));
    expect(accused).toHaveLength(2);
    expect(accused.join('\n')).toContain('North Fulton');
    expect(accused.join('\n')).toContain("You've Got a Friend in Pennsylvania");
  });
});

// ---------------------------------------------------------------- the verdicts, both ways

/**
 * An applicant built to clear every OTHER axis of the three records below, so the only thing that
 * moves between cases is what they said about ARRL membership. `state` is set per record, because a
 * probe refused on geography proves nothing about the axis under test.
 */
const CLEARS_EVERYTHING_ELSE: Omit<StudentProfile, 'kind'> = {
  callsign: 'W3EXAMPLE',
  licenseClass: 'EXTRA',
  licensedSince: '2015-01-01T00:00:00.000Z',
  degreeLevel: 'BACH',
  institution: 'A State University',
  accredited: true,
  partTime: false,
  gpa: 4.0,
  citizenship: 'US_CITIZEN',
  birthDate: '2006-03-01T00:00:00.000Z',
  stage: 'HS_SENIOR',
  fieldOfStudy: 'Electrical Engineering',
  activityKinds: ['club_member', 'on_air'],
  gender: 'female',
};

const applicant = (state: string, arrlMemberSince: string | undefined): Profile => ({
  kind: 'student',
  ...CLEARS_EVERYTHING_ELSE,
  state,
  ...(arrlMemberSince === undefined ? {} : { arrlMemberSince }),
});

/** Ten years before `PROFILE_NOW_ISO`, i.e. a member by any floor this corpus states. */
const LONG_STANDING_MEMBER = '2016-01-01T00:00:00.000Z';
/** Five months before `PROFILE_NOW_ISO` — a member, but under Hesselbrock's stated one-year floor. */
const NEW_MEMBER = '2026-03-01T00:00:00.000Z';

describe('"must be a member of ARRL" — the verdict on both sides of the sentence', () => {
  it('North Fulton: a member is still preferred, a non-answer is asked rather than refused', async () => {
    const { programs } = await corpus();
    const northFulton = programNamed(programs, 'North Fulton');
    // BEFORE THIS ROUND both of these read `eligible_preferred`, off the record's geography and
    // field-of-study cascades, with the membership sentence enforcing nothing at all.
    expect(matchProgram(applicant('GA', LONG_STANDING_MEMBER), northFulton, NOW).kind).toBe(
      'eligible_preferred',
    );
    const unanswered = matchProgram(applicant('GA', undefined), northFulton, NOW);
    // NOT `ineligible`. Nobody has said this applicant is not a member; they have not been asked.
    // `unknown` costs the reader nothing, keeps the door open, and names the one field that would
    // settle it — which is what `VerdictBadge` renders and what an editor can jump to.
    expect(unanswered.kind).toBe('unknown');
    if (unanswered.kind !== 'unknown') throw new Error('unreachable');
    expect(unanswered.missingProfileFields).toEqual(['arrlMemberSince']);
  });

  it("You've Got a Friend in Pennsylvania: the same sentence mid-field, the same two answers", async () => {
    const { programs } = await corpus();
    const pennsylvania = programNamed(programs, 'Friend in Pennsylvania');
    // The funder wrote it as the tail of a GPA sentence — "…excluding grades in sports or physical
    // education; must be a member of ARRL" — so this also pins that `findClause` reaching across
    // the semicolon does not cost the requirement its reading.
    expect(matchProgram(applicant('PA', LONG_STANDING_MEMBER), pennsylvania, NOW).kind).toBe('eligible');
    const unanswered = matchProgram(applicant('PA', undefined), pennsylvania, NOW);
    expect(unanswered.kind).toBe('unknown');
    if (unanswered.kind !== 'unknown') throw new Error('unreachable');
    expect(unanswered.missingProfileFields).toEqual(['arrlMemberSince']);
  });

  it('Hesselbrock: the one-year floor the funder wrote is the one the spec publishes', async () => {
    const { programs } = await corpus();
    const hesselbrock = programNamed(programs, 'Hesselbrock');
    const membership = hesselbrock.constraints.filter((c) => c.spec.axis === 'arrl_membership');
    expect(membership).toHaveLength(1);
    expect(membership[0].hard).toBe(true);
    expect(membership[0].spec).toMatchObject({ axis: 'arrl_membership', required: true, minYears: 1 });
    expect(matchProgram(applicant('OH', LONG_STANDING_MEMBER), hesselbrock, NOW).kind).toBe('eligible');
    // THE ONE NEW REFUSAL IN THIS CHANGE, AND IT IS THE FUNDER'S OWN: "Applicant must have been a
    // member of the ARRL for a minimum of one year prior to the application date". The same record's
    // licence field says "must have held license for a minimum of one year" and `license.ts` has
    // always read twelve months out of it, so this is the record's two sentences finally agreeing.
    expect(matchProgram(applicant('OH', NEW_MEMBER), hesselbrock, NOW).kind).toBe('ineligible');
    expect(matchProgram(applicant('OH', undefined), hesselbrock, NOW).kind).toBe('unknown');
  });

  it('the four records that already parsed this requirement did not move', async () => {
    const { programs } = await corpus();
    // Metzger and Bennett are the compound word order and were hard before this round; Kupferschmid
    // and Riebhoff write it as a preference and must STAY soft. If widening the anchor had reached
    // any of them, this is where it would show.
    for (const [needle, hard, state] of [
      ['Metzger', true, 'IL'],
      ['Bennett', true, 'WA'],
      ['Kupferschmid', false, 'WI'],
      ['Riebhoff', false, 'IL'],
    ] as const) {
      const program = programNamed(programs, needle);
      const membership: Constraint[] = program.constraints.filter((c) => c.spec.axis === 'arrl_membership');
      expect(membership, needle).toHaveLength(1);
      expect(membership[0].hard, needle).toBe(hard);
      expect(membership[0].spec, needle).toMatchObject({ required: true, minYears: 0 });
      // A soft membership constraint never refuses; a hard one asks. Neither refuses the member.
      // The record is reduced to the constraint under test first: Riebhoff refuses this probe on
      // its FIELD OF STUDY, and a refusal from a different axis would let this case pass while the
      // membership axis did anything at all.
      expect(
        matchProgram(applicant(state, LONG_STANDING_MEMBER), { ...program, constraints: membership }, NOW)
          .kind,
        needle,
      ).not.toBe('ineligible');
    }
  });

  it('no applicant is refused for a question they were never asked', async () => {
    const { programs } = await corpus();
    let checked = 0;
    // A student and an organisation who have each answered NOTHING about membership. Both kinds are
    // asked: `matcher.ts` reads `arrlAffiliated` for an organisation and `arrlMemberSince` for a
    // student, and ARRL ETP Grants — the one membership record aimed at institutions — can only be
    // reached by the second of these.
    const nobody: Profile[] = [
      { kind: 'student', state: 'TX' },
      { kind: 'organization', entity: 'club_501c3', state: 'TX' },
    ];
    for (const program of programs) {
      for (const c of program.constraints) {
        if (c.spec.axis !== 'arrl_membership') continue;
        checked += 1;
        for (const profile of nobody) {
          // Every membership constraint in the corpus, against an applicant who has answered
          // nothing about membership: the axis may ask, and may never refuse. This is the assertion
          // that stops a future widening of this axis from becoming the false-exclude direction,
          // and it is asked of the AXIS rather than of the records that happen to be in it today.
          // The record is reduced to this one constraint so an unrelated axis cannot answer for it.
          expect(
            matchProgram(profile, { ...program, applicantEntities: [], constraints: [c] }, NOW).kind,
            `${program.name} refused an unanswered membership question`,
          ).not.toBe('ineligible');
        }
      }
    }
    // Vacuity guard: seven hard and three soft membership constraints, over ten programmes' worth of
    // membership wording. Three of the hard ones did not exist before this round.
    expect(checked).toBe(10);
  });
});
