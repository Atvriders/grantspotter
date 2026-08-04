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
/**
 * The subscriber's watchlist, mutable because the defect this file now pins is a COMPOSED one:
 * starring a programme used to rewrite a calendar that was already subscribed to. A fixture that
 * can only be empty cannot express "and then the user starred something".
 */
let watching: string[] = [];

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
    // Empty by default, because the widest shape is the most dangerous one for the gate to hold
    // for: with nothing starred the plain feed carries all 150 publishable records.
    listWatchedProgramIds: () => [...watching],
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

/**
 * THE COMPOSED DEFECT, AT CORPUS SCALE.
 *
 * Star and feed were each correct alone, which is why every suite above passed while the product
 * was broken. Composed, they were not: `/calendar/<token>.ics` served the whole corpus while the
 * watchlist was empty and only the watched programmes as soon as it was not, from a URL that never
 * changed. Measured here on this corpus before the fix: **243 VEVENTs, then 5, from the same
 * unchanged URL, after starring one programme** — and 5 only because the programme starred below is
 * the widest record in the corpus. The distribution of events per publishable programme is
 * {5:1, 4:1, 2:114, 1:6, 0:28}, so the typical star left 2 (which is Task 22's measured figure) and
 * six of them left 1. That is 238 to 242 deadlines vanishing out of a subscriber's phone overnight
 * with nothing on screen to explain it — the worst failure a deadline tool can have, because it is
 * both silent and remote.
 *
 * The rule now: a feed URL's meaning is fixed by the URL, never by the watchlist behind it.
 */
describe('starring a programme cannot rewrite a calendar already subscribed to', () => {
  const veventCount = (ics: string): number => ics.split('BEGIN:VEVENT').length - 1;

  /** Unfolded first: RFC 5545 breaks a long property line, and an id can land across the break. */
  const eventsNaming = (ics: string, programId: string): number =>
    ics.replace(/\r\n /g, '').split(`X-GRANTSPOTTER-PROGRAM-ID:${programId}\r\n`).length - 1;

  /**
   * The publishable programme with the most projected windows in this corpus (5 of the 243), so
   * "the watchlist feed narrowed to exactly this programme" is a claim with more than one event
   * behind it, and so the two counts either side of the star are not both small numbers.
   */
  const STARRED = 'ardc-grants--apply--b04e6201';

  it('serves the identical bytes from the plain URL before and after a programme is starred', async () => {
    const before = await body(`/calendar/${token}.ics`, false);
    watching = [STARRED];
    let after: string;
    try {
      after = await body(`/calendar/${token}.ics`, false);
    } finally {
      watching = [];
    }

    expect(veventCount(before)).toBe(243);
    // Not "roughly the same": nothing about the corpus, the clock or the token changed, so the
    // only honest assertion is that the file did not change either.
    expect(veventCount(after)).toBe(243);
    expect(after).toBe(before);
  });

  it('serves the starred programme ONLY from the opt-in URL, and an empty calendar from it while nothing is starred', async () => {
    // An empty watchlist on the opt-in URL means an empty calendar, NOT a silent fallback to the
    // whole corpus. The size of the watchlist may never decide what a URL means.
    const nothingStarred = await body(`/calendar/${token}.ics?watched=1`, false);
    expect(veventCount(nothingStarred)).toBe(0);

    watching = [STARRED];
    let oneStarred: string;
    try {
      oneStarred = await body(`/calendar/${token}.ics?watched=1`, false);
    } finally {
      watching = [];
    }

    const plain = await body(`/calendar/${token}.ics`, false);
    const expected = eventsNaming(plain, STARRED);
    expect(expected).toBeGreaterThan(1);
    expect(veventCount(oneStarred)).toBe(expected);
    expect(eventsNaming(oneStarred, STARRED)).toBe(expected);
  });

  /** The two subscriptions must be tellable apart in a client that shows both at once. */
  it('names the two feeds differently, so a client showing both can label them', async () => {
    expect(await body(`/calendar/${token}.ics`, false)).toContain('X-WR-CALNAME:GrantSpotter deadlines');
    expect(await body(`/calendar/${token}.ics?watched=1`, false)).toContain(
      'X-WR-CALNAME:GrantSpotter watchlist',
    );
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

  /**
   * THE WATCHED SCOPE, WITH SOMETHING ACTUALLY IN IT. `?watched=1` narrows to the watchlist, so
   * every watched row in this block runs against the default empty one — two empty calendars, which
   * stay byte-identical however the gate behaves, and assert nothing whatever about suppression.
   * Starring all 703 records is the arrangement in which the gate is the only difference between
   * the two files: the 243 publishable events must all survive it and the 553 hidden ones must not
   * appear, on the download and on the feed alike.
   */
  it('is byte-identical on both watched surfaces when all 703 records are starred', async () => {
    watching = [...corpus.programs, ...corpus.suppressedPrograms].map((p) => p.id);
    try {
      for (const path of [
        '/api/exports/deadlines.ics?watched=1',
        `/calendar/${token}.ics?watched=1`,
      ]) {
        const clean = await body(path, false);
        const mixed = await body(path, true);
        // Not an empty calendar this time, which is what makes the two comparisons below mean
        // something: every publishable cycle is in scope on a watched URL.
        expect(clean.split('BEGIN:VEVENT').length - 1, path).toBe(243);
        expect(mixed.length, path).toBe(clean.length);
        expect(mixed, path).toBe(clean);
      }
    } finally {
      watching = [];
    }
  }, 180_000);

  /**
   * THE NEW VARIANT'S OWN HAZARD. `?watched=1` is the one feed whose contents a user chooses, and
   * a watchlist can name a record that was publishable when it was starred and `do_not_publish`
   * afterwards — the star outlives the reclassification. "The subscriber asked for it" is not a
   * reason to publish it, so the gate runs BEFORE the watch filter and this proves the order.
   */
  it('publishes nothing from either opt-in surface when every starred record is a suppressed one', async () => {
    watching = corpus.suppressedPrograms.map((p) => p.id);
    try {
      // The download as well as the feed: they take the same scope from the same query on the same
      // assembly, and a claim proved of one of them is not a claim about the other.
      for (const path of [
        '/api/exports/deadlines.ics?watched=1',
        `/calendar/${token}.ics?watched=1`,
      ]) {
        const text = await body(path, true);
        expect(text.split('BEGIN:VEVENT').length - 1, path).toBe(0);
        expect(
          corpus.suppressedPrograms.filter((p) => text.includes(p.id)).map((p) => p.id),
          path,
        ).toEqual([]);
        expect(text, path).not.toContain(DO_NOT_PUBLISH_TAG);
        expect(text, path).not.toContain(':planted');
      }
    } finally {
      watching = [];
    }
  }, 180_000);

  it('writes no suppressed id, name or tag into any of the bytes', async () => {
    const publishableNames = new Set(corpus.programs.map((p) => p.name));
    // Everything starred, for the same reason as the byte-identical pair above: on a `?watched=1`
    // URL an unstarred record is out of scope whatever the gate does, so a search of those bytes
    // for 553 ids that were never in scope is a search that cannot find anything.
    watching = [...corpus.programs, ...corpus.suppressedPrograms].map((p) => p.id);
    try {
      for (const path of [...PATHS, `/calendar/${token}.ics`, `/calendar/${token}.ics?watched=1`]) {
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
    } finally {
      watching = [];
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
