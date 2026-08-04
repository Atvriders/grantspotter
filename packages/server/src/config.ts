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
 * The literal values `docker-compose.yml` ships for the two variables that have no default.
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
export const PLACEHOLDER_CONTACT_URL =
  'https://example.org/CHANGE_ME_to_a_page_that_says_who_runs_this';

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

/** The reserved name a hostname falls under, or null. Exported: the live scripts check it too. */
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

  const contactUrl = optional(env, 'CONTACT_URL');
  if (contactUrl === undefined) {
    throw new ConfigError(
      'CONTACT_URL is required and has no default. Set it to a URL identifying the operator; it goes in the crawler User-Agent so the nonprofits we poll can contact you.',
    );
  }
  // Before the URL rules, for the same reason as above: the shipped placeholder parses as https
  // today, so it would otherwise reach `new URL` and pass, but a later edit that broke its shape
  // would report "must be an http(s) URL" about a value whose real problem is that it is nobody's
  // address.
  if (isPlaceholder(contactUrl)) {
    // No worked example here on purpose. The version of this message that ended "for example
    // https://www.example.org/grantspotter" was handing out a value that this very loader
    // accepted, at the moment the operator is most likely to paste whatever they are shown.
    throw new ConfigError(
      'CONTACT_URL is still the placeholder from docker-compose.yml. Replace it there with an ' +
        'http(s) page you control and can be reached through — a club or organisation site, or ' +
        'any page that names you and gives a way to get in touch. It goes in the crawler ' +
        'User-Agent, and it is the only way the ~25 small nonprofits this polls can tell who is ' +
        'polling them and ask you to stop.',
    );
  }
  let parsedContact: URL;
  try {
    parsedContact = new URL(contactUrl);
  } catch {
    throw new ConfigError(`CONTACT_URL must be an http(s) URL; got "${contactUrl}".`);
  }
  if (parsedContact.protocol !== 'http:' && parsedContact.protocol !== 'https:') {
    throw new ConfigError(`CONTACT_URL must be an http(s) URL; got "${contactUrl}".`);
  }
  const reserved = reservedContactName(parsedContact.hostname);
  if (reserved !== null) {
    throw new ConfigError(
      `CONTACT_URL is under ${reserved}, which is reserved for documentation (RFC 2606) and ` +
        'resolves for nobody. This value is pasted into the crawler User-Agent and is the only ' +
        'route by which a site being polled can find out who is polling it, so a reserved name ' +
        'makes this crawler anonymous while looking identified. Use an http(s) page you control ' +
        'and can be reached through.',
    );
  }

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
 * Descriptive, identifiable User-Agent. Spec §7.1 rule 3.
 *
 * RESOLUTIONS R10: this is the ONLY definition in the repository. It accepts
 * either the loaded config or a bare contact URL so Plan 2's fetcher (whose
 * call sites pass a string) imports this rather than declaring a second one.
 */
export function buildUserAgent(source: AppConfig | string): string {
  const url = typeof source === 'string' ? source : source.contactUrl;
  if (!url.trim()) {
    throw new Error('CONTACT_URL is required: the crawler User-Agent must name a contact URL.');
  }
  return `GrantSpotter/${SERVER_VERSION} (+${url}; nightly grant-deadline change detector)`;
}
