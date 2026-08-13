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
 *   THE PRODUCT'S OWN WORDS ARE NOT THE APPLICANT'S TO SIGN. A draft that quotes a shipped
 *   template verbatim used to fill this panel with the product's own sourced prose — 120 rows for
 *   one press of "Insert ARDC Grants Program — funder overlay", each reading "not attributed to
 *   any stated value — this is prose you or a model wrote". The server keeps those off `items`
 *   now and reports them as a count, which this panel prints with the template named: a shorter
 *   list with no explanation would be the same silent assertion pointing the other way.
 *
 *   AND THE TWO HALVES OF THAT SENTENCE HAVE TO AGREE. They did not: the same panel printed "173
 *   values in this draft are quoted, word for word, from material GrantSpotter ships" directly
 *   above "9 assertions still need confirmation", and all nine were the product's own — the word
 *   "Indirect" out of its budget skeleton, and the row numbers 1, 2, 3, 4 of its timeline table.
 *   A shipped line carrying a `{{slot}}` was being dropped from the comparison whole, so the
 *   product's words around the blank came back as the applicant's. The server now matches those
 *   lines with a hole where the value lands: the template's words are excused, and whatever the
 *   applicant filled into the blank is still theirs and still listed. This panel says so, because
 *   a reader who has typed a figure into shipped scaffolding must be able to predict which of the
 *   two paragraphs above covers it.
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
   * Assertions inside passages the draft quotes verbatim from a shipped template, which the server
   * kept off `items`. Printed as a sentence naming the templates: the panel may not simply be
   * shorter than the draft with no explanation.
   */
  shippedFacts?: number;
  shippedTemplates?: string[];
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

export function FactChecklist({
  items,
  openTodos,
  shippedFacts = 0,
  shippedTemplates = [],
  onChange,
}: Props): JSX.Element {
  const unconfirmed = items.filter((i) => !i.confirmed).length;
  const stale = items.filter((i) => i.staleConfirmation);
  const clear = unconfirmed === 0 && openTodos === 0;

  return (
    <section className="fact-checklist" aria-labelledby="fact-checklist-heading">
      <h3 id="fact-checklist-heading">Fact checklist</h3>
      <p className="muted">
        Confirm every figure, date, name, callsign, citation and URL below before exporting — these are the ones
        this draft asserts in your own words. The funder holds you responsible for each one.
      </p>
      {/*
        WHAT IS DELIBERATELY NOT ON THE LIST, said in words and with a number.

        Inserting the ARDC overlay used to put 120 rows here, every one of them labelled "not
        attributed to any stated value — this is prose you or a model wrote", about text
        GrantSpotter wrote, cited to three ARDC pages named beside the insert button. The panel
        was accusing the product's own sourced material of being unsourced, and the applicant's
        real assertions were unfindable underneath it. Those rows are gone; a panel that was
        simply shorter with no explanation would be the same silence pointing the other way, so
        the count and the template are printed. The last two sentences are the property that makes
        the rest safe, and both are literally true: matching is verbatim and whole-line except
        where the template left a blank, and a value in one of those blanks is on the list below.
      */}
      {shippedFacts > 0 ? (
        <p className="muted checklist-shipped">
          {shippedFacts === 1
            ? 'One value in this draft is'
            : `${shippedFacts} values in this draft are`}{' '}
          quoted, word for word, from material GrantSpotter ships
          {shippedTemplates.length > 0 ? ` — ${shippedTemplates.join(', ')}` : ''}: the product’s wording rather
          than yours, so {shippedFacts === 1 ? 'it is' : 'they are'} not listed below for your signature. Every
          funder overlay carries the sources it was read from; open it under Templates and check them as you would
          any quotation. Anything you filled into a blank in that material is yours, not theirs, and is on the
          list below. Edit any of that material and every value in the part you changed appears here too.
        </p>
      ) : null}
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
