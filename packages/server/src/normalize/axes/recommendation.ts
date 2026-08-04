import type { Constraint, RawOpportunity, RecommenderType } from '@grantspotter/core';
import { candidateTexts, splitClauses } from './clauses.js';
import { makeConstraint } from './preference.js';

const WORD_COUNT: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const COUNT = /\b(one|two|three|four|five|\d+)\s+(?:letters? of )?(?:references?|recommendations?)/i;
const SIGNAL = /\b(references?|recommendations?|sponsor(?:s|ed|ship)?|letter from)\b/i;

/**
 * Who FUNDS the award is not a requirement on the applicant. The David Knaus Memorial
 * Scholarship's Field of Study field ends "This Scholarship is sponsored by the West Allis Radio
 * Amateur Club", and the bare `sponsored` alternative in SIGNAL turned that into a "you must be
 * sponsored" constraint — an obligation the funder never stated, displayed to every applicant.
 * Mirrors membership.ts's PRIZE_POLARITY guard, for the same reason. Deliberately requires the
 * linking-verb form ("... is sponsored by ..."), so "Scholarship applicants must be sponsored by
 * a club officer" is still read as the genuine requirement it is.
 */
const AWARD_IS_SPONSORED =
  /\b(?:scholarship|award|prize|fund|program|endowment)\b[^.]{0,40}?\b(?:is|are|was|were)\s+(?:generously\s+|proudly\s+)?sponsored\s+by\b/i;

function recommenderTypeFrom(text: string): RecommenderType {
  if (
    /\b(?:officer of an ARRL[- ]affiliated club|ARRL[- ]affiliated club officers?|sitting officers?)\b/i.test(
      text,
    )
  ) {
    return 'arrl_affiliated_club_officer';
  }
  if (/\bactive\s+\w+\s+members?\b|\bsponsored by an active\b/i.test(text)) return 'sponsor_org_member';
  if (/\b(?:teachers?|instructors?|faculty|professors?)\b/i.test(text)) return 'teacher';
  return 'any';
}

export function extractRecommendation(raw: RawOpportunity): Constraint[] {
  const candidates = candidateTexts([raw.rawFields.Other, raw.rawFields.sponsor], raw.rawText);
  // Anchored on SIGNAL itself, which is word-bounded. The old sentence regex respelled the same
  // alternatives WITHOUT \b, so "reference" matched inside "Preference": on the ARDC Scholarships
  // the extracted clause was the GPA preference sentence (truncated at the decimal point, "…a GPA
  // of over 3."), not the recommendation sentence — wrong wording shown to the user, wrong count
  // (1 instead of 3), and a stated requirement reported as a mere preference.
  for (const clause of candidates.flatMap(splitClauses)) {
    if (!SIGNAL.test(clause)) continue;
    // The award's own funding, not a requirement — keep scanning in case a genuine requirement is
    // stated in another clause, but never emit a constraint from this one.
    if (AWARD_IS_SPONSORED.test(clause)) continue;
    const countMatch = COUNT.exec(clause);
    const count = countMatch
      ? (WORD_COUNT[countMatch[1].toLowerCase()] ?? Number.parseInt(countMatch[1], 10))
      : 1;
    return [
      makeConstraint(
        'recommendation',
        clause,
        { axis: 'recommendation', recommenderType: recommenderTypeFrom(clause), count },
        0,
      ),
    ];
  }
  return [];
}
