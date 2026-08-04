/**
 * THE EXPORT GATE, ON SCREEN.
 *
 * Every funder policy reviewed makes the human applicant — never the tool — accountable for each
 * number, claim and citation, so nothing leaves this app until a person has ticked every assertion
 * and cleared every gap. Four properties of the server's checklist have to survive the trip into
 * this component or the panel quietly becomes a wall of checkboxes:
 *
 *   ORIGIN IS NOT CONFIRMATION. A `program`-origin item is a value that MATCHES the funder's own
 *   record. It still blocks export until a human ticks it, and its provenance sentence says so.
 *
 *   `unattributed` IS A REAL ANSWER, NEVER A GUESS. Two slots from different sources holding the
 *   same value produce `unattributed` and a sentence naming both, because attributing it to one of
 *   them would be the same class of error as asserting the wrong fact.
 *
 *   A CONFIRMATION DIES WITH THE VALUE IT CONFIRMED. Ids are positional (`${kind}:${start}`), so
 *   editing `$1,450` to `$9,999` reuses the id; the server fingerprints the words instead and
 *   hands back `staleConfirmation`. This panel says which item went stale and why, and never
 *   re-ticks it on the applicant's behalf.
 *
 *   THE LIST IS NOT EXHAUSTIVE AND SAYS SO. `extractFactAssertions` returns nothing for claims
 *   made entirely in words — superlatives, universals, causal claims, and the role half of
 *   "Elena Ruiz, faculty advisor" — and a test pins that, so nobody replaces the honest sentence
 *   with a keyword list that covers a fraction and reads as complete.
 *
 * A `[TODO: …]` gap is NOT rendered here. It is counted as a blocker and listed by `DraftGaps`
 * beside this panel: a gap is something to fill, a fact is something to confirm, and the hint text
 * inside a marker (`e.g. W8UM`, `e.g. 1909`) is an instruction to the writer, never an assertion
 * awaiting their signature.
 */

import type { FactItemDTO, FactOriginDTO } from '../api/writing.js';

interface Props {
  items: FactItemDTO[];
  openTodos: number;
  /**
   * The fingerprint is deliberately NOT sent from here. This component is handed the item it is
   * rendering, so it could — but the route holds the checklist the server issued, and echoing the
   * fingerprint from there keeps one owner for "which value was on screen when the box was ticked".
   */
  onChange: (id: string, next: { confirmed: boolean; note: string }) => void;
}

const ORIGIN_LABEL: Record<FactOriginDTO, string> = {
  profile: 'matches your profile',
  program: 'matches the funder’s own record',
  answer: 'matches an answer you typed',
  unattributed: 'not attributed to any stated value',
};

export function FactChecklist({ items, openTodos, onChange }: Props): JSX.Element {
  const unconfirmed = items.filter((i) => !i.confirmed).length;
  const stale = items.filter((i) => i.staleConfirmation);
  const clear = unconfirmed === 0 && openTodos === 0;

  return (
    <section className="fact-checklist" aria-labelledby="fact-checklist-heading">
      <h3 id="fact-checklist-heading">Fact checklist</h3>
      <p className="muted">
        Confirm every figure, date, name, callsign, citation and URL below before exporting. The funder holds you
        responsible for each one.
      </p>
      <p className="muted checklist-scope">
        This lists the specifics a funder can look up. It cannot list a claim made only in words — a superlative such
        as “the only collegiate club in the state”, a universal such as “every member is licensed”, a causal claim
        such as “attendance rose after we bought the radio”, or the job title in “Elena Ruiz, faculty advisor”. Those
        are yours to check; a ticked list here is not a checked draft.
      </p>

      {clear ? (
        <p className="ready">Every assertion is confirmed and no gap is left — ready to export.</p>
      ) : (
        <ul className="blockers">
          {unconfirmed > 0 ? (
            <li>
              {unconfirmed} assertion{unconfirmed === 1 ? '' : 's'} still need
              {unconfirmed === 1 ? 's' : ''} confirmation.
            </li>
          ) : null}
          {openTodos > 0 ? (
            <li>
              {openTodos} unresolved [TODO: …] marker{openTodos === 1 ? '' : 's'} remain
              {openTodos === 1 ? 's' : ''} in the draft — listed under “Gaps to fill”, beside this checklist.
            </li>
          ) : null}
        </ul>
      )}

      {stale.length > 0 ? (
        <p className="fact-stale-summary" role="status">
          {stale.length} confirmation{stale.length === 1 ? '' : 's'} went stale because the text changed. Read the new
          value and tick it again.
        </p>
      ) : null}

      <ul className="fact-items">
        {items.map((item) => (
          <li key={item.id} className={item.confirmed ? 'confirmed' : 'unconfirmed'}>
            <label>
              <input
                type="checkbox"
                checked={item.confirmed}
                onChange={(e) => onChange(item.id, { confirmed: e.target.checked, note: item.note })}
              />
              <span className="fact-kind">{item.kind}</span>
              <span className="fact-text data">{item.text}</span>
            </label>
            <p className="fact-context">{item.context}</p>
            <p className={`fact-origin origin-${item.origin}`}>{ORIGIN_LABEL[item.origin]}</p>
            {item.provenance === '' ? null : <p className="fact-provenance muted">{item.provenance}</p>}
            {item.staleConfirmation ? (
              <p className="fact-stale">
                You confirmed a different value at this spot. The text now reads {item.text}, so the earlier tick no
                longer means anything — your note is kept, the tick is not.
              </p>
            ) : null}
            <input
              type="text"
              aria-label={`Note for ${item.text}`}
              placeholder="How did you verify this?"
              value={item.note}
              onChange={(e) => onChange(item.id, { confirmed: item.confirmed, note: e.target.value })}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
