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
 */
export class HostQueue {
  private readonly defaultMinIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly intervals = new Map<string, number>();
  private readonly nextAllowedAt = new Map<string, number>();

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

  run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    const task = previous.then(async () => {
      const waitMs = (this.nextAllowedAt.get(host) ?? 0) - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      try {
        return await fn();
      } finally {
        this.nextAllowedAt.set(host, this.now() + this.minIntervalFor(host));
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
