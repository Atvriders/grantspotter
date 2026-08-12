import type { LicenseClass } from '@grantspotter/core';

export type CallsignLookupStatus =
  | 'found'        // a live, active record
  | 'not_found'    // the source has no active record for this callsign
  | 'not_us'       // a callsign, issued outside the FCC's records; we cannot look it up at all
  /*
   * What was typed is not a callsign in any administration's format, so nothing was asked and
   * NOTHING IS CLAIMED ABOUT WHERE IT IS FROM. Distinct from `not_us` since 2026-08-09: both were
   * that status, so `N0CALLXX` — a US prefix with two suffix letters too many — was answered with
   * the sentence written to reassure international operators, and told an American their callsign
   * was not American. One value, two meanings; see `shape.ts` for the split.
   */
  | 'malformed'
  | 'updating'     // the source is mid-import and cannot answer right now
  | 'unavailable'; // network failure, timeout, blocked host, malformed response

/**
 * WHAT THE COORDINATES IN A CALLOOK RECORD ARE, WHICH IS NOT WHERE THE STATION IS.
 *
 * Every successful lookup carries a `location`: a latitude, a longitude and a Maidenhead grid
 * square. Not one of the three is a measurement of a station, an antenna, a campus or an operator.
 * The record holds ONE address — `line1`, `line2` and an `attn` line, which is the shape of
 * somewhere post is sent — and the coordinate is callook's geocode of it. So it is exactly as close
 * to the radio as the mail is, and no closer.
 *
 * `fixtures/callook/01-callook-info-w1mx-json.json` is the whole argument in one record, and it is
 * the record this product exists for. M I T RADIO SOCIETY — a collegiate club station — files
 * `P.O. BOX 51421, BOSTON, MA 02205-1421`, and callook answers `42.34991837, -71.0538559`. The
 * coordinate is where the address says it is: Boston. The club is at MIT, across the river in
 * Cambridge. Each of the three real captures states a point that falls inside the grid square the
 * same record states, so the two halves agree with each other — and on this record they agree about
 * a post office.
 *
 * THAT AGREEMENT IS AN INVARIANT OF THIS TYPE AND NOT AN OBSERVATION ABOUT THREE FILES. Since
 * 2026-08-11 `callook.ts` asks `core`'s `checkCoordinateAgainstLocator` whether the stated point
 * falls in the stated square and keeps NOTHING when it does not, so a consumer holding a
 * {@link MailingGeocode} is holding a record that agreed with itself. It has no marked-inconsistent
 * state to handle, because a state whose every handler would say "treat this as absent" is better
 * expressed by the field being absent. What consistency does NOT mean is correctness: two fields
 * computed from one wrong answer agree perfectly, which is why the `0.0 / 0.0 / JJ00aa` placeholder
 * needs a rule of its own and gets one.
 *
 * AND IT IS STATED TO EIGHT DECIMAL PLACES. One unit in the eighth decimal of a latitude is 1.1 mm
 * (measured here with the haversine in `core/geo.ts`). A millimetre, on a post office box. The grid
 * square is the honest half of the same answer: `FN42li` says "somewhere in this box" out loud, and
 * that box measures 2.9 by 4.3 miles at that latitude (measured the same way).
 *
 * WHY THIS IS A TYPE AND NOT A PAIR OF NUMBERS ON THE RECORD. `matcher` decides radius eligibility
 * from a latitude and a longitude (`evaluateGeo`, `case 'radius'`). A `latitude` and a `longitude`
 * sitting on {@link CallsignRecord} are one assignment away from a profile's `lat` and `lon`, and
 * that assignment prints a confident ELIGIBLE or NOT ELIGIBLE about somebody's post office. So the
 * pair is not reachable without saying what it is a geocode OF: `geocodedFrom` discriminates, the
 * arms hold the point under DIFFERENT KEYS, and `geocode.poBox` does not typecheck until the
 * consumer has narrowed to the arm that has one. Narrowing is the moment they find out what they
 * are holding, and tsc — not a reviewer, and not a comment like this one — is what makes them do it.
 *
 * This type does not decide whether a mail-drop coordinate may prefill a profile, or feed a radius
 * test, or be shown with a caveat. Those are the profile's judgement and the matcher's. What it
 * decides is that neither of them can make that judgement BY ACCIDENT — the same refusal, for the
 * same reason, as the legacy licence classes that leave `operClass` undefined rather than guess
 * upward into a verdict the holder cannot enter.
 */
export type GeocodedFrom =
  /** `address.line1` is a street address naming no box. Still the MAIL, never the station. */
  | 'street_address'
  /** `address.line1` names a post office box, so the point is a mail drop. */
  | 'po_box'
  /**
   * The record carried no address line at all (about 1.3% do not) and yet stated a coordinate, so
   * there is nothing here to attribute it to. The value is kept and the claim is withheld — the
   * same division as `operClassRaw` beside an undefined `operClass`.
   */
  | 'address_not_stated';

/**
 * A point exactly as the record stated it, all three parts or not at all.
 *
 * Numbers, parsed from the strings callook sends (`"41.714707"`, never `41.714707`). The grid
 * square is kept exactly as it arrived — trimmed, as every field here is, and otherwise untouched,
 * upper and lower case included — for the same reason the ZIP keeps its hyphen or its absence:
 * re-casing it would be this software presenting its own tidy-up as something the record said. A
 * locator is the same locator in any case, so compare these case-insensitively.
 */
export interface GeocodedPoint {
  /** Degrees north, `-90` to `90`. */
  latitude: number;
  /** Degrees east, `-180` to `180`. */
  longitude: number;
  /**
   * A 4-, 6- or 8-character Maidenhead locator, e.g. `FN31pr`. Case as the record printed it.
   *
   * Two characters is refused rather than kept coarsely, and eight is read rather than refused as
   * ambiguous; both of those are decisions about this source, argued at `MINIMUM_LOCATOR_PRECISION`
   * in `callook.ts`. The box this names contains the latitude and longitude above, or has them
   * exactly on its edge — see the invariant in {@link GeocodedFrom}, and the boundary case in
   * `statedPoint` — so the two fields are one place stated twice, coarsely and finely, rather than
   * two places to choose between.
   */
  gridsquare: string;
}

/**
 * A coordinate callook geocoded from the licensee's MAILING address, filed under what it is.
 *
 * Read it with a `switch` on `geocodedFrom`; there is no other way in, which is the point. See
 * {@link GeocodedFrom} for what these coordinates are and why they are behind a discriminant.
 */
export type MailingGeocode =
  | { geocodedFrom: 'street_address'; mailingAddress: GeocodedPoint }
  | { geocodedFrom: 'po_box'; poBox: GeocodedPoint }
  | { geocodedFrom: 'address_not_stated'; unattributed: GeocodedPoint };

/**
 * THE RECORD STATED A LOCATION AND NONE OF IT IS BEING PASSED ON — AND THAT FACT IS ITSELF NEWS.
 *
 * WHY THIS IS NOT THE "MARK IT AND PASS IT ON" OPTION `statedPoint` REJECTS, which is the first
 * thing to check when reading it. That option was to send the COORDINATE with a flag beside it, and
 * the argument against it stands: no consumer can choose a half when nothing says which half is
 * wrong, every exhaustive `switch` downstream grows a case whose body is "do what you do when there
 * is nothing", and a flag is a thing a consumer can forget to read. Nothing here sends a
 * coordinate. There is no {@link MailingGeocode} to narrow, no `latitude` to reach, and the
 * invariant that gained — the PRESENCE of a `MailingGeocode` means the record agreed with itself —
 * is untouched.
 *
 * WHAT IT SENDS IS THE REASON THE BOXES ARE EMPTY. Measured on 2026-08-11 against a running server:
 * a body stating latitude 10, longitude 10 and gridsquare `FN31pr` came back as
 * `{"status":"found","record":{…}}` with no `mailingGeocode` key, no log line and nothing on
 * screen — indistinguishable, from the browser, from `person-no-address.json`, whose `location` is
 * three empty strings. Those are not the same event and the profile editor was asserting they were:
 * its address note read "What is kept is the state … and nothing else from these lines", which is
 * false about a record that stated a coordinate and had it refused. Silence about a refusal is a
 * claim that there was nothing to refuse.
 *
 * The reasons are separate values rather than one `'refused'` because they are separate upstream
 * defects with separate sentences, on the same principle that split `malformed` out of `not_us`:
 * "these two halves of your record disagree" and "GrantSpotter could not read the grid square" are
 * different things to be told, and only one of them is a fault in the record.
 */
export type GeocodeRefusal =
  /**
   * The stated coordinate falls outside the stated grid square. Two statements about one station,
   * disagreeing, with nothing in the response to say which is wrong.
   */
  | {
      refused: 'contradicted';
      /** The locator the record stated, exactly as it printed it. */
      gridsquare: string;
      /** The locator the stated coordinate actually falls in, at the same precision. */
      containingLocator: string;
    }
  /** The grid square could not be read as a locator at all, so nothing corroborates the pair. */
  | { refused: 'unreadable_locator'; gridsquare: string; because: string }
  /**
   * A two-character locator: a box 10° by 20°, too coarse to check a coordinate against. See
   * `MINIMUM_LOCATOR_PRECISION`.
   */
  | { refused: 'locator_too_coarse'; gridsquare: string }
  /**
   * `0.0 / 0.0 / JJ00aa` — null island, which is an absence written in the shape of an answer. The
   * two halves corroborate each other perfectly, because both were computed from the same absence.
   */
  | { refused: 'placeholder' }
  /**
   * Some of the three parts arrived and some did not, or one of them was not a number this parser
   * would accept. All three or none, which is this file's rule for every compound field.
   */
  | { refused: 'incomplete' };

export interface CallsignRecord {
  callsign: string;              // normalised, upper case
  type: 'PERSON' | 'CLUB';
  name: string;                  // the licensee name as the record prints it
  operClass?: LicenseClass;      // ONLY when it maps exactly; see the legacy-class rule
  operClassRaw?: string;         // always kept, whatever the source said
  addressLine1?: string;
  city?: string;
  state?: string;                // two-letter
  zip?: string;
  isPoBox: boolean;
  /**
   * Where the MAIL goes, geocoded by callook — never where the station is, and typed so that it
   * cannot be mistaken for it. Present only when the record stated a whole readable point; see
   * {@link GeocodedFrom}, which is the paragraph to read before using any of these numbers.
   */
  mailingGeocode?: MailingGeocode;
  /**
   * The record stated a location and it was not kept — never set beside a `mailingGeocode`, and
   * never set for a record that stated no location at all. See {@link GeocodeRefusal}, which is
   * about telling a person why their coordinate boxes are empty rather than about handing anything
   * a coordinate.
   */
  geocodeRefusal?: GeocodeRefusal;
  grantDate?: string;            // ISO. This is NOT "first licensed" — see below.
  expiryDate?: string;
  frn?: string;
  ulsUrl?: string;               // a link the user can open to check us
  source: 'callook.info';
  fetchedAt: string;             // ISO
}

export interface CallsignLookupResult {
  status: CallsignLookupStatus;
  record?: CallsignRecord;       // present only when status === 'found'
  message?: string;              // human-readable reason for every non-'found' status
}
