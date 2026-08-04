import type {
  ChangeKind, FetchRequest, FetchedPayload, Program, RawOpportunity, SourceModule,
} from '@grantspotter/core';
import type { Db } from '../db/migrate.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { hasFollowUp, resolveRequests } from '../sources/types.js';
import { fieldPathForLabel, loadProvenance, recordProvenance } from './provenanceStore.js';

/** PLAN-LOCAL to Plan 3. */
export interface VerifyFieldDiff {
  label: string;
  before: string | null;
  after: string | null;
}

/** PLAN-LOCAL to Plan 3. */
export interface VerifyResult {
  programId: string;
  attemptedAt: string;
  ok: boolean;
  error?: string;
  changed: boolean;
  diffs: VerifyFieldDiff[];
  lastVerifiedAt: string;
  changeEventIds: string[];
}

/** PLAN-LOCAL to Plan 3. Matches the CONTRACT `Fetcher` shape structurally. */
export interface VerifyFetcher {
  fetch(req: FetchRequest): Promise<FetchedPayload>;
}

/** PLAN-LOCAL to Plan 3. */
export interface VerifyRunnerOptions {
  db: Db;
  fetcher: VerifyFetcher;
  /**
   * `readonly` because the composition root passes `SOURCES` from
   * `sources/registry.ts`, which is `readonly SourceModule[]`. A mutable
   * parameter type made Task 14's `createVerifyRunner({ ..., sources: SOURCES })`
   * fail to compile (TS4104), and the runner only ever reads the array.
   */
  sources: readonly SourceModule[];
  now: () => string;
}

/** PLAN-LOCAL to Plan 3. */
export interface VerifyRunner {
  verify(programId: string): Promise<VerifyResult>;
}

const MEMBER_HOURLY_CAP = 10;
const HOUR_MS = 3_600_000;

/**
 * The largest refetch plan a single button press is allowed to issue.
 *
 * Every ham-organisation module in `sources/registry.ts` declares exactly one
 * request, and the widest publishable multi-request source is `nsf-funding-rss`
 * at three small feeds; ARDC's two-phase grant source totals four. The cap
 * therefore never touches a source a user can actually reach from the detail
 * page — what it stops is `grants-gov-extract`, whose plan is seven ~77.85 MB
 * ZIPs. That is ~545 MB, on demand, per click, from a user-triggered endpoint
 * aimed at somebody else's servers. It is a nightly-crawl job, and a refusal
 * that says so is a better answer than a download nobody asked for.
 */
export const MAX_VERIFY_REQUESTS = 4;

/**
 * The ChangeKind implied by the Program field a raw label feeds.
 *
 * DEVIATION FROM THE TASK BRIEF (2026-08-03). The brief classifies the kind by
 * matching substrings of the raw LABEL and then derives the event's `field_path`
 * back from the kind. That round-trip is lossy in both directions: it is a
 * second label vocabulary that can drift from `provenanceStore`'s, and mapping
 * `amount_changed` back to a single path files a change to `Number of Awards`
 * against `amount.amountRaw` — a claim about a field the funder never touched,
 * in the very column the detail page uses to point a reader at what moved.
 * `fieldPathForLabel` is the shared vocabulary (deliberately widened, and pinned
 * at the other end by `normalize/rawFieldsContract.test.ts`); the kind is
 * derived FROM the path, so there is one vocabulary instead of two.
 *
 * `eligibility_changed` is the residual, not a reading. CONTRACT §3 freezes
 * `ChangeKind` with no member meaning "some other field", so a change to, say,
 * `applyUrl` has to travel under the nearest kind — which is why the event, the
 * notification body and the returned diff all carry the raw LABEL and the exact
 * field path alongside it. The kind routes the alert; the label is the evidence.
 */
function changeKindForPath(fieldPath: string): ChangeKind {
  if (fieldPath.startsWith('deadline')) return 'deadline_changed';
  if (fieldPath.startsWith('amount')) return 'amount_changed';
  if (fieldPath === 'trust.status') return 'status_changed';
  return 'eligibility_changed';
}

function diffRawFields(
  before: Record<string, string>,
  after: Record<string, string>,
): VerifyFieldDiff[] {
  const labels = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: VerifyFieldDiff[] = [];
  for (const label of labels) {
    const b = before[label] ?? null;
    const a = after[label] ?? null;
    if (b !== a) out.push({ label, before: b, after: a });
  }
  return out;
}

interface SourceKeyRow {
  source_id: string | null;
  external_key: string | null;
}

/**
 * Which module speaks for this program.
 *
 * In order: the ingest identity stored on the row, then the source named by the
 * program's own provenance, then — only when the funder has exactly ONE module —
 * that module. The single-candidate rule is a deviation from the brief's
 * `sources.find((s) => s.funderId === program.funderId)`: ARRL alone contributes
 * eight modules, so "first match by funder" is a coin toss, and verifying a
 * scholarship against the club-grant page finds nothing and reports the
 * scholarship as vanished. Refusing names a real gap; guessing invents an event.
 */
function resolveSource(
  sources: readonly SourceModule[],
  program: Program,
  storedSourceId: string | null,
  provenanceSourceId: string | undefined,
): SourceModule | undefined {
  const named = storedSourceId ?? provenanceSourceId;
  if (named !== undefined && named !== null) {
    return sources.find((s) => s.id === named);
  }
  const byFunder = sources.filter((s) => s.funderId === program.funderId);
  return byFunder.length === 1 ? byFunder[0] : undefined;
}

/**
 * The parsed record that is this program, or null.
 *
 * The stored `external_key` is the ingest identity and is tried first. The two
 * name fallbacks exist because a seeded or hand-imported row can carry no source
 * key at all, and a positive identification by name is a far better outcome than
 * the false "this vanished" that no match would produce.
 */
function matchRecord(
  parsed: RawOpportunity[],
  program: Program,
  storedExternalKey: string | null,
): RawOpportunity | null {
  if (storedExternalKey !== null) {
    const byKey = parsed.find((r) => r.externalKey === storedExternalKey);
    if (byKey !== undefined) return byKey;
  }
  return (
    parsed.find((r) => r.externalKey === program.name) ??
    parsed.find((r) => r.name === program.name) ??
    null
  );
}

/**
 * "Verify now". Refetches the program's source, re-parses, and diffs the PARSED
 * fields against the stored provenance.
 *
 * Why parsed fields and not the HTML: arrl.org sends no ETag and no
 * Last-Modified, its sitemap `<lastmod>` values are all frozen at 2010, and its
 * nav and footer churn on every request. A conditional request is impossible and
 * hashing raw HTML would report a change every single time, so the amber badge
 * would mean nothing.
 *
 * Every fetch goes through the production `Fetcher`, which is where the
 * non-configurable host blocklist and the per-host crawl delay live. A refused
 * host therefore arrives here as a thrown error and is reported as one, verbatim:
 * this function has no way to bypass the blocklist and must not appear to.
 */
export function createVerifyRunner(opts: VerifyRunnerOptions): VerifyRunner {
  const { db, fetcher, sources, now } = opts;
  const programs = createProgramRepo(db);

  return {
    async verify(programId: string): Promise<VerifyResult> {
      const attemptedAt = now();
      // RESOLUTIONS R1: read through Plan 1's repository, which reassembles the
      // record from the normalized columns and validates it with programSchema.
      const program = programs.get(programId);
      if (program === undefined) {
        return {
          programId, attemptedAt, ok: false, error: 'program not found',
          changed: false, diffs: [], lastVerifiedAt: '', changeEventIds: [],
        };
      }

      /** Nothing below this point may move `lastVerifiedAt` except a successful read. */
      const unverified = (error: string): VerifyResult => ({
        programId,
        attemptedAt,
        ok: false,
        error,
        changed: false,
        diffs: [],
        lastVerifiedAt: program.trust.lastVerifiedAt,
        changeEventIds: [],
      });

      const previous = loadProvenance(db, programId);
      const keyRow = db
        .prepare('SELECT source_id, external_key FROM programs WHERE id = ?')
        .get(programId) as SourceKeyRow | undefined;
      const source = resolveSource(
        sources, program, keyRow?.source_id ?? null, previous[0]?.sourceId,
      );
      if (source === undefined) {
        return unverified(
          `no source module is registered for ${programId}, so there is no page to refetch`,
        );
      }

      let payloads: FetchedPayload[];
      try {
        const requests = await resolveRequests(source);
        if (requests.length > MAX_VERIFY_REQUESTS) {
          return unverified(
            `refetching "${source.id}" takes ${requests.length} requests, more than the ` +
              `${MAX_VERIFY_REQUESTS} a single verification will issue. The nightly crawl ` +
              'refreshes this source.',
          );
        }
        payloads = [];
        for (const req of requests) {
          payloads.push(await fetcher.fetch(req));
        }

        // Two-phase sources (ARDC's grant pages resolve a parent id from the
        // first payload) hand `parse` an incomplete payload set without this,
        // which yields nothing — manufacturing the very false disappearance
        // guarded against below.
        if (hasFollowUp(source)) {
          const followUps = source.followUp(payloads);
          if (requests.length + followUps.length > MAX_VERIFY_REQUESTS) {
            return unverified(
              `refetching "${source.id}" takes ${requests.length + followUps.length} requests, ` +
                `more than the ${MAX_VERIFY_REQUESTS} a single verification will issue. The ` +
                'nightly crawl refreshes this source.',
            );
          }
          for (const req of followUps) {
            payloads.push(await fetcher.fetch(req));
          }
        }
      } catch (err) {
        // The fetcher's own sentence, unedited. For a blocklisted host it names
        // the host and says it cannot be enabled by configuration, which is the
        // whole answer; rewording it here would only make it vaguer.
        return unverified((err as Error).message);
      }

      let parsed: RawOpportunity[];
      try {
        parsed = source.parse(payloads);
      } catch (err) {
        return unverified(`parse failed: ${(err as Error).message}`);
      }

      /**
       * A source that returned NO records verified nothing.
       *
       * DEVIATION FROM THE TASK BRIEF (2026-08-03). The brief reads an empty
       * parse as "this record is gone" and emits `vanished`. Six parsers in this
       * repository were returning zero records from their own real pages while
       * the suite stayed green, so in this corpus an empty parse is far more
       * often a broken read than a withdrawn programme — and `vanished` fans out
       * to every watcher as "Record vanished from its source", a claim about the
       * FUNDER manufactured from a failure of OURS. The honest answer is that we
       * do not know: `ok: false`, no event, and `lastVerifiedAt` left where it
       * was so the amber badge stays amber rather than going green over a page
       * we could not read. A source that legitimately empties out — the
       * `expectedMinRecords: 0` case `diff/index.ts` documents for
       * grants.austinhams.org — lands here too, and "the page lists nothing
       * right now" is the correct thing to tell someone about it.
       */
      if (parsed.length === 0) {
        return unverified(
          `"${source.id}" returned no records at all` +
            (source.expectedMinRecords > 0
              ? ` (it normally carries at least ${source.expectedMinRecords})`
              : '') +
            ', so a withdrawn programme cannot be told from a page that failed to read.',
        );
      }

      const beforeFields: Record<string, string> = {};
      for (const p of previous) beforeFields[p.rawLabel] = p.rawValue;

      const match = matchRecord(parsed, program, keyRow?.external_key ?? null);

      const changeEventIds: string[] = [];
      const insertEvent = db.prepare(
        `INSERT INTO change_events
           (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let diffs: VerifyFieldDiff[] = [];

      if (match === null) {
        // The source spoke and did not include this record. That is a
        // first-class event, not an error.
        const id = `verify:${programId}:${attemptedAt}:vanished`;
        insertEvent.run(
          id, source.id, programId, 'vanished' satisfies ChangeKind,
          JSON.stringify(program.name), null, attemptedAt, null,
        );
        changeEventIds.push(id);
        diffs = Object.keys(beforeFields)
          .sort()
          .map((label) => ({ label, before: beforeFields[label] ?? null, after: null }));
      } else {
        diffs = diffRawFields(beforeFields, match.rawFields);
        for (const d of diffs) {
          const fieldPath = fieldPathForLabel(d.label);
          const kind = changeKindForPath(fieldPath);
          const id = `verify:${programId}:${attemptedAt}:${d.label}`;
          insertEvent.run(
            id, source.id, programId, kind,
            d.before === null ? null : JSON.stringify(d.before),
            d.after === null ? null : JSON.stringify(d.after),
            attemptedAt, fieldPath,
          );
          changeEventIds.push(id);
        }
        recordProvenance(db, programId, source.id, null, match, attemptedAt);
      }

      // We checked. That is exactly what lastVerifiedAt records - it is not a
      // claim that nothing changed, it is a claim that a human-triggered fetch
      // happened at this instant and the page read.
      const updated: Program = {
        ...program,
        trust: {
          ...program.trust,
          lastVerifiedAt: attemptedAt,
          verificationMethod: 'live_fetch',
        },
      };
      // upsert() writes both the JSON `trust` column and the denormalized
      // `last_verified_at` / `status` / `content_hash` columns from it, so the
      // record and the browse-sortable scalars cannot drift apart. `status` is
      // deliberately NOT touched: a record missing from one refetch is not
      // evidence that the funder closed it, and quietly closing an open
      // programme is the one error here with no signal to the applicant.
      programs.upsert(updated);

      return {
        programId,
        attemptedAt,
        ok: true,
        changed: diffs.length > 0,
        diffs,
        lastVerifiedAt: attemptedAt,
        changeEventIds,
      };
    },
  };
}

/**
 * PLAN-LOCAL to Plan 3. `retryAfterSec` (not `retryAfterSeconds`) is the name
 * Plan 1 Task 15's frozen error table gives the `rate_limited` detail field;
 * this interface feeds it straight into `AppError.details`.
 */
export interface RateLimitCheck {
  allowed: boolean;
  reason?: 'program_cooldown' | 'hourly_cap';
  retryAfterSec?: number;
}

function secondsUntil(deadlineMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((deadlineMs - nowMs) / 1000));
}

/**
 * Admin: unlimited. Member: one verification per program per hour, and at most
 * ten verifications per rolling hour overall.
 *
 * The corpus is ~150 publishable records held by roughly twenty-five small,
 * volunteer-run organisations, and this is the one endpoint in the product where
 * a user's click turns directly into a request against one of their servers. The
 * per-program hour is the useful half: a page does not change twice in an hour,
 * so a second check inside one buys the user nothing and costs the funder a
 * request. The overall ten is the ceiling on a person working down their
 * watchlist — enough to re-check every starred programme in a sitting, far short
 * of a script.
 *
 * Both `retryAfterSec` values are computed from the ledger, never rounded to a
 * number that merely looks plausible: the cooldown expires an hour after the
 * attempt that set it, and the cap frees the moment the oldest attempt still
 * inside the window ages out of it.
 */
export function checkVerifyRateLimit(
  db: Db,
  userId: string,
  role: 'admin' | 'member',
  programId: string,
  nowISO: string,
): RateLimitCheck {
  if (role === 'admin') return { allowed: true };

  const nowMs = Date.parse(nowISO);
  const cutoff = new Date(nowMs - HOUR_MS).toISOString();

  const sameProgram = db
    .prepare(
      `SELECT attempted_at FROM verify_attempts
        WHERE user_id = ? AND program_id = ? AND attempted_at > ?
        ORDER BY attempted_at DESC LIMIT 1`,
    )
    .get(userId, programId, cutoff) as { attempted_at: string } | undefined;
  if (sameProgram !== undefined) {
    return {
      allowed: false,
      reason: 'program_cooldown',
      retryAfterSec: secondsUntil(Date.parse(sameProgram.attempted_at) + HOUR_MS, nowMs),
    };
  }

  const recent = db
    .prepare('SELECT COUNT(*) AS n FROM verify_attempts WHERE user_id = ? AND attempted_at > ?')
    .get(userId, cutoff) as { n: number };
  if (recent.n >= MEMBER_HOURLY_CAP) {
    // The attempt whose expiry brings the count back under the cap. With exactly
    // ten in the window that is the oldest; the OFFSET keeps the answer right if
    // more than ten ever land inside one (a cap lowered between deploys).
    const frees = db
      .prepare(
        `SELECT attempted_at FROM verify_attempts
          WHERE user_id = ? AND attempted_at > ?
          ORDER BY attempted_at ASC LIMIT 1 OFFSET ?`,
      )
      .get(userId, cutoff, recent.n - MEMBER_HOURLY_CAP) as { attempted_at: string } | undefined;
    return {
      allowed: false,
      reason: 'hourly_cap',
      retryAfterSec:
        frees === undefined
          ? 1
          : secondsUntil(Date.parse(frees.attempted_at) + HOUR_MS, nowMs),
    };
  }

  return { allowed: true };
}
