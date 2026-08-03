import { describe, expect, it } from 'vitest';
import { hashProgram } from '../src/hash.js';
import { makeConstraint, makeProgram } from './fixtures.js';

describe('hashProgram', () => {
  it('is deterministic and returns 64 lowercase hex characters', () => {
    const p = makeProgram();
    expect(hashProgram(p)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashProgram(p)).toBe(hashProgram(makeProgram()));
  });

  // THE load-bearing test. arrl.org has no ETag and no Last-Modified, so every
  // nightly crawl rewrites lastVerifiedAt. If that field were hashed, every
  // record would look changed every single night and the Inbox would be useless.
  it('ignores lastVerifiedAt', () => {
    const before = makeProgram();
    const after = makeProgram({
      trust: { ...before.trust, lastVerifiedAt: '2027-01-15T09:30:00.000Z' },
    });
    expect(hashProgram(after)).toBe(hashProgram(before));
  });

  it('ignores every other TrustField, including status and contentHash', () => {
    const before = makeProgram();
    const after = makeProgram({
      trust: {
        status: 'dormant',
        sourceUrl: 'https://example.org/moved',
        lastVerifiedAt: '2030-01-01T00:00:00.000Z',
        verificationMethod: 'live_fetch',
        contentHash: 'deadbeef',
        staleMirrorWarning: 'a third-party aggregator still lists this as open',
      },
    });
    // Status changes are detected by diffPrograms comparing trust.status
    // directly (Plan 2), not by the content hash.
    expect(hashProgram(after)).toBe(hashProgram(before));
  });

  it('changes when a substantive field changes', () => {
    const before = makeProgram();
    const after = makeProgram({
      amount: { ...before.amount, amountMax: 30000 },
    });
    expect(hashProgram(after)).not.toBe(hashProgram(before));
  });

  it('is insensitive to constraint ordering', () => {
    const a = makeConstraint({ axis: 'gpa', min: 3 }, { id: 'aaa' });
    const b = makeConstraint({ axis: 'financial_need', weighted: true }, { id: 'bbb' });
    expect(hashProgram(makeProgram({ constraints: [a, b] }))).toBe(
      hashProgram(makeProgram({ constraints: [b, a] }))
    );
  });

  it('is insensitive to tag, entity and restriction ordering', () => {
    const one = makeProgram({
      tags: ['scholarship', 'arrl'],
      applicantEntities: ['university', 'individual'],
      fundingRestrictions: ['no ongoing operating expenses', 'no emcomm equipment'],
    });
    const two = makeProgram({
      tags: ['arrl', 'scholarship'],
      applicantEntities: ['individual', 'university'],
      fundingRestrictions: ['no emcomm equipment', 'no ongoing operating expenses'],
    });
    expect(hashProgram(one)).toBe(hashProgram(two));
  });

  // arrl.org's HTML is riddled with non-breaking spaces and inconsistent
  // wrapping. Collapsing whitespace stops a reflowed paragraph reading as a
  // content change.
  it('normalises non-breaking spaces and collapsed whitespace', () => {
    const plain = makeProgram({ summary: 'A single application across 111 entries.' });
    const gnarly = makeProgram({
      summary: '  A single application   across\n111 entries.  ',
    });
    expect(hashProgram(gnarly)).toBe(hashProgram(plain));
  });

  it('distinguishes an absent optional field from an empty one', () => {
    const absent = makeProgram();
    const present = makeProgram({ applyContact: '' });
    expect(hashProgram(present)).not.toBe(hashProgram(absent));
  });

  // Nested arrays, not just the top-level ones hashProgram sorts explicitly.
  // A parser re-scraping the same page legitimately emits GeoSpec.values (and
  // every other constraint-spec array — fields, excludedFields, degreeLevels,
  // allowed, stages, activityKinds) in a different order between runs. If
  // order were content there, a phantom eligibility_changed would fire every
  // night the order happened to flip.
  it('is insensitive to nested constraint-spec array ordering (GeoSpec.values)', () => {
    // Same constraint id on both sides: only the nested array order differs.
    const forward = makeConstraint(
      { axis: 'geography', geo: { type: 'state', values: ['TX', 'OK'] } },
      { id: 'geo1' },
    );
    const reversed = makeConstraint(
      { axis: 'geography', geo: { type: 'state', values: ['OK', 'TX'] } },
      { id: 'geo1' },
    );
    expect(hashProgram(makeProgram({ constraints: [forward] }))).toBe(
      hashProgram(makeProgram({ constraints: [reversed] })),
    );
  });

  it('still changes when nested constraint-spec array CONTENT changes (not just order)', () => {
    const original = makeConstraint(
      { axis: 'geography', geo: { type: 'state', values: ['TX', 'OK'] } },
      { id: 'geo1' },
    );
    const differentContent = makeConstraint(
      { axis: 'geography', geo: { type: 'state', values: ['TX', 'CA'] } },
      { id: 'geo1' },
    );
    expect(hashProgram(makeProgram({ constraints: [original] }))).not.toBe(
      hashProgram(makeProgram({ constraints: [differentContent] })),
    );
  });
});
