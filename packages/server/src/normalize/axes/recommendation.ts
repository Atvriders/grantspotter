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

/**
 * WORD SENSE, NOT SITE CHROME.
 *
 * The fabrications left on this axis after the chrome guard survived it because the text they came
 * from IS the funder's own eligibility-shaped prose, punctuated and labelled like any requirement.
 * The words simply do not mean what `SIGNAL` assumes they mean. `SIGNAL` is a bag of four single
 * terms, and every one of them carries a second, entirely ordinary sense on funder pages:
 *
 *   "reference"     a MENTION, not a referee.
 *   "recommendation" published GUIDANCE, not a letter about the applicant.
 *   "sponsor"       money — the funder's own backers, a fiscal pass-through, or a verb the
 *                   applicant PERFORMS — rather than somebody vouching for the applicant.
 *
 * The two senses are split two different ways, because they are not equally common.
 *
 * ── "recommendation" is admitted BY FRAME, not excluded by exception ──────────────────────────
 *
 * On the pages this corpus captures, published guidance is the DOMINANT sense of the word. ARRL's
 * ETP Grants page carries an ARISS technical appendix that uses it three times, none of them a
 * letter:
 *
 *     "…you will need to research the current ARISS RECOMMENDATIONS TO get a listing of the radio
 *      power and frequency step resolution suggestions and station configuration RECOMMENDATIONS
 *      SET BY the ARISS program."
 *     "These RECOMMENDATIONS ARE more elaborate than needed for a casual FM satellite contact…"
 *
 * Excluding those one spelling at a time was tried and measured: neutralising "recommendations to"
 * left the constraint standing on the second occurrence in the same sentence, and neutralising
 * "recommendations set by" as well simply re-anchored it onto the third sentence. A rule that has
 * to be extended once per sentence is not a rule.
 *
 * The letter sense, by contrast, has a fixed shape everywhere in this corpus: it is a DOCUMENT
 * ABOUT THE APPLICANT, so it is either "letter(s) of recommendation", or it names who wrote it —
 * "recommendation FROM a sitting officer", "two counselor or TEACHER recommendations". So the word
 * counts as this axis's signal only inside one of those frames, and every other use of it is
 * dropped before `SIGNAL` is tested. All five corpus constraints that rest on this word carry a
 * frame; none of the three ETP sentences does.
 *
 * WHAT THAT GIVES UP, stated rather than hidden: a funder who writes the bare "Applicant must
 * provide three recommendations." — no "letters of", no "from", no person named — now yields
 * nothing. No capture in this corpus does that. The error it accepts is a FALSE INCLUDE, which the
 * applicant corrects by reading the funder's page; the error it prevents is a fabricated
 * obligation published in the funder's own voice.
 *
 * ── "reference" and "sponsor" are admitted BROADLY and excluded by NAMED SENSE ────────────────
 *
 * These two go the other way: their letter sense is the common one and their other senses are a
 * short, closed list, each one an actual capture.
 *
 *   NCDXF Grant Program   "Expeditions to unusual locations as defined by the Islands on the Air
 *                         (IOTA) program, Grid Square awards and various radio contests are not
 *                         supported unless the support can be justified WITHOUT REFERENCE TO these
 *                         activities."
 *                         "Reference" = mention. Read as a recommendation requirement it is wrong
 *                         twice over, because the clause is also a NEGATION: NCDXF is describing
 *                         what it will not fund, not something an applicant must supply.
 *
 *   ARISS ISS Contact     "ARISS appreciates OUR PARTNERS AND SPONSORS: National Amateur Radio
 *                         Societies and AMSAT Organizations…"
 *                         `AWARD_IS_SPONSORED` above already guards the linking-verb spelling of
 *                         this ("This Scholarship is sponsored by the West Allis Radio Amateur
 *                         Club"); a possessive is the same statement in another grammar. Whose
 *                         money it is has never been a requirement on the applicant.
 *
 *   IEEE MTT-S Chapter    "A SPONSORSHIP REQUEST usually requires a detailed description and
 *   Support               mandatory post-event reporting."
 *                         The applicant is the party SEEKING sponsorship — that is the award
 *                         itself. Real obligations, but not a letter about anybody.
 *
 *   ARRL Foundation       "Groups that qualify for mini-grants will include, but not be limited
 *   Special Funds         to, high school radio clubs, youth groups, and general-interest radio
 *                         clubs THAT SPONSOR subgroups of young people…"
 *                         "Sponsor" as a verb whose subject is the applicant itself. A sponsorship
 *                         the applicant PERFORMS is not one the applicant must OBTAIN.
 *
 *   ARDC Grants           "Radio clubs and groups who are NOT nonprofits, as well as individual
 *                         applicants, are not eligible for a grant UNLESS THEY HAVE A NONPROFIT
 *                         FISCAL SPONSOR."
 *                         A fiscal sponsor is a 501(c)(3) that RECEIVES THE GRANT MONEY for an
 *                         unincorporated applicant; nobody writes a letter. Like the NCDXF
 *                         sentence this is an EXCEPTION ("unless…"), so the reading also inverts
 *                         its polarity — the sentence WIDENS who may apply. `ardc-grants.ts`
 *                         independently keeps this prose out of `rawText` (it stays visible to the
 *                         reader through `rawOtherText`); the two fixes overlap deliberately, one
 *                         choosing which surface the sentence belongs on and this one making the
 *                         axis right wherever it reads it.
 *
 * Both halves work by NEUTRALISING the non-letter occurrences and re-testing `SIGNAL` on what is
 * left, never by vetoing the whole clause: a clause may state a genuine requirement AND mention
 * something else, and dropping it wholesale would trade one fabrication for one omission.
 */
const NOT_A_LETTER_SENSE: RegExp[] = [
  /(?<!\bletters?\s+of\s+)\breferences?\s+to\b/gi,
  /\b(?:our|its|their)\s+(?:[\w-]+\s+and\s+)?sponsors?\b/gi,
  /\bsponsorship\s+(?:request|application|proposal)s?\b/gi,
  /\b(?:who|that|which)\s+sponsors?\b/gi,
  /\bfiscal(?:ly)?[\s-]+sponsor(?:s|ed|ship)?\b/gi,
];

/**
 * The three shapes in which "recommendation" means a document about the applicant. Anything else
 * the word is doing in a clause is guidance, and is not this axis's business.
 */
const RECOMMENDATION_IS_A_LETTER =
  /\bletters?\s+of\s+recommendations?\b|\brecommendations?\s+(?:from|by)\b|\b(?:counsel(?:l)?ors?|teachers?|instructors?|professors?|faculty|officers?|employers?|supervisors?|mentors?|principals?|advis[eo]rs?)\s+(?:(?:or|and)\s+\w+\s+)?recommendations?\b/i;

function inLetterSense(clause: string): boolean {
  let remaining = clause;
  for (const sense of NOT_A_LETTER_SENSE) remaining = remaining.replace(sense, ' ');
  if (!RECOMMENDATION_IS_A_LETTER.test(remaining)) {
    remaining = remaining.replace(/\brecommendations?\b/gi, ' ');
  }
  return SIGNAL.test(remaining);
}

/**
 * THE FUNDER'S OWN HEDGE — "SUCH AS", "SUCH ITEMS AS", "INCLUDING BUT NOT LIMITED TO".
 *
 * A signal word that survives only INSIDE a list the funder opened is an EXAMPLE, not a
 * requirement of this record. Two records in this corpus are made entirely of that shape, and both
 * were published as a hard bar:
 *
 *   ARRL Foundation        "A NUMBER OF scholarships require additional documents, SUCH AS a letter
 *   Scholarship Program     of recommendation from a sitting Officer of an ARRL-affiliated club."
 *                           Two hedges in one sentence: the subject is SOME OTHER AWARDS in the
 *                           family, and the letter is an example of "additional documents". This
 *                           record is the deadline owner for 112 catalogue entries — the front door
 *                           — and a hard `recommendation` was its ONLY constraint, so a rule in
 *                           `matcher.ts` read it as a record where nothing had been checked and
 *                           answered `unknown` to every student, in every state.
 *   ARRL Foundation        "An applicant for a mini-grant must write a brief, but complete proposal
 *   Special Funds           INCLUDING SUCH ITEMS AS: * Names, call signs …, addresses and telephone
 *                           numbers of SPONSORS * Objectives of the proposed program …" The signal
 *                           is the word "sponsors" inside an illustrative list of things a PROPOSAL
 *                           should contain. Nobody writes a letter about the applicant here.
 *
 * THIS PROJECT ALREADY DECIDED THIS SENTENCE, AND DECIDED IT THE OTHER WAY. `data/seed/
 * programs.curated.json` — the hand-reviewed record of the same programme — carries the ARRL
 * Foundation sentence verbatim as `hard: false`, on the `other` axis, with the reviewer's note:
 * "Some catalogue entries require a recommendation from a sitting officer of an ARRL-affiliated
 * club. WHICH ONES IS AN ENTRY-LEVEL FACT, NOT A PROGRAMME-LEVEL ONE." The crawl-side extractor
 * disagreed with the product's own reviewed data about the same sentence on the same page.
 *
 * SOFT, NOT DELETED, and the difference is the point. The funder did write the sentence and an
 * applicant needs to read it; dropping the constraint takes it off the eligibility report, which
 * is the one thing this product promises to show (`matcher.ts` makes exactly that argument about
 * The Free Family). A soft constraint is displayed, bars nobody, and — because this axis is
 * `not_evaluable` by construction — is never counted as a preference anybody met either. It is
 * also the direction `preference.ts` says to take a doubt: "a false negative here converts a
 * stated preference into a hard bar … a false positive merely softens a real requirement."
 *
 * IT IS THE SPAN THAT IS NEUTRALISED, NOT THE CLAUSE — the same mechanism as `inLetterSense`
 * above, and for the same reason: a clause may open an illustrative list AND state a real
 * requirement outside it. The CWops award writes "…or A LETTER FROM a person responsible for
 * membership (Examples include but are not limited to: …)": the signal is in front of the marker,
 * survives the cut, and that constraint stays hard.
 */
const FUNDER_OPENED_THE_LIST =
  /\bsuch\s+(?:[\w-]+\s+){0,2}?as\b|\bincluding,?\s+but\s+not\b|\bnot\s+(?:be\s+)?limited\s+to\b|\bexamples?\s+(?:include|are)\b|\bfor\s+example\b|\be\.g\./i;

function signalIsOnlyAnExample(clause: string): boolean {
  const marker = FUNDER_OPENED_THE_LIST.exec(clause);
  if (marker === null) return false;
  return !SIGNAL.test(clause.slice(0, marker.index));
}

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
    // Every SIGNAL word in this clause carries a sense other than "a letter about the applicant".
    if (!inLetterSense(clause)) continue;
    const countMatch = COUNT.exec(clause);
    const count = countMatch
      ? (WORD_COUNT[countMatch[1].toLowerCase()] ?? Number.parseInt(countMatch[1], 10))
      : 1;
    const constraint = makeConstraint(
      'recommendation',
      clause,
      { axis: 'recommendation', recommenderType: recommenderTypeFrom(clause), count },
      0,
    );
    // The funder's sentence is kept and shown; only its FORCE is withdrawn, because the funder
    // withdrew it themselves. See `signalIsOnlyAnExample`. `makeConstraint` is the shared
    // hard/soft classifier and reads preference VOCABULARY ("preferred", "should", "may"); an
    // illustrative list is a different way of not requiring something, and it is this axis's own
    // reading of its own signal, so it is applied here rather than by widening that classifier
    // for every axis at once.
    return [signalIsOnlyAnExample(clause) ? { ...constraint, hard: false } : constraint];
  }
  return [];
}
