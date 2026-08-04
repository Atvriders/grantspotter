import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import type { Cycle, Funder, Profile, Program } from '@grantspotter/core';
import { createApp } from '../app.js';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import { loadConfig } from '../config.js';
import { openTestDb } from '../test/testDb.js';
import { seedTestUser } from '../test/fixtures/programs.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo, withContentHash } from '../db/repositories/programs.js';
import {
  calendarPrograms,
  createCalendarFeedRouter,
  createExportsRouter,
  type ExportDeps,
  type FeedLimits,
} from './exports.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { ExportDataSource } from '../exports/dataSource.js';
import { makeCycle, makeFunder, makeProgram, makeSuppressedProgram } from '../exports/testFixtures.js';
import { hashIcsToken } from '../exports/token.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';

/**
 * DEVIATION FROM THE TASK BRIEF, forced by running its own test.
 *
 * The brief builds a `:memory:` database and hand-writes ONE table — `applications`, copied out of
 * 001-init.sql — on the stated grounds that "assertExportReady never joins one" of the others. It
 * does. `assertExportReady` → `applicationReadiness` → `applicationFactSources`, which calls
 * `createProfileRepo(db).listForUser(...)` and `createProgramRepo(db).get(...)`; against the
 * brief's fixture every draft route answers **500 `no such table: profiles`**, and the brief's own
 * "409 while unconfirmed" assertion never reaches the gate it exists to prove.
 *
 * The fix is not to hand-copy three more tables. Copying 001-init.sql's DDL into a test file is
 * exactly the drift RESOLUTIONS R24 warns about, and `programs` alone is seventeen columns plus a
 * `constraints` child that `createProgramRepo` prepares statements against at construction. So
 * this suite opens Plan 1's REAL migrated schema through `openTestDb()` — the same runner
 * production boots — and seeds it through the product's own repositories. Nothing here restates a
 * shape another file owns, `assertExportReady` runs against the schema it will really meet, and
 * the admin backup/restore routes are exercised against the real table set rather than a fixture
 * with one table in it.
 */

/** No money, no dates, no two-word proper noun: extractFactAssertions finds nothing to confirm. */
const READY_MARKDOWN = '# Need statement\n\nOur club station needs a replacement transceiver.';
/** One unconfirmed money assertion, so assertExportReady throws. */
const UNCONFIRMED_MARKDOWN = '# Budget\n\nOne transceiver at $2,899.';

const PROGRAMS: Program[] = [
  makeProgram(),
  makeProgram({
    id: 'arrl-club-grant',
    name: 'ARRL Club Grant Program',
    klass: 'ham_grant',
    tags: ['ham', 'club'],
  }),
];

/**
 * A record the product STORES and must never publish — one of the ~553. It is in this fake's
 * `listPrograms()` on purpose, behind a switch: the two ICS routes are the only exports that do
 * not go through `applyExportFilter`, so the fake has to be able to hand them the hazard.
 */
const SUPPRESSED: Program = makeSuppressedProgram();
const SUPPRESSED_CYCLE: Cycle = makeCycle({
  id: 'ardc-2019-award-11225:planted',
  programId: SUPPRESSED.id,
  closesAt: '2027-03-01',
});

const FUNDERS: Funder[] = [makeFunder()];
/**
 * TWO windows, on two different programmes. One is not enough to test the feed with: with a single
 * cycle, "every publishable deadline" and "only the one programme I starred" are the same file, and
 * the defect this suite now pins — a feed that silently narrows — is invisible in it.
 */
const CYCLES: Cycle[] = [
  makeCycle(),
  makeCycle({
    id: 'arrl-club-grant-2027-03',
    programId: 'arrl-club-grant',
    closesAt: '2027-03-15',
    label: 'Mar 2027 deadline',
  }),
];
const PROFILE: Profile = { kind: 'student', callsign: 'W8UM', licenseClass: 'GENERAL' };

interface Fake extends ExportDataSource {
  /** When true, `listPrograms`/`listCycles` also hand back the suppressed record and its cycle. */
  suppressedVisible: boolean;
  /**
   * What this user has starred, mutable so a test can star something BETWEEN two fetches of one
   * unchanged URL. A fixed watchlist cannot express the composed defect at all.
   */
  watching: string[];
}

const openDbs: Database.Database[] = [];

function fakeDataSource(): Fake {
  const tokens = new Map<string, { hash: string; revoked: boolean }>();

  // Plan 1's real migrated schema, seeded through the product's own repositories. `user-1` and the
  // `ardc-grants` row exist because `applications.user_id` and `applications.program_id` are real
  // foreign keys under `PRAGMA foreign_keys = ON`.
  const db = openTestDb();
  openDbs.push(db);
  createFunderRepo(db).upsert(makeFunder());
  createProgramRepo(db).upsert(withContentHash(makeProgram()));
  seedTestUser(db, 'user-1');

  const insertApp = db.prepare(
    `INSERT INTO applications (id, user_id, program_id, title, body_markdown, answers_json,
       fact_confirmations_json, include_disclosure, facts_confirmed_at, created_at, updated_at)
     VALUES (?, 'user-1', 'ardc-grants', ?, ?, '{}', '{}', 1, ?, '2026-08-02T12:00:00.000Z', '2026-08-02T12:00:00.000Z')`,
  );
  insertApp.run('app-ready', 'ARDC Grants Program — draft', READY_MARKDOWN, '2026-08-02T12:00:00.000Z');
  insertApp.run('app-unconfirmed', 'Unconfirmed draft', UNCONFIRMED_MARKDOWN, null);

  return {
    suppressedVisible: false,
    watching: ['ardc-grants'],
    listPrograms(): Program[] {
      return this.suppressedVisible ? [...PROGRAMS, SUPPRESSED] : [...PROGRAMS];
    },
    listFunders: () => FUNDERS,
    listCycles(): Cycle[] {
      return this.suppressedVisible ? [...CYCLES, SUPPRESSED_CYCLE] : [...CYCLES];
    },
    getProfile: () => PROFILE,
    listWatchedProgramIds(): string[] {
      return [...this.watching];
    },
    getUserIdForTokenHash: (hash) => {
      for (const [userId, rec] of tokens) if (rec.hash === hash && !rec.revoked) return userId;
      return undefined;
    },
    upsertToken: (userId, hash) => {
      tokens.set(userId, { hash, revoked: false });
    },
    revokeToken: (userId) => {
      const r = tokens.get(userId);
      if (r) r.revoked = true;
    },
    getTokenHash: (userId) => {
      const r = tokens.get(userId);
      return r && !r.revoked ? r.hash : undefined;
    },
    rawDb: () => db,
  };
}

let server: Server;
let base: string;
let data: Fake;
let role: 'member' | 'admin' = 'member';

/**
 * The real app mounts these from the mountRoutes callback in packages/server/src/index.ts, which
 * Step 9 of this task edits. This mounts them on a bare express app plus Plan 1's error handler,
 * which is what turns an AppError into the one JSON envelope — without errorHandler every
 * next(err) would surface as a 500. Because this suite does its own mounting it can never detect
 * a missing mount line; the built-server check in the task report is what can.
 */
async function startApp(
  deps: ExportDeps,
  limits?: FeedLimits,
): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(requestIdMiddleware());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createExportsRouter(deps));
  app.use('/', createCalendarFeedRouter(deps, limits));
  app.use(errorHandler({ logger: () => undefined }));
  const started = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server: started, base: `http://127.0.0.1:${(started.address() as AddressInfo).port}` };
}

function depsFor(source: ExportDataSource): ExportDeps {
  return {
    data: source,
    requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(role === 'admin' ? undefined : new AppError('forbidden', 'Administrator role required.')),
    now: () => '2026-08-02T12:00:00.000Z',
    userIdOf: () => 'user-1',
    publicBaseUrl: () => 'http://127.0.0.1:3030',
  };
}

beforeAll(async () => {
  data = fakeDataSource();
  const started = await startApp(depsFor(data));
  server = started.server;
  base = started.base;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const db of openDbs) db.close();
});

describe('opportunity exports', () => {
  it('serves CSV with a download filename', async () => {
    const res = await fetch(`${base}/api/exports/opportunities.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('grantspotter-opportunities');
    const body = await res.text();
    expect(body.split('\r\n')).toHaveLength(4); // header + 2 rows + trailing empty
  });

  /**
   * DEVIATION FROM THE TASK BRIEF: the download carries the UTF-8 BOM. `exports/csv.ts` ships
   * `programsToCsvFile` for exactly this route and says why — Excel on Windows reads a BOM-less
   * UTF-8 file in the system code page, so `ARDC’s` arrives as `ARDCâ€™s` and every en dash in the
   * corpus becomes mojibake. The BOM is a decision the DOWNLOAD path makes; `programsToCsv` stays
   * byte-pure so the format tests can assert exact output.
   */
  it('prefixes the download with the UTF-8 BOM so Excel reads it as UTF-8', async () => {
    const buf = Buffer.from(
      await (await fetch(`${base}/api/exports/opportunities.csv`)).arrayBuffer(),
    );
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('applies the query filter to the CSV', async () => {
    const body = await (await fetch(`${base}/api/exports/opportunities.csv?q=club`)).text();
    expect(body).toContain('arrl-club-grant');
    expect(body).not.toContain('ARDC Grants Program');
  });

  it('serves an xlsx workbook', async () => {
    const res = await fetch(`${base}/api/exports/opportunities.xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});

describe('eligibility exports', () => {
  it('serves the CSV report', async () => {
    const res = await fetch(`${base}/api/exports/eligibility.csv`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('verdict');
  });

  it('serves the printable HTML report', async () => {
    const res = await fetch(`${base}/api/exports/eligibility.html`);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Print / Save as PDF');
  });

  it('409s a user with no profile, rather than reporting an empty match', async () => {
    const noProfile = fakeDataSource();
    noProfile.getProfile = () => undefined;
    const alt = await startApp(depsFor(noProfile));
    try {
      const res = await fetch(`${alt.base}/api/exports/eligibility.csv`);
      expect(res.status).toBe(409);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('conflict');
    } finally {
      await new Promise<void>((resolve) => alt.server.close(() => resolve()));
    }
  });
});

describe('ICS', () => {
  it('serves a one-off calendar download', async () => {
    const res = await fetch(`${base}/api/exports/deadlines.ics`);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const body = await res.text();
    expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(body).toContain('BEGIN:VEVENT');
    // The plain URL is every publishable deadline. This fixture's watchlist holds exactly one of
    // the two programmes, so a download that read the watchlist would answer one event here.
    expect(body.split('BEGIN:VEVENT').length - 1).toBe(2);
    expect(body).toContain('X-GRANTSPOTTER-PROGRAM-ID:arrl-club-grant');
  });

  it('limits the feed to watched programs when watched=1', async () => {
    const body = await (await fetch(`${base}/api/exports/deadlines.ics?watched=1`)).text();
    expect(body).toContain('X-GRANTSPOTTER-PROGRAM-ID:ardc-grants');
    // EXCLUSION, which is the half this test was missing. The `toContain` above was the whole
    // assertion, and a download that ignored `watched=1` and returned the entire corpus satisfies
    // it just as well: it proved the starred programme was present, never that anything else was
    // absent — the only direction in which "limits" means anything.
    expect(body).not.toContain('X-GRANTSPOTTER-PROGRAM-ID:arrl-club-grant');
    expect(body.split('BEGIN:VEVENT').length - 1).toBe(1);
  });

  it('404s the token endpoint before a token exists', async () => {
    expect((await fetch(`${base}/api/exports/ics-token`)).status).toBe(404);
  });

  it('creates a token, returns a usable subscribe URL exactly once, and serves the feed', async () => {
    const created = (await (
      await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })
    ).json()) as { url: string; token: string };
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.url).toBe(`http://127.0.0.1:3030/calendar/${created.token}.ics`);
    expect(data.getUserIdForTokenHash(hashIcsToken(created.token))).toBe('user-1');

    const feed = await fetch(`${base}/calendar/${created.token}.ics`);
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toContain('text/calendar');
    expect(await feed.text()).toContain('BEGIN:VEVENT');

    const shown = (await (await fetch(`${base}/api/exports/ics-token`)).json()) as Record<
      string,
      unknown
    >;
    expect(shown.token).toBeUndefined();
    expect(shown.hasToken).toBe(true);
  });

  it('serves the feed with or without the .ics suffix', async () => {
    const created = (await (
      await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })
    ).json()) as { token: string };
    expect((await fetch(`${base}/calendar/${created.token}`)).status).toBe(200);
  });

  /**
   * A subscribable URL is a bearer credential in a path segment. It must not be cached by an
   * intermediary, indexed by a crawler that happens to meet it, or handed to a third-party site as
   * a Referer — losing the URL is losing the feed, and the user cannot rotate what they never see.
   */
  it('serves the feed with no-store, noindex and no referrer', async () => {
    const created = (await (
      await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })
    ).json()) as { token: string };
    const feed = await fetch(`${base}/calendar/${created.token}.ics`);
    expect(feed.headers.get('cache-control')).toContain('no-store');
    expect(feed.headers.get('cache-control')).toContain('private');
    expect(feed.headers.get('x-robots-tag')).toContain('noindex');
    expect(feed.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('rotates on a second POST, invalidating the previous URL', async () => {
    const first = (await (
      await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })
    ).json()) as { token: string };
    const second = (await (
      await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })
    ).json()) as { token: string };
    expect(second.token).not.toBe(first.token);
    expect((await fetch(`${base}/calendar/${first.token}.ics`)).status).toBe(404);
    expect((await fetch(`${base}/calendar/${second.token}.ics`)).status).toBe(200);
  });

  it('404s an unknown or revoked token without saying which', async () => {
    const created = (await (
      await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })
    ).json()) as { token: string };
    await fetch(`${base}/api/exports/ics-token`, { method: 'DELETE' });
    const revoked = await fetch(`${base}/calendar/${created.token}.ics`);
    const unknown = await fetch(`${base}/calendar/definitely-not-a-token`);
    expect(revoked.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Same status AND same words: a caller with no session must not learn which of the two it is.
    expect((await revoked.json() as { error: { message: string } }).error.message).toBe(
      (await unknown.json() as { error: { message: string } }).error.message,
    );
  });
});

/**
 * WHAT A FEED URL MEANS, AND WHEN THAT IS DECIDED.
 *
 * Star and feed were each correct alone — every test above this one passed while the product was
 * broken — and the defect only existed in their composition. `/calendar/<token>.ics` used to serve
 * everything while the watchlist was empty and only the watched programmes as soon as it was not,
 * from a URL that never changed and with nothing on any screen to say so. Against the real corpus
 * that was 243 VEVENTs before starring one programme and 5 after (`exportsCorpus.test.ts`).
 *
 * The rule these tests hold to: a feed URL's meaning is fixed by the URL and by nothing else. The
 * plain URL is every publishable deadline, for an empty watchlist and a full one alike; `?watched=1`
 * is the watchlist, for an empty watchlist and a full one alike. Neither branches on its size.
 */
describe('a feed URL means one thing, chosen when it is subscribed to', () => {
  const events = (ics: string): number => ics.split('BEGIN:VEVENT').length - 1;

  const mint = async (): Promise<string> =>
    ((await (await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })).json()) as {
      token: string;
    }).token;

  const feed = async (token: string, query = ''): Promise<string> => {
    const res = await fetch(`${base}/calendar/${token}.ics${query}`);
    expect(res.status).toBe(200);
    return await res.text();
  };

  const withWatchlist = async <T>(ids: string[], body: () => Promise<T>): Promise<T> => {
    const previous = data.watching;
    data.watching = ids;
    try {
      return await body();
    } finally {
      data.watching = previous;
    }
  };

  /** THE REGRESSION. Subscribe, count, star, fetch the SAME url, and the file must not have moved. */
  it('serves the identical file from the plain URL before and after a programme is starred', async () => {
    const token = await mint();
    const before = await withWatchlist([], () => feed(token));
    const after = await withWatchlist(['ardc-grants'], () => feed(token));

    expect(events(before)).toBe(2);
    expect(events(after)).toBe(2);
    // Byte-identical, not merely "still two events": nothing about the corpus, the clock or the
    // token changed between the two fetches, so nothing about the file may have changed either.
    expect(after).toBe(before);
  });

  it('serves every publishable deadline from the plain URL whatever the watchlist says', async () => {
    const token = await mint();
    for (const ids of [[], ['ardc-grants'], ['ardc-grants', 'arrl-club-grant']]) {
      const ics = await withWatchlist(ids, () => feed(token));
      expect(events(ics), JSON.stringify(ids)).toBe(2);
      expect(ics, JSON.stringify(ids)).toContain('X-GRANTSPOTTER-PROGRAM-ID:ardc-grants');
      expect(ics, JSON.stringify(ids)).toContain('X-GRANTSPOTTER-PROGRAM-ID:arrl-club-grant');
    }
  });

  it('serves the watchlist and only the watchlist from ?watched=1', async () => {
    const token = await mint();
    const ics = await withWatchlist(['ardc-grants'], () => feed(token, '?watched=1'));
    expect(events(ics)).toBe(1);
    expect(ics).toContain('X-GRANTSPOTTER-PROGRAM-ID:ardc-grants');
    expect(ics).not.toContain('X-GRANTSPOTTER-PROGRAM-ID:arrl-club-grant');
  });

  /**
   * The half that used to be a special case. An empty watchlist on the opt-in URL is an empty
   * calendar — the subscriber asked for "only what I star" and stars nothing — and NOT a silent
   * widening to the whole corpus. A feed whose scope depends on the size of a list is a feed whose
   * meaning changes without anyone choosing it, which is the defect, not the kindness.
   */
  it('serves an empty calendar from ?watched=1 while nothing is starred, rather than everything', async () => {
    const token = await mint();
    const ics = await withWatchlist([], () => feed(token, '?watched=1'));
    expect(events(ics)).toBe(0);
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });

  /** Two subscriptions in one client have to be tellable apart by the only label a client shows. */
  it('names the two feeds for what they contain', async () => {
    const token = await mint();
    expect(await feed(token)).toContain('X-WR-CALNAME:GrantSpotter deadlines');
    expect(await feed(token, '?watched=1')).toContain('X-WR-CALNAME:GrantSpotter watchlist');
  });

  /** Anything that is not the opt-in spelling is the plain feed. There is no third meaning. */
  it('treats an unrecognised watched= value as the plain feed', async () => {
    const token = await mint();
    for (const query of ['?watched=0', '?watched=true', '?watched=', '?watchlist=1']) {
      const ics = await withWatchlist(['ardc-grants'], () => feed(token, query));
      expect(events(ics), query).toBe(2);
    }
  });
});

/**
 * THE FEED IS A PUBLIC URL, so it is the one route in this file an unauthenticated stranger can
 * reach in a loop. The limiter charges the attempt BEFORE the lookup and never refunds it, which
 * is Plan 3 Task 10's precedent: a limiter that only counts failures is a limiter an attacker
 * turns off by succeeding, and one that refunds on error is no limiter at all.
 */
describe('the feed is rate limited', () => {
  it('429s a burst of guesses at unknown tokens, and says how long to wait', async () => {
    const alt = await startApp(depsFor(fakeDataSource()), {
      windowMs: 60_000,
      maxPerWindow: 100,
      maxMissesPerWindow: 3,
    });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        codes.push((await fetch(`${alt.base}/calendar/guess-${String(i)}`)).status);
      }
      expect(codes).toEqual([404, 404, 404, 429, 429]);
      const res = await fetch(`${alt.base}/calendar/guess-again`);
      expect(res.headers.get('retry-after')).toBeTruthy();
      const envelope = (await res.json()) as { error: { code: string } };
      expect(envelope.error.code).toBe('rate_limited');
    } finally {
      await new Promise<void>((resolve) => alt.server.close(() => resolve()));
    }
  });

  it('429s a burst against a VALID token too, so a leaked URL cannot be used as an amplifier', async () => {
    const source = fakeDataSource();
    const alt = await startApp(depsFor(source), {
      windowMs: 60_000,
      maxPerWindow: 2,
      maxMissesPerWindow: 100,
    });
    try {
      const created = (await (
        await fetch(`${alt.base}/api/exports/ics-token`, { method: 'POST' })
      ).json()) as { token: string };
      const codes: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        codes.push((await fetch(`${alt.base}/calendar/${created.token}.ics`)).status);
      }
      expect(codes).toEqual([200, 200, 429, 429]);
    } finally {
      await new Promise<void>((resolve) => alt.server.close(() => resolve()));
    }
  });
});

/**
 * THE SIXTH TIME. Tasks 1, 2, 3 and 7 each found their own layer had no suppression gate at all,
 * and Task 3's report names these two routes specifically: they build `programsById` from an
 * UNFILTERED `listPrograms()`, unlike the CSV and XLSX routes beside them. `buildIcsCalendar` and
 * `cycleToVevent` now gate internally, and `createSqliteExportDataSource.listPrograms` gates too —
 * this proves the third layer, the one in the handlers, independently of both: the fake below
 * hands the routes the hazard directly.
 */
describe('no suppressed record can leave through a route', () => {
  /**
   * THE WATCHLIST EVERY FETCH IN THIS BLOCK RUNS UNDER, clean and mixed alike, and what makes the
   * `?watched=1` rows below assert anything at all.
   *
   * `?watched=1` narrows to the watchlist, so while the fixture starred only `ardc-grants` the
   * suppressed record was out of scope on those paths for a reason that has nothing to do with the
   * gate. Measured, not assumed: with the hazard's `do_not_publish` tag REMOVED — the gate then
   * having nothing to catch — both watched rows still passed. They could not fail, so they proved
   * nothing, on the one surface whose contents a subscriber chooses. A star outlives a
   * reclassification, so starring the hazard is the state in which the gate is the only thing
   * standing between it and a calendar.
   */
  const STARRED = ['ardc-grants', SUPPRESSED.id];

  const fetchStarred = async (path: string, suppressed: boolean): Promise<string> => {
    const previous = data.watching;
    data.watching = [...STARRED];
    data.suppressedVisible = suppressed;
    try {
      return await (await fetch(`${base}${path}`)).text();
    } finally {
      data.suppressedVisible = false;
      data.watching = previous;
    }
  };

  it('is byte-identical on every export when the suppressed record and its cycle are appended', async () => {
    const created = (await (
      await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })
    ).json()) as { token: string };

    for (const path of [
      '/api/exports/opportunities.csv',
      '/api/exports/eligibility.csv',
      '/api/exports/eligibility.html',
      '/api/exports/deadlines.ics',
      '/api/exports/deadlines.ics?watched=1',
      `/calendar/${created.token}.ics`,
      `/calendar/${created.token}.ics?watched=1`,
    ]) {
      const clean = await fetchStarred(path, false);
      const mixed = await fetchStarred(path, true);
      expect(mixed.length, path).toBe(clean.length);
      expect(mixed, path).toBe(clean);
    }
  });

  it('writes the suppressed id, name and tag nowhere in the bytes', async () => {
    const created = (await (
      await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })
    ).json()) as { token: string };

    for (const path of [
      '/api/exports/opportunities.csv',
      '/api/exports/eligibility.csv',
      '/api/exports/deadlines.ics',
      '/api/exports/deadlines.ics?watched=1',
      `/calendar/${created.token}.ics`,
      `/calendar/${created.token}.ics?watched=1`,
    ]) {
      const body = await fetchStarred(path, true);
      expect(body, path).not.toContain(SUPPRESSED.id);
      expect(body, path).not.toContain(SUPPRESSED.name);
      expect(body, path).not.toContain(DO_NOT_PUBLISH_TAG);
    }
  });

  /**
   * A star outlives a reclassification: a record can be publishable when it is starred and
   * `do_not_publish` afterwards, and the watchlist row stays. "The subscriber asked for it" is not
   * a reason to publish it, so the gate runs BEFORE the watch filter on both watched surfaces.
   */
  it('publishes nothing when the thing the user starred is the suppressed record', async () => {
    const created = (await (
      await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })
    ).json()) as { token: string };
    const previous = data.watching;
    data.watching = [SUPPRESSED.id];
    data.suppressedVisible = true;
    try {
      for (const path of [
        '/api/exports/deadlines.ics?watched=1',
        `/calendar/${created.token}.ics?watched=1`,
      ]) {
        const body = await (await fetch(`${base}${path}`)).text();
        expect(body.split('BEGIN:VEVENT').length - 1, path).toBe(0);
        expect(body, path).not.toContain(SUPPRESSED.id);
        expect(body, path).not.toContain(SUPPRESSED.name);
        expect(body, path).not.toContain(DO_NOT_PUBLISH_TAG);
      }
    } finally {
      data.suppressedVisible = false;
      data.watching = previous;
    }
  });

  /**
   * THE LAYER NO RESPONSE CAN SHOW YOU, so it is the layer that was never actually tested.
   *
   * Every assertion above reads bytes, and bytes cannot see this gate. `calendarPrograms` runs
   * `exportablePrograms` before the watch filter; `buildIcsCalendar` runs the same predicate again
   * on the map it is handed, and `cycleToVevent` a third time. So the handler's own gate can be
   * deleted without changing one byte of any calendar. Measured, which is why this exists: with
   * `calendarPrograms` patched to skip the gate on the watched path — the "the subscriber asked for
   * it, so let it through" bug, verbatim — `npx vitest run --project server` reported 3048 passed,
   * every suppression test in this file included. Four layers are worth having only while losing
   * one is detectable; otherwise the outermost is a comment, and the next reader deletes it.
   *
   * So this calls the function, not the route. It is the only test in the repository that fails
   * when the handler's gate alone is removed.
   */
  describe('gates before it filters, in the handler itself and not only downstream', () => {
    const chosen = (watched?: ReadonlySet<string>): string[] => {
      data.suppressedVisible = true;
      try {
        return [...calendarPrograms(depsFor(data), watched).keys()];
      } finally {
        data.suppressedVisible = false;
      }
    };

    it('never puts the suppressed record in the plain scope', () => {
      expect(chosen(undefined)).toEqual(['ardc-grants', 'arrl-club-grant']);
    });

    /** The exact hazard: a watchlist row that outlived the record's reclassification. */
    it('never puts it in the watched scope, even when the user has starred it', () => {
      expect(chosen(new Set([SUPPRESSED.id]))).toEqual([]);
      expect(chosen(new Set([SUPPRESSED.id, 'ardc-grants']))).toEqual(['ardc-grants']);
    });

    /** A set, never a size: the empty watchlist is an empty calendar, not the whole corpus. */
    it('reads the watchlist as a set of ids', () => {
      expect(chosen(new Set())).toEqual([]);
      expect(chosen(new Set(['arrl-club-grant']))).toEqual(['arrl-club-grant']);
    });
  });

  it('cannot be turned off by asking for the suppression tag by name', async () => {
    data.suppressedVisible = true;
    try {
      const body = await (
        await fetch(`${base}/api/exports/opportunities.csv?tags=${DO_NOT_PUBLISH_TAG}`)
      ).text();
      expect(body).not.toContain(SUPPRESSED.id);
    } finally {
      data.suppressedVisible = false;
    }
  });
});

describe('draft and packet', () => {
  const body = {
    applicationId: 'app-ready',
    programId: 'ardc-grants',
    budgetLines: [
      {
        item: 'IC-7610',
        category: 'Equipment',
        quantity: 1,
        unitCost: 2899,
        justification: 'Replacement',
        quoteSource: 'https://www.example.org/q',
      },
    ],
  };

  const post = (path: string, payload: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  it('returns a docx built from the stored application, not from the request body', async () => {
    const res = await post('/api/exports/draft.docx', body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('wordprocessingml');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('returns the same draft as markdown', async () => {
    const res = await post('/api/exports/draft.md', body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain('grantspotter-draft-app-ready.md');
    const text = await res.text();
    expect(text).toContain('# Need statement');
    expect(text).toContain('Our club station needs a replacement transceiver.');
  });

  /**
   * Spec §10.4, made a property of the ROUTE rather than of the browser in front of it. A body
   * that carries its own markdown must not be able to export it; the gate reads the stored row.
   */
  it('ignores markdown supplied in the request body', async () => {
    const text = await (
      await post('/api/exports/draft.md', { ...body, markdown: '# Smuggled\n\nWe won $1,000,000.' })
    ).text();
    expect(text).not.toContain('Smuggled');
    expect(text).toContain('Our club station needs a replacement transceiver.');
  });

  it('returns a zip packet', async () => {
    const res = await post('/api/exports/packet.zip', body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
  });

  it('409s every draft export while a factual assertion is unconfirmed', async () => {
    for (const path of ['/api/exports/draft.docx', '/api/exports/draft.md', '/api/exports/packet.zip']) {
      const res = await post(path, { ...body, applicationId: 'app-unconfirmed' });
      expect(res.status, path).toBe(409);
      const envelope = (await res.json()) as {
        error: { code: string; message: string; details?: { unconfirmed: number } };
      };
      expect(envelope.error.code).toBe('conflict');
      expect(envelope.error.message).toMatch(/unconfirmed factual assertion/i);
      // The details survive the hop. Plan 4 attaches the counts and the raw slot paths so the UI
      // can say WHICH gap blocks the export; a mapper that rebuilt the AppError would drop them.
      expect(envelope.error.details?.unconfirmed, path).toBeGreaterThan(0);
    }
  });

  it("404s an applicationId that is not this user's", async () => {
    const res = await post('/api/exports/draft.docx', { ...body, applicationId: 'someone-elses' });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('422s a body with no applicationId', async () => {
    const res = await post('/api/exports/packet.zip', { programId: 'ardc-grants' });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('validation_failed');
  });

  it('400s on an unknown programId, in the one error envelope', async () => {
    const res = await post('/api/exports/packet.zip', { ...body, programId: 'ghost' });
    expect(res.status).toBe(400);
    const envelope = (await res.json()) as {
      error: { code: string; message: string };
      requestId: string;
    };
    expect(envelope.error.code).toBe('bad_request');
    expect(envelope.requestId).toBeTypeOf('string');
  });

  /** A suppressed programme is not a programme a draft may be exported against. */
  it('400s a programId that names a suppressed record, as though it did not exist', async () => {
    data.suppressedVisible = true;
    try {
      const res = await post('/api/exports/packet.zip', { ...body, programId: SUPPRESSED.id });
      expect(res.status).toBe(400);
    } finally {
      data.suppressedVisible = false;
    }
  });
});

describe('admin backup and restore', () => {
  it('refuses a member with a forbidden envelope', async () => {
    role = 'member';
    const res = await fetch(`${base}/api/admin/backup.json`);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('forbidden');
    expect(
      (
        await fetch(`${base}/api/admin/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });

  interface RestoreBody {
    tablesRestored: string[];
    tablesSkipped: string[];
    rowsRestored: number;
    rowsSkipped: number;
    programsReindexed: number | null;
    summary: string;
  }

  it('serves a backup to an admin and restores it back', async () => {
    role = 'admin';
    const res = await fetch(`${base}/api/admin/backup.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const backup = (await res.json()) as { app: string; tables: Record<string, unknown[]> };
    expect(backup.app).toBe('grantspotter');
    expect(backup.tables.funders).toHaveLength(1);
    // The backup carries the whole database, not one table: this fixture holds one funder, one
    // programme, one user and two application drafts.
    expect(backup.tables.programs).toHaveLength(1);
    expect(backup.tables.applications).toHaveLength(2);
    // DEVIATION FROM THE TASK BRIEF: it asserts `rowsRestored: 1`, which was never true even of
    // its own fixture — that fixture also carried two `applications` rows, and `applications` is
    // in BACKUP_TABLES.
    const restored = await fetch(`${base}/api/admin/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(backup),
    });
    expect(restored.status).toBe(200);
    const result = (await restored.json()) as RestoreBody;
    role = 'member';

    expect(result.rowsRestored).toBe(5); // 1 funder + 1 programme + 1 user + 2 drafts
    expect(result.rowsSkipped).toBe(0);
    expect(result.tablesSkipped).toEqual([]);
    // Canonical parent-before-child order, taken from BACKUP_TABLES rather than from the file.
    expect(result.tablesRestored.indexOf('funders')).toBeLessThan(
      result.tablesRestored.indexOf('programs'),
    );
    expect(result.tablesRestored.indexOf('users')).toBeLessThan(
      result.tablesRestored.indexOf('applications'),
    );
    expect(result.tablesRestored).not.toContain('sessions');
    expect(result.tablesRestored).not.toContain('schema_migrations');
    expect(result.tablesRestored).not.toContain('program_search');
  });

  /**
   * WHAT THE ADMIN CONSOLE IS ALLOWED TO SAY. Task 6/7's `restoreBackup` returns
   * `programsReindexed` and `tablesSkipped` precisely because two earlier claims in this project
   * were untrue: "browse index was rebuilt" when nothing reindexed, and "every table except
   * sessions" when `schema_migrations` and the two derived browse tables are excluded too. The
   * route has to surface both, or the copy above it goes back to being a claim.
   */
  it('reports how many programmes the browse index was actually rebuilt for', async () => {
    role = 'admin';
    const backup = await (await fetch(`${base}/api/admin/backup.json`)).json();
    const result = (await (
      await fetch(`${base}/api/admin/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(backup),
      })
    ).json()) as RestoreBody;
    role = 'member';

    expect(result.programsReindexed).toBe(1);
    expect(result.summary).toContain('Browse index rebuilt for 1 programme(s).');
    // The copy names every exclusion, not just sessions.
    expect(result.summary).toContain('sessions');
    expect(result.summary).toContain('schema_migrations');
    expect(result.summary).toContain('program_search');
  });

  /**
   * `null` is not `0`. "This database has no browse projection to rebuild" and "the rebuild found
   * nothing to index" are different sentences, and an admin console that printed "0 programmes"
   * for the first would be describing a healthy restore as an empty one.
   */
  it('reports a null reindex as unknown rather than as zero', async () => {
    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE funders (id TEXT PRIMARY KEY, name TEXT, homepage TEXT)');
    bare.prepare('INSERT INTO funders VALUES (?,?,?)').run('ardc', 'ARDC', 'https://www.ardc.net/');
    const source: ExportDataSource = { ...data, rawDb: () => bare };
    const alt = await startApp(depsFor(source));
    try {
      role = 'admin';
      const backup = await (await fetch(`${alt.base}/api/admin/backup.json`)).json();
      const result = (await (
        await fetch(`${alt.base}/api/admin/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(backup),
        })
      ).json()) as RestoreBody;
      role = 'member';

      expect(result.tablesRestored).toEqual(['funders']);
      expect(result.rowsRestored).toBe(1);
      expect(result.programsReindexed).toBeNull();
      expect(result.summary).toMatch(/could not be rebuilt/i);
      expect(result.summary).not.toMatch(/\b0 programme/);
    } finally {
      await new Promise<void>((resolve) => alt.server.close(() => resolve()));
      bare.close();
    }
  });

  /**
   * FOUND OVER THE WIRE, NOT IN A UNIT TEST. `GET /api/admin/backup.json` on the committed corpus
   * serves 2.2 MB; posting that exact document straight back answered **413** through Plan 1's
   * global `express.json({ limit: '1mb' })`, which runs before any router. No suite in this plan
   * could see it — every one of them mounts its own bare express app with its own parser, and
   * every fixture is a handful of rows.
   *
   * So this test uses the REAL `createApp`, and asserts both halves: the restore path takes a
   * document larger than 1 MB, and nothing else does.
   */
  it('accepts a backup larger than the global 1 MB body limit — and only on that path', async () => {
    const harness = openTestDb();
    openDbs.push(harness);
    const realApp = createApp({
      db: harness,
      config: loadConfig({
        SESSION_SECRET: 'x'.repeat(32),
        CONTACT_URL: 'https://example.org/grantspotter',
        NODE_ENV: 'test',
      }),
      // The real guards, through the one mount seam: an anonymous caller must be refused by
      // requireAuth, not by the body parser and not by notFoundHandler.
      mountRoutes: (a) => {
        a.use(
          '/api',
          createExportsRouter({
            ...depsFor(data),
            requireAuth: requireAuth(),
            requireAdmin: requireAdmin(),
            userIdOf: (req) => req.auth?.id,
          }),
        );
      },
    });
    const started = await new Promise<Server>((resolve) => {
      const s = realApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const at = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
    const oversized = JSON.stringify({ app: 'grantspotter', pad: 'a'.repeat(1024 * 1024 + 100) });
    try {
      // Not 413: the body was parsed and the request reached the guard, which refuses an
      // anonymous caller. 401 is the right refusal; 413 would mean it never got that far.
      const restore = await fetch(`${at}/api/admin/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversized,
      });
      expect(restore.status).not.toBe(413);
      expect(restore.status).toBe(401);

      // Every other route keeps the 1 MB refusal Plan 1 pins in test/app.health.test.ts.
      const health = await fetch(`${at}/api/health`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversized,
      });
      expect(health.status).toBe(413);
      expect((await health.json() as { error: { code: string } }).error.code).toBe(
        'payload_too_large',
      );
    } finally {
      await new Promise<void>((resolve) => started.close(() => resolve()));
    }
  });

  it('400s a malformed restore payload and says why', async () => {
    role = 'admin';
    const res = await fetch(`${base}/api/admin/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'other' }),
    });
    expect(res.status).toBe(400);
    const envelope = (await res.json()) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('bad_request');
    expect(envelope.error.message).toMatch(/not a GrantSpotter backup/);
    role = 'member';
  });
});
