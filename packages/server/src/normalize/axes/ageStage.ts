import type { Constraint, RawOpportunity, Stage } from '@grantspotter/core';
import { candidateTexts, firstClause, splitClauses } from './clauses.js';
// The shared "a link label is not a sentence" filter — see the comment on `stageClauses` below and
// the rule's own derivation in hamActivity.ts. Imported, never re-derived.
import { withoutSiteChrome } from './hamActivity.js';
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
  ['HS_SENIOR', /\b(?:high school seniors?|graduating seniors?)\b/i],
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
function stageClauses(raw: RawOpportunity): string[] {
  const fields = candidateTexts(
    [raw.rawFields.Other, raw.rawFields.eligibility, raw.rawFields.Institution],
    raw.rawText,
  )
    .map(withoutSiteChrome)
    .filter((t) => t.trim() !== '');
  return fields.flatMap(splitClauses).filter((c) => !FOREIGN_LABEL.test(c));
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
      },
      0,
    ),
  ];
}
