import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARRL_DIVISIONS, ARRL_SECTIONS } from '../src/arrlSections.js';
import {
  callDistrictFromCallsign,
  evaluateGeo,
  haversineMiles,
  statesForArrlDivision,
  statesForArrlSection,
  withinRadius,
} from '../src/geo.js';
import type { GeoSpec } from '../src/types.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// Real centres from the three radius constraints in the corpus.
const SEAFORD_DE = { lat: 38.6415, lon: -75.6113 };
const SCHENECTADY_NY = { lat: 42.8142, lon: -73.9396 };
const ERVING_MA = { lat: 42.6001, lon: -72.4326 };

const PHILADELPHIA = { lat: 39.9526, lon: -75.1652 };
const NEW_YORK = { lat: 40.7128, lon: -74.006 };
const BOSTON = { lat: 42.3601, lon: -71.0589 };
const ALBANY = { lat: 42.6526, lon: -73.7562 };
const AMHERST_MA = { lat: 42.3732, lon: -72.5199 };
const WASHINGTON_DC = { lat: 38.9072, lon: -77.0369 };

function radius(center: { lat: number; lon: number }, miles: number, label: string): GeoSpec {
  return {
    type: 'radius',
    values: [],
    centerLat: center.lat,
    centerLon: center.lon,
    radiusMiles: miles,
    centerLabel: label,
  };
}

describe('ARRL reference table', () => {
  it('has 15 divisions and 71 sections', () => {
    expect(ARRL_DIVISIONS).toHaveLength(15);
    expect(ARRL_SECTIONS).toHaveLength(71);
    expect(new Set(ARRL_SECTIONS.map((s) => s.abbrev)).size).toBe(71);
    for (const section of ARRL_SECTIONS) {
      expect(ARRL_DIVISIONS, `${section.name} has an unknown division`).toContain(
        section.division,
      );
      expect(section.states.length).toBeGreaterThan(0);
    }
  });

  it('matches data/reference/arrl-sections.json exactly', () => {
    const json = JSON.parse(
      readFileSync(`${REPO_ROOT}/data/reference/arrl-sections.json`, 'utf8'),
    ) as { divisions: string[]; sections: typeof ARRL_SECTIONS };
    expect(json.divisions).toEqual([...ARRL_DIVISIONS]);
    expect(json.sections).toEqual([...ARRL_SECTIONS]);
  });
});

describe('division and section lookups', () => {
  it('resolves the Central Division to IL, IN and WI', () => {
    // The Six Meter Club of Chicago scholarship reads "IL or ARRL Central Division".
    expect(statesForArrlDivision('Central')).toEqual(['IL', 'IN', 'WI']);
  });

  it('tolerates case and a trailing "Division"/"Section" word', () => {
    expect(statesForArrlDivision('central division')).toEqual(['IL', 'IN', 'WI']);
    expect(statesForArrlDivision('  ROANOKE  ')).toEqual(['NC', 'SC', 'VA', 'WV']);
    expect(statesForArrlSection('ohio section')).toEqual(['OH']);
  });

  it('resolves multi-state sections', () => {
    expect(statesForArrlSection('Maryland-DC')).toEqual(['MD', 'DC']);
    expect(statesForArrlSection('Pacific')).toEqual(['HI', 'AS', 'GU', 'MP']);
  });

  it('resolves sections by their official abbreviation', () => {
    expect(statesForArrlSection('MDC')).toEqual(['MD', 'DC']);
    expect(statesForArrlSection('WPA')).toEqual(['PA']);
    expect(statesForArrlSection('NLI')).toEqual(['NY']);
    expect(statesForArrlSection('LAX')).toEqual(['CA']);
  });

  it('unions every section in a division, without duplicates', () => {
    expect(statesForArrlDivision('Hudson')).toEqual(['NJ', 'NY']);
    expect(statesForArrlDivision('Southwestern')).toEqual(['AZ', 'CA']);
    expect(statesForArrlDivision('West Gulf')).toEqual(['OK', 'TX']);
    expect(statesForArrlDivision('Pacific')).toEqual(['AS', 'CA', 'GU', 'HI', 'MP', 'NV']);
  });

  it('returns an empty array for names it does not know', () => {
    expect(statesForArrlDivision('Atlantis')).toEqual([]);
    expect(statesForArrlSection('Sector 7G')).toEqual([]);
  });
});

describe('haversineMiles and withinRadius', () => {
  it('puts one degree of latitude at about 69.1 miles', () => {
    expect(haversineMiles(0, 0, 1, 0)).toBeGreaterThan(69);
    expect(haversineMiles(0, 0, 1, 0)).toBeLessThan(69.2);
  });

  it('handles "within 250 miles of Seaford, Delaware"', () => {
    const geo = radius(SEAFORD_DE, 250, 'Seaford, Delaware');
    expect(withinRadius(PHILADELPHIA.lat, PHILADELPHIA.lon, geo)).toBe(true);
    expect(withinRadius(NEW_YORK.lat, NEW_YORK.lon, geo)).toBe(true);
    expect(withinRadius(BOSTON.lat, BOSTON.lon, geo)).toBe(false);
    expect(withinRadius(SEAFORD_DE.lat, SEAFORD_DE.lon, geo)).toBe(true);
  });

  it('handles "within 70 miles of Schenectady, NY"', () => {
    const geo = radius(SCHENECTADY_NY, 70, 'Schenectady, NY');
    expect(withinRadius(ALBANY.lat, ALBANY.lon, geo)).toBe(true);
    expect(withinRadius(NEW_YORK.lat, NEW_YORK.lon, geo)).toBe(false);
    expect(withinRadius(BOSTON.lat, BOSTON.lon, geo)).toBe(false);
  });

  it('handles "within 175 miles of Erving, MA"', () => {
    const geo = radius(ERVING_MA, 175, 'Erving, MA');
    expect(withinRadius(AMHERST_MA.lat, AMHERST_MA.lon, geo)).toBe(true);
    expect(withinRadius(BOSTON.lat, BOSTON.lon, geo)).toBe(true);
    expect(withinRadius(WASHINGTON_DC.lat, WASHINGTON_DC.lon, geo)).toBe(false);
  });

  it('is false for a non-radius spec or an incomplete centre', () => {
    expect(withinRadius(0, 0, { type: 'state', values: ['DE'] })).toBe(false);
    expect(
      withinRadius(38.6415, -75.6113, { type: 'radius', values: [], radiusMiles: 250 }),
    ).toBe(false);
  });
});

describe('callDistrictFromCallsign', () => {
  it('extracts the digit from US callsigns of every prefix length', () => {
    expect(callDistrictFromCallsign('W1AW')).toBe('1');
    expect(callDistrictFromCallsign('K5UTD')).toBe('5');
    expect(callDistrictFromCallsign('KG4ABC')).toBe('4');
    expect(callDistrictFromCallsign('W8UM')).toBe('8');
    expect(callDistrictFromCallsign('  kh6abc ')).toBe('6');
  });

  it('returns undefined for anything that is not a US-shaped callsign', () => {
    expect(callDistrictFromCallsign('2E0ABC')).toBeUndefined();
    expect(callDistrictFromCallsign('')).toBeUndefined();
    expect(callDistrictFromCallsign('NOTACALL')).toBeUndefined();
  });
});

describe('evaluateGeo across all five GeoSpec shapes', () => {
  it('passes "any" with no profile data at all', () => {
    expect(evaluateGeo({ type: 'any', values: [] }, {})).toEqual({ status: 'pass', missing: [] });
  });

  it('evaluates state', () => {
    const geo: GeoSpec = { type: 'state', values: ['LA'] };
    expect(evaluateGeo(geo, { state: 'LA' }).status).toBe('pass');
    expect(evaluateGeo(geo, { state: 'la' }).status).toBe('pass');
    expect(evaluateGeo(geo, { state: 'TX' }).status).toBe('fail');
    expect(evaluateGeo(geo, {})).toEqual({ status: 'unknown', missing: ['state'] });
  });

  it('evaluates arrl_division and arrl_section through the lookup table', () => {
    const division: GeoSpec = { type: 'arrl_division', values: ['Central'] };
    expect(evaluateGeo(division, { state: 'WI' }).status).toBe('pass');
    expect(evaluateGeo(division, { state: 'OH' }).status).toBe('fail');

    const section: GeoSpec = { type: 'arrl_section', values: ['Maryland-DC'] };
    expect(evaluateGeo(section, { state: 'DC' }).status).toBe('pass');
    expect(evaluateGeo(section, { state: 'VA' }).status).toBe('fail');
    expect(evaluateGeo(section, {})).toEqual({ status: 'unknown', missing: ['state'] });
  });

  it('evaluates county, including the state qualifier', () => {
    const geo: GeoSpec = { type: 'county', values: ['Travis County, TX', 'Hays County, TX'] };
    expect(evaluateGeo(geo, { county: 'Travis', state: 'TX' }).status).toBe('pass');
    expect(evaluateGeo(geo, { county: 'Travis County', state: 'TX' }).status).toBe('pass');
    expect(evaluateGeo(geo, { county: 'Travis', state: 'CA' }).status).toBe('fail');
    expect(evaluateGeo(geo, { county: 'Bexar', state: 'TX' }).status).toBe('fail');
    expect(evaluateGeo(geo, { county: 'Travis' })).toEqual({ status: 'unknown', missing: ['state'] });
    expect(evaluateGeo(geo, { state: 'TX' })).toEqual({ status: 'unknown', missing: ['county'] });
  });

  it('evaluates radius and reports both missing coordinates', () => {
    const geo = radius(SCHENECTADY_NY, 70, 'Schenectady, NY');
    expect(evaluateGeo(geo, { lat: ALBANY.lat, lon: ALBANY.lon }).status).toBe('pass');
    expect(evaluateGeo(geo, { lat: NEW_YORK.lat, lon: NEW_YORK.lon }).status).toBe('fail');
    expect(evaluateGeo(geo, {})).toEqual({ status: 'unknown', missing: ['lat', 'lon'] });
    expect(evaluateGeo(geo, { lat: 42 })).toEqual({ status: 'unknown', missing: ['lon'] });
  });

  it('evaluates call_district from the field or from the callsign', () => {
    const geo: GeoSpec = { type: 'call_district', values: ['5'] };
    expect(evaluateGeo(geo, { callDistrict: '5' }).status).toBe('pass');
    expect(evaluateGeo(geo, { callsign: 'K5UTD' }).status).toBe('pass');
    expect(evaluateGeo(geo, { callsign: 'W1AW' }).status).toBe('fail');
    expect(evaluateGeo(geo, {})).toEqual({ status: 'unknown', missing: ['callDistrict'] });
  });
});
