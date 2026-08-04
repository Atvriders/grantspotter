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

/**
 * A hostname reduced to the one form every rule in this repository compares against: lower-cased,
 * with the DNS root's trailing dot removed — ALL of it, however many dots were typed.
 *
 * Both consumers used to write `.replace(/\.$/, '')` inline, one dot, once, and
 * `https://example.org../x` walked past both of them: `new URL` hands back the hostname
 * `example.org..`, one dot came off, and `example.org.` is neither equal to `example.org` nor a
 * name ending in `.example.org`. A resolver treats every trailing dot as the same root; so does
 * this. Written once, here, because writing it a third time is how it went wrong twice.
 *
 * An IPv6 literal keeps its brackets and is otherwise untouched: the brackets are part of the host
 * in a URL, and a dot inside one belongs to an embedded IPv4 address, not to a label.
 */
export function canonicalHostname(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith('[') ? host : host.replace(/\.+$/, '');
}

/**
 * A bracketed IPv6 literal expanded to its sixteen bytes, or null if it is not readable as one.
 *
 * WHY BYTES AND NOT TEXT. The code this replaces compared SPELLINGS: it regexed `::ffff:<quad>`
 * and `::ffff:<hex>:<hex>`, so it refused `http://[::ffff:127.0.0.1]` and accepted
 * `http://[64:ff9b::7f00:1]` and `http://[::ffff:0:127.0.0.1]` — the same 127.0.0.1, written two
 * other ways that `new URL` parses without complaint. Spellings are unbounded and keep arriving;
 * there are only ever sixteen bytes. Parse once, then ask questions about the bytes.
 *
 * Handles `::` compression and a trailing dotted quad, which is all a URL hostname can contain
 * (WHATWG rejects zone identifiers, so there is no `%eth0` to strip).
 */
function ipv6Bytes(literal: string): Uint8Array | null {
  if (!literal.startsWith('[') || !literal.endsWith(']')) return null;
  let text = literal.slice(1, -1).toLowerCase();

  // A trailing dotted quad is just another way of writing the last two hextets. Rewrite it into
  // them so there is one code path below rather than two.
  const quad = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (quad !== null) {
    const octets = (quad[1] as string).split('.').map((part) => Number.parseInt(part, 10));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const high = (((octets[0] as number) << 8) | (octets[1] as number)).toString(16);
    const low = (((octets[2] as number) << 8) | (octets[3] as number)).toString(16);
    text = `${text.slice(0, text.length - (quad[1] as string).length)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : (halves[0] as string).split(':');
  const tailText = halves.length === 2 ? (halves[1] as string) : '';
  const tail = tailText === '' ? [] : tailText.split(':');
  const written = head.length + tail.length;
  // Without `::` every hextet must be written; with it, at least one must be elided.
  if (halves.length === 1 ? written !== 8 : written > 7) return null;
  const hextets = [...head, ...(new Array<string>(8 - written).fill('0')), ...tail];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const piece = hextets[i] as string;
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    const value = Number.parseInt(piece, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}

function dottedQuadAt(bytes: Uint8Array, offset: number): string {
  return [0, 1, 2, 3].map((i) => bytes[offset + i]).join('.');
}

/**
 * The ways an IPv4 address can be carried inside an IPv6 one, where the IPv4 address it carries
 * still says whether a stranger can reach it.
 *
 * `what` is read after "the IPv4 address <addr> inside ".
 *
 * TEREDO (`2001:0::/32`, RFC 4380) IS DELIBERATELY ABSENT, and the reason is the rule this whole
 * file applies rather than an oversight: a Teredo address embeds the CLIENT's IPv4, and a Teredo
 * client is behind NAT with an RFC 1918 address BY DESIGN, while the IPv6 address itself is
 * globally reachable. Refusing one because the address inside it is private would refuse an
 * address that works. Every family below is the opposite case — the embedded IPv4 is the address
 * that must actually answer.
 */
interface Ipv4Embedding {
  what: string;
  matches(bytes: Uint8Array): boolean;
  ipv4(bytes: Uint8Array): string;
}

const IPV4_EMBEDDINGS: readonly Ipv4Embedding[] = [
  {
    what: 'an IPv4-mapped address (RFC 4291, `::ffff:0:0/96`)',
    matches: (b) => hasPrefix(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]),
    ipv4: (b) => dottedQuadAt(b, 12),
  },
  {
    what: 'an IPv4-translated address (RFC 2765, `::ffff:0:0:0/96`)',
    matches: (b) => hasPrefix(b, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0]),
    ipv4: (b) => dottedQuadAt(b, 12),
  },
  {
    what: 'an IPv4-compatible address (RFC 4291, `::/96`)',
    matches: (b) => hasPrefix(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ipv4: (b) => dottedQuadAt(b, 12),
  },
  {
    what: "NAT64's well-known prefix (RFC 6052, `64:ff9b::/96`)",
    matches: (b) => hasPrefix(b, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]),
    ipv4: (b) => dottedQuadAt(b, 12),
  },
  {
    what: "NAT64's local-use prefix (RFC 8215, `64:ff9b:1::/48`)",
    matches: (b) => hasPrefix(b, [0, 0x64, 0xff, 0x9b, 0, 1, 0, 0, 0, 0, 0, 0]),
    ipv4: (b) => dottedQuadAt(b, 12),
  },
  {
    // Deprecated by RFC 7526, and the embedded address IS the tunnel endpoint that has to answer.
    what: 'a 6to4 address (RFC 3056, `2002::/16`)',
    matches: (b) => hasPrefix(b, [0x20, 0x02]),
    ipv4: (b) => dottedQuadAt(b, 2),
  },
];

function unreachableIpv6(literal: string): string | null {
  const bytes = ipv6Bytes(literal);
  if (bytes === null) {
    // `new URL` only produces a bracketed hostname it managed to parse, so reaching this means the
    // value was hand-assembled. Refusing beats guessing at what it was meant to be.
    return `\`${literal}\`, which is not readable as an IPv6 address`;
  }
  if (bytes.every((byte) => byte === 0)) return 'the unspecified address `::`';
  if (bytes.every((byte, i) => byte === (i === 15 ? 1 : 0))) {
    return 'the IPv6 loopback address `::1`';
  }
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8])) {
    return 'an address in 2001:db8::/32, which RFC 3849 reserves for documentation';
  }
  const firstHextet = ((bytes[0] as number) << 8) | (bytes[1] as number);
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return 'an IPv6 link-local address';
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return 'an IPv6 unique-local address';
  for (const embedding of IPV4_EMBEDDINGS) {
    if (!embedding.matches(bytes)) continue;
    const address = embedding.ipv4(bytes);
    if (UNREACHABLE_IPV4.test(address)) {
      return `the IPv4 address ${address} inside ${embedding.what}, which is loopback, private or reserved space`;
    }
  }
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
  const host = canonicalHostname(hostname);
  if (host === '') return 'no host at all';
  if (host.startsWith('[')) return unreachableIpv6(host);
  if (host.split('.').some((label) => label === '')) {
    // Survives the trailing-dot strip above, so this is an empty label somewhere else:
    // `example..org`, `.example.org`. RFC 1035 §2.3.1 makes those unresolvable, always.
    return `\`${host}\`, which contains an empty DNS label and cannot resolve for anybody`;
  }
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
