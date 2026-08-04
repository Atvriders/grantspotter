import { canonicalHostname } from '../net/hosts.js';

/**
 * Hard domain blocklist. Enforced inside the fetcher (see ./index.ts), never at a call site,
 * and deliberately not configurable: there is no environment variable, no constructor option,
 * and no other list anywhere that can re-permit any host named here.
 *
 * farweb.org  — SAFETY. The Foundation for Amateur Radio's domain was taken over between
 *   2025-10-17 and 2026-02-10 (per Wayback) and now 301s to batualam.org, an Indonesian
 *   gambling site. QCWA, ARRL and club pages still tell applicants to "apply at the FAR
 *   website", so an unguarded crawler would surface it to a student.
 * batualam.org — the takeover target itself. Listed so a redirect chain that reaches it is
 *   refused by host, not only by the redirect guard.
 * candid.org / fconline.foundationcenter.org — the Candid API License Agreement prohibits
 *   republishing, prohibits "data mining, robots or similar data gathering and extraction
 *   methods", and specifically prohibits use for "artificial intelligence, large language
 *   models, machine learning, or similar applications" — a restriction that SURVIVES
 *   TERMINATION.
 * grantwatch.com — "Automated access, including scripts, bots, or data scraping tools, is
 *   prohibited"; "We do not offer or authorize any API access to our data or platform."
 * grantstation.com — EULA bans robots/spiders and bans use for training large language models.
 * instrumentl.com — ToS bans crawling; robots.txt explicitly names anthropic-ai, ClaudeBot and
 *   Claude-Web and disallows /grants, /foundations, /990-report.
 *
 * THE THREE CALLSIGN DIRECTORIES (added 2026-08-04, with the callsign lookup). These are not
 * funding sites and nothing in this product has any reason to fetch them — which is exactly why
 * they are written down. GrantSpotter now looks a US callsign up at callook.info when a person
 * presses a button (see `callsign/callook.ts`), and the next idea anybody has about that feature
 * is a second source for when the first one is down. These three are the second sources, each
 * has said no in writing, and a list is the only form of "no" that survives the person who read
 * it. This is the `instrumentl.com` pattern exactly: consistency means naming a host we have
 * decided not to contact, rather than quietly not contacting it.
 *
 * qrz.com — its Terms of Service forbid automated access AND forbid storing what the database
 *   returns. Both halves matter here: the first rules out asking, and the second would rule out
 *   this product's entire shape even if the first did not, because a lookup that fills a profile
 *   is a lookup whose answer is kept.
 * hamcall.net — its robots.txt names `ClaudeBot`, `Claude-Web` and `anthropic-ai` one after
 *   another and then closes with `User-agent: *` / `Disallow: /`. There is no reading of that
 *   file under which this software is welcome.
 * buckmasterinternational.com — Buckmaster operates HamCall. The same operator's other domain is
 *   listed with it so that a redirect, a rebrand or an API on the corporate host does not become
 *   a way round a decision that was made about the operator and not about the hostname.
 *
 * We deep-link out to the commercial aggregators where a human would find them useful.
 * We never store their text.
 */
export const BLOCKED_HOSTS: readonly string[] = Object.freeze([
  'farweb.org',
  'batualam.org',
  'candid.org',
  'fconline.foundationcenter.org',
  'grantwatch.com',
  'grantstation.com',
  'instrumentl.com',
  'qrz.com',
  'hamcall.net',
  'buckmasterinternational.com',
]);

export class BlockedHostError extends Error {
  readonly host: string;
  readonly url: string;
  constructor(url: string, host: string) {
    super(
      `Blocked host: ${host} (${url}). This host is listed in ` +
        `packages/server/src/fetcher/blocklist.ts and cannot be enabled by configuration.`,
    );
    this.name = 'BlockedHostError';
    this.host = host;
    this.url = url;
  }
}

export class UnsupportedSchemeError extends Error {
  readonly scheme: string;
  readonly url: string;
  constructor(url: string, scheme: string) {
    super(`Unsupported scheme: ${scheme} (${url}). The fetcher speaks http and https only.`);
    this.name = 'UnsupportedSchemeError';
    this.scheme = scheme;
    this.url = url;
  }
}

/**
 * Lowercased hostname with userinfo, port and every trailing root dot removed.
 *
 * The third copy of `.replace(/\.$/, '')` in this repository, and the one with teeth: it decides
 * whether a URL is on the hard blocklist, so `https://farweb.org../` reached the
 * `farweb.org -> batualam.org` takeover check as `farweb.org.` and matched nothing. It now shares
 * `canonicalHostname` with the two CONTACT_URL rules — one spelling of "what a hostname is".
 */
export function normalizeHost(url: string): string {
  return canonicalHostname(new URL(url).hostname);
}

/**
 * Throws BlockedHostError for any blocked host or subdomain thereof, and
 * UnsupportedSchemeError for anything that is not http(s). Returns void — there is
 * deliberately no boolean form, so a caller cannot forget to check the result.
 */
export function assertNotBlocked(url: string): void {
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new UnsupportedSchemeError(url, scheme);
  }
  const host = normalizeHost(url);
  for (const blocked of BLOCKED_HOSTS) {
    if (host === blocked || host.endsWith(`.${blocked}`)) {
      throw new BlockedHostError(url, host);
    }
  }
}
