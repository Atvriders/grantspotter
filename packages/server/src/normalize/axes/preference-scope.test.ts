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
import { extractFieldOfStudy } from './fieldOfStudy.js';
import { extractGeography } from './geography.js';
import { extractLicense } from './license.js';
import {
  cascadeRank,
  isPreferenceText,
  makeConstraint,
  preferenceScope,
  requirementText,
} from './preference.js';

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

// ---------------------------------------------------------------- the fallback family

/**
 * A FUNDER WIDENING ITS OWN ELIGIBILITY, PUBLISHED AS A BAR.
 *
 * `isPreferenceText` used to open `if (!PREFERENCE.test(text)) return false`, so the two things
 * beside it that recognise a stated fallback — `CASCADE` and `FALLBACK_CONDITION` — could not run
 * at all unless the funder had already used the WORD "preference". Every fallback stated without
 * one was published as a hard requirement, which is the exact inverse of what the sentence says.
 *
 * Each `it` below is red under the old ordering. They are written so that restoring the gate — or
 * dropping either pattern back into unreachable code — turns this file red rather than leaving it
 * green over logic nothing executes.
 */
describe('a stated fallback is the funder saying the criterion excludes nobody', () => {
  it('CTRI: "if no suitable applicant identified" is not a bar on six states', () => {
    // Verbatim, fixtures/arrl-scholarship-descriptions, The CTRI/Chris Seeber, KA1GEU, Memorial
    // Scholarship. It hit ALL FIVE individual profiles: every applicant outside New England was
    // excluded from an award whose funder says region excludes nobody. Note there is no
    // preference word anywhere in it, and `CASCADE`'s one spelling ("qualified applicant") does
    // not match "suitable applicant" either — it takes both halves of the fix to see this.
    const text =
      'ARRL New England Division (Connecticut, Rhode Island, Vermont, Maine, New Hampshire); if ' +
      'no suitable applicant identified, applicants from all regions will be considered';
    expect(/\b(?:preference|preferred|prefers?|priority)\b/i.test(text)).toBe(false);
    expect(isPreferenceText(text)).toBe(true);
    expect(cascadeRank(text)).toBe(1);
    const geo = extractGeography(raw({ Region: text }));
    expect(geo).toHaveLength(1);
    expect(geo[0].hard).toBe(false);
    expect(geo[0].fallbackRank).toBe(1);
    // The widening does not erase the funder's stated region: it is still published, softly, so
    // a New England applicant still ranks as preferred.
    expect(geo[0].spec).toMatchObject({ geo: { type: 'arrl_division', values: ['New England'] } });
  });

  it('North Fulton: the same record states both halves, and they now agree', () => {
    // The proof that the preference WORD, not the semantics, was deciding. Both fields state a
    // criterion and then waive it; only one of them says "preference", and only that one came out
    // soft. (The funder's typo, "appilcant", is verbatim and is why `CASCADE` misses this one.)
    const region =
      'Residence in GA. If no qualified applicant, preference will be awarded to an applicant ' +
      'from the ARRL Southeastern Division (Alabama, Florida, Georgia, Puerto Rico and the US ' +
      'Virgin Islands)';
    const field =
      'Engineering or Computer Science. If no qualified appilcant, award given regardless of the ' +
      'field of study.';
    expect(isPreferenceText(region)).toBe(true);
    expect(isPreferenceText(field)).toBe(true);
    const fos = extractFieldOfStudy(raw({ 'Field of Study': field }));
    expect(fos).toHaveLength(1);
    expect(fos[0].hard).toBe(false);
    expect(fos[0].fallbackRank).toBe(1);
    expect(fos[0].spec).toMatchObject({ fields: ['Engineering', 'Computer Science'] });
  });

  it('reads the whole fallback family, not one spelling of it', () => {
    // Real Region/Field values. None carries a preference word before its fallback; all four were
    // hard bars, and two of them ("if no qualified applicant is identified") match `CASCADE`
    // exactly — proof that the gate, not the pattern, was what made them unreachable.
    for (const text of [
      'Residence or student of 4-year university or college in Oklahoma. If no qualified ' +
        'applicant is identified,resident or student of 4-year college or university in the ARRL ' +
        'West Gulf Division (Texas and Oklahoma).',
      'Residence in WI. If none identified, residence in the ARRL Central Division (IL, IN, WI)',
      'ARRL New England Division; if no suitable applicant identified, applicants from all ' +
        'regions will be considered',
      'Engineering or Computer Science. If no qualified appilcant, award given regardless of the ' +
        'field of study.',
    ]) {
      expect(isPreferenceText(text), text).toBe(true);
      expect(cascadeRank(text), text).toBe(1);
    }
  });

  it('keeps the canonical Louisiana cascade soft, with its fallback rank', () => {
    // The shape that was already right, re-pinned: the fix must not move it.
    const text =
      'Preference will be given to applicants residing in Louisiana. If no qualified applicant ' +
      'is identified, the scholarship may be awarded to an applicant from the Delta Division ' +
      '(Arkansas, Louisiana, Mississippi, Tennessee).';
    expect(isPreferenceText(text)).toBe(true);
    expect(cascadeRank(text)).toBe(1);
    const geo = extractGeography(raw({ Region: text }));
    expect(geo[0].hard).toBe(false);
    expect(geo[0].fallbackRank).toBe(1);
  });
});

/**
 * THE OPPOSITE FAILURE, which is the one that cannot be undone by the applicant.
 *
 * Softening is how a real requirement disappears: `matcher.ts` never excludes on a soft
 * constraint. A previous round had to RESTORE seven constraints that a too-eager preference rule
 * had made soft, Holt's licence floor among them — and Holt is one of only two programs the
 * unlicensed high-school profile could reach, on a desk whose whole subject is amateur radio.
 * A widening of the fallback family walks straight back into that, so these are the guard rail.
 */
describe('and does not soften a requirement that merely contains a condition', () => {
  it('leaves the three restored licence floors hard, from their real captured fields', () => {
    const cases: ReadonlyArray<[string, string, string, number | undefined]> = [
      [
        'Michael/Mary Holt',
        'Any active Amateur Radio License Class for two years, preference for General Class',
        'TECH',
        24,
      ],
      [
        'NEAR-Fest',
        'First Preference given to Extra Class, Second Preference given to General Class, Third ' +
          'Preference Given to Technician Class. Applicants must have held an amateur radio ' +
          'license for a minimum of one year prior to date of application.',
        'TECH',
        12,
      ],
      [
        'Carole J. Streeter, KB9JBR',
        'Any class of active Amateur Radio license with preference for basic Morse code capability',
        'TECH',
        undefined,
      ],
    ];
    for (const [who, text, licenseMin, heldMonthsMin] of cases) {
      const cs = extractLicense(raw({ 'License Requirement': text }));
      expect(cs, who).toHaveLength(1);
      expect(cs[0].hard, who).toBe(true);
      expect(cs[0].spec, who).toMatchObject(
        heldMonthsMin === undefined
          ? { axis: 'license', licenseMin }
          : { axis: 'license', licenseMin, heldMonthsMin },
      );
    }
  });

  it('does not read a mid-sentence "unless" as a widening', () => {
    // NCDXF, verbatim: a RESTRICTION on what the fund pays for, with "unless" in the middle of
    // it. `FALLBACK_CONDITION` is anchored at the start of a span precisely so this cannot be
    // mistaken for the funder opening the award up.
    const text =
      'Expeditions to unusual locations as defined by the Islands on the Air (IOTA) program, Grid ' +
      'Square awards and various radio contests are not supported unless the support can be ' +
      'justified.';
    expect(isPreferenceText(text)).toBe(false);
    expect(cascadeRank(text)).toBe(0);
  });

  it('still treats a plain requirement as a requirement', () => {
    for (const text of [
      'Applicant must hold a General class license.',
      'Any accredited institution.',
      'Applicant must be female.',
      'Applicants must be residents of the ARRL Central Division (IL, IN, WI).',
      'Applicant must be a US citizen; open only to graduating high school seniors.',
    ]) {
      expect(isPreferenceText(text), text).toBe(false);
      expect(cascadeRank(text), text).toBe(0);
    }
  });
});
