import { Link } from 'react-router-dom';
import { formatDate } from '../lib/trust.js';
import './watchlist.css';

/**
 * One row of `GET /api/notifications`. The server composes `title` and `body` (and redacts any
 * blocklisted host out of both) so that the in-app digest, the webhook payload and the ntfy push
 * all say the same sentence; this component renders that sentence rather than composing a second
 * one from the parts.
 */
export interface NotificationRow {
  id: string;
  sourceId: string | null;
  programId: string | null;
  programName: string | null;
  kind: string;
  title: string;
  body: string;
  fieldPath: string | null;
  before: string | null;
  after: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationListProps {
  rows: NotificationRow[];
  onMarkRead: (id: string) => void;
}

/**
 * The change digest.
 *
 * THE BODY IS ALWAYS RENDERED, even when `before`/`after` are shown as chips above it. The chips
 * are the at-a-glance signal; the body is the only place the INSTRUCTION lives — every notification
 * the server composes ends in one ("Check the funder's own page before you rely on either date."),
 * and a digest that shows only the two dates has dropped the sentence that makes the notification
 * actionable. A notification a user cannot act on is worse than none.
 *
 * There is no empty branch here beyond a plain sentence: whether an empty digest means "nothing
 * changed", "the drain stalled" or "the alarm reached nobody" is answered by the route, which is
 * where the health readings are in scope.
 */
export function NotificationList({ rows, onMarkRead }: NotificationListProps): JSX.Element {
  if (rows.length === 0) {
    return <p className="wl-empty">No change has been recorded on the programs you watch.</p>;
  }

  return (
    <ul className="wl-digest">
      {rows.map((row) => (
        <li key={row.id} className={row.readAt === null ? 'wl-unread' : ''}>
          <span className="wl-kind">{row.kind.replace(/_/g, ' ')}</span>
          <h3>{row.title}</h3>

          {row.before !== null && row.after !== null && (
            <span className="wl-move">
              <span className="wl-move-label">was</span>
              <span className="wl-was">{row.before}</span>
              <span className="wl-move-label">now</span>
              <span className="wl-now">{row.after}</span>
            </span>
          )}

          <p className="wl-advice">{row.body}</p>

          <span className="eyebrow">
            Detected <span className="data">{formatDate(row.createdAt)}</span>
            {row.fieldPath !== null && (
              <>
                {' · field '}
                <span className="data">{row.fieldPath}</span>
              </>
            )}
            {/* A source-level alarm (a parser that returned nothing) names no programme. Without
                the source id it would be an alarm about nothing a reader can locate. */}
            {row.programId === null && row.sourceId !== null && (
              <>
                {' · source '}
                <span className="data">{row.sourceId}</span>
              </>
            )}
          </span>

          <span className="wl-actions">
            {row.programId !== null && (
              <Link className="btn" to={`/o/${row.programId}`}>
                Open the record
              </Link>
            )}
            {row.readAt === null && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onMarkRead(row.id);
                }}
              >
                Mark read
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
