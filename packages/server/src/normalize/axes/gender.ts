import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { firstClause } from './clauses.js';
// The shared "a link label is not a sentence" filter, imported rather than re-derived — see
// citizenship.ts / recommendation.ts for why there is exactly one copy of it.
import { withoutSiteChrome } from './hamActivity.js';
import { makeConstraint } from './preference.js';

const FEMALE = /\b(women|woman|females?|YL|young lad(?:y|ies))\b/i;

/**
 * THIS AXIS READS ONLY A FIELD THE FUNDER LABELLED AS ELIGIBILITY.
 *
 * Every other axis here falls back to `raw.rawText` — the whole flattened page for a source that
 * files no structured field this axis knows. This one does not, and the reason is measured rather
 * than assumed.
 *
 * ALL FIVE legitimate gender constraints in the corpus are the value of a labelled field:
 *
 *   YLRL Ethel Smith K4LMB       `eligibility` = "Applicant must be female. Applicant must have an
 *   YLRL Mary Lou Brown NM7N      Amateur Radio License."
 *   YLRL Marte Wessel K0EPE
 *   YLRL Scholarships (umbrella) `eligibility` = "Applicant must be female."
 *   ARRL Helen Laughlin AM Mode  `Other` = "Preference is given to women Amateur Radio operators
 *                                 who are performing at a high academic level. …"
 *
 * THE ONE fabricated constraint was the only one read off an unlabelled page. IEEE MTT-S Chapter
 * Support files `summary`, `deadline`, `amount`, `requirements`, `workshopFund`, `travelSupport`
 * and `formUrl` — no eligibility field this axis looks at — so it fell through to mtt.ieee.org's
 * whole flattened page and published HARD `{allowed: ["female"]}` off the site's navigation column:
 *
 *     … Broadening Participation Committee · Mentor–Mentee Initiative ·
 *     Women in Microwaves (WiM) · Special Interest Group on Humanitarian Technology (SIGHT) …
 *
 * `withoutSiteChrome` removes that menu, but NOT the two prose sentences further down the same
 * page — "Women in Microwaves (WiM) – is the subset of Women in Engineering (WIE) working within
 * the field of microwave engineering and typically active within the MTT society." and "Funding
 * applications can be made through the Affinity Funding form, selecting Women in Microwaves as the
 * funding program." Both are punctuated exactly like eligibility prose. "Women in Microwaves" is
 * the NAME OF A SUBCOMMITTEE; MTT-S chapter support is open to every active chapter, and a
 * `female`-only bar excluded every male applicant from it.
 *
 * WHY THE STRICTEST FORM OF THE PROVENANCE RULE, on this axis alone. `spec.allowed` is an
 * allow-list the matcher enforces as a hard bar, and gender is the one axis in this corpus whose
 * bar excludes an applicant on something they cannot change. It is also where a fabrication does
 * double damage: the corpus contains three GENUINE women-only ham scholarships (YLRL's), and a
 * spurious fourth both excludes people wrongly and devalues the real ones. An organisation name
 * containing "Women" is common enough on engineering-society pages that the softer gate
 * `hamActivity.ts` uses on ITS unlabelled surface — "does this clause assert something of the
 * applicant?" — would not hold here: "Chapters affiliated with Women in Microwaves must submit …"
 * carries a modal verb and would fabricate the bar all the same.
 *
 * WHAT IT GIVES UP, stated rather than hidden: a funder who states a gender scope ONLY in
 * unlabelled page prose ("This scholarship is open only to women.") now yields no constraint.
 * There is no such funder in the corpus. The error that costs is a FALSE INCLUDE — the award is
 * shown to someone it is not for, who reads the funder's own page and self-corrects. The error it
 * prevents is a FALSE EXCLUDE, which hides the award permanently with no signal at all.
 *
 * `withoutSiteChrome` is still applied to the labelled fields. It is a no-op on all five above
 * (dropping anything takes four consecutive lines carrying neither "." nor ":", which only a menu
 * produces), and it keeps "no published rawText contains site chrome" true on this axis by
 * construction rather than by luck.
 */
export function extractGender(raw: RawOpportunity): Constraint[] {
  const labelled = [raw.rawFields.eligibility, raw.rawFields.Other]
    .filter((f): f is string => typeof f === 'string' && f.trim() !== '')
    .map(withoutSiteChrome)
    .filter((t) => t.trim() !== '');
  // Anchored on the same pattern as the gate, so the extracted clause is always the one that
  // actually states the gender scope. The old sentence regex spelled a SHORTER list than the gate
  // ("women|woman|female|YL" — no "females", no "young ladies"), so a record gated in on one of
  // the missing spellings fell through to the whole flattened record as its rawText. Gender is
  // the one axis here whose hard/soft reading can bar an applicant on something they cannot
  // change, so the rawText that decides it must be the funder's own sentence, nothing else.
  const clause = firstClause(labelled, FEMALE);
  if (clause === undefined) return [];
  return [makeConstraint('gender', clause, { axis: 'gender', allowed: ['female'] }, 0)];
}
