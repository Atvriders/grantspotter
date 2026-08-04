export interface HostQueueOptions {
  /** Floor for every host. A per-host Crawl-delay may raise this, never lower it. */
  defaultMinIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * One serial lane per host. Requests to the same host are chained end-to-end and separated by
 * at least minIntervalFor(host). Requests to different hosts run concurrently.
 *
 * WHAT A "REQUEST" MEANS HERE, because getting that wrong is what four separate pacing defects
 * turned out to be. One `run` call is ONE HTTP REQUEST ON THE WIRE — not one logical fetch. The
 * fetcher used to wrap its whole retry loop in a single slot, so every retry and every redirect hop
 * inside that slot went straight to the network with no gate at all. `fetcher/index.ts` now enters
 * this queue once per attempt; this class is only correct if callers keep that true.
 */
export class HostQueue {
  private readonly defaultMinIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly intervals = new Map<string, number>();
  /**
   * When the last request on this lane FINISHED — a timestamp, not a deadline.
   *
   * THIS USED TO BE `nextAllowedAt`, a deadline stamped in `run`'s `finally` as
   * `now() + minIntervalFor(host)`, and the difference is the whole of pacing defect 3. A
   * `Crawl-delay` is parsed out of a `/robots.txt` RESPONSE, so `setMinInterval` is necessarily
   * called after that response has been read — which is after the slot that fetched it has already
   * stamped its deadline using the OLD interval. The first page fetched after reading a robots.txt
   * therefore ignored the delay that very file asked for; a host publishing `Crawl-delay: 5` was
   * measured (real fetcher, loopback server) letting the first page through 1003 ms after
   * `/robots.txt` instead of 5000.
   *
   * Storing when the last request ended and reading `minIntervalFor` at RELEASE time instead makes
   * the interval in force the one that is current when the decision is actually taken, which is the
   * only moment at which the question "how long must this host wait" has a correct answer.
   */
  private readonly lastFinishedAt = new Map<string, number>();
  /**
   * An absolute "not before" instant for this lane, raised by {@link defer} and never lowered.
   *
   * Kept separate from the interval floor so that the two COMPOSE rather than replace each other:
   * a server that answers `Retry-After: 0` has asked for nothing on top of our own floor and still
   * gets the floor, and a server that asks for 30 s gets 30 s even though the floor is 1 s.
   */
  private readonly notBefore = new Map<string, number>();

  constructor(opts: HostQueueOptions) {
    this.defaultMinIntervalMs = opts.defaultMinIntervalMs;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? realSleep;
  }

  setMinInterval(host: string, ms: number): void {
    this.intervals.set(host, ms);
  }

  minIntervalFor(host: string): number {
    return Math.max(this.defaultMinIntervalMs, this.intervals.get(host) ?? 0);
  }

  /**
   * Hold this host's lane for at least `ms` from now — a server's `Retry-After`, or our own
   * exponential backoff, expressed as a property of the HOST rather than of one in-flight retry.
   *
   * WHY THE PENALTY LIVES HERE AND NOT IN A `sleep` INSIDE THE RETRY LOOP. A sleep between attempts
   * is invisible to every other request queued against the same host: with the loop outside the
   * gate (which is what fixes pacing defects 1, 2 and 4) a plain sleep would space the retry and
   * nothing else, and a second page waiting behind it would fire the instant the sleep ended. It is
   * also the wrong unit — a 429 is the server saying "stop asking", not "stop asking for this URL".
   *
   * MAX, NOT SUM, and never a replacement. `releaseAt` takes the larger of this instant and the
   * interval floor, so `Retry-After: 0` still costs the full per-host interval and `Retry-After: 30`
   * costs thirty seconds rather than thirty-one. Raising only ever moves the instant later, so two
   * concurrent penalties on one host cannot cancel each other out.
   *
   * Call this from INSIDE the slot that observed the response. The lane is still held there, so
   * nothing can be released between reading the header and recording it; calling it after
   * `run` resolves would depend on microtask ordering to beat the next task out of the gate.
   */
  defer(host: string, ms: number): void {
    const at = this.now() + Math.max(0, ms);
    this.notBefore.set(host, Math.max(this.notBefore.get(host) ?? 0, at));
  }

  /**
   * The earliest instant the next request to this host may leave.
   *
   * A host with no completed request has no floor to compute from — the first request to a site
   * goes immediately, and only the gap between requests is paced.
   */
  private releaseAt(host: string): number {
    const last = this.lastFinishedAt.get(host);
    const floorAt = last === undefined ? 0 : last + this.minIntervalFor(host);
    return Math.max(floorAt, this.notBefore.get(host) ?? 0);
  }

  run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    const task = previous.then(async () => {
      // Re-checked after sleeping rather than waited once, because `setTimeout(n)` is a floor on
      // the event loop's clock and not on `Date.now()`: a timer that returns a millisecond early
      // would produce a gap a millisecond under the interval this project advertises. The loop
      // stops the moment a sleep fails to advance the clock, so the injected non-advancing clocks
      // several tests use cannot spin here.
      for (;;) {
        const waitMs = this.releaseAt(host) - this.now();
        if (waitMs <= 0) break;
        const before = this.now();
        await this.sleep(waitMs);
        if (this.now() <= before) break;
      }
      try {
        return await fn();
      } finally {
        this.lastFinishedAt.set(host, this.now());
      }
    });
    // Swallow rejection on the tail only, so one failure does not poison the lane.
    this.tails.set(
      host,
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
    return task;
  }
}
