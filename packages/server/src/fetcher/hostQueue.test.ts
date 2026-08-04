import { describe, expect, it } from 'vitest';
import { HostQueue } from './hostQueue.js';

/** Deterministic virtual clock: sleep() advances the clock instead of waiting. */
function virtualClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    get slept() {
      return slept;
    },
  };
}

describe('HostQueue', () => {
  it('serialises two requests to the same host — never overlapping', async () => {
    const clock = virtualClock();
    const q = new HostQueue({ defaultMinIntervalMs: 0, now: clock.now, sleep: clock.sleep });
    const events: string[] = [];

    const a = q.run('arrl.org', async () => {
      events.push('a:start');
      await Promise.resolve();
      events.push('a:end');
      return 1;
    });
    const b = q.run('arrl.org', async () => {
      events.push('b:start');
      events.push('b:end');
      return 2;
    });

    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('lets different hosts overlap', async () => {
    const clock = virtualClock();
    const q = new HostQueue({ defaultMinIntervalMs: 0, now: clock.now, sleep: clock.sleep });
    const events: string[] = [];
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseA = res;
    });

    const a = q.run('arrl.org', async () => {
      events.push('a:start');
      await gate;
      events.push('a:end');
    });
    const b = q.run('ardc.net', async () => {
      events.push('b:start');
      events.push('b:end');
    });

    await b;
    releaseA();
    await a;
    expect(events).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('waits Crawl-delay: 5 between two arrl.org requests', async () => {
    const clock = virtualClock();
    const q = new HostQueue({ defaultMinIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    q.setMinInterval('arrl.org', 5000);
    expect(q.minIntervalFor('arrl.org')).toBe(5000);

    await q.run('arrl.org', async () => 'first');
    await q.run('arrl.org', async () => 'second');

    expect(clock.slept).toEqual([5000]);
  });

  it('never applies a smaller interval than the default', async () => {
    const q = new HostQueue({ defaultMinIntervalMs: 1000 });
    q.setMinInterval('example.test', 10);
    expect(q.minIntervalFor('example.test')).toBe(1000);
  });

  it('does not double-wait when real time already elapsed', async () => {
    const clock = virtualClock();
    const q = new HostQueue({ defaultMinIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await q.run('example.test', async () => 1);
    clock.advance(5000);
    await q.run('example.test', async () => 2);
    expect(clock.slept).toEqual([]);
  });

  it('keeps draining the queue after a task throws', async () => {
    const q = new HostQueue({ defaultMinIntervalMs: 0 });
    const failed = q.run('example.test', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');
    await expect(q.run('example.test', async () => 'ok')).resolves.toBe('ok');
  });

  /**
   * PACING DEFECT 3: A `Crawl-delay` WAS ONE REQUEST LATE.
   *
   * `Crawl-delay` is parsed out of a `/robots.txt` RESPONSE, so `setMinInterval` cannot possibly be
   * called before the request that read the file has finished. The old `finally` stamped a
   * `nextAllowedAt` deadline at that moment, using the interval in force at that moment — the
   * default — so the delay a site had just asked for governed the SECOND page and not the first.
   * Measured before the fix with the real fetcher against a loopback server publishing
   * `Crawl-delay: 5`: the first page landed 1002 ms after `/robots.txt`, not 5000.
   */
  it('applies an interval raised AFTER the previous request to the very next one', async () => {
    const clock = virtualClock();
    const q = new HostQueue({ defaultMinIntervalMs: 1000, now: clock.now, sleep: clock.sleep });

    // The robots.txt read: nothing is known about this host yet, so it runs at the default floor.
    await q.run('arrl.org', async () => 'robots.txt');
    // …and only now, having read the file, do we learn what it asked for.
    q.setMinInterval('arrl.org', 5000);
    await q.run('arrl.org', async () => 'the first page governed by it');

    expect(clock.slept).toEqual([5000]);
  });

  describe('defer composes with the interval floor instead of replacing it', () => {
    it('still charges the floor when a server asks for zero', async () => {
      const clock = virtualClock();
      const q = new HostQueue({ defaultMinIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      await q.run('example.test', async () => 1);
      // `Retry-After: 0` — "you may retry immediately" is the SERVER's constraint, not ours.
      q.defer('example.test', 0);
      await q.run('example.test', async () => 2);
      expect(clock.slept).toEqual([1000]);
    });

    it('waits the full Retry-After when it exceeds the floor, and not floor + Retry-After', async () => {
      const clock = virtualClock();
      const q = new HostQueue({ defaultMinIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      await q.run('example.test', async () => 1);
      q.defer('example.test', 30_000);
      await q.run('example.test', async () => 2);
      // MAX, not SUM: 30000 rather than 31000.
      expect(clock.slept).toEqual([30_000]);
    });

    it('never lowers a deferral that is already further out', async () => {
      const clock = virtualClock();
      const q = new HostQueue({ defaultMinIntervalMs: 0, now: clock.now, sleep: clock.sleep });
      await q.run('example.test', async () => 1);
      q.defer('example.test', 30_000);
      q.defer('example.test', 5_000); // a second, milder penalty must not release the lane early
      await q.run('example.test', async () => 2);
      expect(clock.slept).toEqual([30_000]);
    });

    it('applies to whatever runs next on that host, not to the request that earned it', async () => {
      // A 429 is the server asking us to stop asking. The next request to that host is exactly
      // what it was asking about, even when it belongs to a different page.
      const clock = virtualClock();
      const q = new HostQueue({ defaultMinIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
      await q.run('example.test', async () => 'the page that got the 429');
      q.defer('example.test', 30_000);
      await q.run('example.test', async () => 'an unrelated page on the same host');
      expect(clock.slept).toEqual([30_000]);
    });
  });
});
