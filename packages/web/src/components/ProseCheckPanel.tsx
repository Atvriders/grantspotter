import type { DensityDTO, ProseReportDTO } from '../api/writing.js';

interface Props {
  report: ProseReportDTO;
  densities: DensityDTO[];
}

const round = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);

const VERDICT_LABEL: Record<string, string> = {
  specific: 'carries its own specifics',
  thin: 'too short to judge',
  generic: 'style words, no counterweight',
};

/**
 * REPORTS, NEVER SCORES, AND NEVER ACCUSES.
 *
 * Two things this panel deliberately does not do, both of them tested:
 *
 *   1. It emits no single number for a draft. A rating would be acted on as a target, and the
 *      thing being measured — style-word density with no proper nouns or figures near it — is
 *      produced just as readily by a human writing in a hurry as by a model.
 *   2. It never says a passage was machine-written. `analyzeProse` cannot know that, nothing can,
 *      and a product that guessed would be asserting exactly the kind of unchecked claim the fact
 *      checklist exists to prevent.
 *
 * The per-paragraph numbers live in one table with ONE header row rather than a definition list
 * per paragraph: repeating "Style words per 100 words" once per paragraph makes the label
 * ambiguous to a screen reader's rotor and to `getByText`, and a metric you cannot point at
 * uniquely is a metric nobody can cite in a review.
 */
export function ProseCheckPanel({ report, densities }: Props): JSX.Element {
  const densityFor = (index: number): DensityDTO | undefined => densities.find((d) => d.index === index);

  return (
    <section className="prose-check" aria-labelledby="prose-check-heading">
      <h3 id="prose-check-heading">Prose check</h3>
      <p className="muted">
        This says where a passage is thin on specifics, and which words made it read that way. It does not rate a
        draft, and it never claims anything was written by a machine — it cannot know that, and neither can any
        classifier.
      </p>

      <ul className="prose-document-stats">
        <li>Tricolons: {report.documentTricolonCount}</li>
        <li>Sentence-length variance: {round(report.sentenceLengthVariance)}</li>
      </ul>

      {report.stockOpenerHits.length > 0 ? (
        <div className="prose-hits">
          <h4>Stock openers, located</h4>
          <ul>
            {report.stockOpenerHits.map((h, i) => (
              <li key={`${h}-${String(i)}`}>{h}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.stockCloserHits.length > 0 ? (
        <div className="prose-hits">
          <h4>Stock closers, located</h4>
          <ul>
            {report.stockCloserHits.map((h, i) => (
              <li key={`${h}-${String(i)}`}>{h}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.paragraphsWithNoProperNounOrFigure.map((index) => (
        <p key={index} className="prose-warning">
          Paragraph {index + 1} has no proper noun and no figure in it. Name someone, or give a number.
        </p>
      ))}

      {/*
        THE VERDICT IS THE SECOND COLUMN, AND THE TABLE SCROLLS IN A BOX OF ITS OWN.

        Both halves fix one measurement. Six `white-space: nowrap` column heads give this table a
        min-content of 1,053px; the editor column at a 1400px window is 818px. "Reads as" was the
        LAST column, so the one cell that says what the panel is for — "style words, no
        counterweight" / "carries its own specifics" — sat at x=1509..1626 in a 1400px window: off
        screen, with the header cut mid-word at "TRAILI…" and the row backgrounds running flush to
        the card's border. The panel itself carried `overflow-x: auto`, which is why nothing
        overflowed the PAGE, but a padded card is the wrong scrollport: its right padding is not
        preserved at the scroll end, so the clipped column looked like a broken layout rather than
        like something to scroll, and there was no affordance saying otherwise.

        So the verdict moves to the front, where it is visible at every width this product
        supports, and the numbers — which are the detail behind it — are what scrolls. The wrapper
        is `.prose-table-wrap`, built like every other table wrapper in this app
        (`display: grid; grid-template-columns: minmax(0, 1fr); overflow-x: auto`, pinned by
        `denseLayout.css.test.ts`), and it is a labelled `region` with `tabIndex={0}` so a keyboard
        can reach the scroll it creates. Measured after, same 1400px window: the table is 1,102px
        (the verdict column is given 20ch so the longest of the three labels takes two lines rather
        than three), the wrapper is 784px of visible width against a 1,102px `scrollWidth`, the
        `.prose-check` card no longer scrolls at all (818 = 818), and the verdict cell ends at
        x=859 — on screen, before anything is scrolled.
      */}
      {/*
        Said in words, because a clipped column with no visible scrollbar reads as a bug rather
        than as a box with more in it. Phrased for BOTH states: this panel is 818px wide in the
        editor column at 1400px and the table needs 1,102, but it fits on a wide monitor, and a
        sentence that announced scrolling would then be describing something that is not
        happening — the defect this file's neighbours keep being fixed for.
      */}
      <p className="prose-scroll-note">
        The measurements sit in a box of their own: where they do not fit, they scroll sideways in
        it rather than moving the page. The verdict beside each paragraph is never one of them.
      </p>
      <div
        className="prose-table-wrap"
        role="region"
        aria-label="Per-paragraph measurements, scrollable"
        tabIndex={0}
      >
        <table className="grid-table prose-paragraphs">
          <thead>
            <tr>
              <th scope="col">Paragraph</th>
              <th scope="col">Reads as</th>
              <th scope="col" className="num">
                Style words per 100 words
              </th>
              <th scope="col" className="num">
                Proper nouns + figures per 100 words
              </th>
              <th scope="col" className="num">
                Tricolons
              </th>
              <th scope="col" className="num">
                Trailing participials
              </th>
            </tr>
          </thead>
          <tbody>
            {report.paragraphs.map((p) => {
              const d = densityFor(p.index);
              return (
                <tr key={p.index} className={`verdict-${p.verdict}`}>
                  <th scope="row">Paragraph {p.index + 1}</th>
                  <td className="verdict-text">{VERDICT_LABEL[p.verdict] ?? p.verdict}</td>
                  <td className="num data">{d ? round(d.styleDensity) : '—'}</td>
                  <td className="num data">{d ? round(d.referentDensity) : '—'}</td>
                  <td className="num data">{p.tricolonCount}</td>
                  <td className="num data">{p.trailingParticipialCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ol className="prose-paragraph-detail">
        {report.paragraphs.map((p) => (
          <li key={p.index}>
            <h4>Paragraph {p.index + 1}</h4>
            {p.stockTransitionHits.length > 0 ? (
              <p className="prose-hit-line">
                Stock transitions:{' '}
                {p.stockTransitionHits.map((h, i) => (
                  <span key={`${h}-${String(i)}`} className="hit">
                    {h}
                  </span>
                ))}
              </p>
            ) : null}
            {p.styleWordHits.length > 0 ? (
              <p className="muted">Style words: {p.styleWordHits.join(', ')}</p>
            ) : null}
            {p.stockTransitionHits.length === 0 && p.styleWordHits.length === 0 ? (
              <p className="muted">No banned phrase and no style word in this paragraph.</p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
