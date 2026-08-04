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

/**
 * SITE CHROME IS NOT ELIGIBILITY TEXT.
 *
 * `candidateTexts` falls back to `raw.rawText`, and for a source that files no `Other` /
 * `eligibility` field that is THE WHOLE FLATTENED PAGE — masthead, navigation column, mega-footer
 * and all. `spec.activityKinds` is an allow-list the matcher enforces, so any kind matched off a
 * menu link becomes a HARD BAR. Eight programs carried one:
 *
 *   YLRL Scholarships          `contesting` + `proofRequired` off "Contests/Certificates ·
 *                              Contests · Contest Submission" in the site menu. YLRL's awards are
 *                              for licensed FEMALE hams and its own bullets say nothing about
 *                              contesting, so the corpus was hiding a women-only ham scholarship
 *                              from licensed women because of a nav link.
 *   Austin ARC                 `field_day` off the menu item "Events Calendar · Field Day".
 *   the five ARRL org pages    ALL SIX kinds off "Clubs · Contests · Licensing Classes · On The
 *                              Air · Public Service" — the arrl.org global nav and mega-footer.
 *   IEEE Student Branch Rebate `contesting` off ieee.org chrome.
 *
 * The rule, and why it is safe in an axis where narrowing an allow-list EXCLUDES people: a
 * navigation menu is a RUN of link labels, and a link label is not a sentence — it carries no "."
 * and it is not a "Label: value" field either. A funder's requirement is one or the other
 * everywhere in this corpus (the ARRL catalogue's flattened "Other: …" record, YLRL's "· Applicant
 * must …" bullets, every prose page). So a maximal run of `CHROME_RUN_MIN` or more consecutive
 * lines carrying neither is menu, not eligibility, and is dropped before any kind is matched.
 *
 * The RUN is what makes it safe. A short field value that happens to look like a label
 * ("Region: Any", "Must be a member of ARRL") stands alone or among labelled lines, so it is never
 * inside a run and is never dropped; it takes four consecutive label-shaped lines — which only a
 * menu produces — to remove anything. "?" and "!" deliberately do NOT count as sentence marks:
 * arrl.org's footer says "Having Trouble?" and "Newly licensed?", which are links.
 *
 * The licence detector was hardened against exactly this chrome already
 * (`licenseFloorContract.test.ts`, "does not fire on the site navigation that shares its
 * vocabulary"); this is the same surface, on the axis that was left unguarded. It lives here
 * rather than in `clauses.ts` because it is a judgement about what counts as ELIGIBILITY text,
 * which is the axis's question, not the splitter's.
 */
const CHROME_RUN_MIN = 4;

function isChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  return !trimmed.includes('.') && !trimmed.includes(':');
}

export function withoutSiteChrome(text: string): string {
  const lines = text.split('\n');
  const keep = lines.map(() => true);
  let runStart = 0;
  for (let i = 0; i <= lines.length; i += 1) {
    if (i < lines.length && isChromeLine(lines[i])) continue;
    if (i - runStart >= CHROME_RUN_MIN) for (let j = runStart; j < i; j += 1) keep[j] = false;
    runStart = i + 1;
  }
  return lines.filter((_, i) => keep[i]).join('\n');
}

export function extractHamActivity(raw: RawOpportunity): Constraint[] {
  const candidates = candidateTexts([raw.rawFields.Other, raw.rawFields.eligibility], raw.rawText)
    .map(withoutSiteChrome)
    .filter((t) => t.trim() !== '');
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
