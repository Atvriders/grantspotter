import { daysSince, formatDate, isUnverified, UNVERIFIED_AFTER_DAYS } from '../lib/trust.js';
import './badges.css';

export interface TrustBadgeProps {
  lastVerifiedAt: string;
  now?: string;
}

function agePhrase(days: number): string {
  if (!Number.isFinite(days)) return 'date unknown';
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/**
 * Spec §8: lastVerifiedAt on EVERY record. A date with no provenance word is
 * exactly the failure mode this badge exists to prevent, so the word "Verified"
 * or "Unverified" is always present — and an unreadable date renders as an em
 * dash plus "Unverified", never as a fresh-looking blank.
 */
export function TrustBadge({ lastVerifiedAt, now }: TrustBadgeProps): JSX.Element {
  const nowISO = now ?? new Date().toISOString();
  const stale = isUnverified(lastVerifiedAt, nowISO);
  const days = daysSince(lastVerifiedAt, nowISO);
  const date = formatDate(lastVerifiedAt);
  const age = agePhrase(days);

  if (stale) {
    return (
      <span
        className="trust trust-unverified"
        role="img"
        aria-label={
          Number.isFinite(days)
            ? `Unverified. Last checked ${date}, ${age}.`
            : 'Unverified. Last checked date unknown.'
        }
        title={`Nothing has re-checked this record against the funder's own page for more than ${UNVERIFIED_AFTER_DAYS} days. Treat it as a lead to confirm, not as a current fact.`}
      >
        Unverified <span className="trust-date">{date}</span>
      </span>
    );
  }

  return (
    <span
      className="trust"
      role="img"
      aria-label={`Verified ${age}, on ${date}.`}
      title={`This record was last checked against the funder's own page on ${date}. It turns amber once that is more than ${UNVERIFIED_AFTER_DAYS} days old.`}
    >
      Verified <span className="trust-date">{date}</span>
    </span>
  );
}
