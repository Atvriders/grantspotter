import type { Program } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { detectYieldDrop, diffPrograms, shouldSuppressVanished } from './index.js';

const NOW = '2026-08-02T00:00:00.000Z';

function program(over: Partial<Program> = {}): Program {
  return {
    id: 'src--entry--abcdef12',
    funderId: 'arrl-foundation',
    name: 'YASME Foundation Scholarship',
    klass: 'ham_scholarship',
    summary: 'A scholarship.',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_fixed', amountMin: 5000, amountMax: 5000, amountRaw: '$5,000', awardCountRaw: 'Three' },
    deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'owner' }, note: '' },
    applyVia: 'external_spa_portal',
    constraints: [
      { id: 'license-0-aaaa', hard: true, fallbackRank: 0, rawText: 'General or higher', spec: { axis: 'license', licenseMin: 'GENERAL' } },
    ],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
      lastVerifiedAt: NOW,
      verificationMethod: 'live_fetch',
      contentHash: 'hash-a',
    },
    rawOtherText: 'Top 5 to 10 percent of the class.',
    tags: [],
    ...over,
  };
}

describe('diffPrograms — new and vanished', () => {
  it('emits new for a record that was not there last night', () => {
    const events = diffPrograms([], [program()], 'src', NOW);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('new');
    expect(events[0].programId).toBe(program().id);
    expect(events[0].sourceId).toBe('src');
    expect(events[0].detectedAt).toBe(NOW);
    expect(events[0].after).toEqual(program());
    expect(events[0].before).toBeUndefined();
  });

  it('emits vanished for a record that disappeared', () => {
    const events = diffPrograms([program()], [], 'src', NOW);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('vanished');
    expect(events[0].before).toEqual(program());
    expect(events[0].after).toBeUndefined();
  });

  it('emits nothing at all when nothing changed', () => {
    expect(diffPrograms([program()], [program()], 'src', NOW)).toEqual([]);
  });

  it('ignores a lastVerifiedAt-only change — otherwise every record changes every night', () => {
    const before = program();
    const after = program({ trust: { ...program().trust, lastVerifiedAt: '2026-08-03T00:00:00.000Z' } });
    expect(diffPrograms([before], [after], 'src', NOW)).toEqual([]);
  });

  it('gives every event a unique id', () => {
    const events = diffPrograms([], [program(), program({ id: 'src--other--bbbb1111' })], 'src', NOW);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });
});

describe('diffPrograms — field-level classification', () => {
  it('emits deadline_changed when the deadline spec moves', () => {
    const after = program({
      deadline: { kind: 'annual_window', source: { kind: 'self' }, note: 'moved' },
    });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['deadline_changed']);
    expect(events[0].fieldPath).toBe('deadline');
    expect(events[0].before).toEqual(program().deadline);
    expect(events[0].after).toEqual(after.deadline);
  });

  it('emits amount_changed when any part of the amount spec moves', () => {
    const after = program({ amount: { ...program().amount, amountMax: 7500, amountRaw: '$7,500' } });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['amount_changed']);
    expect(events[0].fieldPath).toBe('amount');
  });

  it('emits eligibility_changed when a constraint changes', () => {
    const after = program({
      constraints: [
        { id: 'license-0-aaaa', hard: true, fallbackRank: 0, rawText: 'Extra only', spec: { axis: 'license', licenseMin: 'EXTRA' } },
      ],
    });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['eligibility_changed']);
    expect(events[0].fieldPath).toBe('constraints');
  });

  it('emits eligibility_changed for a rawOtherText change, because unmodelled rules live there', () => {
    const after = program({ rawOtherText: 'Top 5 percent of the class, and a new essay requirement.' });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['eligibility_changed']);
    expect(events[0].fieldPath).toBe('rawOtherText');
  });

  it('emits status_changed when the trust status moves', () => {
    const after = program({ trust: { ...program().trust, status: 'closed' } });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['status_changed']);
    expect(events[0].fieldPath).toBe('trust.status');
    expect(events[0].before).toBe('open');
    expect(events[0].after).toBe('closed');
  });

  it('emits several events when several axes move at once', () => {
    const after = program({
      amount: { ...program().amount, amountRaw: '$6,000' },
      deadline: { kind: 'annual_window', source: { kind: 'self' }, note: '' },
      trust: { ...program().trust, status: 'closed' },
    });
    const kinds = diffPrograms([program()], [after], 'src', NOW).map((e) => e.kind);
    expect(kinds.sort()).toEqual(['amount_changed', 'deadline_changed', 'status_changed']);
  });

  it('emits NO event for a summary-only reword — that would flood the inbox with noise', () => {
    const after = program({ summary: 'A scholarship for licensed students.' });
    expect(diffPrograms([program()], [after], 'src', NOW)).toEqual([]);
  });

  it('emits NO event for a tags-only change', () => {
    expect(diffPrograms([program()], [program({ tags: ['x'] })], 'src', NOW)).toEqual([]);
  });
});

describe('detectYieldDrop', () => {
  it('fires when the parse yield falls below expectedMinRecords', () => {
    const event = detectYieldDrop('arrl-scholarship-descriptions', 42, 100, NOW);
    expect(event?.kind).toBe('parse_yield_dropped');
    expect(event?.sourceId).toBe('arrl-scholarship-descriptions');
    expect(event?.before).toEqual({ expectedMinRecords: 100 });
    expect(event?.after).toEqual({ parsedCount: 42 });
    expect(event?.programId).toBeUndefined();
  });

  it('fires hardest on a silent zero — the most likely way this app rots', () => {
    expect(detectYieldDrop('arrl-scholarship-descriptions', 0, 100, NOW)?.kind).toBe(
      'parse_yield_dropped',
    );
  });

  it('does not fire when the yield is at or above the floor', () => {
    expect(detectYieldDrop('s', 100, 100, NOW)).toBeNull();
    expect(detectYieldDrop('s', 111, 100, NOW)).toBeNull();
  });

  it('NEVER fires for a source whose expectedMinRecords is 0 — Austin ARC is legitimately empty', () => {
    expect(detectYieldDrop('austin-arc', 0, 0, NOW)).toBeNull();
  });
});

describe('shouldSuppressVanished', () => {
  it('suppresses vanished on a fully-empty scrape from a legitimately-empty source', () => {
    expect(shouldSuppressVanished(0, 0)).toBe(true);
  });

  it('does not suppress when the source is supposed to return records', () => {
    expect(shouldSuppressVanished(0, 100)).toBe(false);
  });

  it('does not suppress a single record vanishing from a non-empty scrape', () => {
    expect(shouldSuppressVanished(110, 100)).toBe(false);
    expect(shouldSuppressVanished(3, 0)).toBe(false);
  });
});
