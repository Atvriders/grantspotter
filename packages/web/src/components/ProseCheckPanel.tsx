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

      <table className="grid-table prose-paragraphs">
        <thead>
          <tr>
            <th scope="col">Paragraph</th>
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
            <th scope="col">Reads as</th>
          </tr>
        </thead>
        <tbody>
          {report.paragraphs.map((p) => {
            const d = densityFor(p.index);
            return (
              <tr key={p.index} className={`verdict-${p.verdict}`}>
                <th scope="row">Paragraph {p.index + 1}</th>
                <td className="num data">{d ? round(d.styleDensity) : '—'}</td>
                <td className="num data">{d ? round(d.referentDensity) : '—'}</td>
                <td className="num data">{p.tricolonCount}</td>
                <td className="num data">{p.trailingParticipialCount}</td>
                <td>{VERDICT_LABEL[p.verdict] ?? p.verdict}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

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
