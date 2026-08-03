import type { Constraint, GeoSpec, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';
import { RADIUS_CENTERS } from './radiusCenters.js';

const STATE_BY_NAME: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

const RADIUS = /within\s+(\d+)\s+miles\s+of\s+([A-Z][A-Za-z. ]*(?:,\s*[A-Za-z. ]+)?)/i;
const DIVISION = /\b(?:ARRL\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+Division\b/;
const SECTION = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+Section\b/;
const CALL_DISTRICT = /\b(\d)(?:st|nd|rd|th)?\s+call\s+(?:district|area)\b/i;
const COUNTY = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+count(?:y|ies)\b/i;

function geoFrom(text: string): GeoSpec {
  const radius = RADIUS.exec(text);
  if (radius) {
    const centerLabel = radius[2].replace(/\s+/g, ' ').trim().replace(/[.,]$/, '');
    const center = RADIUS_CENTERS[centerLabel.toLowerCase()];
    return {
      type: 'radius',
      values: [centerLabel],
      radiusMiles: Number.parseInt(radius[1], 10),
      centerLabel,
      ...(center ? { centerLat: center.lat, centerLon: center.lon } : {}),
    };
  }

  const callDistrict = CALL_DISTRICT.exec(text);
  if (callDistrict) return { type: 'call_district', values: [callDistrict[1]] };

  const division = DIVISION.exec(text);
  if (division) return { type: 'arrl_division', values: [division[1].trim()] };

  const section = SECTION.exec(text);
  if (section) return { type: 'arrl_section', values: [section[1].trim()] };

  if (COUNTY.test(text)) {
    const before = text.slice(0, COUNTY.exec(text)?.index ?? text.length);
    const names = `${before} ${COUNTY.exec(text)?.[1] ?? ''}`
      .split(/,|\bor\b|\band\b/i)
      .map((s) => s.replace(/[^A-Za-z ]/g, '').trim())
      .filter((s) => s.length > 2);
    return { type: 'county', values: [...new Set(names)] };
  }

  const states = new Set<string>();
  for (const [name, code] of Object.entries(STATE_BY_NAME)) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) states.add(code);
  }
  for (const m of text.matchAll(/\b([A-Z]{2})\b/g)) {
    if (Object.values(STATE_BY_NAME).includes(m[1])) states.add(m[1]);
  }
  if (states.size > 0) return { type: 'state', values: [...states] };

  return { type: 'any', values: [] };
}

export function extractGeography(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields.Region ?? raw.rawFields.counties ?? raw.rawFields.region;
  if (!text || text.trim() === '') return [];
  return [makeConstraint('geography', text, { axis: 'geography', geo: geoFrom(text) }, 0)];
}
