import type { Constraint, RawOpportunity, RecommenderType } from '@grantspotter/core';
import { candidateTexts, splitClauses } from './clauses.js';
// The shared "a link label is not a sentence" filter. It lives in hamActivity.ts because that is
// the axis whose defect forced it to be written; it is imported rather than re-derived because a
// second copy of a rule about what counts as eligibility text is how the two drift, and this axis
// carried FIVE of the constraints it was written to remove. (recommendation.ts already imports
// `makeConstraint` from another axis module for the same reason.)
import { withoutSiteChrome } from './hamActivity.js';
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

/**
 * SITE CHROME IS NOT ELIGIBILITY TEXT — ON THIS AXIS TOO.
 *
 * `candidateTexts` falls back to `raw.rawText`, and for a source that files neither `Other` nor
 * `sponsor` that is the WHOLE FLATTENED PAGE. SIGNAL is a single word — "sponsor", "references",
 * "recommendations", "letter from" — and every one of those is also a NAV LINK on the sites this
 * corpus captures, so five programmes published a recommendation requirement no funder ever
 * stated, quoting a menu as the evidence:
 *
 *   ARRL Amateur Radio Grants  "Back to Top · Having Trouble? · Get Involved >> The ARRL
 *                              Foundation >> Amateur Radio Grants · Articles of
 *                              Incorporation/ByLaws · … · Ways to support the ARRL Foundation ·
 *                              ARRL Foundation Donation Form" — the foundation's own side rail,
 *                              read as `recommenderType: "teacher"`.
 *   ARRL Club Grant Program    the identical side rail on the neighbouring page, same verdict.
 *   ARRL Foundation Special    "Winners: · 2002 Ian Poole, G3YWX, for "Understanding Solar
 *   Funds                      Indices" · 2003 Ward Silver, NØAX, … " — the award-history roll,
 *                              which is a run of link-shaped lines, not a requirement.
 *   YLRL Scholarships          "Skip to content · Contact · Why Join · Resources · Links · …
 *                              Membership · Why Join · Join/Renew Application · Sponsor ·
 *                              Adoptee Application · …" — the word "Sponsor" is a MENU ITEM on
 *                              ylrl.net. Same page, same menu, same class of defect as the
 *                              `contesting` bar that hid three women-only ham scholarships.
 *   IEEE MTT-S Chapter Support "com · Books · Digital Products · Conferences · Conference
 *                              Calendar · International Microwave Symposium (IMS) · …"
 *   IEEE Student Branch Rebate "Submit Your Student Branch Annual Plan - IEEE Students · Renew
 *                              Membership · Join IEEE Today! · Skip to content · IEEE.org · …"
 *
 * A recommendation requirement does not change any matcher verdict, so unlike the `ham_activity`
 * bars this class did not hide awards — it PUBLISHED a fabricated obligation, quoting a navigation
 * menu back to the applicant as the funder's own words. "Never fabricate: if the eligibility text
 * does not state a requirement, absent is the honest output."
 */
export function extractRecommendation(raw: RawOpportunity): Constraint[] {
  const candidates = candidateTexts([raw.rawFields.Other, raw.rawFields.sponsor], raw.rawText)
    .map(withoutSiteChrome)
    .filter((t) => t.trim() !== '');
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
