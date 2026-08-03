import { ARRL_DIVISIONS, ARRL_SECTIONS } from './arrlSections.js';
import type { GeoSpec } from './types.js';

/** Mean Earth radius in statute miles (6371.0088 km / 1.609344). */
const EARTH_RADIUS_MILES = 3958.7613;

export interface GeoLocation {
  state?: string;
  county?: string;
  lat?: number;
  lon?: number;
  callDistrict?: string;
  callsign?: string;
}

export interface GeoDecision {
  status: 'pass' | 'fail' | 'unknown';
  missing: string[];
}

const PASS: GeoDecision = { status: 'pass', missing: [] };
const FAIL: GeoDecision = { status: 'fail', missing: [] };

/**
 * Lookup key: lowercase, punctuation flattened to single spaces, and a
 * trailing "division"/"section" word dropped, so "Maryland-DC",
 * "maryland dc" and "MARYLAND-DC Section" all agree.
 */
function normKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/ /g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+(division|section)$/, '')
    .trim();
}

const SECTION_BY_KEY = new Map<string, (typeof ARRL_SECTIONS)[number]>();
for (const section of ARRL_SECTIONS) {
  SECTION_BY_KEY.set(normKey(section.name), section);
  SECTION_BY_KEY.set(normKey(section.abbrev), section);
}

const DIVISION_STATES = new Map<string, string[]>();
for (const division of ARRL_DIVISIONS) {
  const states: string[] = [];
  for (const section of ARRL_SECTIONS) {
    if (section.division !== division) continue;
    for (const state of section.states) if (!states.includes(state)) states.push(state);
  }
  DIVISION_STATES.set(normKey(division), states.sort());
}

export function statesForArrlDivision(division: string): string[] {
  const states = DIVISION_STATES.get(normKey(division));
  return states === undefined ? [] : [...states];
}

export function statesForArrlSection(section: string): string[] {
  const found = SECTION_BY_KEY.get(normKey(section));
  return found === undefined ? [] : [...found.states];
}

export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function withinRadius(lat: number, lon: number, geo: GeoSpec): boolean {
  if (geo.type !== 'radius') return false;
  if (geo.centerLat === undefined || geo.centerLon === undefined) return false;
  if (geo.radiusMiles === undefined) return false;
  return haversineMiles(lat, lon, geo.centerLat, geo.centerLon) <= geo.radiusMiles;
}

/** The digit in a US callsign is its call district: W5XYZ is district 5. */
export function callDistrictFromCallsign(callsign: string): string | undefined {
  const m = /^[A-Z]{1,2}(\d)[A-Z]{1,4}$/.exec(callsign.trim().toUpperCase());
  return m === null ? undefined : m[1];
}

function parseCountyValue(value: string): { county: string; state?: string } {
  const parts = value.split(',');
  const county = normKey(parts[0].replace(/\bcounty\b/i, ''));
  if (parts.length < 2) return { county };
  return { county, state: parts[1].trim().toUpperCase() };
}

export function evaluateGeo(geo: GeoSpec, loc: GeoLocation): GeoDecision {
  switch (geo.type) {
    case 'any':
      return PASS;

    case 'state': {
      if (loc.state === undefined) return { status: 'unknown', missing: ['state'] };
      const mine = loc.state.trim().toUpperCase();
      return geo.values.some((v) => v.trim().toUpperCase() === mine) ? PASS : FAIL;
    }

    case 'arrl_division': {
      if (loc.state === undefined) return { status: 'unknown', missing: ['state'] };
      const mine = loc.state.trim().toUpperCase();
      return geo.values.some((v) => statesForArrlDivision(v).includes(mine)) ? PASS : FAIL;
    }

    case 'arrl_section': {
      if (loc.state === undefined) return { status: 'unknown', missing: ['state'] };
      const mine = loc.state.trim().toUpperCase();
      return geo.values.some((v) => statesForArrlSection(v).includes(mine)) ? PASS : FAIL;
    }

    case 'county': {
      if (loc.county === undefined) return { status: 'unknown', missing: ['county'] };
      const mine = normKey(loc.county.replace(/\bcounty\b/i, ''));
      let needsState = false;
      for (const value of geo.values) {
        const parsed = parseCountyValue(value);
        if (parsed.county !== mine) continue;
        if (parsed.state === undefined) return PASS;
        if (loc.state === undefined) {
          needsState = true;
          continue;
        }
        if (parsed.state === loc.state.trim().toUpperCase()) return PASS;
      }
      return needsState ? { status: 'unknown', missing: ['state'] } : FAIL;
    }

    case 'radius': {
      if (loc.lat === undefined || loc.lon === undefined) {
        const missing: string[] = [];
        if (loc.lat === undefined) missing.push('lat');
        if (loc.lon === undefined) missing.push('lon');
        return { status: 'unknown', missing };
      }
      return withinRadius(loc.lat, loc.lon, geo) ? PASS : FAIL;
    }

    case 'call_district': {
      const district =
        loc.callDistrict ??
        (loc.callsign === undefined ? undefined : callDistrictFromCallsign(loc.callsign));
      if (district === undefined) return { status: 'unknown', missing: ['callDistrict'] };
      return geo.values.some((v) => v.trim() === district) ? PASS : FAIL;
    }
  }
}
