import type { Constraint, ConstraintSpec } from '@grantspotter/core';
import { splitClauses } from './clauses.js';

/**
 * Biased toward detecting a preference, not away from it: a false negative here converts a
 * stated preference into a hard bar on whichever axis the sentence describes (this is the
 * shared classifier every axis extractor calls), while a false positive merely softens a real
 * requirement. The asymmetry is deliberate — see the plural-audit report for the corpus-wide
 * hard/soft delta this produced.
 */
const PREFERENCE =
  /\b(?:preferences?|preferred|preferential(?:ly)?|prefers?|preferably|priority|favou?r(?:ed|s|ing)?|considered first|first consideration|is given to|encouraged)\b/i;
/** Same pattern, scanning: `exec` returns the LEFTMOST match, which is where a preference's scope opens. */
const PREFERENCE_SCAN = new RegExp(PREFERENCE.source, 'gi');
const CASCADE = /\bif no (?:other )?qualified applicant/i;

/**
 * MODAL VERBS — "should" is not "must".
 *
 * RFC 2119 spells the convention the English language already had, and it is exactly how the
 * volunteers who write these pages use the words: MUST / SHALL / REQUIRED state a requirement,
 * SHOULD / MAY / RECOMMENDED / OPTIONAL state a recommendation. The preference vocabulary above
 * knows the NOUN family ("preference", "preferably", "encouraged") and knew none of the modals, so
 * a funder who wrote its recommendation the ordinary English way had it published as a bar:
 *
 *   MARCO  "1) Applicants SHOULD be able to describe how they have engaged in volunteer and/or
 *           public service activities making use of Amateur Radio."
 *   York   "Applicants SHOULD describe how they have engaged iin volunteer and/or public service
 *           activities making use of amateur radio."
 *
 * `spec.activityKinds` is an allow-list the matcher enforces, so both awards were `ineligible` on
 * `ham_activity` for EVERY licensed individual profile — a hard bar built out of the word
 * "should". A third, ECARS, states its age band the same way and is widened in the same breath:
 * "Applicant should generally be between the ages of 17 and 25 …, BUT OLDER APPLICANTS RETRAINING
 * IN A CHANGING JOB MARKET WILL BE CONSIDERED."
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *  - `recommend\w*`. The stem looks like the obvious member of this family and is the single most
 *    dangerous string in this corpus: eight hard constraints across six programs carry "letter(s)
 *    of recommendation" or "counselor or teacher recommendations", where it is a NOUN naming a
 *    document the funder REQUIRES ("Three letters of recommendation must be provided"). A stem
 *    match would soften all of them. There is no occurrence of "is/are recommended" anywhere in
 *    the corpus, so the participle buys nothing and the stem costs eight requirements.
 *  - negated or restricted `may`. "may not", "may never", "may only" are a prohibition or a
 *    narrowing, not a permission — "Applicants may not be related to a director" is a bar. Only
 *    bare permissive `may` is a recommendation marker.
 *  - `should not`, by contrast, IS still soft: RFC 2119's SHOULD NOT is a recommendation against,
 *    not a prohibition, and softening it errs toward the recoverable direction anyway.
 */
const RECOMMENDATION_MODAL_SCAN = /\b(?:should|might|ought\s+to)\b|\bmay\b(?!\s+(?:not|never|no|only)\b)/gi;

/**
 * The requirement half of the same convention, used ONLY to stop a recommendation reaching back
 * over a requirement (see `preferenceScope`). It never makes anything soft, so a false positive
 * here costs nothing but a slightly narrower preference scope.
 */
const REQUIREMENT_MODAL = /\b(?:must|shall|required)\b/i;

/**
 * WHOSE OBLIGATION IS BEING RELAXED. A modal only means "this is a recommendation to the
 * applicant" when the applicant is what it is talking about.
 *
 * Unlike the preference NOUNS above — "preference", "priority", "favoured" are selection
 * vocabulary and are about applicants by construction — "should" and "may" are general-purpose
 * English that these pages also use for administration and procedure. The corpus contains exactly
 * one such sentence and it is a licence floor:
 *
 *   QCWA  "APPLICATIONS should be requested by interested licensed radio amateurs on or after
 *          October 31 of each year from the ARRL Foundation Committee."
 *
 * The subject is the APPLICATION, not the applicant; "licensed radio amateurs" is an oblique
 * phrase describing who does the requesting, not something the "should" makes optional. Softening
 * that sentence deletes QCWA's licence floor entirely and hands the award to an unlicensed
 * applicant — `licenseFloorContract.test.ts` RULE A and RULE B both catch it, which is the
 * invariant doing its job.
 *
 * This gate can only ever soften LESS than it would without it, and it can never harden anything
 * that is soft today, so it cannot introduce a false exclude relative to the behaviour it
 * replaces. That is what makes it the safe side of the ambiguity to sit on, notwithstanding the
 * general "when in doubt, soft" rule — the doubt here is resolved by the funder's own subject.
 *
 * The pronouns are in the list on purpose. A page that addresses the reader ("You should be able
 * to describe…") or carries the subject across a sentence ("Applicants must submit an essay. They
 * should describe…") is naming the applicant just as plainly as the nouns are, and leaving them
 * out is the false-exclude direction — which is the one the applicant gets no signal about.
 *
 * `hamActivity.ts` already reaches for the same anchor in `APPLICANT_REQUIREMENT`
 * (`\bapplicants?\s+(?:should|need|needs)\b`); this is that judgement, shared.
 */
const APPLICANT_SUBJECT =
  /\b(?:applicants?|candidates?|students?|recipients?|awardees?|nominees?|entrants?|winners?|scholars?|you|he|she|they)\b/i;

/**
 * "…if no qualified applicant is identified…", "…if no suitable applicant found…", "…if there is
 * no applicant from the preferred areas…". A span that opens with one of these does not state a
 * requirement: it states what happens when the preferred pool is empty, which is the funder
 * saying out loud that the preceding criterion is NOT a bar.
 *
 * Wider than `CASCADE` on purpose, and used only here. `CASCADE` decides the PUBLISHED
 * `fallbackRank` value, so widening it would move data that is already pinned; this one only
 * decides whether a span counts as a requirement, where the safe direction is to recognise more
 * fallbacks, not fewer.
 */
const FALLBACK_CONDITION =
  /^(?:and\s+|but\s+|then\s+)*(?:if|should|unless|when)\s+(?:there\s+(?:is|are)\s+)?(?:no|none|not)\b/i;

/**
 * How many words a span must carry before it counts as a statement of its own. Below this the
 * span is the connective tissue a preference hangs off — "First" (NEAR-Fest's "First Preference
 * given to Extra Class"), "1)", "Second", "and". Three is not tuned to one entry: this corpus
 * produces the SAME set of hard/soft outcomes for any threshold from 2 to 4, so nothing here
 * balances on the exact number.
 */
const MIN_REQUIREMENT_WORDS = 3;

/**
 * Punctuation and function words that ATTACH a preference to what precedes it rather than being
 * part of the requirement — "Any class of active Amateur Radio license WITH preference for basic
 * Morse code capability" (Carole Streeter). Stripped off the tail of an ungoverned span before it
 * is judged, so the span is weighed on the funder's actual requirement and not on the hinge.
 */
const TRAILING_HINGE = /(?:[\s,;:.(–—-]|\b(?:a|an|the|with|and|or|of|for|in|to|by|as|any|but)\b)+$/i;

/**
 * WHERE A PREFERENCE'S SCOPE OPENS. English states a preference in two positions and they scope
 * in OPPOSITE directions:
 *
 *   PREDICATE — "Applicants with two letters of recommendation are preferred", "Applicants from
 *   Louisiana will be given priority", "Regional preferences are considered in the review". Every
 *   content word sits in FRONT of the marker and the clause still states one thing: a preference.
 *   Scoping forward from the marker here would leave "Applicants with two letters of
 *   recommendation" behind and publish it as a requirement — a bar the funder never stated.
 *
 *   HINGED — "…for two years, preference for General Class" (Holt), "…Amateur Radio license with
 *   preference for basic Morse code capability" (Streeter), "Minimum 2.5 GPA on a 4.0 scale;
 *   preference given to need and higher GPA" (IRARC). A comma, colon, "with", "and" or an article
 *   hands the preference off from a statement that is already complete, and the preference scopes
 *   forward over the remainder.
 *
 * So a marker scopes forward only when a hinge introduces it; otherwise it governs its whole
 * segment. This is what keeps the fix from over-hardening the far more common predicate form,
 * which is most of the preference language in this corpus.
 *
 * "(" is deliberately NOT a hinge. A parenthesis after a phrase ANNOTATES that phrase — "ARRL
 * South Texas Section (first preference); The State of Texas (second preference); ARRL West Gulf
 * Division (third preference)" (Robert A. Rodriguez K5AUW) is a ranked preference list, and
 * treating "(" as a hand-off would read each ranked area as a requirement and publish the third
 * preference as a bar.
 */
const HINGE_BEFORE = /(?:[,:–—-]|\b(?:with|and|or|but|a|an|the)\b)\s*$/i;

/**
 * Belt and braces on the same asymmetry: a span that ends in a bare copula once its hinge is
 * stripped is a sentence whose missing predicate IS the preference ("…recommendation are"), never
 * a requirement. Only ever softens, so it cannot erase a floor.
 */
const COPULA_TAIL = /\b(?:is|are|was|were|am|be|been|being|remains?|seems?)$/i;

/**
 * A sentence split into the part a preference GOVERNS and the part it does not.
 *
 * The scope of "…preference for General Class" is the preference marker and everything after it
 * inside the same clause — never the text in front of it, and never a neighbouring clause. That
 * boundary is the whole point: three ARRL entries state a requirement and a preference in one
 * captured field, and softening the field wholesale deleted the requirement half.
 *
 *   Holt      "Any active Amateur Radio License Class for two years, | preference for General Class"
 *   Streeter  "Any class of active Amateur Radio license with | preference for basic Morse code…"
 *   NEAR-Fest "First | Preference given to Extra Class, …Technician Class." ‖
 *             "Applicants must have held an amateur radio license for a minimum of one year…"
 *
 * Clause boundaries come from `clauses.ts` rather than a private splitter, so this shares the
 * decimal/abbreviation safety ("3.0", "U.S.", "St. Louis") every other axis already relies on —
 * `splitClauses` is what keeps NEAR-Fest's second sentence a clause of its own instead of a
 * fragment cut at "date of application."
 *
 * Each clause is then cut again at ";". `splitClauses` deliberately does NOT split there, because
 * one requirement is often stated across a semicolon and truncating it loses half. A preference's
 * SCOPE is a different question, and it does not cross one: "Preference given to applicants
 * residing in Illinois; Applicant must be a resident of the ARRL Central Division" (Francis
 * Walton) states a preference and then a requirement, and the semicolon is the only thing marking
 * the boundary.
 */
export interface PreferenceScope {
  /** What the preferences cover: a hinged marker's span onward, or a whole predicate segment. */
  governed: string[];
  /** Everything else: the text before a hinged marker, and every segment carrying no marker. */
  ungoverned: string[];
}

/**
 * The spans a preference is judged over: every clause, cut again at ";" (see the interface doc).
 * Shared so `statesFallback` asks its question of exactly the same spans `preferenceScope` does —
 * a private second segmentation here is how the two answers would drift apart.
 */
function segmentsOf(text: string): string[] {
  return splitClauses(text).flatMap((clause) => clause.split(';'));
}

/**
 * The leftmost offset in `segment` at which a preference's scope opens, or -1 for none.
 *
 * Two vocabularies, one answer. A preference NOUN opens a scope wherever it appears; a
 * RECOMMENDATION MODAL opens one only where the applicant is what it is talking about (see
 * `APPLICANT_SUBJECT`), so the scan walks the modals and takes the first that qualifies rather
 * than the first that matches.
 */
function markerIndexOf(segment: string): number {
  PREFERENCE_SCAN.lastIndex = 0;
  const noun = PREFERENCE_SCAN.exec(segment);
  RECOMMENDATION_MODAL_SCAN.lastIndex = 0;
  let modalIndex = -1;
  for (
    let m = RECOMMENDATION_MODAL_SCAN.exec(segment);
    m !== null;
    m = RECOMMENDATION_MODAL_SCAN.exec(segment)
  ) {
    if (APPLICANT_SUBJECT.test(segment.slice(0, m.index))) {
      modalIndex = m.index;
      break;
    }
  }
  if (noun === null) return modalIndex;
  if (modalIndex < 0) return noun.index;
  return Math.min(noun.index, modalIndex);
}

export function preferenceScope(text: string): PreferenceScope {
  const governed: string[] = [];
  const ungoverned: string[] = [];
  for (const segment of segmentsOf(text)) {
    const markerIndex = markerIndexOf(segment);
    if (markerIndex < 0) {
      ungoverned.push(segment);
      continue;
    }
    const before = segment.slice(0, markerIndex);
    // A RECOMMENDATION NEVER REACHES BACK OVER A REQUIREMENT. "Applicants must hold a valid
    // licence and should be active in public service" is one sentence stating two different
    // things, and the mixed form is common here — the North Texas Bob Nelson entry says
    // "Applicant must have graduated high school located within the North Texas Section, and may
    // attend college or university in this section." A hinge ("and", ",") already hands the
    // preference forward in both of those; this is the same rule where the funder wrote no hinge
    // ("Applicants must submit a form that may be downloaded online"), and it only ever narrows
    // what a preference governs, so it cannot erase one.
    if (before.trim() !== '' && !HINGE_BEFORE.test(before) && !REQUIREMENT_MODAL.test(before)) {
      // Predicate position: the preference is what this segment says, start to finish.
      governed.push(segment);
      continue;
    }
    ungoverned.push(before);
    governed.push(segment.slice(markerIndex));
  }
  return { governed, ungoverned };
}

/**
 * Does the funder state, IN ITS OWN WORDS, that the criterion beside this one does not exclude?
 *
 * A span that OPENS with a fallback condition — "if no suitable applicant identified, applicants
 * from all regions will be considered" (CTRI/Chris Seeber KA1GEU), "If no qualified appilcant,
 * award given regardless of the field of study" (North Fulton, funder's typo and all) — is the
 * funder widening its own eligibility. Reading it as a restriction inverts the sentence: CTRI's
 * region was published as a hard bar on every applicant outside six states, by an award whose
 * page says region excludes nobody.
 *
 * This is `CASCADE`'s rule applied to the family `CASCADE` cannot spell. `CASCADE` matches one
 * exact wording, "if no (other) qualified applicant", anywhere in the text; this matches the
 * whole family, but only where a span BEGINS with it, which is what keeps "…various radio
 * contests are not supported unless the support can be justified…" (NCDXF, a restriction with
 * "unless" in the middle) from being read as a widening.
 *
 * WHY IT IS CHECKED BEFORE THE PREFERENCE-WORD GATE. `isPreferenceText` used to open with
 * `if (!PREFERENCE.test(text)) return false`, so a funder had to use the WORD "preference" before
 * any of this ran at all — which made `CASCADE` and `FALLBACK_CONDITION` unreachable for every
 * fallback stated without it, and North Fulton proves the mechanism inside a single record: its
 * Region field says "…If no qualified applicant, PREFERENCE will be awarded…" and comes out soft,
 * its Field of Study field says "…If no qualified appilcant, award given regardless…" — the same
 * semantics, no preference word — and came out hard.
 */
function statesFallback(text: string): boolean {
  return segmentsOf(text).some((s) => FALLBACK_CONDITION.test(s.replace(/^[\W_]+/, '')));
}

/** Does this span, on its own, state something the funder requires? */
function statesRequirement(span: string): boolean {
  const trimmed = span.replace(/^[\W_]+/, '').replace(TRAILING_HINGE, '').trim();
  if (trimmed === '') return false;
  if (FALLBACK_CONDITION.test(trimmed)) return false;
  if (COPULA_TAIL.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  return words.length >= MIN_REQUIREMENT_WORDS;
}

/**
 * The funder's own words for what is REQUIRED, with the preference clauses removed — empty when
 * the text is nothing but preference prose.
 *
 * Exported for the axes whose spec VALUES are read out of the same field. Reading them off the
 * whole field publishes the preference as the requirement: Holt's "Any active Amateur Radio
 * License Class for two years, preference for General Class" yielded `licenseMin: GENERAL`, which
 * is the preferred class, not the required one (the funder accepts any class held two years).
 */
export function requirementText(text: string): string {
  return preferenceScope(text)
    .ungoverned.filter(statesRequirement)
    // The hinge belongs to the preference, not to the requirement: "…active Amateur Radio license
    // WITH" is not a phrase any extractor should be handed.
    .map((span) => span.replace(TRAILING_HINGE, '').trim())
    .join(' ')
    .trim();
}

/**
 * Is this text ENTIRELY preference prose — i.e. does the preference govern the whole statement?
 *
 * Soft never excludes, so this answer decides whether a funder's requirement is enforced at all.
 * It used to be `PREFERENCE.test(text)`: one preference word anywhere softened the whole sentence.
 * Three ARRL entries state a requirement AND a preference in one captured field, and all three
 * lost the requirement half that way — Holt most consequentially, because it is one of only two
 * programs the unlicensed high-school profile could reach, on a desk whose entire subject is
 * amateur radio.
 *
 * The rule now: preference language softens what it governs (see `preferenceScope`). If anything
 * outside that scope states a requirement of its own, the text is not preference prose. That
 * language is the preference NOUNS and the RECOMMENDATION MODALS together — "should" and
 * permissive "may" are how MARCO, York and ECARS state theirs, and reading a recommendation as a
 * requirement is the same defect pointing the other way: MARCO and York were `ineligible` on
 * `ham_activity` for every licensed individual profile because of the word "should".
 *
 * TWO THINGS DELIBERATELY STAY SOFT, because the funder has said so:
 *  - an explicit cascade ("…if no qualified applicant is identified, the scholarship may be
 *    awarded to…") — the funder has stated in its own words that the primary criterion does not
 *    exclude anyone, so no part of that sentence is a bar however it is punctuated. This is the
 *    same statement `cascadeRank` publishes as `fallbackRank: 1`;
 *  - a fallback condition inside the ungoverned span, by the same reasoning at clause level.
 *
 * Still biased toward softening at the margin: a span shorter than `MIN_REQUIREMENT_WORDS` is
 * read as connective tissue, not as a requirement.
 */
export function isPreferenceText(text: string): boolean {
  // A stated fallback answers the question on its own, whatever else the text says and whether or
  // not the word "preference" appears — see `statesFallback`. This ordering IS the fix: while the
  // preference-word gate came first, neither `CASCADE` nor `FALLBACK_CONDITION` could run unless
  // the funder had already used a preference word, and a funder who widens eligibility without
  // one ("if no suitable applicant identified, applicants from all regions will be considered")
  // had that sentence published as a bar.
  if (CASCADE.test(text) || statesFallback(text)) return true;
  // "Is there any preference language here at all?" asked of the SCOPE rather than of a bare
  // `PREFERENCE.test(text)`, so the two vocabularies cannot answer differently: a text whose only
  // marker is a recommendation modal ("Applicants should be able to describe…") has a governed
  // span and no preference noun, and the old gate returned false before the scope was ever built.
  const scope = preferenceScope(text);
  if (scope.governed.length === 0) return false;
  return !scope.ungoverned.some(statesRequirement);
}

/**
 * 0 = primary preference; 1 = the explicit "…if no qualified applicant is identified…" fallback.
 *
 * Same predicate as the softening decision above, deliberately: a constraint that is soft BECAUSE
 * the funder stated a fallback is the fallback tier, and publishing it at rank 0 would rank it
 * level with a plain "preference given to residents of X" that carries no such sentence. The
 * earlier note here — that widening this would "move data that is already pinned" — held while
 * `FALLBACK_CONDITION` decided nothing a user sees; now that it decides hard vs soft, the two
 * answers have to come from one rule or a constraint could be soft-because-of-a-cascade and
 * ranked as if there were none.
 */
export function cascadeRank(text: string): number {
  return CASCADE.test(text) || statesFallback(text) ? 1 : 0;
}

/**
 * FNV-1a, 32-bit, hex. Deliberately NOT node:crypto — normalize/ is pure (spec §14) and a
 * constraint id is namespacing, not security: it only has to be stable across runs and
 * collision-resistant inside one program's short constraint list.
 */
export function stableSuffix(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Every string the spec states as a VALUE. `axis` is the spec's own name, never funder wording. */
function specValues(spec: ConstraintSpec): string[] {
  const out: string[] = [];
  const walk = (node: unknown, key: string): void => {
    if (key === 'axis') return;
    if (typeof node === 'string') {
      if (node.trim() !== '') out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(spec, '');
  return out;
}

function mentions(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(text);
}

/**
 * A HARD constraint must never carry a value the funder stated only as a PREFERENCE.
 *
 * `isPreferenceText` answers whether a requirement survives in the text; it cannot answer whether
 * the spec beside it DESCRIBES that requirement. Several extractors read their values off the
 * whole captured field, so when the preference names the narrower value it is the preference that
 * ends up in the spec:
 *
 *   "Resident of Florida, with preference given to residents of Central Florida (Orange, Seminole,
 *    Osceola, Lake, Volusia, Brevard and Polk Counties)"  →  geo county[Orange, Seminole, …]
 *
 * Florida residency is required and seven counties are preferred. Hardening THAT spec would bar
 * every Floridian outside those seven counties — publishing the preference as the bar, which is
 * the opposite error to the one this module was just fixed for and no better. So when every value
 * the spec spells out comes from the preference clause and none of it from the requirement, the
 * constraint stays soft; the real fix is for that axis to read its values from `requirementText`,
 * as `license.ts` now does.
 *
 * Absence of evidence is not evidence here: a spec whose values appear nowhere in the text
 * (`licenseMin: TECH` is a fallthrough, not a quotation) is not preference-derived, and hardening
 * it is the requirement-preserving direction.
 */
function specStatedOnlyAsPreference(text: string, spec: ConstraintSpec): boolean {
  const scope = preferenceScope(text);
  if (scope.governed.length === 0) return false;
  const governed = scope.governed.join(' ');
  const ungoverned = scope.ungoverned.join(' ');
  const values = specValues(spec);
  return (
    values.some((v) => mentions(governed, v)) && !values.some((v) => mentions(ungoverned, v))
  );
}

export function makeConstraint(
  axis: string,
  rawText: string,
  spec: ConstraintSpec,
  index: number,
): Constraint {
  const soft = isPreferenceText(rawText) || specStatedOnlyAsPreference(rawText, spec);
  return {
    id: `${axis}-${index}-${stableSuffix(`${axis}|${rawText}`)}`,
    hard: !soft,
    fallbackRank: soft ? cascadeRank(rawText) : 0,
    rawText,
    spec,
  };
}
