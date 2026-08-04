import { describe, expect, it } from 'vitest';
import { BLOCKED_HOSTS, blockedHostFor } from './safety.js';

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

  it('treats an unparseable or absent URL as not-blocked, since nothing is rendered anyway', () => {
    expect(blockedHostFor(null)).toBeNull();
    expect(blockedHostFor(undefined)).toBeNull();
    expect(blockedHostFor('')).toBeNull();
    expect(blockedHostFor('not a url')).toBeNull();
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
