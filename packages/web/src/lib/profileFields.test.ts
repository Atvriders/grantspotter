import { describe, it, expect } from 'vitest';
import { orgProfileSchema, studentProfileSchema } from '@grantspotter/core';
import {
  PROFILE_FIELDS,
  profileFieldHelp,
  profileFieldHref,
  profileFieldLabel,
} from './profileFields.js';

/**
 * The registry is DERIVED-CHECKED, not hand-checked.
 *
 * A hand-written list of "fields we remembered" is silent exactly where it is incomplete — the
 * defect class this repository keeps paying for (see `contrast.test.ts`, whose hand-written pair
 * list hid a real AA failure). So both directions are asserted against core's own zod mirrors of
 * `StudentProfile` and `OrgProfile`: a field added to CONTRACT §3 fails this suite until the
 * registry carries a label and a help sentence for it, and a registry entry naming a field that
 * no longer exists fails too.
 */
const SCHEMA_KEYS = {
  student: Object.keys(studentProfileSchema.shape).filter((k) => k !== 'kind'),
  organization: Object.keys(orgProfileSchema.shape).filter((k) => k !== 'kind'),
} as const;

describe('profile field registry', () => {
  it('covers every StudentProfile field the matcher can report as missing', () => {
    const keys = new Set(PROFILE_FIELDS.filter((f) => f.kind === 'student').map((f) => f.key));
    for (const required of [
      'licenseClass', 'licensedSince', 'state', 'lat', 'lon', 'callDistrict',
      'fieldOfStudy', 'degreeLevel', 'institution', 'accredited', 'partTime',
      'gpa', 'classRankTopPct', 'arrlMemberSince', 'citizenship', 'birthDate',
      'stage', 'activityKinds', 'cwWpm', 'financialNeed', 'gender',
    ]) {
      expect(keys.has(required), `missing registry entry: ${required}`).toBe(true);
    }
  });

  it('covers the OrgProfile fields too', () => {
    const keys = new Set(PROFILE_FIELDS.filter((f) => f.kind === 'organization').map((f) => f.key));
    for (const required of ['entity', 'is501c3', 'hasFiscalSponsor', 'arrlAffiliated', 'memberCount']) {
      expect(keys.has(required), `missing registry entry: ${required}`).toBe(true);
    }
  });

  it.each(['student', 'organization'] as const)(
    'carries exactly the %s fields core declares — no gaps, no ghosts',
    (kind) => {
      const registry = PROFILE_FIELDS.filter((f) => f.kind === kind).map((f) => f.key).sort();
      expect(registry).toEqual([...SCHEMA_KEYS[kind]].sort());
    },
  );

  it('registers the geography fields an ORGANIZATION can hold', () => {
    // `OrgProfile` has `state`, `lat`, `lon` and `callsign`, and `evaluateConstraint`'s geography
    // axis reads all four for an org exactly as it does for a student. Registering them under
    // `student` alone would leave the organization editor with no input for them (Task 22 renders
    // `PROFILE_FIELDS.filter(f => f.kind === kind)`), so the geography `unknown` an org sees would
    // be permanently unresolvable and its "go fix it" link would open the wrong tab.
    const orgKeys = new Set(PROFILE_FIELDS.filter((f) => f.kind === 'organization').map((f) => f.key));
    for (const shared of ['state', 'lat', 'lon', 'callsign']) {
      expect(orgKeys.has(shared), `organization cannot enter ${shared}`).toBe(true);
    }
  });

  it('gives a field held by both kinds identical copy, so a lookup by key alone cannot mislead', () => {
    // Tasks 18 and 22 look entries up with `PROFILE_FIELDS.find(f => f.key === field)`, which
    // cannot know the profile kind. Identical copy makes that lookup safe.
    for (const key of ['state', 'lat', 'lon', 'callsign']) {
      const entries = PROFILE_FIELDS.filter((f) => f.key === key);
      expect(entries.length, `${key} should exist for both kinds`).toBe(2);
      expect(new Set(entries.map((f) => f.label)).size).toBe(1);
      expect(new Set(entries.map((f) => f.help)).size).toBe(1);
    }
  });

  it('gives every entry a human label and a help sentence', () => {
    for (const field of PROFILE_FIELDS) {
      expect(field.label.length, `${field.key} has no label`).toBeGreaterThan(0);
      expect(field.help.length, `${field.key} has no help`).toBeGreaterThan(0);
      // A "help" string that is just the label restated helps nobody.
      expect(field.help.length, `${field.key} help is too thin`).toBeGreaterThan(field.label.length);
    }
  });

  it('links a field key to the editor anchor that focuses it', () => {
    expect(profileFieldHref('gpa')).toBe('/profile?kind=student&focus=gpa#field-gpa');
    expect(profileFieldHref('memberCount'))
      .toBe('/profile?kind=organization&focus=memberCount#field-memberCount');
  });

  it('sends a shared field to the tab the caller is actually on', () => {
    expect(profileFieldHref('state', 'organization'))
      .toBe('/profile?kind=organization&focus=state#field-state');
    expect(profileFieldHref('state', 'student'))
      .toBe('/profile?kind=student&focus=state#field-state');
    // No kind supplied: the student editor, which is the only tab that holds most fields.
    expect(profileFieldHref('state')).toBe('/profile?kind=student&focus=state#field-state');
  });

  it('still lands on the tab that HAS the field when the caller names the wrong kind', () => {
    // A student-profile page asking for an org-only field must not produce a dead anchor.
    expect(profileFieldHref('memberCount', 'student'))
      .toBe('/profile?kind=organization&focus=memberCount#field-memberCount');
  });

  it('falls back to the raw key for an unregistered field rather than rendering blank', () => {
    expect(profileFieldLabel('somethingNew')).toBe('somethingNew');
    expect(profileFieldHref('somethingNew')).toBe('/profile');
    expect(profileFieldHelp('somethingNew')).toBe('');
  });

  it('explains the ARRL Section concept where geography is involved', () => {
    const state = PROFILE_FIELDS.find((f) => f.key === 'state');
    expect(state?.help).toMatch(/ARRL/);
  });

  it('exposes help text for a registered field', () => {
    expect(profileFieldHelp('gpa')).toMatch(/2\.5/);
  });
});
