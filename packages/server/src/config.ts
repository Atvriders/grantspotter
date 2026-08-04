import { unreachableContactHost } from './net/hosts.js';

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  sessionSecret: string;
  contactUrl: string;
  dataDir: string;
  crawlEnabled: boolean;
  crawlCron: string;
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
 * The literal value `docker-compose.yml` ships for SESSION_SECRET — the one variable an operator
 * still has to edit, and the only one with no default.
 *
 * (It read "the two variables that have no default" until 2026-08-04, and both halves of that had
 * stopped being true in the commit above this one: CONTACT_URL gained a working default, so there
 * is one such variable, not two, and the constant below is only ever about the secret.)
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
 * What `docker-compose.yml` shipped for CONTACT_URL until 2026-08-04, kept because the guard that
 * refused it still has to refuse it. It is no longer shipped anywhere: CONTACT_URL has a working
 * default now (below), so nobody has to edit it — but "you no longer have to edit this" is not the
 * same statement as "any value is now fine", and the tests hold the second one by feeding this
 * string back to `loadConfig`.
 */
export const FORMER_PLACEHOLDER_CONTACT_URL =
  'https://example.org/CHANGE_ME_to_a_page_that_says_who_runs_this';

/**
 * Where this crawler points a site owner who wants to talk to a human, when the operator has not
 * named an address of their own.
 *
 * This used to be required with no default, on the reasoning that "an anonymous crawler is one
 * nobody can ask to stop". That reasoning was sound about anonymity and wrong about the remedy: it
 * made the FIRST run of a self-hosted app depend on the operator inventing a contact page, and an
 * operator who has no such page has two ways forward — find one, or paste something that parses.
 * The second is the one that actually happens, and it produces a plausible-looking address that
 * reaches nobody, which is the failure the requirement existed to prevent.
 *
 * WHAT THE DEFAULT HONESTLY BUYS, AND WHAT IT DOES NOT. It makes the crawler identifiable: the
 * software has a name, a public source tree and an issue tracker a human reads. It does not make
 * every deployment individually accountable, because every deployment that keeps this default
 * points at the SAME tracker — the project's, not the operator's. A site owner who wants one
 * particular instance to stop polling them reaches the maintainers of the software, who do not run
 * that instance and cannot stop it. The remedy that works regardless of who is running what is
 * `robots.txt`: every instance honours it, matched on the `GrantSpotter` token
 * (`fetcher/index.ts` AGENT_TOKEN), so `User-agent: GrantSpotter` + `Disallow: /` stops all of
 * them, taking effect on the next nightly crawl — `runCrawl` drops the fetcher's robots cache at
 * the start of every run, and the cache expires on its own after ROBOTS_CACHE_TTL_MS in any case,
 * so no deployment holds a stale copy for longer than a day. That is what the issue template
 * tells an arriving site owner first.
 *
 * So: overridable, and it should be overridden by anyone running a modified fork, a large or
 * long-running deployment, or an instance polling on behalf of an institution. The README says
 * this in the same words, at the place an operator is deciding.
 */
export const DEFAULT_CONTACT_URL = 'https://github.com/Atvriders/grantspotter/issues';

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
  const host = hostname.toLowerCase().replace(/\.$/, '');
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
    throw new ConfigError('CONTACT_URL is required: the crawler User-Agent must name a contact URL.');
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
    throw new ConfigError(
      'CONTACT_URL still contains CHANGE_ME, so it is a placeholder rather than an address. This ' +
        'variable has a working default — unset it entirely and the crawler identifies itself ' +
        "through this project's issue tracker. Set it only to point complaints at yourself " +
        'instead, and then it must be an http(s) page you control and can be reached through: it ' +
        'goes in the crawler User-Agent, and it is how one of the ~25 small nonprofits this polls ' +
        'finds out who is polling them.',
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
        'reached through, or unset CONTACT_URL and take the default.',
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
   * name it here. That operator is better served by the default, which reaches a human, than by an
   * address that reaches the complainant's own router — and the message says exactly that.
   */
  const unreachable = unreachableContactHost(parsed.hostname);
  if (unreachable !== null) {
    throw new ConfigError(
      `CONTACT_URL points at ${unreachable}, so it cannot be reached from the public internet. ` +
        'This value goes into the crawler User-Agent, where its only reader is somebody at one of ' +
        'the sites being polled: to them a loopback or private address points at their own ' +
        'machine or their own network, which is less use than no address at all, and it tells ' +
        'them how yours is numbered. Use an http(s) page reachable from outside your network, or ' +
        'unset CONTACT_URL and take the default, which reaches a human.',
    );
  }
  return value;
}

/**
 * The contact URL for this process: the operator's, or the project's issue tracker.
 *
 * The one place CONTACT_URL is read from an environment. `loadConfig` uses it, and so do the two
 * live scripts in `scripts/`, which is the whole point — see `assertUsableContactUrl`.
 */
export function resolveContactUrl(env: Env = process.env): string {
  // Unset is a supported choice, not an omission: the default identifies the crawler through this
  // project's issue tracker. Every rule still runs on the resulting value, because the operator
  // who DOES set this is the one who can get it wrong.
  return assertUsableContactUrl(optional(env, 'CONTACT_URL') ?? DEFAULT_CONTACT_URL);
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
  };

  const anthropicApiKey = optional(env, 'ANTHROPIC_API_KEY');
  if (anthropicApiKey !== undefined) config.anthropicApiKey = anthropicApiKey;
  const simplerGrantsApiKey = optional(env, 'SIMPLER_GRANTS_API_KEY');
  if (simplerGrantsApiKey !== undefined) config.simplerGrantsApiKey = simplerGrantsApiKey;

  return config;
}

/**
 * True when `url` is a GitHub issue tracker, so the User-Agent can say "open an issue" and be
 * telling the truth. Only github.com: the instruction has to match the page, and this is the only
 * host whose issue-tracker URL shape this function can recognise without guessing.
 */
function isGithubIssueTracker(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname.toLowerCase().replace(/^www\./, '') !== 'github.com') return false;
  return /\/issues(\/|$)/.test(parsed.pathname);
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
 * what it is, what it wants, and how to make it stop. So the string spells the action out — and
 * spells out the action that the URL in it actually supports, which is why the clause is derived
 * from the URL rather than fixed. `open an issue` printed beside a club's homepage would be an
 * instruction that cannot be followed, which is worse than the bare convention it replaced.
 */
export function buildUserAgent(source: AppConfig | string): string {
  // Re-validated on the string form as well as the config form, and cheap enough to do on every
  // call: this is the function that MINTS the wire value, so it is the last place that can refuse
  // one. `buildUserAgent('')` still throws "CONTACT_URL is required", which is the first branch of
  // the predicate — the message and the test that pins it are unchanged.
  const url = assertUsableContactUrl(typeof source === 'string' ? source : source.contactUrl);
  const howToReachUs = isGithubIssueTracker(url)
    ? 'open an issue there to contact the maintainers'
    : 'contact the operator at that page';
  return `GrantSpotter/${SERVER_VERSION} (+${url}; nightly grant-deadline change detector; ${howToReachUs})`;
}
