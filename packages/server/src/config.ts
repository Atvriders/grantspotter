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
 * The test is PLACEHOLDER_MARKER as a substring, not equality with the whole string. An operator
 * in a hurry pastes their secret next to the placeholder about as often as over it, and a
 * half-edited value is exactly as published as an untouched one. `openssl rand -hex 32` emits
 * [0-9a-f] only, so no secret generated the way the error message says can contain this marker.
 */
export const PLACEHOLDER_MARKER = 'CHANGE_ME';
export const PLACEHOLDER_SESSION_SECRET =
  'CHANGE_ME_generate_one_with_openssl_rand_hex_32_and_paste_it_here';
export const PLACEHOLDER_CONTACT_URL =
  'https://example.org/CHANGE_ME_to_a_page_that_says_who_runs_this';

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
  // BEFORE the length rule, on purpose. The shipped placeholder is 65 characters, so today the
  // order changes nothing — but the order is a property of the code and the length is a property
  // of a string somebody may shorten later. Get it wrong and an operator who left the placeholder
  // alone is told to make it LONGER, which is advice that works: pad it to 32 characters and the
  // server starts, still signing sessions with a value anyone can read off GitHub. The right
  // message is the only one this branch can produce.
  if (isPlaceholder(sessionSecret)) {
    throw new ConfigError(
      'SESSION_SECRET is still the placeholder from docker-compose.yml, so it is published in a ' +
        'public repository and is not a secret: anyone could forge a session cookie for this ' +
        'deployment. Generate a real one with: openssl rand -hex 32 — then paste the output over ' +
        'the placeholder in docker-compose.yml.',
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
    throw new ConfigError(
      'CONTACT_URL is still the placeholder from docker-compose.yml. Replace it there with an ' +
        'http(s) page you control, for example https://www.example.org/grantspotter: it goes in ' +
        'the crawler User-Agent, and it is the only way the ~25 small nonprofits this polls can ' +
        'tell who is polling them and ask you to stop.',
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
