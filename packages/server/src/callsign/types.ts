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
