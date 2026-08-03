const FIELD_MAX = [59, 23, 31, 12, 6];
const DEFAULT_JITTER_MS = 45 * 60 * 1000;

function fieldMatches(field: string, value: number, max: number): boolean {
  for (const part of field.split(',')) {
    if (part === '*') return true;
    const step = /^(\*|\d+-\d+)\/(\d+)$/.exec(part);
    if (step) {
      const n = Number.parseInt(step[2], 10);
      if (n <= 0) continue;
      if (step[1] === '*') {
        if (value % n === 0) return true;
        continue;
      }
      const [lo, hi] = step[1].split('-').map((s) => Number.parseInt(s, 10));
      if (value >= lo && value <= hi && (value - lo) % n === 0) return true;
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const lo = Number.parseInt(range[1], 10);
      const hi = Number.parseInt(range[2], 10);
      if (value >= lo && value <= Math.min(hi, max)) return true;
      continue;
    }
    if (/^\d+$/.test(part) && Number.parseInt(part, 10) === value) return true;
  }
  return false;
}

// Supports `*`, `N`, `a,b`, `a-b` and a step of the form asterisk-slash-N in all five fields.
// UTC. (A `/** */` block comment cannot spell that step syntax literally: the slash-asterisk
// pair would close the comment early and corrupt everything parsed after it.)
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression must have five fields: "${expr}"`);
  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];
  return fields.every((field, i) => fieldMatches(field, values[i], FIELD_MAX[i]));
}

/** Walks forward minute by minute, bounded at 366 days. Always strictly after `from`. */
export function nextCronTime(expr: string, from: Date): Date {
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    if (cronMatches(expr, cursor)) return cursor;
  }
  throw new Error(`cron expression "${expr}" never matches within 366 days`);
}

/**
 * Uniform 0..45 minutes. ~25 small nonprofit sites should not all be hit at 03:17:00 sharp by
 * every deployment of this app.
 */
export function jitterMs(rand: () => number, maxMs: number = DEFAULT_JITTER_MS): number {
  return Math.round(rand() * maxMs);
}

export interface SchedulerOptions {
  cron: string;
  enabled: boolean;
  rand?: () => number;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function startScheduler(
  opts: SchedulerOptions,
  run: () => Promise<unknown>,
): { stop(): void; nextRunAt(): Date | undefined } {
  const now = opts.now ?? (() => new Date());
  const rand = opts.rand ?? Math.random;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  let handle: unknown;
  let scheduled: Date | undefined;
  let stopped = !opts.enabled;

  function schedule(): void {
    if (stopped) return;
    scheduled = nextCronTime(opts.cron, now());
    const delay = Math.max(0, scheduled.getTime() - now().getTime()) + jitterMs(rand);
    handle = setTimer(() => {
      void run()
        .catch(() => undefined)
        .finally(() => schedule());
    }, delay);
  }

  if (opts.enabled) schedule();

  return {
    stop(): void {
      stopped = true;
      if (handle !== undefined) clearTimer(handle);
    },
    nextRunAt: () => (opts.enabled ? scheduled : undefined),
  };
}
