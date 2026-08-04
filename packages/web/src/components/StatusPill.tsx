import type { ProgramStatus } from '@grantspotter/core';
import './badges.css';

const WORDS: Record<ProgramStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  dormant: 'Dormant',
  discontinued: 'Discontinued',
  contact_only: 'Contact only',
  no_application: 'No application exists',
  unknown: 'Unknown',
};

/**
 * What each word MEANS, because five of the seven are not self-evident and the difference between
 * them changes what a reader should do next. `unknown` is 118 of the 150 published records, so its
 * sentence is the one most people will read.
 */
const MEANING: Record<ProgramStatus, string> = {
  open: 'Accepting applications now.',
  closed: 'The application window has passed. Many of these reopen on the next cycle.',
  dormant: 'The funder still exists but has shown no recent activity on this program. It has not been withdrawn.',
  discontinued: 'The funder has ended this program. It is listed so that a stale link elsewhere does not send you looking for it.',
  contact_only: 'There is no application form. You reach this funder by contacting a named person.',
  no_application: 'The funder selects recipients themselves. There is nothing to apply to.',
  unknown: 'No page this pipeline has fetched says whether this program is open. Unknown is what is known — it is not a "no", and it is not a "yes".',
};

const MODIFIER: Partial<Record<ProgramStatus, string>> = {
  open: 'status-open',
  unknown: 'status-unknown',
  discontinued: 'status-discontinued',
};

/** `unknown` is a rendered state, never a blank field (spec §8). */
export function StatusPill({ status }: { status: ProgramStatus }): JSX.Element {
  return (
    <span
      className={`status-pill ${MODIFIER[status] ?? ''}`.trim()}
      role="img"
      aria-label={`Status: ${status}`}
      title={MEANING[status]}
    >
      {WORDS[status]}
    </span>
  );
}
