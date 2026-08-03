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
});
