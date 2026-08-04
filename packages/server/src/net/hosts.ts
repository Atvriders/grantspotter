/**
 * WHAT AN ADDRESS MEANS, said once, for the two places that have to know.
 *
 * Two rules in this repository ask the same question in different words:
 *
 *   - `seed/validate.ts` scans seed PROSE for a private address, because seed data ships in a
 *     public repository and a LAN address in it is the owner's network, published.
 *   - `config.ts` validates CONTACT_URL's HOST, because that value is pasted verbatim into the
 *     crawler's User-Agent and handed to ~25 small nonprofits, and an address inside a private
 *     range tells them nothing except how the operator's LAN is numbered.
 *
 * They were about to be written twice. This file is the one list, and the two consumers differ
 * only in how they anchor it: prose needs `\b…\b` (find it anywhere in a sentence), a hostname
 * needs `^…$` (the host IS the address or it is not). `net/hosts.test.ts` asserts that the prose
 * patterns this file exports are byte-identical to the ones `seed/validate.ts` used before the
 * two were merged, so the merge changed no seed verdict.
 *
 * WHY THE TWO LISTS ARE NOT ONE LIST. `PRIVATE_IPV4_RANGES` is shared. `UNROUTABLE_IPV4_RANGES`
 * is not, and deliberately: `0.0.0.0`, `169.254.x.x` and the carrier-NAT range are meaningful as
 * a whole hostname and meaningless in prose, where they would only add false positives to a
 * corpus checker that has to stay quiet to be worth reading.
 */

/**
 * RFC 1918 private space and loopback, as unanchored regex source.
 *
 * These three fragments are the exact bodies of the patterns `seed/validate.ts` has always used;
 * it now builds its own array from them rather than spelling them out a second time.
 */
export const PRIVATE_IPV4_RANGES: readonly string[] = [
  '(?:10|127)\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}',
  '192\\.168\\.\\d{1,3}\\.\\d{1,3}',
  '172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}',
];

/**
 * The rest of IPv4 that cannot carry a reply from a stranger's web server: `0.0.0.0/8` ("this
 * network", RFC 1122), `169.254.0.0/16` (link-local, RFC 3927) and `100.64.0.0/10` (carrier-grade
 * NAT, RFC 6598 — an address the operator's ISP shares between subscribers).
 */
const UNROUTABLE_IPV4_RANGES: readonly string[] = [
  '0\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}',
  '169\\.254\\.\\d{1,3}\\.\\d{1,3}',
  '100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}',
];

/**
 * RFC 5737's three documentation ranges. Reserved so that examples cannot name anybody's machine,
 * which is the same reason `example.org` is reserved and the same reason a CONTACT_URL may not use
 * one: the site owner reading it gets an address that routes nowhere.
 *
 * This project's own conventions send documentation here, and that stays true — the ranges belong
 * in READMEs and fixtures. What changed on 2026-08-04 is that a LIVE contact URL may not be one,
 * and `config.test.ts` used to assert the opposite, on the reasoning that RFC 5737 is an address
 * rather than a reserved NAME. That distinction does not survive contact with the reader: a
 * sysadmin at a polled nonprofit cannot reach `192.0.2.10` any more than they can reach
 * `example.org`, and refusing one while accepting the other was the inconsistency this file exists
 * to end.
 */
const DOCUMENTATION_IPV4_RANGES: readonly string[] = [
  '192\\.0\\.2\\.\\d{1,3}',
  '198\\.51\\.100\\.\\d{1,3}',
  '203\\.0\\.113\\.\\d{1,3}',
];

/** Word-bounded, for scanning prose. `seed/validate.ts`'s host patterns are built from these. */
export const PRIVATE_IPV4_PROSE_PATTERNS: readonly RegExp[] = PRIVATE_IPV4_RANGES.map(
  (range) => new RegExp(`\\b${range}\\b`),
);

/** Fully anchored, for testing a hostname that either IS one of these addresses or is not. */
const UNREACHABLE_IPV4 = new RegExp(
  `^(?:${[...PRIVATE_IPV4_RANGES, ...UNROUTABLE_IPV4_RANGES, ...DOCUMENTATION_IPV4_RANGES].join('|')})$`,
);

const DOCUMENTATION_IPV4 = new RegExp(`^(?:${DOCUMENTATION_IPV4_RANGES.join('|')})$`);

/**
 * Names reserved for a use that is not "somewhere on the public internet": RFC 6761's `.localhost`
 * and RFC 6762's `.local` (mDNS, link-local by definition), RFC 8375's `home.arpa`, and
 * `.internal`, which ICANN reserved in 2024 for exactly this and delegates to nobody.
 *
 * RFC 2606's documentation names are NOT here. They are refused too, by `reservedContactName` in
 * `config.ts`, with a different message — "this reaches nobody because it was reserved to reach
 * nobody" is a different mistake from "this reaches your own house", and an operator fixes them
 * differently.
 */
const PRIVATE_USE_SUFFIXES: readonly string[] = ['localhost', 'local', 'internal', 'home.arpa'];

/** The two hextets of an IPv4-mapped IPv6 address, as WHATWG URL normalizes it, in dotted form. */
function mappedIpv4(addr: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (dotted) return dotted[1] as string;
  // `new URL('http://[::ffff:127.0.0.1]/').hostname` is `[::ffff:7f00:1]`: the parser rewrites the
  // dotted quad into hextets, so the literal an operator typed is not the literal we are handed.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (!hex) return null;
  const high = Number.parseInt(hex[1] as string, 16);
  const low = Number.parseInt(hex[2] as string, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function unreachableIpv6(literal: string): string | null {
  const addr = literal.slice(1, -1).toLowerCase(); // strip the [ ] the URL parser keeps
  if (addr === '::') return 'the unspecified address `::`';
  if (addr === '::1') return 'the IPv6 loopback address `::1`';
  if (addr.startsWith('2001:db8:') || addr === '2001:db8::') {
    return 'an address in 2001:db8::/32, which RFC 3849 reserves for documentation';
  }
  const mapped = mappedIpv4(addr);
  if (mapped !== null && UNREACHABLE_IPV4.test(mapped)) {
    return `the IPv4-mapped address ${mapped}, which is loopback or private space`;
  }
  const firstHextet = Number.parseInt(addr.split(':')[0] || '0', 16);
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return 'an IPv6 link-local address';
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return 'an IPv6 unique-local address';
  return null;
}

/**
 * Why this host cannot be reached from the public internet, or null if it might be.
 *
 * "Might be" is the strongest thing this function can say, and the honest one: it does no DNS, so
 * it cannot tell a live club site from a domain that expired last week. What it CAN do is name the
 * addresses that are guaranteed not to reach the operator from somebody else's network — which is
 * the whole question CONTACT_URL has to answer, because the reader of that value is a sysadmin at
 * a polled site, not the operator.
 *
 * The returned string is a noun phrase, meant to be read after "CONTACT_URL points at ".
 */
export function unreachableContactHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return 'no host at all';
  if (host.startsWith('[')) return unreachableIpv6(host);
  if (UNREACHABLE_IPV4.test(host)) {
    if (/^127\./.test(host)) return `the loopback address ${host}, which is the polled site's own machine`;
    if (/^0\./.test(host)) return `${host}, in 0.0.0.0/8, which is not an address anything answers on`;
    if (/^169\.254\./.test(host)) return `the link-local address ${host}`;
    if (DOCUMENTATION_IPV4.test(host)) {
      return `${host}, which RFC 5737 reserves for documentation so that it routes to nobody`;
    }
    return `the private address ${host}, which is inside somebody's LAN and not routable from outside it`;
  }
  if (!host.includes('.')) {
    // A single-label name resolves only against whatever local search domain the reader happens to
    // have. `localhost` is the reader's own machine; `intranet` is theirs, or nothing at all.
    // ICANN has never delegated a dotless name to anybody, so this cannot be a public address.
    return `\`${host}\`, a single-label name with no public DNS delegation`;
  }
  for (const suffix of PRIVATE_USE_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return `a \`.${suffix}\` name, which is reserved for local networks and resolves for nobody else`;
    }
  }
  return null;
}
