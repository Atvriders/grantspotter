import type { Program, Verdict } from '@grantspotter/core';
import { profileFieldLabel, type ProfileFieldKind } from '../lib/profileFields.js';
import './badges.css';

/**
 * The routes a programme's own record names that GrantSpotter cannot check —
 * `ConstraintAlternatives.orUnrepresented`, in the funder's own terms, in record order.
 *
 * The Robert A. Rodriguez K5AUW Scholarship is the clearest one: "open to graduating high school
 * seniors, AND TO PREVIOUS AWARDEES". "Previous awardee" is not a `Stage`, not a `DegreeLevel` and
 * not any field `StudentProfile` holds, so the axis declines to decide rather than refuse — an
 * `unknown` with an EMPTY `missingProfileFields`.
 *
 * WHY EVERY UNKNOWN SURFACE NOW NEEDS THIS. Measured over the shipped corpus with
 * `scripts/profile-corpus.ts` at its fixed 2026-08-02 clock: 51 constraints across the 150
 * publishable programmes carry `orUnrepresented`, and for the graduate music student 20 of the
 * programmes that come back `unknown` with nothing to fill in are of exactly this kind. On all 20
 * this badge used to say "This program's record is missing something GrantSpotter needs to decide
 * it", which is the wrong party: the record is complete and the funder's sentence is on file — it
 * is this software's schema that cannot adjudicate "Science, Math, Engineering or Technology"
 * against "Music Performance". Blaming the record sends a reader to check a page that already says
 * what it needs to say.
 *
 * A `Program`, not a `Verdict`: `Verdict.unknown` carries only `missingProfileFields`, and the
 * detail response does not say which profile it was computed against, so no caller can prove this
 * route is what stopped THIS verdict. The copy below therefore says what the record names, never
 * that it is the cause.
 */
export function unrepresentedRoutesOf(program: Program): string[] {
  return program.constraints
    .map((constraint) => constraint.spec.orUnrepresented)
    .filter((route): route is string => route !== undefined && route.trim() !== '');
}

export interface VerdictBadgeProps {
  verdict: Verdict | null;
  /** When supplied, the ineligible badge becomes a button that opens the reasons. */
  onExplain?: () => void;
  expanded?: boolean;
  /**
   * Which profile the verdict was computed against, when the caller knows. Only used to label
   * missing fields with the copy for that editor tab; four field keys exist on both profiles.
   */
  profileKind?: ProfileFieldKind;
  /**
   * Routes this programme's record names that no rule here can check — {@link unrepresentedRoutesOf}.
   * Only ever read for `unknown`, and only when there is nothing to fill in: a route the applicant
   * satisfies makes the verdict `eligible`, and `orUnrepresented` can never produce a refusal.
   */
  unrepresentedRoutes?: readonly string[];
}

/**
 * The two claims this product lives on, rendered once: `can I apply` and, for `unknown`, `what
 * would let me answer that`.
 *
 * `role="img"` rather than a bare `<span aria-label>`: on an element with the generic role an
 * `aria-label` is ignored by assistive technology, so the short visual text ("Ineligible · 2")
 * would be all a screen reader ever got. `img` is the role that both accepts an author-supplied
 * name and replaces its children with it, which is exactly the relationship between the label and
 * the abbreviation shown.
 */
export function VerdictBadge({
  verdict,
  onExplain,
  expanded = false,
  profileKind,
  unrepresentedRoutes = [],
}: VerdictBadgeProps): JSX.Element {
  if (verdict === null) {
    return (
      <span
        className="badge verdict-none"
        role="img"
        aria-label="No profile set"
        title="No profile has been saved yet, so nothing has been matched against this program. This is not a decision about you."
      >
        No profile
      </span>
    );
  }

  switch (verdict.kind) {
    case 'eligible':
      return (
        <span
          className="badge verdict-eligible"
          role="img"
          aria-label="Eligible"
          title="Your profile satisfies every hard constraint recorded for this program. Check the funder's own page before you apply — this record is only as fresh as its verification date."
        >
          Eligible
        </span>
      );

    case 'eligible_preferred':
      return (
        <span
          className="badge verdict-preferred"
          role="img"
          aria-label={`Preferred, rank ${verdict.rank}`}
          title={`You satisfy every hard constraint, and you also match a preference this funder states (rank ${verdict.rank}). A preference is not a guarantee — it is a tie-breaker the funder applies at their discretion.`}
        >
          Preferred · <span className="badge-rank">{verdict.rank}</span>
        </span>
      );

    case 'ineligible': {
      const n = verdict.reasons.length;
      const label = `Ineligible, ${n} constraint${n === 1 ? '' : 's'} not met`;
      const title = `${n} recorded constraint${n === 1 ? '' : 's'} your profile does not meet${
        onExplain ? '. Open to read the funder\'s own wording for each one.' : '.'
      }`;
      const content = (
        <>
          Ineligible · <span className="badge-rank">{n}</span>
        </>
      );
      if (!onExplain) {
        return (
          <span className="badge verdict-ineligible" role="img" aria-label={label} title={title}>
            {content}
          </span>
        );
      }
      return (
        <button
          type="button"
          className="badge verdict-ineligible"
          aria-label={label}
          aria-expanded={expanded}
          title={title}
          onClick={onExplain}
        >
          {content}
        </button>
      );
    }

    case 'unknown': {
      /**
       * `unknown` is a real, common, honest state — 27 of 150 for a fully specified EE
       * undergraduate (8 until 2026-08-12, when a record that named no audience stopped being a
       * refusal), and far more when a profile field is unset. An unset field yields `unknown`,
       * never `ineligible`, so this badge must never read as a soft "no".
       *
       * The title says "waiting on", never "fill this in and you get an answer": the matcher
       * short-circuits per axis, so filling `degreeLevel` moves a verdict from one `unknown` to a
       * DIFFERENT unknown (`accredited`). Promising resolution would be a lie the completeness
       * meter already had to be corrected for.
       */
      const names = verdict.missingProfileFields.map((f) => profileFieldLabel(f, profileKind));
      const first = names[0];
      const rest = names.length - 1;
      const label =
        first === undefined
          ? 'Unknown'
          : rest > 0
            ? `Unknown, needs ${first} and ${rest} more`
            : `Unknown, needs ${first}`;
      const title =
        names.length > 0
          // The trailing clause used to read `— it never turns into "no"`. That is
          // false, and in the opposite direction to the over-assertion this copy
          // exists to avoid: answering a field genuinely CAN produce `ineligible`
          // (state a 2.0 GPA against a funder's 3.0 floor and the honest verdict is
          // no). The real invariant, verified across six hard-bar axes, is narrower:
          // an *unset* field yields `unknown`, never `ineligible`. Promising a
          // never-no would make the badge lie in exactly the way the rest of this
          // product refuses to. Flagged by Task 18 while writing the explorer copy.
          ? `Not an answer yet. This verdict is waiting on: ${names.join(', ')}. Answering one may reveal the next question rather than a final answer — while it stays unanswered, it is a question and not a "no".`
          : unrepresentedRoutes.length > 0
            ? // THE THIRD CAUSE, and the branch below was written before it existed. When a
              // funder names a way of qualifying that this schema cannot describe, nothing is
              // missing from the record — their sentence is on file and quoted on the record page
              // — and nothing is missing from the profile either. What cannot be done is the
              // ADJUDICATION. Saying "this program's record is missing something" about those
              // sends the reader to check a page that already says what it needs to say, and
              // saying "no field you could fill in would change that" is worse than vague on the
              // 49 field-of-study cases, where the applicant's own `fieldOfStudy` is precisely
              // what nobody can decide. See `unrepresentedRoutesOf` for the measurement.
              `Not an answer yet. This funder names a way of qualifying that GrantSpotter cannot check — ${unrepresentedRoutes.join('; ')} — so it declined to decide rather than rule you out. Open the record to read their own sentence. It is not a "no".`
            : // NOT "could not be evaluated from your profile" — that was true of neither case and
            // pointed the reader at the wrong place. Both causes are a hole in GRANTSPOTTER'S
            // record: a radius rule whose centre never resolved to a coordinate (1 record), and a
            // record that never said who may apply (19 records, which were a hard "no" for every
            // possible user until 2026-08-12). Sending a reader to the profile editor to close a
            // gap in our own data is the same misdirection as calling it a refusal, only quieter.
            'Not an answer yet. This program’s record is missing something GrantSpotter needs to decide it, and there is no field you could fill in that would change that. It is not a "no".';
      return (
        <span className="badge verdict-unknown" role="img" aria-label={label} title={title}>
          {first === undefined ? (
            'Unknown'
          ) : (
            <>
              Unknown · {first}
              {rest > 0 && <span className="badge-more">+{rest}</span>}
            </>
          )}
        </span>
      );
    }
  }
}
