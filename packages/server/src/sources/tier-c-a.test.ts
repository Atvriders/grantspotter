import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { extractGender } from '../normalize/axes/index.js';
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

  // Regression coverage for the fixed-slice-window bug: a 3-line lookahead ran PAST the next
  // <h2>, so each named scholarship's summary/amount silently absorbed its neighbor's heading
  // and award figure. Assert each of the three records' OWN amount and summary, with no trace
  // of a sibling's name or figure — presence checks alone (as the old suite had) cannot catch
  // this, because the bled-in figure was coincidentally often correct too.
  describe('no cross-record bleed (regression)', () => {
    const named = raws.filter((r) => r.rawFields.scope === 'named_scholarship');

    it('emits exactly the three named records, each with its own exact amount', () => {
      expect(named).toHaveLength(3);
      const byName = Object.fromEntries(named.map((r) => [r.name, r]));
      expect(byName['Ethel Smith K4LMB Memorial Scholarship'].rawFields.amount).toBe('$2,500');
      expect(byName['Mary Lou Brown NM7N Scholarship'].rawFields.amount).toBe('$2,500');
      expect(byName['Marte Wessel K0EPE Scholarship'].rawFields.amount).toBe('$1,500');
    });

    it('gives Ethel Smith her own summary with no Mary Lou Brown bleed', () => {
      const ethel = named.find((r) => r.name.includes('Ethel Smith'));
      expect(ethel?.rawFields.summary).toBe('Award: $2,500.');
      expect(ethel?.rawText).not.toMatch(/Mary Lou Brown/);
    });

    it('gives Mary Lou Brown her own summary with no Marte Wessel bleed', () => {
      const mlb = named.find((r) => r.name.includes('Mary Lou Brown'));
      expect(mlb?.rawFields.summary).toBe('Award: $2,500.');
      expect(mlb?.rawText).not.toMatch(/Marte Wessel/);
    });

    it("keeps Marte Wessel's part-time-working-full-time detail intact", () => {
      const wessel = named.find((r) => r.name.includes('Wessel'));
      expect(wessel?.rawFields.summary).toBe(
        'Award: $1,500. For part-time students working full-time.',
      );
    });
  });

  // Regression coverage for the reach bug: the document-level women-only restriction sits ABOVE
  // the first <h2>, so the fixed-window parser's per-record rawFields never carried it — only
  // the separate whole-page record did. `raws.some(...)` across ALL records (as the old suite
  // had) passed because of that unrelated page record, while all three real scholarships quietly
  // published as unrestricted. Assert the restriction on EACH named record individually, and
  // that it survives all the way through the shared gender-axis extractor as a HARD constraint —
  // the actual mechanism that would otherwise let these three publish as open to everyone.
  describe('female-only restriction reaches every named record (regression)', () => {
    const named = raws.filter((r) => r.rawFields.scope === 'named_scholarship');

    it('puts the eligibility sentence on all three named records, not just the page record', () => {
      expect(named).toHaveLength(3);
      for (const r of named) {
        expect(r.rawFields.eligibility).toBe('licensed women amateur radio operators worldwide.');
      }
    });

    it('drives a hard female-only gender constraint for all three via extractGender', () => {
      for (const r of named) {
        const constraints = extractGender(r);
        expect(constraints).toHaveLength(1);
        expect(constraints[0].hard).toBe(true);
        expect(constraints[0].spec).toEqual({ axis: 'gender', allowed: ['female'] });
      }
    });
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
