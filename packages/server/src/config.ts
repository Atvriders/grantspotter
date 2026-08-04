import { canonicalHostname, unreachableContactHost } from './net/hosts.js';

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  sessionSecret: string;
  contactUrl: string;
  dataDir: string;
  crawlEnabled: boolean;
  crawlCron: string;
  /**
   * The user-initiated callsign lookup at `POST /api/callsign/lookup`. Default TRUE — the owner
   * asked for the feature — and it is a switch rather than a constant because it is the one path
   * in this product that contacts a host whose `robots.txt` says `Disallow: /`. That is defended
   * at length in `callsign/callook.ts` and in the README, and the defence rests on it being one
   * request a person asked for rather than a crawl. An operator who reads the argument and does
   * not accept it should not have to fork the image, so: `CALLSIGN_LOOKUP_ENABLED=false`, and
   * `index.ts` does not register the router at all.
   */
  callsignLookupEnabled: boolean;
  anthropicApiKey?: string;
  simplerGrantsApiKey?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const MIN_SESSION_SECRET_LENGTH = 32;
export const SERVER_VERSION = '0.1.0';

/**
 * The literal value `docker-compose.yml` ships for SESSION_SECRET — one of the TWO variables an
 * operator has to edit before the first run, and one of the two with no default.
 *
 * (It said "two" until 2026-08-04, then "the only one" for the day CONTACT_URL had a default, and
 * it is two again now that the default is gone. The constant below is only ever about the secret;
 * CONTACT_URL's shipped placeholder is `PLACEHOLDER_CONTACT_URL`, and the two are refused by
 * different rules for the reason recorded there.)
 *
 * Until 2026-08-04 the compose file wrote `${SESSION_SECRET:?…}`, and that `:?` was doing real
 * work: `docker compose up` refused to run at all until the operator supplied a value. Moving the
 * configuration inline — one file to edit, no `.env` to copy — took that fail-fast away, and on a
 * PUBLIC repository the naive replacement is worse than nothing. `loadConfig` below requires
 * SESSION_SECRET and enforces a length, but it never cared WHICH 32 characters, so a shipped
 * placeholder would start the server with a session-signing key that is published on GitHub, and
 * anyone who can read this file could forge a session cookie for every deployment that never got
 * edited. The refusal has to move to where it can still see the value, which is here.
 *
 * The first version of this check was `value.includes('CHANGE_ME')`, and that was ADDITIVE: it
 * caught the operator who pastes a real secret NEXT to the marker, and missed the one who deletes
 * the marker. Deleting the prefix is at least as natural an edit, and it leaves
 * `generate_one_with_openssl_rand_hex_32_and_paste_it_here` — 55 characters, still over the length
 * floor, still committed in this repository verbatim, and the server started on it.
 *
 * So the rule below is not a marker list, it is EVERY marker: a value is refused if it shares any
 * PLACEHOLDER_RUN_LENGTH-character run with the shipped placeholder, compared case-folded. The
 * 58 runs of the 65-character placeholder include `CHANGE_ME`, `GENERATE`, `OPENSSL`, `RAND_HEX`
 * and `AND_PASTE`, and also every window straddling them, so deleting the prefix, deleting the
 * suffix, keeping the middle and retyping any of it in another case all still leave a hit.
 *
 * Why every one of those runs is collision-free against a correctly generated secret: the error
 * message instructs `openssl rand -hex 32`, whose entire output alphabet is [0-9a-f]. The longest
 * all-hex run anywhere in the placeholder is `32`, two characters — every other character in it is
 * an underscore or a letter outside a-f (g, h, i, l, m, n, o, p, r, s, t, w, x). So no 8-character
 * window of the placeholder is all-hex, therefore no all-hex value can contain one, therefore this
 * rule cannot refuse a secret produced the way the message says. `config.test.ts` asserts that
 * property by scanning the windows rather than trusting this paragraph.
 *
 * 8 is the shortest run that keeps that proof (the longest all-hex run is 2, so 3 would already
 * do) while staying long enough that a value which is not a placeholder at all is not going to
 * contain one by accident: it is a whole word of English, not a syllable.
 */
export const PLACEHOLDER_MARKER = 'CHANGE_ME';
export const PLACEHOLDER_RUN_LENGTH = 8;
export const PLACEHOLDER_SESSION_SECRET =
  'CHANGE_ME_generate_one_with_openssl_rand_hex_32_and_paste_it_here';

/**
 * The literal value `docker-compose.yml` ships for CONTACT_URL. The second of the two values an
 * operator must edit before the first run, and the second with no default.
 *
 * (It was called FORMER_PLACEHOLDER_CONTACT_URL for the one day CONTACT_URL had a default and
 * nothing shipped it. It is shipped again, so the name is accurate again.)
 *
 * WHY THIS IS NOT GUARDED THE WAY THE SESSION SECRET IS, which is the obvious thing to reach for
 * and would be a bug. `sharesRunWith` refuses a value sharing any eight-character run with the
 * placeholder, and that is safe for a secret because `openssl rand -hex 32` emits `[0-9a-f]` and no
 * eight-character window of the shipped secret is all-hex. It is not safe here: `https://` is an
 * eight-character run of this string, so the rule would refuse every https URL on earth, starting
 * with the operator's real one.
 *
 * What guards this instead is two independent rules, either of which catches it alone — which is
 * what makes a half-edit safe without a run check:
 *
 *   keep the marker, change the host  ->  `isPlaceholder` refuses it ("still contains CHANGE_ME")
 *   delete the marker, keep the host  ->  `reservedContactName` refuses it (example.org, RFC 2606)
 *
 * so the two edits an operator's hand actually makes are each caught by the rule the other one
 * escaped, and only replacing the whole value gets past both. `config.test.ts` walks exactly those
 * two half-edits, and `compose.test.ts` feeds this file's own literals to the real `loadConfig`.
 */
export const PLACEHOLDER_CONTACT_URL =
  'https://example.org/CHANGE_ME_to_a_page_that_says_who_runs_this';

/*
 * CONTACT_URL IS REQUIRED AND HAS NO DEFAULT. Every operator names their own address.
 *
 * A section note and not a docblock, because there is no longer a constant here for it to document
 * — which is the decision itself.
 *
 * It briefly had one — this project's GitHub issue tracker — on the reasoning that a first run
 * should not depend on the operator inventing a contact page. The owner removed it, and the reason
 * is the one that decides this: a shared default makes the maintainers of the SOFTWARE the contact
 * for every deployment of it, including the ones they do not run, cannot inspect and cannot stop.
 * Somebody would be reading complaints about other people's crawlers with no power to act on them,
 * and the site owner who wrote in would get an apology instead of a result. Pointing at the
 * repository without saying "open an issue" would not have helped: a repository is a place where
 * people open issues.
 *
 * So the requirement is back, and it is stronger for politeness than a default was. The server
 * refuses to start without a contact URL, so no deployment can poll anonymously; and the address
 * it does carry belongs to the person who can actually switch that instance off.
 *
 * The remedy that works no matter who is running what remains `robots.txt`: every instance honours
 * it, matched case-insensitively on the `GrantSpotter` token (`fetcher/index.ts` AGENT_TOKEN), with
 * or without a version or suffix after it — so the string a site owner reads in their log stops us
 * as readily as the bare token, which was NOT true until 2026-08-04. `User-agent: GrantSpotter` +
 * `Disallow: /` takes effect on the next nightly crawl: `runCrawl` drops the fetcher's robots cache
 * at the start of every run, and the cache expires after ROBOTS_CACHE_TTL_MS regardless, so no
 * deployment holds a stale copy for longer than a day.
 *
 * What CONTACT_URL must be is checked, not merely parsed — see `assertUsableContactUrl`. An address
 * that reaches nobody is the failure this value exists to prevent, so a documentation domain, a
 * loopback or private address, and a leftover placeholder are all refused.
 */

/**
 * Names reserved so that documentation cannot name anybody: RFC 2606 §3 (the second-level
 * `example.*`) and RFC 2606 §2 / RFC 6761 (the reserved TLDs).
 *
 * CONTACT_URL is refused if it is under one of these. The reason is specific to what this value
 * DOES: it is pasted into the crawler's User-Agent, and it is the only route by which one of the
 * ~25 small nonprofits this polls can find out who is polling them. A URL under a reserved name is
 * guaranteed to reach nobody — that is the entire purpose of reserving it — so an operator using
 * one is anonymous while looking identified, which is worse than being obviously anonymous.
 *
 * The old CONTACT_URL error message offered `https://www.example.org/grantspotter` as its worked
 * example, and that string passed this loader. An error whose own example satisfies the check is
 * not guidance; it is a second placeholder, handed over at the moment the operator is most likely
 * to paste whatever they are shown. The message below therefore describes what is needed.
 *
 * What this check does NOT claim: that the URL resolves, that anything is served there, or that a
 * human reads the mail. It cannot know any of that. It rules out the addresses that are reserved
 * to be nobody's, and no more.
 */
export const RESERVED_CONTACT_HOSTS = ['example.com', 'example.net', 'example.org'] as const;
export const RESERVED_CONTACT_TLDS = ['invalid', 'test', 'example'] as const;

/**
 * The reserved name a hostname falls under, or null.
 *
 * Exported so `config.test.ts` can pin the RFC list itself rather than only its effect through
 * `loadConfig`. It said "the live scripts check it too" until 2026-08-04, and that was false when
 * it was written: nothing outside this file and its test has ever called it. The scripts did not
 * check this, or anything else — they built a User-Agent straight from `process.env.CONTACT_URL`.
 * They now go through `resolveContactUrl` below, which is the only caller that ever mattered: one
 * predicate, called by every path, rather than a comment asking each path to remember.
 */
export function reservedContactName(hostname: string): string | null {
  // A trailing dot is a legal absolute name and `example.org.` is the same host as `example.org`.
  // `canonicalHostname` rather than a `.replace(/\.$/, '')` written here: this rule and
  // `unreachableContactHost` each had their own copy of that expression, each one dot deep, and
  // `https://example.org../x` passed both — see net/hosts.ts.
  const host = canonicalHostname(hostname);
  for (const name of RESERVED_CONTACT_HOSTS) {
    if (host === name || host.endsWith(`.${name}`)) return name;
  }
  const tld = host.slice(host.lastIndexOf('.') + 1);
  for (const name of RESERVED_CONTACT_TLDS) {
    if (tld === name) return `.${name}`;
  }
  return null;
}

type Env = Record<string, string | undefined>;

function optional(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${key} must be "true" or "false"; got "${raw}".`);
}

function parsePort(env: Env, key: string, fallback: number): number {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${key} must be an integer between 1 and 65535; got "${raw}".`);
  }
  return value;
}

/** Case-insensitive: an operator who lowercased the marker still shipped the placeholder. */
function isPlaceholder(value: string): boolean {
  return value.toUpperCase().includes(PLACEHOLDER_MARKER);
}

/**
 * True when `value` and `placeholder` share any run of `runLength` characters, case-folded.
 *
 * Subsumes isPlaceholder for SESSION_SECRET — `CHANGE_ME` is nine characters and is itself a run
 * of the placeholder — and catches the half-edits it never could. O(len × len) on two strings of
 * about 64 characters, once per process start.
 */
function sharesRunWith(value: string, placeholder: string, runLength: number): boolean {
  const folded = value.toUpperCase();
  const shipped = placeholder.toUpperCase();
  for (let i = 0; i + runLength <= folded.length; i += 1) {
    if (shipped.includes(folded.slice(i, i + runLength))) return true;
  }
  return false;
}

function parseNodeEnv(env: Env): NodeEnv {
  const raw = optional(env, 'NODE_ENV');
  if (raw === 'production' || raw === 'test' || raw === 'development') return raw;
  return 'development';
}

/**
 * Characters that must never reach the header: C0 controls, DEL, and anything above ASCII.
 *
 * THIS IS A CORRECTNESS RULE, NOT TIDINESS. `new URL()` deletes TAB, CR and LF from ANYWHERE in
 * its input — not just the ends, which `optional` already trims — so before this rule existed the
 * string this loader validated and the string the fetcher put in the header were two different
 * strings. Measured against the built artefact on 2026-08-04:
 *
 *   CONTACT_URL="https://w9xyz-radio-club.org/a<TAB>b"
 *     validated as https://w9xyz-radio-club.org/ab   (the tab is gone before any check runs)
 *     sent as      https://w9xyz-radio-club.org/a<TAB>b
 *
 *   CONTACT_URL="https://w9xyz-radio-club.org/about<CR><LF>X-Injected: yes"
 *     validated as one address, and `new Headers()` then threw `invalid header value` on every
 *     outbound request — a config that booted clean and broke the crawler on its first fetch.
 *
 * Refusing the whole non-printable range and everything above 0x7e makes one sentence provable
 * rather than hopeful: **no character is silently deleted before the scheme and host are read, so
 * the address this loader checked is the address the header names.** A URL has a percent-encoding
 * for every character this excludes, and an internationalised host has a punycode form, so nothing
 * addressable is lost — the error below says so and prints the encoded form when it can.
 *
 * The space is handled separately, below, because it is not deleted: `not a url` has to keep
 * reporting "must be an http(s) URL", which is what is actually wrong with it.
 */
const CONTACT_URL_UNSENDABLE = /[^\x20-\x7e]/;

/**
 * THE ONE PREDICATE. Every path that can put a User-Agent on the wire calls this, or calls
 * something that does.
 *
 * WHY IT IS A SEPARATE FUNCTION AND NOT SIX LINES INSIDE `loadConfig`. Because for two commits it
 * WAS six lines inside `loadConfig`, and `scripts/verify-sources.ts` and `scripts/capture-fixture.ts`
 * — both documented in the README, both hitting the same live nonprofit sites the nightly crawl
 * hits — read `process.env.CONTACT_URL` themselves and never called the loader. Measured before
 * the fix: `CONTACT_URL='not a url' npm run verify-sources -- qcwa` fetched qcwa.org and got a
 * live 200, sending `GrantSpotter/0.1.0 (+not a url; …)`. Every value this function refuses went
 * out on the wire that way: `example.org`, a `.invalid` host, a `CHANGE_ME` string, `ftp://…`.
 *
 * A guard that lives in one entry point and is skipped by two others is not a guard. So the rules
 * live here; `loadConfig`, `resolveContactUrl` and `buildUserAgent` all call it, `createFetcher`
 * refuses a User-Agent this function did not produce, and
 * `test/contactUrlEntryPointContract.test.ts` fails if a new file starts reading CONTACT_URL or
 * building a User-Agent without going through one of them.
 *
 * Returns the value, so it can be used inline.
 */
export function assertUsableContactUrl(value: string): string {
  if (value.trim() === '') {
    // Names where to make the edit and what the value is for. An operator whose server will not
    // start and who is told only "required" types the fastest thing that parses, and the fastest
    // thing that parses reaches nobody — which is the failure this variable exists to prevent.
    // What it must NOT do is print an address: this is the moment somebody pastes what they are
    // shown, and there is no address this software could print that would reach the operator.
    throw new ConfigError(
      'CONTACT_URL is required and has no default: the crawler User-Agent must name a contact ' +
        'URL. Set it in docker-compose.yml to an http(s) page you control and can be reached ' +
        'through — it is how one of the ~25 small nonprofits this polls finds out who is polling ' +
        'them and asks you to stop.',
    );
  }
  // Above every shape rule, on purpose: the retired placeholder parses as https, so it would
  // otherwise reach `new URL` and pass — and a later edit that broke its shape would report "must
  // be an http(s) URL" about a value whose real problem is that it is nobody's address. The
  // ordering is the same one SESSION_SECRET's placeholder check needs, and for the same reason:
  // the message that fires must be the one that says "you did not finish editing this".
  if (isPlaceholder(value)) {
    // No worked example here on purpose. The version of this message that ended "for example
    // https://www.example.org/grantspotter" was handing out a value that this very loader
    // accepted, at the moment the operator is most likely to paste whatever they are shown.
    //
    // Nor does it offer "unset it and take the default", which it did for one day: there is no
    // default to take, and there is no address this software can supply on an operator's behalf
    // that would reach the operator.
    throw new ConfigError(
      'CONTACT_URL still contains CHANGE_ME, so it is a placeholder rather than an address. It is ' +
        'one of the two values in docker-compose.yml you must edit before the first run. Replace ' +
        'it with an http(s) page you control and can be reached through: it goes in the crawler ' +
        'User-Agent, and it is how one of the ~25 small nonprofits this polls finds out who is ' +
        'polling them and asks you to stop.',
    );
  }
  if (CONTACT_URL_UNSENDABLE.test(value)) {
    // Best-effort: if it parses at all, show the operator the ASCII form of what they typed,
    // because that form is usually exactly what they meant and this loader accepts it.
    let encoded = '';
    try {
      encoded = ` The encoded form of what you set is "${new URL(value).href}".`;
    } catch {
      encoded = '';
    }
    throw new ConfigError(
      'CONTACT_URL may contain only printable ASCII, and this value contains a control character ' +
        'or a character above ASCII. It is copied verbatim into an HTTP header, and a URL parser ' +
        'silently deletes tabs, carriage returns and newlines from anywhere in it — so a value ' +
        'like this is checked as one address and sent as another, and a line break in it makes ' +
        'every outbound request fail on an invalid header. Percent-encode anything unusual, and ' +
        `use the punycode form of an international host.${encoded}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`CONTACT_URL must be an http(s) URL; got "${value}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`CONTACT_URL must be an http(s) URL; got "${value}".`);
  }
  if (value.includes(' ')) {
    // A space survives `new URL` (it is percent-encoded in `href`, not dropped), so unlike the
    // control characters above it does not change what was checked — but the header would then
    // print an address no reader can copy, and `href` and the printed value would disagree.
    throw new ConfigError(
      `CONTACT_URL must not contain a space; percent-encode it as %20. Got "${value}".`,
    );
  }
  const reserved = reservedContactName(parsed.hostname);
  if (reserved !== null) {
    throw new ConfigError(
      `CONTACT_URL is under ${reserved}, which is reserved for documentation (RFC 2606) and ` +
        'resolves for nobody. This value is pasted into the crawler User-Agent and is the route ' +
        'by which a site being polled finds out who is polling it, so a reserved name makes this ' +
        'crawler anonymous while looking identified. Use an http(s) page you control and can be ' +
        'reached through — there is no default to fall back on, because no address this software ' +
        'ships with could reach you.',
    );
  }
  /*
   * THE RULE THIS CHECK MAKES CONSISTENT WITH ITS OWN STATED REASON (added 2026-08-04).
   *
   * The reserved-name rule above refuses `example.org` on the ground that it reaches nobody. The
   * loader nevertheless accepted `http://127.0.0.1:3030/grantspotter`, `http://localhost:3030/`,
   * `https://192.168.1.5/`, `http://[::1]/`, `http://0.0.0.0/`, `https://intranet/` and
   * `https://a/` — every one of which is MORE useless to the reader than `example.org` is, because
   * the reader is a sysadmin at a polled nonprofit and those addresses point at their own machine,
   * their own LAN, or nothing. The rule and its rationale disagreed, so one of them had to go.
   *
   * Refusing them is the half that keeps the rationale, and it buys something the documentation
   * rule does not: a private address in an outbound User-Agent tells ~25 third parties how the
   * operator's network is numbered, which this project's own seed validator already refuses to let
   * into a public repository (`seed/validate.ts`, `private-host-detail`). Both now ask
   * `net/hosts.ts` — one list, two anchorings.
   *
   * WHAT IT COSTS, SAID PLAINLY: an operator whose only web page is on their LAN can no longer
   * name it here, and — since the shared default was removed — has nothing to fall back on either.
   * The answer is a page somewhere the reader can actually reach: a club page, a university
   * department page, a personal site, a free static page anywhere on the public web. That is a
   * real cost, and it is the one the owner chose over making somebody else the contact for a
   * deployment they do not run. The message says so rather than pretending there is no cost.
   */
  const unreachable = unreachableContactHost(parsed.hostname);
  if (unreachable !== null) {
    throw new ConfigError(
      `CONTACT_URL points at ${unreachable}, so it cannot be reached from the public internet. ` +
        'This value goes into the crawler User-Agent, where its only reader is somebody at one of ' +
        'the sites being polled: to them a loopback or private address points at their own ' +
        'machine or their own network, which is less use than no address at all, and it tells ' +
        'them how yours is numbered. Use an http(s) page reachable from outside your network — ' +
        'any public page that says who runs this instance and how to reach you will do, and it ' +
        'does not have to be the instance itself.',
    );
  }
  return value;
}

/**
 * The contact URL for this process: the operator's own, and nobody else's.
 *
 * The one place CONTACT_URL is read from an environment. `loadConfig` uses it, and so do the two
 * live scripts in `scripts/`, which is the whole point — see `assertUsableContactUrl`. Before that
 * unification the scripts read the variable themselves and put values the server refuses onto the
 * wire, so this is a boundary, not a convenience wrapper.
 */
export function resolveContactUrl(env: Env = process.env): string {
  // No `?? DEFAULT`. Unset reaches `assertUsableContactUrl`, whose first branch refuses it and says
  // what to set — which is the intended outcome, because there is no address this software can
  // supply on an operator's behalf that would reach the operator.
  //
  // `?? ''` and not `!` or a cast: `optional` returns undefined for both "absent" and "blank", and
  // the empty string is the one value the predicate's first branch is written to reject. Unset and
  // `CONTACT_URL: ""` therefore produce the same refusal, which is right — a variable somebody
  // blanked is not a contact address either.
  return assertUsableContactUrl(optional(env, 'CONTACT_URL') ?? '');
}

export function loadConfig(env: Env = process.env): AppConfig {
  const sessionSecret = optional(env, 'SESSION_SECRET');
  if (sessionSecret === undefined) {
    throw new ConfigError(
      'SESSION_SECRET is required and has no default. Generate one with: openssl rand -hex 32',
    );
  }
  // BEFORE the length rule, on purpose, and now load-bearing rather than merely tidy: a surviving
  // FRAGMENT of the placeholder is usually shorter than 32 characters, so the length rule would
  // otherwise be the branch an operator hits. Its advice — make it longer — is advice that works:
  // pad `openssl_rand_hex_32` out to 32 characters and the server starts, still keyed on a string
  // anyone can read off GitHub. Whatever is left of the placeholder, this branch is the one that
  // must answer, and it is the only one that says "you did not change this".
  if (sharesRunWith(sessionSecret, PLACEHOLDER_SESSION_SECRET, PLACEHOLDER_RUN_LENGTH)) {
    // What this message used to say was "anyone could forge a session cookie for this deployment",
    // and that is not what the code does. auth/session.ts signs `rawId.HMAC(rawId, secret)` and
    // auth/middleware.ts resolves the cookie against sha256(rawId) in the sessions table, so a
    // forged signature still has to name a row that exists. Overstating a security problem is a
    // way of losing the argument later: an operator who checks the claim, finds it inflated and
    // then meets the next warning has been taught to discount it. The true statement is narrower
    // and still bad enough to refuse to start on.
    throw new ConfigError(
      'SESSION_SECRET is still the placeholder from docker-compose.yml, or a piece of it, so it ' +
        'is published in a public repository and is not a secret. It is the HMAC key on the ' +
        'session cookie. That alone does not let anyone mint a session — a cookie still has to ' +
        'name a row in the sessions table — but it does mean the signature no longer proves this ' +
        'server issued the cookie, so any raw session id that leaks (a proxy log, a shared ' +
        'screen, a bookmarked link) can be turned into a working one, and every deployment that ' +
        'skipped this edit is keyed the same. Generate a real one with: openssl rand -hex 32 — ' +
        'then paste the output over the placeholder in docker-compose.yml.',
    );
  }
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigError(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters; got ${sessionSecret.length}.`,
    );
  }

  // Every CONTACT_URL rule lives in `assertUsableContactUrl`, which this shares with the two
  // scripts in `scripts/`. Nothing about the value is decided here any more.
  const contactUrl = resolveContactUrl(env);

  const config: AppConfig = {
    nodeEnv: parseNodeEnv(env),
    port: parsePort(env, 'PORT', 3030),
    sessionSecret,
    contactUrl,
    dataDir: optional(env, 'DATA_DIR') ?? '/data',
    crawlEnabled: parseBool(env, 'CRAWL_ENABLED', true),
    crawlCron: optional(env, 'CRAWL_CRON') ?? '17 3 * * *',
    callsignLookupEnabled: parseBool(env, 'CALLSIGN_LOOKUP_ENABLED', true),
  };

  const anthropicApiKey = optional(env, 'ANTHROPIC_API_KEY');
  if (anthropicApiKey !== undefined) config.anthropicApiKey = anthropicApiKey;
  const simplerGrantsApiKey = optional(env, 'SIMPLER_GRANTS_API_KEY');
  if (simplerGrantsApiKey !== undefined) config.simplerGrantsApiKey = simplerGrantsApiKey;

  return config;
}

/**
 * Descriptive, identifiable User-Agent. Spec §7.1 rule 3.
 *
 * RESOLUTIONS R10: this is the ONLY definition in the repository. It accepts
 * either the loaded config or a bare contact URL so Plan 2's fetcher (whose
 * call sites pass a string) imports this rather than declaring a second one.
 *
 * The trailing clause exists because `+URL` is a convention, and a convention only works on
 * someone who already knows it. The reader this string has to survive is a sysadmin at 2am
 * looking at a log line from software they have never heard of, and what they want to know is
 * what it is, what it wants, and how to make it stop. So the string spells the action out.
 *
 * ONE CLAUSE, FIXED, FOR EVERY DEPLOYMENT. It briefly varied — a private `isGithubIssueTracker`
 * predicate switched the wording to "open an issue there to contact the maintainers" when the URL
 * was a GitHub issue tracker, which was true of the shared default and of nothing else. The default
 * is gone, so every URL that can reach this function belongs to whoever runs the instance, the
 * predicate had no remaining caller, and both are deleted. The sentence that replaces it has to be
 * true of a club's contact page, a university department page and a personal site alike, so it
 * names the operator rather than an action only one shape of page affords.
 */
export function buildUserAgent(source: AppConfig | string): string {
  // Re-validated on the string form as well as the config form, and cheap enough to do on every
  // call: this is the function that MINTS the wire value, so it is the last place that can refuse
  // one. `buildUserAgent('')` still throws "CONTACT_URL is required", which is the first branch of
  // the predicate — the message and the test that pins it are unchanged.
  const url = assertUsableContactUrl(typeof source === 'string' ? source : source.contactUrl);
  return `GrantSpotter/${SERVER_VERSION} (+${url}; nightly grant-deadline change detector; contact the operator of this instance at that page)`;
}
