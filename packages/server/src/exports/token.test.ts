import { describe, it, expect } from 'vitest';
import { hashIcsToken, newIcsToken } from './token.js';

describe('newIcsToken', () => {
  it('returns a URL-safe token of at least 32 characters', () => {
    const token = newIcsToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  /**
   * 32 random bytes is 256 bits, base64url-encoded to 43 unpadded characters. The length is
   * asserted exactly rather than as a floor, because this token IS the credential for a public,
   * session-less URL: shortening it is the one change to this file that would silently weaken the
   * feed, and a `>= 32` floor would not notice a drop to 24 bytes.
   */
  it('is 43 characters — 256 bits of entropy, base64url, unpadded', () => {
    expect(newIcsToken()).toHaveLength(43);
    expect(newIcsToken()).not.toContain('=');
  });

  it('never repeats across 100 calls', () => {
    const seen = new Set(Array.from({ length: 100 }, () => newIcsToken()));
    expect(seen.size).toBe(100);
  });
});

describe('hashIcsToken', () => {
  it('is a stable 64-character hex digest', () => {
    expect(hashIcsToken('abc')).toBe(hashIcsToken('abc'));
    expect(hashIcsToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different tokens', () => {
    expect(hashIcsToken('abc')).not.toBe(hashIcsToken('abd'));
  });

  /**
   * The stored value must not be the token. If this ever became identity — or anything reversible
   * — a database dump would hand out every subscriber's feed URL, which is exactly what storing a
   * digest exists to prevent.
   */
  it('never stores the token itself', () => {
    const token = newIcsToken();
    expect(hashIcsToken(token)).not.toBe(token);
    expect(hashIcsToken(token)).not.toContain(token);
  });

  it('is SHA-256 of the UTF-8 bytes, pinned against a published vector', () => {
    // The canonical SHA-256("abc"). A pinned vector rather than a self-comparison, so a change of
    // algorithm or encoding is caught rather than absorbed.
    expect(hashIcsToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
