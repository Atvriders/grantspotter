import { useId, useState, type ReactNode } from 'react';
import { checkCoordinateAgainstLocator, type LicenseClass } from '@grantspotter/core';
import { ApiError } from '../api/client.js';
import {
  postCallsignLookup,
  type CallsignLookupResult,
  type CallsignRecord,
  type GeocodedPoint,
} from '../api/callsign.js';
import {
  callsignFromRecord,
  fillFromLookup,
  fromSource,
  type AcceptedCallsign,
} from '../lib/callsignFill.js';
import { profileFieldLabelList } from '../lib/profileFields.js';
import { formatDate } from '../lib/trust.js';
import './callsign.css';

/**
 * "LOOK UP MY CALLSIGN", AND THE RECORD IT PUTS ON SCREEN.
 *
 * One control, used beside the callsign field on the profile editor and on the first-run
 * setup screen. It is the only place in this product where a value about the USER arrives
 * from somewhere other than the user, so the rules it keeps are the whole point of it:
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
 *  7. IT WILL NOT PRE-FILL A POST OFFICE AS A LOCATION. Every successful lookup carries a
 *     latitude, a longitude and a grid square, and every one of them is callook's geocode of
 *     the licensee's MAILING ADDRESS. Where that address is a street the panel opens with the
 *     coordinate in the boxes; where it is a PO box — which is what two of the three real
 *     captures are, both of them collegiate clubs — the boxes open EMPTY, the coordinate is
 *     shown for what it is, and filling it in takes a second, separate press. The reasoning is
 *     the same as rule 5's, and so is the shape: the source stated something, it does not mean
 *     what a reader would take it to mean, so the software declines to choose and says why.
 *     See {@link describeGeocode}, which is where that decision is written down.
 */

export type CallsignTarget = 'student' | 'organization';

export interface CallsignLookupProps {
  /** The callsign currently typed in the field this control sits beside. */
  callsign: string;
  /**
   * Which profile the accepted values would land on. It decides which fields this panel
   * offers: an organisation profile has no licence class, and a person has no orgName.
   */
  target: CallsignTarget;
  onAccept: (values: AcceptedCallsign) => void;
  /** First run only: the one-time setup token, which is the caller's only credential. */
  setupToken?: string;
  /**
   * What this host can and cannot do with a CLUB record. It differs per screen — the profile
   * editor has an organisation tab to send the user to, the setup screen does not — so the
   * host supplies the sentence rather than this component guessing at it.
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
 * What the values that just left this panel were attributed to — the two lists `fillFromLookup`
 * splits them into, kept so the confirmation can be built from them.
 */
interface Attribution {
  /** Profile fields carrying callook.info's name, because the record itself stated them. */
  marked: string[];
  /** Profile fields written with no mark at all: the applicant's own, however they got there. */
  unmarked: string[];
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
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'answered'; result: CallsignLookupResult }
  | { kind: 'accepted'; record: CallsignRecord; attribution: Attribution }
  /** The request itself did not complete: no answer was received, so none is reported. */
  | { kind: 'failed'; message: string };

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
        body:
          'The source rebuilds itself from the FCC once a day and cannot answer while it does. ' +
          'This says nothing about your callsign — it is not missing, it is unreadable for a few ' +
          'minutes. Try again shortly, or fill the form in yourself.',
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
  const { marked, unmarked, unmarkable, derived, unfillable } = attribution;
  const one = marked.length === 1;
  const mine =
    unmarked.length === 0
      ? ''
      : ` ${profileFieldLabelList(unmarked, kind)} ${unmarked.length === 1 ? 'carries' : 'carry'} no mark: ` +
        `the record either did not state ${unmarked.length === 1 ? 'it' : 'them'}, or you changed ` +
        `what it said, so ${unmarked.length === 1 ? 'it is yours' : 'they are yours'}.`;
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
        `${unmarkable.length === 1 ? 'carries no mark' : 'carry no marks'}: GrantSpotter can ` +
        'record where a callsign, a state or a licence class came from, and has nowhere to record ' +
        `that about a coordinate. Once saved, ${unmarkable.length === 1 ? 'it reads' : 'they read'} ` +
        `exactly like ${unmarkable.length === 1 ? 'a value' : 'values'} you stated.`;
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
        `${one ? 'it' : 'them'}.${mine}${fetched}${worked}${elsewhere} Nothing has been saved yet.`,
    };
  }

  return {
    heading: 'Filled in — none of it attributed to the FCC record',
    body:
      (unmarked.length === 0
        ? ''
        : `${profileFieldLabelList(unmarked, kind)} went onto the form as ` +
          `${unmarked.length === 1 ? 'your own value' : 'your own values'}. `) +
      'GrantSpotter puts callook.info’s name on a field only where the record itself stated what ' +
      'is now in it, and that is true of none of these — either the record had nothing to state, ' +
      `or you changed what it said.${fetched}${worked}${elsewhere} Nothing has been saved yet.`,
  };
}

/**
 * WHETHER A COORDINATE MAY OPEN IN THE BOX, AND WHAT THE PERSON IS TOLD ABOUT IT.
 *
 * THE DECISION, AND THE ARGUMENT FOR IT.
 *
 * callook geocodes ONE thing: the address on the licence, which is where the licensee's post goes.
 * `matcher` reads latitude and longitude for exactly one purpose — radius eligibility — so the
 * only consequence a coordinate has in this product is a verdict about the place it names. Two of
 * the three real captures in `fixtures/callook/` resolve to `po_box`, and both are collegiate
 * clubs: M I T Radio Society files P.O. BOX 51421, BOSTON, and callook answers with a point in
 * Boston, to eight decimal places, while the club is across the river in Cambridge.
 *
 * The three options were: never fill it, fill it with a caveat, or fill it and exclude it from
 * radius matching. The third is not available honestly and saying why matters more than the
 * choice: excluding it would have to happen in `matcher`, the stored profile has nowhere to record
 * that a coordinate is a mail drop (`StudentProfile.lat` is a bare number and the zod schema
 * strips anything else), and a browser-side flag would be gone by the next page load while the
 * number stayed. A caveat alone fails for the same reason — the caveat is not stored either, and
 * after one save the post office is indistinguishable from a measured position.
 *
 * So the answer is per-arm, and it is a DIFFERENCE THE PERSON CAN SEE:
 *
 *   street_address     the boxes open with the coordinate in them. It is still the mail rather
 *                      than the station, and the panel says so, but a street address is a
 *                      defensible answer to "roughly where are you" and the applicant is looking
 *                      at both the address and the number before anything is written.
 *   po_box             the boxes open EMPTY and the coordinate is shown beside a sentence naming
 *                      it as a post office. A second, separate press fills it in. Refusing
 *                      outright was the other candidate and was rejected: this is the median
 *                      user, radius rules are the only thing lat/lon feed, and a club that knows
 *                      its post office is three miles from its shack is better served by an
 *                      informed yes than by a blanket no. What it must not be is silent.
 *   address_not_stated the same withholding, for a stronger reason — the record carried no
 *                      address at all, so nothing here says what the point is a geocode OF.
 *
 * AND THE MARGINS ARE NOT ACADEMIC. Measured with this repository's own `haversineMiles` against
 * the radius centres in the seed corpus: W1AW's own street-address coordinate is 261.23 miles from
 * Seaford, Delaware, against a 250-mile rule — 11.23 miles outside. A mail drop in the next town
 * is the same order of magnitude as that margin.
 *
 * THE RECORD IS ALSO CHECKED AGAINST ITSELF, HERE, EVEN THOUGH THE SERVER NOW DOES IT TOO. A
 * callook `location` carries a coordinate AND a grid square, which are two independent statements
 * about one station, and `checkCoordinateAgainstLocator` in core is what compares them. Since
 * `5d411a4` the server's parser asks the same question and emits no `mailingGeocode` at all when
 * the two halves disagree, so this branch is unreachable from a healthy GrantSpotter server — and
 * it stays, for the reason `KNOWN_STATUSES` stays a few lines up. `api/callsign.ts` is a HAND COPY
 * of a type on the other side of a process boundary; what actually arrives is whatever JSON the
 * connection produces, and this app is served behind a tunnel where a proxy, a stale build or a
 * captive portal can answer 200 with something else. The cost of asking is one function call over
 * numbers already in memory. The cost of not asking, if the invariant ever stops holding, is a
 * confident radius verdict computed from a coordinate 2,900 miles from where the same record says
 * the station is. Its copy is exercised in `CallsignLookup.test.tsx` rather than merely present.
 */
export type GeocodeOffer =
  /** In the boxes when the panel opens. */
  | { kind: 'prefill'; point: GeocodedPoint; note: string }
  /** Shown, not filled. One press puts it in the boxes. */
  | { kind: 'withheld'; point: GeocodedPoint; note: string }
  /** Shown as a fault in the record. No press fills it. */
  | { kind: 'contradicted'; point: GeocodedPoint; note: string };

export function describeGeocode(record: CallsignRecord): GeocodeOffer | undefined {
  const geocode = record.mailingGeocode;
  if (geocode === undefined) return undefined;

  // The exhaustive switch is the point of the type: there is no way to reach the numbers without
  // first saying which of the three things they are, so the paragraph above cannot be skipped by
  // somebody who only wanted a latitude.
  const [point, note]: [GeocodedPoint, string] = ((): [GeocodedPoint, string] => {
    switch (geocode.geocodedFrom) {
      case 'street_address':
        return [
          geocode.mailingAddress,
          'callook geocoded the street address above. That is where the licence receives post, ' +
            'which is not necessarily where the station or the antenna is — but it is a place ' +
            'rather than a mail drop, so it is offered here filled in. Change it or clear it if ' +
            'it is not where you want radius rules answered about.',
        ];
      case 'po_box':
        return [
          geocode.poBox,
          'The address on this licence is a PO box, so this coordinate is a POST OFFICE — not the ' +
            'station, not the antenna, and not the campus. GrantSpotter has left the boxes empty ' +
            'rather than fill them with it. Latitude and longitude are read for one thing only: ' +
            'rules of the form “within 70 miles of Schenectady”, and a post office can be on the ' +
            'other side of that line from the club it serves. Use it if it is close enough for ' +
            'you to be happy answering those with it.',
        ];
      case 'address_not_stated':
        return [
          geocode.unattributed,
          'This record states a coordinate and no address at all, so nothing here says what the ' +
            'point is a geocode of. GrantSpotter is not going to fill in a location it cannot ' +
            'attribute to anything; the number is here because the record contains it, and the ' +
            'judgement about whether it is yours is yours to make.',
        ];
    }
  })();

  const agreement = checkCoordinateAgainstLocator(point.latitude, point.longitude, point.gridsquare);
  if (agreement.status === 'outside') {
    return {
      kind: 'contradicted',
      point,
      note:
        `This record contradicts itself: it states the grid square ${point.gridsquare}, and the ` +
        `coordinate beside it falls in ${agreement.containingLocator} instead. Those are two ` +
        'statements about one station and they disagree, so GrantSpotter is not offering either ' +
        'of them — there is no honest way to pick the right one. Type a location in yourself if ' +
        'you need radius rules answered.',
    };
  }
  if (agreement.status === 'unknown') {
    return {
      kind: 'contradicted',
      point,
      note:
        `GrantSpotter could not read ${JSON.stringify(point.gridsquare)} as a grid square, so the ` +
        'coordinate in this record could not be checked against it — and a coordinate nothing ' +
        'corroborates is not something to fill a form in with. ' +
        `(${agreement.rejection.message}.) Type a location in yourself if you need radius rules ` +
        'answered.',
    };
  }

  return { kind: geocode.geocodedFrom === 'street_address' ? 'prefill' : 'withheld', point, note };
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
  target,
  onAccept,
  setupToken,
  clubNotice,
}: CallsignLookupProps): JSX.Element {
  const baseId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const typed = callsign.trim().toUpperCase();

  async function run(): Promise<void> {
    setPhase({ kind: 'busy' });
    try {
      const result = await postCallsignLookup({
        callsign: typed,
        ...(setupToken === undefined || setupToken === '' ? {} : { setupToken }),
      });
      setPhase(
        KNOWN_STATUSES.has(result.status)
          ? { kind: 'answered', result }
          : {
              kind: 'failed',
              message:
                'The API answered with something that is not a lookup result, so nothing is ' +
                'being reported about this callsign. Something other than GrantSpotter — a ' +
                'proxy, tunnel, or sign-in page — may have answered instead.',
            },
      );
    } catch (err) {
      // A refusal or an unreachable API is not an answer about the callsign, and must not be
      // reported as one. The server's sentence is carried through — for a rate limit that
      // sentence is the whole explanation.
      setPhase({
        kind: 'failed',
        message:
          err instanceof ApiError && err.status !== 0
            ? err.message
            : 'The GrantSpotter API could not be reached, so the lookup never ran.',
      });
    }
  }

  const answered = phase.kind === 'answered' ? phase.result : null;
  const record = answered?.status === 'found' ? (answered.record ?? null) : null;

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
      case 'accepted':
        // The same heading the panel below shows, so the one user who cannot see it is not told
        // that a record filled in values the record stated none of.
        return `${acceptedFrame(phase.attribution, target).heading}. Nothing has been saved yet.`;
      case 'failed':
        return `The lookup did not run. ${phase.message}`;
      case 'answered': {
        const found = phase.result.record;
        if (found === undefined) {
          return frameFor(
            phase.result.status === 'found' ? 'unavailable' : phase.result.status,
            typed,
          ).heading;
        }
        const substituted =
          found.callsign === typed
            ? ''
            : ` This record is for ${found.callsign}, not the ${typed} you asked about.`;
        return (
          `${frameFor('found', found.callsign).heading}: ${found.name}.${substituted}` +
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
          <h2 id={`${baseId}-failed`}>The lookup did not run</h2>
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
             there is nothing to show and nothing is claimed about the callsign. */
          frame={frameFor(answered.status === 'found' ? 'unavailable' : answered.status, typed)}
          message={answered.message}
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
                unmarkable: fill.unmarkable,
                derived: fill.derived,
                unfillable: fill.unfillable,
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
  target,
  clubNotice,
  onUse,
  onDiscard,
}: {
  baseId: string;
  record: CallsignRecord;
  /** What the user asked about, normalised — which is not always what the record is for. */
  typed: string;
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
   * The coordinate boxes, seeded by {@link describeGeocode} and by nothing else. `'prefill'` is
   * the only arm that opens with a value in it — the same one-line expression of a rule as the
   * licence-class seed above, and for the same reason: an empty box is what makes the person the
   * one who decides.
   */
  const geocode = describeGeocode(record);
  const [lat, setLat] = useState(
    geocode?.kind === 'prefill' ? String(geocode.point.latitude) : '',
  );
  const [lon, setLon] = useState(
    geocode?.kind === 'prefill' ? String(geocode.point.longitude) : '',
  );
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
    const trimmedState = state.trim().toUpperCase();
    const trimmedOrg = orgName.trim();
    const latText = lat.trim();
    const lonText = lon.trim();
    // What the RECORD said, whatever the panel decided to do with it — `undefined` when there was
    // no coordinate, so anything the applicant types is theirs by `fromSource`'s comparison.
    const statedLat = geocode === undefined ? undefined : String(geocode.point.latitude);
    const statedLon = geocode === undefined ? undefined : String(geocode.point.longitude);
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
            {record.isPoBox ? ' The FCC record gives a PO box rather than a street address.' : ''}{' '}
            GrantSpotter does not store it: there is no field for a street address and nothing in
            the product reads one. What is kept is the state — eligibility rules are written in
            terms of states, ARRL Divisions and ARRL Sections —{' '}
            {geocode === undefined
              ? 'and nothing else from these lines.'
              : 'and, if you use it below, callook’s coordinate for these lines. That coordinate ' +
                'is derived from this address and points back at it, which is worth knowing ' +
                'before you keep it.'}
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
            <p className="callsign-note">
              This record states the position{' '}
              <strong>
                {geocode.point.latitude}, {geocode.point.longitude}
              </strong>{' '}
              and the grid square <strong>{geocode.point.gridsquare}</strong>. The grid square is
              the more honest half — it names a box a few miles across rather than a point — and
              GrantSpotter has no field for one, so only the numbers can be kept.
            </p>
            <p className={geocode.kind === 'prefill' ? 'callsign-note' : 'callsign-choose'}>
              {geocode.note}
            </p>
            {geocode.kind === 'withheld' && (
              <div className="callsign-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setLat(String(geocode.point.latitude));
                    setLon(String(geocode.point.longitude));
                  }}
                >
                  Use this coordinate anyway
                </button>
              </div>
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
