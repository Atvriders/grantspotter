import { Router } from 'express';
import { appendAuditLog } from '../db/repositories/ingestion.js';
import type { CrawlTrigger, RouterDeps } from './deps.js';
import { AppError } from './errors.js';

/** PLAN-LOCAL to Plan 3. */
export type SourceHealthState =
  | 'healthy'
  | 'idle'
  | 'yield_dropped'
  | 'failing'
  | 'stale'
  | 'never_polled';

/** PLAN-LOCAL to Plan 3. */
export interface SourceHealth {
  state: SourceHealthState;
  detail: string;
}

/** PLAN-LOCAL to Plan 3. */
export interface SourceHealthInput {
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastRecordCount: number | null;
  /**
   * The count this source is known to have yielded on a good run
   * (`sources.baseline_record_count`), or null when nothing has ever recorded
   * one. Present so the yield alarm can name a real number instead of a
   * hardcoded one — see `sourceHealth` below.
   */
  baselineRecordCount: number | null;
  expectedMinRecords: number;
}

const STALE_AFTER_MS = 7 * 86_400_000;

/**
 * An empty scrape is not automatically a failure: grants.austinhams.org
 * legitimately shows "No opportunities available" from Aug 1 to Apr 30. Only a
 * source that normally yields records and now yields none is an alarm - that
 * silent zero is the most likely way this app rots, and it has already happened
 * here: six parsers returned zero records from their own live pages while the
 * whole unit suite stayed green, one of them owning the deadline that 112 of
 * 150 programmes inherit.
 *
 * The six states are deliberately distinguishable rather than collapsed into
 * ok/not-ok, because "nothing has happened yet" (never_polled), "nothing is
 * expected to happen right now" (idle) and "something is broken"
 * (yield_dropped / failing / stale) are three different sentences and the whole
 * point of this page is that an absence of activity must never look identical
 * to a broken pipeline.
 *
 * DEVIATION FROM THE TASK BRIEF (2026-08-04). The brief's yield_dropped message
 * ended with the literal string "(baseline 111 for the ARRL catalog)", which
 * made its own test pass and would have told an operator that NCDXF's grant
 * page normally yields 111 records. The baseline is now an input, so the
 * sentence is true for every source and absent when the number is unknown.
 */
export function sourceHealth(input: SourceHealthInput, nowISO: string): SourceHealth {
  if (input.lastPolledAt === null) {
    return { state: 'never_polled', detail: 'This source has not been polled yet.' };
  }
  if (input.consecutiveFailures > 0) {
    return {
      state: 'failing',
      detail: `${input.consecutiveFailures} consecutive failures since the last success.`,
    };
  }
  // A source that has been polled but has never once succeeded is stale, not
  // healthy. Falling through to the yield check would read its NULL record
  // count as a zero and, for an expectedMinRecords of 0, call it idle.
  if (input.lastSuccessAt === null) {
    return { state: 'stale', detail: 'Polled, but no fetch has ever succeeded.' };
  }
  if (Date.parse(nowISO) - Date.parse(input.lastSuccessAt) > STALE_AFTER_MS) {
    return { state: 'stale', detail: `No successful fetch since ${input.lastSuccessAt}.` };
  }

  const count = input.lastRecordCount ?? 0;
  if (input.expectedMinRecords === 0) {
    return {
      state: count > 0 ? 'healthy' : 'idle',
      detail:
        count > 0
          ? `${count} records on the last successful parse.`
          : 'No records, which is expected for this source outside its open window.',
    };
  }
  if (count < input.expectedMinRecords) {
    const baseline =
      input.baselineRecordCount === null ? '' : ` It last yielded ${input.baselineRecordCount}.`;
    return {
      state: 'yield_dropped',
      detail:
        `Parsed ${count} records; this source normally yields at least ` +
        `${input.expectedMinRecords}.${baseline}`,
    };
  }
  return { state: 'healthy', detail: `${count} records on the last successful parse.` };
}

const RANK: Record<SourceHealthState, number> = {
  failing: 0,
  yield_dropped: 1,
  stale: 2,
  never_polled: 3,
  idle: 4,
  healthy: 5,
};

const SELECT_COLUMNS = `id, label, tier, funder_id, enabled, last_polled_at, last_success_at,
        consecutive_failures, last_record_count, baseline_record_count, expected_min_records`;

interface SourceRow {
  id: string;
  label: string;
  tier: string;
  funder_id: string;
  enabled: number;
  last_polled_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  last_record_count: number | null;
  baseline_record_count: number | null;
  expected_min_records: number;
}

/** PLAN-LOCAL to Plan 3. One source as the Sources page renders it. */
export interface SourceView {
  id: string;
  label: string;
  tier: string;
  funderId: string;
  enabled: boolean;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastRecordCount: number | null;
  baselineRecordCount: number | null;
  expectedMinRecords: number;
  health: SourceHealth;
}

function toView(r: SourceRow, nowISO: string): SourceView {
  return {
    id: r.id,
    label: r.label,
    tier: r.tier,
    funderId: r.funder_id,
    enabled: r.enabled === 1,
    lastPolledAt: r.last_polled_at,
    lastSuccessAt: r.last_success_at,
    consecutiveFailures: r.consecutive_failures,
    lastRecordCount: r.last_record_count,
    baselineRecordCount: r.baseline_record_count,
    expectedMinRecords: r.expected_min_records,
    health: sourceHealth(
      {
        lastPolledAt: r.last_polled_at,
        lastSuccessAt: r.last_success_at,
        consecutiveFailures: r.consecutive_failures,
        lastRecordCount: r.last_record_count,
        baselineRecordCount: r.baseline_record_count,
        expectedMinRecords: r.expected_min_records,
      },
      nowISO,
    ),
  };
}

/**
 * The whole of source configuration.
 *
 * Both fields are operational rather than editorial: what a source's parse
 * yield is expected to be, and whether the nightly crawl visits it at all.
 * Identity (id, funderId, tier, klass) belongs to the source module in code,
 * not to a database row an admin can edit into disagreeing with it.
 *
 * Nothing here can name a URL, a host, or the fetcher blocklist. That list -
 * farweb.org, candid.org, fconline.foundationcenter.org, grantwatch.com,
 * grantstation.com, instrumentl.com - is enforced in the fetcher and is
 * deliberately non-configurable: farweb.org is the Foundation for Amateur
 * Radio's hijacked domain, which now 301s to a gambling site, and club pages
 * still tell applicants to apply there. An unrecognised key is a 422 rather
 * than a silently-ignored field, so a request that tries to point a source
 * somewhere new is refused out loud instead of reading as accepted.
 */
const CONFIGURABLE = new Set(['expectedMinRecords', 'enabled']);

export function createSourcesRouter(deps: RouterDeps, crawl: CrawlTrigger): Router {
  const router = Router();

  const selectOne = deps.db.prepare(`SELECT ${SELECT_COLUMNS} FROM sources WHERE id = ?`);

  /**
   * Single-flight guard for the manual crawl. It is a closure over this router
   * instance, which is exactly the scope that matters: there is one router per
   * process, and a crawl walks ~25 third-party sites belonging to small
   * nonprofits. Two at once would double that load and race each other's
   * `sources` bookkeeping, so a second request is a 409, not a queue.
   */
  let inFlight = false;

  router.get('/health', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const nowISO = deps.now();

    const rows = deps.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM sources ORDER BY label`)
      .all() as SourceRow[];

    const mapped = rows
      .map((r) => toView(r, nowISO))
      .sort((a, b) => RANK[a.health.state] - RANK[b.health.state] || a.label.localeCompare(b.label));

    const healthy = mapped.filter(
      (m) => m.health.state === 'healthy' || m.health.state === 'idle',
    ).length;

    res.json({
      rows: mapped,
      summary: { total: mapped.length, healthy, unhealthy: mapped.length - healthy },
      // Spec §12: members read this page; only admins change it or trigger a
      // crawl. The flag lets the UI say so rather than render dead controls.
      canConfigure: user.role === 'admin',
    });
  });

  // Spec §12, "Source configuration | admin ✅ | member read-only".
  router.patch('/:id', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const unknown = Object.keys(body).filter((k) => !CONFIGURABLE.has(k));
    if (unknown.length > 0) {
      next(
        new AppError(
          'validation_failed',
          `Only expectedMinRecords and enabled are configurable; a source's URL, host and the fetcher blocklist are not.`,
          { unknownFields: unknown },
        ),
      );
      return;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const detail: Record<string, unknown> = {};

    if (body.expectedMinRecords !== undefined) {
      const n = body.expectedMinRecords;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        next(
          new AppError('validation_failed', 'expectedMinRecords must be an integer of 0 or more.'),
        );
        return;
      }
      sets.push('expected_min_records = ?');
      params.push(n);
      detail.expectedMinRecords = n;
    }

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        next(new AppError('validation_failed', 'enabled must be true or false.'));
        return;
      }
      sets.push('enabled = ?');
      params.push(body.enabled ? 1 : 0);
      detail.enabled = body.enabled;
    }

    if (sets.length === 0) {
      next(
        new AppError(
          'validation_failed',
          'Nothing to change. Send expectedMinRecords, enabled, or both.',
        ),
      );
      return;
    }

    if (selectOne.get(req.params.id) === undefined) {
      next(new AppError('not_found', `No source with id "${req.params.id}".`));
      return;
    }

    deps.db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).run(...params, req.params.id);

    // A paused source is an invisible decision until someone asks why a funder
    // stopped updating. Give it an author.
    appendAuditLog(deps.db, {
      userId: deps.currentUser(req).id,
      action: 'source.configure',
      entityType: 'source',
      entityId: req.params.id,
      detail: JSON.stringify(detail),
      atISO: deps.now(),
    });

    res.json({ source: toView(selectOne.get(req.params.id) as SourceRow, deps.now()) });
  });

  // Spec §12, "crawl trigger | admin ✅ | member ❌". Plan 2's runCrawl is
  // injected as `crawl` so this router stays constructible with a fake.
  router.post('/crawl', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    const body = (req.body ?? {}) as { sourceIds?: unknown };
    let sourceIds: string[] | undefined;

    if (body.sourceIds !== undefined) {
      if (
        !Array.isArray(body.sourceIds) ||
        body.sourceIds.some((s) => typeof s !== 'string' || s.trim().length === 0)
      ) {
        next(
          new AppError('validation_failed', 'sourceIds must be an array of source id strings.'),
        );
        return;
      }
      // De-duplicated: one press must not fetch the same volunteer-run site
      // twice because the UI sent its id twice.
      sourceIds = [...new Set(body.sourceIds as string[])];
    }

    if (inFlight) {
      next(new AppError('conflict', 'A crawl is already running. Wait for it to finish.'));
      return;
    }

    const startedAt = deps.now();
    // The lock is taken synchronously, BEFORE the trigger is called, so neither
    // a second request in the same tick nor a trigger that throws before
    // returning a promise can leave it in a wrong state.
    inFlight = true;
    const release = (): void => {
      inFlight = false;
    };

    appendAuditLog(deps.db, {
      userId: deps.currentUser(req).id,
      action: 'source.crawl',
      entityType: 'source',
      entityId: sourceIds === undefined ? '*' : sourceIds.join(','),
      detail: JSON.stringify(sourceIds === undefined ? { sourceIds: null } : { sourceIds }),
      atISO: startedAt,
    });

    let run: Promise<Awaited<ReturnType<CrawlTrigger>>>;
    try {
      run = crawl(sourceIds);
    } catch (err) {
      // Released on a synchronous throw too: a crawl that never started must
      // not wedge the button.
      release();
      next(err);
      return;
    }

    void run.then(
      (results) => {
        release();
        res.json({ startedAt, finishedAt: deps.now(), results });
      },
      (err: unknown) => {
        // Released on failure too: a crawl that threw must not wedge the button.
        release();
        next(err);
      },
    );
  });

  return router;
}
