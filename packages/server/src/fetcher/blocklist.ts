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

/** Lowercased hostname with userinfo, port and any trailing root dot removed. */
export function normalizeHost(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname.toLowerCase().replace(/\.$/, '');
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
