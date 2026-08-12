import type { LicenseClass } from '@grantspotter/core';
import { apiSend } from './client.js';

/**
 * THE CALLSIGN LOOKUP, FROM THE BROWSER.
 *
 * Source of truth for every type below is `packages/server/src/callsign/types.ts`. They are
 * restated here for exactly the reason `client.ts` restates the API error codes: the import
 * direction is one-way — web may import from core, never from server. `LicenseClass` itself
 * is imported from core rather than re-spelled, because core is shared and its four literals
 * are the ones the matcher compares against.
 *
 * A HAND-COPIED TYPE DRIFTS, AND THIS ONE HAD, TWICE OVER. The server sends the whole record with
 * `res.json(result)`, so anything it adds is already in the browser's hands — invisibly, because
 * the only thing that decides what the browser can SEE is the declaration below. On 2026-08-11 it
 * was missing `malformed` (a status added 2026-08-09, whose panel copy exists and was reachable
 * only because `CallsignLookup.tsx` had widened the union locally) and the whole of
 * `mailingGeocode` — the coordinate every successful lookup carries. Neither absence broke a
 * build; both simply hid a field. `callsign.test.ts` now reads BOTH files and compares the
 * declarations, so the next addition to the server's record fails this package's suite by name
 * instead of going unnoticed until somebody greps for it.
 */

export type CallsignLookupStatus =
  /** A live, active record. */
  | 'found'
  /** The source has no active record for this callsign. */
  | 'not_found'
  /** Not a US prefix, so there is no FCC record to look up at all. NOT an error. */
  | 'not_us'
  /**
   * What was typed is not a callsign in any administration's format, so nothing was asked and
   * nothing is claimed about where it is from. Distinct from `not_us` since 2026-08-09: telling an
   * American with one letter too many that their callsign is not American is a claim nobody made.
   */
  | 'malformed'
  /** The source is mid-import and cannot answer right now. */
  | 'updating'
  /** Network failure, timeout, blocked host, malformed response. */
  | 'unavailable';

/**
 * WHAT THE COORDINATE IS A GEOCODE OF — which is the licensee's MAIL, never their station.
 *
 * The full argument is in the server's `types.ts`; the part the browser has to act on is that
 * `po_box` means the point is a post office. `matcher` reads latitude and longitude for radius
 * eligibility and nothing else, so a mail-drop coordinate silently prefilled produces a confident
 * ELIGIBLE or NOT ELIGIBLE about somebody's post office box. Two of the three real captures in
 * `fixtures/callook/` are `po_box`, and both are collegiate clubs — the median user here.
 */
export type GeocodedFrom = 'street_address' | 'po_box' | 'address_not_stated';

/** A point exactly as the record stated it, all three parts or not at all. */
export interface GeocodedPoint {
  latitude: number;
  longitude: number;
  /** A 4- or 6-character Maidenhead locator, in the case the record printed it. */
  gridsquare: string;
}

/**
 * The arms hold the point under DIFFERENT KEYS on purpose, and the mirror keeps that: reaching a
 * coordinate means narrowing on `geocodedFrom`, and narrowing is the moment the reader finds out
 * they are holding a post office. Read it with an exhaustive `switch`.
 */
export type MailingGeocode =
  | { geocodedFrom: 'street_address'; mailingAddress: GeocodedPoint }
  | { geocodedFrom: 'po_box'; poBox: GeocodedPoint }
  | { geocodedFrom: 'address_not_stated'; unattributed: GeocodedPoint };

export interface CallsignRecord {
  callsign: string;
  type: 'PERSON' | 'CLUB';
  name: string;
  /**
   * Present ONLY when the source's operator class maps exactly onto one of core's four.
   * Advanced, Novice and Technician Plus are still held by a substantial number of
   * operators and map onto none of them, so they arrive with this field absent and
   * `operClassRaw` set — the user picks, and GrantSpotter never guesses upward.
   */
  operClass?: LicenseClass;
  operClassRaw?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zip?: string;
  isPoBox: boolean;
  /**
   * Where the MAIL goes, geocoded by callook — never where the station is. Present only when the
   * record stated a whole readable point. See {@link GeocodedFrom} before using any of it.
   */
  mailingGeocode?: MailingGeocode;
  /**
   * When the CURRENT licence was granted. It is NOT "first licensed": it resets on every
   * renewal and on every vanity callsign change. Nothing here may feed `licensedSince`.
   */
  grantDate?: string;
  expiryDate?: string;
  frn?: string;
  ulsUrl?: string;
  source: 'callook.info';
  fetchedAt: string;
}

export interface CallsignLookupResult {
  status: CallsignLookupStatus;
  /** Present only when `status === 'found'`. */
  record?: CallsignRecord;
  /** A human-readable reason for every non-`found` status. */
  message?: string;
}

export interface CallsignLookupRequest {
  callsign: string;
  /**
   * FIRST RUN ONLY. Before any account exists there is no session to authorise with, so the
   * one-time setup token the operator read out of the server log is the caller's credential.
   * The server checks it WITHOUT consuming it — spending it on a lookup would leave the
   * operator holding a token that no longer creates the administrator account.
   */
  setupToken?: string;
}

/**
 * Ask the server to look this callsign up. User-initiated only, and rate-limited per session
 * at the other end: it is one person pressing a button, not a batch.
 */
export async function postCallsignLookup(
  body: CallsignLookupRequest,
): Promise<CallsignLookupResult> {
  return apiSend<CallsignLookupResult>('POST', '/api/callsign/lookup', body);
}
