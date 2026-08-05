export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * A QUEUE FOR THE EXPENSIVE WORK, WHICH IS A DIFFERENT THING FROM A BUDGET FOR IT.
 *
 * A failure counter and a concurrency gate ration two quantities that this file kept confusing,
 * and the confusion had a measured cost. `RateLimitAttempt` below was introduced to stop a burst
 * of wrong codes starting an unbounded number of argon2id hashes, and it does — but it did it by
 * charging SUCCESSFUL enrolments against the same ten-per-window budget as wrong guesses.
 * MEASURED on 2026-08-05, thirty students with a valid thirty-use code pressing submit together:
 * 10 accounts created, 20 answered "Too many enrollment attempts. Try again later." A limit that
 * refuses the work it exists to protect is not a trade-off, it is a defect.
 *
 * The two quantities, said plainly:
 *   - HOW MANY GUESSES an anonymous caller may make at a credential. Per window, per caller, and
 *     refusing is the right answer past it, because there is nothing legitimate left to serve.
 *   - HOW MUCH WORK may be in flight at once. Never refused — QUEUED. Thirty people enrolling at
 *     once is the intended use of this product, and the honest answer to "thirty argon2id hashes
 *     arrived together" is "they will be done in a moment", not "ten of you may proceed".
 *
 * This is the second. It bounds peak concurrent hashes and therefore peak memory (argon2id is
 * 19 MiB a time here), and it bounds nothing else: every caller admitted to the queue is served.
 */
export interface ConcurrencyGate {
  /** Run `work` once a slot is free. Resolves or rejects with whatever `work` did. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Running right now. Exported so a test can assert the ceiling rather than assume it. */
  readonly inFlight: number;
  /** Admitted to the queue and not yet started. Never refused, so this only ever drains. */
  readonly waiting: number;
}

/**
 * FIFO, and first-come-first-served is the point: a queue that reorders is a queue in which the
 * unlucky caller waits forever, which is a lockout wearing a different word.
 */
export function createConcurrencyGate(maxConcurrent: number): ConcurrencyGate {
  if (maxConcurrent < 1) throw new RangeError('maxConcurrent must be at least 1');
  const waiters: Array<() => void> = [];
  let running = 0;

  function release(): void {
    const next = waiters.shift();
    // The slot is handed STRAIGHT to the next waiter rather than decremented and re-claimed by
    // whoever wakes first: dropping to `running - 1` in between is the window in which a request
    // arriving at that instant walks past a full gate, which is the same check-then-act defect
    // this whole module exists to close, one level down.
    if (next === undefined) running -= 1;
    else next();
  }

  return {
    get inFlight() {
      return running;
    },
    get waiting() {
      return waiters.length;
    },
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (running < maxConcurrent) running += 1;
      else await new Promise<void>((resolve) => waiters.push(resolve));
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

/**
 * A limiter key reduced to something an administrator can read in an audit trail without it
 * becoming a record of where one named person was sitting.
 *
 * An IPv4 address is cut to its /24 and an IPv6 address to its /48, which is roughly "this
 * building" or "this ISP customer" and is what an operator actually acts on — block it, ask the
 * campus network office about it, or recognise their own NAT. The host part is dropped because an
 * audit row outlives the incident and is read by more people than the incident.
 *
 * Anything that is not an address — the empty string, a UNIX socket, a value express could not
 * parse — comes back as `unknown` rather than being written down verbatim.
 */
export function coarseOrigin(raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'unknown';
  // `::ffff:203.0.113.7` is how a v4 client reaches a dual-stack listener; it is a v4 address and
  // is coarsened as one, or every deployment behind a v6 socket would log a different shape.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  const address = mapped === null ? raw : mapped[1];

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(address);
  if (v4 !== null) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;

  if (address.includes(':')) {
    const groups = address.split(':');
    if (groups.length >= 3 && groups.slice(0, 3).every((g) => /^[0-9a-f]{0,4}$/i.test(g))) {
      return `${groups.slice(0, 3).join(':')}::/48`;
    }
  }
  return 'unknown';
}

/**
 * A slot held in the budget for the duration of work whose outcome is not known yet, and the two
 * ways it can end.
 *
 * WHY THIS EXISTS AT ALL. `check` then `recordFailure` is only a limit when nothing can run between
 * them. The moment an `await` sits in the gap — and on both auth routes the thing in the gap is an
 * argon2id hash, the single most expensive operation this server performs — every request that
 * arrives before the first hashes finish reads a counter that none of them have paid into yet, and
 * all of them pass. Measured on `POST /api/auth/enroll` on 2026-08-05: 240 concurrent wrong-code
 * requests against a budget of ten produced 240 argon2id hashes and 10.2 s of CPU.
 *
 * This project has now shipped that same shape three times: the callsign lookup (eight concurrent
 * presses through a limit meant to allow one), the enrollment redemption (six accounts from a
 * one-use code), and here. The two earlier fixes both took the same form — claim the thing before
 * the expensive work starts, release it after (`HostCooldown.beginAsking`; the WHERE-guarded
 * `UPDATE` inside `redeem`'s transaction) — and this is that form for a rate limiter.
 */
export type RateLimitAttempt =
  | {
      started: true;
      /**
       * This attempt turned out to be a failure: convert the held slot into a recorded one.
       * Idempotent, and `release` afterwards is a no-op — an attempt settles exactly once.
       */
      charge: (nowMs?: number) => void;
      /**
       * Let the slot go without recording anything. Safe to call unconditionally in a `finally`,
       * which is the point: a handler that throws must not leak a slot for the life of the process.
       */
      release: () => void;
    }
  | { started: false; retryAfterSec: number };

export interface RateLimiter {
  check(key: string, nowMs?: number): RateLimitDecision;
  /**
   * Take a slot BEFORE doing work that will decide whether this attempt is a failure.
   *
   * CHECK AND CLAIM IN ONE CALL, deliberately, for the reason `HostCooldown.beginAsking` gives one
   * level further down: two calls — ask, then take — is the very defect this closes, and the only
   * way to promise nothing interleaves between the reading and the taking is not to offer the two
   * halves separately.
   */
  begin(key: string, nowMs?: number): RateLimitAttempt;
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
  /**
   * Attempts that have started and not yet settled, per key. They occupy the SAME budget as
   * recorded failures because they are the same thing seen earlier: an attempt that is still
   * running is one whose failure has not been written down yet, and a limiter that only counts the
   * written-down ones is a limiter that a burst walks straight past.
   */
  const inFlight = new Map<string, number>();

  function recent(key: string, nowMs: number): number[] {
    const kept = (failures.get(key) ?? []).filter((at) => nowMs - at < options.windowMs);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  }

  function release(key: string): void {
    const held = inFlight.get(key) ?? 0;
    if (held <= 1) inFlight.delete(key);
    else inFlight.set(key, held - 1);
  }

  function decide(key: string, nowMs: number): RateLimitDecision {
    const hits = recent(key, nowMs);
    if (hits.length + (inFlight.get(key) ?? 0) < options.maxFailures) {
      return { allowed: true, retryAfterSec: 0 };
    }
    const oldest = hits[0];
    // Nothing recorded, so the budget is spent entirely by attempts still running: the wait is one
    // argon2id hash, not one window. Answering ~900 seconds to somebody who is behind a queue that
    // drains in milliseconds would be a worse lie than no number at all.
    if (oldest === undefined) return { allowed: false, retryAfterSec: 1 };
    const retryAfterMs = options.windowMs - (nowMs - oldest);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  return {
    check(key, nowMs = Date.now()) {
      return decide(key, nowMs);
    },

    begin(key, nowMs = Date.now()) {
      const decision = decide(key, nowMs);
      if (!decision.allowed) return { started: false, retryAfterSec: decision.retryAfterSec };
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);

      let settled = false;
      return {
        started: true,
        charge(at = Date.now()) {
          if (settled) return;
          settled = true;
          release(key);
          const hits = recent(key, at);
          hits.push(at);
          failures.set(key, hits);
        },
        release() {
          if (settled) return;
          settled = true;
          release(key);
        },
      };
    },

    recordFailure(key, nowMs = Date.now()) {
      const hits = recent(key, nowMs);
      hits.push(nowMs);
      failures.set(key, hits);
    },

    /**
     * Forget the RECORDED failures for `key`. In-flight attempts are deliberately left alone: they
     * belong to requests that are still running and will release their own slots, and dropping them
     * here would let those releases decrement a counter that had already been cleared.
     */
    reset(key) {
      failures.delete(key);
    },
  };
}
