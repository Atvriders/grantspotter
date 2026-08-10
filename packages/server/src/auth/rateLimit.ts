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
 *   - HOW MUCH WORK may be in flight at once. Thirty people enrolling at once is the intended use
 *     of this product, and the honest answer to "thirty argon2id hashes arrived together" is "they
 *     will be done in a moment", not "ten of you may proceed".
 *
 * This is the second, and it turned out to need a THIRD quantity that neither of those two names:
 * WHOSE TURN IT IS.
 *
 * WHAT THE FIRST VERSION OF THIS GATE DID. Unbounded FIFO — every arrival joined the back and
 * nobody was ever refused. MEASURED on this host, 2026-08-09, against a real listening server in
 * its own process: a stranger with no code and no account opening 512 connections and POSTing
 * `/api/auth/login` with a FRESH EMAIL each time — which the `(peer, email)` sign-in counter can
 * never fire on — drove one student's enrolment from 55 ms to 5,036 ms, ninety times baseline,
 * while 2,244 unauthenticated requests produced ZERO rows in `audit_log`.
 *
 * THE FIGURE THAT MAKES IT A DENIAL OF SERVICE RATHER THAN A SLOW AFTERNOON is not its size but
 * what sets it: the student's wait rose in step with the attacker's connection count — 24
 * connections 243 ms, 96 → 967 ms, 256 → 2,507 ms, 512 → 4,881 ms. A queue with no bound does not
 * protect anything; it hands the caller a dial marked "everybody else's latency", and past the
 * point where the wait exceeds the caller's patience every one of those hashes is CPU spent on
 * somebody who has already gone.
 *
 * TWO THINGS WERE WRONG AND ONLY ONE OF THEM WAS THE DEPTH.
 *
 * FIRST, FIFO IS FAIR BETWEEN REQUESTS AND SAYS NOTHING ABOUT CALLERS. One caller holding 512 of
 * the 513 places is being treated exactly as fairly as 513 callers holding one each, which is the
 * whole defect in one sentence. Rationing means telling callers apart, so this queue is now
 * ROUND-ROBIN BETWEEN LANES and FIFO WITHIN A LANE. Nobody starves — every lane is served every
 * round, which is the property the old comment here was reaching for and got by accident — and a
 * caller's share is now 1/n of the service however many requests they send, instead of all of it.
 *
 * SECOND, THE QUEUE HAD NO CEILING, so the wait was whatever the attacker chose and the memory was
 * whatever the attacker chose. Work whose caller has already given up is CPU spent on nobody, and
 * a queue deeper than the caller's patience produces exactly that. So there is a ceiling now, and
 * past it the gate SHEDS.
 *
 * WHO IS SHED, AND WHY THIS IS NOT A BUDGET. The request dropped is the newest one belonging to
 * whoever holds the LARGEST SHARE of the queue — never "the newest arrival" as such. There is no
 * per-caller number to exhaust and nothing anybody can spend on anybody else's behalf: a caller
 * flooding the queue can only ever displace themselves, and a caller with one request in a queue
 * full of somebody else's is never the one dropped. That is what makes it safe to key on a value
 * the caller partly controls — the worst a forged key achieves is that the queue behaves the way
 * it did before, first-come-first-served with a bound, rather than becoming an off switch.
 */
export interface QueueLane {
  /**
   * The TCP peer. No header changes it and no client chooses it — and behind a reverse proxy it is
   * one value for every user in the deployment, which is why it is not enough on its own.
   */
  readonly peer: string;
  /**
   * The address the deployment's own proxy reported (`req.ip`). Behind the documented single hop
   * that is the real client and it is what tells two users of one tunnel apart; with nothing in
   * front of this process the caller writes it themselves and can mint as many as they like.
   *
   * The two fail in opposite deployment shapes, which is why the round is nested rather than
   * keyed on a concatenation of them: peers take turns first, so a caller minting a thousand
   * origins still gets one peer's share; origins take turns inside a peer, so a thousand students
   * behind one tunnel are a thousand lanes rather than one.
   */
  readonly origin: string;
}

/**
 * The gate is full and this caller was holding the largest part of it. Distinct from anything
 * `work` can throw so a route can answer it differently — and thrown BEFORE `work` starts, so a
 * shed request costs this process no argon2id and the caller no credential.
 */
export class QueueFullError extends Error {
  constructor() {
    super('the hash queue is full');
    this.name = 'QueueFullError';
  }
}

export interface ConcurrencyGate {
  /**
   * Run `work` when this lane's turn comes. Resolves or rejects with whatever `work` did, or
   * rejects with `QueueFullError` without running it at all.
   */
  run<T>(lane: QueueLane, work: () => Promise<T>): Promise<T>;
  /** Running right now. Exported so a test can assert the ceiling rather than assume it. */
  readonly inFlight: number;
  /** Queued and not yet started, across every lane. */
  readonly waiting: number;
  /** Requests shed since this process started, so an operator-facing counter has a number. */
  readonly shed: number;
}

export interface ConcurrencyGateOptions {
  /** How many `work` bodies may run at once. */
  maxConcurrent: number;
  /** How many may be waiting at once, across every lane, before the gate starts shedding. */
  maxQueued: number;
}

interface Waiter {
  /** Arrival order, monotonic. Used only to break ties toward the most recent arrival. */
  readonly seq: number;
  readonly lane: QueueLane;
  readonly admit: () => void;
  readonly refuse: (err: Error) => void;
}

export function createConcurrencyGate(options: ConcurrencyGateOptions): ConcurrencyGate {
  if (options.maxConcurrent < 1) throw new RangeError('maxConcurrent must be at least 1');
  if (options.maxQueued < 1) throw new RangeError('maxQueued must be at least 1');

  /**
   * peer -> origin -> the requests waiting in that lane, oldest first.
   *
   * Insertion order IS the round: the group that was just served is deleted and re-inserted, which
   * puts it at the back. That is the whole round-robin implementation, and it means an idle lane
   * costs nothing — a lane exists only while it has somebody in it.
   */
  const lanes = new Map<string, Map<string, Waiter[]>>();
  let queued = 0;
  let running = 0;
  let shedCount = 0;
  let nextSeq = 0;

  /** Move a group to the back of its round, or drop it when it is empty. */
  function rotate<V>(round: Map<string, V>, key: string, group: V, empty: boolean): void {
    round.delete(key);
    if (!empty) round.set(key, group);
  }

  function takeNext(): Waiter | undefined {
    for (const [peerKey, origins] of lanes) {
      for (const [originKey, queue] of origins) {
        const waiter = queue.shift();
        if (waiter === undefined) {
          // Unreachable while the invariant below holds (an empty group is always deleted, both
          // here and in `remove`). Deleting rather than skipping keeps it unreachable for good.
          origins.delete(originKey);
          continue;
        }
        queued -= 1;
        rotate(origins, originKey, queue, queue.length === 0);
        rotate(lanes, peerKey, origins, origins.size === 0);
        return waiter;
      }
    }
    return undefined;
  }

  /**
   * The newest request of the largest origin-group of the largest peer-group — the one whose
   * caller has the most to lose and whose absence frees the most room for everyone else.
   *
   * Ties go to the most recent arrival at both levels, which is what makes the arriving request
   * the one refused when every lane is the same size. That case is genuine load rather than a
   * flood, and turning away the newest is the only answer that does not punish somebody who has
   * already been waiting.
   */
  function heaviest(): Waiter | undefined {
    let chosen: Map<string, Waiter[]> | undefined;
    let peerSize = -1;
    let peerNewest = -1;
    for (const origins of lanes.values()) {
      let size = 0;
      let newest = -1;
      for (const queue of origins.values()) {
        size += queue.length;
        const last = queue[queue.length - 1];
        if (last !== undefined && last.seq > newest) newest = last.seq;
      }
      if (size > peerSize || (size === peerSize && newest > peerNewest)) {
        chosen = origins;
        peerSize = size;
        peerNewest = newest;
      }
    }
    if (chosen === undefined) return undefined;

    let victim: Waiter | undefined;
    let groupSize = -1;
    for (const queue of chosen.values()) {
      const last = queue[queue.length - 1];
      if (last === undefined) continue;
      if (
        queue.length > groupSize ||
        (queue.length === groupSize && victim !== undefined && last.seq > victim.seq)
      ) {
        victim = last;
        groupSize = queue.length;
      }
    }
    return victim;
  }

  function remove(waiter: Waiter): void {
    const origins = lanes.get(waiter.lane.peer);
    if (origins === undefined) return;
    const queue = origins.get(waiter.lane.origin);
    if (queue === undefined) return;
    const at = queue.indexOf(waiter);
    if (at < 0) return;
    queue.splice(at, 1);
    queued -= 1;
    // NOT rotated, unlike `takeNext`: being shed is not being served, and a caller must not be
    // able to move their own lane up the round by filling the queue until they are shed out of it.
    if (queue.length === 0) origins.delete(waiter.lane.origin);
    if (origins.size === 0) lanes.delete(waiter.lane.peer);
  }

  function release(): void {
    const next = takeNext();
    // The slot is handed STRAIGHT to the next waiter rather than decremented and re-claimed by
    // whoever wakes first: dropping to `running - 1` in between is the window in which a request
    // arriving at that instant walks past a full gate, which is the same check-then-act defect
    // this whole module exists to close, one level down.
    if (next === undefined) running -= 1;
    else next.admit();
  }

  return {
    get inFlight() {
      return running;
    },
    get waiting() {
      return queued;
    },
    get shed() {
      return shedCount;
    },
    async run<T>(lane: QueueLane, work: () => Promise<T>): Promise<T> {
      if (running < options.maxConcurrent) running += 1;
      else {
        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = { seq: nextSeq, lane, admit: resolve, refuse: reject };
          nextSeq += 1;
          let origins = lanes.get(lane.peer);
          if (origins === undefined) {
            origins = new Map<string, Waiter[]>();
            // A lane that did not exist joins at the BACK of the round, so arriving cannot jump
            // the queue — and a caller cannot rotate a key to keep arriving at the front, because
            // the front is wherever the round has got to and never where a new lane appears.
            lanes.set(lane.peer, origins);
          }
          let queue = origins.get(lane.origin);
          if (queue === undefined) {
            queue = [];
            origins.set(lane.origin, queue);
          }
          queue.push(waiter);
          queued += 1;

          // Enqueue FIRST and then shed the worst, rather than deciding on arrival: it is one code
          // path whether the newcomer or somebody already waiting turns out to be the biggest
          // contributor, so there is no branch that refuses a request for being late. The newcomer
          // loses this comparison only when no lane is bigger than theirs, which is the tie
          // `heaviest` explains — genuine load, where somebody has to be turned away.
          if (queued > options.maxQueued) {
            const victim = heaviest();
            if (victim !== undefined) {
              remove(victim);
              shedCount += 1;
              victim.refuse(new QueueFullError());
            }
          }
        });
      }
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

/**
 * A COUNTER THAT ONLY EVER SPEAKS. It refuses nothing, delays nothing and changes no answer; the
 * single thing crossing it does is return `true` once, so that a route can write one audit row.
 *
 * WHY IT IS NOT `createRateLimiter` WITH A BIG NUMBER. Two reasons, and the second is the fatal
 * one. A limiter's budget is a thing an attacker wants to exhaust, and every use of one in this
 * server has had to answer "what does it cost the innocent when they do?" — this has no answer to
 * give because there is nothing to exhaust. And `createRateLimiter` keeps a timestamp per failure
 * and filters the whole array on every call, which is fine when the budget REFUSES past ten and
 * quadratic when nothing stops it growing: at the 6,000 requests a minute measured above, one key
 * would hold 90,000 timestamps and re-scan them on every request. A fixed window and an integer
 * costs one comparison.
 *
 * WHY IT MAY BE KEYED ON A CONSTANT. Behind the documented reverse proxy the unforgeable key is
 * one value for the whole deployment, and for a budget that would be the deployment-wide off
 * switch this codebase has now built twice by accident. For a notice it is simply a true sentence
 * with a coarser subject: "a lot of failed sign-ins arrived through the tunnel in this window" is
 * worth strictly more than the nothing an operator gets today.
 */
export interface ThresholdNotice {
  /**
   * Count one event against `key`. True exactly once per window, on the call that reaches the
   * threshold — never on the ones after it, so a caller who keeps going cannot flood the audit
   * trail and hide everything else in it.
   */
  crossed(key: string, nowMs?: number): boolean;
}

export interface ThresholdNoticeOptions {
  windowMs: number;
  threshold: number;
}

/** Keys whose windows are swept, when a new key arrives and the map is already bigger than this. */
const NOTICE_SWEEP_ABOVE = 1024;

export function createThresholdNotice(options: ThresholdNoticeOptions): ThresholdNotice {
  if (options.threshold < 1) throw new RangeError('threshold must be at least 1');
  const seen = new Map<string, { startedMs: number; count: number }>();

  return {
    crossed(key, nowMs = Date.now()) {
      let entry = seen.get(key);
      if (entry === undefined || nowMs - entry.startedMs >= options.windowMs) {
        // Swept on the cold path only, and only once the map is bigger than any real deployment's
        // count of distinct source networks: an O(n) scan on every failed sign-in would be the
        // same quadratic mistake this primitive exists to avoid.
        if (entry === undefined && seen.size >= NOTICE_SWEEP_ABOVE) {
          for (const [old, at] of seen) {
            if (nowMs - at.startedMs >= options.windowMs) seen.delete(old);
          }
        }
        entry = { startedMs: nowMs, count: 0 };
        seen.set(key, entry);
      }
      entry.count += 1;
      return entry.count === options.threshold;
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
