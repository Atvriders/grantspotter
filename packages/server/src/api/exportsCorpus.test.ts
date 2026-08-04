/**
 * THE ROUTES, AGAINST THE REAL 703-RECORD CORPUS.
 *
 * `exports.test.ts` proves route behaviour against two hand-built programmes and one hand-built
 * suppressed record. That is the wrong scale for the one claim that matters most here: a
 * suppression gate which holds for `makeSuppressedProgram()` and leaks for the 553 real ones has
 * proved nothing, and Task 1 established the standard — the export with the suppressed records
 * appended must be BYTE-IDENTICAL to the export without them, not merely "free of obvious
 * leakage".
 *
 * Task 3 tested that property of `buildIcsCalendar`. This tests it of the ROUTES, which is a
 * different claim: `/api/exports/deadlines.ics` and `/calendar/:token` assemble their own
 * programme map and their own cycle list before the calendar writer ever sees them, and Task 3's
 * report says in as many words that those two handlers were the reason it put a gate inside the
 * writer. Four layers now gate this boundary; this file is what proves the outermost one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import type { Cycle, Program } from '@grantspotter/core';
import { createCalendarFeedRouter, createExportsRouter, type ExportDeps } from './exports.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { ExportDataSource } from '../exports/dataSource.js';
import { loadExportCorpus, type ExportCorpus } from '../exports/testCorpus.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import { hashIcsToken } from '../exports/token.js';

let corpus: ExportCorpus;
let allCycles: Cycle[];
/**
 * Cycles pointing at suppressed programmes. The suppressed corpus projects NONE of its own — a
 * record only gets cycles written when it publishes — so appending the records alone would prove
 * nothing. These model the real hazard: a record reclassified `do_not_publish` after its cycles
 * were already in the table, which is exactly the state an unfiltered `listPrograms()` would hand
 * to these handlers.
 */
let planted: Cycle[];
let suppressedVisible = false;

let server: Server;
let base: string;
let token: string;

function source(): ExportDataSource {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE funders (id TEXT PRIMARY KEY, name TEXT, homepage TEXT)');
  const hashes = new Map<string, string>();
  return {
    listPrograms: (): Program[] =>
      suppressedVisible ? [...corpus.programs, ...corpus.suppressedPrograms] : [...corpus.programs],
    listFunders: () => corpus.funders,
    listCycles: (): Cycle[] => (suppressedVisible ? [...allCycles, ...planted] : [...allCycles]),
    getProfile: () => undefined,
    // Empty on purpose: an empty watchlist means "the whole corpus" on the feed, which is the
    // widest — and therefore the most dangerous — shape the gate has to hold for.
    listWatchedProgramIds: () => [],
    getUserIdForTokenHash: (hash) => (hashes.get('u-1') === hash ? 'u-1' : undefined),
    upsertToken: (userId, hash) => {
      hashes.set(userId, hash);
    },
    revokeToken: (userId) => {
      hashes.delete(userId);
    },
    getTokenHash: (userId) => hashes.get(userId),
    rawDb: () => db,
  };
}

beforeAll(async () => {
  corpus = await loadExportCorpus();
  allCycles = [...corpus.cyclesByProgramId.values()].flat();
  planted = corpus.suppressedPrograms.map((p, i) => ({
    ...allCycles[i % allCycles.length],
    id: `${p.id}:planted`,
    programId: p.id,
  }));

  const data = source();
  token = 'a-fixed-token-for-this-suite-only-not-a-secret';
  data.upsertToken('u-1', hashIcsToken(token), corpus.now);

  const deps: ExportDeps = {
    data,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    now: () => corpus.now,
    userIdOf: () => 'u-1',
    publicBaseUrl: () => 'http://127.0.0.1:3030',
  };

  const app = express();
  app.use(requestIdMiddleware());
  app.use(express.json());
  app.use('/api', createExportsRouter(deps));
  // A window wide enough that this suite's own repeated fetches never trip the limiter — the
  // limiter itself is proved in exports.test.ts.
  app.use('/', createCalendarFeedRouter(deps, {
    windowMs: 60_000,
    maxPerWindow: 1_000,
    maxMissesPerWindow: 1_000,
  }));
  app.use(errorHandler({ logger: () => undefined }));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function body(path: string, withSuppressed: boolean): Promise<string> {
  suppressedVisible = withSuppressed;
  try {
    const res = await fetch(`${base}${path}`);
    expect(res.status, path).toBe(200);
    return await res.text();
  } finally {
    suppressedVisible = false;
  }
}

describe('the real corpus, through the export routes', () => {
  it('is the corpus every other export suite measures: 150 publishable, 553 hidden, 243 cycles', () => {
    expect(corpus.programs).toHaveLength(150);
    expect(corpus.suppressedPrograms).toHaveLength(553);
    expect(allCycles).toHaveLength(243);
    expect(planted).toHaveLength(553);
  });

  it('writes 150 rows to the opportunity CSV', async () => {
    const csv = await body('/api/exports/opportunities.csv', false);
    // BOM + header + 150 rows + trailing terminator.
    expect(csv.split('\r\n')).toHaveLength(152);
  });

  it('writes one VEVENT per projected cycle on the one-off download', async () => {
    const ics = await body('/api/exports/deadlines.ics', false);
    expect(ics.split('BEGIN:VEVENT').length - 1).toBe(243);
  });

  it('writes the same 243 events on the subscribable feed', async () => {
    const feed = await body(`/calendar/${token}.ics`, false);
    expect(feed.split('BEGIN:VEVENT').length - 1).toBe(243);
  });
});

describe('no route leaks a suppressed record, at corpus scale', () => {
  const PATHS = [
    '/api/exports/opportunities.csv',
    '/api/exports/deadlines.ics',
    '/api/exports/deadlines.ics?watched=1',
  ];

  it.each(PATHS)(
    'is byte-identical with all 553 suppressed records and 553 cycles pointing at them: %s',
    async (path) => {
      const clean = await body(path, false);
      const mixed = await body(path, true);
      expect(mixed.length, path).toBe(clean.length);
      expect(mixed, path).toBe(clean);
    },
    180_000,
  );

  it('is byte-identical on the subscribable feed, which is the one with no session', async () => {
    const clean = await body(`/calendar/${token}.ics`, false);
    const mixed = await body(`/calendar/${token}.ics`, true);
    expect(mixed.length).toBe(clean.length);
    expect(mixed).toBe(clean);
  }, 180_000);

  it('writes no suppressed id, name or tag into any of the bytes', async () => {
    const publishableNames = new Set(corpus.programs.map((p) => p.name));
    for (const path of [...PATHS, `/calendar/${token}.ics`]) {
      const text = await body(path, true);
      expect(
        corpus.suppressedPrograms.filter((p) => text.includes(p.id)).map((p) => p.id),
        path,
      ).toEqual([]);
      expect(
        corpus.suppressedPrograms
          .filter((p) => !publishableNames.has(p.name))
          .filter((p) => text.includes(p.name))
          .map((p) => p.name),
        path,
      ).toEqual([]);
      expect(text, path).not.toContain(DO_NOT_PUBLISH_TAG);
      expect(text, path).not.toContain(':planted');
    }
  }, 180_000);

  /**
   * farweb.org was the Foundation for Amateur Radio; the domain 301s to an Indonesian gambling
   * site while ARRL, QCWA and club pages still tell applicants to "apply at the FAR website". The
   * corpus keeps a publishable SAFETY WARNING record to intercept that instruction, and no export
   * may repeat the host itself. The calendar is the sharpest case: a URL in a VEVENT is a link a
   * phone will happily open.
   */
  it('never writes the hijacked host into a calendar a phone will subscribe to', async () => {
    for (const path of ['/api/exports/deadlines.ics', `/calendar/${token}.ics`]) {
      const text = await body(path, true);
      expect(text, path).not.toMatch(/farweb\.org/i);
      expect(text, path).not.toMatch(/batualam/i);
    }
  }, 180_000);
});
