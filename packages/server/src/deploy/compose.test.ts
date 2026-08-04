import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The compose file and `.env.example` are the two files a self-hoster actually reads, and neither
 * is exercised by anything else in this repository. The checks that matter are the ones a wrong
 * value would only reveal on someone else's machine: an image that builds locally instead of
 * pulling what CI published, a required secret that quietly acquired a default, or a variable
 * named in compose that `loadConfig` has never heard of.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const compose = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8');
const envExample = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8');
const configSource = readFileSync(resolve(REPO_ROOT, 'packages/server/src/config.ts'), 'utf8');

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

  it('passes the required variables through with no defaults', () => {
    expect(compose).toContain('SESSION_SECRET: ${SESSION_SECRET:?');
    expect(compose).toContain('CONTACT_URL: ${CONTACT_URL:?');
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

/** Every `${NAME…}` the compose file interpolates from the operator's `.env`. */
function interpolatedVars(text: string): string[] {
  return [...new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:?}-]/g)].map((m) => m[1] as string))];
}

/** Every `KEY: value` under the service's `environment:` block. */
function environmentKeys(text: string): string[] {
  const start = text.indexOf('environment:');
  if (start === -1) return [];
  const rest = text.slice(start + 'environment:'.length);
  const keys: string[] = [];
  for (const line of rest.split('\n')) {
    if (/^\s{0,4}\S/.test(line) && !/^\s*#/.test(line)) break; // dedented out of the block
    const match = /^\s+([A-Z][A-Z0-9_]*):/.exec(line);
    if (match) keys.push(match[1] as string);
  }
  return keys;
}

describe('docker-compose.yml — every variable it names is real', () => {
  const vars = interpolatedVars(compose);
  const envKeys = environmentKeys(compose);

  it('interpolates the variables an operator is expected to set', () => {
    // Vacuity guards: a parser that found nothing would make both checks below pass.
    expect(vars).toContain('SESSION_SECRET');
    expect(vars).toContain('HOST_PORT');
    expect(envKeys).toContain('CONTACT_URL');
    expect(envKeys.length).toBeGreaterThan(4);
  });

  it('documents every interpolated variable in .env.example', () => {
    const undocumented = vars.filter((name) => !new RegExp(`^${name}=`, 'm').test(envExample));
    expect(undocumented).toEqual([]);
  });

  it('passes no variable the server does not read', () => {
    // `loadConfig` is the only reader of process.env in the server. A key here that it never looks
    // up is a value the operator sets and nothing consumes — the quietest kind of broken.
    const unread = envKeys.filter((name) => !configSource.includes(`'${name}'`));
    expect(unread).toEqual([]);
  });

  it('keeps the container port and the published port consistent', () => {
    expect(compose).toMatch(/PORT: 3030/);
    expect(compose).toContain('${HOST_PORT:-3030}:3030');
  });
});

describe('.env.example', () => {
  it('lists every variable from the contract', () => {
    for (const key of [
      'HOST_PORT',
      'PORT',
      'SESSION_SECRET',
      'CONTACT_URL',
      'DATA_DIR',
      'CRAWL_ENABLED',
      'CRAWL_CRON',
      'ANTHROPIC_API_KEY',
      'SIMPLER_GRANTS_API_KEY',
    ]) {
      expect(envExample).toContain(`${key}=`);
    }
  });

  it('ships the two required variables empty, so a copied file fails loudly', () => {
    expect(envExample).toMatch(/^SESSION_SECRET=\s*$/m);
    expect(envExample).toMatch(/^CONTACT_URL=\s*$/m);
  });

  it('carries no real secret and no example address that resolves', () => {
    expect(envExample).not.toMatch(/sk-ant-[A-Za-z0-9-]{10,}/);
    expect(envExample).not.toMatch(/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it('uses documentation-safe example values only', () => {
    expect(envExample).toMatch(/203\.0\.113\.|example\.org|example\.com/);
  });

  it('tells the operator how to generate a secret the server will accept', () => {
    // `loadConfig` enforces a 32-character floor; `openssl rand -hex 32` produces 64, and it is
    // the exact command the ConfigError message names.
    expect(envExample).toContain('openssl rand -hex 32');
    expect(configSource).toContain('openssl rand -hex 32');
  });
});
