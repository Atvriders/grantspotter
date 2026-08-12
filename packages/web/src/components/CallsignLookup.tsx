import { useId, useState, type ReactNode } from 'react';
import { checkCoordinateAgainstLocator, type LicenseClass } from '@grantspotter/core';
import { ApiError } from '../api/client.js';
import {
  postCallsignLookup,
  type CallsignLookupResult,
  type CallsignRecord,
  type GeocodedFrom,
  type GeocodedPoint,
} from '../api/callsign.js';
import { humanRetryAfter, retryAfterSecOf } from '../lib/retryAfter.js';
import {
  callsignFromRecord,
  coordinateSubjectLabel,
  coordinateSubjectPhrase,
  fillFromLookup,
  fromSource,
  type AcceptedCallsign,
} from '../lib/callsignFill.js';
import { profileFieldLabel, profileFieldLabelList } from '../lib/profileFields.js';
import { formatDate } from '../lib/trust.js';
import './callsign.css';

/**
 * "LOOK UP MY CALLSIGN", AND THE RECORD IT PUTS ON SCREEN.
 *
 * One control, used beside the callsign field on the profile editor. IT SAID "AND ON THE FIRST-RUN
 * SETUP SCREEN" UNTIL 2026-08-12, and that had not been true for a while: `Profile.tsx:1060` is the
 * only render site in this repository and `FirstRun.tsx` mentions neither this component nor its
 * module. This is the same stale sentence the README was corrected of at its lines 272 and 337,
 * left standing in the file the README was describing — so it is worth saying why it matters
 * rather than just deleting it. A host that does not exist is a host nobody tests, and every prop
 * and paragraph written for it (a setup-token credential, a "no saved profile behind us" caveat)
 * is dead weight that reads as a live requirement to the next person.
 *
 * It is the only place in this product where a value about the USER arrives from somewhere other
 * than the user, so the rules it keeps are the whole point of it:
 *
 *  1. NOTHING IS FILLED IN UNTIL THE PERSON SAYS SO. The panel shows what was found and
 *     waits. There is no auto-fill on success.
 *  2. WHAT THE SOURCE SAID LOOKS LIKE WHAT THE SOURCE SAID, AND NOTHING ELSE DOES. Every
 *     value leaves here labelled with WHO STATED IT (`AcceptedValue.origin`), computed by
 *     comparing what is in the input against what the record returned. This panel is an
 *     editor as well as a report — rule 5 below exists to make the user change a value — so
 *     a single shared "this came from callook.info" stamped over everything that leaves is
 *     a lie about whichever field they just edited. `fillFromLookup` marks only the values
 *     labelled `'source'`; the rest are the applicant's own, exactly as if typed on the form.
 *  3. A RECORD FOR A DIFFERENT CALLSIGN IS SAID OUT LOUD, AND ON SCREEN AND IN THE LIVE
 *     REGION ALIKE. callook answers a superseded callsign with the licensee's CURRENT
 *     record, so asking about K9OLD can return W5NEW — usually the same operator, and never
 *     a value to swap in under the person who typed the other one. The panel names both
 *     callsigns and will not hand the record over until the user confirms it is theirs.
 *  4. IT SHOWS THE ADDRESS AND STORES NONE OF IT. The street is how a person recognises
 *     their own record; it is not persisted, there is no column for it, and nothing reads
 *     it. Only the state leaves this panel, because eligibility rules use the state.
 *  5. IT NEVER GUESSES A LICENCE CLASS. An operator class that maps exactly onto core's
 *     four arrives mapped. Advanced, Novice and Technician Plus map onto none of them, so
 *     the select opens UNSET and says why. Guessing upward manufactures a false ELIGIBLE,
 *     which is the one mistake this product refuses to make.
 *  6. IT NEVER FILLS "LICENSED SINCE". The record's grant date resets on every renewal and
 *     every vanity change, so it is not the date the licence was first held — and
 *     `licensedSince` feeds `heldMonthsMin` in the matcher, where a wrong value becomes a
 *     confident, wrong eligibility verdict. The date is shown, labelled for what it is,
 *     and goes no further.
 *  7. IT NEVER PUTS A COORDINATE IN A BOX. Every successful lookup carries a latitude, a
 *     longitude and a grid square, and every one of them is callook's geocode of the licensee's
 *     MAILING ADDRESS — a post office where that address is a PO box, which is what two of the
 *     three real captures are, both of them collegiate clubs. The boxes open EMPTY on every arm,
 *     the coordinate is shown for what it is, and putting it in takes a second, separate press.
 *     The reasoning is the same as rule 5's and rule 6's, and so is the shape: a value from a
 *     source that can decide a verdict, and that this profile can never afterwards attribute to
 *     anybody, is not one the software chooses. See {@link describeGeocode}, which is where that
 *     decision and the measurement behind it are written down.
 *  8. IT SAYS WHAT IT IS ABOUT TO REPLACE. This panel opens on the RECORD's values, and the form
 *     behind it may already hold the applicant's own — a state they typed, a coordinate they
 *     measured on the campus rather than at the post office. Accepting overwrites them. Until
 *     2026-08-11 it did so silently and the word "replace" appeared nowhere on the screen; the
 *     codebase had already decided what an ERASURE owes the reader (`applyLookup` announces one),
 *     and a replacement owes them the same sentence.
 */

export type CallsignTarget = 'student' | 'organization';

/**
 * WHAT THE FORM BEHIND THIS PANEL ALREADY HOLDS, so the panel can say what accepting would cost.
 *
 * Keyed by profile field, and every one of them a string, because that is what the editor's drafts
 * are and comparing anything else would need a second notion of equality. Absent or empty means
 * the applicant has not answered that field, which is the common case and the one with nothing to
 * warn about.
 *
 * OPTIONAL, because a host may genuinely have nothing behind the panel — and NOT, as this said
 * until 2026-08-12, because "the first-run screen this component is also written for has no saved
 * profile behind it". There is no such screen; see the header. `Profile.tsx` is the only host and
 * it always passes this, reading it off the OPEN DRAFT rather than off the saved profile, so an
 * absent `held` today means a caller that has not been written yet rather than a form known to be
 * empty. The panel says nothing about replacement in that case, which is the safe way to be wrong.
 */
export interface HeldProfileValues {
  state?: string;
  licenseClass?: string;
  orgName?: string;
  lat?: string;
  lon?: string;
}

export interface CallsignLookupProps {
  /** The callsign currently typed in the field this control sits beside. */
  callsign: string;
  /** What the form behind this panel already holds. See {@link HeldProfileValues}. */
  held?: HeldProfileValues;
  /**
   * Which profile the accepted values would land on. It decides which fields this panel
   * offers: an organisation profile has no licence class, and a person has no orgName.
   */
  target: CallsignTarget;
  onAccept: (values: AcceptedCallsign) => void;
  /*
   * `setupToken?: string` WAS HERE AND IS GONE (2026-08-12). It was the one-time first-run token,
   * passed down so a caller with no session could still look a callsign up, and the server retired
   * that privilege on 2026-08-11. The request type it fed carries the measurement: a body with the
   * key is now a 422 `unrecognized_keys`, the same body without it is a 200. See
   * `api/callsign.ts`'s `CallsignLookupRequest`.
   */
  /**
   * What this host can and cannot do with a CLUB record. It differs per host — the profile editor
   * has an organisation tab to send the user to, and a host without one has something else to say
   * — so the host supplies the sentence rather than this component guessing at it. (It read "the
   * setup screen does not" until 2026-08-12, naming a screen that does not render this panel; the
   * argument for the prop is unchanged, and it is now stated without an example that is not real.)
   */
  clubNotice?: ReactNode;
}

const LICENSE_OPTIONS: { value: LicenseClass; label: string }[] = [
  { value: 'NONE', label: 'None — not licensed' },
  { value: 'TECH', label: 'Technician' },
  { value: 'GENERAL', label: 'General' },
  { value: 'EXTRA', label: 'Amateur Extra' },
];

const LICENSE_VALUES = new Set<string>(LICENSE_OPTIONS.map((option) => option.value));

function isLicenseClass(value: string): value is LicenseClass {
  return LICENSE_VALUES.has(value);
}

/**
 * WHAT THIS PANEL CAN RENDER, which is what the server can answer with.
 *
 * This read `CallsignLookupResult['status'] | 'malformed'` until 2026-08-11, and the widening was
 * a mirror's lag written down as a workaround: `api/callsign.ts` restates
 * `packages/server/src/callsign/types.ts` by hand — web may not import from server — and it had
 * not been updated when `malformed` was added on 2026-08-09. So this file had the copy for a
 * status the type system said could not arrive, and the compensation lived here, where nothing
 * would ever prompt anyone to remove it. The mirror is correct now and `api/callsign.test.ts`
 * compares the two declarations, so this is once again just the alias.
 *
 * `KNOWN_STATUSES` below stays, and is a different guard entirely: the wire is not the type, and a
 * proxy or a captive portal can answer 200 with anything at all.
 */
type LookupStatus = CallsignLookupResult['status'];

/**
 * The six statuses, as a runtime set. The type says a response can only be one of these; the
 * wire does not, and this app is served behind a tunnel where a proxy or a captive portal can
 * answer 200 with something else entirely (see `apiFetch`'s non-JSON guard, which is the same
 * defence one layer down). An unrecognised status must not reach `frameFor`, whose exhaustive
 * switch would hand back `undefined` and blank the screen.
 */
const KNOWN_STATUSES: ReadonlySet<string> = new Set<LookupStatus>([
  'found',
  'not_found',
  'not_us',
  'malformed',
  'updating',
  'unavailable',
]);

/**
 * IS THIS A LOOKUP RESULT AT ALL — asked of the whole answer, before anything reads a field off it.
 *
 * `KNOWN_STATUSES.has(result.status)` was the guard, and it assumes the thing it is reading
 * `status` from is an object. A 200 whose body is `null` is not, and `apiFetch` resolves that body
 * as `null` deliberately (see its docblock: a deliberate `null` payload means "asked, answered,
 * nothing there", which is a different event from a body that would not parse). The read threw,
 * and the throw was caught by the network handler around it and reported as an unreachable API —
 * measured in Chromium on 2026-08-12; see {@link CallsignLookup.run}. A 204, which `apiFetch`
 * resolves as `undefined`, is the same shape of answer.
 */
function isLookupResult(value: unknown): value is CallsignLookupResult {
  if (typeof value !== 'object' || value === null) return false;
  const status: unknown = (value as { status?: unknown }).status;
  return typeof status === 'string' && KNOWN_STATUSES.has(status);
}

/**
 * A primitive the wire sent where an object belonged, quoted and capped.
 *
 * THE QUOTATION MARKS ARE LOAD-BEARING and were added on 2026-08-12. `JSON.stringify(null)` is the
 * five characters `null`, and this sentence used to read "the body was null" — a paragraph in
 * which the JavaScript name of nothing appears as an ordinary word. That is the one place in this
 * product where printing that word is honest, because it is naming what arrived rather than
 * failing to name something; every other occurrence of it on a screen is the "FCC record for
 * undefined" defect. Curly quotes are how the reader, and `packages/web/src/test/setup.ts`'s
 * after-every-test sweep for rendered holes, can tell the two apart. A JSON string already carries
 * its own quotes and is not double-wrapped.
 */
function quotedBody(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return 'a value with no JSON form at all';
  const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return shown.startsWith('"') ? shown : `“${shown}”`;
}

/**
 * WHAT ARRIVED INSTEAD OF A LOOKUP RESULT, SAID IN THE ANSWER'S OWN TERMS.
 *
 * Two things reach here and they are not the same event: a body that is not an object at all (a
 * `null` payload, a 204's empty answer, a bare string or number) and an object carrying a status
 * this build cannot read. Both are reported as "the API answered, and not with a lookup result",
 * because both are true of that and neither is true of "the API could not be reached" — which is
 * what the first of them said until 2026-08-12.
 */
function unusableAnswerNote(answer: unknown): string {
  const what =
    answer === undefined
      ? 'no body arrived with it at all'
      : typeof answer !== 'object' || answer === null
        ? `the body was ${quotedBody(answer)}`
        : 'it carries no status this build can read' +
          quotedArm((answer as { status?: unknown }).status);
  return (
    'The API answered with something that is not a lookup result — ' +
    `${what} — so nothing is being reported about this callsign. Something other than ` +
    'GrantSpotter — a proxy, tunnel, or sign-in page — may have answered instead, and a browser ' +
    'running an older version of GrantSpotter than the server it is talking to looks the same ' +
    'from here. Nothing on this form was changed.'
  );
}

/**
 * THE SAME GUARD, ON THE TWO FIELDS THIS ROUND PUT ON THE WIRE — because the argument for
 * `KNOWN_STATUSES` was never about statuses.
 *
 * It is about `api/callsign.ts` being a HAND COPY of a type on the other side of a process
 * boundary, about this app being served behind a tunnel, and about a 200 being answerable by a
 * proxy, a stale build or a captive portal with anything at all. `mailingGeocode` and
 * `geocodeRefusal` arrived on 2026-08-11 with no such guard, and both were narrowed by an
 * exhaustive `switch` whose `undefined` fall-through is not a blank sentence but a THROW.
 *
 * Measured on 2026-08-12 in Chromium against the real SPA on a real server: a profile with
 * Latitude 42.3601, Longitude -71.0942 and a Field of study typed in and NOT saved, answered with
 * `{"geocodedFrom":"street_and_po_box", …}`, gave `TypeError: Cannot read properties of undefined
 * (reading 'latitude')`, `document.body.innerText.length === 0` and `document.querySelectorAll(
 * 'input').length === 0`. The whole application, and every unsaved answer in it, destroyed by one
 * field of one record. Nobody has to be attacking: a browser holding yesterday's bundle against an
 * upgraded server is enough, and `callook.ts` openly contemplates a fourth arm for a K2CC-style
 * line carrying a street AND a box.
 *
 * The rule this file follows, therefore: WHATEVER THE WIRE NARROWS ON IS CHECKED AGAINST A RUNTIME
 * SET BEFORE THE SWITCH SEES IT, and whatever the switch then reaches is checked for the shape it
 * is declared to have. An unrecognised arm becomes a sentence saying so, which is what the reader
 * is owed and is also all that can honestly be said.
 */
const KNOWN_GEOCODED_FROM: ReadonlySet<string> = new Set<GeocodedFrom>([
  'street_address',
  'po_box',
  'address_not_stated',
]);

/**
 * The evidence each refusal arm is DECLARED to carry, so a body that omits a field cannot render a
 * sentence with a hole in it.
 *
 * `satisfies` is what keeps this honest: adding an arm to `GeocodeRefusal` in `api/callsign.ts`
 * fails to compile here until its evidence is written down, exactly as `frameFor`'s switch fails
 * for a new status. The MAP is what is exported to the runtime, because `Record` lookup on a key
 * that is not in the type is `undefined` while tsc goes on believing it is a `string[]` — which is
 * the same class of lie this whole block exists to stop.
 */
const REFUSAL_EVIDENCE: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    contradicted: ['gridsquare', 'containingLocator'],
    unreadable_locator: ['gridsquare', 'because'],
    locator_too_coarse: ['gridsquare'],
    placeholder: [],
    incomplete: [],
  } satisfies Record<NonNullable<CallsignRecord['geocodeRefusal']>['refused'], readonly string[]>),
);

/**
 * THE SAME GUARD AGAIN, ON THE FIELDS THE WHOLE PANEL IS ABOUT.
 *
 * `KNOWN_STATUSES` and `KNOWN_GEOCODED_FROM` above check what the wire says a thing IS. This
 * checks the four facts every sentence on this panel is built out of, and it exists because they
 * were the ones nobody was checking. Measured in Chromium on 2026-08-12 against the built server,
 * `{"status":"found","record":{"source":"callook.info"}}`:
 *
 *   heading                "FCC record for undefined"
 *   live region            "FCC record for undefined: undefined. This record is for undefined,
 *                           not the W1AW you asked about."
 *   the word "undefined"   4 times on screen
 *   the source line        "Read from callook.info on —"
 *   and a checkbox reading "Yes, this record is mine — use  in place of W1AW."
 *
 * The third line is the serious one. The substitution warning is the most safety-critical claim
 * this component makes — it is the sentence that tells somebody a record is NOT the one they asked
 * about, and it is what the confirm checkbox exists to gate — and it was FABRICATED over a record
 * that stated no callsign at all, because `undefined !== 'W1AW'`. A record with no callsign is not
 * a different licensee's record; it is not a record.
 *
 * So a record is read the way `readPoint` reads a point: all of it, or none of it. The four facts
 * required are the ones with no honest substitute — WHO the licence belongs to (`callsign`,
 * `name`), WHICH KIND of licensee that is (`type`, which decides the profile the values land on
 * and prints "Club station" or "Individual"), and WHERE AND WHEN GrantSpotter read it (`source`,
 * `fetchedAt`, the provenance every accepted value carries). Everything this panel omits when
 * absent — an address, a grant date, an FRN — is already conditional below.
 */
const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set<CallsignRecord['type']>([
  'PERSON',
  'CLUB',
]);

/** A `CallsignRecord` stating the four facts every sentence here needs, or `undefined`. */
function readRecord(value: unknown): CallsignRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<CallsignRecord>;
  const stated = (field: unknown): boolean => typeof field === 'string' && field.trim() !== '';
  if (!stated(candidate.callsign) || !stated(candidate.name)) return undefined;
  if (typeof candidate.type !== 'string' || !KNOWN_RECORD_TYPES.has(candidate.type)) {
    return undefined;
  }
  if (!stated(candidate.source) || !stated(candidate.fetchedAt)) return undefined;
  return value as CallsignRecord;
}

/**
 * WHY THERE IS NO RECORD ON SCREEN WHEN THE ANSWER SAID ONE WAS FOUND.
 *
 * The frame around this is `unavailable`'s — "it may have answered with something GrantSpotter
 * could not use" — which is exactly what happened, and this is the sentence that says which part
 * could not be used. Same shape as {@link unreadableGeocodeNote} one layer down, and same reason:
 * rendering nothing would leave a reader who watched a lookup succeed with no account of where the
 * record went.
 */
function unusableRecordNote(): string {
  return (
    'The answer said a record was found, and what arrived is not one this page can read. A licence ' +
    'record has to name the callsign it is for, the licensee, whether the licence is a person’s or ' +
    'a club station’s, and where and when GrantSpotter read it; this one did not state all of ' +
    'that. Nothing from it is shown, because a panel built out of a record that does not say whose ' +
    'it is would be telling you about somebody nobody named. The usual cause is a browser holding ' +
    'an older version of GrantSpotter than the server it is talking to: reload the page. Nothing ' +
    'on this form was changed, and nothing here is required — fill it in yourself if you prefer.'
  );
}

/** A `GeocodedPoint` as declared, or `undefined` — the three parts, or nothing at all. */
function readPoint(value: unknown): GeocodedPoint | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { latitude, longitude, gridsquare } = value as Partial<GeocodedPoint>;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return undefined;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return undefined;
  if (typeof gridsquare !== 'string' || gridsquare.trim() === '') return undefined;
  return { latitude, longitude, gridsquare };
}

/**
 * Whatever the wire called something this build does not know, quoted, or nothing.
 *
 * Quoted with `JSON.stringify` for the reason `unreadable_locator` quotes its grid square: the
 * value is the one piece of evidence about what went wrong, and an unquoted one is indistinguishable
 * from the sentence around it. Non-strings are not printed at all — an object rendered into a
 * paragraph as `[object Object]` tells the reader nothing and looks like a fault in the page.
 */
function quotedArm(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? ` (${JSON.stringify(value)})` : '';
}

/**
 * What the values that just left this panel were attributed to — the two lists `fillFromLookup`
 * splits them into, kept so the confirmation can be built from them.
 */
interface Attribution {
  /** Profile fields carrying callook.info's name, because the record itself stated them. */
  marked: string[];
  /** Profile fields written with no mark at all: the applicant's own, however they got there. */
  unmarked: string[];
  /**
   * Profile fields the RECORD and the APPLICANT both stated, identically — the callsign of an
   * ordinary lookup, which is the question asked and the answer given in the same characters.
   *
   * Named separately for the reason `unmarkable` is: it carries no mark, and neither of
   * `unmarked`'s two reasons is why. See `fillFromLookup`'s `restated`.
   */
  restated: string[];
  /**
   * Fields the record stated that this profile cannot record a source for — the coordinate. Named
   * separately because the sentence they need is neither of the other two: "callook.info said this
   * and nothing here can go on saying so" is not "it is yours", and it is not "it is marked".
   */
  unmarkable: string[];
  /** Fields GrantSpotter computed from another field it just wrote. Nobody stated these. */
  derived: string[];
  /**
   * Keys written that this profile has no field for at all — a licence class on an organisation, an
   * organisation name on a person. The panel gates both, so this is normally empty; it is carried
   * anyway because the alternative is what happened before, which is that such a key was quietly
   * counted as one of the applicant's own and named to them as a field of the profile they are on.
   */
  unfillable: string[];
  /**
   * What the coordinate in `unmarkable` is a geocode of. `undefined` when no coordinate the record
   * stated was accepted — including when the applicant typed one of their own, which is not a
   * geocode of anything and must not be described as one.
   */
  coordinateFrom?: GeocodedFrom;
  /**
   * WHAT THE FORM HELD THAT THESE VALUES HAVE JUST OVERWRITTEN, and what it held.
   *
   * The fifth list, and the one that is not about attribution at all: every other list here answers
   * "who stated the value that is now in the box", and this one answers "what was in the box
   * before". A profile with `state: OH` typed into it accepts a record stating MI and ends up with
   * MI, and until 2026-08-11 the confirmation's only word on the subject was that MI "came from the
   * record rather than from you" — true, complete about the new value, and silent about the one
   * that is gone.
   */
  replaced: Array<{ key: string; was: string }>;
}

/**
 * WHAT THIS ACCEPTANCE OVERWRITES: a field the form already holds an answer in, whose answer this
 * record is about to change.
 *
 * Equality against the held string, exactly as {@link fromSource} compares against the record's —
 * a value the record merely restates is not a replacement, and a field the applicant left empty
 * had nothing to lose. `values` is the map the host is about to write, so a key absent from it (a
 * coordinate the applicant declined to use, a licence class the panel would not guess) names a
 * field this acceptance does not touch and therefore cannot replace.
 */
function replacedBy(
  values: Record<string, string>,
  held: HeldProfileValues,
): Array<{ key: string; was: string }> {
  const out: Array<{ key: string; was: string }> = [];
  for (const [key, was] of Object.entries(held)) {
    if (was === undefined || was === '') continue;
    const now = values[key];
    if (now === undefined || now === was) continue;
    out.push({ key, was });
  }
  return out;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'answered'; result: CallsignLookupResult }
  | { kind: 'accepted'; record: CallsignRecord; attribution: Attribution }
  /**
   * NO LOOKUP RESULT, AND WHETHER ANYTHING ANSWERED AT ALL.
   *
   * This was `{ kind: 'failed'; message: string }` and its comment read "the request itself did not
   * complete: no answer was received, so none is reported". That is true of one of the endings that
   * reach here and false of the rest: a 429 refusal, a 200 whose body is not JSON, and a 200 whose
   * body is not a lookup result are all answers. The panel headed every one of them "The lookup did
   * not run", which nothing here knows.
   *
   * `reached` is the one bit that decides which of those two sentences is honest, and it is set
   * from the one fact this component has: an {@link ApiError} carrying a real HTTP status means the
   * other end answered, and anything else means the request never got one.
   */
  | { kind: 'failed'; reached: boolean; message: string };

/**
 * The heading and the announcement for a lookup that produced no result, which are not the same
 * sentence for a request that never got an answer and a request that got one nobody can use.
 */
function failedHeading(reached: boolean): string {
  return reached ? 'The lookup did not produce a record' : 'The lookup did not run';
}

interface Frame {
  heading: string;
  body: string;
}

/**
 * The sentence for each status. SIX STATUSES, SIX ANSWERS — a shared "lookup failed" would
 * tell an international operator that something is wrong with their licence, and would tell
 * somebody whose source is mid-import that their callsign does not exist.
 *
 * The server's own `message` is rendered beneath whichever of these applies, unedited. This
 * copy is what the SCREEN promises; that message is what the SERVER observed, and flattening
 * one into the other loses the half the user needs.
 */
export function frameFor(status: LookupStatus, callsign: string): Frame {
  switch (status) {
    case 'found':
      return { heading: `FCC record for ${callsign}`, body: '' };
    case 'not_found':
      return {
        heading: `No active licence record for ${callsign}`,
        body:
          'callook.info publishes the FCC licence database and has no active record under this ' +
          'callsign. That is not a judgement about you: a callsign issued or changed in the last ' +
          'day or so may not have reached the daily import yet, and a typo lands here too. Check ' +
          'the spelling, or fill the form in yourself — nothing here is required.',
      };
    case 'not_us':
      return {
        heading: `${callsign} is not a US callsign, so there is nothing to look up`,
        body:
          'This is not an error and nothing is wrong with your licence. GrantSpotter reads the ' +
          'FCC database, which covers US licences only, so it holds no record of any other ' +
          'administration to check against. Fill the form in yourself; every other part of ' +
          'GrantSpotter works exactly the same way for you.',
      };
    /*
     * THE STATUS THAT MUST NOT NAME A COUNTRY, BECAUSE NOBODY HERE KNOWS ONE.
     *
     * Until 2026-08-09 this answer did not exist and its cases arrived as `not_us`, so the heading
     * above — "X is not a US callsign" — was printed over `N0CALLXX`, over `W1AW/4`, and over
     * anything else a person mistyped. `N0` is a US prefix; six suffix letters is not a US format;
     * neither fact makes the string foreign, and one of them is a typo the reader can fix in a
     * second if they are told what is actually wrong. So this frame says what the software knows —
     * it could not read the string as a callsign — and says explicitly that it is not a claim about
     * the licence's origin, which is the claim that was being made by accident.
     */
    case 'malformed':
      return {
        heading: `${callsign} does not look like a callsign, so nothing was looked up`,
        body:
          'GrantSpotter could not read this as a callsign of any administration, so it asked ' +
          'nobody about it and is saying nothing about where your licence is from. The usual ' +
          'cause is a typo — one character too many or too few — or a “/P” or “/4” suffix, which ' +
          'says where somebody is operating and is not part of the callsign. Check what you ' +
          'typed. If it is right exactly as it stands, nothing is wrong with your licence: fill ' +
          'the form in yourself, because nothing here is required.',
      };
    case 'updating':
      return {
        heading: 'callook.info is re-importing the FCC database right now',
        // "unreadable for a few minutes. Try again shortly" until 2026-08-12. Neither figure came
        // from anywhere: callook.info says it is re-importing, not how long its import takes, and
        // nobody here has measured one. Two invented durations in one sentence, on a screen whose
        // sibling 429 arm goes to the trouble of printing the number the server actually computed.
        body:
          'The source rebuilds itself from the FCC once a day and cannot answer while it does. ' +
          'This says nothing about your callsign — it is not missing, it is unreadable until that ' +
          'import finishes. Try again later, or fill the form in yourself.',
      };
    /*
     * THE ONE STATUS THAT IS NOT ONE THING, SO ITS FRAME MAY NOT CLAIM TO BE.
     *
     * This said "The lookup did not get an answer" over "GrantSpotter could not reach callook.info",
     * and `unavailable` is the status the server uses for at least seven different endings. Two of
     * them make both of those sentences false. callook.info ANSWERING — with a redirect, with a
     * status, with bytes that are not a licence record — is an answer, and reporting it as
     * unreachable tells the reader the source is down when it is up. A cooldown hold is stronger
     * still: the source was never asked, because it had asked us not to, and "we could not reach
     * them" describes a failure where what happened was this product doing as it was told. The same
     * is true of the lane refusal beside it and of a host the operator has blocklisted.
     *
     * So the frame states only what is true of every one of them — no record, nothing filled in,
     * nothing claimed about the callsign — and the server's own sentence, rendered directly beneath
     * this by `NonFoundPanel`, is what says which ending it was. That division already exists in
     * this module ("This copy is what the SCREEN promises; that message is what the SERVER
     * observed"); this case was the one that had quietly taken over the server's half and got it
     * wrong. The body cannot lean on that sentence either, because `found`-with-no-record renders
     * this frame with no message at all, so it has to stand up on its own.
     */
    case 'unavailable':
      return {
        heading: `Nothing was filled in for ${callsign}`,
        body:
          'The lookup ended without a licence record, so GrantSpotter is not telling you anything ' +
          'about this callsign either way. That does not necessarily mean the source was ' +
          'unreachable — it may have answered with something GrantSpotter could not use, or ' +
          'GrantSpotter may have decided not to ask it at all. Nothing on this form was changed. ' +
          'Try again, or fill it in yourself: nothing in GrantSpotter depends on this lookup.',
      };
  }
}

/**
 * WHAT THE CONFIRMATION SAYS, BUILT FROM WHAT WAS ACTUALLY ATTRIBUTED.
 *
 * This panel is an editor as much as a report, and `fillFromLookup` marks only the values the
 * RECORD stated — so "Filled in from the FCC record" and "These are values GrantSpotter read, not
 * values you stated" could be, and were, printed over a set of values GrantSpotter read none of: a
 * legacy licence class the applicant picked because the panel asked them to, a state they
 * corrected, a callsign they typed themselves. That sentence is the reassurance this screen exists
 * to give; printed unconditionally it is worth nothing on the occasions when it is true, which is
 * the same defect as a badge that never comes off.
 *
 * So the words are computed from the same function that builds the markers, over the same accepted
 * value, rather than from the fact that a record was on screen. `fillFromLookup` is pure, which is
 * what makes calling it twice — once here for the sentence, once in the host for the markers it
 * stores — a guarantee that the two agree rather than a second opinion.
 */
export function acceptedFrame(attribution: Attribution, kind: CallsignTarget): Frame {
  const { marked, unmarked, restated, unmarkable, derived, unfillable, coordinateFrom, replaced } =
    attribution;
  const one = marked.length === 1;
  const mine =
    unmarked.length === 0
      ? ''
      : ` ${profileFieldLabelList(unmarked, kind)} ${unmarked.length === 1 ? 'carries' : 'carry'} no mark: ` +
        `the record either did not state ${unmarked.length === 1 ? 'it' : 'them'}, or you changed ` +
        `what it said, so ${unmarked.length === 1 ? 'it is yours' : 'they are yours'}.`;
  /**
   * THE SENTENCE THE ORDINARY LOOKUP NEEDED AND DID NOT HAVE.
   *
   * A person types their own callsign, presses the button, and the record comes back for exactly
   * it. Until 2026-08-12 the confirmation said "Callsign carries no mark: the record either did not
   * state it, or you changed what it said, so it is yours" — measured in Chromium, on the most
   * ordinary path this panel has, with both disjuncts false. There is no mark because the value was
   * stated twice, and that is a third thing, so it gets a third sentence. See
   * `fillFromLookup`'s `restated`.
   */
  const alsoStated = ((): string => {
    if (restated.length === 0) return '';
    const it = restated.length === 1 ? 'it' : 'them';
    return (
      ` ${profileFieldLabelList(restated, kind)} ` +
      // NO CONNECTIVE BACK TO `mine`, deliberately: whether that sentence was printed depends on
      // what the applicant edited, and "either" or "neither of those reasons" over a paragraph the
      // reader was never shown is a small lie of the same family as the big one. Stated whole, it
      // reads correctly in both cases — and beside `mine` the contrast is the point, since the two
      // sentences give two different reasons for the same missing badge.
      `${restated.length === 1 ? 'carries no mark' : 'carry no marks'}: ` +
      `the record stated ${it} and so did you.` +
      // Only where the callsign is actually in this list. It is the only key that can be, today —
      // `callsignFromRecord` is the one comparison that answers `'both'` — and a sentence about
      // "the callsign you asked about" printed over some other field would be this list repeating
      // the mistake it was split out of `unmarked` to stop.
      (restated.includes('callsign')
        ? ' This record is for the callsign you asked about, so nothing was substituted.'
        : '') +
      ` Putting callook.info’s name on ${it} would credit the source with an answer you had ` +
      'already given.'
    );
  })();
  /**
   * The third sentence, and the one nobody would think to write. A value the record stated, on a
   * field this profile has, that carries no mark — not because of anything the applicant did but
   * because the profile has no room to record a source for a number. Said plainly, because the
   * consequence lands later: they will reload this page and see a coordinate that looks exactly
   * like one they typed.
   */
  const fetched =
    unmarkable.length === 0
      ? ''
      : ` ${profileFieldLabelList(unmarkable, kind)} came from the record too, and ` +
        // WHAT THE NUMBER IS, BEFORE WHAT CANNOT BE RECORDED ABOUT IT. The old sentence went
        // straight to the marker problem, so the strongest fact about a PO-box coordinate — that
        // it is a post office — was stated only inside the panel the reader then closes.
        (coordinateFrom === undefined
          ? ''
          : `${unmarkable.length === 1 ? 'is' : 'are'} ${coordinateSubjectPhrase(coordinateFrom)}. ` +
            'That is what a radius rule would be answered with. ') +
        `${unmarkable.length === 1 ? 'It carries no mark' : 'They carry no marks'}: GrantSpotter ` +
        'can record where a callsign, a state or a licence class came from, and has nowhere to ' +
        `record that about a coordinate. Once saved, ${unmarkable.length === 1 ? 'it reads' : 'they read'} ` +
        `exactly like ${unmarkable.length === 1 ? 'a value' : 'values'} you stated.`;
  /**
   * THE SENTENCE FOR A VALUE THAT IS GONE, which the codebase already writes for an ERASURE.
   *
   * `applyLookup` calls an emptied field "a change they are owed a sentence about". A replacement
   * is the same change with something on top of it, and it went unremarked: measured on 2026-08-11,
   * a profile holding a typed `OH`, `42.2936` and `-83.7100` accepted W8UM's record and lost all
   * three, and the confirmation's only word was that State and License class "came from the record
   * rather than from you". The old values are quoted rather than merely counted, because that is
   * the difference between a warning and a way to put them back.
   */
  const overwritten =
    replaced.length === 0
      ? ''
      : ' ' +
        `${replaced.length === 1 ? 'One value you had already stated was' : 'Values you had already stated were'} ` +
        `replaced: ${replaced
          .map((entry) => `${profileFieldLabel(entry.key, kind)} was ${entry.was}`)
          .join(', ')}. Put ${replaced.length === 1 ? 'it' : 'them'} back by hand if the record is ` +
        'wrong about you — nothing here is saved until you press Save.';
  const worked =
    derived.length === 0
      ? ''
      : ` ${profileFieldLabelList(derived, kind)} ` +
        `${derived.length === 1 ? 'was' : 'were'} worked out from the callsign rather than read ` +
        'anywhere — no source is credited for arithmetic, and changing the callsign changes ' +
        `${derived.length === 1 ? 'it' : 'them'}.`;
  /**
   * Named WITHOUT the profile kind, which is the one place in this file that is deliberate: these
   * keys are fields of the OTHER profile, and asking `profileFieldLabel` for this one's name for
   * them would be asking a question with no answer. The registry falls through to the kind that
   * does have the field, and the sentence says that is what happened rather than pretending the
   * field is on the screen the applicant is reading.
   */
  const elsewhere =
    unfillable.length === 0
      ? ''
      : ` ${profileFieldLabelList(unfillable)} ${unfillable.length === 1 ? 'is not a field' : 'are not fields'} ` +
        `this profile has, so nothing was recorded for ${unfillable.length === 1 ? 'it' : 'them'} ` +
        `and no source is named for ${unfillable.length === 1 ? 'it' : 'them'}.`;

  if (marked.length > 0) {
    return {
      heading: 'Filled in from the FCC record',
      body:
        `${profileFieldLabelList(marked, kind)} came from the record rather than from you, and ` +
        `${one ? 'the field stays' : 'those fields stay'} marked that way until you edit ` +
        `${one ? 'it' : 'them'}.${mine}${alsoStated}${fetched}${worked}${elsewhere}${overwritten} Nothing has been saved yet.`,
    };
  }

  /*
   * THE CLAIM IN THE SECOND BRANCH IS ABOUT `unmarked`, AND IT IS NOW MADE ONLY WHERE THERE IS AN
   * `unmarked` TO MAKE IT ABOUT.
   *
   * "GrantSpotter puts callook.info's name on a field only where the record itself stated what is
   * now in it, and that is true of none of these" was unconditional, and "these" was whatever the
   * reader took it to refer to. On a record that stated nothing but the callsign the applicant
   * typed, that is a sentence saying the record stated none of the values on screen, printed over
   * one it had stated in full — the same false claim this branch's heading is careful not to make.
   */
  const ownValues =
    unmarked.length === 0
      ? ''
      : `${profileFieldLabelList(unmarked, kind)} went onto the form as ` +
        `${unmarked.length === 1 ? 'your own value' : 'your own values'}. ` +
        'GrantSpotter puts callook.info’s name on a field only where the record itself stated what ' +
        'is now in it, and that is true of none of these — either the record had nothing to state, ' +
        'or you changed what it said.';

  return {
    heading: 'Filled in — none of it attributed to the FCC record',
    body:
      `${ownValues}${alsoStated}${fetched}${worked}${elsewhere}${overwritten}`.trim() +
      ' Nothing has been saved yet.',
  };
}

/**
 * WHAT THE RECORD SAID ABOUT WHERE THE MAIL GOES, AND WHAT THE PERSON IS TOLD ABOUT IT.
 *
 * NOTHING PUTS A COORDINATE IN THESE BOXES EXCEPT THE PERSON. That is the decision, it applies to
 * every arm, and it changed on 2026-08-11 — `street_address` used to open pre-filled.
 *
 * THE ARGUMENT THE OLD SPLIT WAS MISSING. callook geocodes ONE thing: the address on the licence,
 * which is where the licensee's post goes. `matcher` reads latitude and longitude for exactly one
 * purpose — radius eligibility — so the only consequence a coordinate has in this product is a
 * verdict about the place it names. The old rule reasoned per-arm about how GOOD each coordinate
 * was, and a street address won that argument fairly: it is a place rather than a mail drop, and
 * the applicant is looking at both the address and the number before anything is written.
 *
 * But "how good is this number" was the wrong question, and the right one was answered by
 * measurement. Traced end to end in a browser on 2026-08-11: a student profile holding W8UM, MI and
 * GENERAL with no coordinate reports `{"kind":"unknown","missingProfileFields":["citizenship",
 * "fieldOfStudy","lat","lon","stage"]}` against the Chick Allen Memorial Scholarship. Two button
 * presses and ZERO typing later — "Look up this callsign", then "Use these values" — the same
 * profile reports `{"kind":"ineligible","reasons":[{"hard":true,"rawText":"Residence within 250
 * miles of Seaford, Delaware"}]}`, and the screen reads "Ineligible · 1". A HARD ineligible verdict,
 * resting entirely on a number the applicant never stated, never looked at, and — after one save —
 * cannot tell from one they measured themselves, because `StudentFieldSources` has no key for a
 * coordinate and the marker is stripped on the way in.
 *
 * AND THE MARGINS ARE NOT ACADEMIC, which is what turns the argument. Measured with this
 * repository's own `haversineMiles` against the radius centres in the seed corpus: W1AW's own
 * STREET-address coordinate is 261.23 miles from Seaford, Delaware, against a 250-mile rule — 11.23
 * miles outside. The good arm is eleven miles from flipping a hard verdict. A mailing address in the
 * next town over is the same order of magnitude as that margin, so "it is a place rather than a mail
 * drop" does not survive contact with the one thing the number is used for.
 *
 * So the same rule this component already keeps for a legacy licence class (rule 5 in the header,
 * `operClass` left UNSET rather than rounded upward) and for `licensedSince` (refused outright,
 * because it feeds `heldMonthsMin`) now covers the coordinate too: WHERE A VALUE FROM A SOURCE CAN
 * DECIDE A VERDICT AND CANNOT AFTERWARDS BE ATTRIBUTED, THE SOFTWARE DOES NOT CHOOSE IT. It shows
 * the number, says what it is a geocode of, and waits. Refusing outright was rejected for the reason
 * it always was: this is the median user, a club that knows its post office is three miles from its
 * shack is better served by an informed yes than by a blanket no, and radius rules left unanswered
 * are unanswered rather than answered against you. What it must not be is silent, and what it must
 * not be is automatic.
 *
 * THE RECORD IS CHECKED AGAINST ITSELF HERE TOO, EVEN THOUGH THE SERVER DOES IT. A callook
 * `location` carries a coordinate AND a grid square, which are two independent statements about one
 * station, and `checkCoordinateAgainstLocator` in core is what compares them. Since `5d411a4` the
 * server's parser asks the same question and sends no coordinate when the halves disagree — it now
 * sends a {@link GeocodeRefusal} saying so, which is where this copy is normally reached from. The
 * local check stays for the reason `KNOWN_STATUSES` stays: `api/callsign.ts` is a HAND COPY of a
 * type on the other side of a process boundary, this app is served behind a tunnel, and a proxy, a
 * stale build or a captive portal can answer 200 with anything. The cost of asking is one function
 * call over numbers already in memory. The cost of not asking is a confident radius verdict computed
 * from a coordinate 2,900 miles from where the same record says the station is. Both routes produce
 * the SAME sentence — {@link contradictedNote} — so the copy is no longer a paragraph only a broken
 * server could show anybody.
 */
export type GeocodeOffer =
  /**
   * A coordinate the record stated, on screen and NOT in the boxes. One press puts it there.
   * `from` travels with it because every surface past this panel needs to say what it is.
   */
  | { kind: 'offered'; point: GeocodedPoint; from: GeocodedFrom; note: string }
  /**
   * The record stated a location and none of it is being offered. No press fills anything, and no
   * number is quoted: quoting a value this panel has just called untrustworthy invites the reader
   * to type it in by hand, which is the outcome the refusal exists to prevent.
   */
  | { kind: 'refused'; note: string };

/** One sentence for a self-contradictory record, whichever side of the wire noticed it. */
function contradictedNote(gridsquare: string, containingLocator: string): string {
  return (
    `This record contradicts itself: it states the grid square ${gridsquare}, and the coordinate ` +
    `beside it falls in ${containingLocator} instead. Those are two statements about one station ` +
    'and they disagree, so GrantSpotter is not offering either of them — there is no honest way ' +
    'to pick the right one. Type a location in yourself if you need radius rules answered.'
  );
}

/**
 * THE SENTENCE FOR A COORDINATE THIS BUILD CANNOT READ — which is a refusal like any other, and is
 * told to the reader like one.
 *
 * The alternative was to render nothing for these records, and rendering nothing is what the
 * server was measured doing on 2026-08-11 before `GeocodeRefusal` existed: the address note then
 * said the state was all that was kept from those lines, over a record that had also stated a
 * position. The reader is not owed our diagnosis, but they are owed the fact that something was
 * there and is not being used — and the honest form of that, when the shape is unrecognised, is to
 * say which part could not be read and that the boxes are empty because of it.
 *
 * NO NUMBER IS QUOTED, for exactly the reason the `'refused'` arm quotes none: a value this panel
 * has just said it cannot vouch for, printed anyway, is an invitation to type it in by hand.
 */
function unreadableGeocodeNote(because: string): string {
  return (
    'This record states a position that GrantSpotter cannot read: ' +
    `${because}. A latitude and a longitude are used here for one thing only — rules of the form ` +
    '“within 250 miles of Seaford, Delaware” — and answering one of those from a number whose ' +
    'shape this page did not recognise would be a verdict about you computed from something ' +
    'nobody has identified. So nothing from it is offered, in the boxes or one press away. The ' +
    'usual cause is a browser holding an older version of GrantSpotter than the server it is ' +
    'talking to: reload the page. Type a location in yourself if you need radius rules answered.'
  );
}

/**
 * WHY THE BOXES ARE EMPTY WHEN THE RECORD DID STATE SOMETHING.
 *
 * The server refuses a location it cannot vouch for and sends the reason rather than the numbers.
 * Before 2026-08-11 it sent neither, so a contradictory record and a record with no location at all
 * arrived identical — and the address note below then told the reader that the state was the only
 * thing kept from those lines, over a record that had also stated a coordinate. Every arm here is a
 * different upstream defect and gets a different sentence, for the same reason the six lookup
 * statuses do.
 */
function refusalNote(refusal: NonNullable<CallsignRecord['geocodeRefusal']>): string {
  /*
   * THE REASON IS CHECKED BEFORE IT IS SWITCHED ON, AND SO IS THE EVIDENCE IT IS SUPPOSED TO CARRY.
   *
   * Two measurements from 2026-08-12, in Chromium against the real SPA, before this guard:
   *
   *   {"refused":"geocoder_unavailable"}                  → the panel rendered ONE EMPTY <p>
   *   {"refused":"contradicted","gridsquare":"FN31pr"}    → "…the coordinate beside it falls in
   *                                                          undefined instead."
   *
   * The first is the worse of the two, because of what is printed directly above it: "This record
   * did state a position for these lines, and GrantSpotter is not passing it on — THE REASON IS
   * BELOW." A promise, and then a blank line. The argument that put `GeocodeRefusal` on the wire in
   * the first place was that "silence about a refusal is a claim that there was nothing to refuse";
   * a promised reason that renders as nothing is that same silence with a pointer at it.
   *
   * The second prints a locator that does not exist as though the record had stated one. The
   * sentence is evidence — it is the whole basis for calling a record self-contradictory — and
   * evidence with `undefined` in it is worse than no sentence, because a reader who goes to check
   * the FCC record against it has been sent after a grid square nobody named.
   */
  const wire = refusal as Record<string, unknown>;
  const evidence = typeof wire.refused === 'string' ? REFUSAL_EVIDENCE.get(wire.refused) : undefined;
  const missing =
    evidence === undefined ||
    evidence.some((field) => typeof wire[field] !== 'string' || (wire[field] as string).trim() === '');
  if (missing) {
    return (
      'This record stated a position and GrantSpotter is not passing it on. The reason it gave' +
      `${quotedArm(wire.refused)} is not one this page can explain: either it is a reason this ` +
      'build does not know, or the answer arrived without the detail the sentence for it is made ' +
      'of. That normally means this page is older than the server that answered it — reload it, ' +
      'and if nothing changes, the two are not the same version of GrantSpotter. Nothing from the ' +
      'position is in the boxes either way. Type a location in yourself if you need radius rules ' +
      'answered.'
    );
  }

  switch (refusal.refused) {
    case 'contradicted':
      return contradictedNote(refusal.gridsquare, refusal.containingLocator);
    case 'unreadable_locator':
      return (
        `This record states a coordinate beside a grid square, ${JSON.stringify(refusal.gridsquare)}, ` +
        'that GrantSpotter could not read as one — so there was nothing to check the coordinate ' +
        'against, and a coordinate nothing corroborates is not something to fill a form in with. ' +
        `(${refusal.because}.) Type a location in yourself if you need radius rules answered.`
      );
    case 'locator_too_coarse':
      return (
        `This record states a coordinate beside the grid square ${refusal.gridsquare}, which names ` +
        'a box roughly ten degrees by twenty — hundreds of miles across, and far too coarse to ' +
        'tell whether the coordinate belongs in it. GrantSpotter keeps the two halves of a ' +
        'location only where they can check each other, so neither is offered here.'
      );
    case 'placeholder':
      return (
        'This record states its position as 0, 0 — a point in the Gulf of Guinea, thousands of ' +
        'miles from any US licence, and what this data carries where a geocode is missing. It is ' +
        'an absence written in the shape of an answer, so GrantSpotter is not passing it on. Type ' +
        'a location in yourself if you need radius rules answered.'
      );
    case 'incomplete':
      return (
        'This record states part of a position and not the whole of it. A latitude, a longitude ' +
        'and a grid square are kept together or not at all — half a location cannot be checked ' +
        'against itself — so nothing from it is offered here.'
      );
  }
}

export function describeGeocode(record: CallsignRecord): GeocodeOffer | undefined {
  const geocode = record.mailingGeocode;
  if (geocode === undefined) {
    // The two shapes of one answer. A record that stated no location at all reaches neither.
    return record.geocodeRefusal === undefined
      ? undefined
      : { kind: 'refused', note: refusalNote(record.geocodeRefusal) };
  }

  /*
   * WHAT THE WIRE SAID IT IS, CHECKED BEFORE THE SWITCH NARROWS ON IT.
   *
   * The exhaustive switch below is the point of the type — there is no way to reach the numbers
   * without first saying which of the three things they are, so the paragraph above cannot be
   * skipped by somebody who only wanted a latitude. What tsc's exhaustiveness does NOT do is
   * survive contact with a fourth arm, because a `switch` with three cases and no default returns
   * `undefined`, and `undefined.latitude` is a THROW during render. See `KNOWN_GEOCODED_FROM` for
   * the measurement: the whole page, and the applicant's unsaved coordinate and field of study
   * with it.
   */
  if (!KNOWN_GEOCODED_FROM.has(geocode.geocodedFrom)) {
    return {
      kind: 'refused',
      note: unreadableGeocodeNote(
        'it says the coordinate is a geocode of something this page has no name for' +
          quotedArm(geocode.geocodedFrom),
      ),
    };
  }

  const stated: unknown = ((): unknown => {
    switch (geocode.geocodedFrom) {
      case 'street_address':
        return geocode.mailingAddress;
      case 'po_box':
        return geocode.poBox;
      case 'address_not_stated':
        return geocode.unattributed;
    }
  })();

  /*
   * AND THE POINT ITSELF, because the key being right does not make what is under it a point. A
   * body with the arm spelled correctly and `{"poBox":{}}` beside it renders "This record states
   * the position undefined, undefined" and then asks `checkCoordinateAgainstLocator` to compare a
   * missing latitude with a missing grid square. `GeocodedPoint` is all three parts or none — the
   * server's own rule for the field — so it is read that way here rather than trusted.
   */
  const point = readPoint(stated);
  if (point === undefined) {
    return {
      kind: 'refused',
      note: unreadableGeocodeNote('the latitude, longitude and grid square did not all arrive'),
    };
  }

  const agreement = checkCoordinateAgainstLocator(point.latitude, point.longitude, point.gridsquare);
  if (agreement.status === 'outside') {
    return { kind: 'refused', note: contradictedNote(point.gridsquare, agreement.containingLocator) };
  }
  if (agreement.status === 'unknown') {
    return {
      kind: 'refused',
      note: refusalNote({
        refused: 'unreadable_locator',
        gridsquare: point.gridsquare,
        because: agreement.rejection.message,
      }),
    };
  }

  /**
   * ONE NOTE PER ARM, AND IT NO LONGER DIFFERS IN WHAT IT PROMISES — only in what the number IS.
   * The clause naming the subject is `coordinateSubjectPhrase`, shared with the confirmation, the
   * live region and the note beside the field on the editor, because those three said nothing at
   * all about a post office until 2026-08-11 and one string is what keeps four surfaces honest.
   */
  return {
    kind: 'offered',
    point,
    from: geocode.geocodedFrom,
    note:
      `This coordinate is ${coordinateSubjectPhrase(geocode.geocodedFrom)}. GrantSpotter has left ` +
      'the boxes empty rather than fill them with it: latitude and longitude are read for one ' +
      // ONE EXAMPLE OF ONE RULE PER SCREEN. This read “within 70 miles of Schenectady” while the
      // note three paragraphs below the same two boxes read “within 250 miles of Seaford,
      // Delaware” — two different examples of the same thing, a few inches apart, one of which is
      // the rule this profile is actually judged against (the Chick Allen Memorial Scholarship, in
      // the seed corpus, is the measurement that put the coordinate rule where it is).
      'thing only, rules of the form “within 250 miles of Seaford, Delaware”, and that is a ' +
      'verdict about you which this software will not compute from a number you did not choose. ' +
      'Use it if it is close enough that you are happy answering those rules with it.',
  };
}

/** The record's own words for its operator class, or the truth about a club licence. */
function operatorClassText(record: CallsignRecord): string {
  if (record.operClassRaw !== undefined && record.operClassRaw !== '') return record.operClassRaw;
  return record.type === 'CLUB'
    ? 'None — a club station licence has no operator class'
    : 'Not stated in the record';
}

export function CallsignLookup({
  callsign,
  held,
  target,
  onAccept,
  clubNotice,
}: CallsignLookupProps): JSX.Element {
  const baseId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const typed = callsign.trim().toUpperCase();
  const heldValues = held ?? {};

  /**
   * THE REQUEST IS THE ONLY THING IN THE `try`, AND THAT IS THE FIX FOR A FALSE SENTENCE.
   *
   * Measured in Chromium on 2026-08-12 against the built server, with the lookup answered 200 and
   * the body `null`: the screen read "The lookup did not run. The GrantSpotter API could not be
   * reached, so the lookup never ran." The API was reached and it answered. `apiFetch` passes a
   * `null` body through on purpose — "asked, answered, nothing there", in its own words, and a
   * deliberate `null` payload is not the same event as a body that would not parse — so
   * `result.status` was a TypeError thrown by THIS function, caught by the block below, found not
   * to be an `ApiError`, and reported as an unreachable API. The same probe answering `text/html`
   * names the proxy correctly, because that one arrives as an `ApiError` from `apiFetch`: the
   * machinery to tell a tunnel's two misbehaviours apart was already here, and this one walked
   * around it.
   *
   * A `catch` around code that reads the answer will always eventually report a bug in the reader
   * as a fact about the network. So the block covers the request and nothing else, and everything
   * after it is ordinary control flow over a value that has already arrived.
   */
  async function run(): Promise<void> {
    setPhase({ kind: 'busy' });
    let answer: unknown;
    try {
      // The callsign, and nothing else. A `setupToken` was spread in here until 2026-08-12 and the
      // server has refused the key since 2026-08-11 — `{callsign,setupToken}` measured as a 422
      // `unrecognized_keys` against a server started from this tree, `{callsign}` as a 200.
      answer = await postCallsignLookup({ callsign: typed });
    } catch (err) {
      // A refusal or an unreachable API is not an answer about the callsign, and must not be
      // reported as one. The server's sentence is carried through — for a rate limit that
      // sentence is the explanation, and `retryAfterSec` is the when.
      const reached = err instanceof ApiError && err.status !== 0;
      /*
       * THE SERVER'S NUMBER, ADDED 2026-08-12, AND THE SERVER'S PHRASE REMOVED IN THE SAME BREATH.
       *
       * `api/callsign.ts` attaches `details.retryAfterSec` to its 429 and this component threw it
       * away, printing only the message — which used to end "Try again shortly" and now, correctly,
       * says nothing about time. Dropping the number without dropping the phrase would have left a
       * refusal with no when at all; dropping the phrase without printing the number would have
       * left the same. `lib/retryAfter.ts` is the one renderer for this, shared with `Login.tsx`,
       * `Enroll.tsx`, `FirstRun.tsx` and `VerifyButton.tsx`, and it says nothing when the envelope
       * carried no usable number rather than inventing a figure.
       */
      const wait = err instanceof ApiError ? retryAfterSecOf(err.details) : null;
      const when = wait === null ? '' : ` Try again in ${humanRetryAfter(wait)}.`;
      setPhase({
        kind: 'failed',
        reached,
        message: reached
          ? `${(err as ApiError).message}${when}`
          : 'The GrantSpotter API could not be reached, so the lookup never ran.',
      });
      return;
    }
    setPhase(
      isLookupResult(answer)
        ? { kind: 'answered', result: answer }
        : { kind: 'failed', reached: true, message: unusableAnswerNote(answer) },
    );
  }

  const answered = phase.kind === 'answered' ? phase.result : null;
  /**
   * WHAT THE WIRE PUT UNDER `record`, WHICH THE TYPE CALLS A RECORD AND THE WIRE DOES NOT.
   *
   * Read as `unknown` on purpose, because the two things that go wrong here are invisible to the
   * declaration: `record: null` is not in the type at all (so `?? null` is the only place its
   * absence was ever handled), and a record missing the fields every sentence is built from
   * type-checks as a `CallsignRecord` while rendering the word "undefined" four times. One value,
   * read once, used by the panel and by the live region alike — the announcement built its own from
   * `phase.result.record` and guarded it with `found === undefined`, so a `null` was a
   * `TypeError: Cannot read properties of null (reading 'callsign')` during render. The error
   * boundary around this panel kept the applicant's typing, which is what it is for, and the panel
   * still died.
   */
  const sent: unknown = answered?.status === 'found' ? answered.record : undefined;
  const record = readRecord(sent) ?? null;
  /** Something arrived under `record` and it is not a record. See {@link unusableRecordNote}. */
  const recordUnusable = record === null && sent !== undefined && sent !== null;

  /**
   * WHAT THE LIVE REGION SAYS IS WHAT THE PANEL SAYS.
   *
   * Every branch here builds its sentence from the same value the visible heading does, because a
   * screen-reader user and a sighted user must be told about the same record. The heading below is
   * built from `record.callsign`; this used to build its own from the TYPED callsign, so a lookup
   * of a superseded callsign announced "FCC record for K9OLD: ALEX Q EXAMPLE" over a panel showing
   * W5NEW's record — the substitution this component now exists to surface, described to the one
   * user who cannot see it happening.
   *
   * The same rule fixes a second mismatch beside it: `found` with no record renders as the
   * `unavailable` panel (a record was not received, so nothing is claimed), and is now announced
   * that way rather than as an FCC record that is not on screen.
   */
  const announcement = ((): string => {
    switch (phase.kind) {
      case 'idle':
        return '';
      case 'busy':
        return `Looking up ${typed}…`;
      case 'accepted': {
        // The same heading the panel below shows, so the one user who cannot see it is not told
        // that a record filled in values the record stated none of.
        //
        // AND THE TWO FACTS A HEADING CANNOT CARRY. Measured on 2026-08-11, this said exactly
        // "Filled in from the FCC record. Nothing has been saved yet." over an acceptance that had
        // just put a post office into a radius-deciding field and overwritten a coordinate the
        // applicant had typed. Both are on the visible panel; a live region that announces only
        // the heading tells the one user who cannot read that panel the least of what happened.
        const { coordinateFrom, replaced } = phase.attribution;
        return (
          `${acceptedFrame(phase.attribution, target).heading}.` +
          (coordinateFrom === undefined
            ? ''
            : ` The coordinate came from the record and is ${coordinateSubjectLabel(coordinateFrom)}.`) +
          (replaced.length === 0
            ? ''
            : ` ${profileFieldLabelList(
                replaced.map((entry) => entry.key),
                target,
              )} ${replaced.length === 1 ? 'was a value' : 'were values'} you had already stated, ` +
              'and the record has replaced ' +
              `${replaced.length === 1 ? 'it' : 'them'}.`) +
          ' Nothing has been saved yet.'
        );
      }
      case 'failed':
        return `${failedHeading(phase.reached)}. ${phase.message}`;
      case 'answered': {
        // THE SAME `record` THE PANEL BELOW RENDERS, and not a second reading of the wire. This
        // built its own from `phase.result.record` and asked `=== undefined`, which is the one
        // spelling of "no record" that the render path's `?? null` already handled — so the two
        // disagreed on `null`, and on a record whose fields did not arrive. A live region derived
        // from anything other than what is on screen will eventually announce something else.
        if (record === null) {
          return frameFor(
            phase.result.status === 'found' ? 'unavailable' : phase.result.status,
            typed,
          ).heading;
        }
        const substituted =
          record.callsign === typed
            ? ''
            : ` This record is for ${record.callsign}, not the ${typed} you asked about.`;
        return (
          `${frameFor('found', record.callsign).heading}: ${record.name}.${substituted}` +
          ' Nothing has been filled in yet.'
        );
      }
    }
  })();

  return (
    <div className="callsign-lookup">
      <div className="callsign-actions">
        <button
          type="button"
          className="btn"
          onClick={() => void run()}
          disabled={phase.kind === 'busy' || typed === ''}
        >
          {phase.kind === 'busy' ? 'Looking up…' : 'Look up this callsign'}
        </button>
      </div>
      <p className="callsign-hint">
        Reads the FCC licence record published by callook.info. Nothing is filled in, and nothing
        is saved, until you say so.
      </p>

      {/* Always mounted, so an assistive technology is already watching it when an answer
          lands rather than being handed a node that appeared from nowhere. */}
      <p className="callsign-live" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {phase.kind === 'failed' && (
        <section className="callsign-panel callsign-quiet" aria-labelledby={`${baseId}-failed`}>
          <h2 id={`${baseId}-failed`}>{failedHeading(phase.reached)}</h2>
          <p className="callsign-note">
            Nothing on this form was changed, and GrantSpotter is not saying anything about this
            callsign either way. {phase.message}
          </p>
          <div className="callsign-actions">
            <button type="button" className="btn" onClick={() => setPhase({ kind: 'idle' })}>
              Close
            </button>
          </div>
        </section>
      )}

      {answered !== null && record === null && (
        <NonFoundPanel
          id={`${baseId}-status`}
          /* `found` with no record is a malformed answer, and it is framed as
             `unavailable` — which is what it is from here: no record was received, so
             there is nothing to show and nothing is claimed about the callsign. A record
             that arrived without the facts every sentence here is built from is the same
             thing with one more sentence to it, and gets that sentence in place of the
             server's — the server's `message` is `undefined` on a `found` anyway. */
          frame={frameFor(answered.status === 'found' ? 'unavailable' : answered.status, typed)}
          message={recordUnusable ? unusableRecordNote() : answered.message}
          onClose={() => setPhase({ kind: 'idle' })}
        />
      )}

      {record !== null && (
        <FoundPanel
          // Remounts on a fresh answer, so the editable values below are re-seeded from the
          // record rather than carrying the previous callsign's state forward.
          key={`${record.callsign}:${record.fetchedAt}`}
          baseId={baseId}
          record={record}
          typed={typed}
          held={heldValues}
          target={target}
          clubNotice={clubNotice}
          onUse={(values) => {
            onAccept(values);
            // Which of these the host will mark is `fillFromLookup`'s answer, not this panel's
            // guess at it: the same pure function, over the same accepted value, so the sentence
            // the user reads and the markers the profile stores cannot disagree.
            const fill = fillFromLookup(values, target);
            setPhase({
              kind: 'accepted',
              record,
              attribution: {
                marked: Object.keys(fill.fieldSources),
                unmarked: fill.unmarked,
                restated: fill.restated,
                unmarkable: fill.unmarkable,
                derived: fill.derived,
                unfillable: fill.unfillable,
                ...(fill.coordinateFrom === undefined ? {} : { coordinateFrom: fill.coordinateFrom }),
                // Computed from the SAME `values` map the host is about to write, so the sentence
                // cannot name a replacement that did not happen or miss one that did.
                replaced: replacedBy(fill.values, heldValues),
              },
            });
          }}
          onDiscard={() => setPhase({ kind: 'idle' })}
        />
      )}

      {phase.kind === 'accepted' && (
        <AcceptedPanel
          id={`${baseId}-accepted`}
          record={phase.record}
          frame={acceptedFrame(phase.attribution, target)}
          onClose={() => setPhase({ kind: 'idle' })}
        />
      )}
    </div>
  );
}

/**
 * What was filled in, and whose values they are.
 *
 * The record is still named here — it was read, and the link to the FCC's own copy of it is worth
 * having whether or not anything was attributed to it — but the two sentences around it come from
 * {@link acceptedFrame}, which is computed from what the markers actually say.
 */
function AcceptedPanel({
  id,
  record,
  frame,
  onClose,
}: {
  id: string;
  record: CallsignRecord;
  frame: Frame;
  onClose: () => void;
}): JSX.Element {
  return (
    <section className="callsign-panel" aria-labelledby={id}>
      <h2 id={id}>{frame.heading}</h2>
      <SourceLine record={record} />
      <p className="callsign-note">{frame.body}</p>
      <div className="callsign-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

function NonFoundPanel({
  id,
  frame,
  message,
  onClose,
}: {
  id: string;
  frame: Frame;
  message?: string;
  onClose: () => void;
}): JSX.Element {
  return (
    // `callsign-quiet` on every one of these: not one of the five is a failure of the user's —
    // `not_us` in particular must not be dressed as an error, and `malformed`, the only one that
    // does point at what was typed, is a typo being pointed out and not a fault being reported.
    <section className="callsign-panel callsign-quiet" aria-labelledby={id}>
      <h2 id={id}>{frame.heading}</h2>
      <p className="callsign-note">{frame.body}</p>
      {/* The server's own sentence, unedited, beneath the framing rather than instead of it. */}
      {message !== undefined && message !== '' && <p className="callsign-note">{message}</p>}
      <div className="callsign-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

/**
 * The record, and the three values that may leave it.
 *
 * The editable inputs are the "edit" half of accept/edit/dismiss: they open pre-filled from
 * the record, and what the user presses "Use these values" with is what the host receives.
 * Everything above them is evidence — shown so a person can recognise their own record, and
 * then discarded.
 */
function FoundPanel({
  baseId,
  record,
  typed,
  held,
  target,
  clubNotice,
  onUse,
  onDiscard,
}: {
  baseId: string;
  record: CallsignRecord;
  /** What the user asked about, normalised — which is not always what the record is for. */
  typed: string;
  /** What the form behind this panel already holds, so the panel can say what it would cost. */
  held: HeldProfileValues;
  target: CallsignTarget;
  clubNotice?: ReactNode;
  onUse: (values: AcceptedCallsign) => void;
  onDiscard: () => void;
}): JSX.Element {
  const [state, setState] = useState(record.state ?? '');
  // UNSET unless the source's class maps exactly. This is the legacy-class rule in one line:
  // `operClass` is absent for Advanced, Novice and Technician Plus, and an empty select is
  // what makes the user the one who decides.
  const [licenseClass, setLicenseClass] = useState<string>(record.operClass ?? '');
  const [orgName, setOrgName] = useState(record.type === 'CLUB' ? record.name : '');
  /**
   * The coordinate boxes, which open EMPTY on every arm and are seeded by nothing at all.
   *
   * The same one-line expression of a rule as the licence-class seed above, and for the same
   * reason: an empty box is what makes the person the one who decides. It read
   * `geocode?.kind === 'prefill' ? …` until 2026-08-11, and the argument for retiring that arm is
   * at {@link describeGeocode}.
   *
   * THEY DO NOT OPEN ON THE APPLICANT'S OWN HELD COORDINATE EITHER, which looks friendlier and is
   * not safe: a coordinate the form holds may be one a PREVIOUS record put there, and seeding it
   * here would re-emit it through `fromSource` as the applicant's own — laundering the previous
   * licensee's post office into "a value you stated" and defeating `applyLookup`'s `vacated` rule.
   * An empty box leaves the held value untouched in the form, which is the correct outcome, and
   * what the applicant holds is stated below instead of being editable here.
   */
  const geocode = describeGeocode(record);
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  /**
   * The record found is for a callsign the user did not type. callook answers a lookup of a
   * SUPERSEDED callsign with the licensee's current record, so this is usually the same person
   * under a call they no longer hold — and it is also what a mistyped callsign that happens to be
   * somebody else's looks like. Either way it is not a substitution to make on the user's behalf.
   */
  const substituted = record.callsign !== typed;
  const [confirmed, setConfirmed] = useState(false);

  /** A licence class is a person's, and only the student profile has a field for one. */
  const offersLicenseClass = target === 'student' && record.type === 'PERSON';
  /** An organisation name is a club's, and only the organisation profile has a field for one. */
  const offersOrgName = target === 'organization' && record.type === 'CLUB';

  const addressLines = [
    record.addressLine1,
    [record.city, record.state].filter((part) => part !== undefined && part !== '').join(', '),
    record.zip,
  ].filter((line): line is string => line !== undefined && line !== '');

  /**
   * EXACTLY WHAT PRESSING "USE THESE VALUES" WOULD WRITE, computed once per render and read twice:
   * by {@link use}, which sends it, and by the warning below, which says what it costs.
   *
   * One expression rather than two, for the reason `acceptedFrame` calls `fillFromLookup` rather
   * than guessing at it: a warning derived from a second reading of the same inputs is a warning
   * that eventually describes a different acceptance from the one the button performs.
   */
  const trimmedState = state.trim().toUpperCase();
  const trimmedOrg = orgName.trim();
  const latText = lat.trim();
  const lonText = lon.trim();
  const pending: Record<string, string> = {
    ...(trimmedState === '' ? {} : { state: trimmedState }),
    ...(offersLicenseClass && licenseClass !== '' && isLicenseClass(licenseClass)
      ? { licenseClass }
      : {}),
    ...(offersOrgName && trimmedOrg !== '' ? { orgName: trimmedOrg } : {}),
    ...(latText === '' ? {} : { lat: latText }),
    ...(lonText === '' ? {} : { lon: lonText }),
  };
  const heldCoordinate = { lat: (held.lat ?? '').trim(), lon: (held.lon ?? '').trim() };
  const wouldReplace = replacedBy(pending, held);

  /**
   * The values, each labelled with WHO STATED IT.
   *
   * `fromSource` compares what is in the input against what the record returned, which is the
   * whole rule: the state box opens on the record's state, the class select opens on the record's
   * class WHEN THAT CLASS MAPS, and anything else in either of them is the user's own answer. The
   * licence class is where this matters most — the panel deliberately opens UNSET for the three
   * legacy classes and asks the user to choose, so a choice made there is theirs by construction
   * and `record.operClass` is `undefined` to compare against.
   */
  function use(): void {
    // The same condition the button is disabled on, enforced where it cannot be clicked around.
    if (substituted && !confirmed) return;
    // What the RECORD said, whatever the panel decided to do with it — `undefined` when there was
    // no coordinate to offer, so anything the applicant types is theirs by `fromSource`'s
    // comparison. A refused location states nothing here: the point is deliberately not carried on
    // a `'refused'` offer, so a number typed into these boxes beside one is the applicant's, which
    // is exactly what it is.
    const stated = geocode?.kind === 'offered' ? geocode.point : undefined;
    const statedLat = stated === undefined ? undefined : String(stated.latitude);
    const statedLon = stated === undefined ? undefined : String(stated.longitude);
    onUse({
      callsign: callsignFromRecord(record.callsign, typed),
      type: record.type,
      ...(trimmedState === '' ? {} : { state: fromSource(record.state, trimmedState) }),
      // `offersLicenseClass` GATES THE VALUE AS WELL AS THE SELECT, which it did not until
      // 2026-08-04 — its neighbour below has had the matching guard since it was written. Without
      // it, an ORGANIZATION lookup of a PERSON record emitted the class: the select is not
      // rendered, so nobody saw it, but `licenseClass` is seeded from `record.operClass` and left
      // there. An organisation profile has no such field, so the value went into a draft that could
      // never save it and the confirmation told a club that "License class" was one of the values
      // it had just been given — a field of somebody else's profile, named in a sentence about
      // theirs. A value the user was never shown may not leave the panel the user is looking at.
      ...(offersLicenseClass && licenseClass !== '' && isLicenseClass(licenseClass)
        ? { licenseClass: fromSource(record.operClass, licenseClass) }
        : {}),
      // A club record's NAME is the organisation name; a person's name is not, and the day this
      // panel offers `orgName` for a PERSON record is the day comparing against `record.name`
      // would attribute somebody's own name to callook.info as an organisation's.
      ...(offersOrgName && trimmedOrg !== ''
        ? { orgName: fromSource(record.type === 'CLUB' ? record.name : undefined, trimmedOrg) }
        : {}),
      /**
       * The coordinate, compared against what the record STATED rather than against what the
       * panel offered. Those differ on purpose for a PO box: the boxes opened empty, so a value
       * in them arrived by the applicant pressing "use the coordinate anyway" or by them typing
       * one. Pressing the button leaves exactly what callook stated in the box, and that IS the
       * source's value however it got there — the same rule `fromSource` already applies to a
       * state somebody edited and then edited back. What the applicant chose is whether to use
       * it, which is a different question from who said it, and the panel is where that choice
       * is visible.
       */
      ...(latText === '' ? {} : { lat: fromSource(statedLat, latText) }),
      ...(lonText === '' ? {} : { lon: fromSource(statedLon, lonText) }),
      // WHAT THE NUMBER IS, TRAVELLING WITH IT. Sent whenever the record stated an offerable
      // coordinate, whether or not the applicant took it: `fillFromLookup` attaches it only where
      // a value the record stated actually landed, so this is the fact and that is the judgement.
      ...(geocode?.kind === 'offered' ? { statedCoordinateFrom: geocode.from } : {}),
      provenance: {
        source: record.source,
        fetchedAt: record.fetchedAt,
        ...(record.ulsUrl === undefined ? {} : { ulsUrl: record.ulsUrl }),
      },
    });
  }

  return (
    <section className="callsign-panel" aria-labelledby={`${baseId}-found`}>
      <h2 id={`${baseId}-found`}>{frameFor('found', record.callsign).heading}</h2>

      {/* THE RECORD IS NOT FOR THE CALLSIGN THAT WAS TYPED, AND THAT IS SAID BEFORE ANYTHING
          ELSE ON THIS PANEL. The heading above already names the record's own callsign, but a
          person who typed K9OLD reads "FCC record for W5NEW" as the answer to their question
          unless the difference is pointed at. Accepting REPLACES the callsign on the form, so
          this is the one thing here that changes a value the user typed themselves. */}
      {substituted && (
        <p className="callsign-choose">
          You asked about <strong>{typed}</strong>. This record is for{' '}
          <strong>{record.callsign}</strong>. The FCC database answers a lookup of a superseded
          callsign with the licensee&rsquo;s current record, so this is usually the same operator
          under a callsign they no longer hold — and it is also what a typo that lands on somebody
          else&rsquo;s callsign looks like. GrantSpotter cannot tell those apart, so it will not
          choose for you: check the licensee name and address below, and if this record is yours,
          say so. Using it puts {record.callsign} in the callsign field in place of {typed}.
        </p>
      )}

      <dl className="callsign-facts">
        <dt>Licensee</dt>
        <dd>{record.name}</dd>

        <dt>Station</dt>
        <dd>{record.type === 'CLUB' ? 'Club station' : 'Individual'}</dd>

        <dt>Operator class</dt>
        <dd>{operatorClassText(record)}</dd>

        {record.grantDate !== undefined && (
          <>
            {/* NOT "licensed since", and the label is the entire reason this is safe to show.
                The grant date resets on every renewal and every vanity change, so a real
                record can show a 2019 grant beside a callsign the operator held for decades
                — and beside a PREVIOUS callsign of theirs. */}
            <dt>Current licence granted</dt>
            <dd>{formatDate(record.grantDate)}</dd>
          </>
        )}

        {record.expiryDate !== undefined && (
          <>
            <dt>Expires</dt>
            <dd>{formatDate(record.expiryDate)}</dd>
          </>
        )}

        {record.frn !== undefined && (
          <>
            <dt>FRN</dt>
            <dd>{record.frn}</dd>
          </>
        )}
      </dl>

      {addressLines.length > 0 && (
        <div className="callsign-address">
          <address>{addressLines.join('\n')}</address>
          <p className="callsign-note">
            The address is here so you can confirm this is your record.
            {/* WHAT THE RECORD SAYS, NOT WHAT THE CLASSIFICATION ASSUMED. This read "The FCC
                record gives a PO box rather than a street address." for any `isPoBox` record, and
                on K2CC — the fixture this codebase itself flags as ambiguous — it printed that
                directly beneath a rendered address reading "8 CLARKSON AVE, P.O. BOX 8550".
                Measured in Chromium on 2026-08-12: both strings on screen, one contradicting the
                other. `callook.ts`'s `geocodeSubject` says as much in its own words — "A LINE
                CARRYING BOTH IS A BOX … which of the two callook geocoded is not stated anywhere
                in the response" — so `isPoBox` means the line NAMES a box, and the cautious
                reading of an ambiguous line is deliberately not the same claim as "there is no
                street address here". The panel exists so the reader can confirm the record is
                theirs; telling them the record says something it does not is the one thing that
                cannot be allowed to happen on it. The caution is still stated, and stated as
                caution. */}
            {record.isPoBox
              ? ' The address line on this record names a PO box' +
                (geocode?.kind === 'offered'
                  ? ' — and a line that names one may name a street as well, with nothing in the ' +
                    'record saying which of the two the coordinate below was geocoded from. ' +
                    'GrantSpotter reads it as the box, which is the cautious way round rather ' +
                    'than something the record states.'
                  : '.')
              : ''}{' '}
            GrantSpotter does not store it: there is no field for a street address and nothing in
            the product reads one. What is kept is the state — eligibility rules are written in
            terms of states, ARRL Divisions and ARRL Sections —{' '}
            {/* THE THIRD BRANCH EXISTS BECAUSE THE FIRST ONE WAS LYING. "Nothing else from these
                lines" was printed over every record whose coordinate the server had refused, which
                from here looked identical to a record that stated none: measured on 2026-08-11
                against a contradictory body, which came back with no coordinate, no reason and no
                mention of either. A record that stated a location and had it refused is now told
                apart, because the server sends the reason. */}
            {geocode === undefined
              ? 'and nothing else from these lines.'
              : geocode.kind === 'offered'
                ? 'and, if you choose to use it below, callook’s coordinate for these lines. That ' +
                  'coordinate is derived from this address and points back at it, which is worth ' +
                  'knowing before you keep it.'
                : 'and nothing else. This record did state a position for these lines, and ' +
                  'GrantSpotter is not passing it on — the reason is below.'}
          </p>
        </div>
      )}

      <SourceLine record={record} />

      {record.type === 'CLUB' && clubNotice !== undefined && (
        <p className="callsign-choose">{clubNotice}</p>
      )}

      <div className="callsign-fill">
        <p className="callsign-note">
          Check these before you use them, and change anything that is wrong. They are the only
          values that leave this panel.
        </p>

        {/* WHAT IS ALREADY ON THE FORM, AND WHAT WOULD HAPPEN TO IT.
            This panel opens on the RECORD's answers, which is the offer it exists to make — and
            the form behind it may already hold the applicant's own. Measured on 2026-08-11: a
            profile holding a typed OH, 42.2936 and -83.7100 opened this panel on MI / 42.2808 /
            -83.743, never showed the applicant a single one of their own three values, contained
            no occurrence of "replace", "overwrit" or "already", and lost all three on one press.
            Recomputed from `pending` on every render, so editing a box back to what you had makes
            the warning go away rather than leaving a sentence about a loss that is no longer
            going to happen. */}
        {wouldReplace.length > 0 && (
          <p className="callsign-choose">
            {wouldReplace.length === 1
              ? 'Using these values replaces something you have already stated: '
              : 'Using these values replaces things you have already stated: '}
            {wouldReplace.map((entry, index) => (
              <span key={entry.key}>
                {index === 0 ? '' : '; '}
                {profileFieldLabel(entry.key, target)} is <strong>{entry.was}</strong> on your
                profile and would become <strong>{pending[entry.key]}</strong>
              </span>
            ))}
            . Clear a box to leave that field exactly as you have it. Nothing is saved until you
            press Save on the form itself.
          </p>
        )}

        <div className="callsign-fill-field">
          <label htmlFor={`${baseId}-state`}>State to fill in</label>
          <input
            id={`${baseId}-state`}
            type="text"
            maxLength={2}
            value={state}
            onChange={(event) => setState(event.target.value)}
          />
        </div>

        {offersLicenseClass && (
          <div className="callsign-fill-field">
            <label htmlFor={`${baseId}-class`}>License class to fill in</label>
            <select
              id={`${baseId}-class`}
              value={licenseClass}
              onChange={(event) => setLicenseClass(event.target.value)}
            >
              <option value="">Leave unset</option>
              {LICENSE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* The legacy classes, named. Novice, Advanced and Technician Plus are no longer
            issued and are still held, and every operator holding one would otherwise be
            silently rounded to a class the FCC never granted them. */}
        {offersLicenseClass && record.operClass === undefined && (
          <p className="callsign-choose">
            The record gives the operator class as <strong>{operatorClassText(record)}</strong>.
            GrantSpotter matches against None, Technician, General and Amateur Extra only, and
            that is not one of them, so nothing has been chosen for you — pick the class you want
            to be matched against, or leave it unset and answer it later.
          </p>
        )}

        {offersOrgName && (
          <div className="callsign-fill-field">
            <label htmlFor={`${baseId}-org`}>Organization name to fill in</label>
            <input
              id={`${baseId}-org`}
              type="text"
              value={orgName}
              onChange={(event) => setOrgName(event.target.value)}
            />
          </div>
        )}

        {/* THE COORDINATE. What it is a geocode of is stated before the boxes, never after: a
            person who reads only the first sentence should already know whether they are looking
            at a street or a post office. See `describeGeocode` for the decision behind each arm. */}
        {/* The wrapper carries no class of its own — the paragraphs inside carry the panel's
            existing styling, and a new class here would be a rule nothing in the CSS audits has
            measured. */}
        {geocode !== undefined && (
          <div>
            {geocode.kind === 'offered' && (
              <p className="callsign-note">
                This record states the position{' '}
                <strong>
                  {geocode.point.latitude}, {geocode.point.longitude}
                </strong>{' '}
                and the grid square <strong>{geocode.point.gridsquare}</strong>. The grid square is
                the more honest half — it names a box a few miles across rather than a point — and
                GrantSpotter has no field for one, so only the numbers can be kept.
              </p>
            )}
            <p className="callsign-choose">{geocode.note}</p>
            {geocode.kind === 'offered' && (
              <>
                {/* THE PRESS THAT REPLACES SOMETHING SAYS SO BEFORE IT IS PRESSED, and it names
                    both numbers, because the more accurate value here is very often the
                    applicant's: measured on 2026-08-11, an MIT student holding the campus
                    coordinate 42.3601, -71.0942 had it silently replaced by W1MX's post office
                    2.18 miles away — the record's number is not better, it is just the record's. */}
                {(heldCoordinate.lat !== '' || heldCoordinate.lon !== '') && (
                  <p className="callsign-choose">
                    You have already stated a position on this profile:{' '}
                    <strong>
                      {heldCoordinate.lat === '' ? '—' : heldCoordinate.lat},{' '}
                      {heldCoordinate.lon === '' ? '—' : heldCoordinate.lon}
                    </strong>
                    . Using the record&rsquo;s coordinate replaces it with{' '}
                    {coordinateSubjectLabel(geocode.from)}. Leave the boxes below empty and what you
                    stated stays exactly as it is.
                  </p>
                )}
                <div className="callsign-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setLat(String(geocode.point.latitude));
                      setLon(String(geocode.point.longitude));
                    }}
                  >
                    {heldCoordinate.lat === '' && heldCoordinate.lon === ''
                      ? 'Use this coordinate anyway'
                      : 'Use this coordinate anyway, in place of mine'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Always rendered, coordinate or not: a person who knows where they are may type it, and
            an applicant on a record with no `location` at all would otherwise have no way to
            answer a radius rule from this panel. */}
        <div className="callsign-fill-field">
          <label htmlFor={`${baseId}-lat`}>Latitude to fill in</label>
          <input
            id={`${baseId}-lat`}
            type="text"
            inputMode="decimal"
            value={lat}
            onChange={(event) => setLat(event.target.value)}
          />
        </div>

        <div className="callsign-fill-field">
          <label htmlFor={`${baseId}-lon`}>Longitude to fill in</label>
          <input
            id={`${baseId}-lon`}
            type="text"
            inputMode="decimal"
            value={lon}
            onChange={(event) => setLon(event.target.value)}
          />
        </div>

        <p className="callsign-note">
          A latitude and longitude are read for one purpose in GrantSpotter: rules of the form
          “within 250 miles of Seaford, Delaware”. Nothing else uses them, and leaving them empty
          leaves those rules unanswered rather than answered against you.
        </p>

        {/* The decision, beside the button it governs. A record found under a different callsign
            is the one answer this panel will not hand over unasked — and "Discard" is right
            there, which is the other half of making it a choice rather than an obstacle. */}
        {substituted && (
          <div className="callsign-confirm">
            <label htmlFor={`${baseId}-confirm`}>
              <input
                id={`${baseId}-confirm`}
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {/* Short, and about the DECISION rather than about the record: the paragraph at the
                  top of the panel is where the explanation belongs, and a label that repeats it
                  is a label nobody reads to the end. */}
              <span>
                Yes, this record is mine — use <strong>{record.callsign}</strong> in place of{' '}
                {typed}.
              </span>
            </label>
          </div>
        )}

        <div className="callsign-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={use}
            disabled={substituted && !confirmed}
          >
            Use these values
          </button>
          <button type="button" className="btn" onClick={onDiscard}>
            Discard
          </button>
        </div>
      </div>
    </section>
  );
}

/** Where the values came from, when, and the link that lets the user check us. */
function SourceLine({ record }: { record: CallsignRecord }): JSX.Element {
  return (
    <p className="callsign-source">
      Read from <strong>{record.source}</strong> on {formatDate(record.fetchedAt)}, which
      republishes the FCC&rsquo;s licence database.{' '}
      {record.ulsUrl === undefined ? (
        <>GrantSpotter did not receive a link to the FCC&rsquo;s own page for this record.</>
      ) : (
        <>
          Check it against the FCC yourself:{' '}
          <a href={record.ulsUrl} target="_blank" rel="noopener noreferrer">
            this record in the FCC ULS
          </a>
          .
        </>
      )}{' '}
      The grant date is when the current licence was granted — it resets on renewal and on a
      vanity change — so GrantSpotter never fills &ldquo;licensed since&rdquo; from it.
    </p>
  );
}
