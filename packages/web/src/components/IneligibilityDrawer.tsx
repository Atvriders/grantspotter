import {
  APPLICANT_ENTITY_AXIS_LABEL,
  hasFunderWording,
  isApplicantEntityConstraint,
} from '@grantspotter/core';
import type { Constraint, ConstraintAxis } from '@grantspotter/core';
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

/** A short, human restatement of the machine-readable spec, under — never instead of — the quote. */
function specDetail(constraint: Constraint): string | null {
  const spec = constraint.spec;
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
      if (spec.geo.type === 'any') return null;
      return `${spec.geo.type.replace(/_/g, ' ')}: ${spec.geo.values.join(', ')}.`;
    case 'field_of_study':
      return spec.excludedFields.length > 0
        ? `Allows ${spec.fields.join(', ')}; excludes ${spec.excludedFields.join(', ')}.`
        : `Allows ${spec.fields.join(', ')}.`;
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
