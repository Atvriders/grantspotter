// `extractLicense` only — the licence axis, end to end from the committed real captures.
//
// The defect this file was created for: the QCWA Memorial Scholarship computed NO licence
// constraint at all and so published as eligible to an applicant with no amateur licence, on a
// page whose own words are "requested by interested licensed radio amateurs" and "Scholarships
// are awarded to worthy Amateur Radio operators". Two independent causes, one per layer:
//
//   1. sources/tier-c-a.ts kept only the class-agnostic sentence ("There are no restrictions
//      regarding class of amateur license, race, sex, residence, or field of study.") under
//      `eligibility`. `extractLicense` reads `License Requirement` / `license` and NOTHING else,
//      so no field reached the axis and it returned [].
//   2. axes/license.ts had no rule saying that a disclaimer about the CLASS presupposes a
//      licence. NO_LICENSE happens not to match that sentence today, so the fallback rescued it
//      by accident; it is one widened alternative away from being read as "no licence needed",
//      which is the single worst direction for a funding desk about amateur radio to fail in.
//
// This is the mirror of the already-fixed defect in which `licenseMin` defaulted to 'NONE' on 71
// of 111 ARRL entries: `matcher.ts` skips the licence check entirely when the floor is NONE, so a
// wrong NONE is not a lenient answer, it is an unenforced requirement.
//
// Kept in its own file rather than appended to the shared part1.test.ts / part2.test.ts, which
// concurrently-running agents are editing for other axes — the same reason fieldOfStudy.test.ts
// and clause-split.test.ts exist.
import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../../test/fixtures.js';
import { qcwa, sara, ylrl } from '../../sources/tier-c-a.js';
import { extractLicense } from './license.js';

/** Drives the axis exactly as the ARRL catalog does: one `License Requirement` value. */
const specOf = (licenseRequirement: string): Record<string, unknown> => {
  const raw: RawOpportunity = {
    sourceId: 'arrl-scholarship-descriptions',
    externalKey: 'k',
    name: 'n',
    rawFields: { 'License Requirement': licenseRequirement },
    sourceUrl: 'https://example.test/x',
    rawText: licenseRequirement,
  };
  const constraints = extractLicense(raw);
  expect(constraints).toHaveLength(1);
  return constraints[0].spec as unknown as Record<string, unknown>;
};

const minOf = (licenseRequirement: string): unknown => specOf(licenseRequirement).licenseMin;

/** Parses a committed REAL capture through the production source module, as the crawler does. */
const parseReal = (sourceId: 'qcwa' | 'sara' | 'ylrl', file: string, url: string): RawOpportunity[] =>
  ({ qcwa, sara, ylrl })[sourceId].parse([fixturePayload(sourceId, file, url)]);

const only = (constraints: Constraint[]): Constraint => {
  expect(constraints).toHaveLength(1);
  return constraints[0];
};

// ------------------------------------------------------------------ the reported defect

describe('QCWA (REAL capture) — a licensed-operators-only award that published with no licence floor', () => {
  const raws = parseReal(
    'qcwa',
    '00-www-qcwa-org-scholarship-program-htm.html',
    'https://www.qcwa.org/scholarship-program.htm',
  );
  const raw = raws[0];
  const constraints = extractLicense(raw);

  it('still parses exactly one record now that `license` is a required field', () => {
    expect(raws).toHaveLength(1);
  });

  // fixtures/qcwa/00-www-qcwa-org-scholarship-program-htm.html line 87:
  //   "Applications should be requested by interested licensed radio amateurs on or after
  //    October 31 of each year from the ARRL Foundation Committee."
  it('carries the sentence that establishes a licence is required at all', () => {
    expect(raw.rawFields.license).toBe(
      'Applications should be requested by interested licensed radio amateurs on or after ' +
        'October 31 of each year from the ARRL Foundation Committee.',
    );
  });

  // The whole point. Exact spec, not `toContain`/`toBeDefined`: an axis that emits SOME licence
  // constraint with licenseMin 'NONE' is indistinguishable from no constraint at all to
  // matcher.ts, which skips the check when the required rank is 0.
  it('computes a HARD licence floor of TECH — the entry-level class every higher class clears', () => {
    const constraint = only(constraints);
    expect(constraint.hard).toBe(true);
    expect(constraint.spec).toEqual({ axis: 'license', licenseMin: 'TECH' });
  });

  // "on or after October 31 of each year" is a request window, not a holding period. The axis
  // must not read a date out of it and impose a tenure the funder never stated.
  it('reads no holding period out of the request-window date in the same sentence', () => {
    expect((only(constraints).spec as { heldMonthsMin?: number }).heldMonthsMin).toBeUndefined();
  });

  // Line 98 of the same capture. It is kept, and it is kept OUT of the licence field's job of
  // establishing that a licence exists: it only says which classes qualify.
  it('still keeps the class-agnostic sentence, under eligibility where it belongs', () => {
    expect(raw.rawFields.eligibility).toBe(
      'no restrictions regarding class of amateur license, race, sex, residence, or field of study.',
    );
  });
});

describe('"no restrictions regarding class of amateur license" presupposes a licence', () => {
  // The literal phrase from qcwa.org. ANY CLASS QUALIFIES — floor TECH. It must never resolve to
  // NONE, which matcher.ts treats as "do not check the licence at all".
  it('resolves the literal QCWA phrase to TECH, never NONE', () => {
    expect(minOf('no restrictions regarding class of amateur license')).toBe('TECH');
  });

  it('resolves the full page sentence, with its other disclaimed axes, to TECH', () => {
    expect(
      minOf(
        'There are no restrictions regarding class of amateur license, race, sex, residence, ' +
          'or field of study.',
      ),
    ).toBe('TECH');
  });

  it('resolves the wording variants of the same disclaimer to TECH', () => {
    expect(minOf('There is no restriction on class of amateur license.')).toBe('TECH');
    expect(minOf('No restrictions as to license class.')).toBe('TECH');
    expect(minOf('Class of amateur license is not restricted.')).toBe('TECH');
  });

  // The guard exists because these two families are one word apart in English. A class
  // disclaimer that also happens to carry a NO_LICENSE token must still resolve to TECH: the
  // funder disclaimed the class, not the licence.
  it('is not talked out of TECH by a NO_LICENSE token elsewhere in the same value', () => {
    expect(minOf('No restrictions regarding class of amateur license; none is preferred.')).toBe(
      'TECH',
    );
  });
});

// ------------------------------------------------------------------ the true negative

describe('genuinely licence-free awards still get no licence floor', () => {
  // The one real "License Requirement: None" value in the 111-entry ARRL catalog — The North
  // Fulton Amateur Radio League Scholarship. If the fix above swallowed this, every unlicensed
  // applicant would lose the one ARRL scholarship actually open to them.
  it("reads the North Fulton catalog value 'None' as NONE", () => {
    expect(minOf('None')).toBe('NONE');
  });

  it('reads explicit licence disclaimers as NONE', () => {
    expect(minOf('No license required')).toBe('NONE');
    expect(minOf('An amateur radio license is not required.')).toBe('NONE');
    expect(minOf('N/A')).toBe('NONE');
  });

  // SARA's $200 radio-astronomy project grant states no licence requirement anywhere on its
  // page, so the axis must emit NOTHING — the true negative that proves the QCWA fix is a
  // reading of QCWA's page and not a blanket "every ham funder needs a licence" rule.
  it('SARA (REAL capture) yields no licence constraint at all', () => {
    const raws = parseReal(
      'sara',
      '00-www-radio-astronomy-org-grants.html',
      'https://www.radio-astronomy.org/grants',
    );
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.license).toBeUndefined();
    expect(raws[0].rawFields['License Requirement']).toBeUndefined();
    expect(extractLicense(raws[0])).toEqual([]);
  });
});

// ------------------------------------------------------------------ the same defect, YLRL

describe('YLRL (REAL capture) — the licence bullet reaches every named record, not just the page record', () => {
  const raws = parseReal('ylrl', '00-ylrl-net-scholarships.html', 'https://ylrl.net/Scholarships/');
  const named = raws.filter((r) => r.rawFields.scope === 'named_scholarship');

  // Found by sweeping the whole corpus rather than by testing the reported record: all three
  // YLRL scholarships carried "Applicant must have an Amateur Radio License." inside
  // `eligibility`, which the licence axis cannot see, so all three computed no licence floor.
  // Only the unrelated female-only gender constraint kept them away from unlicensed applicants.
  it('gives all three named scholarships a hard TECH floor', () => {
    expect(named).toHaveLength(3);
    for (const raw of named) {
      expect(raw.rawFields.license).toBe('Applicant must have an Amateur Radio License.');
      const constraint = only(extractLicense(raw));
      expect(constraint.hard).toBe(true);
      expect(constraint.spec).toEqual({ axis: 'license', licenseMin: 'TECH' });
    }
  });
});

// ------------------------------------------------------------------ corpus-wide floors

describe('class floors read off the real ARRL catalog values', () => {
  // Every string below is verbatim from
  // fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html.
  it('takes the LOWEST class named as the floor, never the highest', () => {
    expect(minOf('General Class or Extra Class active Amateur Radio License')).toBe('GENERAL');
    expect(
      minOf(
        'First Preference given to Extra Class, Second Preference given to General Class, ' +
          'Third Preference Given to Technician Class.',
      ),
    ).toBe('TECH');
  });

  it('reads the "any class" family as TECH', () => {
    expect(minOf('Any active Amateur Radio License Class')).toBe('TECH');
    expect(minOf('FCC issued amateur radio license, any class')).toBe('TECH');
    expect(minOf('Applicant must be a licensed radio amateur.')).toBe('TECH');
  });

  // The narrow CLASS_AGNOSTIC guard must not flatten this one: "any class" is the hard floor and
  // General is a stated PREFERENCE, so the spec keeps GENERAL and the constraint is soft.
  it('keeps the General-class preference on the one entry that states one', () => {
    const text = 'Any active Amateur Radio License Class for two years, preference for General Class';
    expect(minOf(text)).toBe('GENERAL');
    expect(specOf(text).heldMonthsMin).toBe(24);
  });

  it('treats Novice as the legacy equivalent of the Technician floor', () => {
    expect(minOf('Active Novice Class Amateur Radio License or higher')).toBe('TECH');
  });
});
