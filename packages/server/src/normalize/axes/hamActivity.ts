import type { ActivityKind, Constraint, RawOpportunity } from '@grantspotter/core';
import { candidateTexts, firstClause } from './clauses.js';
import { makeConstraint } from './preference.js';

const CW_WPM = /\b(\d{1,3})\s*(?:wpm|words per minute)\b/i;

/**
 * `spec.activityKinds` is an ALLOW-list: the matcher passes an applicant who holds ANY ONE of the
 * listed kinds. Adding a spelling therefore widens who qualifies, and a missing spelling is a
 * silent bar. Two were missing on the largest programme in the corpus — the ARDC Scholarships
 * list, as EXAMPLES of acceptable proof, "membership in a local or regional club", "on-the-air
 * activities" and "participation in college radio clubs". Neither the club nor the on-air
 * spelling matched, so the constraint came out as `["teaching"]` and an applicant who is a club
 * member and operates on the air — exactly the person the sentence describes — was excluded.
 *
 * The `teaching` pattern was `\b(teach|instruct|licensing class|Elmer)\w*\b`, whose `\w*` tail
 * also swallowed "teacher" and "instructor". Three scholarships (Harry A. Hodges, K6GO Gayle
 * Olson, Richard Warren K6OBS) share the sentence "…at least two counselor or teacher
 * recommendations as to how and why they have turned their lives around": "teacher" is who WRITES
 * the letter, not an amateur-radio activity the applicant performs. Reading it as one fabricated
 * a ham-activity requirement on three awards at once, and it was that fabricated kind ALONE that
 * excluded applicants from all three.
 *
 * The club pattern requires membership/participation language near the word "club", so an
 * ARRL-affiliated club named only as the source of a recommendation letter ("a letter from a
 * sitting officer of an ARRL-affiliated club") is still not read as a club-membership
 * requirement.
 */
const KIND_PATTERNS: Array<[ActivityKind, RegExp]> = [
  [
    'club_member',
    /\bclub (?:member|membership|teaching|activit)\w*\b|\b(?:member(?:ship)?|participat\w+|involve\w+|active)\b[^.]{0,60}?\bclubs?\b/i,
  ],
  ['ares_races_skywarn', /\b(ARES|RACES|SKYWARN)\b/],
  ['teaching', /\b(?:teach(?:es|ing)?|instruct(?:s|ing)?|licensing class(?:es)?|Elmer(?:ing|s)?)\b/i],
  ['on_air', /\bon[-\s]the[-\s]air\b|\bon[-\s]air\b|\boperating activit\w*\b/i],
  ['field_day', /\bField Days?\b/i],
  ['contesting', /\bcontest(?:ing|s)?\b/i],
  ['public_service', /\bpublic services?\b/i],
];
const ANY_ACTIVITY = new RegExp(
  [...KIND_PATTERNS.map(([, re]) => re.source), CW_WPM.source].join('|'),
  'i',
);

export function extractHamActivity(raw: RawOpportunity): Constraint[] {
  const candidates = candidateTexts([raw.rawFields.Other, raw.rawFields.eligibility], raw.rawText);
  const text = candidates.join('\n');
  const activityKinds = KIND_PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
  const cw = CW_WPM.exec(text);
  if (activityKinds.length === 0 && !cw) return [];
  // Anchored on the same patterns that produced the kinds. The old sentence regex spelled a
  // THIRD, shorter list ("…|club|teach|wpm") and could not cross a period, so on the Rev. Paul E.
  // Bittner and Wayne Nelson entries it started mid-decimal and on records with no sentence
  // terminator it ran across every field, letting another axis's "preference" wording decide
  // whether this axis was a bar.
  const clause = firstClause(candidates, ANY_ACTIVITY) ?? text;
  return [
    makeConstraint(
      'ham_activity',
      clause,
      {
        axis: 'ham_activity',
        activityKinds,
        ...(cw ? { cwProficiencyWpmMin: Number.parseInt(cw[1], 10) } : {}),
        proofRequired: /\b(documented|documentation|proof|certificate|verified)\b/i.test(clause),
      },
      0,
    ),
  ];
}
