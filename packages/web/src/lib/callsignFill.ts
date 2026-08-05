import type { LicenseClass, ProfileFieldSource } from '@grantspotter/core';
import type { CallsignRecord } from '../api/callsign.js';
import { callsignFillableFields, type ProfileFieldKind } from './profileFields.js';

/**
 * WHAT LEAVES THE CALLSIGN LOOKUP PANEL, AND WHO SAID EACH PART OF IT.
 *
 * The lookup panel is the only control in this product that puts a value about the USER on screen
 * without asking them for it — and it is also an EDITOR: the record arrives beside inputs the user
 * can change, because the alternative is a tool that fills a form with somebody else's state and
 * a licence class the FCC never granted. Those two facts together are the whole reason this module
 * exists. A value can leave that panel having come from the record, or from the person reading it,
 * and the two must not arrive at the host looking the same.
 *
 * They did. Every accepted value used to be a bare string carrying one shared `provenance`, and
 * both hosts (the profile editor and the first-run screen) stamped that provenance onto every
 * field they wrote. So choosing EXTRA for a record whose class is ADVANCED — which is exactly what
 * the panel ASKS the user to do, because the three legacy classes map onto none of GrantSpotter's
 * four — stored `fieldSources.licenseClass = { source: 'callook.info', value: 'EXTRA' }`. callook
 * never said EXTRA. Measured on 2026-08-04 over the 143-record publishable seed corpus, for an
 * applicant holding only that callsign and state, the falsely attributed class moves 76 matcher
 * verdicts, 13 of them onto a hard `{ kind: 'eligible' }`, and every one of them then rests on a
 * licence class the cited source never stated. Eligibility computed from a value nobody asserted,
 * presented as a value somebody did, is the single failure this product exists to prevent.
 *
 * The fix is structural rather than careful: a value travels WITH its origin, and
 * {@link fillFromLookup} — the only place in this product that builds a `ProfileFieldSource` — can
 * only mark a value whose origin is `'source'`. A host cannot mislabel what it never labels.
 */

/** Where a filled-in value came from, carried to the host so the field can say so. */
export interface CallsignProvenance {
  /**
   * The source's own name, as the record reports it. Typed as the record's literal rather than
   * as a string so a host can put it straight into core's `ProfileFieldSource`, whose `source`
   * is that same literal — a widened type here would need a cast there, and a cast is where a
   * second source would one day be mislabelled as this one.
   */
  source: CallsignRecord['source'];
  /** ISO instant the record was fetched. */
  fetchedAt: string;
  /** The FCC's own page for this record, so the user can check us. */
  ulsUrl?: string;
}

/**
 * WHO STATED THIS VALUE.
 *
 * `'source'` means the record itself returned exactly this and the user left it alone. `'user'`
 * means the person typed it, picked it from a select, or had already supplied it — their own
 * assertion, which is the strongest thing this tool ever holds and the one thing it must never
 * attribute to somebody else.
 */
export type ValueOrigin = 'source' | 'user';

export interface AcceptedValue<T extends string = string> {
  value: T;
  origin: ValueOrigin;
}

/**
 * What the user accepted. Only fields the profile actually stores appear here: there is no
 * street, no licensee name for a person, and no `licensedSince`.
 */
export interface AcceptedCallsign {
  /**
   * The callsign the RECORD is for, which is not always the one that was asked about — see
   * {@link callsignFromRecord}.
   */
  callsign: AcceptedValue;
  /**
   * Whether the licence is a person's or a club station's. The host needs it because the two
   * belong on different profiles, and a collegiate club station — the shape this product's
   * primary audience holds — is a CLUB. Not an {@link AcceptedValue}: it is never written into a
   * profile field, it decides WHICH profile the values land on.
   */
  type: CallsignRecord['type'];
  state?: AcceptedValue;
  licenseClass?: AcceptedValue<LicenseClass>;
  /** Club stations only, and only where the host has somewhere to put an organisation name. */
  orgName?: AcceptedValue;
  provenance: CallsignProvenance;
}

/**
 * A panel value labelled by COMPARISON with what the record returned — never by tracking whether
 * the user touched the input.
 *
 * The same device as `profileValueOrigin` one layer down: a flag set by an `onChange` has to be
 * maintained by every path that writes the value, and the path that forgets is the one that
 * mislabels. Equality needs nobody to remember anything. It also gets the legacy-licence-class
 * case right for free: `record.operClass` is `undefined` for ADVANCED, NOVICE and TECHNICIAN PLUS,
 * and `undefined` equals nothing, so whatever the user picks is theirs.
 *
 * A user who edits a value and then edits it back to what the record said is labelled `'source'`,
 * and that is correct: the marker's claim is "callook.info returned this", which is true of that
 * string however the input arrived at it.
 */
export function fromSource<T extends string>(
  stated: T | undefined,
  current: T,
): AcceptedValue<T> {
  return { value: current, origin: stated !== undefined && stated === current ? 'source' : 'user' };
}

/**
 * The callsign the record is for, labelled against the callsign the user ASKED about.
 *
 * Inverted from {@link fromSource}, and deliberately: the callsign is the question, so a record
 * that answers with the same one has told the user nothing they did not already state. It becomes
 * the source's answer only when it DIFFERS — callook answers a lookup of a superseded callsign
 * with the licensee's current record, so "K9OLD" can come back as "W5NEW" — and that is precisely
 * the case where the field must not read like something the applicant typed.
 */
export function callsignFromRecord(recordCallsign: string, typed: string): AcceptedValue {
  return { value: recordCallsign, origin: recordCallsign === typed ? 'user' : 'source' };
}

export interface CallsignFill {
  /** Profile field key → the value to write. Every accepted value, whoever stated it. */
  values: Record<string, string>;
  /**
   * Profile field key → marker, for the values the SOURCE stated and only those.
   *
   * THE COMPLETE SET, to REPLACE what a host is holding rather than to merge into it. Every marker
   * a profile can hold names one licensee — the holder of the callsign that was looked up — so the
   * set that describes this profile after accepting a record is exactly the set this record
   * stated. Merging keeps the previous licensee's answers alive under the new one: accept a second
   * record with an address callook could not parse and a legacy operator class, and the first
   * licensee's `MI` and `GENERAL` stay in the form still marked as read from callook.info, which
   * is two people's facts on one profile.
   */
  fieldSources: Record<string, ProfileFieldSource>;
  /**
   * THE APPLICANT'S OWN VALUES, and nothing else — a field of THIS profile that a lookup may fill,
   * written with no marker because the person rather than the record stated what is in it.
   *
   * A host uses this to say so — see `acceptedFrame` in `components/CallsignLookup.tsx`, which
   * builds the confirmation sentence from this list and from `fieldSources` so that "filled in
   * from the FCC record" cannot be printed over a set of values the record stated none of.
   *
   * IT MEANT TWO THINGS UNTIL 2026-08-04, AND THAT IS WHY {@link unfillable} NOW EXISTS. Every key
   * that did not get a marker landed here, for either of two unrelated reasons: the value was the
   * applicant's, or the value was the SOURCE'S and this profile kind has nowhere to record that. The
   * doc comment said the first; the code did both. So an organisation confirmation could read
   * "License class carries no mark: the record either did not state it, or you changed what it
   * said, so it is yours" — about a value callook.info had stated in full, on a field an
   * organisation profile does not have, that the applicant had never seen. A list that means two
   * things gets described as one of them, and the description is wrong half the time.
   */
  unmarked: string[];
  /**
   * The keys written that this profile kind has no fillable field for — whoever stated them.
   *
   * `callsignFillableFields` is the test, so this is exactly the complement of the marked and
   * unmarked sets: a licence class handed to an organisation profile, an organisation name handed
   * to a student's. Both panels gate those at source, and this is what makes the gate checkable
   * rather than merely present — a host that says anything about these keys has to say something
   * true about a field the applicant is not looking at, which is the sentence
   * `acceptedFrame` writes for them.
   */
  unfillable: string[];
}

/**
 * Every accepted value, in the order a host writes them. Written out rather than derived from
 * `Object.entries`, so a new accepted field is a deliberate line here rather than something that
 * silently starts (or stops) being marked.
 */
function acceptedValues(accepted: AcceptedCallsign): Array<[string, AcceptedValue]> {
  const out: Array<[string, AcceptedValue]> = [['callsign', accepted.callsign]];
  if (accepted.state !== undefined) out.push(['state', accepted.state]);
  if (accepted.licenseClass !== undefined) out.push(['licenseClass', accepted.licenseClass]);
  if (accepted.orgName !== undefined) out.push(['orgName', accepted.orgName]);
  return out;
}

/**
 * THE ONLY PLACE IN THIS PRODUCT THAT BUILDS A `ProfileFieldSource`.
 *
 * Two rules, and neither is left to a caller:
 *   1. a marker is built only for a value whose origin is `'source'` — what the user picked or
 *      typed is theirs, whether they typed it on the form or in the panel beside the record;
 *   2. a marker is built only for a field `callsignFillableFields` says can hold one, which is
 *      asserted against core's zod mirrors — a marker the schema would strip on save is a badge
 *      that shows on screen and vanishes on reload, which is worse than no badge at all.
 *
 * Both hosts call this. They used to build markers themselves, in two places, with the same
 * mistake in each.
 */
export function fillFromLookup(accepted: AcceptedCallsign, kind: ProfileFieldKind): CallsignFill {
  const fillable = new Set(callsignFillableFields(kind));
  const values: Record<string, string> = {};
  const fieldSources: Record<string, ProfileFieldSource> = {};
  const unmarked: string[] = [];
  const unfillable: string[] = [];

  for (const [key, entry] of acceptedValues(accepted)) {
    values[key] = entry.value;
    // WHOSE PROFILE THE FIELD IS ON IS ASKED FIRST, AND ORIGIN ONLY AFTER. The two questions are
    // independent — "did the record state this" and "can this profile hold it" — and asking them in
    // one condition is what collapsed them into a single answer. Splitting them here is what makes
    // `unmarked` a set of THIS profile's fields by construction, so a host naming them to the
    // applicant cannot name a field of the other kind.
    if (!fillable.has(key)) {
      unfillable.push(key);
      continue;
    }
    if (entry.origin !== 'source') {
      unmarked.push(key);
      continue;
    }
    fieldSources[key] = {
      source: accepted.provenance.source,
      fetchedAt: accepted.provenance.fetchedAt,
      value: entry.value,
    };
  }

  return { values, fieldSources, unmarked, unfillable };
}
