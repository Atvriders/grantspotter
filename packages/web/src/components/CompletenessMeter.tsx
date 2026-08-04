import { UnknownFields } from './UnknownFields.js';
import type { CompletenessReport, ProfileKind } from '../store/session.js';
import './profile.css';

export type { CompletenessReport };

/** Total by construction: a third profile variant in CONTRACT §3 stops compiling here. */
const KIND_NOUN: Record<ProfileKind, string> = {
  student: 'student',
  organization: 'organization',
};

export interface CompletenessMeterProps {
  report: CompletenessReport;
  /**
   * The profile the report speaks for, exactly as the SERVER named it
   * (`completenessFor`). Never re-derived here: the preference order that picks the
   * active profile has one definition, in `packages/server/src/api/profileStore.ts`,
   * and a second copy in the browser is how two screens end up disagreeing about the
   * same user. `null` means no profile was evaluated.
   */
  measuredFor: ProfileKind | null;
  /**
   * Held profiles the report does NOT speak for — `unevaluatedProfileKinds` from the
   * session store, pure set subtraction. Non-empty means the meter is silent about a
   * profile that exists, and silence reads as an assertion.
   */
  unevaluated: ProfileKind[];
  /** The editor tab currently open, so the meter can say when it is not that one. */
  editing: ProfileKind;
}

/**
 * Completeness measured against the matcher: not "how much of the form is filled" but
 * "how much of the corpus can already be judged".
 *
 * Two things this component is careful about, both of which the repo has paid for once
 * already:
 *
 * 1. **`resolves` is an upper bound, not a promise.** The matcher short-circuits per
 *    axis, so answering `degreeLevel` moves QCWA's verdict from one `unknown` to a
 *    DIFFERENT unknown (`accredited`), and one verdict can name several fields at once.
 *    The ladder therefore says "N unknown verdicts are waiting on this" and never "fill
 *    this in and N verdicts become answers". That wording, and the "an unanswered field
 *    is a question, not a 'no'" framing under it, are `UnknownFields`' — reused here
 *    rather than restated, so the browse page and this page cannot drift apart. What it
 *    does NOT claim is that answering can never produce a "no": state a 2.0 GPA against
 *    a funder's 3.0 floor and `ineligible` is the honest verdict. The narrower invariant
 *    that actually holds is that an *unset* field yields `unknown`, never `ineligible`.
 *
 * 2. **One report, up to two profiles.** The number is rendered with the name of the
 *    profile it was computed from, always. An unlabelled 60% beside an organization form
 *    tells a club its club profile scored 60% when the report was about a student.
 */
export function CompletenessMeter({
  report,
  measuredFor,
  unevaluated,
  editing,
}: CompletenessMeterProps): JSX.Element {
  const nouns = unevaluated.map((kind) => KIND_NOUN[kind]);
  const unmeasured =
    nouns.length === 1
      ? `Your ${nouns[0]} profile has not been measured.`
      : `Your ${nouns.join(' and ')} profiles have not been measured.`;

  return (
    <>
      <section className="card profile-meter" aria-labelledby="completeness-heading">
        <h2 id="completeness-heading">Completeness</h2>
        <p className="profile-meter-figure">{report.score}%</p>
        <div
          className="profile-meter-shell"
          role="meter"
          aria-label="Profile completeness"
          aria-valuenow={report.score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${report.score} percent of the corpus already returns a real verdict`}
        >
          <div className="profile-meter-fill" style={{ width: `${report.score}%` }} />
        </div>
        <p className="profile-meter-count">
          {report.unknownCount} of {report.total} programs still return an unknown verdict.
        </p>
        {/* Whole sentences in a single text node. Wrapping the profile name in a
            <strong> splits it across children, and both a screen reader's flat
            string and getByText's node text then read "Measured against your
            profile." — the one word that carries the meaning dropped out. */}
        {measuredFor === null ? (
          <p className="profile-meter-for">
            No profile has been measured yet. Save one and this meter will speak for it.
          </p>
        ) : (
          <p className="profile-meter-for">
            {`Measured against your ${KIND_NOUN[measuredFor]} profile.`}
          </p>
        )}
        {unevaluated.length > 0 && (
          <p className="profile-meter-warn">
            {unevaluated.includes(editing)
              ? `This meter does not speak for the ${KIND_NOUN[editing]} profile you are editing. Save it and the meter will measure that one instead.`
              : `${unmeasured} Saving a profile is what measures it.`}
          </p>
        )}
      </section>

      <UnknownFields
        fields={report.fields.map(({ field, resolves }) => ({ field, count: resolves }))}
        kind={measuredFor}
      />
    </>
  );
}
