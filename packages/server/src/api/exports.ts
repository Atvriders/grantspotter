import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { Cycle, Program } from '@grantspotter/core';
import { AppError } from './errors.js';
import { asyncHandler } from './asyncHandler.js';
import { createRateLimiter, type RateLimiter } from '../auth/rateLimit.js';
import { assertExportReady, getApplication } from '../db/repositories/applications.js';
import type { ApplicationRow } from '../db/repositories/applications.js';
import type { ExportDataSource } from '../exports/dataSource.js';
import { applyExportFilter, exportablePrograms, parseExportFilter } from '../exports/filter.js';
import { CSV_UTF8_BOM, programsToCsvFile } from '../exports/csv.js';
import { programsToXlsx } from '../exports/xlsx.js';
import { buildIcsCalendar } from '../exports/ics.js';
import { buildEligibilityReport, eligibilityReportToCsv } from '../exports/eligibility.js';
import { renderEligibilityReportHtml } from '../exports/html.js';
import { markdownToDraft, draftToMarkdown } from '../exports/draft.js';
import { draftToDocx } from '../exports/docx.js';
import { buildApplicationPacket } from '../exports/zip.js';
import type { BudgetLine } from '../exports/packet.js';
import {
  DERIVED_TABLES,
  NEVER_BACKED_UP_TABLES,
  exportBackup,
  restoreBackup,
  type RestoreResult,
} from '../exports/json.js';
import { hashIcsToken, newIcsToken } from '../exports/token.js';

/** PLAN-LOCAL. */
export interface ExportDeps {
  data: ExportDataSource;
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  now(): string;
  userIdOf(req: Request): string | undefined;
  publicBaseUrl(req: Request): string;
}

/**
 * PLAN-LOCAL, and an addition to the task brief's interface list. The subscribable feed is the
 * only route in this file an unauthenticated stranger can reach, so it is the only one that needs
 * a limiter — and a limiter whose numbers cannot be lowered in a test is a limiter nobody proves.
 * Production passes nothing and takes the defaults below; `exports.test.ts` passes tight numbers.
 * Same shape as `createTemplatesRouter`'s optional `templatesRoot` seam (Plan 4).
 */
export interface FeedLimits {
  windowMs: number;
  /** Fetches of a VALID token, per window. A calendar client polls twice a day. */
  maxPerWindow: number;
  /** Fetches that matched no live token, per source address, per window. */
  maxMissesPerWindow: number;
}

/**
 * Generous for a subscriber, useless for a scraper. RFC 5545 clients honour the `REFRESH-INTERVAL`
 * / `X-PUBLISHED-TTL` of PT12H this calendar advertises; even a client that ignores both and polls
 * every minute stays under 60 in ten minutes. The miss budget is much tighter because a miss is
 * either a typo or a guess, and 256 bits of token is not something anyone guesses in twenty tries.
 */
const DEFAULT_FEED_LIMITS: FeedLimits = {
  windowMs: 10 * 60 * 1000,
  maxPerWindow: 60,
  maxMissesPerWindow: 20,
};

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function windowAround(nowISO: string): { from: string; to: string } {
  const now = Date.parse(nowISO);
  return {
    from: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    to: new Date(now + ONE_YEAR_MS * 2).toISOString().slice(0, 10),
  };
}

function cyclesByProgram(deps: ExportDeps, nowISO: string): Map<string, Cycle[]> {
  const { from, to } = windowAround(nowISO);
  const map = new Map<string, Cycle[]>();
  for (const cycle of deps.data.listCycles(from, to)) {
    const list = map.get(cycle.programId) ?? [];
    list.push(cycle);
    map.set(cycle.programId, list);
  }
  return map;
}

function attach(res: Response, filename: string, contentType: string): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
}

function stamp(nowISO: string): string {
  return nowISO.slice(0, 10);
}

const budgetLineSchema = z.object({
  item: z.string(),
  category: z.string(),
  quantity: z.number(),
  unitCost: z.number(),
  justification: z.string(),
  quoteSource: z.string(),
});

/**
 * PLAN-LOCAL. `applicationId` is required and the draft text is read from that row, never from the
 * request body: spec §10.4's fact checklist has to gate the export itself, not the browser button
 * in front of it. `subtitle` is the only cosmetic field the caller may set. zod strips unknown
 * keys, so a body carrying its own `markdown` is not merely ignored — it never reaches this code.
 */
const draftBodySchema = z.object({
  applicationId: z.string().min(1),
  programId: z.string().min(1),
  subtitle: z.string().optional(),
  budgetLines: z.array(budgetLineSchema).optional(),
});

type DraftBody = z.infer<typeof draftBodySchema>;

/**
 * DEVIATION FROM THE TASK BRIEF. The brief maps Plan 4's failures by reading a `status` number off
 * the thrown value and building a NEW `AppError` from its message. Plan 4 does not throw a plain
 * `Object.assign(new Error(msg), { status })`; `assertExportReady` throws `AppError` itself, with
 * `details` carrying `{ unconfirmed, openTodos, rawSlots, rawSlotPaths }` — which is the only way
 * the UI can say WHICH gap blocks the export instead of "something is unconfirmed". Rebuilding the
 * error silently drops that payload. So an `AppError` is passed straight through, and only a
 * genuinely foreign throw is wrapped.
 */
function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const status = (error as { status?: number }).status;
  const message = error instanceof Error ? error.message : 'export failed';
  if (status === 409) return new AppError('conflict', message);
  if (status === 404) return new AppError('not_found', message);
  return new AppError('internal', message);
}

/**
 * What a restore actually did, in a sentence an administrator can act on.
 *
 * THIS EXISTS BECAUSE TWO EARLIER CLAIMS IN THIS PROJECT WERE FALSE. The restore copy said "browse
 * index was rebuilt" while nothing in the restore path reindexed anything, and the admin copy said
 * "every table except sessions" while `schema_migrations` and the two derived browse tables are
 * excluded as well — for three different reasons, all of which matter. `programsReindexed === null`
 * means "this schema has no browse projection to rebuild", which is NOT `0`: "could not rebuild"
 * and "rebuilt nothing" are different sentences and only one of them is a reason to worry.
 */
function summarise(result: RestoreResult): string {
  const parts = [
    `Restored ${String(result.rowsRestored)} row(s) across ${String(result.tablesRestored.length)} table(s).`,
    result.programsReindexed === null
      ? 'The browse index could not be rebuilt: this database has no browse projection ' +
        `(${DERIVED_TABLES.join(', ')}).`
      : `Browse index rebuilt for ${String(result.programsReindexed)} programme(s).`,
    `Not included in a backup: ${NEVER_BACKED_UP_TABLES.join(', ')} — restoring live sessions ` +
      'would resurrect signed-in browsers out of a file, and the migration ledger belongs to the ' +
      `TARGET database. ${DERIVED_TABLES.join(' and ')} are derived from programs and are rebuilt, ` +
      'never imported.',
  ];
  if (result.tablesSkipped.length > 0) {
    parts.push(
      `This build has no table named ${result.tablesSkipped.join(', ')}, so that data did NOT land.`,
    );
  }
  if (result.rowsSkipped > 0) {
    parts.push(`${String(result.rowsSkipped)} row(s) had no column this schema recognises.`);
  }
  return parts.join(' ');
}

export function createExportsRouter(deps: ExportDeps): Router {
  const router = Router();

  router.get('/exports/opportunities.csv', deps.requireAuth, (req, res) => {
    const now = deps.now();
    const cycles = cyclesByProgram(deps, now);
    const programs = applyExportFilter(
      deps.data.listPrograms(),
      parseExportFilter(req.query as Record<string, unknown>),
      cycles,
    );
    attach(res, `grantspotter-opportunities-${stamp(now)}.csv`, 'text/csv; charset=utf-8');
    res.send(programsToCsvFile(programs, deps.data.listFunders(), cycles));
  });

  router.get(
    '/exports/opportunities.xlsx',
    deps.requireAuth,
    asyncHandler(async (req, res) => {
      const now = deps.now();
      const cycles = cyclesByProgram(deps, now);
      const programs = applyExportFilter(
        deps.data.listPrograms(),
        parseExportFilter(req.query as Record<string, unknown>),
        cycles,
      );
      const buffer = await programsToXlsx(programs, deps.data.listFunders(), cycles);
      attach(
        res,
        `grantspotter-opportunities-${stamp(now)}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.send(buffer);
    }),
  );

  const eligibility = (req: Request): ReturnType<typeof buildEligibilityReport> | undefined => {
    const userId = deps.userIdOf(req);
    if (userId === undefined) return undefined;
    const profile = deps.data.getProfile(userId);
    if (profile === undefined) return undefined;
    const now = deps.now();
    const cycles = cyclesByProgram(deps, now);
    const programs = applyExportFilter(
      deps.data.listPrograms(),
      parseExportFilter(req.query as Record<string, unknown>),
      cycles,
    );
    return buildEligibilityReport(profile, programs, deps.data.listFunders(), cycles, now);
  };

  const NO_PROFILE = 'Set up a profile first; there is nothing to match against.';

  router.get('/exports/eligibility.csv', deps.requireAuth, (req, res, next) => {
    const report = eligibility(req);
    if (report === undefined) {
      next(new AppError('conflict', NO_PROFILE));
      return;
    }
    attach(res, `grantspotter-eligibility-${stamp(deps.now())}.csv`, 'text/csv; charset=utf-8');
    // Same BOM decision as the opportunity CSV, for the same Excel-on-Windows reason.
    res.send(CSV_UTF8_BOM + eligibilityReportToCsv(report));
  });

  router.get('/exports/eligibility.html', deps.requireAuth, (req, res, next) => {
    const report = eligibility(req);
    if (report === undefined) {
      next(new AppError('conflict', NO_PROFILE));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderEligibilityReportHtml(report));
  });

  /**
   * The programme map a calendar is built from.
   *
   * `exportablePrograms` FIRST, and unconditionally. The CSV and XLSX routes above reach the gate
   * through `applyExportFilter`; the two calendar routes have no such filter, which is precisely
   * what Task 3's report flagged. `buildIcsCalendar` gates again and `cycleToVevent` gates a third
   * time, and `createSqliteExportDataSource.listPrograms` gates before any of them — four layers
   * for one boundary is not paranoia here, it is the count of times this boundary has leaked.
   */
  const calendarPrograms = (watched?: ReadonlySet<string>): Map<string, Program> => {
    const publishable = exportablePrograms(deps.data.listPrograms());
    const chosen =
      watched === undefined ? publishable : publishable.filter((p) => watched.has(p.id));
    return new Map(chosen.map((p) => [p.id, p]));
  };

  const calendarFor = (
    programsById: ReadonlyMap<string, Program>,
    calendarName: string,
    nowISO: string,
  ): string => {
    const { from, to } = windowAround(nowISO);
    const cycles = deps.data.listCycles(from, to).filter((c) => programsById.has(c.programId));
    return buildIcsCalendar({ calendarName, cycles, programsById, nowISO });
  };

  router.get('/exports/deadlines.ics', deps.requireAuth, (req, res) => {
    const now = deps.now();
    const userId = deps.userIdOf(req);
    const watchedOnly = req.query.watched === '1' && userId !== undefined;
    const watched = watchedOnly
      ? new Set(deps.data.listWatchedProgramIds(userId as string))
      : undefined;
    attach(res, `grantspotter-deadlines-${stamp(now)}.ics`, 'text/calendar; charset=utf-8');
    res.send(
      calendarFor(
        calendarPrograms(watched),
        watchedOnly ? 'GrantSpotter watchlist' : 'GrantSpotter deadlines',
        now,
      ),
    );
  });

  /**
   * DEVIATION FROM THE TASK BRIEF: this answers `{ hasToken: true }` and NOT a `url`.
   *
   * The brief returns `{ url: '…/calendar/<your token>.ics', hasToken: true }`. That string is not
   * a URL — pasting it into a calendar client subscribes to nothing — and a field named `url`
   * whose value does not work is worse than an absent field. It cannot be made real, either: only
   * the SHA-256 of the token is stored, deliberately, so the plaintext is unrecoverable after the
   * POST that minted it. That is the design, not a gap: a feed URL that the server could reprint
   * on demand is a feed URL that a database dump hands out.
   *
   * Task 10's client reads `{ hasToken: boolean }` from this route and nothing else.
   */
  router.get('/exports/ics-token', deps.requireAuth, (req, res, next) => {
    const userId = deps.userIdOf(req);
    if (userId === undefined) {
      next(new AppError('unauthorized', 'Not signed in.'));
      return;
    }
    if (deps.data.getTokenHash(userId) === undefined) {
      next(new AppError('not_found', 'No calendar feed has been created for this account yet.'));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ hasToken: true });
  });

  router.post('/exports/ics-token', deps.requireAuth, (req, res, next) => {
    const userId = deps.userIdOf(req);
    if (userId === undefined) {
      next(new AppError('unauthorized', 'Not signed in.'));
      return;
    }
    const token = newIcsToken();
    deps.data.upsertToken(userId, hashIcsToken(token), deps.now());
    // The plaintext token is shown exactly once; only its hash is stored. Creating again ROTATES:
    // one row per user, so the previous URL stops working the moment this responds.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ url: `${deps.publicBaseUrl(req)}/calendar/${token}.ics`, token });
  });

  router.delete('/exports/ics-token', deps.requireAuth, (req, res) => {
    const userId = deps.userIdOf(req);
    if (userId !== undefined) deps.data.revokeToken(userId, deps.now());
    res.status(204).end();
  });

  /**
   * THE EXPORT GATE. The draft text, title, fact confirmations and disclosure flag all come from
   * the `applications` row; `assertExportReady` throws 409 while any factual assertion is
   * unconfirmed, any `[TODO: …]` marker survives, or any raw `{{slot.path}}` remains. A zod
   * failure here surfaces as 422 through Plan 1's errorHandler, which understands ZodError.
   */
  const readDraft = (
    req: Request,
  ): {
    application: ApplicationRow;
    program: Program;
    draft: ReturnType<typeof markdownToDraft>;
    lines: BudgetLine[];
  } => {
    const body: DraftBody = draftBodySchema.parse(req.body ?? {});
    const userId = deps.userIdOf(req);
    if (userId === undefined) throw new AppError('unauthorized', 'Not signed in.');

    // `exportablePrograms`, not `listPrograms`: a suppressed record is not an opportunity anybody
    // may build an application packet around, and it must read as absent rather than as refused.
    const program = exportablePrograms(deps.data.listPrograms()).find((p) => p.id === body.programId);
    if (program === undefined) {
      throw new AppError('bad_request', `Unknown programId "${body.programId}".`);
    }

    const db = deps.data.rawDb();
    const application = getApplication(db, body.applicationId, userId);
    if (application === undefined) throw new AppError('not_found', 'No such application draft.');

    try {
      assertExportReady(db, body.applicationId, userId);
    } catch (error) {
      throw toAppError(error);
    }

    const draft = markdownToDraft(application.bodyMarkdown, {
      title: application.title.length > 0 ? application.title : program.name,
      subtitle: body.subtitle,
      factChecklist: Object.values(application.factConfirmations)
        .filter((c) => c.note.trim().length > 0)
        .map((c) => c.note.trim()),
      disclosure: application.includeDisclosure
        ? 'Portions of this application were drafted with the assistance of a large language ' +
          'model; every fact was verified by the applicant.'
        : undefined,
      provenanceNote:
        `Generated by GrantSpotter on ${stamp(deps.now())}. Source: ${program.trust.sourceUrl} ` +
        `(last verified ${program.trust.lastVerifiedAt}). Every figure in this document is the ` +
        "applicant's responsibility.",
    });
    return { application, program, draft, lines: body.budgetLines ?? [] };
  };

  router.post(
    '/exports/draft.docx',
    deps.requireAuth,
    asyncHandler(async (req, res) => {
      const parsed = readDraft(req);
      const buffer = await draftToDocx(parsed.draft);
      attach(
        res,
        `grantspotter-draft-${parsed.application.id}.docx`,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      res.send(buffer);
    }),
  );

  // Spec §11.3 lists the application draft as "DOCX, Markdown". Same row, same gate.
  router.post('/exports/draft.md', deps.requireAuth, (req, res) => {
    const parsed = readDraft(req);
    attach(res, `grantspotter-draft-${parsed.application.id}.md`, 'text/markdown; charset=utf-8');
    res.send(draftToMarkdown(parsed.draft));
  });

  router.post(
    '/exports/packet.zip',
    deps.requireAuth,
    asyncHandler(async (req, res) => {
      const parsed = readDraft(req);
      const funder = deps.data.listFunders().find((f) => f.id === parsed.program.funderId);
      const zip = await buildApplicationPacket({
        program: parsed.program,
        funder,
        draft: parsed.draft,
        budgetLines: parsed.lines,
        generatedAtISO: deps.now(),
      });
      attach(res, `grantspotter-packet-${parsed.program.id}.zip`, 'application/zip');
      res.send(Buffer.from(zip));
    }),
  );

  router.get('/admin/backup.json', deps.requireAuth, deps.requireAdmin, (_req, res) => {
    const now = deps.now();
    const backup = exportBackup(deps.data.rawDb(), now);
    attach(res, `grantspotter-backup-${stamp(now)}.json`, 'application/json; charset=utf-8');
    res.send(JSON.stringify(backup));
  });

  router.post('/admin/restore', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    try {
      // `deps.now()` rather than `restoreBackup`'s internal `new Date()`: the reindex it runs
      // stamps `program_search`, and the one clock in this process is the injected one.
      const result = restoreBackup(deps.data.rawDb(), req.body, deps.now());
      res.json({ ...result, summary: summarise(result) });
    } catch (error) {
      next(new AppError('bad_request', error instanceof Error ? error.message : 'Restore failed.'));
    }
  });

  return router;
}

export function createCalendarFeedRouter(deps: ExportDeps, limits?: FeedLimits): Router {
  const router = Router();
  const config = limits ?? DEFAULT_FEED_LIMITS;

  /**
   * TWO BUCKETS, CHARGED BEFORE THE WORK, NEVER REFUNDED.
   *
   * `createRateLimiter` counts "failures" in a sliding window; here every attempt is recorded as
   * one, which is what turns a failure counter into a request limiter. Plan 3 Task 10's precedent
   * is explicit about the order: charge the attempt BEFORE doing the work and never refund on
   * failure, because a limiter an attacker turns off by succeeding — or by causing an error — is
   * decorative.
   *
   * The buckets are keyed differently on purpose. A VALID token is charged against the token, so
   * one leaked URL cannot be pointed at this process as an amplifier while every other subscriber
   * keeps working. A MISS is charged against the source address, because a miss carries no
   * identity to charge and the thing being limited is somebody trying tokens.
   */
  const byToken: RateLimiter = createRateLimiter({
    windowMs: config.windowMs,
    maxFailures: config.maxPerWindow,
  });
  const byAddress: RateLimiter = createRateLimiter({
    windowMs: config.windowMs,
    maxFailures: config.maxMissesPerWindow,
  });

  const refuse = (res: Response, retryAfterSec: number): AppError => {
    res.setHeader('Retry-After', String(retryAfterSec));
    return new AppError('rate_limited', 'Too many calendar requests. Try again later.', {
      retryAfterSec,
    });
  };

  // No inline regex in the path: Express 5's path-to-regexp v8 rejects it, and this must work
  // identically on the Express 4 this project ships. The handler strips a trailing `.ics` so both
  // /calendar/<t> and /calendar/<t>.ics work — a calendar client will append either.
  router.get('/calendar/:token', (req, res, next) => {
    const raw = String(req.params.token ?? '');
    const token = raw.endsWith('.ics') ? raw.slice(0, -4) : raw;
    const hash = hashIcsToken(token);

    // A public URL must not be cached by an intermediary, indexed by a crawler that meets it, or
    // handed onward as a Referer. Set before the lookup, so a 404 and a 429 carry them too.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const address = req.ip ?? 'unknown';
    const addressBudget = byAddress.check(address);
    if (!addressBudget.allowed) {
      next(refuse(res, addressBudget.retryAfterSec));
      return;
    }

    const userId = deps.data.getUserIdForTokenHash(hash);
    if (userId === undefined) {
      // Charged to the address, not the token: there is no token to charge.
      byAddress.recordFailure(address);
      // Deliberately the same answer for "never existed" and "revoked": a calendar client is an
      // unauthenticated caller and must not learn which of the two it is.
      next(new AppError('not_found', 'No calendar feed matches this token.'));
      return;
    }

    const tokenBudget = byToken.check(hash);
    if (!tokenBudget.allowed) {
      next(refuse(res, tokenBudget.retryAfterSec));
      return;
    }
    byToken.recordFailure(hash);

    const now = deps.now();
    // THE GATE, again. See `calendarPrograms` above: this is the least recoverable surface in the
    // product, and the one route here with no session behind it.
    const publishable = exportablePrograms(deps.data.listPrograms());
    const watched = new Set(deps.data.listWatchedProgramIds(userId));
    // An empty watchlist means "everything", not "nothing": a user who subscribes before starring
    // anything must get a calendar, not an empty one they will assume is broken.
    const chosen = watched.size > 0 ? publishable.filter((p) => watched.has(p.id)) : publishable;
    const programsById = new Map(chosen.map((p) => [p.id, p]));
    const { from, to } = windowAround(now);
    const cycles = deps.data.listCycles(from, to).filter((c) => programsById.has(c.programId));

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.send(buildIcsCalendar({ calendarName: 'GrantSpotter', cycles, programsById, nowISO: now }));
  });

  return router;
}
