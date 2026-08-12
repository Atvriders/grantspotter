import type { Constraint, RawOpportunity, Stage } from '@grantspotter/core';
import { candidateTexts, firstClause, splitClauses } from './clauses.js';
// The shared "a link label is not a sentence" filter and the shared "this clause asserts something
// OF THE APPLICANT" test — see `stageClauses` and `INSTITUTION_LABEL` below, and each rule's own
// derivation in hamActivity.ts. Imported, never re-derived.
import { APPLICANT_REQUIREMENT, withoutSiteChrome } from './hamActivity.js';
import { makeConstraint } from './preference.js';

const RANGE = /\b(\d{2})\s*(?:to|through|[-–])\s*(\d{2})\b/;
const MAX_AGE = /\b(\d{2})\s*(?:years old )?or (?:younger|under)\b/i;
const MIN_AGE = /\bat least\s+(\d{2})\s*(?:years old)?\b/i;
const AS_OF = /\bas of\s+([A-Z][a-z]+\.?\s+\d{1,2})/;

/**
 * `spec.stages` is an ALLOW-list: the matcher fails an applicant whose stage is absent from it.
 * Every pattern here therefore widens who may apply, and a missing spelling is a silent bar —
 * which is what "a student currently enrolled at a 2 or 4-year college" was. The Tom and Judith
 * Comstock Scholarship states, in one sentence, that it is open to a high-school senior OR to a
 * student already enrolled in college; only the first half had a spelling here, so every
 * currently-enrolled undergraduate was told they were ineligible for an award written to include
 * them.
 */
const STAGE_PATTERNS: Array<[Stage, RegExp]> = [
  // `high[\s-]?school` — ONE SPELLING WAS MISSING AND IT COST THE FIRST AUDIENCE OF AN AWARD.
  // The ARRL Scholarship to Honor Barry Goldwater is "open only to graduating HIGHSCHOOL seniors
  // and undergraduate students", written solid, exactly as the live arrl.org capture and the
  // committed seed record spell it. `\bhigh school seniors?\b` cannot match "highschool seniors",
  // so the only stage this record published was UNDERGRAD — and `stages` is an ALLOW-LIST, so
  // every graduating high-school senior, the audience the funder names FIRST, was told they were
  // ineligible for a $5,000 award written to include them. The optional separator covers all three
  // spellings volunteers use: "high school", "high-school", "highschool".
  ['HS_SENIOR', /\b(?:high[\s-]?school seniors?|graduating seniors?)\b/i],
  [
    'UNDERGRAD',
    // Two phrases are excluded because they are not statements about the applicant's standing:
    //  - "undergraduate YEAR" — the Wayne Nelson, KB4UT, Memorial Scholarship's only occurrence of
    //    the word is "…grade point average of 3.0 or higher on a 4.0 scale in high school or in
    //    the previous undergraduate year", which names where the GPA came from;
    //  - "undergraduate DEGREE" — that is a degree LEVEL, and institution.ts already reads it into
    //    `degreeLevels: ["ASSOC","BACH"]` (verified on Six Meter Club of Chicago, PVRC and Fort
    //    Meyers, all three of which carry it). Re-reading it here as a stage duplicated the same
    //    requirement on a second axis with a coarser vocabulary, and the coarser one barred people
    //    the finer one admits: a part-time adult in an associate programme has degreeLevel ASSOC
    //    (passes institution.ts) but stage RETRAINING_ADULT (failed a stages:["UNDERGRAD"] bar) —
    //    on the Six Meter Club of Chicago Scholarship, whose institution wording begins
    //    "Part-time or full-time post-secondary student", i.e. explicitly welcomes them.
    /\b(?:undergraduates?(?!\s+(?:year|degree))|baccalaureate|four[- ]year students?)\b|\bstudents? (?:currently )?enrolled\b|\b(?:currently )?enrolled (?:at|in) an? \d/i,
  ],
  // `post-graduate` is spelled out because the CWops Scholarship's institution wording is
  // "2- or 4-year, undergraduate, graduate or post-graduate": without it the stage list came out
  // as UNDERGRAD alone and barred exactly the graduate students the sentence names.
  ['GRAD', /\b(?:graduate students?|post[- ]?graduates?|masters?|doctoral|phds?)\b/i],
  ['VETERAN', /\bveterans?\b/i],
  ['RETRAINING_ADULT', /\bretrain|returning to school|career chang|adults? (?:re)?entering\b/i],
];
const ANY_STAGE = new RegExp(STAGE_PATTERNS.map(([, re]) => re.source).join('|'), 'i');

/**
 * Field labels this axis must not read a stage out of. `Field of Study` is owned by
 * fieldOfStudy.ts and `Region` by geography.ts; a degree name appearing there describes the
 * SUBJECT or the PLACE, not the applicant's standing, and turning it into a hard stage bar
 * invents a restriction the funder never stated. The New England Amateur Radio Festival
 * (NEAR-Fest) Memorial Scholarship is the case that matters: its only occurrence of
 * "undergraduate" anywhere is "Field of Study: Any undergraduate degree or a two-year technical
 * school in radio communications", and reading it here produced a hard UNDERGRAD-only bar that
 * excluded graduate students on an axis where the funder said nothing at all.
 */
/** An Age field that carries no information — "Age: Any" is the real Fort Meyers wording. */
const PLACEHOLDER = /^(?:any|none|n\/a|-+|any age|no age (?:limit|requirement)s?)\.?$/i;

const FOREIGN_LABEL =
  /^(?:[·•▪‣]\s*)?(?:Field of Study|Region|Award Amounts?|Number of [Aa]wards|License Requirement|Deadline|Contact)\s*:/i;

function stagesFrom(texts: string[]): Stage[] {
  const stages = new Set<Stage>();
  for (const [stage, re] of STAGE_PATTERNS) {
    if (texts.some((t) => re.test(t))) stages.add(stage);
  }
  return [...stages];
}

/**
 * AN AUDIENCE WITH NO PROFILE FIELD — the case where widening the spec would be a fabrication.
 *
 * The Robert A. Rodriguez K5AUW Scholarship: "The scholarship is open to graduating high school
 * seniors, AND TO PREVIOUS AWARDEES." Two audiences, and only the first is a `Stage`. "Previous
 * awardee" is not a stage, not a degree level, not anything `StudentProfile` holds — there is no
 * value of any field that means "I won this last year", and inventing a stage so the second
 * audience appears to be captured would put a claim in the record the funder never made. But
 * publishing `stages: ["HS_SENIOR"]` alone hard-refuses a returning awardee while quoting them the
 * very sentence that invites them, which is the defect this round is about.
 *
 * So the axis says what is true: there is another route and this schema cannot check it. The
 * matcher turns that into `unknown` — "it is not a 'no'" — instead of a refusal. See
 * `ConstraintAlternatives.orUnrepresented`.
 *
 * WHAT MAKES THIS DETECTABLE RATHER THAN A GUESS: the funder REPEATED THE PREPOSITION. English
 * repeats "to" when a genuinely separate object follows ("open to A, and TO B") and drops it when
 * the objects are coordinate members of one audience ("open only to graduating highschool seniors
 * and undergraduate students" — Goldwater, which must NOT be flagged and is not). Both halves of
 * the test are needed and each does real work:
 *   1. the clause must OPEN an audience list ("open to", "available to", "awarded to"), so the
 *      "and to" of ordinary prose ("submit the form and to the committee") is not an audience; and
 *   2. the trailing audience must match NO stage pattern, so a second audience this axis DID
 *      understand widens `stages` in the normal way and is not filed as unrepresentable.
 * Measured over the committed fixtures: one record in the corpus matches, and it is Rodriguez.
 */
const AUDIENCE_INTRO = /\b(?:open|available|awarded|offered|restricted|limited)\s+(?:only\s+)?to\b/i;
const SECOND_AUDIENCE = /\b(?:and|or)\s+to\s+([^.;]+)/i;

function unrepresentedAudience(clauses: string[]): string | undefined {
  for (const clause of clauses) {
    const intro = AUDIENCE_INTRO.exec(clause);
    if (intro === null) continue;
    const second = SECOND_AUDIENCE.exec(clause.slice(intro.index + intro[0].length));
    if (second === null) continue;
    const audience = second[1].replace(/\s+/g, ' ').trim();
    if (audience === '' || ANY_STAGE.test(audience)) continue;
    return audience;
  }
  return undefined;
}

/**
 * The clauses this axis is allowed to read: every structured field that describes the applicant,
 * plus the flattened record's own clauses minus the ones another axis owns (see FOREIGN_LABEL) and
 * minus the site's navigation.
 *
 * SITE CHROME IS NOT ELIGIBILITY TEXT here either, and `spec.stages` is an ALLOW-list, so a stage
 * matched off a menu is a HARD BAR that admits only that one stage. The IEEE Student Branch Rebate
 * carried exactly that: ieee.org's masthead and mega-footer run "Submit Your Student Branch Annual
 * Plan - IEEE Students · Renew Membership · Join IEEE Today! · Skip to content · IEEE.org · … ·
 * Graduate Students · …", and the record published `stages: ["GRAD"]` — barring every
 * undergraduate, high-school and returning-adult applicant from a student-branch rebate on the
 * strength of a link label. FOREIGN_LABEL could not see it: a menu carries no label at all.
 */
/**
 * THE INSTITUTION SENTENCE DESCRIBES THE SCHOOL, NOT THE APPLICANT'S STANDING.
 *
 * The CWops Scholarship's `Institution` value is
 *
 *   "Fully accredited educational institution of higher learning, 2- OR 4-YEAR, UNDERGRADUATE,
 *    GRADUATE OR POST-GRADUATE, or a fully accredited trade, art or professional school"
 *
 * — a list of the levels a qualifying SCHOOL teaches at, which `institution.ts` reads correctly as
 * `degreeLevels: [CERT, ASSOC, BACH, GRAD]` with `tradeSchoolOK`. Read here as well, the same three
 * words became `stages: ['UNDERGRAD','GRAD']`, an ALLOW-list, and an Extra-class graduating high
 * school senior with 25 wpm was told they were INELIGIBLE, sole reason `age_stage`. Nothing in that
 * record says a graduating senior may not apply — the award is tuition for the coming academic
 * year, and the funder's own preamble is "open to ANY QUALIFIED APPLICANT regardless of location or
 * nationality". A stage list minted from a sentence about buildings refused the applicant the
 * sentence never mentions.
 *
 * This is the same judgement the `undergraduate (?!degree)` lookahead above already makes on a
 * single phrase, applied to the SURFACE the phrase came from — and the same rule hamActivity.ts
 * derived for its unlabelled-page fallback: an axis may only read out of text that is actually
 * about its question. So the `Institution` field (and the `Institution:` line of the flattened
 * record, which is the same words reached by a different route) contributes a stage only when the
 * clause ASSERTS SOMETHING OF THE APPLICANT. `APPLICANT_REQUIREMENT` is imported from hamActivity.ts
 * rather than restated, so the two surfaces cannot drift apart.
 *
 * WHAT STILL READS. The Tom and Judith Comstock Scholarship files its whole audience under
 * `Institution`: "APPLICANT MUST BE a high school senior accepted at a 2 or 4-year college or a
 * student currently enrolled at a 2 or 4-year college" — an obligation on the applicant, so both
 * of its stages survive, which matters because that record has no other statement of who may apply.
 *
 * DIRECTION OF ERROR. `stages` is an allow-list, so a clause this gate drops WIDENS who may apply;
 * it can never manufacture a refusal. A stage wrongly dropped costs an applicant a requirement they
 * will read in the funder's own words on the record; a stage wrongly kept is a silent bar.
 */
const INSTITUTION_LABEL = /^(?:[·•▪‣]\s*)?Institution\s*:/i;

function stageClauses(raw: RawOpportunity): string[] {
  const clauses = candidateTexts([raw.rawFields.Other, raw.rawFields.eligibility], raw.rawText)
    .map(withoutSiteChrome)
    .filter((t) => t.trim() !== '')
    .flatMap(splitClauses)
    .filter((c) => !FOREIGN_LABEL.test(c) && !INSTITUTION_LABEL.test(c));
  const institution = raw.rawFields.Institution;
  const institutionClauses =
    typeof institution === 'string' && institution.trim() !== ''
      ? splitClauses(withoutSiteChrome(institution))
      : [];
  return [
    ...clauses,
    // The same gate on both routes to the same words: the labelled field, and the `Institution:`
    // line of the flattened record that `candidateTexts` folds in through `rawText`.
    ...institutionClauses.filter((c) => APPLICANT_REQUIREMENT.test(c)),
  ];
}

export function extractAgeStage(raw: RawOpportunity): Constraint[] {
  const ageText = (raw.rawFields.Age ?? raw.rawFields.age ?? '').trim();
  const clauses = stageClauses(raw);

  const range = RANGE.exec(ageText);
  const maxAge = MAX_AGE.exec(ageText);
  const minAge = MIN_AGE.exec(ageText);
  const stages = stagesFrom(clauses);

  if (!range && !maxAge && !minAge && stages.length === 0) return [];

  const asOf = AS_OF.exec(ageText)?.[1];
  // The Age field is the constraint's own wording whenever it says anything — including age
  // wording no pattern above could parse ("Applicant must be under 26 years of age", the Ozaukee
  // Radio Club, W9CQO, Scholarship). It is skipped only when it is a placeholder ("Age: Any", the
  // Fort Meyers Amateur Radio Club Scholarship), where showing the applicant the literal word
  // "Any" as the reason for a stage constraint tells them nothing at all; then the clause that
  // actually produced the stages is the honest rawText.
  const usableAgeText = PLACEHOLDER.test(ageText) ? '' : ageText;
  const rawText =
    usableAgeText !== ''
      ? usableAgeText
      : (firstClause(clauses, ANY_STAGE) ?? clauses.join('\n'));

  // Only a STAGE list can hide an audience: an age band is a number, and a number has no second
  // reading. Read from the clauses this axis actually understood, not from the whole record.
  const orUnrepresented = stages.length > 0 ? unrepresentedAudience(clauses) : undefined;

  return [
    makeConstraint(
      'age_stage',
      rawText,
      {
        axis: 'age_stage',
        ...(range ? { ageMin: Number.parseInt(range[1], 10), ageMax: Number.parseInt(range[2], 10) } : {}),
        ...(!range && maxAge ? { ageMax: Number.parseInt(maxAge[1], 10) } : {}),
        ...(!range && minAge ? { ageMin: Number.parseInt(minAge[1], 10) } : {}),
        ...(asOf ? { asOf } : {}),
        stages,
        ...(orUnrepresented !== undefined ? { orUnrepresented } : {}),
      },
      0,
    ),
  ];
}
