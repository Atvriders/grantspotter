export interface RateLimitDecision {
  allowed: boolean;
  /**
   * HOW LONG UNTIL A SLOT FREES: the remaining life of the OLDEST SLOT IN THE BUDGET, whether that
   * slot is a recorded entry or an attempt still running — a sliding window empties from the front.
   *
   * WHICH OF THOSE TWO KINDS COUNTS DEPENDS ON WHAT THE BUDGET COUNTS, and this paragraph said
   * something else until 2026-08-12: "when NOTHING is recorded it is 1, because the budget is held
   * entirely by attempts that are still running and the honest answer to somebody behind a queue
   * that drains in milliseconds is a second". That is true of a limiter counting FAILURES, where a
   * running attempt usually succeeds and hands its slot back, and it is exactly false of one
   * counting SUCCESSES, where the running attempts are what will fill the window. Measured cost of
   * the difference: 897×, see `RateLimiterOptions.counts`, which is what a construction site says
   * to get this right.
   *
   * A caller that turns this number into a sentence must branch on the same value it is about to
   * print — see `RateLimitAttempt`, which is where a caller printed one and stated the other.
   */
  retryAfterSec: number;
  /**
   * HOW MANY FAILURES WERE ALREADY RECORDED AGAINST THE KEY at the instant this decision was made,
   * NOT counting the attempts still in flight that may also be holding the budget shut.
   *
   * Read in the same synchronous breath as `allowed` and `retryAfterSec`, which is the point of it
   * being here rather than on a second call to `count`: the three have to describe one instant, or
   * a caller composing them into a sentence is quoting two different moments at the reader.
   */
  recorded: number;
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
 *
 * THE ROUND GAINED A MIDDLE LEVEL ON 2026-08-12, AND IT IS THE ROUTE. MEASURED against the built
 * server on this host: a sign-in flood of 400 connections rotating `X-Forwarded-For` (1,642 req/s)
 * while 130 students registered from 130 distinct addresses — 37 accounts created, 83 students SHED
 * BY THIS GATE, 10 refused by the registration ladder afterwards. "A caller can only displace
 * themselves" was true WITHIN a route and false across two: every place in this queue that the
 * sign-in flood held was a place the sign-up route could not have, and the shed sign-ups had
 * already charged the registration budget on their way in (`api/auth.ts` no longer lets them; that
 * is the other half of the fix). One queue for one CPU is still right — see `hashGate` — but "one
 * queue" must not mean "whoever shouts loudest gets all of it", and the two routes serve different
 * populations: members signing in, and strangers signing up. So they take turns, and the heaviest
 * ROUTE is shed before the heaviest caller inside it, which is what keeps either from spending the
 * other's share.
 *
 * WHY THE ROUTE SITS BETWEEN THE PEER AND THE ORIGIN rather than above or below both. The nesting
 * is ordered by how much the caller controls: the peer is theirs only by having a machine, the
 * route is chosen by which URL they POST to but the VALUE is written by this server and comes from
 * a closed set of two, and the origin is a header they may write outright. Ordering it that way is
 * what makes each level's guarantee survive the level below it being forged. Putting the route
 * outermost was the other candidate and is worse in one measurable shape: a caller who floods BOTH
 * routes from one peer would then hold half of each round, where under this nesting they hold one
 * peer's share of everything.
 */
export type HashRoute = 'sign-in' | 'sign-up';

export interface QueueLane {
  /**
   * The TCP peer. No header changes it and no client chooses it — and behind a reverse proxy it is
   * one value for every user in the deployment, which is why it is not enough on its own.
   */
  readonly peer: string;
  /**
   * Which of the two unauthenticated routes that hash a password this is. Not a caller-supplied
   * value at all: the route itself passes its own constant, so there is nothing here to rotate and
   * a caller cannot mint a third class to get a third share.
   */
  readonly route: HashRoute;
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

/** Why the gate turned a request away. Both are 429s; only the arithmetic behind them differs. */
export type QueueRefusal =
  /** The queue was at its ceiling and this caller was holding the largest part of it. */
  | 'full'
  /**
   * The queue had room, and this request reached the front of it having already waited longer than
   * the gate promises anybody will wait. See `ConcurrencyGateOptions.maxWaitMs`.
   */
  | 'waited-too-long';

/**
 * The gate refused to run this work. Distinct from anything `work` can throw so a route can answer
 * it differently — and thrown BEFORE `work` starts, so a refused request costs this process no
 * argon2id and the caller no credential.
 */
export class QueueFullError extends Error {
  readonly reason: QueueRefusal;
  constructor(reason: QueueRefusal = 'full') {
    super(reason === 'full' ? 'the hash queue is full' : 'the hash queue took too long to reach');
    this.name = 'QueueFullError';
    this.reason = reason;
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
  /**
   * Requests dropped at the front of the queue for having waited longer than `maxWaitMs`, counted
   * apart from `shed` because they mean a different thing to an operator: `shed` says more people
   * arrived than this queue holds, and this says this machine is slower than the queue assumed.
   */
  readonly expired: number;
}

export interface ConcurrencyGateOptions {
  /** How many `work` bodies may run at once. */
  maxConcurrent: number;
  /** How many may be waiting at once, across every lane, before the gate starts shedding. */
  maxQueued: number;
  /**
   * THE LONGEST THIS GATE WILL MAKE ANYBODY WAIT BEFORE IT STARTS THEIR WORK, enforced rather than
   * derived — and that is the WHOLE of what it bounds. See "WHAT IT DOES NOT BOUND" at the bottom
   * of this block, which is the half a promise like this always leaves out.
   *
   * WHY IT EXISTS. `maxQueued` alone was sold as a promise about the wait — "256/4 x 42 ms = 2.7 s,
   * the worst wait this gate will impose on anybody" — and that arithmetic multiplies a depth this
   * file chooses by a slot cost measured on an IDLE machine. MEASURED on this host against the
   * built server: a four-way argon2id slot costs 43 ms when a single lane is flooding and 168 ms
   * under 1,642 req/s across 250 lanes, and a member's sign-in in the second case took 10,680 ms
   * against a 41 ms baseline — four times the promised worst case, on the hardware the promise was
   * derived from. A promise whose truth depends on a constant measured elsewhere is a hope.
   *
   * So the depth is now only the MEMORY bound, and this is the promise. A waiter that reaches the
   * front having already waited longer than this is refused instead of started: the work is being
   * done for somebody who has very likely closed the tab, and the slot is worth more to whoever is
   * still there. It only ever fires when the machine is slower than `maxQueued` assumed, which is
   * exactly the case the old arithmetic got wrong.
   *
   * WHAT IT DOES NOT BOUND, MEASURED, AND WHY THAT IS NOT A DEFECT IN THE GATE. This clock starts
   * when `run` is called and stops when `work` is called. It says nothing about how long the
   * caller's REQUEST takes, because everything either side of those two moments happens on an
   * event loop this gate does not own: accepting the socket, parsing the body, resolving the route,
   * and — after the hash — the INSERT and the response write. MEASURED on this host, 2026-08-12,
   * against the built server, with the flood generated from four separate processes so the load
   * generator was not sharing the measurer's event loop: forty registrations under a 1,893 req/s
   * sign-in flood ran min 245 ms, MEDIAN 41,410 ms, MAX 45,603 ms, and a second run at 1,852 req/s
   * ran min 277, median 42,621, max 46,374. This bound was 3,000 ms throughout and it HELD — all
   * eighty of those students were answered 201, none was refused for having waited. The wait a
   * person experienced was fourteen times the promise, and the promise was not broken.
   *
   * So the sentence that is true is "nobody waits more than `maxWaitMs` in this queue", and the
   * sentence that is NOT true, however natural it is to write, is "nobody waits more than
   * `maxWaitMs`". A caller can saturate the loop in front of the gate and there is no constant in
   * this file that bounds that; the gate's answer to a flood is that the CPU is divided by turns
   * (see `QueueLane`), not that latency has a ceiling. The one lesson this file keeps relearning is
   * that a promise measured somewhere else is a hope, and a promise about a DIFFERENT INTERVAL from
   * the one being enforced is the same mistake with the arithmetic hidden.
   */
  maxWaitMs: number;
}

interface Waiter {
  /** Arrival order, monotonic. Used only to break ties toward the most recent arrival. */
  readonly seq: number;
  /** The lane's keys, outermost first: peer, route, origin. */
  readonly keys: readonly string[];
  readonly queuedAtMs: number;
  readonly admit: () => void;
  readonly refuse: (err: Error) => void;
}

/**
 * One level of the round, or the requests at the bottom of one.
 *
 * `children` is empty exactly at the leaves: an interior group is created only in order to be
 * given a child immediately, and any group that empties is deleted by whoever emptied it.
 * Insertion order IS the round at every level — the group that was just served is deleted and
 * re-inserted, which puts it at the back — so an idle lane costs nothing, because it does not
 * exist while it is idle.
 */
interface Group {
  readonly children: Map<string, Group>;
  readonly queue: Waiter[];
  /** Waiters in this subtree. Maintained on every insert and removal, so shedding is not a scan. */
  count: number;
  /**
   * The highest `seq` inserted into this subtree. Only ever a tie-break between groups of equal
   * size, and never decremented: a group is deleted the moment it empties, so a value left behind
   * by a waiter who has gone cannot outlive the group's own occupancy.
   */
  newest: number;
}

/** peer, route, origin. Named as a length so the walk below cannot silently disagree with it. */
const LANE_DEPTH = 3;

function emptyGroup(): Group {
  return { children: new Map<string, Group>(), queue: [], count: 0, newest: -1 };
}

export function createConcurrencyGate(options: ConcurrencyGateOptions): ConcurrencyGate {
  if (options.maxConcurrent < 1) throw new RangeError('maxConcurrent must be at least 1');
  if (options.maxQueued < 1) throw new RangeError('maxQueued must be at least 1');
  if (options.maxWaitMs < 1) throw new RangeError('maxWaitMs must be at least 1');

  /** peer -> route -> origin -> the requests waiting in that lane, oldest first. */
  const root = emptyGroup();
  let running = 0;
  let shedCount = 0;
  let expiredCount = 0;
  let nextSeq = 0;

  function insert(waiter: Waiter): void {
    let group = root;
    group.count += 1;
    group.newest = waiter.seq;
    for (const key of waiter.keys) {
      let child = group.children.get(key);
      if (child === undefined) {
        child = emptyGroup();
        // A lane that did not exist joins at the BACK of the round, so arriving cannot jump the
        // queue — and a caller cannot rotate a key to keep arriving at the front, because the
        // front is wherever the round has got to and never where a new lane appears.
        group.children.set(key, child);
      }
      child.count += 1;
      child.newest = waiter.seq;
      group = child;
    }
    group.queue.push(waiter);
  }

  function takeFrom(group: Group, level: number): Waiter | undefined {
    if (level === LANE_DEPTH) {
      const waiter = group.queue.shift();
      if (waiter !== undefined) group.count -= 1;
      return waiter;
    }
    for (const [key, child] of group.children) {
      const waiter = takeFrom(child, level + 1);
      if (waiter === undefined) {
        // Unreachable while the invariant holds (an empty group is always deleted, here and in
        // `remove`). Deleting rather than skipping keeps it unreachable for good.
        group.children.delete(key);
        continue;
      }
      group.count -= 1;
      group.children.delete(key);
      if (child.count > 0) group.children.set(key, child);
      return waiter;
    }
    return undefined;
  }

  /**
   * The newest request of the largest lane of the largest route of the largest peer — the one whose
   * caller has the most to lose and whose absence frees the most room for everyone else.
   *
   * Ties go to the most recent arrival at every level, which is what makes the arriving request the
   * one refused when every lane is the same size. That case is genuine load rather than a flood,
   * and turning away the newest is the only answer that does not punish somebody who has already
   * been waiting.
   */
  function heaviestIn(group: Group, level: number): Waiter | undefined {
    if (level === LANE_DEPTH) return group.queue[group.queue.length - 1];
    let chosen: Group | undefined;
    for (const child of group.children.values()) {
      if (
        chosen === undefined ||
        child.count > chosen.count ||
        (child.count === chosen.count && child.newest > chosen.newest)
      ) {
        chosen = child;
      }
    }
    return chosen === undefined ? undefined : heaviestIn(chosen, level + 1);
  }

  function remove(waiter: Waiter): void {
    const path: Group[] = [root];
    let group = root;
    for (const key of waiter.keys) {
      const child = group.children.get(key);
      if (child === undefined) return;
      path.push(child);
      group = child;
    }
    const at = group.queue.indexOf(waiter);
    if (at < 0) return;
    group.queue.splice(at, 1);
    for (const each of path) each.count -= 1;
    // NOT rotated, unlike `takeFrom`: being shed is not being served, and a caller must not be able
    // to move their own lane up the round by filling the queue until they are shed out of it.
    for (let level = path.length - 1; level >= 1; level -= 1) {
      const child = path[level];
      if (child !== undefined && child.count === 0) {
        path[level - 1]?.children.delete(waiter.keys[level - 1] ?? '');
      }
    }
  }

  function release(): void {
    for (;;) {
      const next = takeFrom(root, 0);
      // The slot is handed STRAIGHT to the next waiter rather than decremented and re-claimed by
      // whoever wakes first: dropping to `running - 1` in between is the window in which a request
      // arriving at that instant walks past a full gate, which is the same check-then-act defect
      // this whole module exists to close, one level down.
      if (next === undefined) {
        running -= 1;
        return;
      }
      if (Date.now() - next.queuedAtMs <= options.maxWaitMs) {
        next.admit();
        return;
      }
      // They have been waiting longer than this gate promises anybody will, so the slot goes to
      // whoever is behind them instead of to a hash whose caller has probably gone. The loop is
      // what makes that true of a whole run of stale waiters rather than only of the first.
      expiredCount += 1;
      next.refuse(new QueueFullError('waited-too-long'));
    }
  }

  return {
    get inFlight() {
      return running;
    },
    get waiting() {
      return root.count;
    },
    get shed() {
      return shedCount;
    },
    get expired() {
      return expiredCount;
    },
    async run<T>(lane: QueueLane, work: () => Promise<T>): Promise<T> {
      if (running < options.maxConcurrent) running += 1;
      else {
        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = {
            seq: nextSeq,
            keys: [lane.peer, lane.route, lane.origin],
            queuedAtMs: Date.now(),
            admit: resolve,
            refuse: reject,
          };
          nextSeq += 1;
          insert(waiter);

          // Enqueue FIRST and then shed the worst, rather than deciding on arrival: it is one code
          // path whether the newcomer or somebody already waiting turns out to be the biggest
          // contributor, so there is no branch that refuses a request for being late. The newcomer
          // loses this comparison only when no lane is bigger than theirs, which is the tie
          // `heaviestIn` explains — genuine load, where somebody has to be turned away.
          if (root.count > options.maxQueued) {
            const victim = heaviestIn(root, 0);
            if (victim !== undefined) {
              remove(victim);
              shedCount += 1;
              victim.refuse(new QueueFullError('full'));
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
   * Count one event against `key`, and answer with THE NUMBER COUNTED SO FAR IN THIS WINDOW when
   * this call is one an operator should be told about — 0 on every other call.
   *
   * IT RETURNED A BOOLEAN UNTIL 2026-08-12 AND THAT COST THE OPERATOR THE ONLY FIGURE THAT
   * MATTERED. A boolean can only say "at least the threshold", so the two call sites in
   * `api/auth.ts` had nothing to put in their audit rows but the threshold constant itself, and
   * both wrote it: `{"answers":20}` and `{"failures":50}`. MEASURED against the built server on
   * this host: 4,000 probes of one taken address in 2.4 s — 1,665 answers a second — produced the
   * operator exactly one row, and that row said `"answers":20`. The magnitude is the whole signal
   * (twenty is a club intake with a few forgetful members in it; four thousand is somebody reading
   * a roster), and it was the one thing the row could not carry.
   *
   * WHY IT IS NOT SIMPLY "RETURN THE COUNT EVERY TIME", which is the obvious version and would put
   * one audit row on the trail per request — the flood this whole primitive exists to avoid, since
   * a trail an attacker can fill at will is a trail that hides everything else in it. So it
   * announces at the threshold and then at each DOUBLING of it: 20, 40, 80, 160, … A caller who
   * sends n events in a window writes about log2(n / threshold) + 1 rows, so the 4,000 above become
   * eight rows and a sustained 1.1 M-a-window flood becomes sixteen. Bounded, and every row states
   * a number that was true when it was written.
   */
  announce(key: string, nowMs?: number): number;
}

export interface ThresholdNoticeOptions {
  windowMs: number;
  threshold: number;
}

/** Keys whose windows are swept, when a new key arrives and the map is already bigger than this. */
const NOTICE_SWEEP_ABOVE = 1024;

export function createThresholdNotice(options: ThresholdNoticeOptions): ThresholdNotice {
  if (options.threshold < 1) throw new RangeError('threshold must be at least 1');
  /**
   * `announceAt` is the next count that earns a row: the threshold, then each doubling of it. Kept
   * per key rather than derived from `count` so the sequence cannot be re-entered — a key whose
   * window rolls over starts again at the threshold, and one that does not never announces the
   * same number twice.
   */
  const seen = new Map<string, { startedMs: number; count: number; announceAt: number }>();

  return {
    announce(key, nowMs = Date.now()) {
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
        entry = { startedMs: nowMs, count: 0, announceAt: options.threshold };
        seen.set(key, entry);
      }
      entry.count += 1;
      if (entry.count < entry.announceAt) return 0;
      // Doubling rather than `+= threshold`: a linear ladder would still be one row per twenty
      // requests, which at the measured 1,665 answers a second is 83 rows a second.
      entry.announceAt *= 2;
      return entry.count;
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
       * This attempt turned out to be the thing the budget counts: convert the held slot into a
       * recorded one. Idempotent, and `release` afterwards is a no-op — an attempt settles exactly
       * once.
       *
       * IT IS STAMPED WITH THE MOMENT THE ATTEMPT STARTED, not the moment it settled, and that
       * default is what makes a wait quotable. The slot was already occupying the budget from
       * `begin`; dating the recorded entry from the settle instead would mean a caller told "the
       * oldest slot frees in 900 seconds" comes back in 900 seconds to find it frees in another
       * two, because the hash it was waiting on charged after the forecast was made. Measured
       * against the built server on this host: a 260-student burst settles over 2.4 s, so that is
       * the size of the error being removed. Pass a value only to place an entry deliberately, as
       * the tests do.
       */
      charge: (nowMs?: number) => void;
      /**
       * Let the slot go without recording anything. Safe to call unconditionally in a `finally`,
       * which is the point: a handler that throws must not leak a slot for the life of the process.
       */
      release: () => void;
    }
  /**
   * THE BUDGET IS SHUT, AND THE TWO NUMBERS THAT SAY WHY MUST BE READ TOGETHER.
   *
   * `recorded` is what has actually been written down; `retryAfterSec` is how long until a slot
   * frees. `recorded === 0` means nothing has been written down yet and the budget is held entirely
   * by attempts still running — but what that IMPLIES about the wait is not the same on both kinds
   * of limiter, and `RateLimiterOptions.counts` is what says which one this is. On a limiter
   * counting failures the wait is one hash, because a running attempt that succeeds frees its slot;
   * on one counting successes the running attempts are the successes, so their slots do not come
   * back and the wait is a window measured from when they started. Anything else is a spent window
   * and the wait is the rest of it.
   *
   * BOTH ARE HERE BECAUSE A CALLER THAT BRANCHED ON ONE AND PRINTED THE OTHER SHIPPED A REFUSAL
   * THAT CONTRADICTED ITSELF IN ONE BREATH. MEASURED against the built server on this host,
   * 2026-08-12: 130 students behind one campus NAT, six submits at a time — 60 accounts, 70
   * refusals, and 37 of the 70 read "GrantSpotter is already making as many accounts at once as it
   * will from this connection … wait a moment and try again" in a body carrying
   * `"retryAfterSec":900`, which the browser renders as "… wait a moment and try again. Try again
   * in 15 minutes." The handler had branched on a SECOND read of `count()`, which excludes
   * in-flight attempts, while the wait came from this decision. One instant, two readings, two
   * sentences that cannot both be true. Branch on what you are about to print.
   */
  | { started: false; retryAfterSec: number; recorded: number };

export interface RateLimiter {
  check(key: string, nowMs?: number): RateLimitDecision;
  /**
   * HOW MANY FAILURES ARE RECORDED AGAINST `key` RIGHT NOW, for a caller that wants to SAY
   * something rather than refuse something.
   *
   * WHY IT EXISTS. `check` answers "may this one proceed?", which is a boolean and was the wrong
   * question for the place this was written for: `api/auth.ts` wrote an audit row when an account
   * came out of a source that had just been getting enrollment codes wrong, and "seven" and "one"
   * are the same boolean. MEASURED on 2026-08-10 against the built server: seven wrong codes from
   * one address, then a chosen code found on the eighth, produced an account and no row an
   * operator could see, because every one of those seven was inside a budget that never closed.
   *
   * IT HAD NO PRODUCTION CALLER FOR ONE DAY — the note here said so, and said that if a second
   * release went by with nothing calling it, it should be deleted. It has exactly ONE as of
   * 2026-08-12: the `registrations` field of the audit row that says a rung closed
   * (`announceClosedRungs` in `api/auth.ts`). That field used to quote `rung.max`, a constant, and
   * a constant cannot be wrong out loud — which is how the row came to say `"registrations":120` on
   * a deployment with one user in it. A number that is READ from the limiter can only ever be what
   * the limiter holds.
   *
   * IT BRIEFLY HAD A SECOND CALLER AND THAT ONE WAS A DEFECT, recorded here because the shape is
   * inviting. The refusal SENTENCE was built from a second call to this method after `begin` had
   * already refused — two readings of one instant — and because this number excludes in-flight
   * attempts while the budget includes them, the sentence and the `retryAfterSec` beside it
   * contradicted each other for 37 of 130 measured students. A caller that needs the count AND the
   * wait must take both from the one decision: see `RateLimitAttempt`, which now carries `recorded`
   * for exactly that. This method is for a caller that wants the count and NOTHING else.
   *
   * IN-FLIGHT ATTEMPTS ARE NOT COUNTED, unlike `check`'s reading of the same key. This number goes
   * into a sentence about what has already happened; an attempt whose outcome is still unknown is
   * not yet a failure, and counting it would let a burst of requests that all turn out to be
   * correct inflate the figure in the row.
   */
  count(key: string, nowMs?: number): number;
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

/**
 * WHAT THE REAL LIMITER CAN BE ASKED THAT THE CONTRACT DOES NOT REQUIRE, and why it is a second
 * interface rather than a member of the one above.
 *
 * `RateLimiter` is implemented by test doubles elsewhere in this server, and a member added to it
 * is a member every one of them has to grow. This is not part of what a route depends on — no
 * handler reads it, and no behaviour changes with it — so it belongs to the concrete map that has
 * the memory, not to the contract that describes the budget.
 */
export interface RateLimiterMemory {
  /**
   * HOW MANY KEYS THIS LIMITER IS STILL HOLDING MEMORY FOR, which is a different question from any
   * of the ones on `RateLimiter` and the only one that can be asked about the map as a whole.
   *
   * It exists because the sweep this map gained on 2026-08-12 was otherwise unassertable: every
   * other method prunes the key it is asked about as it reads it, so a test that asks about a stale
   * key gets 0 whether the key was swept or is still sitting there. A bound nobody can measure is a
   * bound nobody can keep, and the defect being fixed — 342 bytes per distinct forged
   * `X-Forwarded-For`, retained until the process restarted — was invisible for exactly that
   * reason.
   *
   * IT DOES NOT PRUNE. Asking must not be what makes the answer true.
   */
  keysRetained(): number;
}

export interface RateLimiterOptions {
  windowMs: number;
  maxFailures: number;
  /**
   * WHAT THIS BUDGET IS A BUDGET FOR, which is the one thing that decides what an attempt still in
   * flight means for the wait quoted to whoever is refused.
   *
   * A LIMITER COUNTING FAILURES gets `'failures'`, which is the default and what `maxFailures` is
   * named for. A running attempt is one whose outcome is unknown, most of them succeed, and a
   * success on such a limiter frees its slot — so when the whole budget is held by running attempts
   * the honest wait is one hash, not one window. That is what `decide` answers, and it is right.
   *
   * A LIMITER COUNTING SUCCESSES gets `'successes'`, and every word of the paragraph above is
   * false for it. The registration ladder in `api/auth.ts` counts CREATED ACCOUNTS: a running
   * attempt that succeeds charges, so its slot never comes back, and a budget held entirely by
   * running attempts is a budget that is about to be spent for a whole window rather than one that
   * drains in milliseconds. MEASURED against the built server on this host, 2026-08-12, 260
   * students from one building NAT arriving together: 200 created, 56 refused with
   * `retryAfterSec: 1` and the sentence "No account has been created from this connection in the
   * last fifteen minutes" — and one second later the same caller was answered `retryAfterSec: 897`
   * and "200 accounts have been created from this connection". The number was wrong by 897×, in
   * exactly the branch whose comment justified it.
   *
   * IT IS AN OPTION AND NOT AN INFERENCE because nothing in this file can see which of `charge` and
   * `release` a caller will pick; only the caller knows. It has a default because `maxFailures`
   * already names the common case and three limiters in this server rely on it — but a budget that
   * counts anything other than failures MUST say so here, or it will quote the wrong wait to
   * everybody it refuses during a burst.
   */
  counts?: 'failures' | 'successes';
}

/**
 * Keys below which the sweep never runs, and the floor it can never drop under. Larger than any
 * real deployment's count of distinct source networks in one window, so an honest instance sweeps
 * nothing at all and pays nothing for the sweep existing.
 */
const LIMITER_SWEEP_ABOVE = 1024;

/**
 * In-memory sliding-window failure counter. Single-process by design: this app
 * runs as one Node process (spec §3), so a shared store would be ceremony.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter & RateLimiterMemory {
  const failures = new Map<string, number[]>();
  /**
   * THIS MAP USED TO BE FREED ONLY BY BEING READ, AND A CALLER WHO NEVER REPEATS A KEY NEVER READS
   * ONE TWICE. `recent` prunes the key it is asked about and nothing else, so every distinct key
   * that ever recorded a failure stayed for the life of the process: MEASURED by the reviewer at
   * 342 bytes retained per distinct forged `X-Forwarded-For`, about 3.9 MB a day that only a
   * restart returned. Bounded per window, unbounded over a process lifetime — which is the same
   * defect the `ThresholdNotice` comment above warns about, in the primitive that comment was
   * written next to.
   *
   * SWEPT ON THE COLD PATH ONLY, when a key that does not exist yet is about to be added, and only
   * once the map is bigger than this. AMORTISED O(1) BY DOUBLING: after a sweep the next one is not
   * due until the map has grown to twice what the sweep left behind, so a flood of fresh keys pays
   * a linear scan every n arrivals rather than on every arrival. Scanning on every insert once the
   * map is large would be the quadratic mistake this file already refuses once.
   */
  let sweepAbove = LIMITER_SWEEP_ABOVE;

  function sweep(nowMs: number): void {
    if (failures.size < sweepAbove) return;
    for (const [key, at] of failures) {
      const last = at[at.length - 1];
      if (last === undefined || nowMs - last >= options.windowMs) failures.delete(key);
    }
    sweepAbove = Math.max(LIMITER_SWEEP_ABOVE, failures.size * 2);
  }
  /**
   * Attempts that have started and not yet settled, per key. They occupy the SAME budget as
   * recorded failures because they are the same thing seen earlier: an attempt that is still
   * running is one whose failure has not been written down yet, and a limiter that only counts the
   * written-down ones is a limiter that a burst walks straight past.
   *
   * THE VALUE IS WHEN EACH ONE STARTED, and it used to be just how many there were. A count can
   * say that the budget is shut; only the start times can say WHEN IT OPENS AGAIN on a limiter
   * whose running attempts are about to become recorded ones — see `RateLimiterOptions.counts`,
   * which is the fact that makes these timestamps mean a wait. Ascending, because `begin` pushes
   * in time order, so `[0]` is the oldest slot held.
   *
   * BOUNDED BY `maxFailures` PER KEY: `begin` only pushes when the budget was open, and it is open
   * only while recorded plus in-flight is under the ceiling. It is the same bound the count had.
   */
  const inFlight = new Map<string, number[]>();

  function recent(key: string, nowMs: number): number[] {
    const kept = (failures.get(key) ?? []).filter((at) => nowMs - at < options.windowMs);
    if (kept.length === 0) failures.delete(key);
    else failures.set(key, kept);
    return kept;
  }

  /**
   * Give back the one slot this attempt is holding — identified by the moment it started, and by
   * value rather than by index because two attempts on one key settle in whatever order their work
   * finishes. Timestamps are interchangeable when they are equal, so removing the first match is
   * removing this attempt's slot.
   */
  function release(key: string, startedAt: number): void {
    const held = inFlight.get(key);
    if (held === undefined) return;
    const at = held.indexOf(startedAt);
    if (at !== -1) held.splice(at, 1);
    if (held.length === 0) inFlight.delete(key);
  }

  /**
   * Write one failure down against `key`. The sweep goes here and only here, because `recent` has
   * just deleted the key if everything it held was stale — so `failures.has(key)` after it is
   * exactly the question "is this a key the map does not have yet?", which is the only moment the
   * map can grow.
   */
  function record(key: string, at: number): void {
    const hits = recent(key, at);
    if (!failures.has(key)) sweep(at);
    hits.push(at);
    failures.set(key, hits);
  }

  function decide(key: string, nowMs: number): RateLimitDecision {
    const hits = recent(key, nowMs);
    const held = inFlight.get(key) ?? [];
    if (hits.length + held.length < options.maxFailures) {
      return { allowed: true, retryAfterSec: 0, recorded: hits.length };
    }
    /**
     * THE OLDEST SLOT IN THE BUDGET, WHICH IS NOT ALWAYS THE OLDEST RECORDED ONE.
     *
     * On a limiter counting SUCCESSES a slot held by a running attempt is a slot that is about to
     * become a recorded one, dated from when that attempt started (`charge` stamps the start). So
     * it expires at `start + windowMs` exactly like a recorded entry, and the first slot to free is
     * the oldest of the two kinds. Taking the minimum is what makes the number quotable: a caller
     * who waits exactly the wait they were given arrives after that slot has gone.
     *
     * On a limiter counting FAILURES the running attempts are excluded on purpose. Most of them
     * will succeed and hand their slots back within one hash, so a window measured from their start
     * would be a fifteen-minute answer to a queue that drains in milliseconds.
     */
    const oldestRecorded = hits[0];
    const oldestHeld = options.counts === 'successes' ? held[0] : undefined;
    const oldest =
      oldestRecorded === undefined
        ? oldestHeld
        : oldestHeld === undefined
          ? oldestRecorded
          : Math.min(oldestRecorded, oldestHeld);
    // Nothing recorded and nothing whose start time counts, so the budget is spent entirely by
    // attempts still running on a limiter that expects them to hand their slots back: the wait is
    // one argon2id hash, not one window. Answering ~900 seconds to somebody who is behind a queue
    // that drains in milliseconds would be a worse lie than no number at all. Unreachable when
    // `counts` is `'successes'` — a shut budget with nothing recorded is a budget full of held
    // slots, and every one of them has a start time.
    if (oldest === undefined) return { allowed: false, retryAfterSec: 1, recorded: 0 };
    const retryAfterMs = options.windowMs - (nowMs - oldest);
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      recorded: hits.length,
    };
  }

  return {
    check(key, nowMs = Date.now()) {
      return decide(key, nowMs);
    },

    count(key, nowMs = Date.now()) {
      // `recent` prunes as it reads, so asking is also what keeps a key from outliving its window.
      return recent(key, nowMs).length;
    },

    keysRetained() {
      return failures.size;
    },

    begin(key, nowMs = Date.now()) {
      const decision = decide(key, nowMs);
      if (!decision.allowed) {
        // Both numbers out of ONE decision, so the sentence a caller builds from them describes one
        // instant. See the `started: false` variant of `RateLimitAttempt` for what a second read
        // cost the 130 students it was measured on.
        return {
          started: false,
          retryAfterSec: decision.retryAfterSec,
          recorded: decision.recorded,
        };
      }
      const held = inFlight.get(key);
      if (held === undefined) inFlight.set(key, [nowMs]);
      else {
        // Kept ascending BY CONSTRUCTION rather than by the convention that `Date.now()` only goes
        // forwards, because `nowMs` is a parameter and a caller may hand these over in any order.
        // `decide` reads `[0]` as the oldest slot held and that has to be true of what is there,
        // not of how it usually arrives. An append in the normal case, one comparison deep.
        let at = held.length;
        while (at > 0 && (held[at - 1] ?? 0) > nowMs) at -= 1;
        held.splice(at, 0, nowMs);
      }

      let settled = false;
      return {
        started: true,
        // Dated from the start of the attempt by default. See `RateLimitAttempt.charge` for what
        // the settle-time default cost the caller who was told when to come back.
        charge(at = nowMs) {
          if (settled) return;
          settled = true;
          release(key, nowMs);
          record(key, at);
        },
        release() {
          if (settled) return;
          settled = true;
          release(key, nowMs);
        },
      };
    },

    recordFailure(key, nowMs = Date.now()) {
      record(key, nowMs);
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
