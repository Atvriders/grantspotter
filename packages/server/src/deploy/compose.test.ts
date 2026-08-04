import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  PLACEHOLDER_CONTACT_URL,
  PLACEHOLDER_MARKER,
  PLACEHOLDER_SESSION_SECRET,
} from '../config.js';

/**
 * `docker-compose.yml` is now the ONLY file a self-hoster reads, and nothing else in this
 * repository exercises it. It used to be one of two: `.env.example` was copied to `.env`, and the
 * compose file interpolated `${SESSION_SECRET:?…}` so that `docker compose up` refused to run
 * until the operator had filled it in. The owner asked for one file, so the values are literal
 * here and `.env.example` is gone.
 *
 * That trade is what these tests are for. Deleting the `:?` deleted a fail-fast, and a literal
 * placeholder in a PUBLIC repository is the worst possible replacement for it: `loadConfig`
 * requires SESSION_SECRET and enforces a length but never cared which characters, so an unedited
 * compose file would have produced a running server whose session-signing key is on GitHub. The
 * fail-fast therefore moved into `config.ts`, and the strongest check available here is to take
 * the compose file's own literals and hand them to the real `loadConfig`: if any future edit puts
 * a USABLE secret in this file, the loader stops throwing and this suite goes red. The second
 * check is that the two files agree on the placeholder strings — two files that must match is
 * exactly where this project's defects have lived, so the constants are imported, never retyped.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const compose = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8');
const configSource = readFileSync(resolve(REPO_ROOT, 'packages/server/src/config.ts'), 'utf8');
const indexSource = readFileSync(resolve(REPO_ROOT, 'packages/server/src/index.ts'), 'utf8');

/** Every `KEY: value` under the service's `environment:` block, with YAML quoting removed. */
function environmentEntries(text: string): Record<string, string> {
  const start = text.indexOf('environment:');
  if (start === -1) return {};
  const rest = text.slice(start + 'environment:'.length);
  const entries: Record<string, string> = {};
  for (const line of rest.split('\n')) {
    if (/^\s{0,4}\S/.test(line) && !/^\s*#/.test(line)) break; // dedented out of the block
    const match = /^\s+([A-Z][A-Z0-9_]*):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const raw = (match[2] as string).trim();
    const unquoted = /^"(.*)"$|^'(.*)'$/.exec(raw);
    entries[match[1] as string] = unquoted ? (unquoted[1] ?? unquoted[2] ?? '') : raw;
  }
  return entries;
}

/** Every `${NAME…}` the compose file still interpolates from the environment. */
function interpolatedVars(text: string): string[] {
  return [...new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:?}-]/g)].map((m) => m[1] as string))];
}

const envEntries = environmentEntries(compose);
const envKeys = Object.keys(envEntries);

describe('docker-compose.yml', () => {
  it('pulls the published image and never builds locally', () => {
    expect(compose).toContain('image: ghcr.io/atvriders/grantspotter:latest');
    expect(compose).not.toMatch(/^\s*build:/m);
  });

  it('makes the host port a variable defaulting to 3030', () => {
    expect(compose).toContain('${HOST_PORT:-3030}:3030');
  });

  it('persists sqlite and snapshots in a named volume', () => {
    expect(compose).toMatch(/volumes:[\s\S]*grantspotter-data:\/data/);
    expect(compose).toMatch(/^volumes:/m);
  });

  it('runs an init process so SIGTERM stops the container promptly', () => {
    expect(compose).toContain('init: true');
    expect(compose).toContain('restart: unless-stopped');
  });

  it('contains no real host address, hostname or path', () => {
    expect(compose).not.toMatch(/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(compose).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
    expect(compose).not.toMatch(/\/mnt\/user\//);
  });
});

describe('docker-compose.yml is the only file an operator needs', () => {
  it('ships no .env.example, and sends nobody looking for one', () => {
    // The instruction and the file went together. A compose file that still said `cp .env.example`
    // would be pointing at nothing; a file left behind would be a second source of truth for
    // values that now live here.
    expect(existsSync(resolve(REPO_ROOT, '.env.example'))).toBe(false);
    expect(compose).not.toContain('.env.example');
    expect(compose).not.toMatch(/cp \.env/);
  });

  it('interpolates nothing but HOST_PORT, and that has a default', () => {
    // Everything else is a literal now, so `docker compose up` needs no file beside it. HOST_PORT
    // survives with `:-` (a default) rather than `:?` (a hard failure): it cannot block a start.
    expect(interpolatedVars(compose)).toEqual(['HOST_PORT']);
    expect(compose).not.toMatch(/\$\{[A-Z_]+:\?/);
  });

  it('sets every variable the contract names, in the environment block', () => {
    for (const key of [
      'PORT',
      'SESSION_SECRET',
      'CONTACT_URL',
      'DATA_DIR',
      'CRAWL_ENABLED',
      'CRAWL_CRON',
      'ANTHROPIC_API_KEY',
      'SIMPLER_GRANTS_API_KEY',
    ]) {
      expect(envKeys, key).toContain(key);
    }
  });

  it('passes no variable the server does not read', () => {
    // `loadConfig` is the only reader of process.env in the server. A key here that it never looks
    // up is a value the operator sets and nothing consumes — the quietest kind of broken.
    const unread = envKeys.filter((name) => !configSource.includes(`'${name}'`));
    expect(unread).toEqual([]);
  });

  it('keeps the container port and the published port consistent', () => {
    expect(envEntries.PORT).toBe('3030');
    expect(compose).toContain('${HOST_PORT:-3030}:3030');
  });

  it('parses the values it actually sets, and not a stale copy of them', () => {
    // Vacuity guard. Every assertion below reads `envEntries`, so a parser that silently returned
    // nothing would make all of them pass.
    expect(envKeys.length).toBeGreaterThan(4);
    expect(envEntries.CRAWL_ENABLED).toBe('true');
    expect(envEntries.CRAWL_CRON).toBe('17 3 * * *');
    expect(envEntries.ANTHROPIC_API_KEY).toBe('');
  });
});

describe('the shipped secret is not a secret, and the server knows it', () => {
  it('ships the exact placeholder strings config.ts refuses', () => {
    // Imported constants, not literals retyped here: this is the assertion that makes it
    // impossible for the compose file and the loader to drift apart on the value.
    expect(envEntries.SESSION_SECRET).toBe(PLACEHOLDER_SESSION_SECRET);
    expect(envEntries.CONTACT_URL).toBe(PLACEHOLDER_CONTACT_URL);
    expect(envEntries.SESSION_SECRET).toContain(PLACEHOLDER_MARKER);
    expect(envEntries.CONTACT_URL).toContain(PLACEHOLDER_MARKER);
  });

  it('refuses to start on exactly what this file ships', () => {
    // The whole point, checked end to end: the literals in the compose file, fed to the real
    // loader. This is what fails if a future edit drops a usable secret in here — a working
    // SESSION_SECRET would make loadConfig return instead of throw.
    expect(() => loadConfig(envEntries)).toThrow(ConfigError);
    expect(() => loadConfig(envEntries)).toThrow(/SESSION_SECRET is still the placeholder/);
  });

  it('refuses the shipped CONTACT_URL even once the secret is real', () => {
    // Fixing one required value must not silently let the other through: an operator who
    // generated a secret and stopped reading would otherwise crawl 25 nonprofits anonymously.
    const secretFixed = { ...envEntries, SESSION_SECRET: 'f'.repeat(64) };
    expect(() => loadConfig(secretFixed)).toThrow(/CONTACT_URL is still the placeholder/);
  });

  it('starts once both placeholders are replaced, and changes nothing else', () => {
    // The other half of the claim. If a non-placeholder value in this file were wrong — a mistyped
    // cron, a YAML boolean `parseBool` rejects — the operator would hit it only after fixing the
    // two that are flagged, which is the worst moment to find it.
    const config = loadConfig({
      ...envEntries,
      SESSION_SECRET: 'f'.repeat(64),
      CONTACT_URL: 'https://www.example.org/grantspotter',
    });
    expect(config.port).toBe(3030);
    expect(config.dataDir).toBe('/data');
    expect(config.crawlEnabled).toBe(true);
    expect(config.crawlCron).toBe('17 3 * * *');
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.simplerGrantsApiKey).toBeUndefined();
  });

  it('tells the operator how to generate a secret the server will accept', () => {
    // `loadConfig` enforces a 32-character floor; `openssl rand -hex 32` produces 64, and it is
    // the exact command the ConfigError message names. Both files must print it: the compose file
    // is where the operator is standing, and the error sends them back to it by name.
    expect(compose).toContain('openssl rand -hex 32');
    expect(configSource).toContain('openssl rand -hex 32');
  });

  it('sends the operator back to the file that now holds the value', () => {
    // The error text is the only instruction an operator gets at the moment of failure, and it is
    // in a different file from the thing it talks about. `.env.example` no longer exists, so a
    // message still naming it would be a dangling pointer printed at exactly the wrong time.
    for (const [name, source] of [
      ['config.ts', configSource],
      ['index.ts', indexSource],
    ] as const) {
      expect(source, name).toContain('docker-compose.yml');
      expect(source, name).not.toContain('.env.example');
    }
  });

  it('carries no real secret and no example address that resolves', () => {
    expect(compose).not.toMatch(/sk-ant-[A-Za-z0-9-]{10,}/);
    expect(compose).toMatch(/example\.org|example\.com/);
  });
});
