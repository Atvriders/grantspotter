import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_HOSTS,
  BlockedHostError,
  UnsupportedSchemeError,
  assertNotBlocked,
  normalizeHost,
} from './blocklist.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED = [
  'farweb.org',
  'candid.org',
  'fconline.foundationcenter.org',
  'grantwatch.com',
  'grantstation.com',
  'instrumentl.com',
];

describe('BLOCKED_HOSTS', () => {
  it('contains every host the design requires', () => {
    expect(BLOCKED_HOSTS).toEqual(expect.arrayContaining(REQUIRED));
  });

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(BLOCKED_HOSTS)).toBe(true);
    expect(() => (BLOCKED_HOSTS as string[]).push('example.test')).toThrow(TypeError);
  });

  it('is stored lowercase with no scheme, port, or path', () => {
    for (const host of BLOCKED_HOSTS) {
      expect(host).toBe(host.toLowerCase());
      expect(host).not.toMatch(/[:/]/);
    }
  });
});

describe('normalizeHost', () => {
  it('lowercases, strips the port, strips a trailing dot, and drops userinfo', () => {
    expect(normalizeHost('https://FarWeb.ORG:8443/apply?x=1')).toBe('farweb.org');
    expect(normalizeHost('http://farweb.org./')).toBe('farweb.org');
    expect(normalizeHost('https://user:pass@farweb.org/x')).toBe('farweb.org');
  });
});

describe('assertNotBlocked', () => {
  it('allows hosts that are not on the list', () => {
    expect(() => assertNotBlocked('http://www.arrl.org/scholarship-descriptions')).not.toThrow();
    expect(() => assertNotBlocked('https://www.ardc.net/apply/')).not.toThrow();
  });

  it('blocks the exact host', () => {
    expect(() => assertNotBlocked('https://farweb.org/')).toThrow(BlockedHostError);
  });

  it('blocks every subdomain, however deep', () => {
    for (const url of [
      'https://www.farweb.org/',
      'https://apply.farweb.org/scholarships',
      'https://a.b.c.farweb.org/',
      'https://fconline.foundationcenter.org/search',
    ]) {
      expect(() => assertNotBlocked(url)).toThrow(BlockedHostError);
    }
  });

  it('is not fooled by a host that merely ends with the same letters', () => {
    expect(() => assertNotBlocked('https://notfarweb.org/')).not.toThrow();
    expect(() => assertNotBlocked('https://farweb.org.example.test/')).not.toThrow();
  });

  it('blocks every scheme, case, port, trailing-dot and userinfo variation', () => {
    for (const url of [
      'http://farweb.org/',
      'HTTPS://FARWEB.ORG/',
      'https://farweb.org:8443/',
      'https://farweb.org./',
      'https://someone:secret@farweb.org/',
      'https://GrantWatch.com/grants',
      'https://www.instrumentl.com/grants/amateur-radio-digital-communications-grants',
    ]) {
      expect(() => assertNotBlocked(url)).toThrow(BlockedHostError);
    }
  });

  it('rejects non-http(s) schemes outright', () => {
    expect(() => assertNotBlocked('file:///etc/passwd')).toThrow(UnsupportedSchemeError);
    expect(() => assertNotBlocked('data:text/html,<b>x</b>')).toThrow(UnsupportedSchemeError);
    expect(() => assertNotBlocked('ftp://example.test/x')).toThrow(UnsupportedSchemeError);
  });

  it('rejects unparseable input rather than letting it through', () => {
    expect(() => assertNotBlocked('not a url')).toThrow();
  });

  it('blocks a redirect target exactly like a direct request, so a permitted host that 301s to a blocked host is not followed', () => {
    // assertNotBlocked has no notion of "initial request" vs "redirect hop" — it is a
    // pure function of whatever URL string it is given. A fetcher that calls it on the
    // Location header of every hop (not only the first request URL) therefore cannot be
    // walked from a permitted host into farweb.org via a 301/302.
    const permittedHostRequest = 'https://qcwa.org/scholarships';
    expect(() => assertNotBlocked(permittedHostRequest)).not.toThrow();

    const redirectLocationHeader = 'https://farweb.org/apply?ref=qcwa';
    expect(() => assertNotBlocked(redirectLocationHeader)).toThrow(BlockedHostError);

    // A redirect can also land on the takeover domain directly.
    expect(() => assertNotBlocked('https://batualam.org/')).toThrow(BlockedHostError);
  });

  it('names the host and the file in the error message', () => {
    try {
      assertNotBlocked('https://apply.farweb.org/x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedHostError);
      const e = err as BlockedHostError;
      expect(e.host).toBe('apply.farweb.org');
      expect(e.message).toContain('blocklist.ts');
      expect(e.message).toContain('cannot be enabled by configuration');
    }
  });
});

describe('the blocklist has no configuration escape hatch', () => {
  it('reads no environment variable and exposes no override', async () => {
    const src = await readFile(path.join(HERE, 'blocklist.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/\b(allowlist|bypass|override|skipBlocklist|disableBlocklist)\b/i);
  });
});
