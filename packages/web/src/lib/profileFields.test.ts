import { describe, it, expect } from 'vitest';
import {
  orgFieldSourcesSchema,
  orgProfileSchema,
  PROFILE_NON_FIELD_KEYS,
  studentFieldSourcesSchema,
  studentProfileSchema,
} from '@grantspotter/core';
import {
  callsignFillableFields,
  callsignFillCaveat,
  callsignFillDerivation,
  callsignFillRefusal,
  fieldUsedInMatching,
  PROFILE_FIELDS,
  profileFieldHelp,
  profileFieldHref,
  profileFieldKeys,
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
/**
 * `PROFILE_NON_FIELD_KEYS` rather than a local `k !== 'kind'`: the exclusion list is core's, and it
 * is pinned to exactly two entries by `core/test/profileProvenance.test.ts`, so this assertion
 * cannot be widened from here. `kind` is the discriminant; `fieldSources` is the provenance map,
 * which describes the other keys instead of being one of them — it has no input in the editor, no
 * label and no help sentence, and the matcher can never report it as a missing profile field.
 */
const SCHEMA_KEYS = {
  student: Object.keys(studentProfileSchema.shape).filter(
    (k) => !(PROFILE_NON_FIELD_KEYS as readonly string[]).includes(k),
  ),
  organization: Object.keys(orgProfileSchema.shape).filter(
    (k) => !(PROFILE_NON_FIELD_KEYS as readonly string[]).includes(k),
  ),
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

/**
 * WHICH fields a callsign lookup may fill is a fact with two homes — this registry, which the
 * editor reads, and `StudentFieldSources`/`OrgFieldSources` in core, which is what actually
 * decides whether a marker survives a save. A field that is fillable in the form but not in the
 * schema loses its provenance silently at the next PUT, and the applicant is left with a fetched
 * value that reads exactly like one they typed. So the two are asserted equal in both directions,
 * the same way the registry itself is asserted against the profile schemas above.
 */
const FILLABLE_BY_SCHEMA = {
  student: Object.keys(studentFieldSourcesSchema.shape),
  organization: Object.keys(orgFieldSourcesSchema.shape),
} as const;

describe('what a callsign lookup may fill', () => {
  it.each(['student', 'organization'] as const)(
    'agrees with core about the %s fields — no gaps, no ghosts',
    (kind) => {
      expect(callsignFillableFields(kind).sort()).toEqual([...FILLABLE_BY_SCHEMA[kind]].sort());
    },
  );

  it('is exactly the four things an FCC record can supply, split by profile kind', () => {
    // The licensee NAME (a club record's name IS the organisation name), the operator CLASS, the
    // STATE — and the CALLSIGN. Written out rather than derived, because this is the claim under
    // review: if a fifth key appears here, somebody has decided the FCC record supports something
    // new, and that decision should be visible in a diff.
    //
    // `callsign` IS THAT DECISION, MADE ON 2026-08-04 AND VISIBLE IN THIS LINE. It was absent on
    // the reasoning that a callsign is the question the user asked rather than an answer the tool
    // found — true of every lookup except the one that matters: callook answers a SUPERSEDED
    // callsign with the licensee's CURRENT record, so accepting a record found for K9OLD writes
    // W5NEW into this field. That value is the source's answer and the applicant never typed it,
    // so it needs somewhere to be recorded as one, and `StudentFieldSources.callsign` is it. The
    // ordinary case is unaffected: `fillFromLookup` marks only values whose origin is `'source'`,
    // and a record for the callsign the user typed is labelled `'user'` by `callsignFromRecord`.
    expect(callsignFillableFields('student')).toEqual(['callsign', 'licenseClass', 'state']);
    expect(callsignFillableFields('organization')).toEqual(['orgName', 'callsign', 'state']);
  });

  it('never offers to fill the two fields the record cannot honestly support', () => {
    expect(callsignFillableFields('student')).not.toContain('licensedSince');
    expect(callsignFillableFields('student')).not.toContain('county');

    // And says why, in words an applicant can read — a comment would not survive the next person
    // who notices that the record does carry a date.
    expect(callsignFillRefusal('licensedSince')).toMatch(/renewal/i);
    expect(callsignFillRefusal('licensedSince')).toMatch(/vanity/i);
    expect(callsignFillRefusal('county')).toMatch(/no county/i);
  });

  it('leaves a field the record has nothing to do with unannotated rather than refused', () => {
    // Silence is the third state. Annotating `gpa` would say the question had been considered and
    // answered, which would make the annotations on `licensedSince` and `county` ordinary rather
    // than pointed.
    expect(callsignFillRefusal('gpa')).toBeUndefined();
    expect(callsignFillRefusal('memberCount')).toBeUndefined();
    expect(callsignFillRefusal('somethingNew')).toBeUndefined();
  });

  it('can record every fillable value as the string a marker holds', () => {
    // `ProfileFieldSource.value` is a string, and comparing it to the stored value is what makes
    // an edit clear the marker. A number-, boolean- or array-valued field could not be compared
    // that way, so no such field may be fillable.
    for (const [kind, schema] of [
      ['student', studentProfileSchema],
      ['organization', orgProfileSchema],
    ] as const) {
      for (const key of callsignFillableFields(kind)) {
        const field = (schema.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>)[key];
        expect(field, `${kind}.${key} is not a field of the profile schema`).toBeDefined();
        for (const notAString of [1, true, ['a'], { a: 1 }]) {
          expect(
            field?.safeParse(notAString).success,
            `${kind}.${key} accepts ${JSON.stringify(notAString)}`,
          ).toBe(false);
        }
      }
    }
  });

  it('gives a field held by both kinds the same answer, so a lookup by key alone cannot mislead', () => {
    // Same reason the label and help text must match: Tasks 18 and 22 look entries up by key
    // alone. A `state` that fills for a student and refuses for an organisation would answer
    // whichever kind happened to be listed first.
    for (const key of ['state', 'lat', 'lon', 'callsign']) {
      const entries = PROFILE_FIELDS.filter((f) => f.key === key);
      expect(new Set(entries.map((f) => JSON.stringify(f.callsignFill ?? null))).size, key).toBe(1);
    }
  });

  it('never marks a field both fillable and refused', () => {
    for (const field of PROFILE_FIELDS) {
      if (field.callsignFill?.kind !== 'refused') continue;
      expect(field.callsignFill.because.length, `${field.key} refuses without a reason`)
        .toBeGreaterThan(20);
      expect(callsignFillableFields(field.kind)).not.toContain(field.key);
    }
  });

  /**
   * THE TWO FIELDS THIS WHOLE ROUND IS ABOUT WERE THE TWO THE REGISTRY SAID NOTHING ABOUT.
   *
   * `lat` and `lon` carried no `callsignFill` at all until 2026-08-11, which this registry reads
   * as the third state — "the FCC record has nothing to do with this field" — beside a `county`
   * and a `licensedSince` that each carry an explicit refusal with a reason. It was the opposite
   * of true: callook states a coordinate on every successful lookup, and the code was discarding
   * it. Silence in the registry whose job is to say which is happening is the failure mode the
   * annotations exist to prevent, so it is asserted away here rather than left to be noticed again.
   */
  it('says something explicit about the coordinate fields, on both profile kinds', () => {
    for (const key of ['lat', 'lon']) {
      const entries = PROFILE_FIELDS.filter((f) => f.key === key);
      expect(entries.length, `${key} should exist for both kinds`).toBe(2);
      for (const entry of entries) {
        expect(entry.callsignFill?.kind, `${key} (${entry.kind}) is unannotated`).toBe(
          'fills_unattributed',
        );
      }
      // A lookup fills it, so "GrantSpotter will never fill this in" must NOT be what is shown.
      expect(callsignFillRefusal(key)).toBeUndefined();
      // The caveat says all three: what the number is, what GrantSpotter does with it, and that
      // no marker can be stored for a number.
      const caveat = callsignFillCaveat(key) ?? '';
      expect(caveat, key).toMatch(/PO box/i);
      expect(caveat, key).toMatch(/nowhere to record|reads exactly like a coordinate you typed/i);
      /**
       * AND IT IS TRUE WITH A NUMBER IN THE BOX. This caveat is attached to the FIELD, not to an
       * event, so it is read beside whatever the field currently holds — and on 2026-08-11 it was
       * measured saying the lookup "will show it without filling it in" beside a Latitude box
       * holding 42.34991837, the post office callook geocoded for W1MX. The behaviour was changed
       * to the one the sentence described rather than the sentence weakened to fit: no arm of a
       * lookup puts a coordinate in these boxes. So the caveat must go on stating a refusal to
       * fill, and must NOT read as a conditional promise about which kind of address gets filled
       * in — the phrasing that made the old one false.
       */
      expect(caveat, key).toMatch(/will not fill this in for you/i);
      expect(caveat, key).toMatch(/never writes it into this box itself/i);
      expect(caveat, key).toMatch(/in it because you put it there/i);
      expect(caveat, key).not.toMatch(/can fill this in/i);
      expect(caveat, key).not.toMatch(/only from a street address/i);
      // NO CLAIM ABOUT THE BOX'S CURRENT CONTENTS, which is what makes a permanent sentence safe
      // beside a value: this caveat is read beside an empty box AND beside a coordinate the
      // applicant chose in an earlier session, and it has to be true of both.
      expect(caveat, key).not.toMatch(/leaves this box empty|this box is empty|without filling it/i);
    }
  });

  /**
   * A value computed from another field of the same profile is a THIRD case, and the registry has
   * to name the field it comes from — not merely explain itself in prose. The editor recomputes
   * the district when the callsign changes, and it can only do that if it can ask which input to
   * watch. A call district left behind after the callsign moves to another licensee is the same
   * defect as a stale provenance marker, which this product has already had once.
   */
  it('names the field a derived value is derived FROM, not just that it is derived', () => {
    const derivation = callsignFillDerivation('callDistrict', 'student');
    expect(derivation?.from).toBe('callsign');
    // ...and that name has to be a real input on the same profile, or nothing can watch it.
    expect(profileFieldKeys('student')).toContain(derivation?.from);
    // No source is credited for arithmetic this tool did itself — core says the same thing in
    // `StudentFieldSources`, which is why `callDistrict` is not in the fillable set.
    expect(callsignFillableFields('student')).not.toContain('callDistrict');
    expect(derivation?.because).toMatch(/callsign/i);
    // An organisation profile has no call district at all, so there is nothing to derive there.
    expect(profileFieldKeys('organization')).not.toContain('callDistrict');
  });

  it('leaves no field of either profile without an answer about what a lookup does to it', () => {
    // Not a demand that every field be annotated — silence is a legitimate answer for `gpa`. What
    // is asserted is that every annotation present is one of the four the union declares, so a
    // fifth case cannot be introduced as a free-form string nothing renders.
    const kinds = new Set(
      PROFILE_FIELDS.map((f) => f.callsignFill?.kind).filter((k) => k !== undefined),
    );
    expect([...kinds].sort()).toEqual(['derived', 'fills', 'fills_unattributed', 'refused']);
  });
});

/**
 * WHICH BOXES CHANGE THE ANSWER, AND WHICH ARE FOR THE APPLICANT'S OWN RECORDS.
 *
 * A person filling in thirty-five inputs is owed the difference. `matcher.ts` is the only thing
 * that computes a verdict and it reads a subset; the rest is real and goes on the application a
 * funder reads, but cannot move what GrantSpotter says.
 *
 * The claim is STRUCTURAL — "matcher.ts reads this field" — and it is pinned as a written-out list
 * rather than derived, for the same reason `callsignFillableFields` is: this is the claim under
 * review, and a change to it should be visible in a diff. Verified with
 * `grep -rn 'profile\.<key>' packages/core/src/`, which finds no read anywhere in core for any of
 * the seven below.
 *
 * NOT a corpus measurement, deliberately. Dropping `state` from an organisation profile moves no
 * verdict over today's 143-record seed corpus either — the eleven club programs in it are all
 * `geography: any` — and it would be false to tell a club that its state is decorative.
 */
describe('which fields the matcher actually reads', () => {
  const IGNORED = [
    'institution', // the axes ask whether the school is accredited and at what level, never which
    'orgName',
    'ein',
    'is501c3',
    'hasFiscalSponsor',
    'memberCount',
    'institutionName',
  ];

  it('is exactly this list, and everything else is read', () => {
    const ignored = PROFILE_FIELDS.filter((f) => !f.usedInMatching).map((f) => f.key).sort();
    expect(ignored).toEqual([...IGNORED].sort());
  });

  it('gives a field held by both kinds the same answer', () => {
    // Same reason as the label, help and `callsignFill` assertions above: a lookup by key alone
    // cannot know the kind, so `lat` must not be load-bearing on one tab and decorative on the other.
    for (const key of ['state', 'lat', 'lon', 'callsign']) {
      const entries = PROFILE_FIELDS.filter((f) => f.key === key);
      expect(new Set(entries.map((f) => f.usedInMatching)).size, key).toBe(1);
    }
  });

  it('answers false for a key nobody registered, rather than claiming it matters', () => {
    expect(fieldUsedInMatching('somethingNew')).toBe(false);
    expect(fieldUsedInMatching('gpa')).toBe(true);
    expect(fieldUsedInMatching('memberCount', 'organization')).toBe(false);
  });

  it('reads the coordinate pair, which is what makes a prefilled coordinate consequential', () => {
    // The point of the caveat on `lat`/`lon`: these are not inert. `evaluateGeo`'s radius axis is
    // the only thing in the product that reads them, and it produces a verdict from them.
    expect(fieldUsedInMatching('lat', 'student')).toBe(true);
    expect(fieldUsedInMatching('lon', 'organization')).toBe(true);
  });
});
