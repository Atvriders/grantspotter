export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string, nowMs?: number): RateLimitDecision;
  recordFailure(key: string, nowMs?: number): void;
  reset(key: string): void;
}

export interface RateLimiterOptions {
  windowMs: number;
  maxFailures: number;
}

/**
 * In-memory sliding-window failure counter. Single-process by design: this app
 * runs as one Node process (spec §3), so a shared store would be ceremony.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const failures = new Map<string, number[]>();

  function recent(key: string, nowMs: number): number[] {
    const kept = (failures.get(key) ?? []).filter((at) => nowMs - at < options.windowMs);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  }

  return {
    check(key, nowMs = Date.now()) {
      const hits = recent(key, nowMs);
      if (hits.length < options.maxFailures) return { allowed: true, retryAfterSec: 0 };
      const oldest = hits[0];
      const retryAfterMs = options.windowMs - (nowMs - oldest);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    },
    recordFailure(key, nowMs = Date.now()) {
      const hits = recent(key, nowMs);
      hits.push(nowMs);
      failures.set(key, hits);
    },
    reset(key) {
      failures.delete(key);
    },
  };
}
