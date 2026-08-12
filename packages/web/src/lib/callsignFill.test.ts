import { describe, expect, it } from 'vitest';
import { profileValueOrigin, pruneFieldSources, type StudentProfile } from '@grantspotter/core';
import {
  callsignFromRecord,
  fillFromLookup,
  fromSource,
  type AcceptedCallsign,
} from './callsignFill.js';
import { callsignFillableFields } from './profileFields.js';

/**
 * THE ONE PLACE A "READ FROM callook.info" MARKER IS BUILT.
 *
 * The rule it enforces is one sentence: a marker may only ever describe what the SOURCE returned.
 * Everything below is a way that used to be false. The panel this feeds is an editor — it opens
 * with the record's values in inputs the user can change, and for the three legacy licence classes
 * it deliberately opens EMPTY and asks them to pick — so "the value that was filled in" and "the
 * value the source stated" are different things far more often than the old code assumed.
 */

const PROVENANCE = {
  source: 'callook.info',
  fetchedAt: '2026-08-04T12:00:00.000Z',
} as const;

function accepted(over: Partial<AcceptedCallsign> = {}): AcceptedCallsign {
  return {
    callsign: { value: 'W8UM', origin: 'user' },
    type: 'PERSON',
    provenance: PROVENANCE,
    ...over,
  };
}

describe('labelling a value with who stated it', () => {
  it('calls a value the record returned the source’s', () => {
    expect(fromSource('MI', 'MI')).toEqual({ value: 'MI', origin: 'source' });
  });

  it('calls a value the record did not return the user’s', () => {
    expect(fromSource('MI', 'OH')).toEqual({ value: 'OH', origin: 'user' });
  });

  /**
   * The legacy-class case, which is the reported defect in one line. ADVANCED, NOVICE and
   * TECHNICIAN PLUS map onto none of GrantSpotter's four, so `record.operClass` is `undefined` and
   * the panel asks the applicant to choose. There is nothing for their choice to have come from.
   */
  it('calls a value the record stated NOTHING for the user’s, whatever they picked', () => {
    for (const picked of ['NONE', 'TECH', 'GENERAL', 'EXTRA'] as const) {
      expect(fromSource(undefined, picked)).toEqual({ value: picked, origin: 'user' });
    }
  });

  it('reads the callsign the other way round, because the callsign is the question', () => {
    expect(callsignFromRecord('W8UM', 'W8UM')).toEqual({ value: 'W8UM', origin: 'user' });
    // callook answered a superseded call with the licensee's current record: this one is an answer.
    expect(callsignFromRecord('W5NEW', 'K9OLD')).toEqual({ value: 'W5NEW', origin: 'source' });
  });
});

describe('building the values and the markers a host writes', () => {
  it('marks what the source stated', () => {
    const fill = fillFromLookup(
      accepted({
        state: { value: 'MI', origin: 'source' },
        licenseClass: { value: 'GENERAL', origin: 'source' },
      }),
      'student',
    );

    /**
     * `callDistrict: '8'` IS NEW HERE ON 2026-08-11, AND IT IS THE DESIGN CHANGING RATHER THAN
     * THIS ASSERTION BEING WRONG. A lookup now also writes what FOLLOWS from a value it wrote:
     * the 8 in W8UM is the call district, `evaluateGeo` in core does the same sum when the field
     * is empty, and the owner asked for the box to be filled. It is not marked and never will be
     * — see the `derived` assertion below — because crediting callook.info for the digit in a
     * callsign would credit a source for this tool's own arithmetic.
     */
    expect(fill.values).toEqual({
      callsign: 'W8UM',
      state: 'MI',
      licenseClass: 'GENERAL',
      callDistrict: '8',
    });
    expect(fill.fieldSources).toEqual({
      state: { ...PROVENANCE, value: 'MI' },
      licenseClass: { ...PROVENANCE, value: 'GENERAL' },
    });
    // The callsign the user typed is theirs, and the record agreeing with it changes nothing.
    expect(fill.unmarked).toEqual(['callsign']);
    // Nobody stated the district: not the source, not the applicant. It is arithmetic, in its own
    // list, so a host cannot describe it as either.
    expect(fill.derived).toEqual(['callDistrict']);
    expect(fill.unmarked).not.toContain('callDistrict');
    expect(fill.fieldSources).not.toHaveProperty('callDistrict');
  });

  /**
   * The district follows the callsign THE RECORD IS FOR, which is not always the one that was
   * typed. callook answers a lookup of a superseded callsign with the licensee's current record,
   * so accepting a record found for K9OLD puts W5NEW in the field — and district 5, not 9.
   */
  it('derives the district from the callsign the record answered with, not the one asked about', () => {
    const fill = fillFromLookup(
      accepted({ callsign: callsignFromRecord('W5NEW', 'K9OLD') }),
      'student',
    );
    expect(fill.values.callDistrict).toBe('5');
  });

  it('empties the district rather than leaving another licensee’s behind', () => {
    // A callsign the FCC did not issue has no US call district at all — `callDistrictFromCallsign`
    // refuses VE3ABC, whose 3 is Canadian. The answer is an empty field, not the previous one.
    const fill = fillFromLookup(
      accepted({ callsign: { value: 'VE3ABC', origin: 'user' } }),
      'student',
    );
    expect(fill.values.callDistrict).toBe('');
    expect(fill.derived).toEqual(['callDistrict']);
  });

  it('derives nothing on an organisation profile, which has no call district', () => {
    const fill = fillFromLookup(accepted({ type: 'CLUB' }), 'organization');
    expect(fill.derived).toEqual([]);
    expect(fill.values).not.toHaveProperty('callDistrict');
  });

  /**
   * A COORDINATE IS A FIELD OF THIS PROFILE THAT NOTHING CAN MARK, WHICH IS ITS OWN ANSWER.
   *
   * Before this list existed there were two places for it to land and both were false. `unmarked`
   * says "the record either did not state it, or you changed what it said, so it is yours" — about
   * a latitude callook stated to eight decimal places and the applicant never touched. `unfillable`
   * says "not a field this profile has" — about a box the editor renders on both tabs and the
   * matcher reads for radius eligibility.
   */
  it('separates a coordinate the record stated from the values it can attribute', () => {
    const fill = fillFromLookup(
      accepted({
        state: { value: 'MI', origin: 'source' },
        lat: { value: '41.714707', origin: 'source' },
        lon: { value: '-72.728411', origin: 'source' },
      }),
      'student',
    );

    expect(fill.values.lat).toBe('41.714707');
    expect(fill.unmarkable).toEqual(['lat', 'lon']);
    expect(fill.unmarked).toEqual(['callsign']);
    expect(fill.unfillable).toEqual([]);
    // The rule that makes this list necessary: no marker, because the server would strip it.
    expect(fill.fieldSources).not.toHaveProperty('lat');
    expect(fill.fieldSources).not.toHaveProperty('lon');
  });

  it('calls a coordinate the applicant typed over theirs, not the record’s', () => {
    const fill = fillFromLookup(
      accepted({ lat: { value: '42.0', origin: 'user' }, lon: { value: '-71.0', origin: 'source' } }),
      'organization',
    );
    expect(fill.unmarked).toEqual(['callsign', 'lat']);
    expect(fill.unmarkable).toEqual(['lon']);
  });

  /**
   * THE DEFECT THIS MODULE EXISTS FOR. Choosing EXTRA for a record whose class is ADVANCED used to
   * store `licenseClass: { source: 'callook.info', value: 'EXTRA' }` — an attribution to a source
   * that never said it, under a value every downstream eligibility verdict is computed from.
   */
  it('writes a value the user picked, and marks it for nobody', () => {
    const fill = fillFromLookup(
      accepted({
        state: { value: 'MI', origin: 'source' },
        licenseClass: { value: 'EXTRA', origin: 'user' },
      }),
      'student',
    );

    expect(fill.values.licenseClass).toBe('EXTRA');
    expect(fill.fieldSources).not.toHaveProperty('licenseClass');
    expect(fill.unmarked).toContain('licenseClass');
    // ...and the value the source DID state is unaffected: this is per-field, not all-or-nothing.
    expect(fill.fieldSources.state).toEqual({ ...PROVENANCE, value: 'MI' });
  });

  it('marks a callsign the source substituted, which the applicant never typed', () => {
    const fill = fillFromLookup(
      accepted({ callsign: { value: 'W5NEW', origin: 'source' } }),
      'student',
    );

    expect(fill.values.callsign).toBe('W5NEW');
    expect(fill.fieldSources.callsign).toEqual({ ...PROVENANCE, value: 'W5NEW' });
  });

  it('marks a club’s name on an organisation profile', () => {
    const fill = fillFromLookup(
      accepted({
        type: 'CLUB',
        orgName: { value: 'A UNIVERSITY RADIO CLUB', origin: 'source' },
        state: { value: 'MI', origin: 'source' },
      }),
      'organization',
    );

    expect(fill.fieldSources).toEqual({
      orgName: { ...PROVENANCE, value: 'A UNIVERSITY RADIO CLUB' },
      state: { ...PROVENANCE, value: 'MI' },
    });
  });

  it('never mints a marker for a field the schema would strip on save', () => {
    // A licence class has nowhere to go on an organisation profile — `OrgFieldSources` has no such
    // key — so a marker shown here would vanish at the next PUT. A badge that disappears on reload
    // is worse than no badge at all.
    const fill = fillFromLookup(
      accepted({ type: 'CLUB', licenseClass: { value: 'GENERAL', origin: 'source' } }),
      'organization',
    );

    expect(fill.values.licenseClass).toBe('GENERAL');
    expect(fill.fieldSources).not.toHaveProperty('licenseClass');
  });

  /**
   * TWO REASONS FOR "NO MARKER" ARE NOW TWO LISTS.
   *
   * `unmarked` was documented as "the applicant's own values" and computed as "everything that did
   * not get a marker", which is not the same set: a value the SOURCE stated, on a field this
   * profile kind cannot hold, landed there too. The host reads that list to the applicant — "the
   * record either did not state it, or you changed what it said, so it is yours" — and every clause
   * of that sentence is false about a licence class callook.info stated in full for a club profile
   * that has no such field. A list that means two things gets described as one of them.
   */
  it('separates a value this profile cannot hold from a value the applicant stated', () => {
    const fill = fillFromLookup(
      accepted({
        type: 'CLUB',
        state: { value: 'OH', origin: 'user' },
        licenseClass: { value: 'GENERAL', origin: 'source' },
        orgName: { value: 'A UNIVERSITY RADIO CLUB', origin: 'source' },
      }),
      'organization',
    );

    // Theirs: a field this profile has, holding what they typed.
    expect(fill.unmarked).toEqual(['callsign', 'state']);
    // callook.info stated this one in full. What is missing is anywhere on an organisation profile
    // to record that — a different fact, and no longer reported as the same one.
    expect(fill.unfillable).toEqual(['licenseClass']);
    expect(fill.fieldSources).toEqual({
      orgName: { ...PROVENANCE, value: 'A UNIVERSITY RADIO CLUB' },
    });
  });

  /**
   * The structural half, asserted over both kinds: `unmarked` and the marked set are what a host
   * NAMES TO THE APPLICANT as fields of the profile they are looking at, so every key in either has
   * to be one. This is what stops the same defect arriving through a different door — a fifth
   * accepted field, or a panel that forgets a gate.
   */
  it.each(['student', 'organization'] as const)(
    'never puts a field the %s profile does not have among that profile’s own values',
    (kind) => {
      const fill = fillFromLookup(
        accepted({
          type: 'CLUB',
          state: { value: 'MI', origin: 'source' },
          licenseClass: { value: 'GENERAL', origin: 'source' },
          orgName: { value: 'A UNIVERSITY RADIO CLUB', origin: 'source' },
        }),
        kind,
      );
      const fillable = callsignFillableFields(kind);

      for (const key of [...fill.unmarked, ...Object.keys(fill.fieldSources)]) {
        expect(fillable, `${kind} names ${key} as its own`).toContain(key);
      }
      // Vacuity guard: this accepted value carries a field of the OTHER kind either way round.
      expect(fill.unfillable.length, kind).toBeGreaterThan(0);
      for (const key of fill.unfillable) expect(fillable, `${kind}: ${key}`).not.toContain(key);
      /**
       * Every key written is accounted for exactly once, whichever list it lands in — and there
       * are now five lists rather than three. `unmarkable` and `derived` were added on 2026-08-11
       * with the coordinate and the call district, and this sum is what makes a sixth case
       * impossible to add silently: a key that lands in no list, or in two, fails here rather than
       * going unnamed on a confirmation the applicant reads.
       */
      expect(
        [
          ...Object.keys(fill.fieldSources),
          ...fill.unmarked,
          ...fill.unmarkable,
          ...fill.derived,
          ...fill.unfillable,
        ].sort(),
      ).toEqual(Object.keys(fill.values).sort());
    },
  );

  /**
   * The end of the chain, asserted rather than assumed: what this builds has to survive core's own
   * storage rule, and has to READ correctly through the only sanctioned reader.
   */
  it('produces markers that core keeps, and that read as looked-up beside their values', () => {
    const fill = fillFromLookup(
      accepted({
        state: { value: 'MI', origin: 'source' },
        licenseClass: { value: 'EXTRA', origin: 'user' },
      }),
      'student',
    );
    const stored = pruneFieldSources({
      kind: 'student',
      ...fill.values,
      fieldSources: fill.fieldSources,
    } as unknown as StudentProfile) as StudentProfile;

    expect(profileValueOrigin(stored.state, stored.fieldSources?.state)).toBe('looked_up');
    // No marker, so core reads the licence class as the applicant's own assertion — which it is.
    expect(profileValueOrigin(stored.licenseClass, stored.fieldSources?.licenseClass)).toBe('typed');
  });
});
