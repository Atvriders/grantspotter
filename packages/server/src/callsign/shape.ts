import { callDistrictFromCallsign } from '@grantspotter/core';

/**
 * WHAT THE STRING IS, BEFORE ANYBODY ASKS A SOURCE ABOUT IT.
 *
 * THE DEFECT THIS MODULE EXISTS TO CLOSE. `callDistrictFromCallsign` answers `undefined` for two
 * completely different facts — "this is a callsign, issued somewhere the FCC is not" and "this is
 * not a callsign at all" — and `callook.ts` used to read that one value as the first of them. So
 * `N0CALLXX` (a US prefix, with six suffix letters where the format allows four) was answered with
 * "GrantSpotter can only look up United States callsigns automatically… your licence is no less
 * valid for being issued somewhere this lookup cannot reach". Measured against the running server
 * on 2026-08-09, `POST /api/callsign/lookup` with `N0CALLXX` returned `status: "not_us"`; so did
 * `W1AW/4`, `KANSAS`, `W5X5`, `K` and `???`. A person who typed one letter too many was told their
 * American callsign was not American, and told it in the reassuring words written for somebody
 * else. This is the third time in this codebase that one value has carried two meanings (see
 * `unmarked` in `web/src/lib/callsignFill.ts`), so what is fixed here is the CONFLATION: three
 * answers, named, rather than one absence read as whichever meaning the caller assumed.
 *
 * WHY IT IS NOT FIXED IN `core/src/geo.ts`. `callDistrictFromCallsign` has another caller —
 * `evaluateGeo`'s `call_district` branch, which reads `undefined` as "this person's district is
 * unknown" and answers `{ status: 'unknown', missing: ['callDistrict'] }`. That reading is correct
 * for BOTH meanings and would gain nothing from the split, so the distinction is added ALONGSIDE
 * geo's answer rather than by changing its shape.
 *
 * AND IT STILL DOES NOT MINT A SECOND OPINION ABOUT WHICH PREFIXES ARE AMERICAN. That rule lives in
 * `geo.ts` (the whole K/N/W blocks, AA-AL of the A block) and is asked, not restated — including by
 * {@link hasUsPrefix}, which asks it about a probe rather than re-deriving it. A copy of the block
 * list here would be a second thing to keep true of the ITU's table.
 */

/** What the person typed, as far as this software is willing to guess about it. */
export type CallsignShape =
  /** A well-formed callsign in a US ITU block: there is an FCC record to go and ask for. */
  | 'us'
  /** A well-formed callsign, issued somewhere the FCC does not publish: nothing to ask. */
  | 'foreign'
  /** Not a callsign in any administration's format. Says NOTHING about which country it is from. */
  | 'malformed';

/**
 * Whitespace removed, upper-cased. A callsign contains neither, so a space in the input is
 * typing, not data — and the shape rules below would read `W1 AW` as "not a callsign at all",
 * which is the one thing that must never be said to somebody holding a US licence.
 *
 * Nothing else is stripped. A `/P` or `/4` suffix is a real thing people type and this does NOT
 * remove it, because the licence record it would then return is not the string they asked about.
 * Such a string is `malformed` below — which is the honest answer for it, and is what it was
 * getting wrong before: `W1AW/4` was reported as a callsign the United States does not issue.
 */
export function normaliseCallsign(callsign: string): string {
  return callsign.replace(/\s+/g, '').toUpperCase();
}

/**
 * A callsign of ANY administration, as the ITU builds one: a prefix, one digit naming the call
 * area, then a suffix of one to four letters.
 *
 * The three prefix forms are the ITU's own (Radio Regulations Article 19): two letters (`DL`),
 * a letter and a digit (`E7`), or a digit and a letter (`2E`, `9A`). The optional fourth character
 * covers the administrations whose allocation is three characters wide — `3DA0RS` in Eswatini,
 * which would otherwise be reported to its holder as not a callsign.
 *
 * DELIBERATELY A SHAPE AND NOT A LIST OF ISSUED PREFIXES. The question this answers is "could a
 * human being hold this?", asked so that the answer to somebody's typo is not a sentence about
 * their country. Guessing a country from an unassigned-but-plausible prefix would be inventing the
 * fact this whole module exists to stop inventing.
 */
const CALLSIGN_SHAPE = /^(?:[A-Z]{1,2}|[A-Z]\d|\d[A-Z])[A-Z]?\d[A-Z]{1,4}$/;

/**
 * Do the leading letters of this string fall in a US ITU block?
 *
 * ASKED OF `geo.ts` RATHER THAN ANSWERED HERE. `callDistrictFromCallsign` accepts a whole callsign
 * and not a prefix, so the prefix is put into the smallest well-formed callsign that carries it —
 * `K` becomes `K0A` — and geo's own US-block rule decides. The digit and the suffix letter are
 * arbitrary and never leave this function.
 *
 * WHY IT COMES BEFORE THE SHAPE TEST BELOW. K, N, W and AA-AL are issued by the United States and
 * by nobody else, so a string that begins with one and is not a well-formed US callsign is a
 * MISTYPED AMERICAN CALLSIGN, whatever else it may resemble. Without this, `K12AB` parses under the
 * ITU shape as prefix `K1`, area `2`, suffix `AB` — a perfectly plausible foreign callsign — and
 * the holder of `K1AB` who fat-fingered a digit gets told the United States did not issue it. That
 * is the very sentence this module was written to stop printing.
 */
function hasUsPrefix(wanted: string): boolean {
  const lead = /^[A-Z]{1,2}/.exec(wanted);
  return lead !== null && callDistrictFromCallsign(`${lead[0]}0A`) !== undefined;
}

/**
 * Which of the three this string is. Normalises first, so a caller may hand it raw input.
 *
 * The order is the whole of the logic: what the FCC issues, then what the FCC's own prefix blocks
 * cover, then what any administration could have issued, and only then "we cannot read this".
 */
export function classifyCallsign(callsign: string): CallsignShape {
  const wanted = normaliseCallsign(callsign);
  if (callDistrictFromCallsign(wanted) !== undefined) return 'us';
  if (hasUsPrefix(wanted)) return 'malformed';
  return CALLSIGN_SHAPE.test(wanted) ? 'foreign' : 'malformed';
}
