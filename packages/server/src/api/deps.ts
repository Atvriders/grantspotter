// PLAN-LOCAL to Plan 3.
import type { RequestHandler, Request } from 'express';
import type { Db } from '../db/migrate.js';

export interface SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
}

/**
 * PLAN-LOCAL to Plan 3. Structurally identical to Plan 2's `SourceRunResult`
 * (`packages/server/src/crawl/runner.ts`). It is restated rather than imported
 * so the sources router can be constructed with a fake crawl trigger in tests,
 * exactly as `RouterDeps` restates the auth seam.
 */
export interface CrawlRunSummary {
  sourceId: string;
  parsedCount: number;
  events: number;
  reviewItems: number;
  error?: string;
}

/** PLAN-LOCAL to Plan 3. The admin-only manual crawl seam (spec §12). */
export type CrawlTrigger = (sourceIds?: string[]) => Promise<CrawlRunSummary[]>;

/**
 * Everything a Plan 3 router needs, injected. The server entrypoint supplies
 * the real implementations from Plan 1's auth module; tests supply fakes.
 * No Plan 3 router imports Plan 1's auth module directly.
 */
export interface RouterDeps {
  db: Db;
  /** Injected clock. Every timestamp in Plan 3 comes from here, never Date.now(). */
  now: () => string;
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  currentUser: (req: Request) => SessionUser;
}
