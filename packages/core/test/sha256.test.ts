import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/sha256.js';

// node:crypto is used HERE, in a test, as an independent oracle. core/src
// must never import it — see packages/core/test/purity.test.ts.
function reference(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('sha256Hex', () => {
  it('matches the published NIST vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches node:crypto across padding boundaries and unicode', () => {
    const cases = [
      '',
      'abc',
      'hello world',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      'Café W1AW —   naïve \u{1F4E1}',
      'x'.repeat(1000),
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
    ];
    for (const c of cases) {
      expect(sha256Hex(c), `mismatch for input of length ${c.length}`).toBe(reference(c));
    }
  });

  it('always returns 64 lowercase hex characters', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
