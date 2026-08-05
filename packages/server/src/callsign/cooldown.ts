import { canonicalOrigin } from '../net/hosts.js';

/**
 * THE MEMORY THAT MAKES "WE BACKED OFF" TRUE ACROSS TWO BUTTON PRESSES.
 *
 * The crawler learned to honour `Retry-After` on 2026-08-04 (`fetcher/index.ts`: `backoffMs` lets
 * it win outright, and `HostQueue.defer` holds the host's lane for it). The lookup did not inherit
 * any of that, because it deliberately does not use the fetcher — and a stateless function cannot
 * back off, because backing off is a fact about the PREVIOUS request and a function that keeps
 * nothing has no previous request.
 *
 * MEASURED, 2026-08-04, before this file existed. A loopback server answering `429` with
 * `Retry-After: 120` to everything received EIGHT requests in 69 ms from eight presses — gaps of
 * 21, 9, 7, 8, 8, 8 and 8 ms. The rate limiter in `api/callsign.ts` allows eight presses per ten
 * minutes and cannot see how fast they arrive, so eight presses inside a second is eight requests
 * inside a second, at a host that had already said "not for two minutes" in writing, seven times.
 *
 * callook.info publishes `Disallow: /`. This product queries it anyway, on an argument written out
 * in full in `callook.ts` and in the README, and the whole of that argument rests on this being one
 * request that a person asked for. A burst is not that. It also makes the one instruction the site
 * CAN give a non-crawler — a `Retry-After` header on a 429 — the one instruction we ignored.
 *
 * WHAT THIS IS NOT. It is not a queue, not a retry, and it never sleeps: the lookup is in front of
 * somebody watching a spinner and may not make them wait for politeness. It is a note of when a
 * host said it would like to be asked again, which the next press READS and then answers the
 * person without a request. In memory only, per process, lost on restart — a durable ledger would
 * be a promise this software cannot keep across a container rebuild, and the honest scale of the
 * problem is one person pressing one button a few times in a row.
 *
 * AND THE SECOND FACT, ADDED 2026-08-04: WHETHER WE ARE ASKING THAT HOST RIGHT NOW.
 *
 * The hold above is written when the answer ARRIVES and read before the request LEAVES, and for a
 * day those two moments had a gap between them wide enough to drive the whole defect through. Every
 * press that started while the first request was still in flight read an empty ledger, passed the
 * check, and sent its own request — so the hold could only ever stop the presses that came after an
 * answer, never the ones racing it. Measured on this host, 2026-08-04, against a loopback server
 * answering `429 Retry-After: 120`: eight presses fired with `Promise.all` produced EIGHT requests,
 * exactly as they had before any of this existed. The per-session ration next door bounds one
 * member at eight; several members racing is not bounded at all, because the hold is the only
 * mechanism that is about the HOST and it was the one that could not see them.
 *
 * So a host also has a lane, and there is one of it. A press that arrives while a request to that
 * host is in flight does not send a second one; it is answered from here, in this process, with the
 * sentence `callook.ts` writes for it. ONE LANE PER HOST IS THE RIGHT UNIT because it is the unit
 * the promise is made in: the README defends querying a site that publishes `Disallow: /` on the
 * ground that this is one person, one button, one request to one host — not one request per person,
 * which is what "bounded per session" would mean. A lane per user would leave a hundred accounts
 * able to make a hundred simultaneous requests, each of them individually polite.
 *
 * IT IS STILL NOT A QUEUE. The losing press is refused, not parked: parking it would make somebody
 * wait out another person's eight-second timeout on top of their own, which breaks `callook.ts`'s
 * published promise — "the worst case a user can experience is this budget ONCE" — from a new
 * direction. Refusing costs the loser one press, tells them so, and charges them nothing.
 */

/**
 * The shortest hold this module will place, and therefore the answer when a 429 arrives with no
 * usable `Retry-After` at all.
 *
 * A minute, not the crawler's one-second per-host floor. That floor spaces a queue that is going to
 * make hundreds of requests anyway; this one has to be large enough that a person leaning on the
 * button cannot turn a refusal into a burst, and the number that decides it is the ration next
 * door: `api/callsign.ts` allows eight presses per ten minutes, so a sixty-second floor caps a
 * single user at eight requests spaced at least a minute apart, and the ration is what binds.
 * Anything second-scaled leaves the measured burst intact in all but name.
 *
 * The cost is borne by the person, not the source: a minute of "try again shortly" against a
 * four-field form they can fill in meanwhile. That is the right way round for a host that has just
 * asked to be left alone.
 */
export const COOLDOWN_FLOOR_MS = 60_000;

/**
 * The longest hold, and it exists to bound OUR silence rather than to disobey the source.
 *
 * `Retry-After` is a value a stranger's server chooses, and this ledger lives in memory with a
 * message attached that tells a user roughly how long to wait. An absurd value — a mis-set header,
 * a date parsed out of a badly-formatted string — would otherwise disable the feature for the life
 * of the process and print a wait measured in years at somebody trying to fill in a form. A day is
 * longer than any real instruction a service gives a client that asks it one question per button
 * press, so this cap never shortens a request anybody actually made; and if it ever did, the next
 * press earns another 429 and re-arms the hold, which is one extra request rather than a burst.
 */
export const COOLDOWN_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * What this process knows about one host between two presses: when it asked to be left alone, and
 * whether we are asking it something right now. Remembered for this process only.
 *
 * BOTH FACTS, ONE OBJECT, and that is not tidiness. They are read in the same breath — a press is
 * refused if EITHER is true — and a caller who wired up one and forgot the other would rebuild
 * exactly the defect the other was added to close. `CallsignLookupDeps` requires one thing, so
 * there is one line to leave out and it does not compile.
 */
export interface HostCooldown {
  /** How much of `key`'s hold is left at `nowMs`, or 0 when there is none. */
  remainingMs(key: string, nowMs: number): number;
  /** Hold `key` for `ms` from `nowMs`. Never shortens a hold that is already longer. */
  hold(key: string, ms: number, nowMs: number): void;
  /**
   * Is a request to `key` in flight right now?
   *
   * READ-ONLY, and it claims nothing — this is the question `wouldReachTheSource` asks on behalf of
   * the rate limiter next door, which needs to know whether a press will cost the source a request
   * without becoming that request itself.
   */
  isAsking(key: string): boolean;
  /**
   * Claim `key`'s one lane: the release when this press got it, `undefined` when a request to that
   * host is already in flight.
   *
   * CHECK AND CLAIM IN ONE CALL, deliberately. Two calls — ask, then take — is the shape of the
   * defect this closes, one level further down: nothing may be able to run between the reading and
   * the taking, and the only way to promise that of a function anybody can call is not to offer the
   * two halves separately. The release is idempotent, because a lane reopened by a second release
   * while its request is still running is a lane that is not one.
   */
  beginAsking(key: string): (() => void) | undefined;
}

/**
 * What a hold is remembered against: scheme, host and port, canonicalised.
 *
 * `canonicalOrigin` rather than a hand-written hostname, for the reason it exists — a trailing-dot
 * host has walked past four hand-written host checks in this repository already. The port is part
 * of the key because it is part of who is being asked to be left alone, and because two loopback
 * servers in a test are two sources rather than one.
 */
export function cooldownKey(url: string): string {
  return canonicalOrigin(new URL(url));
}

export function createHostCooldown(): HostCooldown {
  const until = new Map<string, number>();
  /**
   * The hosts we are mid-question with. A Set and not a counter: the whole rule is that the count
   * may not exceed one, and a counter is a thing that can be incremented.
   */
  const asking = new Set<string>();
  return {
    remainingMs(key, nowMs) {
      const at = until.get(key);
      if (at === undefined) return 0;
      // Dropped on read rather than swept: this map has one entry in production, and an expired
      // hold that lingers is a hold that could be re-read as live if a clock moved backwards.
      if (at <= nowMs) {
        until.delete(key);
        return 0;
      }
      return at - nowMs;
    },
    hold(key, ms, nowMs) {
      const at = nowMs + Math.max(0, ms);
      const existing = until.get(key);
      // A later press must not be able to shorten what an earlier answer promised. If two 429s
      // arrive and one asks for two minutes and the other for ten seconds, ten seconds is not the
      // answer: the longer instruction was still given and has not expired.
      if (existing === undefined || at > existing) until.set(key, at);
    },
    isAsking(key) {
      return asking.has(key);
    },
    beginAsking(key) {
      if (asking.has(key)) return undefined;
      asking.add(key);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        asking.delete(key);
      };
    },
  };
}

/**
 * `Retry-After` in milliseconds, or undefined when the header says nothing we can act on.
 *
 * RFC 9110 §10.2.3 gives two forms — `delta-seconds` (`1*DIGIT`) and an HTTP-date — and this
 * accepts exactly those. The digit form is matched as digits ONLY, so `-5` and `1.5` never become
 * a negative or fractional hold; `Number.parseInt` would have taken both. A date in the past yields
 * 0, which the floor then raises: a server that says "you could have retried a minute ago" has not
 * asked for anything, and has still answered 429.
 *
 * THE DAY-NAME GUARD IS NOT DECORATION, and it was added because the first version of this function
 * did not have it. All three date forms RFC 9110 §5.6.7 permits — IMF-fixdate, the obsolete RFC 850
 * form and asctime — begin with a day name, but `Date.parse` will read almost anything: measured on
 * node 20.19.43, `Date.parse('-5')` is `988693200000` (1 May 2001) and `Date.parse('1.5')` is
 * `978674400000` (5 January 2001). Those two happen to land in the past and reduce to zero, which
 * is harmless. A neighbouring shape need not: any garbage V8 chooses to read as a future date
 * would become a hold measured in years, placed by a header nobody wrote. Requiring the day name
 * first is what makes "we accept exactly the two documented forms" a description of the code.
 *
 * THE SECOND COPY OF THIS PARSE IN THE REPOSITORY, and that is a deliberate cost. `fetcher/index.ts`
 * has one, private to it, keyed off `Date.now()` directly. Sharing it would mean either exporting
 * from the fetcher into a module whose entire design is "this is not the fetcher and must not
 * become it", or moving it out and editing the crawler's back-off path to suit a user-facing
 * lookup — a change to the one part of this software that is running against ~25 real sites
 * tonight. Two readings of one header is a smaller risk than that, they are checked against the
 * same RFC, and this one is stricter. It takes its clock as an argument so a test can pin a date
 * header without pinning the machine.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const raw = header.trim();
  if (raw === '') return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number.parseInt(raw, 10);
    // `Retry-After: 99999999999999999999` is not an instruction, it is a broken header.
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  if (!/^(?:mon|tue|wed|thu|fri|sat|sun)/i.test(raw)) return undefined;
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return undefined;
  return Math.max(0, when - nowMs);
}

/** What this module will actually hold for, given what a source asked for. */
export function clampCooldownMs(ms: number): number {
  return Math.min(COOLDOWN_CAP_MS, Math.max(COOLDOWN_FLOOR_MS, Math.round(ms)));
}

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * "about 2 minutes" — a wait a person can act on, not a millisecond count.
 *
 * Rounded UP at every boundary, because the number is attached to "try again in…" and a message
 * that sends somebody back a second early sends them back to the same message.
 */
export function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds <= 45) return `about ${plural(seconds, 'second')}`;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes <= 90) return `about ${plural(minutes, 'minute')}`;
  return `about ${plural(Math.max(1, Math.ceil(minutes / 60)), 'hour')}`;
}
