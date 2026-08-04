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
 */

export type CallsignLookupStatus =
  /** A live, active record. */
  | 'found'
  /** The source has no active record for this callsign. */
  | 'not_found'
  /** Not a US prefix, so there is no FCC record to look up at all. NOT an error. */
  | 'not_us'
  /** The source is mid-import and cannot answer right now. */
  | 'updating'
  /** Network failure, timeout, blocked host, malformed response. */
  | 'unavailable';

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
