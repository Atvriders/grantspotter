import { describe, expect, it } from 'vitest';
import {
  buildUserAgent,
  ConfigError,
  DEFAULT_CONTACT_URL,
  FORMER_PLACEHOLDER_CONTACT_URL,
  loadConfig,
  MIN_SESSION_SECRET_LENGTH,
  PLACEHOLDER_MARKER,
  PLACEHOLDER_RUN_LENGTH,
  PLACEHOLDER_SESSION_SECRET,
  reservedContactName,
} from '../src/config.js';

/**
 * NOT example.org. `loadConfig` refuses the RFC 2606 documentation domains for CONTACT_URL now,
 * because that value ends up in a live crawler's User-Agent and a reserved name reaches nobody —
 * and this fixture was one of the places the old rule's own example was quietly proving itself
 * acceptable. Loopback is the honest stand-in for a test: it is where this process actually is.
 */
const VALID = {
  SESSION_SECRET: 'a'.repeat(32),
  CONTACT_URL: 'http://127.0.0.1:3030/grantspotter',
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

    it('refuses the CONTACT_URL placeholder it used to ship, though it is a valid https URL', () => {
      // The compose file no longer ships this — CONTACT_URL has a default now — but the guard is
      // not what was removed. It parses; nothing about its SHAPE is wrong, which is why the check
      // has to be by value.
      expect(new URL(FORMER_PLACEHOLDER_CONTACT_URL).protocol).toBe('https:');
      expect(() => loadConfig({ ...VALID, CONTACT_URL: FORMER_PLACEHOLDER_CONTACT_URL })).toThrow(
        /CONTACT_URL still contains CHANGE_ME/,
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
      ).toThrow(/CONTACT_URL still contains CHANGE_ME/);
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

    /**
     * THE HALF-EDIT HOLE, which the `includes('CHANGE_ME')` version of this check was open to.
     *
     * That test was additive: it caught a secret pasted NEXT to the marker and missed one where
     * the marker had been deleted. `SESSION_SECRET=generate_one_with_openssl_rand_hex_32_and_
     * paste_it_here` — the shipped line with its prefix removed, 55 characters, present verbatim
     * in the committed docker-compose.yml — started a real server. Each case below is an edit an
     * operator's hand actually makes.
     */
    it('refuses every piece of the placeholder a plausible edit leaves behind', () => {
      const cases: Record<string, string> = {
        'deleted the CHANGE_ME_ prefix': PLACEHOLDER_SESSION_SECRET.slice('CHANGE_ME_'.length),
        'deleted the trailing instruction': PLACEHOLDER_SESSION_SECRET.slice(0, 40),
        'kept only the middle': PLACEHOLDER_SESSION_SECRET.slice(18, 50),
        'retyped it in another case': PLACEHOLDER_SESSION_SECRET.toUpperCase(),
        'retyped the tail and padded it out': `openssl_rand_hex_32_and_paste_it_here_0000`,
        'kept a fragment and appended their own': `${PLACEHOLDER_SESSION_SECRET.slice(10, 26)}${'f'.repeat(48)}`,
      };
      for (const [why, value] of Object.entries(cases)) {
        expect(value.length, why).toBeGreaterThanOrEqual(MIN_SESSION_SECRET_LENGTH);
        expect(() => loadConfig({ ...VALID, SESSION_SECRET: value }), why).toThrow(
          /SESSION_SECRET is still the placeholder/,
        );
      }
    });

    /**
     * The property that makes the rule above safe to be this aggressive, checked rather than
     * asserted in prose: the error message tells the operator to run `openssl rand -hex 32`, and
     * that command emits [0-9a-f] and nothing else. If no window of the placeholder is all-hex,
     * no all-hex value can contain one, so no correctly generated secret can ever be refused —
     * for any secret, not just the samples below.
     */
    it('cannot collide with anything openssl rand -hex 32 emits', () => {
      const windows: string[] = [];
      for (let i = 0; i + PLACEHOLDER_RUN_LENGTH <= PLACEHOLDER_SESSION_SECRET.length; i += 1) {
        windows.push(PLACEHOLDER_SESSION_SECRET.slice(i, i + PLACEHOLDER_RUN_LENGTH));
      }
      expect(windows.length).toBeGreaterThan(50); // vacuity guard on the loop above
      expect(windows.filter((w) => /^[0-9a-fA-F]+$/.test(w))).toEqual([]);
    });

    it('accepts real openssl output, which is the whole point of refusing the rest', () => {
      // Captured from `openssl rand -hex 32` on this host. A guard that refuses a legitimate
      // value is a guard the operator routes around, so this is as load-bearing as the refusals.
      const generated = [
        '4d2b7f2eafd0a6f2ea0f2c07bb1ac0e0640b9f2a3b0e3d2f9d3c9b0a11f47ac2',
        '00000000000000000000000000000000000000000000000000000000000000ff',
        'deadbeefcafef00dfeedfacebadc0ffee0ddf00dbaaaaaad1234567890abcdef',
      ];
      for (const secret of generated) {
        expect(secret).toMatch(/^[0-9a-f]{64}$/);
        expect(loadConfig({ ...VALID, SESSION_SECRET: secret }).sessionSecret).toBe(secret);
      }
    });
  });

  /**
   * The CONTACT_URL error message used to end "for example https://www.example.org/grantspotter",
   * and that exact string was ACCEPTED — it produced the User-Agent
   * `GrantSpotter/0.1.0 (+https://www.example.org/grantspotter; …)`. example.org is IANA's
   * reserved documentation domain: a site owner who follows it to ask this crawler to stop reaches
   * nobody. An error message whose own example satisfies the check is a second placeholder.
   */
  describe('CONTACT_URL under a reserved documentation name', () => {
    it('refuses the RFC 2606 second-level names and the reserved TLDs', () => {
      for (const url of [
        'https://www.example.org/grantspotter', // the message's own former example
        'https://example.com/about',
        'http://example.net/',
        'https://grantspotter.example.org/who-runs-this',
        'https://grantspotter.example.test/about',
        'https://my-club.invalid/contact',
        'https://gs.example/contact',
      ]) {
        expect(() => loadConfig({ ...VALID, CONTACT_URL: url }), url).toThrow(
          /reserved for documentation/,
        );
      }
    });

    it('hands out no address of its own to paste back in', () => {
      // The message that names a usable-looking example is the defect, not the wording.
      let message = '';
      try {
        loadConfig({ ...VALID, CONTACT_URL: FORMER_PLACEHOLDER_CONTACT_URL });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/CONTACT_URL still contains CHANGE_ME/);
      expect(message).not.toMatch(/example\.(org|com|net)/);
      // It does have somewhere to send them now, and it is the one address that needs no
      // invention: leave the variable alone.
      expect(message).toMatch(/unset it entirely/);
    });

    it('accepts an address that is somebody’s', () => {
      // Vacuity guard: this must rule out the reserved names, not http(s) URLs in general.
      for (const url of [
        'https://w9xyz-radio-club.org/grantspotter',
        'http://192.0.2.10:3030/about', // RFC 5737 documentation ADDRESS, not a reserved NAME
        'https://exampleclub.org/contact', // "example" as a prefix is not example.org
        'https://notexample.com/contact',
      ]) {
        expect(loadConfig({ ...VALID, CONTACT_URL: url }).contactUrl, url).toBe(url);
      }
    });
  });

  /**
   * WHAT THIS BLOCK REPLACED, AND WHY THE OLD ASSERTION WAS NOT WRONG.
   *
   * Until 2026-08-04 this file asserted `CONTACT_URL is required and has no default` and that
   * `loadConfig` threw when it was absent. That assertion was true about the code and faithful to
   * the design of the day — "an anonymous crawler is one nobody can ask to stop" — so it is being
   * rewritten because the DESIGN changed under it, not because it had gone stale or stood in the
   * way of green. The requirement was doing one useful thing (no anonymous crawler) and one
   * harmful one (a self-hoster could not start the server until they invented a contact page, and
   * the value that actually gets pasted at that moment is one that parses and reaches nobody).
   *
   * The replacement has to hold the new design at least as tightly as the old one held the old,
   * so these tests assert the three things that survive the change: the default is a real https
   * address that is somebody's, an explicit value still wins, and a BAD explicit value is still
   * refused. What stopped being required is the operator's edit — not the guard on it.
   */
  describe('CONTACT_URL has a default now, and the default is a real address', () => {
    it('starts with no CONTACT_URL in the environment at all', () => {
      const config = loadConfig({ SESSION_SECRET: VALID.SESSION_SECRET });
      expect(config.contactUrl).toBe(DEFAULT_CONTACT_URL);
    });

    it('defaults to this project’s issue tracker, which reaches a human', () => {
      // Pinned by value: the whole point of the change is WHICH address this is. A default that
      // drifted to some other page would still pass every structural check below.
      expect(DEFAULT_CONTACT_URL).toBe('https://github.com/Atvriders/grantspotter/issues');
    });

    it('holds the default to every rule an operator’s value is held to', () => {
      // The default is not exempt from the loader's checks; it is the first value that has to
      // pass them. A default under a reserved name, or one still carrying a marker, would be the
      // exact failure this loader refuses in an operator's value.
      const parsed = new URL(DEFAULT_CONTACT_URL);
      expect(parsed.protocol).toBe('https:');
      expect(reservedContactName(parsed.hostname)).toBeNull();
      expect(DEFAULT_CONTACT_URL.toUpperCase()).not.toContain(PLACEHOLDER_MARKER);
      // …and fed back in as though an operator had typed it, it survives loadConfig unchanged.
      expect(loadConfig({ ...VALID, CONTACT_URL: DEFAULT_CONTACT_URL }).contactUrl).toBe(
        DEFAULT_CONTACT_URL,
      );
    });

    it('lets an explicit value win, because the operator is who a complaint should reach', () => {
      // The override is not a leftover: it is the answer for a fork, a large deployment, or an
      // institution, none of which the project's own tracker can speak for.
      const mine = 'https://w9xyz-radio-club.org/grantspotter';
      expect(loadConfig({ ...VALID, CONTACT_URL: mine }).contactUrl).toBe(mine);
      expect(loadConfig({ ...VALID, CONTACT_URL: VALID.CONTACT_URL }).contactUrl).toBe(
        VALID.CONTACT_URL,
      );
    });

    it('treats blank as unset rather than as an anonymous crawler', () => {
      // `CONTACT_URL: ""` in a compose file is a variable somebody blanked, not a value. The
      // alternative reading — empty string as the contact URL — is the one case that could put a
      // `(+; …)` on the wire.
      for (const blank of ['', '   ']) {
        expect(loadConfig({ ...VALID, CONTACT_URL: blank }).contactUrl).toBe(DEFAULT_CONTACT_URL);
      }
    });

    it('still refuses an explicitly bad value: the edit stopped being required, the guard did not', () => {
      const bad: Record<string, [string, RegExp]> = {
        'the placeholder this project used to ship': [
          FORMER_PLACEHOLDER_CONTACT_URL,
          /CONTACT_URL still contains CHANGE_ME/,
        ],
        'a marker left in an otherwise real address': [
          'https://w9xyz-radio-club.org/CHANGE_ME',
          /CONTACT_URL still contains CHANGE_ME/,
        ],
        'a reserved documentation domain': [
          'https://my-club.example.org/contact',
          /reserved for documentation/,
        ],
        'a reserved TLD': ['https://my-club.invalid/contact', /reserved for documentation/],
        'not a URL at all': ['not a url', /CONTACT_URL must be an http\(s\) URL/],
        'a scheme no site owner can follow': [
          'ftp://w9xyz-radio-club.org',
          /CONTACT_URL must be an http\(s\) URL/,
        ],
      };
      for (const [why, [value, message]] of Object.entries(bad)) {
        expect(() => loadConfig({ ...VALID, CONTACT_URL: value }), why).toThrow(ConfigError);
        expect(() => loadConfig({ ...VALID, CONTACT_URL: value }), why).toThrow(message);
      }
    });
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
    'GrantSpotter/0.1.0 (+http://127.0.0.1:3030/grantspotter; nightly grant-deadline change detector; contact the operator at that page)';

  it('names the app and carries the contact URL', () => {
    // Plan 2's fetcher sends this on every request. Politeness §7.1.3.
    expect(buildUserAgent(loadConfig(VALID))).toBe(EXPECTED);
  });

  it('accepts a bare contact URL and produces the identical string', () => {
    // Plan 2's fetcher tests call the string form; both forms must agree.
    expect(buildUserAgent('http://127.0.0.1:3030/grantspotter')).toBe(EXPECTED);
    expect(buildUserAgent(loadConfig(VALID))).toBe(buildUserAgent(VALID.CONTACT_URL));
  });

  /**
   * The string a stranger reads. Everything in this block is about the reader who is not a user
   * of this software: a sysadmin at 2am with a log line from something they have never heard of.
   */
  it('is the exact line a polled site sees from a stock deployment', () => {
    expect(buildUserAgent(loadConfig({ SESSION_SECRET: VALID.SESSION_SECRET }))).toBe(
      'GrantSpotter/0.1.0 (+https://github.com/Atvriders/grantspotter/issues; ' +
        'nightly grant-deadline change detector; open an issue there to contact the maintainers)',
    );
  });

  it('spells out an action the URL in it can actually support', () => {
    // "open an issue" beside a club homepage would be an instruction nobody can follow, so the
    // clause is derived from the URL rather than fixed to the default's wording.
    expect(buildUserAgent(DEFAULT_CONTACT_URL)).toContain('open an issue there');
    expect(buildUserAgent('https://github.com/someone/their-fork/issues')).toContain(
      'open an issue there',
    );
    const club = buildUserAgent('https://w9xyz-radio-club.org/about');
    expect(club).toContain('contact the operator at that page');
    expect(club).not.toContain('open an issue');
  });

  it('is never anonymous and never more than one header line, whatever the contact URL', () => {
    // The properties that have to hold for EVERY value the loader can produce, not just the
    // three strings spelled out above. A User-Agent with no `+URL` is the thing this whole
    // variable exists to prevent; a User-Agent with a newline in it is a header-injection bug.
    const configs = [
      loadConfig({ SESSION_SECRET: VALID.SESSION_SECRET }), // the default
      loadConfig(VALID), // an http override
      loadConfig({ ...VALID, CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter' }),
      loadConfig({ ...VALID, CONTACT_URL: DEFAULT_CONTACT_URL }), // the default, set explicitly
    ];
    for (const config of configs) {
      const ua = buildUserAgent(config);
      expect(ua, ua).toContain(`GrantSpotter/0.1.0 (+${config.contactUrl};`);
      expect(ua, ua).toContain('nightly grant-deadline change detector');
      expect(ua, ua).toMatch(/contact/); // says how to reach somebody, not just who
      expect(ua, ua).not.toMatch(/[\r\n]/);
      expect(ua, ua).toMatch(/^[\x20-\x7e]+$/); // a legal single-line header value
    }
  });

  it('refuses to build an anonymous User-Agent', () => {
    // Unreachable through `loadConfig` — blank falls back to the default — and kept because this
    // function is exported and the scripts in scripts/ pass a bare string straight in.
    expect(() => buildUserAgent('')).toThrow(/CONTACT_URL is required/);
    expect(() => buildUserAgent('   ')).toThrow(/CONTACT_URL is required/);
  });
});
