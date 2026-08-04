/**
 * GAPS, BESIDE THE CHECKLIST AND NEVER INSIDE IT.
 *
 * A `[TODO: …]` marker is a hole the applicant fills. A checklist item is an assertion the
 * applicant signs. Rendering the first as the second is a defect this repository has now produced
 * three times — Task 3's filler test, Task 13's proper-noun count and Task 14's own brief, which
 * listed `W8UM` and `1909` as facts awaiting confirmation when both are EXAMPLES INSIDE THE HINT
 * TEXT of an unfilled slot. Nobody wrote them; confirming them would be confirming the tooltip.
 *
 * So this component exists as a separate file, renders a separate section with its own heading,
 * and offers no checkbox at all. There is nothing here to confirm — only something to write.
 *
 * The marker grammar is `[TODO: <slot path> — <hint>]`, produced by `templates/fill.ts`, and the
 * scan regex is the one `prose/facts.ts` counts `openTodos` with. Both are pinned server-side, and
 * a marker can contain neither `]` nor `<` nor a zero-width character, so parsing one is total.
 */

/** Mirrors `TODO_MARKER_SCAN()` in `packages/server/src/templates/fill.ts`. */
const TODO_MARKER = /\[TODO:[^\]]*\]/g;

export interface DraftGap {
  /** The whole marker as it appears in the draft, including the brackets. */
  marker: string;
  /** The slot path, e.g. `club.callsign`. Empty when a hand-typed marker carries no path. */
  slot: string;
  /** What the writer is being asked for. May carry an `e.g. …` example — an example, not a fact. */
  hint: string;
  /** Character offset in the draft, so two identical markers stay distinguishable. */
  start: number;
}

export function extractGaps(markdown: string): DraftGap[] {
  const out: DraftGap[] = [];
  for (const match of markdown.matchAll(TODO_MARKER)) {
    const marker = match[0];
    const inner = marker.slice('[TODO:'.length, -1).trim();
    const dash = inner.indexOf('—');
    out.push({
      marker,
      slot: dash === -1 ? '' : inner.slice(0, dash).trim(),
      hint: dash === -1 ? inner : inner.slice(dash + 1).trim(),
      start: match.index ?? 0,
    });
  }
  return out;
}

interface Props {
  gaps: DraftGap[];
}

export function DraftGaps({ gaps }: Props): JSX.Element {
  return (
    <section className="draft-gaps" aria-labelledby="draft-gaps-heading">
      <h3 id="draft-gaps-heading">Gaps to fill</h3>
      <p className="muted">
        A gap is something to write, not something to confirm, so gaps are listed here rather than in the fact
        checklist. Anything after “e.g.” below is an example of the SHAPE of the answer — it is not a value about
        you, and nothing has claimed it on your behalf.
      </p>
      {gaps.length === 0 ? (
        <p className="ready">No gap markers are left in this draft.</p>
      ) : (
        <ol className="gap-list">
          {gaps.map((gap) => (
            <li key={`${gap.slot}-${String(gap.start)}`}>
              <code className="gap-marker data">{gap.marker}</code>
              {gap.slot ? <span className="gap-slot data">{gap.slot}</span> : null}
              <p className="gap-hint">{gap.hint}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
