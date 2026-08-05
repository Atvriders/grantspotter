import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildUserAgent,
  ConfigError,
  loadConfig,
  MIN_SESSION_SECRET_LENGTH,
  PLACEHOLDER_CONTACT_URL,
  PLACEHOLDER_MARKER,
  PLACEHOLDER_RUN_LENGTH,
  PLACEHOLDER_SESSION_SECRET,
  reservedContactName,
  resolveContactUrl,
} from '../src/config.js';
// The lookup's clause, imported rather than re-spelled: the value on the wire and the value this
// suite compares against the crawler's must be the same object, or this test proves nothing.
import { CALLSIGN_LOOKUP_PURPOSE } from '../src/callsign/callook.js';

/**
 * NOT example.org, and — since 2026-08-04 — NOT loopback either.
 *
 * This fixture has now been wrong twice, in opposite directions, which is worth recording because
 * both times it was the RULE that was wrong and the fixture merely honest about it.
 *
 *   1. It was `https://example.org/grantspotter`, back when the loader accepted RFC 2606 names.
 *      That value was also the error message's own worked example, so the message was handing out
 *      a placeholder at the moment an operator was most likely to paste one.
 *   2. It became `http://127.0.0.1:3030/grantspotter`, with the comment "loopback is the honest
 *      stand-in for a test: it is where this process actually is". True of the process and false
 *      of the value's only reader: this string goes into a User-Agent read by a sysadmin at a
 *      polled nonprofit, and `127.0.0.1` points at THEIR machine. The loader refuses it now, for
 *      exactly the reason it refuses `example.org`, so the fixture had to move again.
 *
 * What it is now: an invented club domain. The loader does no DNS and cannot tell a live club site
 * from an unregistered one — it rules out the addresses that are GUARANTEED to reach nobody, and
 * says so — so the honest fixture is a plausible public address that is nobody's, not a reserved
 * name pretending to be one.
 */
const VALID = {
  SESSION_SECRET: 'a'.repeat(32),
  CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter',
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
      // It parses, and nothing about its SHAPE is wrong — which is exactly why the check has to be
      // by value. `https://example.org/CHANGE_ME_…` would otherwise start a server that puts a
      // reserved documentation domain in front of ~25 volunteer-run sites.
      expect(new URL(PLACEHOLDER_CONTACT_URL).protocol).toBe('https:');
      expect(() => loadConfig({ ...VALID, CONTACT_URL: PLACEHOLDER_CONTACT_URL })).toThrow(
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

    it('is not walked past by a second trailing dot', () => {
      // `reservedContactName` and `unreachableContactHost` each carried their own
      // `.replace(/\.$/, '')` — one dot, once — and `https://example.org../x` passed BOTH:
      // `new URL` keeps the hostname as `example.org..`, one dot came off, and `example.org.` is
      // neither `example.org` nor a name ending in `.example.org`. They now share
      // `canonicalHostname` in net/hosts.ts.
      for (const url of [
        'https://example.org./x',
        'https://example.org../x',
        'https://example.org.../x',
        'https://my-club.invalid../contact',
      ]) {
        expect(() => loadConfig({ ...VALID, CONTACT_URL: url }), url).toThrow(
          /reserved for documentation/,
        );
      }
      expect(reservedContactName('example.org..')).toBe('example.org');
      // A real club domain is still a real club domain with the root dot written out.
      expect(loadConfig({ ...VALID, CONTACT_URL: 'https://w9xyz-radio-club.org./x' }).contactUrl).toBe(
        'https://w9xyz-radio-club.org./x',
      );
    });

    /**
     * The last assertion here used to be `expect(message).toMatch(/unset it entirely/)`, and it was
     * right about the code it was written against: for one day the message's advice was "unset this
     * and take the default". THAT ADVICE IS NOW IMPOSSIBLE TO FOLLOW — unsetting the variable is
     * the first branch of the predicate and refuses the start — so the assertion is not being
     * relaxed to get green; it is being replaced because keeping it would pin a message that lies.
     *
     * What replaces it is at least as tight: the message must still hand out no pasteable address,
     * AND it must now name where the operator is standing and say what kind of thing to put there.
     * A message that only said "invalid" would pass the old assertion's neighbours and fail these.
     */
    it('hands out no address of its own to paste back in, and no default to fall back on', () => {
      // The message that names a usable-looking example is the defect, not the wording.
      let message = '';
      try {
        loadConfig({ ...VALID, CONTACT_URL: PLACEHOLDER_CONTACT_URL });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/CONTACT_URL still contains CHANGE_ME/);
      expect(message).not.toMatch(/example\.(org|com|net)/);
      // No offer of a default, in any wording: there is none, and there cannot be one.
      expect(message).not.toMatch(/unset|default/i);
      // It says where to make the edit and what the value is for, which is all it can honestly do.
      expect(message).toContain('docker-compose.yml');
      expect(message).toMatch(/page you control/);
      expect(message).toMatch(/User-Agent/);
    });

    it('accepts an address that is somebody’s', () => {
      // Vacuity guard: this must rule out the reserved names, not http(s) URLs in general.
      //
      // `http://192.0.2.10:3030/about` used to be in this list, admitted on the reasoning that
      // RFC 5737 is a documentation ADDRESS rather than a reserved NAME. It is refused now, and
      // the distinction is what was wrong: the reader of this value is a stranger at a polled
      // site, and they can reach 192.0.2.10 exactly as well as they can reach example.org, which
      // is not at all. It moved to the block below with the loopback and LAN addresses.
      for (const url of [
        'https://w9xyz-radio-club.org/grantspotter',
        'https://exampleclub.org/contact', // "example" as a prefix is not example.org
        'https://notexample.com/contact',
        'https://gs.w9xyz.org.uk/who-runs-this', // a multi-label public suffix is not a TLD match
      ]) {
        expect(loadConfig({ ...VALID, CONTACT_URL: url }).contactUrl, url).toBe(url);
      }
    });
  });

  /**
   * WHAT THIS BLOCK HAS ASSERTED, IN ORDER, AND WHY IT IS BACK.
   *
   * It asserted "CONTACT_URL is required and has no default" for most of this project's life. On
   * 2026-08-04 it became "CONTACT_URL has a default now, and the default is a real address",
   * pinned to `https://github.com/Atvriders/grantspotter/issues`, on the reasoning that a first run
   * should not depend on the operator inventing a contact page. NEITHER ASSERTION WAS WRONG about
   * the code it was written against, and the second is not being deleted for going stale or for
   * standing in the way of green: the owner removed the default, and the reason decides the shape.
   *
   *   "remove the open a issue. i don't see issues for other deployments i have no control over"
   *
   * A shared default makes the maintainers of the SOFTWARE the contact for every deployment of it,
   * including the ones they do not run, cannot inspect and cannot stop. The site owner who follows
   * it gets an apology rather than a result, and pointing at the repository without the words "open
   * an issue" would not have helped — a repository is a place where people open issues.
   *
   * THE REPLACEMENT HAS TO HOLD THE RESTORED DESIGN AT LEAST AS TIGHTLY, and it can, because the
   * restored design is the stronger one for politeness: the server refuses to start without a
   * contact URL, so no deployment can poll anonymously, and the address it carries belongs to
   * somebody who can actually switch that instance off. So these tests assert exactly that —
   * unset is refused, blank is refused the same way, the refusal names what to set and where, and
   * every guard on an explicit value survives untouched.
   */
  describe('CONTACT_URL is required and has no default', () => {
    it('refuses to start with no CONTACT_URL in the environment at all', () => {
      expect(() => loadConfig({ SESSION_SECRET: VALID.SESSION_SECRET })).toThrow(ConfigError);
      expect(() => loadConfig({ SESSION_SECRET: VALID.SESSION_SECRET })).toThrow(
        /CONTACT_URL is required/,
      );
    });

    it('treats blank as unset, and refuses it the same way', () => {
      // `CONTACT_URL: ""` in a compose file is a variable somebody blanked. The alternative
      // reading — empty string as the contact URL — is the one case that could put a `(+; …)` on
      // the wire, and it is the case this branch exists for.
      for (const blank of ['', '   ', '\t']) {
        expect(() => loadConfig({ ...VALID, CONTACT_URL: blank }), blank).toThrow(
          /CONTACT_URL is required/,
        );
      }
    });

    it('says what the value is FOR, so the refusal is not merely an obstacle', () => {
      // The operator hitting this has a server that will not start. What they do next depends
      // entirely on this string: told only "required", the fastest thing to type is something that
      // parses and reaches nobody, which is the failure the requirement exists to prevent.
      let message = '';
      try {
        loadConfig({ SESSION_SECRET: VALID.SESSION_SECRET });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/User-Agent/);
      expect(message).toMatch(/contact URL/);
      expect(message).toContain('docker-compose.yml'); // where the edit is made
      // And it hands out no address of its own, at the moment an operator is likeliest to paste
      // whatever they are shown.
      expect(message).not.toMatch(/https?:\/\//);
    });

    it('names no default anywhere in the module, under any name', () => {
      // The structural half. A constant reintroduced as `FALLBACK_CONTACT_URL` or inlined as
      // `?? 'https://…'` would satisfy every behavioural test above on the day it was added and
      // quietly restore the design the owner removed — the reason `resolveContactUrl` is the one
      // reader of this variable in the first place.
      const source = readFileSync(
        resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'config.ts'),
        'utf8',
      );
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/DEFAULT_CONTACT_URL/);
      expect(code).not.toMatch(/(?:\?\?|\|\|)\s*['"]https?:\/\//);
      expect(code).toContain('CONTACT_URL'); // vacuity guard: the strip left the code behind
    });

    it('lets an operator’s own value through unaltered, which is the whole point', () => {
      const mine = 'https://w9xyz-radio-club.org/grantspotter';
      expect(loadConfig({ ...VALID, CONTACT_URL: mine }).contactUrl).toBe(mine);
      expect(loadConfig({ ...VALID, CONTACT_URL: VALID.CONTACT_URL }).contactUrl).toBe(
        VALID.CONTACT_URL,
      );
    });

    it('still refuses every explicitly bad value: nothing about the guard changed', () => {
      const bad: Record<string, [string, RegExp]> = {
        'the placeholder docker-compose.yml ships': [
          PLACEHOLDER_CONTACT_URL,
          /CONTACT_URL still contains CHANGE_ME/,
        ],
        'a marker left in an otherwise real address': [
          'https://w9xyz-radio-club.org/CHANGE_ME',
          /CONTACT_URL still contains CHANGE_ME/,
        ],
        'the shipped placeholder with only its host edited': [
          'https://w9xyz-radio-club.org/CHANGE_ME_to_a_page_that_says_who_runs_this',
          /CONTACT_URL still contains CHANGE_ME/,
        ],
        'the shipped placeholder with only its path edited': [
          'https://example.org/about',
          /reserved for documentation/,
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

    it('holds the SHIPPED placeholder to the rule an operator’s value is held to', () => {
      // The compose file's literal is not exempt; it is the first value that has to fail. Both
      // halves of it are independently disqualifying, which is what makes a half-edit safe without
      // the eight-character run rule the session secret needs — see PLACEHOLDER_CONTACT_URL.
      expect(PLACEHOLDER_CONTACT_URL.toUpperCase()).toContain(PLACEHOLDER_MARKER);
      expect(reservedContactName(new URL(PLACEHOLDER_CONTACT_URL).hostname)).toBe('example.org');
    });
  });

  /**
   * VALIDATED AS ONE ADDRESS, SENT AS ANOTHER.
   *
   * `optional()` trims the ends; `new URL()` deletes TAB, CR and LF from ANYWHERE in its input.
   * Between those two facts, a CONTACT_URL with an interior tab was checked as one string and put
   * on the wire as a different one, and a value with a newline booted cleanly and then injected a
   * line break into an HTTP header on every outbound request. Both measured against the built
   * `packages/server/dist/config.js` before the fix:
   *
   *   "https://w9xyz-radio-club.org/a<TAB>b"      validated as …/ab, sent as …/a<TAB>b
   *   "https://w9xyz-radio-club.org/x<CR><LF>…"   accepted, then `new Headers()` threw
   *                                               "is an invalid header value" on every fetch
   *
   * The rule is a character-set rule and it runs BEFORE `new URL`, which is the only ordering that
   * can work: after the parse, the evidence is gone.
   */
  describe('CONTACT_URL characters that would not survive the trip', () => {
    const smuggled: Record<string, string> = {
      'an interior tab': 'https://w9xyz-radio-club.org/a\tb',
      'a carriage return': 'https://w9xyz-radio-club.org/a\rb',
      'a newline, which is header injection': 'https://w9xyz-radio-club.org/about\nX-Injected: yes',
      'a CRLF pair': 'https://w9xyz-radio-club.org/about\r\nX-Injected: yes',
      'a tab inside the HOST, which rewrites the host': 'https://w9xyz-radio\t-club.org/x',
      'a NUL': 'https://w9xyz-radio-club.org/a\u0000b',
      'a DEL': 'https://w9xyz-radio-club.org/a\u007fb',
      'a non-ASCII host the parser would punycode': 'https://münster-arc.de/kontakt',
    };

    it('refuses every one of them', () => {
      for (const [why, value] of Object.entries(smuggled)) {
        expect(() => loadConfig({ ...VALID, CONTACT_URL: value }), why).toThrow(ConfigError);
        expect(() => loadConfig({ ...VALID, CONTACT_URL: value }), why).toThrow(
          /only printable ASCII/,
        );
      }
    });

    it('proves the point it is refusing them for: the parser really does delete these', () => {
      // Not a restatement of the rule — the reason for it. If this ever stops being true the rule
      // above is unnecessary, and a test that only asserted "refused" would never say so.
      expect(new URL('https://w9xyz-radio-club.org/a\tb').href).toBe(
        'https://w9xyz-radio-club.org/ab',
      );
      expect(new URL('https://w9xyz-radio\t-club.org/x').hostname).toBe('w9xyz-radio-club.org');
      expect(() => new Headers({ 'user-agent': 'x\r\ny' })).toThrow();
    });

    it('tells the operator the encoded form of what they typed, when there is one', () => {
      let message = '';
      try {
        loadConfig({ ...VALID, CONTACT_URL: 'https://münster-arc.de/kontakt' });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('punycode');
      expect(message).toContain('https://xn--mnster-arc-9db.de/kontakt');
    });

    it('refuses a space, which survives the parse but not a reader', () => {
      expect(() =>
        loadConfig({ ...VALID, CONTACT_URL: 'https://w9xyz-radio-club.org/who runs this' }),
      ).toThrow(/must not contain a space/);
      // …while a value whose only problem is that it is not a URL still says exactly that.
      expect(() => loadConfig({ ...VALID, CONTACT_URL: 'not a url' })).toThrow(
        /must be an http\(s\) URL/,
      );
    });

    /**
     * THE PROPERTY, over the config path rather than over `buildUserAgent` in isolation.
     *
     * The existing "never more than one header line" test builds four configs by hand. That is
     * the shape of test that misses a class: every value below was one `loadConfig` accepted, and
     * two of them produced a User-Agent that no HTTP client would send. The property is now:
     * whatever the environment says, EITHER the loader refuses it OR the User-Agent contains the
     * exact string it was given and is a legal single-line header value.
     */
    it('every value that boots produces a header the wire will carry, unaltered', () => {
      const candidates = [
        ...Object.values(smuggled),
        'https://w9xyz-radio-club.org/who runs this',
        'https://w9xyz-radio-club.org/grantspotter',
        'https://w9xyz-radio-club.org/a%20b',
        'https://w9xyz-radio-club.org/~w9xyz/contact?ref=logs#top',
        'http://w9xyz-radio-club.org:8080/contact',
        'https://github.com/w9xyz/my-grantspotter-fork/issues', // an operator's own tracker
        'not a url',
        'ftp://w9xyz-radio-club.org/',
        'http://127.0.0.1:3030/grantspotter',
        'https://example.org/x',
        PLACEHOLDER_CONTACT_URL,
      ];
      let accepted = 0;
      for (const value of candidates) {
        let config;
        try {
          config = loadConfig({ ...VALID, CONTACT_URL: value });
        } catch (err) {
          expect(err, value).toBeInstanceOf(ConfigError);
          continue;
        }
        accepted += 1;
        const ua = buildUserAgent(config);
        expect(config.contactUrl, value).toBe(value); // stored verbatim, nothing normalised away
        expect(ua, value).toContain(`(+${value};`); // the exact string, on the wire
        expect(ua, value).toMatch(/^[\x20-\x7e]+$/); // one line, printable ASCII
        expect(() => new Headers({ 'user-agent': ua }), value).not.toThrow();
      }
      expect(accepted).toBeGreaterThan(4); // vacuity: the loop must not be refusing everything
    });
  });

  /**
   * THE RULE AND ITS STATED REASON, MADE TO AGREE (2026-08-04).
   *
   * `loadConfig` refused `example.org` because a reserved name "resolves for nobody", and in the
   * same breath accepted `http://127.0.0.1:3030/grantspotter`, `https://192.168.1.5/`,
   * `http://[::1]/`, `http://0.0.0.0/`, `https://intranet/` and `https://a/`. Every one of those
   * is MORE useless to the reader than example.org: the reader is a sysadmin at a polled
   * nonprofit, and those addresses name their own machine, their own LAN, or nothing.
   *
   * The rule now enforces what it always claimed to: an address that cannot reach the operator
   * from the public internet is refused, whether it is reserved-by-name or unreachable-by-range.
   * It does NOT claim the accepted ones resolve — no DNS happens here, and the message says so.
   */
  describe('CONTACT_URL that cannot be reached from the public internet', () => {
    it('refuses loopback, LAN, link-local, dotless and documentation addresses', () => {
      const unreachable: Record<string, string> = {
        'IPv4 loopback, the value this suite itself used to use': 'http://127.0.0.1:3030/grantspotter',
        'another loopback address in 127/8': 'http://127.1.2.3/about',
        'the name for loopback': 'http://localhost:3030/',
        'IPv6 loopback': 'http://[::1]/',
        'IPv6 loopback, IPv4-mapped': 'http://[::ffff:127.0.0.1]/',
        'RFC 1918, the shape a home server has': 'https://192.168.1.5/',
        'RFC 1918, 10/8': 'https://10.0.0.7:8080/',
        'RFC 1918, 172.16/12': 'https://172.20.3.4/contact',
        'the unspecified address': 'http://0.0.0.0/',
        'link-local': 'https://169.254.10.2/',
        'carrier-grade NAT': 'https://100.100.20.3/',
        'IPv6 link-local': 'https://[fe80::1]/',
        'IPv6 unique-local': 'https://[fd00::5]/',
        'a single-label intranet name': 'https://intranet/',
        'a single-label name of one letter': 'https://a/',
        'an mDNS name': 'https://gs.local/contact',
        'ICANN’s private-use TLD': 'https://grantspotter.internal/contact',
        'RFC 8375 home networking': 'https://gs.home.arpa/',
        'RFC 5737 TEST-NET-1': 'http://192.0.2.10:3030/about',
        'RFC 5737 TEST-NET-2': 'http://198.51.100.4/about',
        'RFC 5737 TEST-NET-3': 'http://203.0.113.9/about',
        'RFC 3849 documentation IPv6': 'http://[2001:db8::1]/about',
      };
      for (const [why, url] of Object.entries(unreachable)) {
        expect(() => loadConfig({ ...VALID, CONTACT_URL: url }), why).toThrow(ConfigError);
        expect(() => loadConfig({ ...VALID, CONTACT_URL: url }), why).toThrow(
          /cannot be reached from the public internet/,
        );
      }
    });

    it('finds loopback and LAN addresses hidden inside an IPv6 literal', () => {
      // Refusing `http://[::ffff:127.0.0.1]/` while accepting these was the state of things until
      // 2026-08-04, because the check compared SPELLINGS. Every one of these is 127.0.0.1 or
      // 192.168.1.5, and `new URL` parses all of them.
      const hidden: Record<string, string> = {
        'NAT64 well-known prefix, RFC 6052': 'http://[64:ff9b::7f00:1]/about',
        'NAT64, written with the dotted quad': 'http://[64:ff9b::127.0.0.1]/about',
        'NAT64 local-use prefix, RFC 8215': 'http://[64:ff9b:1::192.168.1.5]/about',
        'IPv4-translated, RFC 2765': 'http://[::ffff:0:127.0.0.1]/about',
        'IPv4-compatible, RFC 4291': 'http://[::127.0.0.1]/about',
        '6to4 around loopback, RFC 3056': 'http://[2002:7f00:1::1]/about',
        '6to4 around a LAN address': 'http://[2002:c0a8:105::1]/about',
      };
      for (const [why, url] of Object.entries(hidden)) {
        expect(() => loadConfig({ ...VALID, CONTACT_URL: url }), why).toThrow(
          /cannot be reached from the public internet/,
        );
      }
    });

    /**
     * The two assertions here were `/unset CONTACT_URL/` and `/reaches a human/`, and they were
     * right for the one day this message could honestly say "unset it and take the default". There
     * is no default to take, so keeping them would pin advice that cannot be followed — the same
     * reason they were written in the first place, applied in the other direction.
     *
     * What they are replaced by is the harder half of the same requirement. This message refuses a
     * LEGITIMATE deployment — somebody running GrantSpotter on a home server whose only web page is
     * on the LAN — and it no longer has a fallback to offer them. So it has to say what would work
     * instead, in concrete terms, or the next thing that operator types is a plausible-looking lie.
     */
    it('says what it costs and what would work instead, because it is refusing a real deployment', () => {
      let message = '';
      try {
        loadConfig({ ...VALID, CONTACT_URL: 'https://192.168.1.5/about' });
      } catch (err) {
        message = (err as Error).message;
      }
      // No offer of a default, because there is none to offer.
      expect(message).not.toMatch(/unset|default/i);
      // Somewhere to go that does not require exposing the instance itself.
      expect(message).toMatch(/reachable from outside your network/);
      expect(message).toMatch(/does not have to be the instance itself/);
      // And it names what it found rather than saying "invalid".
      expect(message).toContain('192.168.1.5');
    });

    it('does not over-reach into names that merely look local', () => {
      // Vacuity guard, and a real risk: a substring rule would refuse a club whose domain happens
      // to contain one of these words, and every over-refusal pushes an operator toward a value
      // that parses and reaches nobody.
      for (const url of [
        'https://localhost-hosting.org/contact', // a real registrable domain
        'https://local.w9xyz-radio-club.org/contact', // `local` as a LABEL, not the TLD
        'https://internal.w9xyz-radio-club.org/contact',
        'https://home.arpa.w9xyz-radio-club.org/contact',
        'https://10-10-international.org/contact', // 10-10 International Net, a real club
        'https://w9xyz-radio-club.org/10.0.0.1', // a private address in the PATH is not the host
      ]) {
        expect(loadConfig({ ...VALID, CONTACT_URL: url }).contactUrl, url).toBe(url);
      }
    });
  });

  /**
   * ONE PREDICATE, CALLED BY EVERY PATH.
   *
   * `scripts/verify-sources.ts` and `scripts/capture-fixture.ts` — both documented in the README,
   * both polling the same live nonprofit sites the nightly crawl polls — read
   * `process.env.CONTACT_URL` themselves and never called `loadConfig`. Measured before the fix:
   * `CONTACT_URL='not a url' npm run verify-sources -- qcwa` fetched qcwa.org, got a live 200, and
   * sent `GrantSpotter/0.1.0 (+not a url; …)`.
   *
   * `resolveContactUrl` is the shared entry point those scripts use now, so these tests are what
   * says the two paths cannot disagree. The structural half — nothing NEW skips it — is
   * `test/contactUrlEntryPointContract.test.ts`.
   */
  describe('resolveContactUrl: the one way a contact URL enters this process', () => {
    it('agrees with loadConfig on every value, good and bad', () => {
      const values = [
        undefined,
        '',
        '   ',
        'https://w9xyz-radio-club.org/grantspotter',
        'https://github.com/w9xyz/my-grantspotter-fork/issues',
        'https://gs.w9xyz.org.uk/who-runs-this',
        'http://w9xyz-radio-club.org:8080/contact',
        '  https://w9xyz-radio-club.org/padded  ',
        'not a url',
        'ftp://w9xyz-radio-club.org/',
        'https://example.org/x',
        'https://x.invalid/me',
        PLACEHOLDER_CONTACT_URL,
        'http://127.0.0.1:3030/grantspotter',
        'https://w9xyz-radio-club.org/a\tb',
      ];
      let refused = 0;
      let accepted = 0;
      for (const value of values) {
        const env = value === undefined ? {} : { CONTACT_URL: value };
        let resolved: string | Error;
        try {
          resolved = resolveContactUrl(env);
          accepted += 1;
        } catch (err) {
          resolved = err as Error;
          refused += 1;
        }
        let loaded: string | Error;
        try {
          loaded = loadConfig({ ...env, SESSION_SECRET: VALID.SESSION_SECRET }).contactUrl;
        } catch (err) {
          loaded = err as Error;
        }
        if (resolved instanceof Error) {
          expect(loaded, String(value)).toBeInstanceOf(ConfigError);
          expect((loaded as Error).message, String(value)).toBe(resolved.message);
        } else {
          expect(loaded, String(value)).toBe(resolved);
        }
      }
      expect(refused).toBeGreaterThan(5); // vacuity guards on both arms of the loop
      expect(accepted).toBeGreaterThan(4);
    });

    it('refuses when the environment says nothing, rather than inventing an address', () => {
      // The scripts in `scripts/` poll the same live nonprofit sites the nightly crawl polls. This
      // is the branch that decides whether `npm run verify-sources` with no CONTACT_URL set is a
      // refusal or an anonymous poll of somebody's club site.
      for (const env of [{}, { CONTACT_URL: '  ' }, { CONTACT_URL: '' }]) {
        expect(() => resolveContactUrl(env), JSON.stringify(env)).toThrow(/CONTACT_URL is required/);
      }
    });

    it('refuses before anything can be fetched — the failure is a ConfigError, not a network error', () => {
      // What the scripts rely on: this throws where they call it, above the line that builds a
      // fetcher, so the refusal costs a polled site nothing.
      expect(() => resolveContactUrl({ CONTACT_URL: 'not a url' })).toThrow(ConfigError);
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
    'GrantSpotter/0.1.0 (+https://w9xyz-radio-club.org/grantspotter; nightly grant-deadline change detector; contact the operator of this instance at that page)';

  it('names the app and carries the contact URL', () => {
    // Plan 2's fetcher sends this on every request. Politeness §7.1.3.
    expect(buildUserAgent(loadConfig(VALID))).toBe(EXPECTED);
  });

  it('accepts a bare contact URL and produces the identical string', () => {
    // Plan 2's fetcher tests call the string form; both forms must agree.
    expect(buildUserAgent('https://w9xyz-radio-club.org/grantspotter')).toBe(EXPECTED);
    expect(buildUserAgent(loadConfig(VALID))).toBe(buildUserAgent(VALID.CONTACT_URL));
  });

  /**
   * THE OTHER HALF OF "ONE PREDICATE". `buildUserAgent` is the only thing in this repository that
   * mints a wire User-Agent (RESOLUTIONS R10), and it is exported, and `scripts/` used to hand it
   * a bare `process.env.CONTACT_URL`. So it validates too: whatever route a value takes to get
   * here, it faces the same rules `loadConfig` applies.
   */
  it('refuses to mint a User-Agent from a value loadConfig would refuse', () => {
    for (const bad of [
      'not a url',
      'ftp://w9xyz-radio-club.org/',
      'https://example.org/grantspotter',
      'https://x.invalid/me',
      PLACEHOLDER_CONTACT_URL,
      'http://127.0.0.1:3030/grantspotter',
      'https://w9xyz-radio-club.org/about\r\nX-Injected: yes',
    ]) {
      expect(() => buildUserAgent(bad), bad).toThrow(ConfigError);
      expect(() => loadConfig({ ...VALID, CONTACT_URL: bad }), bad).toThrow(ConfigError);
    }
  });

  /**
   * THE STRING A STRANGER READS, and the clause that says how to act on it.
   *
   * This used to assert two wordings: "open an issue there to contact the maintainers" when the URL
   * was a GitHub issue tracker, and "contact the operator at that page" otherwise, derived by a
   * private `isGithubIssueTracker` predicate. That was correct while a shared default existed — a
   * default pointing at an issue tracker should say so — and it stopped being correct the moment the
   * default did, because every URL that can reach this function now belongs to whoever runs the
   * instance. The predicate has no caller and is deleted; the wording is one clause for everyone.
   *
   * "the operator OF THIS INSTANCE" rather than "the operator" is doing work: the reader is a
   * sysadmin looking at a log line from self-hosted software, and what they need to know is that the
   * page named is the person who runs the crawler that visited THEM, not a project office.
   */
  it('is the exact line a polled site sees, and it names the operator of the instance', () => {
    expect(buildUserAgent(loadConfig(VALID))).toBe(
      'GrantSpotter/0.1.0 (+https://w9xyz-radio-club.org/grantspotter; ' +
        'nightly grant-deadline change detector; contact the operator of this instance at that page)',
    );
  });

  it('says the same thing whatever shape of page the operator named', () => {
    // The clause may not vary with the URL any more: a fork's issue tracker, a club page and a
    // university department page are all "the operator of this instance" and none of them is us.
    for (const url of [
      'https://github.com/w9xyz/my-grantspotter-fork/issues',
      'https://w9xyz-radio-club.org/about',
      'https://ece.w9xyz-university.edu/amateur-radio/contact',
      'http://w9xyz-radio-club.org:8080/contact',
    ]) {
      const ua = buildUserAgent(url);
      expect(ua, url).toContain('contact the operator of this instance at that page');
      // And never the instruction that only one shape of page can carry.
      expect(ua, url).not.toContain('open an issue');
      expect(ua, url).not.toContain('maintainers');
    }
  });

  it('is never anonymous and never more than one header line, whatever the contact URL', () => {
    // The properties that have to hold for EVERY value the loader can produce, not just the
    // strings spelled out above. A User-Agent with no `+URL` is the thing this whole variable
    // exists to prevent; a User-Agent with a newline in it is a header-injection bug.
    const configs = [
      loadConfig(VALID),
      loadConfig({ ...VALID, CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter' }),
      loadConfig({ ...VALID, CONTACT_URL: 'http://w9xyz-radio-club.org:8080/contact' }),
      loadConfig({ ...VALID, CONTACT_URL: 'https://github.com/w9xyz/my-fork/issues' }),
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
    // Reachable through `loadConfig` again, which it was not while a default existed: an unset or
    // blank CONTACT_URL now lands here rather than on a fallback. That is the property the whole
    // change buys — no deployment of this software can poll anonymously — so it is asserted at
    // both ends, on the bare-string form the scripts in `scripts/` pass and through the loader.
    expect(() => buildUserAgent('')).toThrow(/CONTACT_URL is required/);
    expect(() => buildUserAgent('   ')).toThrow(/CONTACT_URL is required/);
    expect(() => loadConfig({ SESSION_SECRET: VALID.SESSION_SECRET })).toThrow(
      /CONTACT_URL is required/,
    );
  });
});

/**
 * THE PURPOSE CLAUSE, AND THE TWO ACTIVITIES THAT MAY DIFFER IN IT.
 *
 * Two things in this software open a socket at a stranger's host: the nightly crawl and the
 * user-initiated callsign lookup. Until 2026-08-04 they signed themselves identically, and what
 * they both said was the crawler's sentence — `nightly grant-deadline change detector` — on a
 * request that is not nightly, detects nothing, and is one licence record a person asked us to
 * read about themselves. Being identified is half the courtesy the User-Agent exists for; being
 * described accurately is the other half, and callook.info's owner was getting one of them.
 *
 * THE FIX HAD TO BE A PARAMETER OF THE ONE FACTORY (RESOLUTIONS R10). A second builder is exactly
 * how this repository once ended up with two different strings on the wire, and "the crawler and
 * the lookup need different wording" is precisely the pressure that produces one. So: same
 * function, same version, same `+URL`, same contact sentence, same punctuation — one clause moves.
 */
describe('buildUserAgent: the purpose clause', () => {
  const CRAWL = 'GrantSpotter/0.1.0 (+https://w9xyz-radio-club.org/grantspotter; ';
  const CONTACT = '; contact the operator of this instance at that page)';

  it('defaults to the crawler wording, so every existing caller is untouched', () => {
    // The default is not merely "some default": it is byte-for-byte what this function returned
    // before the parameter existed, which is what makes the change safe for the ~25 polled sites.
    expect(buildUserAgent(VALID.CONTACT_URL)).toBe(
      `${CRAWL}nightly grant-deadline change detector${CONTACT}`,
    );
    expect(buildUserAgent(loadConfig(VALID))).toBe(buildUserAgent(VALID.CONTACT_URL));
  });

  /**
   * SIDE BY SIDE, WHICH IS THE ONLY WAY TO SEE THAT IT DIFFERS IN THE RIGHT WAY AND ONLY THERE.
   * Everything a site owner uses to identify and reach us is identical; the description of what we
   * came for is not.
   */
  it('differs from the crawl in the purpose clause and in nothing else', () => {
    const crawl = buildUserAgent(loadConfig(VALID));
    const lookup = buildUserAgent(loadConfig(VALID), CALLSIGN_LOOKUP_PURPOSE);

    expect(lookup).toBe(`${CRAWL}${CALLSIGN_LOOKUP_PURPOSE}${CONTACT}`);
    expect(lookup).not.toBe(crawl);
    // Same product, same version, same contact URL, same instruction for reaching a human.
    expect(crawl.startsWith(CRAWL)).toBe(true);
    expect(lookup.startsWith(CRAWL)).toBe(true);
    expect(crawl.endsWith(CONTACT)).toBe(true);
    expect(lookup.endsWith(CONTACT)).toBe(true);
    // And the difference is exactly one clause: strip it and the two are the same string.
    expect(lookup.replace(CALLSIGN_LOOKUP_PURPOSE, '')).toBe(
      crawl.replace('nightly grant-deadline change detector', ''),
    );
    // The false sentence is gone from the lookup's line, and still present on the crawl's.
    expect(lookup).not.toContain('nightly');
    expect(crawl).toContain('nightly grant-deadline change detector');
  });

  it('is still a legal single-line header value with the lookup clause in it', () => {
    const lookup = buildUserAgent(loadConfig(VALID), CALLSIGN_LOOKUP_PURPOSE);
    expect(lookup).not.toMatch(/[\r\n]/);
    expect(lookup).toMatch(/^[\x20-\x7e]+$/);
    // Three clauses, still: the `+URL`, the purpose, the contact instruction.
    expect(lookup.split('; ')).toHaveLength(3);
  });

  /**
   * The parameter is a wire value, so it faces the same treatment the contact URL does. Nothing
   * outside this repository can reach it today — both callers pass a module constant — and that is
   * the condition under which a guard is cheap. A `;` or a bracket is the interesting case: it
   * would not break the header, it would forge a clause, and the result reads perfectly.
   */
  it('refuses a purpose clause that would split the header or forge another clause', () => {
    for (const bad of [
      '',
      '   ',
      'nightly\r\nX-Injected: yes',
      'nightly\ncrawl',
      'crawler; nightly grant-deadline change detector',
      'crawler (nightly)',
      'a purpose clause with a \u0007 bell in it',
      'a purpose clause with a \u0000 null in it',
      'a purpose clause with a \t tab in it',
      'x'.repeat(121),
    ]) {
      expect(() => buildUserAgent(VALID.CONTACT_URL, bad), bad).toThrow(ConfigError);
    }
  });

  it('still refuses an unusable contact URL whatever the purpose says', () => {
    expect(() => buildUserAgent('', CALLSIGN_LOOKUP_PURPOSE)).toThrow(/CONTACT_URL is required/);
    expect(() => buildUserAgent('https://example.org/x', CALLSIGN_LOOKUP_PURPOSE)).toThrow(
      ConfigError,
    );
  });
});
