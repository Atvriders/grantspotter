/**
 * Hosts this UI must never turn into a clickable link.
 *
 * SOURCE OF TRUTH IS `packages/server/src/fetcher/blocklist.ts`. The list is restated here for
 * the same reason `api/client.ts` restates `ApiErrorCode`: import direction is one-way, `web`
 * may import `core` and never `server`, and `core` is required to stay pure. This is a SECOND
 * enforcement point, not a replacement — the fetcher's is the one that stops a crawl, and it is
 * not configurable there either.
 *
 * Why a browser-side copy earns its keep rather than being redundant:
 *   - `farweb.org` is blocklisted for SAFETY, not licensing. The Foundation for Amateur Radio's
 *     domain was taken over between 2025-10-17 and 2026-02-10 and now 301s to an Indonesian
 *     gambling site, while QCWA pages, ARRL pages and club pages still tell applicants to
 *     "apply at the FAR website". The corpus's Tier-D record exists to INTERCEPT that
 *     instruction, so rendering its `applyUrl` as an anchor would defeat the record's only job.
 *   - The fetcher never sees `applyUrl`. It is a value the pipeline STORES and this page RENDERS;
 *     nothing between the two refuses it. 76% of records once carried an apply URL their own
 *     page contradicted, and 345 ARDC awards advertised a grant recipient's Facebook page as the
 *     place to apply, so an apply URL is exactly the field that has been wrong before.
 *   - The commercial aggregators below are here for licence reasons and we do deep-link out to
 *     them elsewhere; withholding those links costs a user nothing they cannot reach by typing.
 *
 * If the two lists ever diverge, the fetcher's wins — it is the one with teeth.
 */
export const BLOCKED_HOSTS: readonly string[] = Object.freeze([
  'farweb.org',
  'batualam.org',
  'candid.org',
  'fconline.foundationcenter.org',
  'grantwatch.com',
  'grantstation.com',
  'instrumentl.com',
]);

/**
 * The blocked host this URL resolves to, or `null`.
 *
 * Matching is on the registrable host and its subdomains — `www.farweb.org` is the form the
 * corpus actually carries — and never on a substring, so `notfarweb.org` and
 * `farweb.org.example.com` are both ordinary hosts. Port, case and the DNS root dot are
 * normalised away exactly as the server's `normalizeHost` does.
 *
 * An unparseable URL returns `null` rather than throwing: a value that is not a URL is not a
 * link this page would render in the first place, and a throw here would take the whole detail
 * page down over a malformed field.
 */
export function blockedHostFor(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === '') return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  return BLOCKED_HOSTS.find((b) => host === b || host.endsWith(`.${b}`)) ?? null;
}
