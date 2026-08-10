import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHOSEN_CODE_MAX_DAYS, CHOSEN_CODE_MAX_USES } from '@grantspotter/core';
import { ENV_CODE_DEFAULT_DAYS, ENV_CODE_DEFAULT_MAX_USES } from '../auth/chosenCode.js';
import {
  ConfigError,
  loadConfig,
  PLACEHOLDER_CONTACT_URL,
  PLACEHOLDER_MARKER,
  PLACEHOLDER_SESSION_SECRET,
  reservedContactName,
  resolveEnrollmentCode,
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
 * a USABLE value in this file — for EITHER of the two variables that ship as placeholders — the
 * loader stops throwing and this suite goes red. The second check is that the two files agree on
 * the placeholder strings — two files that must match is exactly where this project's defects have
 * lived, so the constants are imported, never retyped.
 *
 * CONTACT_URL is one of the two again as of 2026-08-04. It had a working default for a day, this
 * file shipped it, and the owner removed it: a default that every unedited deployment keeps makes
 * the maintainers of the software the contact for instances they do not run and cannot stop.
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
      'CALLSIGN_LOOKUP_ENABLED',
      'ENROLLMENT_CODE',
      'ENROLLMENT_CODE_MAX_USES',
      'ENROLLMENT_CODE_DAYS',
      'ANTHROPIC_API_KEY',
      'SIMPLER_GRANTS_API_KEY',
    ]) {
      expect(envKeys, key).toContain(key);
    }
  });

  /**
   * THE ONE SWITCH WHOSE COMMENT IS THE POINT OF IT.
   *
   * `CALLSIGN_LOOKUP_ENABLED` turns off the only request in this product that goes to a host
   * publishing `Disallow: /`. An operator who never learns that is an operator who cannot make
   * the decision the switch exists to offer them, and this file is the only documentation a
   * `docker compose up` deployment is guaranteed to have opened.
   */
  it('explains beside the switch what it switches off, and admits the awkward half', () => {
    expect(envEntries.CALLSIGN_LOOKUP_ENABLED).toBe('true');
    const block = compose.slice(
      compose.indexOf('# The callsign lookup.'),
      compose.indexOf('CALLSIGN_LOOKUP_ENABLED:'),
    );
    expect(block.length).toBeGreaterThan(200); // vacuity guard on the two indexOf calls
    expect(block).toMatch(/callook\.info/);
    expect(block).toMatch(/Disallow: \//);
    expect(block).toMatch(/free to use however you wish/);
    // It must not sell the convenient half alone.
    expect(block).toMatch(/tension/i);
    expect(block).toMatch(/README/);
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

  /**
   * THE ENROLLMENT CODE IS THE ONE VALUE IN THIS FILE THAT IS A CREDENTIAL AND WILL NOT FEEL LIKE
   * ONE, and these three tests are the whole of what keeps that said where it is edited.
   *
   * The session secret is guarded by a placeholder the loader refuses, which works because nobody
   * mistakes a session secret for something to share. An enrollment code is MEANT to be shared, so
   * the operator's own instinct is the thing that fails here — they will type it the way they type
   * a meeting-room number. There is no value-refusal available for that, because the whole point is
   * that the operator's code is a real code. What is left is the sentence beside the line, and a
   * sentence nothing tests is a sentence that quietly leaves.
   */
  it('warns beside the line that this file is tracked, and says what to do instead', () => {
    const block = compose.slice(
      compose.indexOf('AN ENROLLMENT CODE YOU SET HERE'),
      compose.indexOf('ENROLLMENT_CODE: ""'),
    );
    expect(block.length, 'the ENROLLMENT_CODE comment block moved or went').toBeGreaterThan(800);
    expect(block).toMatch(/TRACKED BY GIT/);
    // The specific reason this one is worse than the secret it sits below, which is the whole
    // argument: it does not feel like a secret while it is being typed.
    expect(block).toMatch(/MEANT to be shared|meant to be shared/);
    expect(block).toMatch(/credential/i);
    // And the remedy, named as concretely as the SESSION_SECRET paragraph names it.
    expect(block).toMatch(/\.env/);
    expect(block).toMatch(/HOST_PORT/);
    expect(block).toMatch(/gitignore|ignores it/i);
  });

  it('ships no code anybody could paste, and says that is deliberate', () => {
    // THE SAME RULE THE CONTACT URL GETS ONE DESCRIBE DOWN, for the same reason: a worked example
    // in a public repository is a value every deployment that copied it shares. There the rule is
    // "no URL in this file may be one the loader would accept"; a code cannot be recognised by the
    // loader from a comment, so the shape is what is banned — three dashed groups is what an
    // example enrollment code looks like and is not something the rest of this file writes.
    const codeShaped = /\b[A-Z0-9]{2,}-[A-Z0-9]{2,}-[A-Z0-9]{2,}\b/g;
    expect('W1MX-FALL-2026'.match(codeShaped), 'the shape this test looks for stopped matching a code')
      .not.toBeNull();
    expect([...compose.matchAll(codeShaped)].map((m) => m[0])).toEqual([]);
    expect(compose).toMatch(/NO EXAMPLE CODE/i);
    // Empty as shipped, and therefore off. The feature costs an operator who ignores it nothing.
    expect(envEntries.ENROLLMENT_CODE).toBe('');
    expect(resolveEnrollmentCode(envEntries)).toBeUndefined();
  });

  it('writes the two bounds out, and writes the same numbers the server would default to', () => {
    // Written out rather than left to the defaults so the operator SEES what they are handing out —
    // and imported rather than retyped, because two files that must agree is where this project's
    // defects have lived. If a default moves in code and not here, the file starts lying about the
    // limits on a credential.
    expect(envEntries.ENROLLMENT_CODE_MAX_USES).toBe(String(ENV_CODE_DEFAULT_MAX_USES));
    expect(envEntries.ENROLLMENT_CODE_DAYS).toBe(String(ENV_CODE_DEFAULT_DAYS));
    // Neither shipped number may be the ceiling: a default that takes the maximum is a default
    // nobody chose, and both of these bound a code that gets read out loud.
    expect(ENV_CODE_DEFAULT_MAX_USES).toBeLessThan(CHOSEN_CODE_MAX_USES);
    expect(ENV_CODE_DEFAULT_DAYS).toBeLessThan(CHOSEN_CODE_MAX_DAYS);
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

describe('the shipped values are placeholders, and the server knows it', () => {
  it('ships the exact placeholder SESSION_SECRET config.ts refuses', () => {
    // Imported constant, not a literal retyped here: this is the assertion that makes it
    // impossible for the compose file and the loader to drift apart on the value.
    expect(envEntries.SESSION_SECRET).toBe(PLACEHOLDER_SESSION_SECRET);
    expect(envEntries.SESSION_SECRET).toContain(PLACEHOLDER_MARKER);
  });

  it('refuses to start on exactly what this file ships', () => {
    // The whole point, checked end to end: the literals in the compose file, fed to the real
    // loader. This is what fails if a future edit drops a usable secret in here — a working
    // SESSION_SECRET would make loadConfig return instead of throw.
    expect(() => loadConfig(envEntries)).toThrow(ConfigError);
    expect(() => loadConfig(envEntries)).toThrow(/SESSION_SECRET is still the placeholder/);
  });

  /**
   * WHAT THIS TEST HAS ASSERTED, IN ORDER, AND WHY IT IS BACK WHERE IT STARTED.
   *
   * It read "refuses the shipped CONTACT_URL even once the secret is real" while the compose file
   * shipped a `CHANGE_ME` contact URL. It then became "needs exactly one edit — the secret — and
   * starts on the shipped contact URL", pinned to `DEFAULT_CONTACT_URL`, for the one day
   * CONTACT_URL had a default. Neither assertion was wrong about the code it was written against;
   * the DESIGN moved under each of them, and the owner has now moved it back, because a shared
   * default names the maintainers of the software as the contact for deployments they do not run.
   *
   * So the claim to bind is TWO edits, and it is bound the only way that cannot rot into a
   * tautology: make each edit in turn and require the loader still to refuse until both are made.
   * A future change that quietly gives either variable a default makes one of these throws stop
   * throwing, and this test goes red.
   */
  it('refuses the shipped CONTACT_URL even once the secret is real', () => {
    const realSecret = 'f'.repeat(64);
    expect(() => loadConfig({ ...envEntries, SESSION_SECRET: realSecret })).toThrow(ConfigError);
    expect(() => loadConfig({ ...envEntries, SESSION_SECRET: realSecret })).toThrow(
      /CONTACT_URL still contains CHANGE_ME/,
    );
  });

  it('needs both edits, and nothing else in the file is quietly broken', () => {
    const mine = 'https://w9xyz-radio-club.org/grantspotter';
    const config = loadConfig({
      ...envEntries,
      SESSION_SECRET: 'f'.repeat(64),
      CONTACT_URL: mine,
    });
    expect(config.contactUrl).toBe(mine);
    // A mistyped cron or a YAML boolean `parseBool` rejects would otherwise surface only after the
    // operator had fixed both values, which is the worst moment to find it.
    expect(config.port).toBe(3030);
    expect(config.dataDir).toBe('/data');
    expect(config.crawlEnabled).toBe(true);
    expect(config.crawlCron).toBe('17 3 * * *');
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.simplerGrantsApiKey).toBeUndefined();
    // Off as it ships, so an operator who edits the two required values and nothing else gets the
    // deployment they had before this variable existed.
    expect(config.enrollmentCode).toBeUndefined();
    // And the two bounds beside it are read and honoured the moment a code IS typed in, rather
    // than being decoration the loader ignores. `loadConfig` throwing here would mean the shipped
    // literals cannot survive the one edit the line invites.
    const withCode = loadConfig({
      ...envEntries,
      SESSION_SECRET: 'f'.repeat(64),
      CONTACT_URL: mine,
      ENROLLMENT_CODE: 'W9XYZ-FIELDDAY-QRP-2027',
    });
    expect(withCode.enrollmentCode).toEqual({
      code: 'W9XYZ-FIELDDAY-QRP-2027',
      maxUses: ENV_CODE_DEFAULT_MAX_USES,
      days: ENV_CODE_DEFAULT_DAYS,
    });
  });

  it('ships the exact placeholder CONTACT_URL config.ts refuses, and refuses each half-edit', () => {
    // Imported constant, never retyped: the same anti-drift rule the session secret gets.
    expect(envEntries.CONTACT_URL).toBe(PLACEHOLDER_CONTACT_URL);
    // Two independent rules hold it, which is what makes the run-length check unnecessary here —
    // and necessary that it be absent, since `https://` is an eight-character run of this string
    // and the run rule would therefore refuse every https URL an operator could supply.
    const secret = 'f'.repeat(64);
    expect(() =>
      loadConfig({ SESSION_SECRET: secret, CONTACT_URL: PLACEHOLDER_CONTACT_URL.replace(
        'example.org',
        'w9xyz-radio-club.org',
      ) }),
    ).toThrow(/CONTACT_URL still contains CHANGE_ME/);
    expect(() =>
      loadConfig({
        SESSION_SECRET: secret,
        CONTACT_URL: PLACEHOLDER_CONTACT_URL.replace('CHANGE_ME_to_a_page_that_says_who_runs_this', 'about'),
      }),
    ).toThrow(/reserved for documentation/);
    // …and the vacuity guard the two above need: an ordinary https URL is not caught by either.
    expect(() =>
      loadConfig({ SESSION_SECRET: secret, CONTACT_URL: 'https://w9xyz-radio-club.org/about' }),
    ).not.toThrow();
  });

  it('says in the file itself that TWO values must be edited before the first run', () => {
    // The operator reads this file and nothing else, so the count has to be right here. It said
    // "the ONE value marked EDIT THIS" while CONTACT_URL had a default; it is two again.
    expect(compose).toMatch(/\bTWO values\b/);
    expect(compose).toMatch(/EDIT THIS \(1 of 2\)/);
    expect(compose).toMatch(/EDIT THIS \(2 of 2\)/);
    expect(compose).not.toMatch(/the ONE value|the only value in this file/i);
  });

  it('says why the contact URL has to be the operator’s own, not this project’s', () => {
    // The reason is the whole decision, and an operator who does not read it will paste anything.
    expect(compose).toMatch(/must be YOURS|It must be YOURS/);
    expect(compose).toMatch(/cannot stop/i);
    expect(compose).toMatch(/do not run/i);
    // …and the remedy that works whoever is running the instance, because it is what a site owner
    // is left with when an operator supplies a contact address nobody answers.
    expect(compose).toContain('User-agent: GrantSpotter');
    expect(compose).toContain('Disallow: /');
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

  it('carries no real secret, and no address the server would accept', () => {
    expect(compose).not.toMatch(/sk-ant-[A-Za-z0-9-]{10,}/);
    // This inverted for one day, to "every URL here must be this project's", which was right while
    // the file shipped a working default. It is back to the stronger form, and the strong form is
    // this: NO http(s) URL in this file may be one the loader would accept. A shipped address that
    // parses is an address some deployment will keep, and there is no address this project can put
    // here that would reach the operator of that deployment. Checked through the real rule rather
    // than by pattern, so a documentation host added to `RESERVED_CONTACT_HOSTS` is honoured here
    // automatically and a plausible-looking third-party URL fails immediately.
    const urls = [...compose.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0]);
    expect(urls.length).toBeGreaterThan(0); // vacuity guard on the match above
    for (const url of urls) {
      expect(reservedContactName(new URL(url).hostname), url).not.toBeNull();
      expect(() =>
        loadConfig({ SESSION_SECRET: 'f'.repeat(64), CONTACT_URL: url }),
        url,
      ).toThrow(ConfigError);
    }
  });
});
