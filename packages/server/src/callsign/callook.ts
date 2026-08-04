import { callDistrictFromCallsign, type LicenseClass } from '@grantspotter/core';
import { assertNotBlocked } from '../fetcher/blocklist.js';
import { canonicalHostname } from '../net/hosts.js';
import type { CallsignLookupResult, CallsignRecord } from './types.js';

/**
 * ONE CALLSIGN, ONE REQUEST, ON BEHALF OF A HUMAN WHO IS WAITING.
 *
 * This module exists so that a student setting up an account can type `KD9XYZ` instead of ten
 * fields. It is not a crawler and must not become one: one request per call, no cache, no
 * discovery, no following of links or redirects, nothing queued, nothing retried more than once.
 * Every source of data this project POLLS goes through the crawler's fetcher (robots.txt,
 * per-host pacing, snapshots, a contact-bearing User-Agent); a lookup a person triggers about
 * their own licence is a different act, and the differences are enumerated below rather than
 * assumed.
 *
 * WHY NOT THE FETCHER. Three reasons, and the third is the honest one.
 *   1. The fetcher exists to be polite to sites we visit uninvited, on a schedule, in bulk. This
 *      request happens once, when somebody presses a button about themselves.
 *   2. Its politeness machinery has costs a person waiting on a form should not pay: a per-host
 *      lane that serialises against a nightly crawl, up to four attempts with backoff, and a
 *      robots.txt read before the request it governs.
 *   3. `https://callook.info/robots.txt` — read 2026-08-04, HTTP 200, 26 bytes — is
 *      `User-agent: *` / `Disallow: /`, so the fetcher would refuse this request outright and the
 *      feature would not exist. THAT IS NOT A LOOPHOLE AND IT IS NOT TREATED AS ONE. RFC 9309 §1
 *      scopes the Robots Exclusion Protocol to "automatic clients known as crawlers"; a browser
 *      fetching a page a user asked for has never been in scope, and neither is this. What makes
 *      that claim true here rather than convenient is the shape of the code: nothing in this file
 *      can run without a person supplying a callsign, nothing enumerates URLs, nothing follows a
 *      redirect, nothing repeats. The same site's API reference, read the same day, says in its
 *      Usage Terms: "The callook.info API is publicly available and is free to use however you
 *      wish." Both documents are the site owner's; they address different clients.
 *      **The README's "Polite crawling" section describes the nightly crawl and says nothing about
 *      this path, which makes it incomplete rather than wrong — it needs a paragraph saying that
 *      one further request exists, that a person triggers it, and where it goes.** If the site
 *      ever asks us to stop, one request per button press is the whole of what there is to stop.
 *
 * WHY THE TRANSPORT IS REQUIRED RATHER THAN DEFAULTED. `FetchOptions.transport` in the fetcher is
 * optional and falls back to the platform's own fetch. Doing that here would make this the third
 * file in the repository that opens a socket without a fetcher, and that list is closed on purpose
 * by `test/contactUrlEntryPointContract.test.ts` — a decision made in review, not by writing four
 * lines in a hurry. So this module never holds the platform's fetch: whoever wires it up supplies
 * one, which also means the unit suite cannot reach the network from here even by accident.
 *
 * WHAT THIS MODULE MUST NEVER PRODUCE: `licensedSince`. See {@link toRecord}.
 */

/** The documented pretty-URL base: `https://callook.info/<CALL>/json`. */
export const CALLOOK_BASE_URL = 'https://callook.info';

/**
 * Eight seconds, not the crawler's thirty.
 *
 * The crawler's timeout is sized for a volunteer-run site on shared hosting that nobody is
 * watching. This one is sized for the person watching the spinner: past a few seconds they have
 * already decided the form is broken, and the fallback — typing four fields themselves — costs
 * less than waiting. The worst case a user can experience is this budget once (see the retry
 * rule in {@link lookupCallsign}).
 */
const DEFAULT_TIMEOUT_MS = 8_000;

export interface CallsignLookupDeps {
  /**
   * The one way this module reaches the network. Same signature as `FetchOptions.transport`, and
   * required rather than defaulted — see the note at the top of this file.
   *
   * The `init` handed to it carries `accept`, `redirect: 'manual'` and an abort signal, and NO
   * identity header: there is exactly one User-Agent in this software, built by `config.ts` from
   * the operator's contact URL, and this module is not allowed to mint a second one. A deployment
   * that wants callook to see that identity adds it in the transport it supplies.
   */
  transport: (url: string, init: RequestInit) => Promise<Response>;
  /** Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Defaults to `Date.now`. Injected so `fetchedAt` is assertable. */
  now?: () => number;
  /**
   * Defaults to {@link CALLOOK_BASE_URL}. Tests set it to prove that the blocklist governs this
   * path too; a deployment has no reason to. Whatever it is set to, `assertNotBlocked` decides
   * whether we are allowed to ask it, and `CallsignRecord.source` still says `callook.info`
   * because that is whose database the answer would be — point this somewhere else and the label
   * is a lie, which is the one thing this product does not do.
   */
  baseUrl?: string;
}

/**
 * The operator classes that map onto core's four-value `LicenseClass` with nothing left over.
 *
 * THE OMISSIONS ARE THE POINT. callook's documented set is
 * `NOVICE | TECHNICIAN | TECHNICIAN PLUS | GENERAL | ADVANCED | EXTRA`, and roughly 212,000 US
 * licensees still hold one of the three legacy classes that are not in this table. `LicenseClass`
 * has no room for them, and the nearest neighbour is always upward: Advanced would become EXTRA,
 * Technician Plus would become TECH-or-GENERAL depending on who was guessing. Guessing upward
 * manufactures an ELIGIBLE verdict on an award the holder cannot enter, which is the single
 * mistake this product refuses to make. So a legacy class leaves `operClass` undefined, keeps
 * `operClassRaw`, and the user chooses — one question, asked honestly, instead of a wrong answer
 * presented confidently.
 *
 * `AMATEUR EXTRA` is here beside `EXTRA` because that is how the licence itself is spelled and how
 * the FCC's own printouts render it; callook prints `EXTRA`. Matching both is not a guess, it is
 * two spellings of one exact name.
 */
const EXACT_LICENSE_CLASSES: Readonly<Record<string, LicenseClass | undefined>> = Object.freeze({
  TECHNICIAN: 'TECH',
  GENERAL: 'GENERAL',
  EXTRA: 'EXTRA',
  'AMATEUR EXTRA': 'EXTRA',
});

/**
 * callook's five licensee types, answered as the two this product asks about.
 *
 * `CallsignRecord.type` is OUR question — is this licence held by a person or by an organisation?
 * — not callook's. `MILITARY` (a military recreation station), `RACES` and `RECREATION` are all
 * organisational licences held by an entity with a name and a mailing address, which is the same
 * shape as `CLUB` everywhere downstream. The mapping is written out here rather than derived from
 * "anything that is not PERSON", so that a SIXTH value callook might add one day does not silently
 * become a club: an unrecognised type is refused by {@link toRecord} instead.
 */
const LICENSEE_TYPES: Readonly<Record<string, CallsignRecord['type'] | undefined>> = Object.freeze({
  PERSON: 'PERSON',
  CLUB: 'CLUB',
  MILITARY: 'CLUB',
  RACES: 'CLUB',
  RECREATION: 'CLUB',
});

/**
 * `"CITY, ST 12345"`, `"CITY, ST 12345-6789"`, or `"CITY, ST 123456789"`.
 *
 * callook publishes the city, state and ZIP as ONE string (`address.line2`), so they have to be
 * taken apart, and the taking-apart is all-or-nothing: a line that does not match this leaves
 * `city`, `state` and `zip` all undefined. Splitting on the comma alone would set
 * `state = "EXAMPLESHIRE"` for a US licensee with an overseas address, and half a parsed address
 * silently entered into somebody's profile is worse than an empty one they can see is empty.
 *
 * The unpunctuated nine-digit form is accepted because ULS data contains it; it is stored exactly
 * as it arrived, hyphen or no hyphen. Re-punctuating it would be this software presenting its own
 * tidy-up as something the record said.
 */
const CITY_STATE_ZIP = /^(.+),\s*([A-Za-z]{2})\s+(\d{5}(?:-?\d{4})?)$/;

/**
 * A post office box, however the record spells it: `PO BOX`, `P.O. BOX`, `P O BOX`, `POST OFFICE
 * BOX`. Real captures in `fixtures/callook/` contain `P.O. BOX 51421` and
 * `8 CLARKSON AVE, P.O. BOX 8550` — the second being a street address that ALSO carries a box,
 * which is why this asks "does this line name a box" and not "is this line only a box".
 */
const PO_BOX = /\b(?:p\.?\s*o\.?|post\s+office)\s*box\b/i;

/** MM/DD/YYYY, which is the only date format callook prints. */
const US_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** A trimmed non-empty string, or undefined. callook writes "no data" as `""`, never as null. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Whitespace removed, upper-cased. A callsign contains neither, so a space in the input is
 * typing, not data — and `callDistrictFromCallsign` would read `W1 AW` as "not a US callsign",
 * which is the one message that must never be shown to somebody holding a US licence.
 *
 * Nothing else is stripped. A `/P` or `/4` suffix is a real thing people type and this does NOT
 * remove it, because the licence record it would then return is not the string they asked about.
 */
function normalise(callsign: string): string {
  return callsign.replace(/\s+/g, '').toUpperCase();
}

/**
 * `04/04/2019` -> `2019-04-04`, or undefined for anything else.
 *
 * Date-only, deliberately: the FCC records a calendar day with no time and no zone, and turning
 * that into `2019-04-04T00:00:00.000Z` would add a midnight and a timezone that nobody stated.
 */
function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const parts = US_DATE.exec(raw);
  if (parts === null) return undefined;
  const iso = `${parts[3]}-${parts[1]}-${parts[2]}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  // The round trip is what refuses 13/45/2019: a rolled-over date does not print itself back.
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10) === iso ? iso : undefined;
}

/**
 * The FCC licence page for this record, if the value we were handed is one.
 *
 * This string is rendered as a link a user clicks to check our answer against the FCC's, so it is
 * the one field here that could do harm if it were taken on trust: an unchecked value is an anchor
 * pointing wherever the response said, `javascript:` included. Two conditions, both narrow — an
 * `http(s)` scheme, and a host at fcc.gov — and anything else is dropped rather than shown.
 * `canonicalHostname` does the comparing because a trailing-dot host has walked past four
 * hand-written host checks in this repository already.
 *
 * We never REQUEST it: `wireless2.fcc.gov` answers 403 to non-browser clients (it 403s its own
 * robots.txt), which is exactly why the link is for the human and not for us.
 */
function ulsUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const host = canonicalHostname(parsed.hostname);
  return host === 'fcc.gov' || host.endsWith('.fcc.gov') ? raw : undefined;
}

/**
 * A value from outside, quoted back to the person who will read it, bounded.
 *
 * Two of the messages below contain something this module did not choose — what was typed, and
 * what the response said. Neither has a length this code controls, and an error message is not a
 * place to find that out.
 */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function unavailable(message: string): CallsignLookupResult {
  return { status: 'unavailable', message };
}

/**
 * A VALID callook body turned into a record, or a reason it could not be.
 *
 * `licensedSince` IS NOT SET HERE, IS NOT SET ANYWHERE IN THIS FILE, AND MUST NOT BE. The profile
 * field of that name feeds `heldMonthsMin` in the matcher — "held for at least N months" — and the
 * only date-shaped thing in this response is `otherInfo.grantDate`, which is NOT the date first
 * licensed. It resets on every renewal and on every vanity change. A real record read on
 * 2026-08-04 shows `grantDate 04/04/2019` beside a non-empty `previous.callsign`, for a licensee
 * first licensed years earlier; `fixtures/callook/person-extra.json` reproduces that pair without
 * reproducing whose record it was. Filling
 * `licensedSince` from it would hand the matcher a confidently wrong number and print an ELIGIBLE
 * or NOT ELIGIBLE verdict on an award the student's real licence date decides differently. The
 * field is surfaced as `grantDate` and, wherever it is shown, is labelled "current licence
 * granted" — a fact about this licence, which is what it is.
 */
function toRecord(body: Record<string, unknown>, fetchedAt: string): CallsignLookupResult {
  const current = record(body.current);
  const address = record(body.address);
  const other = record(body.otherInfo);

  const callsign = text(current.callsign);
  const name = text(body.name);
  const rawType = text(body.type);
  if (callsign === undefined || name === undefined || rawType === undefined) {
    // The API reference is explicit that when status is VALID, every other field appears. A body
    // missing the callsign or the name is not a licence record, and the queried callsign is NOT
    // substituted for the missing one: that would print our own input back as the source's answer.
    return unavailable(
      'callook.info answered, but not with a licence record we could read, so nothing was ' +
        'filled in rather than guessed at. That is ours to fix, not yours — type your details in ' +
        'and carry on; nothing else depends on this.',
    );
  }

  const type = LICENSEE_TYPES[rawType.toUpperCase()];
  if (type === undefined) {
    return unavailable(
      `callook.info describes ${clip(callsign, 16)} as a "${clip(rawType, 32)}" licence, which ` +
        'this version of GrantSpotter does not know how to record, so nothing was filled in ' +
        'rather than filed under the wrong kind of licensee. Type your details in and carry on.',
    );
  }

  const line1 = text(address.line1);
  const result: CallsignRecord = {
    // What the licensee holds NOW, which is not always what was asked for: callook answers a
    // lookup of a superseded callsign with the current record for that licensee. The caller must
    // use THIS value, and may usefully say "we found you under WV0ZZZ" when it differs.
    callsign: normalise(callsign),
    type,
    name,
    // False also means "we were given no address at all", which is normal — about 1.3% of records
    // carry none. It is never a claim that we looked and found a street address.
    isPoBox: line1 !== undefined && PO_BOX.test(line1),
    source: 'callook.info',
    fetchedAt,
  };

  const operClassRaw = text(current.operClass);
  if (operClassRaw !== undefined) {
    // Kept whatever it says. `operClass` is set only alongside it, and only on an exact match.
    result.operClassRaw = operClassRaw;
    const mapped = EXACT_LICENSE_CLASSES[operClassRaw.replace(/\s+/g, ' ').toUpperCase()];
    if (mapped !== undefined) result.operClass = mapped;
  }

  if (line1 !== undefined) result.addressLine1 = line1;

  const line2 = text(address.line2);
  const split = line2 === undefined ? null : CITY_STATE_ZIP.exec(line2);
  if (split !== null) {
    const [, city, state, zip] = split;
    result.city = city.trim();
    result.state = state.toUpperCase();
    result.zip = zip;
  }

  const grantDate = isoDate(other.grantDate);
  if (grantDate !== undefined) result.grantDate = grantDate;
  const expiryDate = isoDate(other.expiryDate);
  if (expiryDate !== undefined) result.expiryDate = expiryDate;
  const frn = text(other.frn);
  if (frn !== undefined) result.frn = frn;
  const uls = ulsUrl(other.ulsUrl);
  if (uls !== undefined) result.ulsUrl = uls;

  return { status: 'found', record: result };
}

/** Our own timeout firing, or a caller's abort. Either way, asking again immediately is wrong. */
function wasAborted(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Look one US callsign up at callook.info.
 *
 * Resolves — it does not throw. Every failure is a status and a message, because the caller is a
 * form and the reader is a person who has just typed their callsign into a piece of software they
 * do not yet trust. A rejected promise at that moment becomes a red box with a stack trace in it.
 *
 * THE PREFIX CHECK HAPPENS BEFORE THE REQUEST, and that ordering is the whole point of it.
 * callook holds United States records only ("Callook.info exclusively contains and serves United
 * States callsign data" — its API reference), so a German or Japanese callsign comes back with the
 * same empty answer as a typo. Told "not found" while creating an account, a licensed operator
 * reads "your licence is invalid". So a callsign that is not a US prefix never becomes a request,
 * and gets its own status and its own words. `callDistrictFromCallsign` decides — it already
 * encodes the US prefix rule (the whole K/N/W blocks, AA-AL of the A block) and this file does not
 * mint a second opinion about what a callsign looks like.
 *
 * RETRIES: at most one, and never after a timeout. A dropped connection is a coin-flip worth
 * flipping twice and costs nothing when it succeeds. A timeout is not: the source has already had
 * the whole budget, and spending it again doubles the wait for somebody who is watching a spinner
 * and whose alternative — typing four fields — takes less time than the second attempt. An HTTP
 * status is not retried either: a 429 or a 503 is the source asking to be left alone, and this
 * path has no backoff to honour it with, because it is not allowed to sleep in front of a user.
 */
export async function lookupCallsign(
  callsign: string,
  deps: CallsignLookupDeps,
): Promise<CallsignLookupResult> {
  const wanted = normalise(callsign);
  if (callDistrictFromCallsign(wanted) === undefined) {
    // Quoted back so the reader can see what we read, but capped: this is the one message that can
    // be built from arbitrary input, and a pasted paragraph must not become a pasted paragraph
    // with an apology around it. No US callsign is longer than 6 characters.
    const quoted = clip(wanted, 16);
    return {
      status: 'not_us',
      message:
        `GrantSpotter can only look up United States callsigns automatically — the source it ` +
        `asks, callook.info, holds FCC records and nothing else — and "${quoted}" is not one it ` +
        `can answer for. If that is a US callsign, check it for a typo and leave off any "/P" or ` +
        `"/4" suffix. Otherwise just type your licence details in yourself: every part of ` +
        `GrantSpotter works the same either way, and your licence is no less valid for being ` +
        `issued somewhere this lookup cannot reach.`,
    };
  }

  const base = deps.baseUrl ?? CALLOOK_BASE_URL;
  const url = `${base}/${encodeURIComponent(wanted)}/json`;
  try {
    // The blocklist is not a crawler rule, it is a rule about what this software may contact, so
    // it applies here too. Without this line a lookup would be a way around it.
    assertNotBlocked(url);
  } catch (error) {
    return unavailable(
      `This installation is set up to look callsigns up somewhere GrantSpotter refuses to ` +
        `contact, so nothing was checked. That is a setting on this server, not a problem with ` +
        `your callsign — whoever runs it can fix it (${error instanceof Error ? error.message : String(error)}). ` +
        `Type your details in meanwhile.`,
    );
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  let response: Response | undefined;
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await deps.transport(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        // We do not follow redirects. Following one means requesting a host that has not been
        // past `assertNotBlocked`, and one request per call is the promise this module makes.
        redirect: 'manual',
        // A fresh signal per attempt: an AbortSignal that has already fired cannot be reused.
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (error) {
      failure = error;
      if (wasAborted(error)) break;
    }
  }

  if (response === undefined) {
    return unavailable(
      wasAborted(failure)
        ? 'callook.info did not answer in time, so nothing was filled in. That is the network or ' +
          'the source being slow, not anything to do with your callsign — try again in a moment, ' +
          'or type your details in and carry on.'
        : 'We could not reach callook.info, so nothing was filled in. That is our end or the ' +
          'network, not your callsign — try again in a moment, or type your details in and ' +
          'carry on.',
    );
  }

  if (response.status !== 200) {
    return unavailable(
      `callook.info answered with HTTP ${response.status} instead of a licence record, so ` +
        `nothing was filled in. That is the source having trouble, not your callsign — try again ` +
        `later, or type your details in and carry on.`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return unavailable(
      'callook.info answered with something we could not read as a licence record, so nothing ' +
        'was filled in rather than guessed at. That is ours to fix, not yours — type your ' +
        'details in and carry on.',
    );
  }

  const parsed = record(body);
  const status = text(parsed.status)?.toUpperCase();

  if (status === 'UPDATING') {
    return {
      status: 'updating',
      // Its API reference: the database reloads from the FCC snapshot daily at 11:00 AM ET and
      // the site is offline while it does, "usually less than five minutes".
      message:
        'callook.info is reloading its copy of the FCC database right now — it does that once a ' +
        'day, at about 11:00 in the morning US Eastern time, and it usually takes under five ' +
        'minutes. Nothing is wrong with your callsign. Try again shortly, or type your details ' +
        'in and carry on.',
    };
  }

  if (status === 'INVALID') {
    return {
      status: 'not_found',
      message:
        `callook.info has no current FCC record for "${wanted}". The usual reason is a typo — ` +
        `check each letter and digit — and the other is a licence that has lapsed or expired. ` +
        `If you are sure the callsign is right, type your details in yourself and carry on; ` +
        `nothing in GrantSpotter depends on this lookup succeeding.`,
    };
  }

  if (status !== 'VALID') {
    return unavailable(
      'callook.info answered with something we could not read as a licence record, so nothing ' +
        'was filled in rather than guessed at. That is ours to fix, not yours — type your ' +
        'details in and carry on.',
    );
  }

  return toRecord(parsed, new Date(now()).toISOString());
}
