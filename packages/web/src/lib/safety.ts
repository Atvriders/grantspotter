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
 * The only two URL schemes this UI will ever put in an `href`. An ALLOWLIST, deliberately.
 *
 * The blocklist above answers "which hosts", and it is not configurable here or in the fetcher.
 * This answers the question that was never asked at all: `blockedHostFor` used to return `null`
 * whenever `new URL()` threw and never looked at the scheme, so BOTH of these read as "not
 * blocked" and were rendered as live anchors —
 *
 *   - `new URL('//www.farweb.org/scholarships')` THROWS. A protocol-relative URL pointing straight
 *     at the hijacked domain was passed through as safe, and the browser resolves it.
 *   - `new URL('javascript:alert(1)')` PARSES, with `hostname === ''`, so no host ever matched.
 *
 * An allowlist rather than a second blocklist because enumerating the dangerous schemes leaves
 * `data:`, `vbscript:`, `blob:` and whatever a browser ships next to be found the way this one
 * was. The server twin already refuses a non-http(s) scheme by name (`fetcher/blocklist.ts`'s
 * `UnsupportedSchemeError`); this module claims to be a SECOND enforcement point, and one that is
 * weaker than the first is not one.
 */
export const LINKABLE_SCHEMES: readonly string[] = Object.freeze(['http:', 'https:']);

/**
 * Why a URL must not be rendered as a link. Three reasons, because they are three different
 * things to tell a reader and flattening them into a boolean is what let two of them through.
 */
export type LinkRefusal =
  | { kind: 'blocked_host'; host: string }
  | { kind: 'unsupported_scheme'; scheme: string }
  | { kind: 'unreadable' };

/** What `blockedHostFor` reports for a URL `new URL()` cannot read at all. */
export const UNREADABLE_LABEL = 'an address this product cannot read';

/**
 * The reason this URL may not be an anchor, or `null` if it may.
 *
 * FAILS CLOSED. Anything that is not an absolute http(s) URL is refused; only an absent address
 * (`null`, `undefined`, blank) returns `null`, because there is no address to warn anyone about
 * and a "do not visit this" beside nothing would be its own false claim. Every caller already
 * guards the empty case before rendering.
 *
 * Host matching is on the registrable host and its subdomains — `www.farweb.org` is the form the
 * corpus actually carries — and never on a substring, so `notfarweb.org` and
 * `farweb.org.example.com` are both ordinary hosts. Port, case and the DNS root dot are
 * normalised away exactly as the server's `normalizeHost` does.
 */
export function linkRefusal(url: string | null | undefined): LinkRefusal | null {
  if (url === null || url === undefined || url.trim() === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'unreadable' };
  }
  if (!LINKABLE_SCHEMES.includes(parsed.protocol.toLowerCase())) {
    return { kind: 'unsupported_scheme', scheme: parsed.protocol.toLowerCase() };
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const blocked = BLOCKED_HOSTS.find((b) => host === b || host.endsWith(`.${b}`));
  return blocked === undefined ? null : { kind: 'blocked_host', host: blocked };
}

/**
 * The thing this URL resolves to that the product refuses to link, or `null` if there is none.
 *
 * Kept as the predicate every render site already calls (`SourceLink`, the inbox, the detail
 * page): non-null means "show the address, never the anchor". The name still reads "host" because
 * a blocked host is what it reports in every case the corpus produces — all 703 stored URLs are
 * absolute http/https — but it now also reports the scheme of a URL whose scheme is not linkable,
 * and {@link UNREADABLE_LABEL} for one that cannot be parsed at all, so that a caller which only
 * knows how to ask "is this blocked?" cannot be answered "no" about `javascript:alert(1)`.
 *
 * Callers that need to SAY why should use {@link linkRefusal} and word each case themselves; the
 * detail page does.
 */
export function blockedHostFor(url: string | null | undefined): string | null {
  const refusal = linkRefusal(url);
  if (refusal === null) return null;
  switch (refusal.kind) {
    case 'blocked_host':
      return refusal.host;
    case 'unsupported_scheme':
      return refusal.scheme;
    case 'unreadable':
      return UNREADABLE_LABEL;
  }
}
