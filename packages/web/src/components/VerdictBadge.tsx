import type { Verdict } from '@grantspotter/core';
import { profileFieldLabel, type ProfileFieldKind } from '../lib/profileFields.js';
import './badges.css';

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
