import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChangeEvent, FetchedPayload, Program, RawOpportunity, SourceModule } from '@grantspotter/core';
import type { AiAssist } from '../ai/assist.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import {
  ProgramUpsertConflictError,
  appendAuditLog,
  insertChangeEvents,
  insertSnapshot,
  listProgramsBySource,
  listSourceHealth,
  recordPollFailure,
  recordPollStart,
  recordPollSuccess,
} from '../db/repositories/ingestion.js';
import { detectYieldDrop, diffPrograms, shouldSuppressVanished } from '../diff/index.js';
import type { Fetcher } from '../fetcher/index.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { deadlineOwnerKey, deadlineOwnerProgramId } from '../normalize/deadline.js';
import type { NormalizeContext } from '../normalize/index.js';
import { normalizeRaw } from '../normalize/index.js';
import { buildReviewItems, reprojectAllCycles } from '../review/index.js';
import { SOURCES, funderFor, getSource } from '../sources/registry.js';
import { hasFollowUp, isSignalSource, resolveRequests } from '../sources/types.js';
import { isReadablePayload } from '../sources/util/payload.js';
import { contextForSource } from './context.js';

export interface CrawlDeps {
  db: Database.Database;
  fetcher: Fetcher;
  nowISO: () => string;
  /**
   * Spec §9, strictly optional. Undefined behaves exactly as if this task did not exist: no
   * salvage parse, no pre-score, the crawl is byte-identical. `createAiAssist(config)` (server
   * index.ts) already returns a disabled, no-op assist when ANTHROPIC_API_KEY is unset, so
   * production code can pass it unconditionally — this field only needs to be omitted in tests
   * that want the old behaviour with zero setup.
   */
  assist?: AiAssist;
}

export interface SourceRunResult {
  sourceId: string;
  parsedCount: number;
  events: number;
  reviewItems: number;
  error?: string;
}

function signalEventId(sourceId: string, externalKey: string): string {
  return createHash('sha256').update(`signal|${sourceId}|${externalKey}`).digest('hex').slice(0, 24);
}

/**
 * A source whose `requests` are ALTERNATIVES rather than a set: several addresses for the same
 * answer, of which the crawl needs exactly one.
 *
 * WHY THIS EXISTS. `grants-gov-extract` offers the seven days of the Grants.gov rolling retention
 * window. Every one of them is a FULL SNAPSHOT of the same federal corpus, and the window is there
 * only so that a day which has not been published yet, or which 404s, does not cost us the feed.
 * The loop below fetched all seven and held all seven, so a nightly run downloaded 545,297,718
 * bytes, wrote the same corpus to disk seven times as base64, and held all seven bodies in memory
 * to use one of them. Measured end-to-end on this host before the change, this one source:
 * `parsedCount=89 snapshot bytes=727,063,624 wall=38.6s VmHWM=3547MB`. After: one request,
 * `parsedCount=89 snapshot bytes=0 wall=28.4s VmHWM=877MB`.
 *
 * `answeredBy` is asked after each payload arrives, and a `true` ends the walk. It is a question
 * about the PAYLOAD, not about the parse: for the extract it reads the ZIP frame and inflates
 * nothing, so the cost of asking is a fraction of the cost of the request that would follow.
 *
 * IT MUST NOT BE ABLE TO HIDE A FAILURE. Stopping early only ever DROPS REQUESTS; it never turns
 * an unreadable answer into a readable one, and the module's `parse` still throws when nothing it
 * was given could be read. `answeredBy` returning `false` for every day leaves the loop exactly
 * where it was — all seven fetched, and the parse deciding.
 *
 * Declared here, with the loop that honours it, rather than in `sources/types.ts` beside
 * `FollowUpSource`: the modules that implement it must not import it, because
 * `sources/registry.test.ts` walks every relative import out of `sources/` and fails when the walk
 * reaches `db/` — which this file does on its second line. The structural match is what connects
 * the two, and the test below `runSource` is what keeps them spelled the same.
 */
export interface AlternativeRequestsSource extends SourceModule {
  /** True when this payload is the answer, so the remaining requests need not be made. */
  answeredBy(payload: FetchedPayload): boolean;
}

export function hasAlternativeRequests(m: SourceModule): m is AlternativeRequestsSource {
  return typeof (m as Partial<AlternativeRequestsSource>).answeredBy === 'function';
}

/**
 * Carry-forward #2 (RESOLUTIONS R9). `upsertProgram`'s `ON CONFLICT(id)` target means a stale or
 * missed `existingIdFor` surfaces as `ProgramUpsertConflictError` (Task 20) rather than a raw
 * SQLite message. This is the single place that turns any error caught inside `runSource` into
 * the text that lands in `sources.last_error` — and it specifically NAMES a source-key conflict
 * instead of relaying whatever SQLite/fetch/parse message happened to be attached, so an operator
 * reading source health can tell "reconciliation broke for one record" apart from "the site is
 * down" or "the parser found nothing". Exported so it can be exercised directly: constructing a
 * real `ProgramUpsertConflictError` end-to-end through `runSource` is not possible once R9
 * reconciliation is wired correctly (that is the point of wiring it), so this is unit-tested
 * against an error instance obtained the same way Task 20's own tests obtain one.
 */
export function healthMessageFor(err: unknown): string {
  if (err instanceof ProgramUpsertConflictError) return `source-key conflict: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The status a server can give that means "stop asking", rather than "not today".
 *
 * RFC 9110 §15.5.11: a 410 states that access "is no longer available and this condition is likely
 * to be permanent", that the condition is intentional, and that a client with link-editing
 * capability SHOULD delete the reference. There is exactly one other status in this file's
 * vocabulary that a site owner uses to speak to a crawler — a `Disallow` in robots.txt — and this
 * software already treats that as binding the same night it appears. Re-requesting nightly,
 * forever, a page whose owner has gone to the trouble of publishing 410 for it is the same
 * impoliteness in a different spelling.
 */
const GONE = 410;

/**
 * Nothing this source asked for was served, so there is no page to have parsed.
 *
 * THE DEFECT THIS CLOSES, and it is the seventh instance in this codebase of one thing being
 * reported as another. `fetcher/index.ts` throws only for 429 and 5xx; a 403 or a 404 comes back
 * as an ordinary `FetchedPayload`. `runSource` then called `recordPollSuccess` no matter what the
 * status was, while every parser skipped the payload (`isReadablePayload`) and returned `[]`. So
 * "students.ieee.org refused us" — the ordinary way a datacentre IP meets Cloudflare, where a home
 * VM does not — was stored as a SUCCESSFUL poll with zero records, and the Sources screen drew it
 * as `yield_dropped`: "your parser stopped working", about a parser, a fixture and a live page
 * that were all fine.
 *
 * That is the exact conflation the README's founding argument names: "this source returned
 * nothing" and "this source has nothing right now" are different facts that look identical in a
 * database row. A refusal is neither of them, and it must not be able to wear the second one's
 * clothes.
 *
 * IT IS A THROW, not a bespoke code path, because `runSource`'s existing `catch` already does
 * every single thing that has to happen: `recordPollFailure` writes `sources.last_error` and
 * increments `consecutive_failures`, `SourceRunResult.error` carries the sentence into the crawl
 * summary the Sources screen prints, and the run continues to the next source. Thrown BEFORE the
 * diff, which matters for a reason beyond tidiness: `diffPrograms` against an empty `next` emits a
 * `vanished` event per published record, so a single 403 used to tell an operator that every
 * programme this funder had ever published was gone. It also skips `detectYieldDrop`, whose alarm
 * would have said the parser failed.
 */
export class PageNotReadError extends Error {
  /** The status of the first unread payload, or 0 when the fetch produced no status at all. */
  readonly status: number;
  readonly url: string;
  /** True only for {@link GONE}: this source is to stop being polled, not retried tonight. */
  readonly permanent: boolean;
  constructor(url: string, status: number, requestCount: number) {
    super(pageNotReadMessage(url, status, requestCount));
    this.name = 'PageNotReadError';
    this.status = status;
    this.url = url;
    this.permanent = status === GONE;
  }
}

/**
 * WHY EACH STATUS GETS ITS OWN SENTENCE. They are all failures and they are not the same event, and
 * the operator reading `sources.last_error` is deciding what to DO. A 403 is somebody's WAF and the
 * answer is usually to ask them; a 404 on a page polled for months is a move and the answer is to
 * find the new address; a 401 on a source that never needed credentials is a change at their end
 * and nothing we can fix by trying harder; a 410 is a decision, and the answer is to stop.
 *
 * 429 and 5xx are deliberately absent: `fetcher/index.ts` throws `HttpStatusError` for those after
 * every retry, so they never become a payload and never reach this function. A server in distress
 * is already a failure by a different road, and it is not a refusal — which is why the enumeration
 * below does not pretend to cover it.
 */
export function pageNotReadMessage(url: string, status: number, requestCount: number): string {
  const head = `HTTP ${String(status)} for ${url}`;
  const rest =
    status === 401
      ? '— the site now asks for credentials this source has never had, so no page was read. ' +
        'That is a change at their end, not an empty page.'
      : status === 403
        ? '— the site refused us, so no page was read. This is a refusal, not an empty page.'
        : status === 404
          ? '— nothing is at that address, so no page was read. The page has moved or been ' +
            'withdrawn; it has not gone empty.'
          : status === GONE
            ? '— the site states this address is permanently gone, so no page was read. This ' +
              'source has been paused so that we stop asking nightly; re-enable it here once ' +
              'someone has found where the page went.'
            : status >= 300 && status < 400
              ? '— the redirects never resolved to a page within the hops allowed, so no page ' +
                'was read. We never arrived, which is not the same as arriving at something empty.'
              : `— the site declined this request, so no page was read. This is a refusal, not ` +
                'an empty page.';
  const others =
    requestCount > 1
      ? ` All ${String(requestCount)} of this source's requests came back unread.`
      : '';
  return `${head} ${rest}${others}`;
}

/**
 * The refusal to report, or undefined when tonight's empty hands are honestly empty.
 *
 * THE RULE, AND THE TWO CASES IT DELIBERATELY LEAVES ALONE.
 *
 * It fires only when NOTHING WAS PARSED AND NOTHING WAS READ. Both halves are load-bearing:
 *
 *   "Nothing was read" and not "something was refused", because a refusal among payloads is
 *   NORMAL for a source whose requests are alternatives. `grants-gov-extract` offers the seven days
 *   of the Grants.gov retention window precisely so that a day which 404s does not cost us the
 *   feed (see {@link AlternativeRequestsSource}); one readable archive is a complete answer about
 *   the federal corpus, and a night on which that corpus happens to hold nothing we score as
 *   adjacent is a real zero, not a refusal. Reading "any 4xx" as a failed poll would have marked
 *   that source `failing` on an ordinary night, forever.
 *
 *   "Nothing was parsed", because records in hand are proof the source answered. A multi-request
 *   source that yields records while one supplementary request 403s is still reported as a
 *   success, and that is a residual this rule accepts rather than hides: the mechanism for "we got
 *   less than we should have" already exists and is `detectYieldDrop`. Buying that case would cost
 *   a per-source declaration of which requests are load-bearing, which is a thing every source
 *   would then have to keep true.
 *
 * A source with no requests at all (`manual-tier-d`, whose records are hand-curated) has no
 * payloads, so it can never land here — an empty list is not a refusal.
 */
export function refusalFor(payloads: FetchedPayload[], parsedCount: number): PageNotReadError | undefined {
  if (parsedCount > 0 || payloads.length === 0) return undefined;
  if (payloads.some(isReadablePayload)) return undefined;
  const first = payloads[0];
  if (first === undefined) return undefined;
  // Permanence has to be unanimous. "Every address this source has is gone" is a decision worth
  // acting on; one 410 beside a 403 is a site in some other kind of trouble, and pausing on it
  // would silence a source over a state nobody stated.
  const status = payloads.every((p) => p.status === GONE) ? GONE : first.status;
  return new PageNotReadError(first.url, status, payloads.length);
}

/**
 * Stop polling a source whose every address answers 410, and SAY WHO DECIDED.
 *
 * `sources.enabled = 0` is the same pause an administrator applies from the Sources screen, and
 * `runCrawl` honours it on the nightly path and on the manual "run just this one" trigger alike.
 * This is the only place in the product where that flag is written by something other than a
 * person, so it writes an audit row exactly as `PATCH /api/sources/:id` does — a paused source is
 * an invisible decision until somebody asks why a funder stopped updating, and an automatic one is
 * worse. `actor_user_id` is null: the actor was the crawl, and naming any account there would be a
 * false statement in the one record that exists to be believed.
 *
 * REVERSIBLE, ON THE SCREEN THAT SAYS WHY. The row keeps its `last_error`, which names the status
 * and the address, and the enable checkbox is on the same line. That is the whole reason this can
 * be automatic at all: the cost of being wrong is one tick, by somebody who has just read the
 * reason.
 */
function stopPolling(deps: CrawlDeps, sourceId: string, err: PageNotReadError, nowISO: string): void {
  const changed = deps.db
    .prepare('UPDATE sources SET enabled = 0 WHERE id = ? AND enabled = 1')
    .run(sourceId).changes;
  // Already paused (a direct `runSource` call on a source the nightly crawl would skip): the flag
  // is right and a second audit row would claim a decision nobody made twice.
  if (changed === 0) return;
  appendAuditLog(deps.db, {
    userId: null,
    action: 'source.gone',
    entityType: 'source',
    entityId: sourceId,
    detail: JSON.stringify({ status: err.status, url: err.url, enabled: false }),
    atISO: nowISO,
  });
}

/**
 * REMEDIATION (2026-08-03). `federal/adjacency.ts`'s weighted score is the only relevance signal
 * this codebase computes. Five source modules write it into `rawFields.adjacencyScore`, and it
 * reached NOTHING: `normalizeRaw` drops `rawFields` wholesale (a `Program` has no field for them),
 * and `confidenceFor`'s `adjacencyScore` parameter — which has real arithmetic behind it — was
 * never passed a value by the one production call site.
 *
 * This is the seam that repairs it, and it is the only place it can be repaired without inventing
 * a new `Program` field: `raws[i]` and `next[i]` are the same record before and after
 * normalization, so this is the one point in the whole pipeline where the score and the minted
 * program id are both in hand. Keying by program id is what lets `buildReviewItems` — which sees
 * only `Program`s — find it again.
 *
 * WHY NOT STAMP IT ONTO THE PROGRAM (an `adjacency:<n>` tag, the way `source:`/`key:` ride along).
 * Because the score is a property of TONIGHT'S PARSE of a source record, not of the published
 * opportunity: `hashProgram` includes `tags`, so a tag would fold an operational triage number
 * into the published corpus's content hash and into every `rejectKey`, and a rescoring caused by
 * nothing but a vocabulary edit would resurface records a reviewer had already dismissed. The
 * signal is needed for exactly one decision — how to triage tonight's candidate — so it travels
 * exactly as far as that decision and no further.
 *
 * A non-numeric or absent value yields no entry, and an absent entry means "not scored", which
 * leaves `confidenceFor` on its tier/kind path exactly as before.
 */
function adjacencyScores(raws: RawOpportunity[], next: Program[]): Map<string, number> {
  const out = new Map<string, number>();
  raws.forEach((raw, i) => {
    const program = next[i];
    if (program === undefined) return;
    const score = Number(raw.rawFields.adjacencyScore);
    if (raw.rawFields.adjacencyScore !== undefined && Number.isFinite(score)) {
      out.set(program.id, score);
    }
  });
  return out;
}

/**
 * Carry-forward #3 (RESOLUTIONS R9), rewritten by the 2026-08-03 dangling-owner remediation.
 *
 * `DEADLINE_INHERITANCE` (normalize/deadline.ts) now names the OWNER'S SOURCE, and the owner's
 * program id is derived from that source's stable key by `deadlineOwnerProgramId` — the same
 * expression `normalizeRaw` uses for the owner's own id. This warning is what watches that
 * derivation against reality, and it is the check that would have caught the original defect: the
 * old code resolved `ctx.deadlineInheritsFrom` as if it were already a program id, so it warned
 * about a literal that could never match anything, on every crawl, forever — and because it is
 * only a warning, nothing failed and nobody looked.
 *
 * Two distinct conditions, reported distinctly:
 *   - this file cannot say WHICH record of the owning source owns the cycle (no
 *     `DEADLINE_OWNER_EXTERNAL_KEY` entry) — a table defect, and inheritance is not emitted at all;
 *   - the owner is simply not published YET — the ordinary state of a fresh install before its
 *     first approval, and self-healing: `review/index.ts` backfills every dependent the moment the
 *     owner is approved.
 *
 * Still a WARNING and never a failure. The source's own records are real and worth reviewing even
 * while the program they ride is missing, so this must not set `result.error` or block review-item
 * creation.
 */
/**
 * The published program that owns this source's cycle, or undefined when this source inherits
 * nothing, when no owner record is described, or when the owner has not been approved yet.
 *
 * Looked up by the owner's STABLE (sourceId, externalKey) — the same key `deadlineOwnerProgramId`
 * derives the id from — rather than by the derived id, so this keeps working even if a record was
 * published under an id minted before the source key existed.
 */
function publishedDeadlineOwner(deps: CrawlDeps, ctx: NormalizeContext): Program | undefined {
  if (ctx.deadlineInheritsFrom === undefined) return undefined;
  const key = deadlineOwnerKey(ctx.deadlineInheritsFrom);
  if (key === undefined) return undefined;
  return createProgramRepo(deps.db).findBySourceKey(key.sourceId, key.externalKey);
}

/**
 * STATUS INHERITANCE (2026-08-03). A record that rides another programme's cycle inherits its
 * STATE too, not just its dates.
 *
 * THE DEFECT THIS CLOSES. Deadline inheritance was implemented and status inheritance was not, so
 * 110 of the 111 ARRL catalog scholarships badged `open` while the portal page they ride says,
 * twice, "The 2026 Scholarship Cycle is now closed." The portal's own record computed `closed`
 * correctly from that sentence; nothing carried it one hop. That is the same shape as the dangling
 * owner reference fixed alongside it — a record inheriting one property from an owner while
 * silently defaulting another — and it is the most damaging thing this product can say, because a
 * wrongly-open scholarship costs a student the work of a whole application to a cycle that shut
 * months ago.
 *
 * WHY HERE, IN THE CRAWL, AND NOT AT APPROVE TIME. `diffPrograms` compares `trust.status`
 * DIRECTLY (it is excluded from `hashProgram`, so the diff has to read it by name), which means a
 * stored status that the pipeline does not recompute identically raises a `status_changed` event
 * every single night, forever. Whatever value is published must therefore be the value the crawl
 * derives. This is that seam: the candidate a reviewer sees already carries the inherited status,
 * and re-deriving it tomorrow from the same published owner yields the same value, so there is no
 * churn. Resolving it in `approveReviewItem` instead would publish a status the reviewer never saw
 * AND flood the inbox nightly.
 *
 * ONLY FILLS `unknown`, NEVER OVERWRITES. `normalize/deadline.ts` returns `unknown` for an
 * inheriting record precisely because it cannot see the owner; anything else on the record is a
 * finding somebody actually made — the Winscott scholarship's `dormant`, read out of its own "not
 * currently active" sentence — and a record's own evidence outranks its owner's. An owner that is
 * itself `unknown` is not a state worth propagating, so nothing is copied and the dependents stay
 * honestly unknown. NO STATE IS EVER INVENTED here: every value written came off the owner's page.
 */
function applyInheritedStatus(
  deps: CrawlDeps,
  ctx: NormalizeContext,
  candidates: Program[],
): Program[] {
  const owner = publishedDeadlineOwner(deps, ctx);
  if (owner === undefined || owner.trust.status === 'unknown') return candidates;
  return candidates.map((program) =>
    program.deadline.source.kind === 'inherited' &&
    program.deadline.source.fromProgramId === owner.id &&
    program.trust.status === 'unknown'
      ? { ...program, trust: { ...program.trust, status: owner.trust.status } }
      : program,
  );
}

function warnIfDeadlineTargetMissing(deps: CrawlDeps, module: SourceModule, ctx: NormalizeContext): void {
  if (ctx.deadlineInheritsFrom === undefined) return;
  const ownerId = deadlineOwnerProgramId(ctx.deadlineInheritsFrom, ctx);
  if (ownerId === undefined) {
    console.warn(
      `[crawl] "${module.id}" inherits its deadline from source "${ctx.deadlineInheritsFrom}", ` +
        'but DEADLINE_OWNER_EXTERNAL_KEY (normalize/deadline.ts) does not say which record of ' +
        'that source owns the cycle, so these records fall back to their own deadline instead of ' +
        'inheriting one. Add the owning record’s externalKey there.',
    );
    return;
  }
  const target = deps.db.prepare('SELECT 1 FROM programs WHERE id = ?').get(ownerId);
  if (target !== undefined) return;
  console.warn(
    `[crawl] "${module.id}" inherits its deadline from source "${ctx.deadlineInheritsFrom}" ` +
      `(program id "${ownerId}", derived from that source's key), but no published program ` +
      'carries that id yet. Every "inherited" deadline this source emits tonight resolves to no ' +
      'cycle until that owner is approved — at which point review/index.ts backfills them.',
  );
}

export async function runSource(deps: CrawlDeps, sourceId: string): Promise<SourceRunResult> {
  const module = getSource(sourceId);
  const now = deps.nowISO();
  recordPollStart(deps.db, module, now);

  try {
    // SEAM FIX (whole-branch review). `programs.funder_id` is a NOT NULL foreign key onto
    // `funders(id)` and nothing else ever wrote that table, so a fresh install's first
    // `approveReviewItem` died on a raw FOREIGN KEY constraint failure. `funderFor` (the
    // registry) knows the real organization behind every module's funderId; upserting it here,
    // before anything else touches this source tonight, guarantees the funder row exists before
    // any review item this run produces can ever reach approval.
    createFunderRepo(deps.db).upsert(funderFor(module.funderId));

    const payloads: FetchedPayload[] = [];
    const alternatives = hasAlternativeRequests(module) ? module : undefined;
    for (const request of await resolveRequests(module)) {
      const payload = await deps.fetcher.fetch(request);
      payloads.push(payload);
      insertSnapshot(deps.db, sourceId, payload);
      // One answer is enough. See `AlternativeRequestsSource` — for every other source in the
      // registry `alternatives` is undefined and this loop is byte-identical to what it was.
      if (alternatives?.answeredBy(payload) === true) break;
    }

    if (hasFollowUp(module)) {
      const sinceISO = listSourceHealth(deps.db).find((h) => h.sourceId === sourceId)?.lastSuccessAt;
      for (const request of module.followUp(payloads, { sinceISO })) {
        const payload = await deps.fetcher.fetch(request);
        payloads.push(payload);
        insertSnapshot(deps.db, sourceId, payload);
      }
    }

    let raws: RawOpportunity[] = module.parse(payloads);

    // SALVAGE ONLY (spec §9). The deterministic parser already ran and found nothing, on a
    // source that expects real records — never the primary path, never a substitute for a
    // working parser. With no ANTHROPIC_API_KEY, `deps.assist` is either undefined or an
    // assist whose isEnabled() is false, so this branch calls nothing and `raws` stays [],
    // exactly as if this task did not exist.
    if (raws.length === 0 && module.expectedMinRecords > 0 && deps.assist?.isEnabled()) {
      const html = payloads.find((p) => p.status === 200 && p.body !== '')?.body ?? '';
      if (html !== '') {
        raws = await deps.assist.parseAssist(html, {
          sourceId,
          sourceUrl: payloads[0]?.url ?? '',
          expectedFields: [
            'Award Amount',
            'Number of Awards',
            'License Requirement',
            'Field of Study',
            'Region',
          ],
        });
      }
    }

    // A REFUSAL IS NOT AN EMPTY PAGE. Placed here, after the deterministic parse and after the
    // salvage that only runs when that parse found nothing, and BEFORE the diff and the yield
    // alarm: a source that was never served has no records to have lost, so it must not raise
    // `parse_yield_dropped` (which says the parser broke) or a `vanished` event per published
    // record (which says the funder withdrew them). See `refusalFor`.
    const refusal = refusalFor(payloads, raws.length);
    if (refusal !== undefined) {
      if (refusal.permanent) stopPolling(deps, sourceId, refusal, now);
      throw refusal;
    }

    const events: ChangeEvent[] = [];

    const yieldAlarm = detectYieldDrop(sourceId, raws.length, module.expectedMinRecords, now);
    if (yieldAlarm) events.push(yieldAlarm);

    let reviewItemCount = 0;

    if (isSignalSource(module)) {
      // Signal sources produce ChangeEvents for a human to read and never a candidate Program.
      // The event id is derived from the item's externalKey, and insertChangeEvents uses
      // INSERT OR IGNORE, so an item is signalled exactly once, ever.
      for (const raw of raws) {
        if (!module.isRelevant(raw)) continue;
        events.push({
          id: signalEventId(sourceId, raw.externalKey),
          sourceId,
          kind: 'new',
          fieldPath: 'news',
          after: { name: raw.name, sourceUrl: raw.sourceUrl, rawFields: raw.rawFields },
          detectedAt: now,
        });
      }
      insertChangeEvents(deps.db, events);
    } else {
      // `deps.db` is what turns on RESOLUTIONS R9's seeded-id reconciliation.
      const ctx = contextForSource(module, now, deps.db);
      warnIfDeadlineTargetMissing(deps, module, ctx); // carry-forward #3
      // Status inheritance runs BEFORE the diff and before the review queue is built, so the
      // candidate a reviewer reads is the candidate that gets published, and tomorrow's crawl
      // re-derives the same value from the same published owner instead of raising a
      // `status_changed` event every night. See `applyInheritedStatus`.
      const next: Program[] = applyInheritedStatus(
        deps,
        ctx,
        raws.map((raw) => normalizeRaw(raw, ctx)),
      );
      const previous = listProgramsBySource(deps.db, sourceId);
      const diffed = diffPrograms(previous, next, sourceId, now);
      // carry-forward #1: a legitimately empty scrape (grants.austinhams.org, Aug-Apr) must not
      // read as "every previously-published record vanished". shouldSuppressVanished is exported
      // by diff/ but deliberately not called there — it is a runner-facing gate, and this is the
      // one place that wires it in.
      const suppressVanished = shouldSuppressVanished(next.length, module.expectedMinRecords);
      events.push(...diffed.filter((e) => !(suppressVanished && e.kind === 'vanished')));
      insertChangeEvents(deps.db, events);

      const byId = new Map<string, Program>();
      for (const program of [...previous, ...next]) byId.set(program.id, program);
      // deps.assist is optional (spec §9): undefined or disabled leaves confidence exactly as
      // confidenceFor computed it, and buildReviewItems must still be awaited regardless — a bare
      // call returns a Promise, and reading `.length` off that is a type error, not just a race.
      //
      // `reviewItemCount` is deliberately NOT `next.length`, and for five sources it is much
      // smaller: `buildReviewItems` drops every candidate tagged `do_not_publish` (past awards and
      // cross-check-only records — see its `SUPPRESSION_EXEMPT_KINDS` doc comment) and, since
      // 2026-08-03, every candidate whose source scored it below `ADJACENCY_THRESHOLD` (the
      // nsf-funding-rss flood — see `isBelowAdjacencyThreshold`). Those records are already fully
      // stored by the `insertChangeEvents` call above, which carries the whole normalized Program
      // in `after_json`, so suppression costs no evidence. `parsedCount` and `recordPollSuccess`
      // below still report the true parse yield — 45 for nsf-funding-rss, not 0 — so a parser that
      // quietly stops working is still caught by `detectYieldDrop` rather than being masked by
      // suppression. That is the whole reason both gates live here and not in the parsers.
      reviewItemCount = (
        await buildReviewItems(
          deps.db,
          events,
          byId,
          module.tier,
          sourceId,
          deps.assist,
          adjacencyScores(raws, next),
        )
      ).length;
    }

    recordPollSuccess(deps.db, sourceId, raws.length, now);
    return { sourceId, parsedCount: raws.length, events: events.length, reviewItems: reviewItemCount };
  } catch (err) {
    // carry-forward #2: whatever the failure — a network error, a parser throw, or a source-key
    // UNIQUE conflict from a stale/missed existingIdFor — this is caught here, turned into a
    // health failure for THIS source only, and never rethrown. `runCrawl`'s loop below is what
    // actually keeps crawling the other sources; healthMessageFor is what makes the recorded
    // message name a source-key conflict specifically rather than relaying an opaque SQLite error.
    const message = healthMessageFor(err);
    recordPollFailure(deps.db, sourceId, message, now);
    return { sourceId, parsedCount: 0, events: 0, reviewItems: 0, error: message };
  }
}

/**
 * Sources run strictly serially. One source failing never aborts the crawl.
 *
 * RESOLUTIONS R20 — `sources.enabled = 0` really pauses a source. Plan 3 ships
 * `PATCH /api/sources/:id` writing that column and an admin toggle on the Sources page; without
 * this filter the toggle is decorative and the nightly crawl keeps hammering a site the operator
 * deliberately backed off from. That is a politeness failure, not just a UI bug: this crawl walks
 * ~25 small-nonprofit sites, and the reason an admin pauses one is almost always that it is
 * 500ing, rate-limiting, or asked us to stop.
 *
 * The filter applies to an explicit `sourceIds` request too. "Run just this one" from the admin
 * console must not resurrect a source someone paused — Plan 3's manual crawl trigger calls exactly
 * this function, so the pause has to hold on both paths.
 *
 * A source that has never been polled has no `sources` row at all, so it is not in the disabled
 * set and runs normally. The default is enabled, and Plan 1's column default (`1`) agrees.
 */
export async function runCrawl(deps: CrawlDeps, sourceIds?: string[]): Promise<SourceRunResult[]> {
  // EVERY RUN RE-READS robots.txt. The fetcher caches it per origin so that one run does not fetch
  // the same file 30 times; without this line that cache had no end, and a container running since
  // February would still be acting on February's rules. `robots.txt` is the remedy this project's
  // README and issue template give a site owner as the way to stop EVERY deployment of this
  // software — "a new file takes effect tonight" has to be true of the code, not just of the
  // documentation. Cheap: one conditional GET per origin per night, on ~25 origins.
  deps.fetcher.forgetRobots();
  const disabled = new Set(
    (
      deps.db.prepare('SELECT id FROM sources WHERE enabled = 0').all() as Array<{ id: string }>
    ).map((r) => r.id),
  );
  const ids = (sourceIds ?? SOURCES.map((m) => m.id)).filter((id) => !disabled.has(id));
  const results: SourceRunResult[] = [];
  for (const id of ids) results.push(await runSource(deps, id));
  // SEAM FIX round 2: the 18-month cycle horizon otherwise never refreshes for a program nobody
  // ever touches again (no crawl diff, no re-approval), so it silently ages out of its own
  // calendar. `runCrawl` is "where programs are already refreshed" (nightly, and also Plan 3's
  // manual "run this one source" trigger), so it re-projects every already-published program's
  // cycles forward from `nowISO` here, independent of whether tonight's crawl produced any review
  // items at all. See `reprojectAllCycles` (review/index.ts) for the full reasoning.
  reprojectAllCycles(deps.db, deps.nowISO());
  return results;
}
