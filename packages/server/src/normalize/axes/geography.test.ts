import type { GeoSpec, RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { extractGeography } from './geography.js';

const raw = (fields: Record<string, string>): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: Object.values(fields).join('\n'),
});

const geoOf = (region: string): GeoSpec => {
  const cs = extractGeography(raw({ Region: region }));
  const spec = cs[0]?.spec as { axis: 'geography'; geo: GeoSpec };
  return spec.geo;
};

const sortValues = (geo: GeoSpec): GeoSpec => ({ ...geo, values: [...geo.values].sort() });

/**
 * Plan 2's whole-branch review over the real matcher found this axis responsible for 33 of 88
 * wrong exclusions — the second-largest cause of the product telling a well-qualified applicant
 * they cannot apply. These are regression tests for the four confirmed root causes, each proven
 * against real (or near-verbatim real) corpus text from
 * fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html.
 */

describe('defect 1 — fabricated states and dropped DC', () => {
  it('does not fabricate VA from a West-Virginia-only mention', () => {
    expect(geoOf('Resident of West Virginia')).toEqual({ type: 'state', values: ['WV'] });
  });

  it('the real K3IVO Freestate entry: five real states, no fabricated VA, DC present', () => {
    // Source: "Maryland, DC, Delaware, Pennsylvania, or West Virginia" — the text never says
    // "Virginia" on its own, only "West Virginia"; the old \bvirginia\b match fired anyway.
    const geo = sortValues(geoOf('Maryland, DC, Delaware, Pennsylvania, or West Virginia'));
    expect(geo).toEqual({ type: 'state', values: ['DC', 'DE', 'MD', 'PA', 'WV'] });
  });

  it('still recognises a real, standalone "Virginia" alongside a separate "West Virginia"', () => {
    // Source (MMARSI): both states are legitimately, independently named in the same sentence.
    const geo = sortValues(
      geoOf(
        'preference will be given to applicants from the states of Virginia, Delaware, The District of Columbia, Pennsylvania, and West Virginia',
      ),
    );
    expect(geo).toEqual({ type: 'state', values: ['DC', 'DE', 'PA', 'VA', 'WV'] });
  });

  it('the real Vienna Wireless Society cascade: Virginia, Maryland and DC all present', () => {
    const geo = sortValues(
      geoOf(
        'Preference will be given to applicants from Virginia; if no qualified applicant is identified, preference will be given to applicants from Maryland or the District of Columbia (DC)',
      ),
    );
    expect(geo).toEqual({ type: 'state', values: ['DC', 'MD', 'VA'] });
  });

  it('a Maryland-DC ARRL Section keeps DC as part of the recognised section name', () => {
    // "Maryland-DC" is a real ARRL Section name (arrlSections.ts): MD + DC. The old
    // `[A-Z][a-z]+\s+Section\b` regex could never match it — "DC" is all caps, not
    // capital-then-lowercase — so this used to fall through and lose the DC half entirely.
    expect(geoOf('ARRL Maryland-DC Section')).toEqual({
      type: 'arrl_section',
      values: ['Maryland-DC'],
    });
  });
});

describe('defect 2 — counties dropped into a garbage blob', () => {
  // EVERY VALUE HERE NOW CARRIES ITS STATE, and that is the fix to a false INCLUDE: `evaluateGeo`
  // passes a bare county name whatever state the applicant is in, so this Illinois-only award
  // admitted a resident of Fulton County GEORGIA and Knox County TENNESSEE. The qualifier comes
  // from the funder's own sentence ("Central IL") and from nowhere else — see
  // `qualifyCountiesWithState`.
  it('the real Peoria Area entry: all nine named counties present, each qualified by its state', () => {
    const geo = sortValues(
      geoOf(
        'Residence in Central IL in one of these counties: Peoria, Tazewell, Woodford, Knox, McLean, Fulton, Logan, Marshall or Stark',
      ),
    );
    expect(geo).toEqual({
      type: 'county',
      values: [
        'Fulton, IL', 'Knox, IL', 'Logan, IL', 'Marshall, IL', 'McLean, IL', 'Peoria, IL',
        'Stark, IL', 'Tazewell, IL', 'Woodford, IL',
      ].sort(),
    });
  });

  it('a single named county is not swallowed into the surrounding sentence', () => {
    // Source (Gulf Coast Amateur Radio Club): the old code produced
    // "Preference will be given to residents of Pasco" as the "county name".
    expect(
      geoOf(
        'Preference will be given to residents of Pasco County, Florida; if no qualified applicant is identified then preference will be given to residents of the West Central Florida Sectioin counties',
      ),
    ).toEqual({ type: 'county', values: ['Pasco, FL'] });
  });

  it('a multi-word county name (San Diego) is not truncated or prefixed', () => {
    expect(
      geoOf('Preference given to applicants from San Diego County, California.'),
    ).toEqual({ type: 'county', values: ['San Diego, CA'] });
  });

  // The other half of the state rule, and the reason it can only ever narrow a value the funder
  // themselves qualified: two states named is ambiguous per county, so the Shenandoah Valley list
  // (five Virginia counties and three West Virginia ones) keeps its bare names — see the test
  // below — and a list whose own sentence names NO state keeps them too. The Austin ARC `counties`
  // field is exactly that, so its seven Central Texas counties stay unqualified rather than
  // gaining a TX this axis would have had to invent.
  it('does not invent a state for a county list whose own sentence names none (Austin ARC)', () => {
    expect(
      geoOf('Travis, Bastrop, Blanco, Burnet, Caldwell, Hays, and Williamson counties.'),
    ).toEqual({
      type: 'county',
      values: ['Travis', 'Bastrop', 'Blanco', 'Burnet', 'Caldwell', 'Hays', 'Williamson'],
    });
  });

  it('two colon-introduced county lists in one sentence stay separate (Shenandoah Valley)', () => {
    const geo = sortValues(
      geoOf(
        'Preference will be given to applicants residing in the following Virginia counties: Page, Shenandoah, Warren, Clarke, City of Winchester, or the following West Virginia counties: Hampshire, Jefferson and Berkeley.',
      ),
    );
    expect(geo).toEqual({
      type: 'county',
      values: [
        'Berkeley', 'City of Winchester', 'Clarke', 'Hampshire', 'Jefferson', 'Page', 'Shenandoah', 'Warren',
      ].sort(),
    });
  });
});

describe('defect 3 — divisions collapsed to one, some not real Division names', () => {
  it('the real James Cothran entry: all three divisions present, not just the first', () => {
    const geo = sortValues(
      geoOf(
        'Resident of Atlantic Division (DE, MD, PA, Southern NJ, Western NY), the Roanoke Division (NC, SC, VA, WV), the Southeastern Division (AL, FL, GA) or Washington, D.C.',
      ),
    );
    expect(geo).toEqual({ type: 'arrl_division', values: ['Atlantic', 'Roanoke', 'Southeastern'].sort() });
  });

  it('a comma/or-joined list sharing one "Division" keyword yields all three names, not just the last', () => {
    // Source (William Bennett): "ARRL Northwest, Pacific or Southwest Division" — one keyword,
    // three names. The old code returned only ["Southwest"].
    const geo = sortValues(geoOf('Residence in ARRL Northwest, Pacific or Southwest Division'));
    expect(geo).toEqual({
      type: 'arrl_division',
      values: ['Northwestern', 'Pacific', 'Southwestern'].sort(),
    });
  });
});

describe('defect 3/4 — "Northwest"/"Southwest" are not real Divisions', () => {
  it('canonicalises "Northwest Division" to the real name, Northwestern', () => {
    expect(geoOf('Resident of ARRL Northwest Division (AK,ID,MT,OR,WA)')).toEqual({
      type: 'arrl_division',
      values: ['Northwestern'],
    });
  });

  it('leaves an already-correct "Northwestern Division" alone', () => {
    expect(geoOf('ARRL Northwestern Division (Alaska, Idaho, Montana, Oregon or Washington)')).toEqual({
      type: 'arrl_division',
      values: ['Northwestern'],
    });
  });
});

describe('defect 4 — validated against the real 15-Division / 71-Section table', () => {
  it('does not emit a Division name that is not in the table', () => {
    // "Cascadia" is not one of the 15 real ARRL Divisions. Silently emitting it as if it were
    // real is exactly what the requirement forbids; the text should fall through to "any"
    // rather than fabricate a value nothing downstream can resolve.
    expect(geoOf('Residence in the ARRL Cascadia Division')).toEqual({ type: 'any', values: [] });
  });

  it('does not emit a Section name that is not in the table', () => {
    expect(geoOf('Residence in the Atlantis Section')).toEqual({ type: 'any', values: [] });
  });

  it('reads a real, single-name ARRL Section correctly (North Texas)', () => {
    expect(
      geoOf('Applicant must have graduated high school located within the North Texas Section'),
    ).toEqual({ type: 'arrl_section', values: ['North Texas'] });
  });
});

describe('radius: the three real corpus strings, unaffected by this pass', () => {
  it.each([
    ['Residence within 250 miles of Seaford, Delaware', 250, 'Seaford, Delaware', 38.6412, -75.6116],
    ['Residence within 70 miles of Schenectady, NY', 70, 'Schenectady, NY', 42.8142, -73.9396],
    ['within 175 miles of Erving, MA', 175, 'Erving, MA', 42.5987, -72.4009],
  ] as const)('%s', (text, miles, label, lat, lon) => {
    expect(geoOf(text)).toEqual({
      type: 'radius',
      values: [label],
      radiusMiles: miles,
      centerLabel: label,
      centerLat: lat,
      centerLon: lon,
    });
  });
});

describe('the Louisiana preference cascade stays soft', () => {
  it('real corpus text (Larry Hodges): hard=false, fallbackRank=1, LA only', () => {
    const text =
      'Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, the award is open to any eligible applicant.';
    const cs = extractGeography(raw({ Region: text }));
    expect(cs[0].hard).toBe(false);
    expect(cs[0].fallbackRank).toBe(1);
    expect(cs[0].spec).toMatchObject({ geo: { type: 'state', values: ['LA'] } });
  });

  it('real corpus text (Walter Gallinghouse): cascades on to a real Division, still soft', () => {
    const text =
      'Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, the scholarship may be awarded to an applicant from the Delta Division (Arkansas, Louisiana, Mississippi, Tennessee).';
    const cs = extractGeography(raw({ Region: text }));
    expect(cs[0].hard).toBe(false);
    expect(cs[0].fallbackRank).toBe(1);
    expect(cs[0].spec).toMatchObject({ geo: { type: 'arrl_division', values: ['Delta'] } });
  });
});

/**
 * Round 2: the coordinator's narrower fix for the residual reported after round 1.
 * "<Section> Section of the <Division> Division" is a specific phrase, not a general
 * Division-vs-Section priority question — when a funder names a Section AND the Division it sits
 * inside together, the Section is the operative (narrower) restriction. This does not change the
 * general Division-before-Section priority the other describe blocks above depend on.
 */
describe('round 2 — "<Section> Section of the <Division> Division" resolves to the Section', () => {
  it('the real Steel City ARC entry: Western Pennsylvania Section, not the whole Atlantic Division', () => {
    expect(geoOf('ARRL Western Pennsylvania Section of the Atlantic Division')).toEqual({
      type: 'arrl_section',
      values: ['Western Pennsylvania'],
    });
  });

  it('works without the "ARRL" prefix on either side', () => {
    expect(geoOf('Western Pennsylvania Section of the Atlantic Division')).toEqual({
      type: 'arrl_section',
      values: ['Western Pennsylvania'],
    });
  });

  it('does not disturb the general Division-before-Section priority elsewhere', () => {
    // The real Robert A. Rodriguez K5AUW entry names a Section and a Division as separate tiers
    // of a preference cascade ("ARRL South Texas Section (first preference); ... ARRL West Gulf
    // Division (third preference)") — not the "X Section of the Y Division" phrase — so this
    // must keep resolving to the Division exactly as it did before round 2.
    expect(
      geoOf(
        'Preference will be given to applicants who reside in: ARRL South Texas Section (first preference); The State of Texas (second preference); ARRL West Gulf Division (third preference).',
      ),
    ).toEqual({ type: 'arrl_division', values: ['West Gulf'] });
  });

  it('a real Section paired with a Division it does NOT belong to is not silently reconciled', () => {
    // "Western Pennsylvania" is a real Section, "Central" is a real Division, but Western
    // Pennsylvania belongs to Atlantic, not Central — a wrong pairing must not be resolved by
    // guessing which one the funder meant. It falls through to the general division scan, which
    // still finds the (independently, literally stated) real "Central Division" text.
    expect(geoOf('Western Pennsylvania Section of the Central Division')).toEqual({
      type: 'arrl_division',
      values: ['Central'],
    });
  });

  it('a fabricated Section name in this phrase shape is not emitted as if it were real', () => {
    expect(geoOf('Atlantis Section of the Atlantic Division')).toEqual({
      type: 'arrl_division',
      values: ['Atlantic'],
    });
  });
});

/**
 * Round 3: the first defect this axis has been shown by a REAL captured page rather than by a
 * fixture someone wrote. fixtures/austin-arc/00-austinhams-org-scholarships.html publishes the
 * Austin ARC scholarship's eligible area as an Oxford-comma list —
 *   "Travis, Bastrop, Blanco, Burnet, Caldwell, Hays, and Williamson counties."
 * — and the axis published exactly ONE of the seven (Williamson), hiding the award from
 * applicants in the other six. The synthetic fixture had used " or " with no comma, so the
 * parser agreed with its author and disagreed with the web.
 *
 * ROOT CAUSE (not the split, and not a missing delimiter): `splitCandidateList` already splits on
 * `,`, `or` and `and`, but it never saw the list, because `COUNTY_LIST_BEFORE` never matched it.
 * That pattern walks BACKWARD from the "counties" keyword through connectors, and its connector
 * alternation was `(?:,\s*|\s+(?:or|and)\s+)` — a bare comma, or a bare "and"/"or" surrounded by
 * spaces, but never the two combined. On ", and Williamson" the comma branch consumes ", " and
 * then requires a Title-Case name where "and" sits; the "and" branch requires whitespace where
 * the comma sits. Both fail, the whole backward chase from "Travis" fails with it, and the global
 * scan restarts and matches the shortest thing that does work: "Williamson counties".
 */
describe('round 3 — the real Austin ARC page: an Oxford-comma county list', () => {
  const AUSTIN = 'Travis, Bastrop, Blanco, Burnet, Caldwell, Hays, and Williamson counties.';
  const SEVEN = ['Bastrop', 'Blanco', 'Burnet', 'Caldwell', 'Hays', 'Travis', 'Williamson'];

  it('publishes all seven Central Texas counties, not just the last one', () => {
    expect(sortValues(geoOf(AUSTIN))).toEqual({ type: 'county', values: SEVEN });
  });

  it('reads them through the real field the source writes (rawFields.counties)', () => {
    // austinArc.parse() puts this text under `counties`, not `Region` — the exact string is
    // asserted verbatim in sources/tier-c-a.test.ts against the captured page.
    const cs = extractGeography(raw({ counties: AUSTIN }));
    const geo = (cs[0].spec as { axis: 'geography'; geo: GeoSpec }).geo;
    expect(sortValues(geo)).toEqual({ type: 'county', values: SEVEN });
  });

  it('accepts the Oxford "or" form of the same list', () => {
    expect(sortValues(geoOf('Travis, Hays, or Williamson counties'))).toEqual({
      type: 'county',
      values: ['Hays', 'Travis', 'Williamson'],
    });
  });

  it('still accepts the non-Oxford form the synthetic fixture used', () => {
    expect(sortValues(geoOf('Travis, Williamson and Hays county'))).toEqual({
      type: 'county',
      values: ['Hays', 'Travis', 'Williamson'],
    });
  });

  it('an Oxford comma does not let the list chase backward into prose', () => {
    // The connector fix must not reopen the prefix-contamination bug: "residents of" is prose,
    // and "Preference"/"residents" are stopwords, so nothing but the two real names survives.
    expect(
      sortValues(
        geoOf('Preference will be given to residents of Pasco, and Hernando Counties, Florida.'),
      ),
    ).toEqual({ type: 'county', values: ['Hernando, FL', 'Pasco, FL'] });
  });
});

/**
 * Round 4 — A REQUIREMENT AND A PREFERENCE IN ONE `Region` VALUE.
 *
 * `preference.ts` already stopped a preference clause from softening the requirement beside it.
 * That left the other half of the same defect open on this axis: the SPEC was still read off the
 * whole field, so where the preference names the narrower area, the preference's area is what the
 * spec described. `makeConstraint`'s `specStatedOnlyAsPreference` guard held those constraints
 * soft — correct as a stopgap, because hardening the spec as-written would have published the
 * preference as the bar — but it left the funder's actual requirement enforced by nobody, and the
 * preference recorded nowhere.
 *
 * Both directions are live here, and the two entries below are the two directions:
 *
 *   OVER-HARDENING  Orlando HamCation requires Florida residency and PREFERS seven Central Florida
 *   counties. Hardening the county list would bar every other Floridian from an award the funder
 *   states they may have.
 *
 *   OVER-SOFTENING  the same entry, left whole, enforces nothing at all: an applicant in any state
 *   is shown an award restricted to Florida residents.
 *
 * So each half is now extracted from the clause that states it and emitted as its OWN constraint,
 * with that clause as its `rawText` — the requirement hard, the preference soft. Neither half is
 * fused into the other and neither is discarded, and both statuses now follow from each
 * constraint's own text rather than from the guard.
 */
describe('round 4 — the spec comes from the requirement clause; the preference stays a preference', () => {
  const constraintsFor = (region: string) => extractGeography(raw({ Region: region }));

  // Verbatim, fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html.
  const HAMCATION =
    'Resident of Florida, with preference given to residents of Central Florida (Orange, ' +
    'Seminole, Osceola, Lake, Volusia, Brevard and Polk Counties)';
  const K6GO =
    'Preference is given to residents of San Diego County (especially Vista Unified School ' +
    'District and Fallbrook Union High School District), followed by Orange and Los Angeles ' +
    'Counties (especially Orange Unified School District, Whittier Union High School District, ' +
    'Huntington Beach Union High School District). Award must go to a California student.';

  it('Orlando HamCation — Florida is REQUIRED; the seven counties are only PREFERRED', () => {
    const cs = constraintsFor(HAMCATION);
    expect(cs).toHaveLength(2);

    expect(cs[0].hard).toBe(true);
    expect(cs[0].fallbackRank).toBe(0);
    expect(cs[0].rawText).toBe('Resident of Florida');
    expect(cs[0].spec).toEqual({ axis: 'geography', geo: { type: 'state', values: ['FL'] } });

    expect(cs[1].hard).toBe(false);
    expect(cs[1].fallbackRank).toBe(0);
    expect(cs[1].rawText).toBe(
      'preference given to residents of Central Florida (Orange, Seminole, Osceola, Lake, ' +
        'Volusia, Brevard and Polk Counties)',
    );
    expect(cs[1].spec).toEqual({
      axis: 'geography',
      geo: {
        type: 'county',
        // "Central Florida" names the state, so each county carries it: Orange, Lake, Polk and
        // Brevard are all names shared with counties in other states, and a preference is still a
        // claim ("you meet this") that should not be handed to an Orange County CALIFORNIA reader.
        values: [
          'Orange, FL', 'Seminole, FL', 'Osceola, FL', 'Lake, FL', 'Volusia, FL', 'Brevard, FL',
          'Polk, FL',
        ],
      },
    });
  });

  it('Orlando HamCation — no HARD constraint carries a county, so a Floridian elsewhere is not barred', () => {
    // The over-hardening direction, asserted as a property rather than by position: any future
    // shape of this output still fails here if a county list ever becomes a bar.
    for (const c of constraintsFor(HAMCATION)) {
      if (!c.hard) continue;
      expect((c.spec as { geo: GeoSpec }).geo.type).not.toBe('county');
    }
  });

  it('K6GO — "Award must go to a California student" is the requirement; the counties are preferred', () => {
    const cs = constraintsFor(K6GO);
    expect(cs).toHaveLength(2);

    expect(cs[0].hard).toBe(true);
    expect(cs[0].fallbackRank).toBe(0);
    expect(cs[0].rawText).toBe('Award must go to a California student');
    expect(cs[0].spec).toEqual({ axis: 'geography', geo: { type: 'state', values: ['CA'] } });

    expect(cs[1].hard).toBe(false);
    expect(cs[1].fallbackRank).toBe(0);
    expect(cs[1].rawText).toBe(
      'Preference is given to residents of San Diego County (especially Vista Unified School ' +
        'District and Fallbrook Union High School District), followed by Orange and Los Angeles ' +
        'Counties (especially Orange Unified School District, Whittier Union High School ' +
        'District, Huntington Beach Union High School District).',
    );
    expect(cs[1].spec).toEqual({
      axis: 'geography',
      geo: { type: 'county', values: ['San Diego', 'Orange', 'Los Angeles'] },
    });
  });

  it('Lois Manley — the Division stays the requirement, and Oregon stops being discarded', () => {
    // Swept, not reported: this entry already published the right HARD answer (the Division), so
    // the whole-field read happened to be correct — but the funder's Oregon preference was thrown
    // away entirely. Scoping keeps the requirement exactly as it was and records the preference.
    const cs = constraintsFor(
      'ARRL Northwestern Division (Washington, Oregon, Idaho, Montana, Alaska), with preference ' +
        'given to residents of Oregon',
    );
    expect(cs).toHaveLength(2);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].rawText).toBe('ARRL Northwestern Division (Washington, Oregon, Idaho, Montana, Alaska)');
    expect(cs[0].spec).toEqual({
      axis: 'geography',
      geo: { type: 'arrl_division', values: ['Northwestern'] },
    });
    expect(cs[1].hard).toBe(false);
    expect(cs[1].rawText).toBe('preference given to residents of Oregon');
    expect(cs[1].spec).toEqual({ axis: 'geography', geo: { type: 'state', values: ['OR'] } });
  });

  it('Francis Walton — a preference stated BEFORE the requirement is still the preference', () => {
    // The hinge here is a semicolon and the order is reversed: the preference comes first. Scope
    // is decided by which clause carries the marker, never by position in the sentence.
    const cs = constraintsFor(
      'Preference given to applicants residing in Illinois; Applicant must be a resident of the ' +
        'ARRL Central Division (IL, IN, WI)',
    );
    expect(cs).toHaveLength(2);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].rawText).toBe('Applicant must be a resident of the ARRL Central Division (IL, IN, WI)');
    expect(cs[0].spec).toEqual({
      axis: 'geography',
      geo: { type: 'arrl_division', values: ['Central'] },
    });
    expect(cs[1].hard).toBe(false);
    expect(cs[1].rawText).toBe('Preference given to applicants residing in Illinois');
    expect(cs[1].spec).toEqual({ axis: 'geography', geo: { type: 'state', values: ['IL'] } });
  });
});

/**
 * The over-softening guard rail for round 4. An explicit cascade is the funder saying in its own
 * words that the first-named area does NOT exclude anyone — "State of Indiana; if no qualified
 * applicant is identified, preference given to applicants from the ARRL Central Division". A
 * scoping rule that reads "State of Indiana" as a requirement and hardens it would bar the
 * Illinois applicant the funder has just said may win. So a cascade is never split: the whole
 * field stays ONE soft constraint with `fallbackRank: 1`, exactly as before this round.
 */
describe('round 4 — an explicit cascade is never split or hardened', () => {
  const constraintsFor = (region: string) => extractGeography(raw({ Region: region }));

  it.each([
    [
      'Indianapolis',
      'State of Indiana; if no qualified applicant is identified, preference given to applicants ' +
        'from the ARRL Central Division (Illinois, Indiana and Wisconsion)',
      { type: 'arrl_division', values: ['Central'] },
    ],
    [
      'North Fulton',
      'Residence in GA. If no qualified applicant, preference will be awarded to an applicant ' +
        'from the ARRL Southeastern Division (Alabama, Florida, Georgia, Puerto Rico and the US ' +
        'Virgin Islands)',
      { type: 'arrl_division', values: ['Southeastern'] },
    ],
    [
      'MMARSI',
      'State of Maryland; if no qualified applicant is identified, preference will be given to ' +
        'applicants from the states of Virginia, Delaware, The District of Columbia, ' +
        'Pennsylvania, and West Virginia, and then the remaining USA.',
      { type: 'state', values: ['DE', 'DC', 'MD', 'PA', 'VA', 'WV'] },
    ],
  ] as const)('%s: one soft constraint over the whole field, fallbackRank 1', (_name, text, geo) => {
    const cs = constraintsFor(text);
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(false);
    expect(cs[0].fallbackRank).toBe(1);
    expect(cs[0].rawText).toBe(text);
    expect(cs[0].spec).toEqual({ axis: 'geography', geo });
  });

  it('the canonical Louisiana cascade is still one soft constraint, not two', () => {
    const cs = constraintsFor(
      'Preference will be given to applicants residing in Louisiana. If no qualified applicant is ' +
        'identified, the scholarship may be awarded to an applicant from the Delta Division ' +
        '(Arkansas, Louisiana, Mississippi, Tennessee).',
    );
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(false);
    expect(cs[0].fallbackRank).toBe(1);
    expect(cs[0].spec).toEqual({
      axis: 'geography',
      geo: { type: 'arrl_division', values: ['Delta'] },
    });
  });

  it('a whole-value preference with no requirement beside it stays one soft constraint', () => {
    // Palomar, verbatim: there is nothing outside the preference to scope to, so nothing to split.
    const cs = constraintsFor('Preference is given to applicants residing in San Diego or Imperial Counties, CA');
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(false);
    expect(cs[0].spec).toEqual({
      axis: 'geography',
      geo: { type: 'county', values: ['San Diego, CA', 'Imperial, CA'] },
    });
  });

  it('a plain requirement with no preference at all is untouched: one hard constraint', () => {
    const cs = constraintsFor('Resident of GA or AL');
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].rawText).toBe('Resident of GA or AL');
    expect(cs[0].spec).toEqual({ axis: 'geography', geo: { type: 'state', values: ['GA', 'AL'] } });
  });
});
