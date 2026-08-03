import { describe, expect, it, vi } from 'vitest';
import { cronMatches, jitterMs, nextCronTime, startScheduler } from './scheduler.js';

const at = (iso: string) => new Date(iso);

describe('cronMatches', () => {
  it('matches the default nightly 17 3 * * *', () => {
    expect(cronMatches('17 3 * * *', at('2026-08-02T03:17:00Z'))).toBe(true);
    expect(cronMatches('17 3 * * *', at('2026-08-02T03:18:00Z'))).toBe(false);
    expect(cronMatches('17 3 * * *', at('2026-08-02T04:17:00Z'))).toBe(false);
  });

  it('matches a wildcard minute', () => {
    expect(cronMatches('* 3 * * *', at('2026-08-02T03:59:00Z'))).toBe(true);
  });

  it('matches a list and a range', () => {
    expect(cronMatches('0 1,3,5 * * *', at('2026-08-02T03:00:00Z'))).toBe(true);
    expect(cronMatches('0 1,3,5 * * *', at('2026-08-02T02:00:00Z'))).toBe(false);
    expect(cronMatches('0 1-5 * * *', at('2026-08-02T04:00:00Z'))).toBe(true);
  });

  it('matches a step', () => {
    expect(cronMatches('*/15 * * * *', at('2026-08-02T03:30:00Z'))).toBe(true);
    expect(cronMatches('*/15 * * * *', at('2026-08-02T03:31:00Z'))).toBe(false);
  });

  it('matches day-of-week', () => {
    expect(cronMatches('0 0 * * 0', at('2026-08-02T00:00:00Z'))).toBe(true); // a Sunday
    expect(cronMatches('0 0 * * 1', at('2026-08-02T00:00:00Z'))).toBe(false);
  });

  it('rejects a malformed expression', () => {
    expect(() => cronMatches('17 3 * *', at('2026-08-02T03:17:00Z'))).toThrow(/five fields/i);
  });
});

describe('nextCronTime', () => {
  it('finds tonight’s run when it has not happened yet', () => {
    expect(nextCronTime('17 3 * * *', at('2026-08-02T01:00:00Z')).toISOString()).toBe(
      '2026-08-02T03:17:00.000Z',
    );
  });

  it('rolls to tomorrow when tonight’s run has passed', () => {
    expect(nextCronTime('17 3 * * *', at('2026-08-02T05:00:00Z')).toISOString()).toBe(
      '2026-08-03T03:17:00.000Z',
    );
  });

  it('never returns the current minute — it always advances', () => {
    const from = at('2026-08-02T03:17:00Z');
    expect(nextCronTime('17 3 * * *', from).getTime()).toBeGreaterThan(from.getTime());
  });
});

describe('jitterMs', () => {
  it('spreads uniformly across the window', () => {
    expect(jitterMs(() => 0)).toBe(0);
    expect(jitterMs(() => 1)).toBe(45 * 60 * 1000);
    expect(jitterMs(() => 0.5)).toBe(45 * 60 * 1000 * 0.5);
  });

  it('honours a custom window', () => {
    expect(jitterMs(() => 1, 60_000)).toBe(60_000);
  });
});

describe('startScheduler', () => {
  it('starts nothing when CRAWL_ENABLED is false', () => {
    const setTimer = vi.fn();
    const handle = startScheduler(
      { cron: '17 3 * * *', enabled: false, setTimer, now: () => at('2026-08-02T01:00:00Z') },
      async () => undefined,
    );
    expect(setTimer).not.toHaveBeenCalled();
    expect(handle.nextRunAt()).toBeUndefined();
  });

  it('schedules the next cron time plus jitter', () => {
    const setTimer = vi.fn();
    const handle = startScheduler(
      {
        cron: '17 3 * * *',
        enabled: true,
        rand: () => 0.5,
        now: () => at('2026-08-02T03:00:00Z'),
        setTimer,
      },
      async () => undefined,
    );
    expect(setTimer).toHaveBeenCalledTimes(1);
    const delay = setTimer.mock.calls[0][1] as number;
    // 17 minutes to the cron minute, plus half of the 45-minute jitter window.
    expect(delay).toBe(17 * 60 * 1000 + 45 * 60 * 1000 * 0.5);
    expect(handle.nextRunAt()?.toISOString()).toBe('2026-08-02T03:17:00.000Z');
  });

  it('runs the job when the timer fires and reschedules afterwards', async () => {
    let fire: (() => void) | undefined;
    const setTimer = vi.fn((fn: () => void) => {
      fire = fn;
      return 1;
    });
    const run = vi.fn(async () => undefined);
    let now = at('2026-08-02T03:00:00Z');
    startScheduler(
      { cron: '17 3 * * *', enabled: true, rand: () => 0, now: () => now, setTimer },
      run,
    );
    now = at('2026-08-02T03:17:00Z');
    fire?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // The reschedule happens in a `.finally()` chained off `run()`'s promise, i.e. on a LATER
    // microtask than the one that satisfies the `run` assertion above — so this needs its own
    // wait rather than a synchronous check right after, or it is a coin flip depending on how
    // many microtask hops vi.waitFor's own polling takes relative to `.catch().finally()`.
    await vi.waitFor(() => expect(setTimer).toHaveBeenCalledTimes(2));
  });

  it('reschedules even when the job throws', async () => {
    let fire: (() => void) | undefined;
    const setTimer = vi.fn((fn: () => void) => {
      fire = fn;
      return 1;
    });
    startScheduler(
      { cron: '17 3 * * *', enabled: true, rand: () => 0, now: () => at('2026-08-02T03:00:00Z'), setTimer },
      async () => {
        throw new Error('crawl blew up');
      },
    );
    fire?.();
    await vi.waitFor(() => expect(setTimer).toHaveBeenCalledTimes(2));
  });

  it('stop() clears the pending timer', () => {
    const clearTimer = vi.fn();
    const handle = startScheduler(
      {
        cron: '17 3 * * *',
        enabled: true,
        now: () => at('2026-08-02T03:00:00Z'),
        setTimer: () => 42,
        clearTimer,
      },
      async () => undefined,
    );
    handle.stop();
    expect(clearTimer).toHaveBeenCalledWith(42);
  });
});
