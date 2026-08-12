import { callDistrictFromCallsign, type LicenseClass, type ProfileFieldSource } from '@grantspotter/core';
import type { CallsignRecord, GeocodedFrom } from '../api/callsign.js';
import {
  callsignFillableFields,
  callsignFillDerivation,
  profileFieldKeys,
  type ProfileFieldKind,
} from './profileFields.js';

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
  /**
   * THE COORDINATE, AND WHY IT IS A PAIR OF ORDINARY {@link AcceptedValue}s RATHER THAN A
   * `GeocodedPoint`.
   *
   * What arrives from the record is a discriminated `MailingGeocode`, and the whole point of that
   * type is that a consumer cannot reach the numbers without finding out whether they are a street
   * address or a post office. That decision belongs to the PANEL, which is where a person can see
   * it being made — see `CallsignLookup.tsx`, which does the narrowing, refuses to pre-fill a
   * mail-drop coordinate, and shows it instead. By the time a value reaches here the decision has
   * been made and a human has accepted it, so what travels is what travels for every other field:
   * a string, and who stated it.
   *
   * They are strings because a `ProfileFieldSource` holds a string and `profileValueOrigin`
   * compares against `String(value)`; the form's drafts are strings too, and `toPayload` is what
   * turns them into numbers. That is also the shape of the problem: `StudentFieldSources` has no
   * key for either, so neither can ever carry a marker — see `unmarkable`.
   */
  lat?: AcceptedValue;
  lon?: AcceptedValue;
  /**
   * WHAT THE RECORD'S COORDINATE IS A GEOCODE OF, CARRIED PAST THE PANEL THE USER PRESSES CLOSE ON.
   *
   * Present whenever the record stated a usable coordinate, whatever the applicant then did with
   * it. The two numbers above are strings by the time they get here and a string cannot say whether
   * it is a post office; this can, and every surface downstream needs it to.
   *
   * IT DID NOT EXIST UNTIL 2026-08-11, AND THE MEASUREMENT THAT PUT IT HERE IS WORTH KEEPING. After
   * accepting W1MX's PO-box coordinate, the note beside Latitude read — byte-identical to the note
   * beside W1AW's street coordinate — "Read from callook.info on …, and carrying no mark, because
   * GrantSpotter cannot record where a coordinate came from." The words "post office" appeared
   * nowhere past the panel: not in the field note, not in the confirmation, not in the live region.
   * The entire PO-box argument lived inside a panel with a Close button on it. A caveat that only
   * exists inside a dismissible panel is not a caveat.
   */
  statedCoordinateFrom?: GeocodedFrom;
  provenance: CallsignProvenance;
}

/**
 * WHAT A FETCHED COORDINATE IS, IN ONE PHRASE, FOR EVERY SURFACE THAT NAMES ONE.
 *
 * Four surfaces say this now — the lookup panel, the acceptance confirmation, the live region and
 * the note beside the field on the editor — and three of them said nothing at all until this
 * existed. One function rather than four strings, for the same reason `profileFieldLabelList` is
 * one function: the applicant reads two of these within a second of each other, and two copies
 * eventually describe one number two ways.
 *
 * Written to slot after a noun ("this coordinate is …", "Latitude holds …"), so every caller gets
 * the same clause in the same grammar.
 */
export function coordinateSubjectPhrase(from: GeocodedFrom): string {
  switch (from) {
    case 'street_address':
      return (
        'callook’s geocode of the street address on the licence — where the licence receives ' +
        'post, which is not necessarily where the station or the antenna is'
      );
    case 'po_box':
      return (
        'callook’s geocode of the PO box on the licence, which makes it a POST OFFICE — not the ' +
        'station, not the antenna and not the campus'
      );
    case 'address_not_stated':
      return (
        'a coordinate this record states with no address beside it at all, so nothing here says ' +
        'what it is a geocode of'
      );
  }
}

/** Two or three words for the same thing, where a whole clause will not fit. */
export function coordinateSubjectLabel(from: GeocodedFrom): string {
  switch (from) {
    case 'street_address':
      return 'a street address';
    case 'po_box':
      return 'a post office';
    case 'address_not_stated':
      return 'an unattributed point';
  }
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
   * A FIELD OF THIS PROFILE, HOLDING WHAT THE RECORD STATED, THAT NOTHING CAN RECORD THAT ABOUT.
   *
   * `lat` and `lon`, today, and only them. The record states a coordinate; this profile has both
   * boxes and the matcher reads both; and core's `StudentFieldSources`/`OrgFieldSources` declare
   * three keys apiece with `z.object`, which strips the rest — so a marker built for `lat` would
   * be dropped by the server on the way in and the badge would vanish on the next reload.
   * `fillFromLookup` refuses to build one for exactly that reason (rule 2), and this list is what
   * that refusal MEANS rather than what it leaves behind.
   *
   * It is not `unmarked`, and the difference is the same one that split `unfillable` out in the
   * first place. `unmarked` means "yours": the record did not state it, or you changed what it
   * said. Every clause of that is false about a coordinate callook stated in full and the
   * applicant accepted untouched — and telling somebody a value is their own assertion when it
   * came from a source is the single misattribution this module exists to prevent, pointed the
   * other way.
   */
  unmarkable: string[];
  /**
   * Keys GrantSpotter COMPUTED from another field of this same profile, rather than read anywhere.
   *
   * `callDistrict` from `callsign`, and nothing else today. It is in `values` like any other write
   * and it is deliberately in no other list: crediting callook.info for the digit in a callsign
   * would credit a source for this tool's own arithmetic (core says exactly that in
   * `StudentFieldSources`), and calling it the applicant's own would credit them for it instead.
   * A host names these separately, and — because the input they are computed from is on the same
   * form — recomputes them when it changes.
   */
  derived: string[];
  /**
   * The keys written that this profile kind has no field for at all — whoever stated them.
   *
   * A licence class handed to an organisation profile, an organisation name handed to a student's.
   * Both panels gate those at source, and this is what makes the gate checkable rather than merely
   * present — a host that says anything about these keys has to say something true about a field
   * the applicant is not looking at, which is the sentence `acceptedFrame` writes for them.
   *
   * THE TEST IS `profileFieldKeys`, NOT `callsignFillableFields`, SINCE 2026-08-11. It was the
   * latter, which made this the complement of everything else — so `lat`, a field the organisation
   * and student editors both render, would have been announced to the applicant as "not a field
   * this profile has" the moment a coordinate was accepted. The two questions are "can this
   * profile hold it" and "can this profile record where it came from", and only the first belongs
   * here.
   */
  unfillable: string[];
  /**
   * What the coordinate in {@link unmarkable} is a geocode of, or `undefined` when no coordinate
   * the record stated was accepted.
   *
   * Set only alongside a non-empty `unmarkable`, which is the same condition as "a number the
   * RECORD stated went into a box this profile cannot mark". A coordinate the applicant typed
   * themselves lands in `unmarked` and gets none of this: nothing was geocoded from anything, and
   * telling somebody their own measurement is a post office would be the misattribution this
   * module exists to prevent, wearing the newest hat.
   */
  coordinateFrom?: GeocodedFrom;
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
  if (accepted.lat !== undefined) out.push(['lat', accepted.lat]);
  if (accepted.lon !== undefined) out.push(['lon', accepted.lon]);
  return out;
}

/**
 * WHAT FOLLOWS FROM A VALUE ALREADY IN THE FORM, recomputed from scratch every time.
 *
 * One derivation exists: the call district is the digit in the callsign, and `evaluateGeo` in core
 * does the identical sum when the field is empty, so this fills in a box the matcher could already
 * answer for itself. It is here rather than in the lookup panel because a hand-typed callsign has
 * to derive it too — the arithmetic is a property of the CALLSIGN, not of a record having been
 * fetched.
 *
 * Returned as a whole map from a whole map, never patched in place, and that is the same device as
 * `profileValueOrigin`: there is no flag to clear and nothing to remember. The answer for "W1AW"
 * is `1` and the answer for "" is `''`, so the caller that hands over a cleared callsign gets a
 * cleared district back and a stale digit cannot survive. `undefined` for a callsign the FCC did
 * not issue (`callDistrictFromCallsign` refuses `VE3ABC`, whose 3 is not a US call district) comes
 * back as `''` for the same reason: the previous callsign's district is not this one's.
 */
export function derivedProfileValues(
  kind: ProfileFieldKind,
  values: { callsign?: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  /**
   * OWNERSHIP FIRST, THEN THE RULE — and in that order for a reason that has bitten this file
   * before. `callsignFillDerivation` reads the registry through `lookup`, which FALLS THROUGH to
   * the other profile kind by design: it answers "where does this field live and what is it
   * called", which has the same answer whoever asks. Asked alone it therefore hands an
   * organisation profile the student entry for `callDistrict` and this would have written a call
   * district into a draft that has no such field, which `toPayload` would then post and the server
   * would strip. `profileFieldKeys` is the predicate that answers "is this field MINE", the same
   * split `fillFromLookup` makes one function down.
   */
  if (!profileFieldKeys(kind).includes('callDistrict')) return out;
  const derivation = callsignFillDerivation('callDistrict', kind);
  if (derivation?.from === 'callsign') {
    out.callDistrict = callDistrictFromCallsign(values.callsign ?? '') ?? '';
  }
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
  const onThisProfile = new Set(profileFieldKeys(kind));
  const values: Record<string, string> = {};
  const fieldSources: Record<string, ProfileFieldSource> = {};
  const unmarked: string[] = [];
  const unmarkable: string[] = [];
  const unfillable: string[] = [];

  for (const [key, entry] of acceptedValues(accepted)) {
    values[key] = entry.value;
    // THREE INDEPENDENT QUESTIONS, ASKED IN THIS ORDER, AND NEVER COLLAPSED INTO ONE CONDITION.
    // "Does this profile have the field", "can it record where the value came from", and "did the
    // record state it" have three different answers and three different sentences, and every time
    // two of them have been folded together this module has told somebody something false about
    // their own form. Asking them separately is what makes each list mean exactly one thing.
    if (!onThisProfile.has(key)) {
      unfillable.push(key);
      continue;
    }
    if (!fillable.has(key)) {
      // The profile has the box and nothing can mark it. A value the applicant edited inside the
      // panel is still theirs, though, and saying "the record stated this" about it would be the
      // original defect wearing a new list — so origin still decides which sentence they get.
      if (entry.origin === 'source') unmarkable.push(key);
      else unmarked.push(key);
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

  // LAST, AND FROM THE ACCEPTED CALLSIGN RATHER THAN FROM THE FORM. The district that follows from
  // this record is the district of the callsign this record is FOR — which is not always the one
  // the applicant typed, because callook answers a superseded callsign with the current record.
  const derived: string[] = [];
  for (const [key, value] of Object.entries(derivedProfileValues(kind, { callsign: values.callsign }))) {
    values[key] = value;
    derived.push(key);
  }

  // The subject travels exactly as far as the number it describes does, and no further: it is
  // attached where a value the RECORD stated landed in a box nothing can mark, which is the only
  // case in which any surface has something to explain.
  const coordinateFrom =
    unmarkable.length > 0 && accepted.statedCoordinateFrom !== undefined
      ? { coordinateFrom: accepted.statedCoordinateFrom }
      : {};

  return { values, fieldSources, unmarked, unmarkable, derived, unfillable, ...coordinateFrom };
}
