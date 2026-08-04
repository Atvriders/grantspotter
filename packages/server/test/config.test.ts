import { describe, expect, it } from 'vitest';
import {
  buildUserAgent,
  ConfigError,
  loadConfig,
  MIN_SESSION_SECRET_LENGTH,
  PLACEHOLDER_CONTACT_URL,
  PLACEHOLDER_SESSION_SECRET,
} from '../src/config.js';

const VALID = {
  SESSION_SECRET: 'a'.repeat(32),
  CONTACT_URL: 'https://example.org/grantspotter',
};

describe('loadConfig', () => {
  it('refuses to start with no SESSION_SECRET', () => {
    expect(() => loadConfig({ CONTACT_URL: VALID.CONTACT_URL })).toThrow(ConfigError);
    expect(() => loadConfig({ CONTACT_URL: VALID.CONTACT_URL })).toThrow(
      /SESSION_SECRET is required and has no default/,
    );
  });

  it('refuses an empty or whitespace SESSION_SECRET', () => {
    expect(() => loadConfig({ ...VALID, SESSION_SECRET: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...VALID, SESSION_SECRET: '    ' })).toThrow(ConfigError);
  });

  it('refuses a short SESSION_SECRET', () => {
    expect(() => loadConfig({ ...VALID, SESSION_SECRET: 'tooshort' })).toThrow(
      /at least 32 characters; got 8/,
    );
  });

  /**
   * `docker-compose.yml` ships these two values as literals now — the owner wanted one file to
   * edit, not a `.env` to copy — so the `${VAR:?…}` interpolation that used to stop
   * `docker compose up` in its tracks is gone. On a public repository the naive version of that
   * change is a vulnerability, not a convenience: every deployment that skipped the edit would
   * sign its session cookies with a key published on GitHub. These are the tests that hold the
   * replacement fail-fast in place.
   */
  describe('the placeholders shipped in docker-compose.yml', () => {
    it('refuses the exact SESSION_SECRET the compose file ships', () => {
      expect(() => loadConfig({ ...VALID, SESSION_SECRET: PLACEHOLDER_SESSION_SECRET })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ ...VALID, SESSION_SECRET: PLACEHOLDER_SESSION_SECRET })).toThrow(
        /SESSION_SECRET is still the placeholder/,
      );
    });

    it('refuses the exact CONTACT_URL the compose file ships, though it is a valid https URL', () => {
      // It parses. Nothing about its SHAPE is wrong, which is why the check has to be by value.
      expect(new URL(PLACEHOLDER_CONTACT_URL).protocol).toBe('https:');
      expect(() => loadConfig({ ...VALID, CONTACT_URL: PLACEHOLDER_CONTACT_URL })).toThrow(
        /CONTACT_URL is still the placeholder/,
      );
    });

    it('refuses a half-edited value, because a half-edited value is still published', () => {
      // What a hurried operator actually does: pastes the real thing beside the placeholder
      // rather than over it, or edits the readable half and leaves the marker.
      const pastedBeside = `${PLACEHOLDER_SESSION_SECRET}${'f'.repeat(64)}`;
      expect(() => loadConfig({ ...VALID, SESSION_SECRET: pastedBeside })).toThrow(
        /SESSION_SECRET is still the placeholder/,
      );
      expect(() =>
        loadConfig({ ...VALID, CONTACT_URL: 'https://radioclub.example.org/CHANGE_ME' }),
      ).toThrow(/CONTACT_URL is still the placeholder/);
      // Lowercased by an operator who retyped it rather than pasting.
      expect(() =>
        loadConfig({ ...VALID, SESSION_SECRET: 'change_me_i_will_do_this_properly_tomorrow' }),
      ).toThrow(/SESSION_SECRET is still the placeholder/);
    });

    it('says "you did not change this", never "too short", whatever the length', () => {
      // The ordering test, and the reason the placeholder check sits above the length rule. A
      // short placeholder that reported "must be at least 32 characters" would be advice an
      // operator can follow — pad it — arriving at a server that starts on a published secret.
      const short = 'CHANGE_ME';
      expect(short.length).toBeLessThan(MIN_SESSION_SECRET_LENGTH);
      expect(() => loadConfig({ ...VALID, SESSION_SECRET: short })).toThrow(
        /SESSION_SECRET is still the placeholder/,
      );
      expect(() => loadConfig({ ...VALID, SESSION_SECRET: short })).not.toThrow(/at least 32/);
    });

    it('names the command that produces a value it will accept', () => {
      // The error is the operator's only instruction at that moment. `openssl rand -hex 32`
      // yields 64 hex characters, which clears MIN_SESSION_SECRET_LENGTH and contains no marker.
      let message = '';
      try {
        loadConfig({ ...VALID, SESSION_SECRET: PLACEHOLDER_SESSION_SECRET });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('openssl rand -hex 32');
      expect(message).toContain('docker-compose.yml');
      expect(() => loadConfig({ ...VALID, SESSION_SECRET: 'a1b2c3d4'.repeat(8) })).not.toThrow();
    });

    it('lets a real value through unmolested', () => {
      // Vacuity guard on the marker test: it must reject placeholders, not secrets in general.
      const real = 'd41d8cd98f00b204e9800998ecf8427e' + 'd41d8cd98f00b204e9800998ecf8427e';
      expect(loadConfig({ ...VALID, SESSION_SECRET: real }).sessionSecret).toBe(real);
    });
  });

  it('refuses a missing or malformed CONTACT_URL', () => {
    expect(() => loadConfig({ SESSION_SECRET: VALID.SESSION_SECRET })).toThrow(
      /CONTACT_URL is required and has no default/,
    );
    expect(() => loadConfig({ ...VALID, CONTACT_URL: 'not a url' })).toThrow(
      /CONTACT_URL must be an http\(s\) URL/,
    );
    expect(() => loadConfig({ ...VALID, CONTACT_URL: 'ftp://example.org' })).toThrow(ConfigError);
  });

  it('applies the CONTRACT §7 defaults', () => {
    const config = loadConfig(VALID);
    expect(config.port).toBe(3030);
    expect(config.dataDir).toBe('/data');
    expect(config.crawlEnabled).toBe(true);
    expect(config.crawlCron).toBe('17 3 * * *');
    expect(config.nodeEnv).toBe('development');
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.simplerGrantsApiKey).toBeUndefined();
  });

  it('reads every overridable variable', () => {
    const config = loadConfig({
      ...VALID,
      PORT: '4100',
      DATA_DIR: '/srv/grantspotter-data',
      CRAWL_ENABLED: 'false',
      CRAWL_CRON: '0 4 * * *',
      NODE_ENV: 'production',
      ANTHROPIC_API_KEY: 'sk-test',
      SIMPLER_GRANTS_API_KEY: 'key-test',
    });
    expect(config.port).toBe(4100);
    expect(config.dataDir).toBe('/srv/grantspotter-data');
    expect(config.crawlEnabled).toBe(false);
    expect(config.crawlCron).toBe('0 4 * * *');
    expect(config.nodeEnv).toBe('production');
    expect(config.anthropicApiKey).toBe('sk-test');
    expect(config.simplerGrantsApiKey).toBe('key-test');
  });

  it('rejects a nonsense PORT or CRAWL_ENABLED rather than guessing', () => {
    expect(() => loadConfig({ ...VALID, PORT: 'abc' })).toThrow(/PORT must be an integer/);
    expect(() => loadConfig({ ...VALID, PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...VALID, CRAWL_ENABLED: 'maybe' })).toThrow(
      /CRAWL_ENABLED must be "true" or "false"/,
    );
  });

  it('ignores blank optional keys instead of storing empty strings', () => {
    const config = loadConfig({ ...VALID, ANTHROPIC_API_KEY: '', SIMPLER_GRANTS_API_KEY: '   ' });
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.simplerGrantsApiKey).toBeUndefined();
  });
});

describe('buildUserAgent', () => {
  // RESOLUTIONS R10: one definition, one output string. Plan 2 imports this
  // function instead of declaring its own.
  const EXPECTED =
    'GrantSpotter/0.1.0 (+https://example.org/grantspotter; nightly grant-deadline change detector)';

  it('names the app and carries the contact URL', () => {
    // Plan 2's fetcher sends this on every request. Politeness §7.1.3.
    expect(buildUserAgent(loadConfig(VALID))).toBe(EXPECTED);
  });

  it('accepts a bare contact URL and produces the identical string', () => {
    // Plan 2's fetcher tests call the string form; both forms must agree.
    expect(buildUserAgent('https://example.org/grantspotter')).toBe(EXPECTED);
    expect(buildUserAgent(loadConfig(VALID))).toBe(buildUserAgent(VALID.CONTACT_URL));
  });

  it('refuses to build an anonymous User-Agent', () => {
    expect(() => buildUserAgent('')).toThrow(/CONTACT_URL is required/);
    expect(() => buildUserAgent('   ')).toThrow(/CONTACT_URL is required/);
  });
});
