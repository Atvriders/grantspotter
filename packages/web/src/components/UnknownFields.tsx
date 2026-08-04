import { Link } from 'react-router-dom';
import {
  profileFieldHelp,
  profileFieldHref,
  profileFieldLabel,
  type ProfileFieldKind,
} from '../lib/profileFields.js';
import './explain.css';

export interface UnknownFieldsProps {
  /** `BrowseSummary.unknownByField`, already ranked by the server. */
  fields: Array<{ field: string; count: number }>;
  /**
   * Which profile the verdicts were computed against (`BrowseResponse.profileApplied`). Four keys —
   * `callsign`, `state`, `lat`, `lon` — exist on BOTH profiles, so without this a club is sent to
   * the student editor, where filling the field does nothing for the verdict that sent it there.
   */
  kind?: ProfileFieldKind | null;
}

/**
 * What the `unknown` verdicts are waiting on, each row linked straight to the input that sets it.
 *
 * The copy here is deliberately narrower than the number it renders. `unknownByField[].count` is an
 * UPPER BOUND on what answering a field buys, not a promise, for two reasons the server's
 * `completeness.ts` spells out and `completeness.test.ts` pins:
 *
 *   - one verdict can name several fields at once (`age_stage` reports `stage` and `birthDate`
 *     together), and answering one of them leaves the verdict unknown;
 *   - the matcher stops at the first thing it cannot answer, so filling `degreeLevel` moves QCWA's
 *     verdict from one unknown to a DIFFERENT unknown (`accredited`).
 *
 * So: "7 unknown verdicts are waiting on this". Never "resolves 7 unknown verdicts", and never
 * "fill these in and the unknowns become answers" — that is the same over-assertion this project
 * spent its entire effort removing from the data layer, restated in the one place a user would
 * actually read it. `VerdictBadge` holds the same line for the badge, with a test forbidding
 * "becomes an answer".
 */
export function UnknownFields({ fields, kind }: UnknownFieldsProps): JSX.Element | null {
  if (fields.length === 0) return null;

  return (
    <section className="card unknown-ladder" aria-label="What your unknown verdicts are waiting on">
      <h3>What your unknown verdicts are waiting on</h3>
      <p className="unknown-lede">
        Each program stops at the first thing it cannot work out about you, so answering one of
        these may reveal the next question rather than a final verdict. An unanswered field is a
        question, not a &ldquo;no&rdquo;.
      </p>
      <ul>
        {fields.map(({ field, count }) => {
          const help = profileFieldHelp(field, kind ?? undefined);
          const waiting =
            count === 1
              ? '1 unknown verdict is waiting on this'
              : `${count} unknown verdicts are waiting on this`;
          return (
            <li key={field}>
              <span>
                <Link to={profileFieldHref(field, kind ?? undefined)}>
                  {profileFieldLabel(field, kind ?? undefined)}
                </Link>
                {help !== '' && <span className="help">{help}</span>}
              </span>
              <span className="waiting">{waiting}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
