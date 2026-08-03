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
  it('the real Peoria Area entry: all nine named counties present, nothing else', () => {
    const geo = sortValues(
      geoOf(
        'Residence in Central IL in one of these counties: Peoria, Tazewell, Woodford, Knox, McLean, Fulton, Logan, Marshall or Stark',
      ),
    );
    expect(geo).toEqual({
      type: 'county',
      values: [
        'Fulton', 'Knox', 'Logan', 'Marshall', 'McLean', 'Peoria', 'Stark', 'Tazewell', 'Woodford',
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
    ).toEqual({ type: 'county', values: ['Pasco'] });
  });

  it('a multi-word county name (San Diego) is not truncated or prefixed', () => {
    expect(
      geoOf('Preference given to applicants from San Diego County, California.'),
    ).toEqual({ type: 'county', values: ['San Diego'] });
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
