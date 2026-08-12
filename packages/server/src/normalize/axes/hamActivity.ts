import type { ActivityKind, Constraint, RawOpportunity } from '@grantspotter/core';
import { candidateTexts, firstClause, splitClauses } from './clauses.js';
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
  // THE FUNDER NAMED IT WITHOUT NAMING THE ACRONYM. ARDC's own list of acceptable proof includes
  // "PARTICIPATION IN AMATEUR RADIO EMERGENCY ACTIVITIES", and `\b(ARES|RACES|SKYWARN)\b` cannot
  // see it — so an ARES/RACES/SKYWARN volunteer was refused the largest programme in the corpus by
  // a list that names exactly what they do. On an allow-list axis a missing spelling is a silent
  // bar (see the note above), and this one was silent on the plainest possible case.
  //
  // THE PARTICIPATION PREFIX IS NOT DECORATION — it is the same guard the club pattern above
  // carries, for the same reason, and it was added after measuring what the bare phrase does. The
  // ARRL Amateur Radio Grants page says
  //
  //     "Grant requests for EMERGENCY COMMUNICATIONS equipment, facilities, or projects WILL NOT
  //      BE CONSIDERED."
  //
  // — a funding RESTRICTION, the exact opposite of an activity the applicant must have performed —
  // and an unguarded `\bemergency communications\b` published it as a required ham activity,
  // quoting that sentence back as the evidence. Requiring participation/activity language within
  // the same clause admits every real case in the corpus (ARDC "participation in … emergency
  // activities", Hodges and K6GO "participating in … activities such as emergency communications",
  // PARC "demonstrate activity and interest in radio service such as emergency communications",
  // MMARSI "demonstrated activity within the several amateur emergency communications programs")
  // and rejects that one, which carries no such language anywhere in its sentence.
  //
  // The acronyms stay CASE-SENSITIVE — "races" is a common English word and this corpus is about a
  // hobby with contests in it — so the whole entry carries no `i` flag and the spelled-out half
  // writes its capitals into character classes rather than living in a second entry that could
  // drift away from this one.
  [
    'ares_races_skywarn',
    /\b(?:ARES|RACES|SKYWARN)\b|\b(?:[Pp]articipat\w+|[Ii]nvolve\w+|[Aa]ctivit\w+|[Aa]ctive|[Vv]olunteer\w+)\b[^.]{0,60}?\b[Ee]mergency\s+(?:[a-z]+\s+)?(?:activit(?:y|ies)|communications?|services?|nets?|preparedness|response|operations?|drills?|exercises?)\b/,
  ],
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

/**
 * AN UNLABELLED PAGE IS NOT AN ELIGIBILITY FIELD.
 *
 * `withoutSiteChrome` removes the MENU. It cannot remove the rest of a marketing page, because
 * marketing prose is punctuated exactly like eligibility prose. The Austin Amateur Radio Club is
 * the case: austinhams.org/scholarships/ files no `Other` and no `eligibility`, so this axis was
 * handed the whole flattened page, and the only clause on it that matched any kind was the HERO
 * STRAPLINE under the headline —
 *
 *     "Supporting Central Texas students who are building the future of technology, public
 *      service, and community."
 *
 * — which published `activityKinds: ["public_service"]` as a HARD bar. `spec.activityKinds` is an
 * allow-list, so that one strapline excluded ALL FIVE individual profiles from a club scholarship
 * whose own "Who can apply" section says "Students pursuing higher education or skilled trades".
 * The club states no amateur-radio activity requirement anywhere on the page; the phrase occurs
 * three more times and every occurrence is a coordinate item in a list of STUDY FIELDS or civic
 * abstractions ("engineering, computer science, public service, healthcare, and more"), never
 * something the applicant must have done.
 *
 * WHY THE OBVIOUS RULES ALL FAILED, and what separates this from the one it kept breaking. A
 * previous round tried to characterise the TEXT — "this is a list, not a requirement", "this
 * sentence is about the funder" — and every such rule also swallowed the ARDC Scholarships'
 *
 *     "Examples: membership in a local or regional club, participation in amateur radio emergency
 *      activities, teaching amateur radio classes, on-the-air activities, …"
 *
 * which is a genuine, funder-stated list of acceptable proof on the largest programme in the
 * corpus, and is ALSO a comma-separated list with no modal verb in it. Lexically the two are the
 * same shape. They differ in PROVENANCE:
 *
 *   - ARDC's sentence is the value of the ARRL catalogue's `Other:` field — a field whose whole
 *     purpose is "the additional things this funder requires of you". Everything in it is
 *     eligibility text by construction, whatever its grammar.
 *   - Austin ARC's strapline came from `candidateTexts`' LAST-RESORT fallback to `raw.rawText`,
 *     which for a source filing no eligibility field is the entire flattened page: masthead, hero,
 *     brochure copy, how-to-apply steps and footer. Nothing in that blob is labelled as anything.
 *
 * So the rule is scoped by provenance, not by wording. When the funder labelled the field, every
 * clause in it is read exactly as before — ARDC, CARA, CWops, MARCO, York, MMARSI and YASME are
 * untouched by this, by construction. When there is NO labelled field and this axis is reading a
 * whole page, a clause may contribute a kind only if it ASSERTS SOMETHING OF THE APPLICANT: it
 * carries an obligation or an eligibility verdict. "Applicant must show proof of on-the-air
 * activity." does; "Supporting Central Texas students who are building the future of technology,
 * public service, and community." does not, and neither does any other clause on that page.
 *
 * This is not a blanket "ignore rawText" — that would lose YLRL-shaped pages, whose real
 * requirements are bullets in exactly this position and which say "Applicant must …". It is the
 * same judgement `ageStage.ts` already makes with FOREIGN_LABEL: an axis may only read out of a
 * surface that is actually about its question.
 *
 * DIRECTION OF ERROR. On an allow-list axis, dropping a kind WIDENS who qualifies. A clause this
 * gate wrongly rejects costs an applicant a requirement they will read on the funder's page
 * anyway; a clause it wrongly accepts hides the award from them with no signal at all. That
 * asymmetry is why the gate is deliberately strict on the unlabelled surface and does not exist
 * on the labelled one.
 */
export const APPLICANT_REQUIREMENT =
  /\b(?:must|shall|requir\w*|eligib\w*|qualif\w*|prerequisite)\b|\bopen (?:only )?to\b|\bapplicants?\s+(?:should|need|needs)\b/i;

/**
 * A RULE ABOUT GROUPS CAN ONLY EVER BITE THE INDIVIDUAL IT IS NOT ABOUT.
 *
 * The ARRL Foundation Special Funds page describes the Victor C. Clark Youth Incentive Fund's
 * mini-grants:
 *
 *   "GROUPS THAT QUALIFY for mini-grants will include, but not be limited to, high school radio
 *    clubs, youth groups, and general-interest radio clubs that sponsor subgroups of young people
 *    or otherwise make a special effort to get them involved in CLUB ACTIVITIES."
 *
 * The subject is GROUPS. The clause passed `APPLICANT_REQUIREMENT` on the word "qualify", the two
 * final words matched the club pattern, and the record published `activityKinds: ['club_member']`
 * as a hard bar. `ham_activity` returns `not_evaluable` for an organisation profile, so that bar
 * could never touch the audience the sentence actually describes — only an INDIVIDUAL student, who
 * it does not describe at all. Measured: a student whose activities are ARES/RACES and Field Day
 * was `ineligible`, sole reason `ham_activity`, on a fund whose sentence sets no condition on an
 * individual's on-air life whatsoever.
 *
 * The funder also says in so many words that the list "will include, BUT NOT BE LIMITED TO" — a
 * one-item allow-list built out of an explicitly non-exhaustive one. Both faults are in the same
 * clause and this removes both, because a clause that states a rule for organisations states no
 * rule for a person, whatever kinds its words happen to contain.
 *
 * WHY IT IS THE SUBJECT AND NOT A KEYWORD. "Club" appears in real individual requirements all over
 * this corpus ("membership in a local or regional club", "participation in college radio clubs"),
 * so the noun cannot be what decides. What decides is that the clause OPENS with the organisation
 * as its grammatical subject — the group is who the sentence is predicating of. A requirement
 * written about the applicant ("Applicant must be a member of a club that…", "Students must
 * demonstrate…") never opens that way and is untouched; measured over the committed fixtures,
 * exactly one clause in the corpus matches this and it is the one quoted above.
 *
 * MULTILINE, because `splitClauses` does not cut on a bare newline: the fund's HEADING sits on the
 * line above ("Victor C. Clark Youth Incentive Fund\nGroups that qualify…"), so the sentence this
 * is about does not start at the beginning of the clause. `^` therefore means start of LINE.
 */
const ORGANISATION_SUBJECT =
  /^(?:[·•▪‣*]\s*)?(?:the\s+|all\s+|any\s+)?(?:groups?|organi[sz]ations?|clubs?|schools?|societies|chapters?|troops?|teams?|entities|institutions?)\b\s+(?:that|which|who|must|will|shall|may|should|are|is|can|receiving|applying|seeking)\b/im;

/**
 * The text this axis is allowed to read a kind out of, chrome already removed. Labelled fields are
 * returned whole (the funder said these are the rules) minus any clause whose subject is an
 * organisation; a whole-page fallback is returned as the subset of its clauses that state a rule
 * ABOUT THE APPLICANT.
 *
 * The organisation gate applies to BOTH surfaces, unlike `APPLICANT_REQUIREMENT`: "this clause is
 * not about a person" is a fact about the sentence, not about how well-labelled the page it sits on
 * is, and this axis has no reading of a group requirement that could ever be right.
 */
function eligibilityTexts(raw: RawOpportunity): string[] {
  const labelled = [raw.rawFields.Other, raw.rawFields.eligibility].some(
    (f) => typeof f === 'string' && f.trim() !== '',
  );
  const candidates = candidateTexts([raw.rawFields.Other, raw.rawFields.eligibility], raw.rawText)
    .map(withoutSiteChrome)
    .filter((t) => t.trim() !== '');
  const clauses = candidates.flatMap(splitClauses).filter((c) => !ORGANISATION_SUBJECT.test(c));
  if (labelled) return clauses;
  return clauses.filter((c) => APPLICANT_REQUIREMENT.test(c));
}

/**
 * A NUMBER LIFTED OUT OF ONE OF SIX ALTERNATIVES IS NOT A FLOOR ON THE AXIS.
 *
 * The CWops Scholarship requires "Demonstrated CW operating ability within the last 24 months …
 * (EXAMPLES INCLUDE BUT ARE NOT LIMITED TO: ARRL Code Proficiency certificate at 15 WPM or higher;
 * successful completion of CWA Basic Level or higher; membership in CWops or HSC or other club
 * where some level of CW proficiency is a requirement for membership; participation in a CW contest
 * where the results have been published; operation in a CW traffic net…; OR achieving any award
 * where all contacts are CW)".
 *
 * "15 wpm" is one clause of ONE of six alternatives, inside a list the funder calls illustrative,
 * and `CW_WPM` made it a numeric bar on the whole axis. Measured on the real record:
 *
 *   cwWpm undefined -> unknown (missing cwWpm)      cwWpm 10 -> INELIGIBLE      cwWpm 20 -> eligible
 *
 * So a student who completed CWA Basic, or belongs to CWops or HSC, or has published CW-contest
 * results, or holds a CW-only award — every one of them named by the funder — was refused for
 * answering the speed question honestly with a number under 15. Answering a profile question
 * MANUFACTURED the exclusion, which is the thing `geo.ts`'s `radiusIsMeasurable` says must never
 * happen.
 *
 * WHY THE FLOOR STAYS AND AN ALTERNATIVE IS ADDED INSTEAD. Deleting the number would say the funder
 * asked for nothing, and 20 wpm really is the route they named first, so it should still read as a
 * pass. What is missing is the other five routes, and not one of them is a field `StudentProfile`
 * holds — there is no value of any input that means "I finished CWA Basic". That is precisely
 * `ConstraintAlternatives.orUnrepresented`: the tier stands, and when it fails the answer is
 * `unknown` with nothing to fill in, never a refusal quoting a sentence that invites them.
 *
 * SCOPED TO AN OPEN LIST, and it has to be. A funder who states a speed and nothing else ("must be
 * able to copy CW at 5 wpm") has named ONE route and means it; that floor must keep refusing, or
 * this becomes a licence to soften every number in the corpus. The trigger is the funder's own
 * words saying their list is illustrative, quoted verbatim into the spec as the evidence.
 */
const OPEN_PROOF_LIST =
  /\bexamples?\b[^.]{0,40}?\b(?:include|are|such as)\b|\bincluding,? but not\b|\bnot (?:be )?(?:necessarily |strictly |solely )?limited to\b|\bsuch as\b/i;

function unrepresentedProofRoutes(clause: string): string | undefined {
  const marker = OPEN_PROOF_LIST.exec(clause);
  return marker === null ? undefined : clause.slice(marker.index).trim();
}

export function extractHamActivity(raw: RawOpportunity): Constraint[] {
  const candidates = eligibilityTexts(raw);
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
  // Only a NUMBER can fail here once the funder has opened their own list: `funderOpenedTheList`
  // already stops an illustrative `activityKinds` list from gating, so the wpm floor is the one
  // route left that can refuse anybody, and it is the only one that needs the other routes recorded
  // beside it. Asked only when there IS a floor, so no other record in the corpus gains the field.
  const orUnrepresented = cw ? unrepresentedProofRoutes(clause) : undefined;
  return [
    makeConstraint(
      'ham_activity',
      clause,
      {
        axis: 'ham_activity',
        activityKinds,
        ...(cw ? { cwProficiencyWpmMin: Number.parseInt(cw[1], 10) } : {}),
        proofRequired: /\b(documented|documentation|proof|certificate|verified)\b/i.test(clause),
        ...(orUnrepresented !== undefined ? { orUnrepresented } : {}),
      },
      0,
    ),
  ];
}
