import { describe, expect, it } from 'vitest';
import {
  orgProfileSchema,
  PROFILE_NON_FIELD_KEYS,
  profileFieldOrigin,
  profileSchema,
  profileValueOrigin,
  pruneFieldSources,
  studentProfileSchema,
  type OrgProfile,
  type ProfileFieldSource,
  type StudentProfile,
} from '../src/index.js';
import { makeOrg, makeStudent } from './fixtures.js';

/**
 * A value this tool FETCHED must never be stored in the same shape as a value the applicant TYPED.
 * These tests are the profile-side half of that rule — `field_provenance` is `program_id`-keyed
 * and says nothing about a profile.
 *
 * The two properties worth stating plainly, because everything below is one of them:
 *   1. a marker survives being saved and read back, or the provenance is lost at the first PUT;
 *   2. a marker cannot outlive the value it describes, or the badge "filled from callook.info"
 *      ends up sitting on something the applicant typed themselves.
 */
const LOOKUP = (value: string): ProfileFieldSource => ({
  source: 'callook.info',
  fetchedAt: '2026-08-04T12:00:00.000Z',
  value,
});

describe('profile field provenance', () => {
  it('round-trips a marker through the zod schema unchanged', () => {
    const profile: StudentProfile = makeStudent({
      licenseClass: 'GENERAL',
      state: 'MI',
      fieldSources: { licenseClass: LOOKUP('GENERAL'), state: LOOKUP('MI') },
    });

    const parsed = studentProfileSchema.parse(profile);

    expect(parsed).toEqual(profile);
    expect(parsed.fieldSources?.state).toEqual({
      source: 'callook.info',
      fetchedAt: '2026-08-04T12:00:00.000Z',
      value: 'MI',
    });
    // Through the union the server actually validates stored rows with, too.
    expect(profileSchema.parse(profile)).toEqual(profile);
  });

  it('round-trips an organisation marker on the club name', () => {
    const profile: OrgProfile = makeOrg({
      orgName: 'University of Michigan Amateur Radio Club',
      state: 'MI',
      fieldSources: { orgName: LOOKUP('University of Michigan Amateur Radio Club') },
    });

    expect(orgProfileSchema.parse(profile)).toEqual(profile);
  });

  /**
   * The callsign is the one field whose value can change under the person who typed it: callook
   * answers a lookup of a SUPERSEDED callsign with the licensee's CURRENT record, so a profile can
   * end up holding a callsign the applicant never entered. Storable, therefore — and on both
   * kinds, because a club callsign is superseded exactly as an individual's is.
   */
  it('round-trips a marker on a callsign the lookup answered with', () => {
    const student: StudentProfile = makeStudent({
      callsign: 'W5NEW',
      fieldSources: { callsign: LOOKUP('W5NEW') },
    });
    expect(studentProfileSchema.parse(student)).toEqual(student);

    const org: OrgProfile = makeOrg({ callsign: 'W5NEW', fieldSources: { callsign: LOOKUP('W5NEW') } });
    expect(orgProfileSchema.parse(org)).toEqual(org);

    // And it obeys the same self-invalidation as every other marker: typing over it makes it
    // the applicant's again, and the marker is dropped on the way into storage.
    const retyped: StudentProfile = makeStudent({
      callsign: 'K9OLD',
      fieldSources: { callsign: LOOKUP('W5NEW') },
    });
    expect(profileFieldOrigin(retyped, 'callsign')).toBe('typed');
    expect(pruneFieldSources(retyped)).not.toHaveProperty('fieldSources');
  });

  it('refuses to store a marker on a field the source cannot supply', () => {
    // `licensedSince` is the one that matters: callook's grant date resets on every renewal and
    // every vanity change, and `licensedSince` feeds `heldMonthsMin` in the matcher. `county` is
    // simply not in the record. Neither is a key of `StudentFieldSources`, so zod strips both —
    // the same way it strips any other key CONTRACT §3 does not define.
    const parsed = studentProfileSchema.parse({
      kind: 'student',
      licensedSince: '2019-04-04',
      county: 'Washtenaw',
      gpa: 3.4,
      fieldSources: {
        licensedSince: LOOKUP('2019-04-04'),
        county: LOOKUP('Washtenaw'),
        gpa: LOOKUP('3.4'),
      },
    });

    expect(Object.keys(parsed.fieldSources ?? {})).toEqual([]);
    // The values themselves are kept — they are perfectly good things for a person to have typed.
    expect(parsed.licensedSince).toBe('2019-04-04');
    expect(parsed.county).toBe('Washtenaw');
  });

  it('refuses a licence-class marker on an organisation, which has no licence class', () => {
    const parsed = orgProfileSchema.parse({
      kind: 'organization',
      entity: 'club_501c3',
      fieldSources: { licenseClass: LOOKUP('GENERAL') },
    });
    expect(Object.keys(parsed.fieldSources ?? {})).toEqual([]);
  });

  it('refuses a marker that names a source nobody fetched from', () => {
    const parsed = studentProfileSchema.safeParse({
      kind: 'student',
      state: 'MI',
      fieldSources: { state: { source: 'fcc.gov', fetchedAt: '2026-08-04', value: 'MI' } },
    });
    expect(parsed.success).toBe(false);
  });

  describe('profileValueOrigin', () => {
    it('reads an untouched auto-filled value as looked up', () => {
      expect(profileValueOrigin('MI', LOOKUP('MI'))).toBe('looked_up');
    });

    it('reads a value with no marker as the applicant’s own', () => {
      expect(profileValueOrigin('MI', undefined)).toBe('typed');
    });

    it('reads an EDITED value as the applicant’s own, marker or no marker', () => {
      // The whole reason the marker stores the filled value. Nothing had to remember to clear it.
      expect(profileValueOrigin('OH', LOOKUP('MI'))).toBe('typed');
    });

    it('reads an empty field as unset even when a marker is still attached', () => {
      expect(profileValueOrigin(undefined, LOOKUP('MI'))).toBe('unset');
      expect(profileValueOrigin(null, LOOKUP('MI'))).toBe('unset');
    });
  });

  describe('profileFieldOrigin', () => {
    const profile: StudentProfile = makeStudent({
      licenseClass: 'EXTRA',
      state: 'OH',
      gpa: 3.9,
      fieldSources: { licenseClass: LOOKUP('EXTRA'), state: LOOKUP('MI') },
    });

    it('attributes each field separately', () => {
      expect(profileFieldOrigin(profile, 'licenseClass')).toBe('looked_up');
      // Filled 'MI', now reads 'OH': the applicant corrected it, so it is theirs.
      expect(profileFieldOrigin(profile, 'state')).toBe('typed');
      // No marker is possible on `gpa` at all, and it holds a value, so a person put it there.
      expect(profileFieldOrigin(profile, 'gpa')).toBe('typed');
      expect(profileFieldOrigin(profile, 'county')).toBe('unset');
    });

    it('answers for a profile that has never seen a lookup', () => {
      const typed = makeStudent({ state: 'TX' });
      expect(profileFieldOrigin(typed, 'state')).toBe('typed');
      expect(profileFieldOrigin(typed, 'gpa')).toBe('unset');
    });
  });

  describe('pruneFieldSources', () => {
    it('drops the marker on an edited field and keeps the rest', () => {
      const profile: StudentProfile = makeStudent({
        licenseClass: 'EXTRA',
        state: 'OH',
        fieldSources: { licenseClass: LOOKUP('EXTRA'), state: LOOKUP('MI') },
      });

      const pruned = pruneFieldSources(profile) as StudentProfile;

      expect(pruned.fieldSources).toEqual({ licenseClass: LOOKUP('EXTRA') });
      // Values are untouched: pruning is about attribution, not about the answers.
      expect(pruned.state).toBe('OH');
      expect(pruned.licenseClass).toBe('EXTRA');
      // The input is not mutated — the caller may still be rendering it.
      expect(profile.fieldSources?.state).toEqual(LOOKUP('MI'));
    });

    it('drops a marker whose field has been emptied', () => {
      const profile: StudentProfile = makeStudent({ fieldSources: { state: LOOKUP('MI') } });
      expect(pruneFieldSources(profile)).not.toHaveProperty('fieldSources');
    });

    it('removes the map entirely rather than storing an empty one', () => {
      // "No field was filled by a lookup" and "this profile predates provenance" must serialise
      // identically, or a diff of two equivalent profiles shows a change nobody made.
      const edited: StudentProfile = makeStudent({
        state: 'OH',
        fieldSources: { state: LOOKUP('MI') },
      });
      expect(JSON.stringify(pruneFieldSources(edited))).toBe(
        JSON.stringify(makeStudent({ state: 'OH' })),
      );
    });

    it('leaves a profile with no markers exactly as it was', () => {
      const profile = makeStudent({ state: 'TX' });
      expect(pruneFieldSources(profile)).toBe(profile);
    });

    it('keeps what it prunes storable', () => {
      const profile: OrgProfile = makeOrg({
        orgName: 'Renamed Club',
        state: 'MI',
        fieldSources: { orgName: LOOKUP('Old Club'), state: LOOKUP('MI') },
      });
      const pruned = pruneFieldSources(profile);
      expect(orgProfileSchema.parse(pruned)).toEqual(pruned);
      expect((pruned as OrgProfile).fieldSources).toEqual({ state: LOOKUP('MI') });
    });
  });

  describe('PROFILE_NON_FIELD_KEYS', () => {
    // This list is an escape hatch from the registry coverage assertion in
    // `web/src/lib/profileFields.test.ts`: a key named here needs no label, no help text and no
    // input in the profile editor. Two keys qualify and no more, so the list is pinned. Adding a
    // third has to be a deliberate act that changes this line.
    it('names exactly the two keys that are not applicant-entered fields', () => {
      expect([...PROFILE_NON_FIELD_KEYS]).toEqual(['kind', 'fieldSources']);
    });

    it('names only keys that both profile schemas actually have', () => {
      for (const key of PROFILE_NON_FIELD_KEYS) {
        expect(Object.keys(studentProfileSchema.shape), key).toContain(key);
        expect(Object.keys(orgProfileSchema.shape), key).toContain(key);
      }
    });
  });
});
