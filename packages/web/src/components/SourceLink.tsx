import type { ReactNode } from 'react';
import { linkRefusal } from '../lib/safety.js';
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

/**
 * Why a scheme other than http(s) is withheld — its OWN sentence, never `WHY_BLOCKED_DEFAULT`'s.
 * That sentence is true of the blocklisted aggregators (Candid, GrantWatch, GrantStation and
 * Instrumentl genuinely forbid automated access) and FALSE of a `javascript:` or `data:` address:
 * a scheme has no "terms" to prohibit anything, and telling a reader it does misattributes a
 * technical refusal to a legal one — a reason they cannot act on because it is not true. The real
 * reason is purely mechanical: this product only knows how to turn an absolute http or https
 * address into a link. Worded to match `Opportunity.tsx`'s `refusedUrlSentence`, the one other
 * surface that already had to say this honestly.
 */
function whyUnsupportedScheme(scheme: string): string {
  return (
    `This address uses the ${scheme} scheme. This product links only to absolute http and https ` +
    'addresses, so it is shown here as text and not as a link. Treat it as a broken record ' +
    'rather than as somewhere to go.'
  );
}

/**
 * Why an address this product cannot parse at all is withheld — also purely mechanical, and also
 * its own sentence rather than the licensing one. Mirrors `refusedUrlSentence`'s `unreadable` arm.
 */
const WHY_UNREADABLE =
  'This address is not an absolute http or https URL, so this product cannot tell where it ' +
  'points and will not link it. It is shown here as text.';

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
 *  2. A URL `linkRefusal` refuses is NEVER an anchor — for THREE distinct, honest reasons, not
 *     one sentence stretched thin over all of them:
 *       - `blocked_host` — a host on the fetcher's blocklist. `farweb.org` 301s to an Indonesian
 *         gambling site and ARRL, QCWA and club pages still print "apply at the FAR website"; the
 *         corpus's warning record exists to intercept that sentence, so an anchor here would hand
 *         the reader the exact instruction the record was written to stop. The commercial
 *         aggregators (Candid, GrantWatch, GrantStation, Instrumentl) are blocked for a DIFFERENT
 *         reason — their terms forbid republishing what they hold — and keep their own sentence
 *         so the dangerous case never reads as merely procedural.
 *       - `unsupported_scheme` — `javascript:`, `data:` and whatever else a URL bar accepts. This
 *         used to fall through to the blocklist's licensing sentence, telling a reader that
 *         `javascript:alert(1)` was a host whose "terms prohibit republishing" — a false, useless
 *         reason for a refusal that is actually just "not http(s)".
 *       - `unreadable` — a string `new URL()` cannot parse as a URL at all. Same mechanical
 *         reasoning as `unsupported_scheme`; kept as its own arm because "not a URL" and "the
 *         wrong kind of URL" are different findings even though neither becomes a link.
 *     In every case the URL is still shown, as plain unclickable text beside a sentence saying
 *     why — withholding the address as well would be its own kind of silence.
 *  3. The address always ships with `source-url`, which is `overflow-wrap: anywhere` (see
 *     `styles/base.css`). An address has no spaces in it, so it is one word, so its rendered
 *     width is a floor under every box it sits in — and this component prints one as its own
 *     link text by default. That is how 112 of the 143 shipped records came to scroll sideways at
 *     every measured width from 320 to 1440 but one, in both themes (`styles/base.css` has the
 *     figures). The class goes on here rather than on each of the five call sites for the same
 *     reason rule 1 does: a caller cannot forget it.
 */
export function SourceLink({ href, children, className }: SourceLinkProps): JSX.Element {
  const refusal = linkRefusal(href);
  if (refusal !== null) {
    const spanClass = `blocked-host ${className ?? ''}`.trim();
    switch (refusal.kind) {
      case 'blocked_host':
        return (
          <span className={spanClass} role="alert">
            <strong>Do not visit this address.</strong> <span className="host">{href}</span> resolves
            to <span className="host">{refusal.host}</span>, which this application hard-blocks and
            deliberately does not link. {WHY_BLOCKED[refusal.host] ?? WHY_BLOCKED_DEFAULT}
          </span>
        );
      case 'unsupported_scheme':
        return (
          <span className={spanClass} role="alert">
            <span className="host">{href}</span> {whyUnsupportedScheme(refusal.scheme)}
          </span>
        );
      case 'unreadable':
        return (
          <span className={spanClass} role="alert">
            <span className="host">{href}</span> {WHY_UNREADABLE}
          </span>
        );
    }
  }
  return (
    <a
      className={`source-url ${className ?? ''}`.trim()}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children ?? href}
    </a>
  );
}
