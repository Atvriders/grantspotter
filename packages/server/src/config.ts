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
