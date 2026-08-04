// `preference.ts` scoping only — the shared hard/soft classifier every one of the 13 axes calls
// through `makeConstraint`.
//
// The defect: `isPreferenceText` was `PREFERENCE.test(text)`, so ONE preference word anywhere
// softened the WHOLE captured field. A funder that states a requirement and a preference in one
// field lost the requirement half, and `matcher.ts` never excludes on a soft constraint. Three
// ARRL catalog entries are exactly that shape, and one of them (Holt) was one of only two
// programs the unlicensed high-school profile could reach — a licence-required award shown to an
// unlicensed applicant on a desk whose entire subject is amateur radio.
//
// The corpus-level proof of the fix lives in licenseFloorContract.test.ts, which asserts the
// three entries' published constraints from their real captured text. THIS file pins the
// mechanism, and above all the OPPOSITE failure: a scoping fix that leans too hard converts every
// stated preference into a bar, which is no better than the defect it replaces.
//
// Kept in its own file rather than appended to the shared part1.test.ts / part2.test.ts, which
// concurrently-running agents are editing for other axes — the same reason license.test.ts,
// fieldOfStudy.test.ts and clause-split.test.ts exist.
import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { extractGeography } from './geography.js';
import { isPreferenceText, makeConstraint, preferenceScope, requirementText } from './preference.js';

const raw = (fields: Record<string, string>): RawOpportunity => ({
  sourceId: 'arrl-scholarship-descriptions',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n'),
});

describe('a preference scopes over the clause that carries it, not the whole field', () => {
  // The three real ARRL fields the allow-list used to hold, as classifier inputs.
  it('leaves a requirement stated in front of a hinged preference', () => {
    // Michael/Mary Holt: a comma hands off to the preference; the two-year requirement precedes it.
    expect(
      isPreferenceText(
        'Any active Amateur Radio License Class for two years, preference for General Class',
      ),
    ).toBe(false);
    expect(
      requirementText(
        'Any active Amateur Radio License Class for two years, preference for General Class',
      ),
    ).toBe('Any active Amateur Radio License Class for two years');
    // Carole Streeter: "with" is the hinge, and the preference is on a different subject entirely.
    expect(
      isPreferenceText(
        'Any class of active Amateur Radio license with preference for basic Morse code capability',
      ),
    ).toBe(false);
    expect(
      requirementText(
        'Any class of active Amateur Radio license with preference for basic Morse code capability',
      ),
    ).toBe('Any class of active Amateur Radio license');
  });

  it('stops at the sentence boundary, so a mandatory sentence beside a preference cascade survives', () => {
    // NEAR-Fest. The dot-safety in clauses.ts is what makes this a clause of its own.
    const text =
      'First Preference given to Extra Class, Second Preference given to General Class, Third ' +
      'Preference Given to Technician Class. Applicants must have held an amateur radio license ' +
      'for a minimum of one year prior to date of application.';
    expect(isPreferenceText(text)).toBe(false);
    expect(requirementText(text)).toBe(
      'Applicants must have held an amateur radio license for a minimum of one year prior to date of application',
    );
    // The ranking sentence is governed end to end, so nothing in it can turn hard: "First" is an
    // ordinal, not a hinge, so the marker reads as predicate position and takes the whole segment.
    expect(preferenceScope(text).governed[0]).toMatch(/^First Preference given to Extra Class/);
    expect(preferenceScope(text).ungoverned).toEqual([
      'Applicants must have held an amateur radio license for a minimum of one year prior to date of application.',
    ]);
  });

  it('stops at a semicolon, which is the only boundary some entries have', () => {
    // Francis Walton. splitClauses deliberately does not cut here; a preference's scope does.
    const text =
      'Preference given to applicants residing in Illinois; Applicant must be a resident of the ' +
      'ARRL Central Division (IL, IN, WI)';
    expect(isPreferenceText(text)).toBe(false);
    expect(requirementText(text)).toBe(
      'Applicant must be a resident of the ARRL Central Division (IL, IN, WI)',
    );
  });
});

describe('and does NOT turn a stated preference into a bar', () => {
  it('keeps the Louisiana cascade soft — the funder says a non-resident can win it', () => {
    const text =
      'Preference will be given to applicants residing in Louisiana. If no qualified applicant ' +
      'is identified, the scholarship may be awarded to an applicant from the Delta Division ' +
      '(Arkansas, Louisiana, Mississippi, Tennessee).';
    expect(isPreferenceText(text)).toBe(true);
    expect(requirementText(text)).toBe('');
    expect(extractGeography(raw({ Region: text }))[0].hard).toBe(false);
  });

  it('keeps a cascade soft even when the primary criterion is stated as a bare fact', () => {
    // Real Region values. "State of Maryland" and "Residence in GA." READ like requirements, and
    // the funder then says outright that they are not: the award reaches the remaining USA.
    for (const text of [
      'State of Maryland; if no qualified applicant is identified, preference will be given to ' +
        'applicants from the states of Virginia, Delaware, The District of Columbia, Pennsylvania, ' +
        'and West Virginia, and then the remaining USA.',
      'Residence in GA. If no qualified applicant, preference will be awarded to an applicant ' +
        'from the ARRL Southeastern Division (Alabama, Florida, Georgia, Puerto Rico and the US ' +
        'Virgin Islands)',
      'Preference will be given to Central Florida hams (Orange, Seminole, Osceola, Lake, ' +
        'Volusia, Brevard and Polk Counties); if no suitable applicant found, preference will be ' +
        'given to hams from the State of Florida',
    ]) {
      expect(isPreferenceText(text), text).toBe(true);
    }
  });

  it('keeps a preference stated in PREDICATE position soft, where the substance precedes the marker', () => {
    // The commonest shape in this corpus, and the one a naive "scope forward from the marker"
    // rule breaks: every content word sits in FRONT of the preference and the clause still says
    // one thing.
    for (const text of [
      'Applicants with two letters of recommendation are preferred.',
      'Applicants from Louisiana will be given priority.',
      'Louisiana applicants receive first consideration.',
      'Regional preferences are considered in the review.',
      'Louisiana applicants will be considered first.',
      'Applicants are encouraged to be a member of PARC',
    ]) {
      expect(isPreferenceText(text), text).toBe(true);
    }
  });

  it('reads a ranked preference list as ranking, not as three requirements', () => {
    // Robert A. Rodriguez K5AUW. "(" annotates the phrase in front of it; treating it as a
    // hand-off would read each ranked area as required and publish the THIRD preference as a bar.
    const text =
      'Preference will be given to applicants who reside in: ARRL South Texas Section (first ' +
      'preference); The State of Texas (second preference); ARRL West Gulf Division (third ' +
      'preference). If there is no applicant from the preferred areas then no scholarship will ' +
      'be awarded.';
    expect(isPreferenceText(text)).toBe(true);
  });

  it('never hardens a spec whose values come only from the preference clause', () => {
    // Orlando HamCation. Florida residency is required and seven counties are preferred, but
    // `geoFrom` read the COUNTIES, so hardening this spec would bar every Floridian outside them.
    // `isPreferenceText` correctly sees the requirement; `makeConstraint` refuses to publish a bar
    // built out of the preference. (The requirement stays unenforced here — a residual of the
    // same defect class, tracked, and fixable only by scoping geography.ts's own extraction.)
    const text =
      'Resident of Florida, with preference given to residents of Central Florida (Orange, ' +
      'Seminole, Osceola, Lake, Volusia, Brevard and Polk Counties)';
    expect(isPreferenceText(text)).toBe(false);
    const constraint = makeConstraint(
      'geography',
      text,
      {
        axis: 'geography',
        geo: { type: 'county', values: ['Orange', 'Seminole', 'Osceola'] },
      },
      0,
    );
    expect(constraint.hard).toBe(false);
    // The mirror case: the same shape, but the spec describes the REQUIREMENT (Lois Manley /
    // Randall Pitchford — the Division is required, Oregon preferred), so it hardens.
    const mirror =
      'ARRL Northwestern Division (Washington, Oregon, Idaho, Montana, Alaska), with preference ' +
      'given to residents of Oregon';
    expect(
      makeConstraint(
        'geography',
        mirror,
        { axis: 'geography', geo: { type: 'arrl_division', values: ['Northwestern'] } },
        0,
      ).hard,
    ).toBe(true);
  });

  it('hardens a spec the text never spells out — absence of evidence is not evidence', () => {
    // `licenseMin: TECH` is a fallthrough for "names a licence but no class", never a quotation,
    // so it can never be preference-derived. Carole Streeter depends on this.
    expect(
      makeConstraint(
        'license',
        'Any class of active Amateur Radio license with preference for basic Morse code capability',
        { axis: 'license', licenseMin: 'TECH' },
        0,
      ).hard,
    ).toBe(true);
  });
});
