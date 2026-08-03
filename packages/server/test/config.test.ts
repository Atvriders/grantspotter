import { describe, expect, it } from 'vitest';
import { buildUserAgent, ConfigError, loadConfig } from '../src/config.js';

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
