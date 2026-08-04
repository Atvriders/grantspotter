import { describe, expect, it } from 'vitest';
import { PRIVATE_IPV4_PROSE_PATTERNS, PRIVATE_IPV4_RANGES, unreachableContactHost } from './hosts.js';

/**
 * Two consumers, one list — and the proof that merging them changed nothing for the older one.
 *
 * `seed/validate.ts` has scanned seed prose for private addresses since Task 11. `config.ts` needed
 * the same ranges on 2026-08-04 to refuse a CONTACT_URL pointing into somebody's LAN. Writing them
 * twice is how this repository's worst defects have always started, so the ranges moved here — but
 * a shared list is only an improvement if the older consumer's behaviour is provably untouched,
 * which is what the first test below is for. The literals it compares against are the ones that
 * stood in `seed/validate.ts` immediately before the merge, transcribed once, here, so that a later
 * edit to the shared list has to come past them.
 */
describe('the private-address list the seed validator has always used', () => {
  it('produces byte-identical prose patterns to the ones seed/validate.ts spelled out', () => {
    expect(PRIVATE_IPV4_PROSE_PATTERNS.map((r) => r.source)).toEqual([
      '\\b(?:10|127)\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b',
      '\\b192\\.168\\.\\d{1,3}\\.\\d{1,3}\\b',
      '\\b172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}\\b',
    ]);
    expect(PRIVATE_IPV4_RANGES).toHaveLength(3);
  });

  it('still finds an address in the middle of a sentence, which is what prose scanning is for', () => {
    const hits = (text: string) => PRIVATE_IPV4_PROSE_PATTERNS.filter((p) => p.test(text)).length;
    expect(hits('Apply at the club server, 192.168.1.50, before July.')).toBe(1);
    expect(hits('Deadline is 10.30 on the 4th.')).toBe(0); // a time, not an address
    expect(hits('Award amounts range from $172.16 to $500.')).toBe(0);
  });
});

/**
 * The host rule CONTACT_URL is held to. Anchored, never substring: the cost of a false positive is
 * an operator whose real club domain is refused, and every over-refusal pushes somebody toward a
 * value that parses and reaches nobody — the exact failure this whole rule exists to prevent.
 */
describe('unreachableContactHost', () => {
  it('names why, for each class a person actually types', () => {
    const cases: Record<string, RegExp> = {
      '127.0.0.1': /loopback/,
      '127.13.2.9': /loopback/,
      localhost: /single-label/,
      '[::1]': /loopback/,
      '[::ffff:127.0.0.1]': /IPv4-mapped/,
      '[::ffff:7f00:1]': /IPv4-mapped/, // what WHATWG URL rewrites the line above into
      '[::]': /unspecified/,
      '[fe80::1]': /link-local/,
      '[febf::1]': /link-local/,
      '[fd00::5]': /unique-local/,
      '[fc00::5]': /unique-local/,
      '[2001:db8::1]': /RFC 3849/,
      '192.168.1.5': /private address/,
      '10.0.0.7': /private address/,
      '172.20.3.4': /private address/,
      '172.31.255.255': /private address/,
      '0.0.0.0': /0\.0\.0\.0\/8/,
      '169.254.10.2': /link-local/,
      '100.100.20.3': /private address/, // carrier NAT: not yours to be reached at either
      intranet: /single-label/,
      a: /single-label/,
      'gs.local': /`\.local`/,
      'gs.internal': /`\.internal`/,
      'gs.home.arpa': /`\.home\.arpa`/,
      '192.0.2.10': /RFC 5737/,
      '198.51.100.4': /RFC 5737/,
      '203.0.113.9': /RFC 5737/,
    };
    for (const [host, why] of Object.entries(cases)) {
      const reason = unreachableContactHost(host);
      expect(reason, host).not.toBeNull();
      expect(reason as string, host).toMatch(why);
    }
  });

  it('passes anything that could be somebody’s public address', () => {
    for (const host of [
      'w9xyz-radio-club.org',
      'www.arrl.org',
      'gs.w9xyz.org.uk',
      'localhost-hosting.org', // a registrable domain that merely starts with the word
      'local.w9xyz-radio-club.org', // `local` as a label, not as the TLD
      'internal.w9xyz-radio-club.org',
      'home.arpa.w9xyz-radio-club.org',
      '10-10-international.org', // the 10-10 International Net: digits, hyphens, real club
      'a.b', // two labels is enough to be delegable
      '172.15.0.1', // just below the RFC 1918 block
      '172.32.0.1', // just above it
      '11.0.0.1', // 10/8 stops at 10
      '128.0.0.1', // 127/8 stops at 127
      '169.253.0.1',
      '100.63.0.1', // just below 100.64/10
      '100.128.0.1', // just above it
      '192.0.3.1', // one octet off TEST-NET-1
      '[2001:db9::1]', // one hex digit off the documentation prefix
      '[2606:4700::1111]',
    ]) {
      expect(unreachableContactHost(host), host).toBeNull();
    }
  });

  it('is not fooled by case or a trailing dot, which are the same host', () => {
    expect(unreachableContactHost('LOCALHOST')).not.toBeNull();
    expect(unreachableContactHost('gs.LOCAL.')).not.toBeNull();
    expect(unreachableContactHost('127.0.0.1.')).not.toBeNull();
    expect(unreachableContactHost('W9XYZ-Radio-Club.org.')).toBeNull();
  });
});
