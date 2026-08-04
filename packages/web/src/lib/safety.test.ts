import { describe, expect, it } from 'vitest';
import { BLOCKED_HOSTS, LINKABLE_SCHEMES, blockedHostFor, linkRefusal } from './safety.js';

describe('blockedHostFor', () => {
  it('names the blocked host in a plain URL', () => {
    expect(blockedHostFor('https://farweb.org/scholarships')).toBe('farweb.org');
  });

  it('matches a subdomain, because the takeover redirects from www', () => {
    expect(blockedHostFor('https://www.farweb.org/scholarships')).toBe('farweb.org');
  });

  it('ignores case, port and the trailing root dot', () => {
    expect(blockedHostFor('https://FarWeb.ORG:8443/apply?x=1')).toBe('farweb.org');
    expect(blockedHostFor('http://farweb.org./')).toBe('farweb.org');
  });

  it('does not match a host that merely ends with the same letters', () => {
    expect(blockedHostFor('https://notfarweb.org/')).toBeNull();
    expect(blockedHostFor('https://farweb.org.example.com/')).toBeNull();
  });

  it('passes ordinary funder pages through', () => {
    expect(blockedHostFor('https://www.arrl.org/club-grant-program')).toBeNull();
    expect(blockedHostFor('https://www.ardc.net/apply/')).toBeNull();
  });

  it('treats an ABSENT URL as absent — there is no address to warn anyone about', () => {
    expect(blockedHostFor(null)).toBeNull();
    expect(blockedHostFor(undefined)).toBeNull();
    expect(blockedHostFor('')).toBeNull();
    expect(blockedHostFor('   ')).toBeNull();
    expect(linkRefusal(null)).toBeNull();
    expect(linkRefusal('')).toBeNull();
  });

  it('blocks the takeover target as well as the original domain', () => {
    expect(blockedHostFor('https://batualam.org/')).toBe('batualam.org');
  });

  it('covers every host the fetcher refuses', () => {
    for (const host of BLOCKED_HOSTS) {
      expect(blockedHostFor(`https://${host}/anything`)).toBe(host);
    }
    // A vacuity guard: an empty or truncated list would make every assertion above pass while
    // the guard protected nothing.
    expect(BLOCKED_HOSTS.length).toBeGreaterThanOrEqual(7);
  });
});

/**
 * CLOSE-OUT REVIEW I5 — FAIL CLOSED.
 *
 * The two measured escapes, both of which produced "not blocked" and therefore a live `<a href>`:
 *
 *   - `new URL('//farweb.org/apply')` THROWS, so a protocol-relative URL pointing straight at the
 *     hijacked domain was passed through as safe and resolved by the browser;
 *   - `new URL('javascript:alert(1)')` PARSES, with `hostname === ''`, and no scheme was ever
 *     checked, so it was passed through as safe too.
 *
 * The server twin refuses a non-http(s) scheme by name (`fetcher/blocklist.ts`,
 * `UnsupportedSchemeError`); this module claims in its own doc-comment to be "a SECOND enforcement
 * point", and a second enforcement point that is weaker than the first is not one.
 *
 * The rule is an ALLOWLIST, not another blocklist: anything that is not an absolute http or https
 * URL is refused. Enumerating the dangerous schemes would leave `data:`, `vbscript:`, `blob:` and
 * whatever a browser ships next to be discovered the same way this one was.
 */
describe('linkRefusal — nothing but absolute http(s) is ever rendered as a link', () => {
  it('refuses a javascript: URL, which parses cleanly and has no host', () => {
    expect(linkRefusal('javascript:alert(1)')).toEqual({
      kind: 'unsupported_scheme',
      scheme: 'javascript:',
    });
    expect(blockedHostFor('javascript:alert(1)')).not.toBeNull();
  });

  it('refuses every other scheme a stored field could carry', () => {
    for (const url of [
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.test/1234',
      'ftp://example.test/apply',
      'mailto:grants@example.test',
      'JavaScript:alert(1)',
    ]) {
      expect(linkRefusal(url)?.kind, url).toBe('unsupported_scheme');
      expect(blockedHostFor(url), url).not.toBeNull();
    }
  });

  it('refuses a URL the constructor cannot read, including the protocol-relative form', () => {
    expect(linkRefusal('//www.farweb.org/scholarships')).toEqual({ kind: 'unreadable' });
    expect(linkRefusal('not a url')).toEqual({ kind: 'unreadable' });
    expect(linkRefusal('/apply')).toEqual({ kind: 'unreadable' });
    expect(blockedHostFor('//www.farweb.org/scholarships')).not.toBeNull();
  });

  it('still reports a blocked host as a blocked host, by name', () => {
    expect(linkRefusal('https://www.farweb.org/scholarships')).toEqual({
      kind: 'blocked_host',
      host: 'farweb.org',
    });
  });

  it('passes an ordinary absolute http(s) URL through', () => {
    expect(linkRefusal('https://www.arrl.org/club-grant-program')).toBeNull();
    expect(linkRefusal('http://www.arrl.org/club-grant-program')).toBeNull();
  });

  it('is an allowlist of exactly two schemes, and no more', () => {
    expect([...LINKABLE_SCHEMES]).toEqual(['http:', 'https:']);
    expect(Object.isFrozen(LINKABLE_SCHEMES)).toBe(true);
  });
});
