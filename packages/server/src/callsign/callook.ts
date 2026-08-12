import { checkCoordinateAgainstLocator, type LicenseClass } from '@grantspotter/core';
import { assertNotBlocked } from '../fetcher/blocklist.js';
import { canonicalHostname } from '../net/hosts.js';
import {
  clampCooldownMs,
  cooldownKey,
  COOLDOWN_FLOOR_MS,
  describeWait,
  parseRetryAfterMs,
  type HostCooldown,
} from './cooldown.js';
import { classifyCallsign, normaliseCallsign } from './shape.js';
import type {
  CallsignLookupResult,
  CallsignRecord,
  GeocodedFrom,
  GeocodedPoint,
  GeocodeRefusal,
  MailingGeocode,
} from './types.js';

/**
 * ONE CALLSIGN, ONE REQUEST, ON BEHALF OF A HUMAN WHO IS WAITING.
 *
 * This module exists so that a student setting up an account can type `KD9XYZ` instead of ten
 * fields. It is not a crawler and must not become one: one request per call, no cache, no
 * discovery, no following of links or redirects, nothing queued, nothing retried.
 * Every source of data this project POLLS goes through the crawler's fetcher (robots.txt,
 * per-host pacing, snapshots, a contact-bearing User-Agent); a lookup a person triggers about
 * their own licence is a different act, and the differences are enumerated below rather than
 * assumed.
 *
 * IT DOES KEEP ONE THING, added 2026-08-04, and it is the opposite of a cache: not what the source
 * SAID, which is never remembered, but when the source asked to be left alone. See
 * {@link CallsignLookupDeps.cooldown} and `cooldown.ts`. A module that remembers nothing cannot
 * honour `Retry-After`, and a feature that queries a host publishing `Disallow: /` and then ignores
 * the one instruction that host can give a non-crawler has no argument left.
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
 *      ever asks us to stop, one request per button press is the whole of what there is to stop —
 *      and if it asks us to WAIT, which is the thing a 429 does, that is now heard: see the
 *      cooldown below.
 *
 * WHY THE TRANSPORT IS REQUIRED RATHER THAN DEFAULTED. `FetchOptions.transport` in the fetcher is
 * optional and falls back to the platform's own fetch. Doing that here would make this the third
 * file in the repository that opens a socket without a fetcher, and that list is closed on purpose
 * by `test/contactUrlEntryPointContract.test.ts` — a decision made in review, not by writing four
 * lines in a hurry. So this module never holds the platform's fetch: whoever wires it up supplies
 * one, which also means the unit suite cannot reach the network from here even by accident.
 *
 * WHAT THIS MODULE MUST NEVER PRODUCE: `licensedSince`. See {@link toRecord}.
 *
 * WHAT IT PRODUCES THAT LOOKS LIKE MORE THAN IT IS: a coordinate. Every VALID body carries a
 * latitude, a longitude and a grid square, and until 2026-08-11 this file stepped over all three
 * without comment — a station's position, apparently, arriving on every lookup and being thrown
 * away. It is not a station's position. callook geocodes the licensee's MAILING address, which for
 * `01-callook-info-w1mx-json.json` — a collegiate club, the audience this product was built for —
 * is a post office box, answered to eight decimal places. The whole of that argument, and the shape
 * that stops a consumer walking into it, is in `types.ts` under {@link GeocodedFrom}; the parsing
 * of it is at {@link statedPoint} below, which also asks core whether the coordinate and the grid
 * square agree and keeps neither when they do not.
 */

/** The documented pretty-URL base: `https://callook.info/<CALL>/json`. */
export const CALLOOK_BASE_URL = 'https://callook.info';

/**
 * WHAT THIS REQUEST IS, IN THE WORDS A SITE OWNER READS IN THEIR LOG.
 *
 * Passed to `buildUserAgent` — the ONE User-Agent factory (RESOLUTIONS R10) — as its purpose
 * clause, by the composition root, which is the only file allowed to call that factory for this
 * path. It is not a second User-Agent and this module does not build one: the version, the contact
 * URL and the shape of the string are all still decided in `config.ts`, and this is the one clause
 * that differs.
 *
 * MEASURED BYTE-IDENTICAL TO THE CRAWLER'S UNTIL 2026-08-04, including `nightly grant-deadline
 * change detector`. Every word of that is false here: nothing about this is nightly, nothing about
 * it detects a change, nothing about it is about a grant deadline, and it is not a crawl. The
 * person it misinforms is exactly the reader the User-Agent exists for — callook.info's owner,
 * looking at one line in a log and deciding what visited them. Being identified and being described
 * wrongly are not the same courtesy.
 */
export const CALLSIGN_LOOKUP_PURPOSE = 'single user-initiated callsign lookup, not a crawl';

/**
 * Eight seconds, not the crawler's thirty.
 *
 * The crawler's timeout is sized for a volunteer-run site on shared hosting that nobody is
 * watching. This one is sized for the person watching the spinner: past a few seconds they have
 * already decided the form is broken, and the fallback — typing four fields themselves — costs
 * less than waiting. The worst case a user can experience is this budget ONCE, and that sentence
 * is now true rather than aspirational (see the no-retry rule in {@link lookupCallsign}).
 *
 * IT WAS NOT TRUE UNTIL 2026-08-04. This file retried once on a dropped connection, each attempt
 * with its own fresh `AbortSignal.timeout(timeoutMs)`, so the budget was per ATTEMPT and not per
 * call. Measured against a loopback server that accepted the connection and then destroyed the
 * socket at 900 ms, with `timeoutMs = 1000`: two requests and 1808 ms of spinner. That is what
 * this comment already promised would not happen.
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
  /**
   * Where "this host asked us to wait" is remembered between two presses of the button, and where
   * "we are asking this host something right now" is remembered between two presses that OVERLAP.
   *
   * REQUIRED, for the same reason `transport` is. A stateless lookup cannot honour `Retry-After`
   * at all — backing off is a fact about the previous request — and until 2026-08-04 this module
   * had nowhere to keep one, so eight presses at a host answering `429 Retry-After: 120` sent
   * eight requests in 69 ms. Defaulting this would mean a caller could re-create that by leaving
   * one line out, and the caller here is a route that a person presses a button on.
   *
   * ONE LEDGER PER PROCESS in production (`api/callsign.ts` builds it once per router, and the
   * composition root builds one router). Both facts belong to the HOST, not to the user: callook.info
   * asking to be left alone is not an instruction that one member has used up their share of, and
   * "one request at a time" counted per member would let a hundred members make a hundred.
   */
  cooldown: HostCooldown;
  /** Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Defaults to `Date.now`. Injected so `fetchedAt` and the cooldown clock are both assertable. */
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

/**
 * A plain decimal number, which is the only shape a coordinate has ever arrived in.
 *
 * THE VALUES ARE STRINGS. `"41.714707"`, not `41.714707` — every field in a callook body is a
 * string and "no data" is `""`, the coordinates included. `text()` disposes of the empty one;
 * this is what disposes of the rest, because `Number` on its own is far too willing: it reads
 * `"1e3"`, `"0x2A"` and `"Infinity"` as numbers no geocoder wrote, and turns `"41.7N"` into a
 * silent `NaN` that then has to be caught somewhere else. Matching the string first means the
 * conversion below can only be handed digits.
 */
const DECIMAL_DEGREES = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * The coarsest locator that can still check the coordinate printed beside it.
 *
 * THIS FILE NO LONGER HAS AN OPINION ABOUT WHAT A LOCATOR IS. It used to hold a regular expression
 * of its own — `/^[A-R]{2}\d{2}(?:[A-X]{2})?$/i` — and two opinions about one notation is precisely
 * how the repository came to state, in two files committed two minutes apart, both that an
 * eight-character locator cannot be read and that here is the arithmetic for reading one. Syntax is
 * `core/maidenhead.ts`'s answer now, the same way callsign shape is `shape.ts`'s. What is left here
 * is the one question core cannot answer, because it is about this source and this use: how coarse
 * a locator is still worth keeping.
 *
 * FOUR, NOT TWO. A four-character locator is the same statement made coarsely — a bigger box,
 * honestly labelled — and refusing one would throw away a usable coordinate over a technicality.
 * Two characters is where that argument runs out. `FN` is a box 10° by 20°, measured at 691 miles
 * north-south by 1029 east-west at Newington's latitude: a coordinate a thousand miles from where
 * the rest of the record puts it still falls inside it. The ONLY reason {@link statedPoint} keeps
 * the locator beside the pair is that the two check each other, so a locator too coarse to perform
 * that check is the absent one the all-or-nothing rule already refuses.
 *
 * AND EIGHT IS ACCEPTED, which it was not until 2026-08-11. The comment that refused it said the
 * extended form has "no single convention for its fifth pair" — an eight-character locator has FOUR
 * pairs, and the fourth is not in dispute. The notation is built on an alternation, letters then
 * digits, repeating: field A-R, square 0-9, subsquare A-X, extended square 0-9. Whatever
 * disagreement exists further out is about the pair after that, at ten characters, which core
 * refuses as `too_long` and this file therefore never sees. The measured cost of the refusal: a
 * body carrying `FN42li33` — which is the correct eight-character locator for W1MX's own stated
 * coordinate — produced NO geocode at all, because the parse is all-or-nothing, so a usable
 * coordinate was discarded over a locator core could already read and had tested to eight places.
 */
const MINIMUM_LOCATOR_PRECISION = 4;

/** A trimmed non-empty string, or undefined. callook writes "no data" as `""`, never as null. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The pieces of {@link CallsignLookupDeps} that decide whether a press becomes a request. */
export type ReachDeps = Pick<CallsignLookupDeps, 'cooldown' | 'baseUrl' | 'now'>;

/** Where this press would go, if it went anywhere. */
function targetUrl(wanted: string, deps: ReachDeps): string {
  return `${deps.baseUrl ?? CALLOOK_BASE_URL}/${encodeURIComponent(wanted)}/json`;
}

/**
 * Why this press will not become a request, or `undefined` if it will.
 *
 * ONE OPINION, READ TWICE. {@link lookupCallsign} needs the REASON — each of these gets its own
 * status and its own sentence, and flattening them would tell an international operator that
 * callook.info is having trouble. `api/callsign.ts` needs only the yes/no, to decide whether to
 * charge a press against the caller's allowance. Both read this function, so what is rationed and
 * what is spent cannot drift apart, which is the property `api/callsign.ts` claims in prose.
 */
type Refusal =
  /** A callsign, issued somewhere callook does not publish records from. */
  | { kind: 'not_us' }
  /** Not a callsign at all — which is a DIFFERENT fact, and used to be reported as the one above. */
  | { kind: 'malformed' }
  | { kind: 'blocked'; error: unknown }
  | { kind: 'cooling'; remainingMs: number }
  | { kind: 'busy' };

function refuseBeforeRequest(callsign: string, deps: ReachDeps): Refusal | undefined {
  const wanted = normaliseCallsign(callsign);
  /*
   * TWO REASONS NOT TO ASK, AND THEY ARE NOT THE SAME REASON.
   *
   * callook holds United States records only, so a foreign callsign has nothing to ask about — and
   * a string that is not a callsign has nothing to ask about either, for a reason that has nothing
   * to do with which country anybody is licensed in. Until 2026-08-09 both came back from
   * `callDistrictFromCallsign` as one `undefined` and were sent out as `not_us`, so `N0CALLXX` —
   * one letter too long, US prefix and all — was answered "your licence is no less valid for being
   * issued somewhere this lookup cannot reach". `shape.ts` splits them; this file does not mint a
   * second opinion about what a callsign looks like, it asks.
   */
  switch (classifyCallsign(wanted)) {
    case 'foreign':
      return { kind: 'not_us' };
    case 'malformed':
      return { kind: 'malformed' };
    case 'us':
      break;
  }

  const url = targetUrl(wanted, deps);
  try {
    // The blocklist is not a crawler rule, it is a rule about what this software may contact, so
    // it applies here too. Without this line a lookup would be a way around it.
    assertNotBlocked(url);
  } catch (error) {
    return { kind: 'blocked', error };
  }

  const now = deps.now ?? Date.now;
  const key = cooldownKey(url);
  const remainingMs = deps.cooldown.remainingMs(key, now());
  if (remainingMs > 0) return { kind: 'cooling', remainingMs };

  // A hold that has not been WRITTEN yet still binds this press, and that is the whole of the
  // in-flight lane: the request already running may be about to learn that this host wants to be
  // left alone for two minutes, and a press that starts before it finds out is a press the hold
  // can never reach. Read here rather than claimed — this function is also the rate limiter's
  // predicate and must be able to answer without becoming the request it is asked about.
  return deps.cooldown.isAsking(key) ? { kind: 'busy' } : undefined;
}

/**
 * Does pressing the button, right now, cost callook.info a request?
 *
 * EXPORTED FOR THE THING THAT RATIONS REQUESTS. `api/callsign.ts` limits how often one person may
 * make this software ask somebody else's server a question, and the ways a press can cost that
 * server nothing — a callsign the FCC did not issue, a string that is not a callsign at all, a base
 * URL on the hard blocklist, a host that has asked us to wait and whose wait has not run out, and a
 * host we are already mid-question with — are all decided here, in this process, before any socket
 * exists. The first two were one reason until 2026-08-09, which is how a typo came to be answered
 * with a sentence about international licensing; they are two now, and a press costs nothing under
 * either of them.
 *
 * Until 2026-08-04 the route had no way to ask, so it charged every press. Nine `DL1ABC` presses
 * from one member spent the whole allowance without a single request leaving the process, and the
 * next press — with a real US callsign — was refused for ten minutes. That punished exactly the
 * international operators the `not_us` message exists to reassure. The cooldown case is the same
 * mistake waiting to happen from the other end: a source asking to be left alone must not also
 * cost the person their allowance for the ten minutes they are being asked to wait.
 */
export function wouldReachTheSource(callsign: string, deps: ReachDeps): boolean {
  return refuseBeforeRequest(callsign, deps) === undefined;
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
 * One coordinate component, or undefined — never a number this file could not read off the page.
 *
 * `limit` is 90 for a latitude and 180 for a longitude, and it is a check on the NOTATION rather
 * than on the geography: outside those bounds a value is not a coordinate at all. It is
 * deliberately not a US bounding box. A US licensee may hold an overseas mailing address — that is
 * why `person-unsplittable-address.json` exists one screen up — and deciding which coordinates are
 * PLAUSIBLE for an American licence is exactly the guess this file declines to make about a licence
 * class. The bound also disposes of the one way a digit string can still overflow: 400 digits match
 * the pattern and convert to `Infinity`, which is not `<= 90`.
 */
function decimalDegrees(value: unknown, limit: number): number | undefined {
  const raw = text(value);
  if (raw === undefined || !DECIMAL_DEGREES.test(raw)) return undefined;
  const degrees = Number(raw);
  return Math.abs(degrees) <= limit ? degrees : undefined;
}

/**
 * The whole of what a record said about where its mail goes, or nothing at all.
 *
 * ALL THREE OR NONE, which is the house rule from `CITY_STATE_ZIP` applied to the one other field
 * callook sends as a compound: half a parsed location silently entered into somebody's profile is
 * worse than an empty one they can see is empty. There is a second reason here that the address
 * does not have. Of the two halves, THE GRID SQUARE IS THE HONEST ONE — `FN42li` states its own
 * precision out loud, a box measured at 2.9 by 4.3 miles at that latitude, while `42.34991837`
 * states a millimetre it does not have (1.1 mm, measured with `core/geo.ts`'s haversine, is what
 * one unit in that eighth decimal buys). Dropping the locator and keeping the pair would be
 * keeping precisely the half that overstates itself.
 *
 * AND THE TWO HALVES HAVE TO AGREE, which is what makes keeping both of them worth anything.
 *
 * WHERE THAT CHECK LIVES. This comment used to say the check belonged in core and stop there, on
 * the grounds that Maidenhead-to-bounds arithmetic is core's and a second copy here is how two
 * answers to one question start disagreeing. The instinct was right; the conclusion drawn from it
 * was that nobody made the check at all. Measured against the commit before this one: a body
 * stating latitude 10, longitude 10 and gridsquare `FN31pr` — a point 5,385 miles from the centre
 * of its own stated square, in the Atlantic off Liberia — was accepted and emitted as a clean
 * `street_address` geocode carrying no marker of any kind. OWNING arithmetic and INVOKING it are
 * different acts. So `core/maidenhead.ts` parses the locator and does the containment, and this
 * file — the only place that knows the three values arrived in one field of one response — decides
 * what the answer means for a record.
 *
 * AND WHAT IT MEANS IS THAT THE WHOLE `location` IS REFUSED. Three things could happen to a
 * self-contradictory record and only one of them leaves a consumer better off:
 *
 *   - Keep it silently, which is what happened until now. That is a confident ELIGIBLE or NOT
 *     ELIGIBLE printed about a coordinate the record's own other half says is wrong.
 *   - Mark it and pass it on. Ask what a consumer would do with the mark: it cannot choose a half,
 *     because two statements disagree and NOTHING IN THE RESPONSE SAYS WHICH ONE IS WRONG. The
 *     profile would decline to prefill and the matcher would decline to match — which is what an
 *     absent field already tells them both, in a shape neither can forget to read. And it would
 *     have to be a SECOND axis rather than a fourth `geocodedFrom`, because a contradictory record
 *     is still a PO box or still a street address; every exhaustive `switch` downstream would grow
 *     a case whose body is "do what you do when there is nothing".
 *   - Refuse the field. It costs both halves, and that is the honest price of not knowing which of
 *     them is the wrong one. It is also this file's existing rule — `CITY_STATE_ZIP` drops city,
 *     state and ZIP together, and the three values here are already all-or-nothing — for the
 *     reason stated above: an empty field a person can see is better than a filled one they cannot
 *     check.
 *
 * Refusing buys something marking cannot: the PRESENCE of a {@link MailingGeocode} now means the
 * record agreed with itself. That is an invariant every consumer gets for free instead of a flag
 * every consumer has to remember to test.
 *
 * A MISS OF EXACTLY ZERO IS NOT A DISAGREEMENT. `LocatorAgreement` reports how far outside the
 * coordinate fell precisely so that a caller does not treat every `outside` alike, and an offset of
 * exactly 0 on both axes has one meaning: the coordinate lies ON a boundary of its own stated box.
 * The two halves name the same place and differ only over which side of a line a point on the line
 * belongs to — core's boxes are half-open, `[south, north)` and `[west, east)`, and not every
 * implementation picks the same end. It is also where a rounded decimal lands: a true position of
 * 42.374999996 inside `FN42li`, printed to eight places, becomes 42.375, which is that box's north
 * edge exactly. Anything further out was computed from different data and is refused — `FN42li07`
 * beside W1MX's coordinate misses by 0.0126° of latitude, which is 0.87 miles.
 *
 * THIS AND THE NULL-ISLAND RULE BELOW ARE NOT SUBSTITUTES, IN EITHER DIRECTION. `0.0 / 0.0 /
 * JJ00aa` passes this check perfectly — the locator was computed from the zeros, so the halves
 * corroborate each other exactly as well as two facts would — and is refused by a rule written
 * down. A record whose halves disagree is refused here even though each half, taken alone, is a
 * perfectly plausible coordinate and a perfectly good locator. Neither rule can be dropped in
 * favour of the other. All three real captures pass both, checked in code now rather than by hand.
 *
 * WHAT CHANGED ON 2026-08-11, AND IT IS NOT THE DECISION ABOVE. Every refusal here used to be one
 * `undefined`, which the record then carried as an absent `mailingGeocode` — the same absence a
 * record that stated no location at all produces. Measured in a browser against a running server:
 * the contradictory body in the paragraph above came back as `{"status":"found","record":{…}}` with
 * no `mailingGeocode`, and the panel then told the reader that the state was "the only thing kept
 * from these lines", which is a claim about a record that had also stated a coordinate. So the
 * REASON now travels, as {@link GeocodeRefusal}, while the coordinate still does not — see the
 * header of that type, which is where the difference between the two is argued. `silent` is the
 * fourth answer and the common one: `person-no-address.json` states three empty strings, and a
 * record that said nothing has had nothing refused.
 */
type LocationReading =
  /** The record stated a whole point and its two halves agree. */
  | { kind: 'point'; point: GeocodedPoint }
  /** The record stated something and none of it is being passed on. */
  | { kind: 'refused'; refusal: GeocodeRefusal }
  /** The record stated no location at all, so there is nothing to refuse and nothing to say. */
  | { kind: 'silent' };

function readLocation(location: Record<string, unknown>): LocationReading {
  const rawLatitude = text(location.latitude);
  const rawLongitude = text(location.longitude);
  const rawGridsquare = text(location.gridsquare);
  // Not one of the three fields carries anything. This is the ~1.3% shape, and it is silence
  // rather than a refusal: saying "a location was refused" about a record that stated none would
  // be the same over-claim, pointed the other way, as the one this reading exists to stop.
  if (rawLatitude === undefined && rawLongitude === undefined && rawGridsquare === undefined) {
    return { kind: 'silent' };
  }

  const latitude = decimalDegrees(location.latitude, 90);
  const longitude = decimalDegrees(location.longitude, 180);
  const gridsquare = rawGridsquare;
  if (latitude === undefined || longitude === undefined || gridsquare === undefined) {
    return { kind: 'refused', refusal: { refused: 'incomplete' } };
  }

  const agreement = checkCoordinateAgainstLocator(latitude, longitude, gridsquare);
  // `unknown` means core could not read the locator. It also covers a coordinate core will not
  // accept, which `decimalDegrees` has already made unreachable — and the two need not be told
  // apart, because the answer to both is the same: nothing here is checkable, so nothing is kept.
  if (agreement.status === 'unknown') {
    return {
      kind: 'refused',
      refusal: {
        refused: 'unreadable_locator',
        gridsquare,
        because: agreement.rejection.message,
      },
    };
  }
  if (agreement.box.precision < MINIMUM_LOCATOR_PRECISION) {
    return { kind: 'refused', refusal: { refused: 'locator_too_coarse', gridsquare } };
  }
  if (
    agreement.status === 'outside' &&
    !(agreement.latOffsetDeg === 0 && agreement.lonOffsetDeg === 0)
  ) {
    return {
      kind: 'refused',
      refusal: {
        refused: 'contradicted',
        gridsquare,
        containingLocator: agreement.containingLocator,
      },
    };
  }

  /*
   * (0, 0) IS NOT A PLACE ANY OF THESE RECORDS IS.
   *
   * The hand-built fixtures carry `"0.0" / "0.0" / "JJ00aa"`. Null island, in the Gulf of Guinea:
   * 5,334 statute miles from W1AW's coordinate and 5,259 from W1MX's, measured with the haversine
   * in `core/geo.ts`. callook serves United States records only, so no address it geocodes lands
   * there, and `fixtures/callook/README.md` says what the pair is doing in those files — "`frn` is
   * `0000000000`, `ulsUrl` ends `licKey=0`, and the coordinates are `0.0, 0.0`. None of them is a
   * real key." It is an absence written in the shape of an answer, and an absence that reaches
   * `withinRadius` is a confident NOT ELIGIBLE for every award on this continent.
   *
   * THE CROSS-CHECK ABOVE DOES NOT CATCH IT, AND THAT IS NOT A GAP IN THE CROSS-CHECK. `JJ00aa`
   * is the subsquare whose south-west corner IS (0, 0); it was computed from the zeros, so the
   * pair and the locator corroborate each other perfectly. Two fields derived from one absence
   * agree exactly as well as two facts do, and consistency was never the same claim as truth.
   * Hence a rule written down, sitting after the check rather than replaced by it.
   *
   * ONLY THE PAIR. A lone zero is left alone: a latitude of 0 beside a real longitude is a
   * statement about the equator, and dropping it would be this file ruling on which coordinates
   * are plausible rather than on which values the source actually stated. That zero still has to
   * agree with the locator beside it, which is a different question and is asked above.
   */
  if (latitude === 0 && longitude === 0) {
    return { kind: 'refused', refusal: { refused: 'placeholder' } };
  }

  return { kind: 'point', point: { latitude, longitude, gridsquare } };
}

/**
 * WHAT THE COORDINATE IS A GEOCODE OF, decided from the one line of the record that says.
 *
 * ONE READING OF ONE LINE. `isPoBox` is built from this function's answer rather than from its own
 * second call to {@link PO_BOX}, so the flag and the discriminant cannot drift into disagreeing
 * about the same address — a record whose coordinate is filed as a mail drop while its own boolean
 * says otherwise is worse than either mistake alone, because whichever a consumer reads, the other
 * one is available to contradict it.
 *
 * A LINE CARRYING BOTH IS A BOX. `02-callook-info-k2cc-json.json` is `8 CLARKSON AVE, P.O. BOX
 * 8550`, and which of the two callook geocoded is not stated anywhere in the response. So the
 * cautious reading is taken, exactly as `PO_BOX` already asks "does this line name a box" rather
 * than "is this line only a box": labelling a street geocode as a mail drop costs a caveat nobody
 * needed, and the other way round costs a verdict computed from a post office.
 */
function geocodeSubject(line1: string | undefined): GeocodedFrom {
  if (line1 === undefined) return 'address_not_stated';
  return PO_BOX.test(line1) ? 'po_box' : 'street_address';
}

/**
 * The point, filed under the key that names what it is.
 *
 * Three keys for one shape looks like ceremony until you write the consumer: `geocode.poBox` does
 * not typecheck on the street-address arm, so a caller cannot reach ANY coordinate without first
 * narrowing to one, and narrowing is where they find out they are holding a post office. The
 * `switch` is exhaustive and tsc checks it, so a fourth kind of address stops the build here rather
 * than arriving downstream under whichever key was nearest.
 */
function attributePoint(point: GeocodedPoint, geocodedFrom: GeocodedFrom): MailingGeocode {
  switch (geocodedFrom) {
    case 'po_box':
      return { geocodedFrom, poBox: point };
    case 'street_address':
      return { geocodedFrom, mailingAddress: point };
    case 'address_not_stated':
      return { geocodedFrom, unattributed: point };
  }
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
  const geocodedFrom = geocodeSubject(line1);
  const result: CallsignRecord = {
    // What the licensee holds NOW, which is not always what was asked for: callook answers a
    // lookup of a superseded callsign with the current record for that licensee. The caller must
    // use THIS value, and may usefully say "we found you under WV0ZZZ" when it differs.
    callsign: normaliseCallsign(callsign),
    type,
    name,
    // False also means "we were given no address at all", which is normal — about 1.3% of records
    // carry none. It is never a claim that we looked and found a street address — and that is why
    // `geocodeSubject` has THREE answers where this boolean has two, rather than the coordinate
    // being filed from this flag.
    isPoBox: geocodedFrom === 'po_box',
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

  /*
   * THE FIELD THIS PARSER USED TO STEP OVER.
   *
   * Read from `body.location` and NOT from anything derived here: the grid square in particular is
   * callook's own statement and not this software's arithmetic on the pair beside it.
   *
   * WHAT IT DOES WHEN THERE IS NO ADDRESS, established rather than assumed:
   * `person-no-address.json` — the ~1.3% shape — carries a `location` whose three fields are all
   * `""`, so nothing is kept and the third arm of {@link GeocodedFrom} never arises from a real
   * body. The arm exists anyway, because "the source stated a coordinate and showed us no address
   * to attribute it to" is a shape this module must have an answer for, and the answer is to keep
   * the value and withhold the claim, exactly as `operClassRaw` does beside an undefined
   * `operClass`.
   *
   * A REFUSAL IS SET WHERE A POINT IS NOT, AND NEVER BOTH. The two fields are one answer with two
   * shapes — `readLocation` returns exactly one of them — and an exhaustive `switch` is what keeps
   * a fourth reading from arriving downstream under whichever key was nearest.
   */
  const location = readLocation(record(body.location));
  switch (location.kind) {
    case 'point':
      result.mailingGeocode = attributePoint(location.point, geocodedFrom);
      break;
    case 'refused':
      result.geocodeRefusal = location.refusal;
      break;
    case 'silent':
      break;
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
 * "It asked us to wait" — never "it is broken" and never "your callsign is wrong".
 *
 * A 429 with a `Retry-After` is the most cooperative thing a source can do: it is telling us how
 * often it wants to be asked, in a header written for exactly this. Reporting that as `HTTP 429
 * instead of a licence record` — which is what this path did until 2026-08-04 — reads to the person
 * in front of it as a failure, and reads to anybody debugging it as callook.info misbehaving. It is
 * the opposite: the source is fine, the answer is fine, and the only thing that happened is that
 * this software has been asked to slow down and has.
 *
 * `sent` is false when no request was made at all, because the previous answer's hold was still
 * running. That distinction is the whole reason the hold exists, so the sentence says which it was.
 */
function askedToWaitMessage(remainingMs: number, sent: boolean): string {
  return (
    `callook.info asked GrantSpotter to wait before asking it again, so ` +
    (sent ? 'nothing was filled in this time' : 'no request was sent this time') +
    `. Nothing is wrong with your callsign and nothing is wrong with the source: it is telling us ` +
    `how often it wants to be asked, and GrantSpotter is doing what it asked. Try the button ` +
    `again in ${describeWait(remainingMs)}, or type your licence details in and carry on — ` +
    `nothing here depends on this lookup.`
  );
}

/**
 * "Somebody else's press got there first" — which is a fact about GrantSpotter, and says so.
 *
 * The other three pre-request refusals are about the callsign, the operator's configuration, or
 * something the source said. This one is about a rule of ours, so it does not borrow any of their
 * explanations: callook.info has not refused anything, is not slow, and may not even be involved by
 * the time this is read. Naming ourselves is also the only honest way to explain why a second
 * person pressing the same button at the same moment is told to wait a beat.
 */
function alreadyAskingMessage(): string {
  return (
    'GrantSpotter was already waiting on an answer from callook.info when you pressed, and it asks ' +
    'that source one question at a time, so this press did not send a second request. Nothing is ' +
    'wrong with your callsign and nothing is wrong with the source — this is a rule of ' +
    'GrantSpotter’s own. Press the button again in a moment, or type your licence details in and ' +
    'carry on; nothing here depends on this lookup.'
  );
}

/**
 * The message for a host this installation is configured to refuse to contact.
 *
 * Shared by {@link lookupCallsign} and nothing else, but written beside its siblings so that the
 * three pre-request refusals are read together.
 */
function blockedMessage(error: unknown): string {
  return (
    `This installation is set up to look callsigns up somewhere GrantSpotter refuses to ` +
    `contact, so nothing was checked. That is a setting on this server, not a problem with ` +
    `your callsign — whoever runs it can fix it (${error instanceof Error ? error.message : String(error)}). ` +
    `Type your details in meanwhile.`
  );
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
 * RETRIES: NONE. One press of the button is one request, and that is a promise made to two
 * different readers who both have to be able to check it — the person watching the spinner, who is
 * told the wait is bounded by {@link DEFAULT_TIMEOUT_MS}, and callook.info, whom the README tells
 * that this feature is "one user-initiated request to one host" and not a crawl. It used to retry
 * once on a dropped connection, on the reasoning that a coin-flip worth flipping twice "costs
 * nothing when it succeeds". It cost something when it FAILED: a fresh timeout budget per attempt,
 * measured at two requests and 1808 ms against a 1000 ms budget, and a second request to a host
 * that had just dropped the first one. Both published sentences were false while that stood, and
 * of the two ways to make them agree — widen the promise, or narrow the code — narrowing the code
 * is the one that leaves a promise worth having. A dropped connection now says so and offers the
 * button again, which is a retry the person decides on.
 *
 * AN HTTP STATUS IS NOT RETRIED EITHER, and since 2026-08-04 a 429 is not merely not-retried: it
 * is REMEMBERED. This path still has no backoff to sleep in — it is in front of a person watching
 * a spinner — but "we cannot wait for you" was never a reason to keep asking. A 429, and a 503 that
 * carries a `Retry-After` we can read, put the host in {@link CallsignLookupDeps.cooldown}, and the
 * next press inside that window answers the person without a request at all. Measured before that
 * existed: eight presses at a stand-in answering `429 Retry-After: 120` produced eight requests in
 * 69 ms. The site whose robots.txt says `Disallow: /` was the one being hammered, which is the
 * exact inverse of the argument this feature is defended with.
 *
 * AND ONE PRESS AT A TIME PER HOST, which is what makes the paragraph above true of presses that
 * OVERLAP rather than only of presses that queue politely behind each other. The hold is written
 * when an answer arrives; every press that starts before then reads a ledger that is still empty.
 * Measured 2026-08-04 against the same stand-in, eight presses fired concurrently rather than in
 * sequence: EIGHT requests, with the cooldown in place and working exactly as its own tests
 * describe. `beginAsking` closes that window — see `cooldown.ts` for why the lane belongs to the
 * host rather than to the session, and why the losing press is refused rather than parked.
 */
export async function lookupCallsign(
  callsign: string,
  deps: CallsignLookupDeps,
): Promise<CallsignLookupResult> {
  const wanted = normaliseCallsign(callsign);
  const refusal = refuseBeforeRequest(callsign, deps);
  /*
   * NOT A CALLSIGN IS NOT A COUNTRY, AND IT GETS ITS OWN STATUS SO THAT NOBODY HAS TO READ IT AS
   * ONE.
   *
   * Its own status rather than its own sentence under `not_us`, because `not_us` is a CLAIM — the
   * client renders a heading saying this callsign is not American — and the claim is what was
   * false. A sixth status is the thing the cooldown case deliberately did not add (see the NOTES in
   * this module's tests); the difference is that a hold and a network failure share a true frame,
   * "nothing was filled in and nothing is claimed", while "not a US callsign" and "not a callsign"
   * do not share one. `packages/web`'s `KNOWN_STATUSES` guard is extended in the same change, which
   * is what keeps the politest outcome in the product from being rendered as the most alarming one.
   */
  if (refusal?.kind === 'malformed') {
    return {
      status: 'malformed',
      /*
       * SHORT, AND ABOUT WHAT THIS PROCESS DID. The advice — check for a stray character, mind the
       * "/P" suffix — belongs to the client's frame, which renders directly above this sentence;
       * saying it in both places makes a person read the same paragraph twice and is the division
       * of labour this module keeps everywhere else ("this copy is what the SCREEN promises; that
       * message is what the SERVER observed"). What only this side knows is the string it was
       * handed, that it asked nobody, and that it is claiming nothing about a country.
       */
      message:
        `GrantSpotter could not read "${clip(wanted, 16)}" as a callsign, so it asked callook.info ` +
        `nothing and is saying nothing about which country issued your licence. Check what you ` +
        `typed; if it is right exactly as it stands, type your licence details in and carry on, ` +
        `because nothing here depends on this lookup.`,
    };
  }
  if (refusal?.kind === 'not_us') {
    // Quoted back so the reader can see what we read, but capped: this is the one message that can
    // be built from arbitrary input, and a pasted paragraph must not become a pasted paragraph
    // with an apology around it. No US callsign is longer than 6 characters.
    const quoted = clip(wanted, 16);
    return {
      status: 'not_us',
      message:
        `GrantSpotter can only look up United States callsigns automatically — the source it ` +
        `asks, callook.info, holds FCC records and nothing else — and "${quoted}" is not one it ` +
        `can answer for. It IS a callsign, which is why this says nothing worse than that: if you ` +
        `meant a US one, check it for a typo. Otherwise just type your licence details in ` +
        `yourself: every part of ` +
        `GrantSpotter works the same either way, and your licence is no less valid for being ` +
        `issued somewhere this lookup cannot reach.`,
    };
  }
  if (refusal?.kind === 'blocked') return unavailable(blockedMessage(refusal.error));
  // THE HOLD, READ BEFORE ANY SOCKET EXISTS. `unavailable` and not a status of its own, and that is
  // still true now that `malformed` exists: every ending `unavailable` covers shares one true
  // frame — no record, nothing filled in, nothing claimed about the callsign — and the sentence is
  // what carries which ending it was. A status is worth adding only when the frame would otherwise
  // say something false, which is what `malformed` was for. See NOTES in this module's tests.
  if (refusal?.kind === 'cooling') {
    return unavailable(askedToWaitMessage(refusal.remainingMs, false));
  }
  if (refusal?.kind === 'busy') return unavailable(alreadyAskingMessage());

  const url = targetUrl(wanted, deps);

  /*
   * THE LANE, CLAIMED BEFORE ANY SOCKET EXISTS AND RELEASED WHATEVER HAPPENS TO IT.
   *
   * `refuseBeforeRequest` above only READ this, because `wouldReachTheSource` shares it and a
   * predicate that claimed a lane would be a predicate with a side effect. The claim is here, and
   * it is a check-and-take in one call: nothing may run between deciding the lane is free and
   * taking it.
   *
   * A SECOND REFUSAL RATHER THAN AN ASSERTION, and today it is unreachable — node runs one thing at
   * a time and there is no `await` between the read above and this line, nor between the route's
   * own `wouldReachTheSource` and this function's first statement. That is a property of code
   * somebody could edit, so the belt is here as well as the braces, and it fails towards refusing a
   * press rather than towards sending a request nobody bounded.
   */
  const release = deps.cooldown.beginAsking(cooldownKey(url));
  if (release === undefined) return unavailable(alreadyAskingMessage());
  try {
    return await askTheSource(wanted, url, deps);
  } finally {
    // `finally` and not a line at each exit: this function has ten of them and a thrown error is an
    // eleventh. A lane never released is a lookup that answers "already asking" for the life of the
    // process, which would be this fix turning into a worse outage than the defect it closes.
    release();
  }
}

/**
 * The request itself, and everything that can be said about what came back.
 *
 * Split from {@link lookupCallsign} on 2026-08-04 so the host's lane is held across the WHOLE of
 * it — the request, the body read and the parse — by one `try`/`finally` around one call, rather
 * than by a release repeated at each of the ten places this can return.
 */
async function askTheSource(
  wanted: string,
  url: string,
  deps: CallsignLookupDeps,
): Promise<CallsignLookupResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  let response: Response;
  try {
    // THE ONLY REQUEST. There is no loop around this on purpose; see the RETRIES paragraph above.
    response = await deps.transport(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      // We do not follow redirects. Following one means requesting a host that has not been
      // past `assertNotBlocked`, and one request per call is the promise this module makes.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    /*
     * NO "IN A MOMENT". Both arms said "try again in a moment" until 2026-08-12, and neither had
     * anything behind the moment: one is a socket that stopped answering inside our own timeout
     * and the other is a transport failure whose cause is unknown. Neither event says a single
     * thing about when the source will next answer, and this product's one-number rule
     * (`userFacingCopyContract.test.ts`) exists because a wait nobody measured is worse than no
     * advice. The instruction survives; the invented duration does not.
     */
    return unavailable(
      wasAborted(error)
        ? 'callook.info did not answer in time, so nothing was filled in. That is the network or ' +
          'the source being slow, not anything to do with your callsign — try again, or type ' +
          'your details in and carry on.'
        : 'We could not reach callook.info, so nothing was filled in. That is our end or the ' +
          'network, not your callsign — try again, or type your details in and carry on.',
    );
  }

  /*
   * "PLEASE STOP", HEARD AND WRITTEN DOWN.
   *
   * 429 always, whatever the header says or fails to say: the status itself IS the instruction —
   * "you are asking too often" — and a 429 with no readable `Retry-After` has still asked. A bare
   * 503 is not that. It says "I am broken right now", which is trouble rather than an instruction,
   * and it keeps the plain HTTP-status message below; only a 503 that carries a `Retry-After` we
   * can actually read has told us anything about when to come back, and only that one arms a hold.
   * Drawing the line at the header rather than at the status is what keeps this a matter of doing
   * what the source said instead of guessing at what it meant.
   *
   * `Retry-After: 0` is not "ask me again now": it is "I am not asking for more than your own
   * floor", exactly as the crawler reads it (`hostQueue.ts`). Our floor still applies, because the
   * thing our floor exists to prevent is the eight-in-69-ms burst that was measured here.
   */
  if (response.status === 429 || response.status === 503) {
    const asked = parseRetryAfterMs(response.headers.get('retry-after'), now());
    if (response.status === 429 || asked !== undefined) {
      const held = clampCooldownMs(asked ?? COOLDOWN_FLOOR_MS);
      deps.cooldown.hold(cooldownKey(url), held, now());
      return unavailable(askedToWaitMessage(held, true));
    }
  }

  /*
   * A REDIRECT IS OUR DECISION, NOT THE SOURCE'S FAULT, AND THE SENTENCE NOW SAYS WHOSE IT IS.
   *
   * This used to fall into the status message below and read "callook.info answered with HTTP 301
   * instead of a licence record… That is the source having trouble". A 301 is not trouble. It is a
   * perfectly good answer meaning "the thing you asked for is over here", and the only reason it
   * ends the lookup is that four lines up we set `redirect: 'manual'` ON PURPOSE — following one
   * would mean requesting a host that has never been past `assertNotBlocked`, and would make a
   * feature defended in public as "one press, one request, one host" into two requests to two
   * hosts. Blaming the source for a rule of ours is the same class of mistake as attributing an
   * unread body to it, which this file already refuses to make one paragraph down.
   *
   * The `Location` is deliberately not quoted: it is a value from outside addressed to a person who
   * cannot act on it, and the operator's copy of it is in the source's own logs, not in a form.
   */
  if (response.status >= 300 && response.status < 400) {
    return unavailable(
      `callook.info answered with a redirect (HTTP ${response.status}) rather than a licence ` +
        `record, and GrantSpotter did not follow it, so nothing was filled in. That is a rule of ` +
        `GrantSpotter’s own rather than a fault at callook.info: one press of this button is one ` +
        `request to one host that has been checked, and following a redirect would make it a ` +
        `second request to a host that has not been. Nothing is wrong with your callsign — type ` +
        `your licence details in and carry on; nothing here depends on this lookup.`,
    );
  }

  if (response.status !== 200) {
    return unavailable(
      `callook.info answered with HTTP ${response.status} instead of a licence record, so ` +
        `nothing was filled in. That is the source having trouble, not your callsign — try again ` +
        `later, or type your details in and carry on.`,
    );
  }

  /*
   * TWO FAILURES THAT USED TO BE ONE, AND THE ONE THEY WERE BOTH REPORTED AS WAS A LIE.
   *
   * `JSON.parse(await response.text())` sat inside a single bare `catch {}`, so a timeout or a
   * dropped socket DURING THE BODY READ came out as "callook.info answered with something we could
   * not read as a licence record" — our own failure, attributed to the source as a statement it
   * made. This product's entire discipline is not attributing to a source something it did not say,
   * and an error message is not exempt from it: a person reading that sentence, or an operator
   * reading it in a bug report, is being told callook.info served rubbish when what happened is
   * that we never received the answer.
   *
   * So the read is its own step with its own failure. Below it, `JSON.parse` speaks only about
   * bytes we actually hold, which is the only thing that entitles anyone to say what the source
   * answered with.
   */
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    // Same correction as the two arms above, and for the same reason: a body that stopped
    // arriving and a connection that dropped mid-answer are not statements about when the source
    // will answer next. "In a moment" was ours, and it is gone.
    return unavailable(
      wasAborted(error)
        ? 'callook.info started answering, but the rest of the answer had not arrived by the time ' +
          'GrantSpotter stopped waiting, so nothing was filled in. What it was going to say is ' +
          'not known and has not been guessed at. That is the network or the source being slow, ' +
          'not anything to do with your callsign — try again, or type your details in and ' +
          'carry on.'
        : 'The connection to callook.info dropped while its answer was still arriving, so ' +
          'GrantSpotter never saw the whole of it and nothing was filled in. What it was going ' +
          'to say is not known and has not been guessed at. That is our end or the network, not ' +
          'your callsign — try again, or type your details in and carry on.',
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
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
      /*
       * Its API reference: the database reloads from the FCC snapshot daily at 11:00 AM ET and
       * the site is offline while it does, "usually less than five minutes".
       *
       * THE ONE DURATION HERE IS THE SOURCE'S OWN, AND IT IS THE ONLY ONE ALLOWED TO BE HERE.
       * This sentence ended "Try again shortly, or type your details in and carry on." until
       * 2026-08-12, which was the harder of the five invented waits to see precisely BECAUSE a
       * sourced figure was sitting two clauses away: callook publishes "usually less than five
       * minutes" and this message quotes it, attributed, which is exactly what the product is
       * for. "Shortly" was not that figure. It was a second, vaguer, unattributed answer to the
       * same question, and where the two disagree the reader has no way to tell which one came
       * from the source. Quoting the source's own number and stopping is strictly more
       * informative than quoting it and then adding one of ours.
       */
      message:
        'callook.info is reloading its copy of the FCC database right now — it does that once a ' +
        'day, at about 11:00 in the morning US Eastern time, and it says the reload usually takes ' +
        'under five minutes. Nothing is wrong with your callsign. Type your details in and ' +
        'carry on.',
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
