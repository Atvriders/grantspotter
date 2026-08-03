import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { TIER_C_A_SOURCES, austinArc, qcwa, sara, ylrl } from './tier-c-a.js';

describe('qcwa', () => {
  const raws = qcwa.parse([
    fixturePayload('qcwa', 'pathological.html', 'https://www.qcwa.org/scholarship-program.htm'),
  ]);

  it('captures the $3,000 award and the mandatory QCWA sponsor', () => {
    expect(raws[0].rawFields.amount).toBe('$3,000');
    expect(raws[0].rawFields.sponsor).toMatch(/active QCWA member/i);
  });

  it('captures that the intake is ARRL’s portal, not QCWA’s', () => {
    expect(raws[0].rawFields.applyNote).toMatch(/ARRL/);
    expect(raws[0].rawFields.deadlineNote).toMatch(/first week of January/i);
  });
});

describe('ylrl', () => {
  const raws = ylrl.parse([fixturePayload('ylrl', 'pathological.html', 'https://ylrl.net/Scholarships/')]);

  it('emits one record per named scholarship plus the page record', () => {
    const names = raws.map((r) => r.name);
    expect(names).toContain('Ethel Smith K4LMB Memorial Scholarship');
    expect(names).toContain('Mary Lou Brown NM7N Scholarship');
    expect(names).toContain('Marte Wessel K0EPE Scholarship');
    expect(raws.length).toBeGreaterThanOrEqual(3);
  });

  it('captures each award amount', () => {
    const wessel = raws.find((r) => r.name.includes('Wessel'));
    expect(wessel?.rawFields.amount).toBe('$1,500');
  });

  it('carries the female-only eligibility that drives the gender constraint axis', () => {
    expect(raws.some((r) => /women|female|YL/i.test(r.rawText))).toBe(true);
  });

  it('has expectedMinRecords 3, one per named scholarship', () => {
    expect(ylrl.expectedMinRecords).toBe(3);
  });
});

describe('austin-arc', () => {
  const url = 'https://austinhams.org/scholarships/';

  it('captures the May 1 - Jul 31 window and the seven Central Texas counties', () => {
    const raws = austinArc.parse([fixturePayload('austin-arc', 'pathological.html', url)]);
    expect(raws[0].rawFields.window).toMatch(/May 1 through July 31/i);
    expect(raws[0].rawFields.counties).toMatch(/Travis/);
  });

  it('has expectedMinRecords 0 — an empty scrape here is CORRECT for eight months a year', () => {
    expect(austinArc.expectedMinRecords).toBe(0);
    expect(austinArc.notes).toMatch(/No opportunities available/i);
    expect(austinArc.notes).toMatch(/Aug(?:ust)? 1/);
  });

  it('returns [] on the closed-window page without throwing', () => {
    expect(austinArc.parse([fixturePayload('austin-arc', 'empty-window.html', url)])).toEqual([]);
  });
});

describe('sara', () => {
  const raws = sara.parse([
    fixturePayload('sara', 'pathological.html', 'https://www.radio-astronomy.org/grants'),
  ]);

  it('captures the 5th-grade-through-college audience and the email intake', () => {
    expect(raws[0].rawFields.audience).toMatch(/5th grade/i);
    expect(raws[0].rawFields.applyNote).toBe('grants@radio-astronomy.org');
  });

  it('records that there is no deadline anywhere on the page', () => {
    expect(sara.notes).toMatch(/rolling/i);
    expect(raws[0].rawFields.window).toBeUndefined();
  });
});

describe('the group', () => {
  it('exports all four modules with unique ids', () => {
    expect(TIER_C_A_SOURCES.map((m) => m.id).sort()).toEqual([
      'austin-arc',
      'qcwa',
      'sara',
      'ylrl',
    ]);
  });
});
