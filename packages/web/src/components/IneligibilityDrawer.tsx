import {
  APPLICANT_ENTITY_AXIS_LABEL,
  hasFunderWording,
  isApplicantEntityConstraint,
} from '@grantspotter/core';
import type { Constraint, ConstraintAxis, ConstraintTier } from '@grantspotter/core';
import './explain.css';

const AXIS_LABELS: Record<ConstraintAxis, string> = {
  license: 'License',
  geography: 'Geography',
  field_of_study: 'Field of study',
  institution: 'Institution',
  gpa: 'GPA or class rank',
  arrl_membership: 'ARRL membership',
  recommendation: 'Recommendation',
  citizenship: 'Citizenship',
  age_stage: 'Age or stage',
  ham_activity: 'Demonstrated ham activity',
  financial_need: 'Financial need',
  gender: 'Gender',
  other: 'Other',
};

/**
 * The human name for a constraint axis. `Record<ConstraintAxis, string>` is what makes this total:
 * an axis added to core's union fails the typecheck here rather than rendering a bare `age_stage`
 * at a user, and `IneligibilityDrawer.test.tsx` re-checks it at runtime against core's own zod
 * discriminated union in case the type ever loosens.
 */
export function axisLabel(axis: ConstraintAxis): string {
  return AXIS_LABELS[axis];
}

/**
 * The heading one reason is filed under. Almost always its axis — except for the one constraint
 * GrantSpotter composes rather than reads, which carries `axis: 'other'` because CONTRACT §3 has
 * no axis for it, and so rendered the word "OTHER" above a sentence about who may apply.
 */
export function reasonHeading(constraint: Constraint): string {
  return isApplicantEntityConstraint(constraint)
    ? APPLICANT_ENTITY_AXIS_LABEL
    : axisLabel(constraint.spec.axis);
}

/**
 * A short, human restatement of ONE TIER, under — never instead of — the quote.
 *
 * IT TAKES A `ConstraintTier`, NOT A `Constraint`, AND THAT IS THE WHOLE POINT. A spec is one tier
 * plus `ConstraintAlternatives.anyOf` — other tiers of the same axis the funder also named, any one
 * of which satisfies the rule — and this function used to be handed the spec and read only the
 * tier. The IRARC Memorial scholarship ("Resident of Brevard County FL, or any FL resident") then
 * rendered as `county: Brevard, FL.` under a quoted sentence that plainly offers a second route:
 * the structured line, which is the part a reader scans, stated a requirement NARROWER than the one
 * the matcher applies. `alternativeDetails` runs the same function over the siblings so the two can
 * never again describe different rules.
 *
 * Two arms return a phrase where a spec-only reader could get away with `null`, because an
 * alternative that renders as nothing is worse than no alternative at all — it silently deletes the
 * WIDEST route from the line:
 *   - `geo.type === 'any'` is unreachable as a base tier (`evaluateGeo` passes it, so it is never
 *     an ineligibility reason) but perfectly reachable as a sibling.
 *   - `field_of_study` with an empty `fields` AND an empty `excludedFields` is how the extractor
 *     writes "or an undergraduate degree in anything" beside a named certification programme;
 *     `matcher.ts` reads it as `required.unrestricted` and passes everyone, so "Allows ." was both
 *     ungrammatical and a description of the opposite rule.
 */
function tierDetail(spec: ConstraintTier): string | null {
  switch (spec.axis) {
    case 'license':
      return spec.heldMonthsMin !== undefined
        ? `Needs ${spec.licenseMin} or higher, held at least ${spec.heldMonthsMin} months.`
        : `Needs ${spec.licenseMin} or higher.`;
    case 'geography':
      if (spec.geo.type === 'radius') {
        return `Within ${spec.geo.radiusMiles} miles of ${spec.geo.centerLabel ?? 'the stated point'}.`;
      }
      if (spec.geo.type === 'arrl_section') {
        // Spelled out because an ARRL Section is routinely misread as a state, and a user who
        // reads it that way will conclude the verdict is wrong when it is right.
        return `ARRL Section ${spec.geo.values.join(', ')}. An ARRL Section is an ARRL-defined region, not a state.`;
      }
      if (spec.geo.type === 'arrl_division') {
        return `ARRL Division ${spec.geo.values.join(', ')}, which spans several states.`;
      }
      if (spec.geo.type === 'any') return 'Anywhere — no location restriction.';
      return `${spec.geo.type.replace(/_/g, ' ')}: ${spec.geo.values.join(', ')}.`;
    case 'field_of_study':
      if (spec.excludedFields.length > 0) {
        return spec.fields.length > 0
          ? `Allows ${spec.fields.join(', ')}; excludes ${spec.excludedFields.join(', ')}.`
          : `Any field of study except ${spec.excludedFields.join(', ')}.`;
      }
      return spec.fields.length > 0
        ? `Allows ${spec.fields.join(', ')}.`
        : 'Any field of study.';
    case 'institution':
      return `Degree levels ${spec.degreeLevels.join(', ')}${
        spec.accreditationRequired ? ', accredited only' : ''
      }${spec.partTimeOK ? ', part-time allowed' : ''}.`;
    case 'gpa':
      if (spec.min !== undefined) return `Minimum GPA ${spec.min}.`;
      if (spec.classRankTopPct !== undefined) return `Top ${spec.classRankTopPct}% of class.`;
      return null;
    case 'arrl_membership':
      return spec.minYears > 0
        ? `ARRL membership for at least ${spec.minYears} year(s).`
        : 'ARRL membership required.';
    case 'recommendation':
      return `${spec.count} recommendation(s) from: ${spec.recommenderType.replace(/_/g, ' ')}.`;
    case 'citizenship':
      return `Allows ${spec.allowed.join(', ')}.`;
    case 'age_stage':
      return `${spec.ageMin ?? '?'}–${spec.ageMax ?? '?'}${
        spec.asOf !== undefined ? ` as of ${spec.asOf}` : ''
      }; stages ${spec.stages.join(', ')}.`;
    case 'ham_activity':
      return spec.cwProficiencyWpmMin !== undefined
        ? `Activity in ${spec.activityKinds.join(', ')}, plus Morse code at ${spec.cwProficiencyWpmMin} wpm.`
        : `Activity in ${spec.activityKinds.join(', ')}.`;
    case 'gender':
      return `Open to: ${spec.allowed.join(', ')}.`;
    case 'financial_need':
      return 'Financial need is weighted, never a bar.';
    case 'other':
      // An empty note is not a detail. Returning `''` rendered an empty paragraph under the
      // quote, and — for a constraint with no funder wording either — an empty box where the
      // whole reason should be.
      return spec.note === '' ? null : spec.note;
  }
}

/** The base tier's restatement. Unchanged in meaning; see {@link tierDetail}. */
function specDetail(constraint: Constraint): string | null {
  return tierDetail(constraint.spec);
}

/**
 * The OTHER routes the funder named for the same rule, each restated the same way the base tier is.
 *
 * Exported for the tests, which check it against the corpus records that actually carry
 * `anyOf` — six constraints across five programmes, measured with `scripts/profile-corpus.ts`'s
 * loader: IRARC (county Brevard OR state FL, and a certification programme OR any degree), Gwinnett
 * (county OR state GA), Fred R. McDaniel (call district 5 OR six named states), North Texas Section
 * (ARRL Section OR OK/TX) and Michael R. Ware (GENERAL held 24 months OR EXTRA).
 *
 * A tier that restates as nothing is dropped rather than rendered as a blank alternative; after the
 * two arms `tierDetail` gained, no tier in the corpus does that.
 */
export function alternativeDetails(constraint: Constraint): string[] {
  return (constraint.spec.anyOf ?? [])
    .map((tier) => tierDetail(tier))
    .filter((detail): detail is string => detail !== null);
}

/**
 * The alternatives as one line of prose, WITH THE ATTRIBUTION INSIDE THE SENTENCE.
 *
 * "GrantSpotter also treats" and not "the funder also accepts": the funder's sentence is quoted
 * two lines above and says whatever it says; this line is the software's account of what it
 * actually applied, and the rule established two rounds ago is that anything the software composed
 * must be visibly the software's. Naming it in the words rather than in a tag above them means it
 * stays attributed when the line is read aloud or copied out.
 *
 * Exported so `Opportunity.tsx` and the tests use the same sentence rather than two that drift.
 */
export function alternativesSentence(alternatives: readonly string[]): string {
  const routes = alternatives.map((a) => a.replace(/\.$/, '')).join('; or ');
  return (
    `GrantSpotter also treats this as satisfied by ${routes}. ` +
    'The funder named more than one route here, and any one of them is enough.'
  );
}

export interface IneligibilityDrawerProps {
  programName: string;
  reasons: Constraint[];
}

/**
 * A constraint with neither a funder sentence nor a restatement of its own says nothing at all,
 * and the honest rendering of nothing is to say so rather than to leave a blank box that reads as
 * a rendering bug. No constraint in the shipped corpus is in this state; the branch exists because
 * "the record is silent" is precisely the case this whole fix is about.
 */
const NO_WORDING_AT_ALL =
  'No wording was recorded for this requirement. Open the record and check the source.';

/**
 * The lede has to be true of the list underneath it. "Quoted below in the funder's own wording"
 * was false for every verdict whose only reason was the applicant-entity gate — which, for a
 * collegiate 501(c)(3) club, was 144 of 150 — and the second clause ("not a gap in your profile")
 * was true in the worst possible way: it was a gap in the RECORD.
 */
function ledeFor(reasons: Constraint[]): string {
  const quoted = reasons.filter(hasFunderWording).length;
  if (quoted === reasons.length) {
    return (
      'Quoted below in the funder’s own wording. A requirement you do not meet is a ' +
      'restriction the funder set, not a gap in your profile.'
    );
  }
  if (quoted === 0) {
    return (
      'Not a quotation. No funder sentence was recorded for this, so what follows is ' +
      'GrantSpotter’s own statement about the record — read the funder’s page ' +
      'before you take it as theirs.'
    );
  }
  return (
    'Quoted below in the funder’s own wording, except where a line is marked as ' +
    'GrantSpotter’s. A marked line is our statement about the record, not a sentence the ' +
    'funder wrote.'
  );
}

/**
 * "You are ineligible for N of these, and here is the specific constraint for each" (spec §5).
 *
 * Two things this must not do, both learned the hard way:
 *
 * 1. **Paraphrase.** A constraint that carries the funder's own `rawText` is shown verbatim,
 *    quoted, in a monospaced block. The ingestion layer produced confidently wrong constraints for
 *    a long time; a user can trust a verdict now precisely because the sentence it was derived
 *    from is on screen next to it and can be judged.
 *
 *    THE COROLLARY, AND IT HAD TO BE LEARNED SEPARATELY. That promise is only keepable for
 *    sentences a funder actually wrote, and one reason in this product is composed by GrantSpotter
 *    at match time: the applicant-entity gate. It used to arrive with a `rawText` reading "This
 *    program accepts applications from: ieee_student_branch_chapter." — GrantSpotter's own words,
 *    in the funder's grammatical voice, inside the quotation block, and for 19 of 150 records with
 *    "(none recorded)" where the sentence should be. So the quote block is now rendered ONLY when
 *    `hasFunderWording` is true; anything the software composed is rendered in a visibly different
 *    block that says whose words they are, and the lede stops claiming a quotation that is not
 *    there. An empty monospaced box would have been the same lie with the text removed.
 * 2. **Read as a to-do list.** For a licensed EE undergraduate the census is 68 eligible-or-
 *    preferred of 150, and geography alone accounts for 36 of the exclusions — every one of them
 *    correct, because those awards really are ARRL-Division, Section and state restricted. A
 *    correct exclusion is not a fixable gap, and inviting the user to "fill something in" to clear
 *    it would be inviting them to falsify a profile. The "what would let me answer" surface is
 *    `UnknownFields`, and it is only ever shown for `unknown`.
 */
export function IneligibilityDrawer({
  programName,
  reasons,
}: IneligibilityDrawerProps): JSX.Element {
  return (
    <section className="explain" aria-label={`Why you are ineligible for ${programName}`}>
      <h3>Why you are ineligible for {programName}</h3>
      {reasons.length === 0 ? (
        <p className="explain-lede">
          No constraint was recorded for this verdict. Open the record and check the source.
        </p>
      ) : (
        <>
          <p className="explain-lede">{ledeFor(reasons)}</p>
          <ul>
            {reasons.map((reason) => {
              const detail = specDetail(reason);
              const alternatives = alternativeDetails(reason);
              const quoted = hasFunderWording(reason);
              return (
                <li key={reason.id}>
                  <div>
                    <span className="explain-axis">{reasonHeading(reason)}</span>
                    <br />
                    <span className={`explain-kind${reason.hard ? '' : ' soft'}`}>
                      {reason.hard ? 'Requirement' : 'Preference'}
                    </span>
                  </div>
                  <div>
                    {quoted ? (
                      <>
                        <p className="explain-raw">{reason.rawText}</p>
                        {detail !== null && <p className="explain-detail">{detail}</p>}
                      </>
                    ) : (
                      <p className="explain-authored">
                        <span className="explain-authored-tag">
                          GrantSpotter&rsquo;s words, not the funder&rsquo;s
                        </span>
                        {detail ?? NO_WORDING_AT_ALL}
                      </p>
                    )}
                    {/*
                      OUTSIDE the quoted/authored branch, deliberately: a second route is a fact
                      about the rule whichever kind of wording the rule arrived with, and it must
                      never sit inside `.explain-raw`, the monospaced box whose whole meaning is
                      "the funder published this". The attribution is in the sentence rather than in
                      a tag above it, so it survives being read aloud, copied, or pasted somewhere
                      with no styling — the same reason the CSV carries its attribution inline.
                    */}
                    {alternatives.length > 0 && (
                      <p className="explain-detail explain-alt">
                        {alternativesSentence(alternatives)}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
