import { formatDate } from '../lib/trust.js';
import { SourceLink } from './SourceLink.js';
import './detail.css';

/**
 * Mirrors `packages/server/src/api/browseTypes.ts`'s `FieldProvenance`. Restated rather than
 * imported because import direction is one-way — `web` may import `core`, never `server`.
 */
export interface FieldProvenance {
  fieldPath: string;
  sourceId: string;
  snapshotId: string | null;
  rawLabel: string;
  rawValue: string;
  fetchedAt: string;
  /** The page this value was read off, or null when the row cannot be traced to one. */
  sourceUrl: string | null;
}

/**
 * Spec §8: which source, which fetch, and the raw text the value came from — so a professional
 * can go and check it.
 *
 * This panel is the answer to a specific class of failure this corpus has already produced: a
 * Yaesu "the repeater must remain on the air for 12 months" obligation that appeared ZERO times
 * in the funder's own 145 KB captured page and existed only in a hand-written fixture, and was
 * then repeated as fact until someone grepped the bytes. A value with no traceable page is not
 * necessarily wrong, but it is a different kind of claim, and the reader has to be able to see
 * which kind they are looking at.
 */
export function ProvenanceTable({ rows }: { rows: FieldProvenance[] }): JSX.Element {
  if (rows.length === 0) {
    /**
     * NOT an empty table. Nothing writes field provenance until a "Verify now" runs, so this is
     * the state all 150 published programmes are in today — and an empty table with headers
     * reads as "we looked, and each value came from nowhere", which is a stronger and different
     * claim than "we have not captured this yet".
     */
    return (
      <p>
        <strong>No captured provenance.</strong> Nothing has recorded, field by field, where the
        values above came from. Provenance is written when a page is fetched, so run{' '}
        <strong>Verify now</strong> to capture it. Until then the record&rsquo;s single source is
        the page listed under <em>Source</em>, and the values here are untraced.
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="grid-table" aria-label="Field provenance">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Source label</th>
            <th scope="col">Raw value</th>
            <th scope="col">Source</th>
            <th scope="col">Page</th>
            <th scope="col">Fetch</th>
            <th scope="col" className="num">Fetched (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.sourceId}:${row.fieldPath}:${row.rawLabel}`}>
              <td className="data">{row.fieldPath}</td>
              <td className="data">{row.rawLabel}</td>
              <td className="data">{row.rawValue}</td>
              <td className="data">{row.sourceId}</td>
              <td>
                {row.sourceUrl === null ? (
                  <span className="untraceable">Not traceable to a page</span>
                ) : (
                  <SourceLink href={row.sourceUrl} />
                )}
              </td>
              <td className="data">{row.snapshotId ?? 'No snapshot'}</td>
              <td className="num">{formatDate(row.fetchedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
