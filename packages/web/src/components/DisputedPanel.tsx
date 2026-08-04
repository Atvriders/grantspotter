import type { Disputed } from '@grantspotter/core';
import { SourceLink } from './SourceLink.js';
import './detail.css';

/**
 * Spec §8: the record shows EVERY reading with its source instead of picking one.
 *
 * Ships populated for the ARRL Club Grant cycle, where three researchers reached three different
 * conclusions from the same page — dormant, an autumn window, and a February/June/October
 * rhythm that is probably a conflation with a different ARRL programme. Choosing one and
 * printing it would have been indistinguishable, to a reader, from a fact.
 */
export function DisputedPanel({ disputed }: { disputed: Disputed }): JSX.Element {
  return (
    <section className="panel card disputed" aria-label="Disputed: sources do not agree">
      <h2>Sources do not agree</h2>
      <p>{disputed.note}</p>
      <ol>
        {disputed.claims.map((claim, index) => (
          <li key={`${index}-${claim.sourceUrl}`}>
            <p className="claim">{claim.claim}</p>
            <SourceLink href={claim.sourceUrl} />
          </li>
        ))}
      </ol>
    </section>
  );
}
