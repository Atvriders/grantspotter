import { describe, expect, it } from 'vitest';
import {
  clampCooldownMs,
  cooldownKey,
  COOLDOWN_CAP_MS,
  COOLDOWN_FLOOR_MS,
  createHostCooldown,
  describeWait,
  parseRetryAfterMs,
} from './cooldown.js';

/**
 * The parts, on their own. `callook.test.ts` drives the same behaviour through the real client,
 * which is where the request COUNTS are asserted; this file pins the arithmetic that decides them,
 * because a floor or a parse that is quietly wrong shows up there as one fewer request and nowhere
 * as a sentence anybody can check.
 *
 * The clock is an argument everywhere in this module, so nothing here reads the machine's.
 */

const NOW = Date.parse('2026-08-04T22:07:30.000Z');

describe('parseRetryAfterMs: the two forms RFC 9110 defines, and nothing else', () => {
  it.each([
    ['0', 0],
    ['1', 1_000],
    ['120', 120_000],
    ['  120  ', 120_000],
    ['86400', 86_400_000],
  ])('reads delta-seconds %s', (header, expected) => {
    expect(parseRetryAfterMs(header, NOW)).toBe(expected);
  });

  it('reads an HTTP-date as the distance from now', () => {
    const header = new Date(NOW + 300_000).toUTCString();
    expect(parseRetryAfterMs(header, NOW)).toBe(300_000);
  });

  /**
   * A date already in the past is not an instruction to wait, and must not become a negative hold
   * that silently cancels one. It reads as zero, and {@link clampCooldownMs} then raises it to the
   * floor — because the response it arrived on was still a 429.
   */
  it('reads a date in the past as zero rather than as a negative wait', () => {
    const header = new Date(NOW - 600_000).toUTCString();
    expect(parseRetryAfterMs(header, NOW)).toBe(0);
  });

  /**
   * `-5` and `1.5` are the two that `Number.parseInt` would have taken, and both would have become
   * a hold this module never meant to place: one negative, one fractional. `delta-seconds` is
   * `1*DIGIT` and nothing else, so neither reaches the numeric branch — and neither reaches
   * `Date.parse` either, because every date form RFC 9110 permits starts with a day name and these
   * do not. THAT SECOND GUARD WAS ADDED BECAUSE THIS TEST FOUND ITS ABSENCE: without it,
   * `Date.parse('-5')` reads as 1 May 2001 and `Date.parse('1.5')` as 5 January 2001 on node
   * 20.19.43, which reduce to zero here only by the accident of being in the past.
   */
  it.each([
    ['', undefined],
    ['   ', undefined],
    ['soon', undefined],
    ['-5', undefined],
    ['1.5', undefined],
    ['120s', undefined],
    ['NaN', undefined],
    ['99999999999999999999', undefined],
    ['12-25', undefined],
    ['2099-01-01', undefined],
  ])('refuses to read %s as an instruction', (header, expected) => {
    expect(parseRetryAfterMs(header, NOW)).toBe(expected);
  });

  /**
   * The guard above must not eat the thing it is guarding. All three forms §5.6.7 permits begin
   * with a day name, and all three have to survive.
   */
  it.each([
    ['Tue, 04 Aug 2026 22:12:30 GMT', 300_000],
    ['Tuesday, 04-Aug-26 22:12:30 GMT', 300_000],
  ])('still reads the zoned HTTP-date form %s', (header, expected) => {
    expect(parseRetryAfterMs(header, NOW)).toBe(expected);
  });

  /**
   * The asctime form carries NO ZONE — that is the form itself, not this parser — so what it means
   * depends on the reader's clock, and V8 reads it as local time. This host is not UTC, so pinning
   * a millisecond count here would pin the machine rather than the code. What has to be true is
   * that the form is READ at all rather than dropped by the day-name guard; how far away it lands
   * is then the source's problem and the clamp's, and a value that misses by a timezone still
   * cannot escape the floor and the cap.
   */
  it('reads the zoneless asctime form rather than dropping it', () => {
    expect(parseRetryAfterMs('Tue Aug  4 22:12:30 2026', NOW)).toBeTypeOf('number');
  });

  it('treats an absent header as no instruction at all', () => {
    expect(parseRetryAfterMs(null, NOW)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
  });
});

describe('clampCooldownMs', () => {
  it('never holds for less than the floor, whatever the source asked for', () => {
    // `Retry-After: 0` is "I am not asking for more than your own floor", not "ask me again now".
    expect(clampCooldownMs(0)).toBe(COOLDOWN_FLOOR_MS);
    expect(clampCooldownMs(1_000)).toBe(COOLDOWN_FLOOR_MS);
    expect(clampCooldownMs(-1)).toBe(COOLDOWN_FLOOR_MS);
  });

  it('honours anything between the floor and a day exactly', () => {
    expect(clampCooldownMs(120_000)).toBe(120_000);
    expect(clampCooldownMs(COOLDOWN_CAP_MS)).toBe(COOLDOWN_CAP_MS);
  });

  it('caps an absurd value rather than disabling the feature for the life of the process', () => {
    expect(clampCooldownMs(365 * COOLDOWN_CAP_MS)).toBe(COOLDOWN_CAP_MS);
  });
});

describe('createHostCooldown', () => {
  it('answers zero for a host that has said nothing', () => {
    expect(createHostCooldown().remainingMs('https://callook.info', NOW)).toBe(0);
  });

  it('counts down and then expires', () => {
    const cooldown = createHostCooldown();
    cooldown.hold('https://callook.info', 120_000, NOW);

    expect(cooldown.remainingMs('https://callook.info', NOW)).toBe(120_000);
    expect(cooldown.remainingMs('https://callook.info', NOW + 119_999)).toBe(1);
    expect(cooldown.remainingMs('https://callook.info', NOW + 120_000)).toBe(0);
    expect(cooldown.remainingMs('https://callook.info', NOW + 500_000)).toBe(0);
  });

  it('keeps hosts apart, so one source asking to wait does not silence another', () => {
    const cooldown = createHostCooldown();
    cooldown.hold('https://callook.info', 120_000, NOW);

    expect(cooldown.remainingMs('https://example-radio-club.org', NOW)).toBe(0);
  });

  /** A second, shorter instruction has not cancelled the first: it has not expired yet. */
  it('never shortens a hold that is already longer', () => {
    const cooldown = createHostCooldown();
    cooldown.hold('https://callook.info', 120_000, NOW);
    cooldown.hold('https://callook.info', 5_000, NOW);

    expect(cooldown.remainingMs('https://callook.info', NOW)).toBe(120_000);
  });

  it('extends a hold that is longer than what is left of the current one', () => {
    const cooldown = createHostCooldown();
    cooldown.hold('https://callook.info', 60_000, NOW);
    cooldown.hold('https://callook.info', 300_000, NOW + 30_000);

    expect(cooldown.remainingMs('https://callook.info', NOW + 30_000)).toBe(300_000);
  });
});

/**
 * THE LANE, WHICH IS THE HALF THE HOLD COULD NOT DO.
 *
 * A hold is written when an answer arrives and read before a request leaves, so it can only ever
 * stop presses that come AFTER an answer. Presses that overlap the request all read an empty ledger
 * and all send. Measured 2026-08-04 through the real client against a loopback stand-in answering
 * `429 Retry-After: 120`, eight presses fired with `Promise.all`: eight requests, with the cooldown
 * present and passing every test above it.
 */
describe('createHostCooldown: one request at a time, per host', () => {
  const HOST = 'https://callook.info';

  it('answers that nobody is asking a host it has never heard of', () => {
    expect(createHostCooldown().isAsking(HOST)).toBe(false);
  });

  it('gives the lane to the first press and refuses the second', () => {
    const cooldown = createHostCooldown();

    const release = cooldown.beginAsking(HOST);
    expect(release).toBeTypeOf('function');
    expect(cooldown.isAsking(HOST)).toBe(true);
    expect(cooldown.beginAsking(HOST)).toBeUndefined();
  });

  it('reopens the lane when the press holding it is done', () => {
    const cooldown = createHostCooldown();

    const release = cooldown.beginAsking(HOST);
    release?.();

    expect(cooldown.isAsking(HOST)).toBe(false);
    expect(cooldown.beginAsking(HOST)).toBeTypeOf('function');
  });

  /**
   * A release called twice must not free a lane the SECOND press is holding. `callook.ts` releases
   * in a `finally`, and a `finally` is exactly the shape that runs once too often when somebody
   * later adds an early return with a release of its own beside it.
   */
  it('ignores a stale release rather than freeing a lane somebody else now holds', () => {
    const cooldown = createHostCooldown();

    const first = cooldown.beginAsking(HOST);
    first?.();
    const second = cooldown.beginAsking(HOST);
    first?.();

    expect(second).toBeTypeOf('function');
    expect(cooldown.isAsking(HOST)).toBe(true);
    expect(cooldown.beginAsking(HOST)).toBeUndefined();
  });

  /** Two deployments, two loopback stand-ins, two sources. Asking one is not asking the other. */
  it('keeps hosts apart', () => {
    const cooldown = createHostCooldown();
    cooldown.beginAsking('http://127.0.0.1:8081');

    expect(cooldown.isAsking('http://127.0.0.1:8082')).toBe(false);
    expect(cooldown.beginAsking('http://127.0.0.1:8082')).toBeTypeOf('function');
  });

  /** Two different facts about one host, and neither is read off the other. */
  it('does not read a hold as a request in flight, or the reverse', () => {
    const cooldown = createHostCooldown();

    cooldown.hold(HOST, 120_000, NOW);
    expect(cooldown.isAsking(HOST)).toBe(false);

    const other = createHostCooldown();
    other.beginAsking(HOST);
    expect(other.remainingMs(HOST, NOW)).toBe(0);
  });
});

describe('cooldownKey', () => {
  /**
   * The trailing-dot host has walked past four hand-written host checks in this repository. A hold
   * placed by `callook.info` that `callook.info.` does not see would be a way round it that costs
   * one character to find.
   */
  it('is the same key for the same host however the URL spells it', () => {
    expect(cooldownKey('https://CALLOOK.INFO/W1AW/json')).toBe(cooldownKey('https://callook.info/'));
    expect(cooldownKey('https://callook.info./W1AW/json')).toBe(cooldownKey('https://callook.info/'));
  });

  it('is a different key for a different port, which is a different server', () => {
    expect(cooldownKey('http://127.0.0.1:8081/x')).not.toBe(cooldownKey('http://127.0.0.1:8082/x'));
  });
});

describe('describeWait', () => {
  it.each([
    [1_000, 'about 1 second'],
    [8_000, 'about 8 seconds'],
    [45_000, 'about 45 seconds'],
    [COOLDOWN_FLOOR_MS, 'about 1 minute'],
    [120_000, 'about 2 minutes'],
    [90 * 60_000, 'about 90 minutes'],
    [COOLDOWN_CAP_MS, 'about 24 hours'],
  ])('says %d ms as "%s"', (ms, expected) => {
    expect(describeWait(ms)).toBe(expected);
  });

  /** Rounded up: a message that sends somebody back a second early sends them back to itself. */
  it('rounds up rather than down', () => {
    expect(describeWait(1)).toBe('about 1 second');
    expect(describeWait(61_000)).toBe('about 2 minutes');
  });
});
