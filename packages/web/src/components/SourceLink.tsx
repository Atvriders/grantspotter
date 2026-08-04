import type { ReactNode } from 'react';
import { blockedHostFor } from '../lib/safety.js';
import './detail.css';

/**
 * Why each blocked host is withheld, in the words a reader needs. The safety case and the
 * licensing case are genuinely different instructions — one says "this will harm you", the other
 * says "we are not allowed to relay this" — and flattening them into one sentence would make the
 * dangerous one sound procedural.
 */
const WHY_BLOCKED: Readonly<Record<string, string>> = {
  'farweb.org':
    'The Foundation for Amateur Radio’s domain was taken over between 2025-10-17 and 2026-02-10 ' +
    'and now redirects to an online-gambling site. ARRL, QCWA and club pages still tell ' +
    'applicants to "apply at the FAR website" — this record exists to intercept that instruction. ' +
    'FAR’s historical portfolio appears absorbed into the ARRL Foundation.',
  'batualam.org':
    'This is the site the Foundation for Amateur Radio’s former domain now redirects to. It is ' +
    'blocked by host so that a redirect chain cannot reach it either.',
};

const WHY_BLOCKED_DEFAULT =
  'This host is on the application’s hard blocklist and cannot be enabled by configuration. ' +
  'Its terms prohibit republishing what it holds, so this product neither stores its text nor ' +
  'relays a link to it.';

export interface SourceLinkProps {
  href: string;
  /** Link text. Defaults to the URL itself, which is what a reader needs in order to check it. */
  children?: ReactNode;
  className?: string;
}

/**
 * The ONLY way this product renders a URL a source gave it.
 *
 * Two rules, both of which existed as defects first:
 *
 *  1. `rel="noopener noreferrer"` and `target="_blank"` on every outbound link. These are other
 *     people's pages, several of which are single-page portals.
 *  2. A host on the fetcher's blocklist is NEVER an anchor. `farweb.org` 301s to an Indonesian
 *     gambling site and ARRL, QCWA and club pages still print "apply at the FAR website"; the
 *     corpus's warning record exists to intercept that sentence, so an anchor here would hand
 *     the reader the exact instruction the record was written to stop. The URL is still shown —
 *     withholding the address as well would be its own kind of silence — as plain, unclickable
 *     text beside a sentence saying why.
 */
export function SourceLink({ href, children, className }: SourceLinkProps): JSX.Element {
  const blocked = blockedHostFor(href);
  if (blocked !== null) {
    return (
      <span className={`blocked-host ${className ?? ''}`.trim()} role="alert">
        <strong>Do not visit this address.</strong> <span className="host">{href}</span> resolves
        to <span className="host">{blocked}</span>, which this application hard-blocks and
        deliberately does not link. {WHY_BLOCKED[blocked] ?? WHY_BLOCKED_DEFAULT}
      </span>
    );
  }
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children ?? href}
    </a>
  );
}
