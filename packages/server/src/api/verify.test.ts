import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type {
  FetchRequest, FetchedPayload, Program, RawOpportunity, SourceModule,
} from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { arrlScholarship, seedFixtureCorpus, starProgram } from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import { reindexBrowse } from './reindex.js';
import { recordProvenance } from './provenanceStore.js';
import { createVerifyRunner, checkVerifyRateLimit, MAX_VERIFY_REQUESTS } from './verify.js';
import { createVerifyRouter } from './verifyRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
/** `arrlScholarship`'s seeded trust.lastVerifiedAt. Every "did not move" assertion uses it. */
const SEEDED_VERIFIED_AT = '2026-08-02T00:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };
const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@example.com', role: 'admin' };

const BEFORE: RawOpportunity = {
  sourceId: 'arrl-scholarship-descriptions',
  externalKey: 'ARRL Foundation Scholarship Program',
  name: 'ARRL Foundation Scholarship Program',
  rawFields: { 'Award Amount': '$500 - $25,000', Deadline: 'January 31' },
  sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
  rawText: 'Award Amount: $500 - $25,000 • Deadline: January 31',
};

const AFTER: RawOpportunity = {
  ...BEFORE,
  rawFields: { 'Award Amount': '$500 - $25,000', Deadline: 'December 30, 12:00 PM EST' },
  rawText: 'Award Amount: $500 - $25,000 • Deadline: December 30, 12:00 PM EST',
};

/**
 * A stored-but-unpublishable record, and the raw entry a refetch of its page
 * would return for it.
 *
 * Modelled on the real thing: the ARRL club-grant page carries ~37 already-funded
 * clubs beside the one live programme, and `ardc-award-tables`, `nsf-awards` and
 * `usaspending` are entirely past awards. ~553 of the 703 records the corpus
 * stores carry `do_not_publish` for exactly this reason.
 *
 * `recipient` is the field that makes it evidence rather than an opportunity, and
 * it is what the assertions below look for in the response body: on a live server
 * at HEAD this route answered 200 with `{"label":"recipient",…}` in `diffs`.
 */
const SUPPRESSED_ID = 'arrl-club-grant--past-award-radio-club-of-example-city';
const SUPPRESSED_NAME = 'ARRL Club Grant — 2024 award to the Radio Club of Example City';
const SUPPRESSED_RECIPIENT = 'Radio Club of Example City';

const SUPPRESSED_RAW: RawOpportunity = {
  sourceId: 'arrl-scholarship-descriptions',
  externalKey: SUPPRESSED_NAME,
  name: SUPPRESSED_NAME,
  rawFields: { recipient: SUPPRESSED_RECIPIENT, 'Award Amount': '$2,500', year: '2024' },
  sourceUrl: 'http://www.arrl.org/club-grant-program',
  rawText: `recipient: ${SUPPRESSED_RECIPIENT} • Award Amount: $2,500`,
};

/**
 * Seed it. No provenance is recorded, so every field reads as newly appeared —
 * which is what makes an ungated refetch write a `change_events` row per field
 * AND hand the caller the record's values in `diffs`.
 */
function seedSuppressed(db: Database.Database): void {
  const suppressed: Program = {
    ...arrlScholarship,
    id: SUPPRESSED_ID,
    name: SUPPRESSED_NAME,
    tags: [...arrlScholarship.tags, 'past_award', DO_NOT_PUBLISH_TAG],
  };
  createProgramRepo(db).upsert(suppressed);
}

/** A different entry off the same catalog page. Used to prove a REAL disappearance. */
const SOMEONE_ELSE: RawOpportunity = {
  ...BEFORE,
  externalKey: 'Chicago FM Club Scholarships',
  name: 'Chicago FM Club Scholarships',
  rawFields: { 'Award Amount': '$1,000', Deadline: 'January 31' },
};

function fakeSource(
  emit: RawOpportunity[],
  overrides: Partial<SourceModule> = {},
): SourceModule {
  return {
    id: 'arrl-scholarship-descriptions',
    funderId: 'arrl-foundation',
    label: 'ARRL scholarship catalog',
    tier: 'C',
    klass: 'ham_scholarship',
    requests: [{
      url: 'http://www.arrl.org/scholarship-descriptions',
      method: 'GET',
      accept: 'html',
    }],
    parse: () => emit,
    expectedMinRecords: 100,
    ...overrides,
  };
}

function fakeFetcher(status = 200) {
  return {
    fetch: vi.fn(async (req: FetchRequest): Promise<FetchedPayload> => ({
      url: req.url,
      status,
      contentType: 'text/html',
      body: '<html>…</html>',
      fetchedAt: NOW,
    })),
  };
}

function primeProvenance(db: Database.Database) {
  recordProvenance(
    db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-0', BEFORE, '2026-05-01T00:00:00.000Z',
  );
}

function lastVerifiedAtColumn(db: Database.Database): string {
  const row = db
    .prepare('SELECT last_verified_at FROM programs WHERE id = ?')
    .get('arrl-foundation-scholarship') as { last_verified_at: string };
  return row.last_verified_at;
}

describe('verify runner', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    primeProvenance(db);
  });

  afterEach(() => {
    db.close();
  });

  it('reports no change when the source still says the same thing', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([BEFORE])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.diffs).toEqual([]);
  });

  it('refreshes lastVerifiedAt even when nothing changed — checking IS the point', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([BEFORE])], now: () => NOW,
    });
    await runner.verify('arrl-foundation-scholarship');

    // The denormalized column and the record must move together: the browse
    // list sorts on the column, the detail page renders the record.
    expect(lastVerifiedAtColumn(db)).toBe(NOW);

    const stored = createProgramRepo(db).get('arrl-foundation-scholarship');
    expect(stored?.trust.lastVerifiedAt).toBe(NOW);
    expect(stored?.trust.verificationMethod).toBe('live_fetch');
  });

  it('diffs the parsed fields and names the changed label', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([AFTER])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.changed).toBe(true);
    expect(result.diffs).toEqual([
      { label: 'Deadline', before: 'January 31', after: 'December 30, 12:00 PM EST' },
    ]);
  });

  it('records a deadline_changed ChangeEvent, which is what feeds the watchlist', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([AFTER])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.changeEventIds).toHaveLength(1);
    const ce = db
      .prepare('SELECT kind, program_id, field_path FROM change_events WHERE id = ?')
      .get(result.changeEventIds[0]) as { kind: string; program_id: string; field_path: string };
    expect(ce.kind).toBe('deadline_changed');
    expect(ce.program_id).toBe('arrl-foundation-scholarship');
    expect(ce.field_path).toBe('deadline.note');
  });

  it('classifies an amount label change as amount_changed', async () => {
    const amountMoved: RawOpportunity = {
      ...BEFORE,
      rawFields: { 'Award Amount': '$1,000 - $25,000', Deadline: 'January 31' },
    };
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([amountMoved])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    const ce = db
      .prepare('SELECT kind FROM change_events WHERE id = ?')
      .get(result.changeEventIds[0]) as { kind: string };
    expect(ce.kind).toBe('amount_changed');
  });

  /**
   * DEVIATION FROM THE TASK BRIEF (2026-08-03), and the reason for it.
   *
   * The brief derives the event's `field_path` from the ChangeKind
   * (`deadline_changed → 'deadline.note'`, `amount_changed → 'amount.amountRaw'`).
   * That round-trip is lossy: `Number of Awards` and `Award Amount` are both
   * `amount_changed`, so a change to the AWARD COUNT would be filed against
   * `amount.amountRaw` — a claim about a field the funder did not touch, in the
   * one column the detail page uses to point a reader at the value that moved.
   * `provenanceStore.fieldPathForLabel` is the shared label→path vocabulary
   * (widened deliberately, and pinned at the other end by
   * `normalize/rawFieldsContract.test.ts`); the kind is derived FROM the path,
   * so there is one vocabulary rather than two that can drift.
   */
  it('files the event against the field the label really feeds, not the kind\'s default', async () => {
    const countAdded: RawOpportunity = {
      ...BEFORE,
      rawFields: { ...BEFORE.rawFields, 'Number of Awards': '170+' },
    };
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([countAdded])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    const ce = db
      .prepare('SELECT kind, field_path FROM change_events WHERE id = ?')
      .get(result.changeEventIds[0]) as { kind: string; field_path: string };
    expect(ce.kind).toBe('amount_changed');
    expect(ce.field_path).toBe('amount.awardCountRaw');
  });

  it('emits vanished when the source spoke and this record was not in it', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([SOMEONE_ELSE])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const ce = db.prepare('SELECT kind FROM change_events').get() as { kind: string };
    expect(ce.kind).toBe('vanished');
  });

  /**
   * DEVIATION FROM THE TASK BRIEF (2026-08-03), and the reason for it.
   *
   * The brief asserts that a source parsing ZERO records means this record
   * `vanished`. Six parsers in this repository were returning zero records from
   * their own real pages while the suite stayed green, so "the parse returned
   * nothing" is, in this corpus, far more often a broken read than a withdrawn
   * programme — and `vanished` fans out to every watcher as "Record vanished
   * from its source", a claim about the FUNDER made out of a failure of OURS.
   * A zero-yield refetch therefore verifies nothing: it reports `ok: false`,
   * writes no change event, and leaves `lastVerifiedAt` where it was, so the
   * amber badge stays amber instead of going green over a page we could not read.
   */
  it('refuses to call a zero-yield parse a disappearance', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.error).toContain('no records');
    expect(result.changeEventIds).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_events').get()).toEqual({ n: 0 });
    expect(lastVerifiedAtColumn(db)).toBe(SEEDED_VERIFIED_AT);
  });

  it('reports a fetch failure without touching lastVerifiedAt', async () => {
    const failing = {
      fetch: vi.fn(async () => {
        throw new Error('blocked host: farweb.org');
      }),
    };
    const runner = createVerifyRunner({
      db, fetcher: failing, sources: [fakeSource([BEFORE])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('farweb.org');
    expect(lastVerifiedAtColumn(db)).toBe(SEEDED_VERIFIED_AT);
  });

  it('reports a missing source module rather than pretending to verify', async () => {
    const runner = createVerifyRunner({ db, fetcher: fakeFetcher(), sources: [], now: () => NOW });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no source module');
  });

  /**
   * ADDED (2026-08-03). Two ARRL modules, neither named by this program's
   * provenance, is not a coin toss: verifying a scholarship against the club
   * grant page finds nothing and would report the scholarship `vanished`.
   */
  it('refuses to guess between two sources for the same funder', async () => {
    db.prepare('DELETE FROM field_provenance WHERE program_id = ?').run('arrl-foundation-scholarship');
    const runner = createVerifyRunner({
      db,
      fetcher: fakeFetcher(),
      sources: [
        fakeSource([BEFORE]),
        fakeSource([BEFORE], { id: 'arrl-club-grant', label: 'ARRL club grant page' }),
      ],
      now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no source module');
    expect(lastVerifiedAtColumn(db)).toBe(SEEDED_VERIFIED_AT);
  });

  /**
   * ADDED (2026-08-03). Politeness is the whole point of this endpoint's
   * design: it is user-triggered, and `grants-gov-extract`'s request plan is
   * seven ~77.85 MB ZIPs. A button must not be able to pull half a gigabyte.
   */
  it('refuses a refetch plan too large to be a button press', async () => {
    const many = Array.from({ length: MAX_VERIFY_REQUESTS + 1 }, (_unused, i) => ({
      url: `https://example.com/extract-${i}.zip`,
      method: 'GET' as const,
      accept: 'binary' as const,
    }));
    const fetcher = fakeFetcher();
    const runner = createVerifyRunner({
      db, fetcher, sources: [fakeSource([BEFORE], { requests: many })], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(false);
    expect(result.error).toContain(String(many.length));
    expect(fetcher.fetch).not.toHaveBeenCalled();
    expect(lastVerifiedAtColumn(db)).toBe(SEEDED_VERIFIED_AT);
  });

  /**
   * ADDED (2026-08-03). ARDC's grant pages are a two-phase source: the child
   * query needs a parent id resolved from the first payload. Fetching only
   * phase one hands `parse` an incomplete payload set, which yields nothing —
   * i.e. it manufactures exactly the false disappearance above.
   */
  it('follows a two-phase source through its follow-up requests', async () => {
    const fetcher = fakeFetcher();
    const followUp = vi.fn((): FetchRequest[] => [
      { url: 'https://example.com/children', method: 'GET', accept: 'json' },
    ]);
    const runner = createVerifyRunner({
      db,
      fetcher,
      sources: [Object.assign(fakeSource([BEFORE]), { followUp })],
      now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(true);
    expect(followUp).toHaveBeenCalledTimes(1);
    expect(fetcher.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('checkVerifyRateLimit', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function attempt(userId: string, programId: string, at: string) {
    db.prepare('INSERT INTO verify_attempts (user_id, program_id, attempted_at) VALUES (?, ?, ?)')
      .run(userId, programId, at);
  }

  it('never limits an admin', () => {
    for (let i = 0; i < 50; i += 1) attempt('u-admin', `p-${i}`, NOW);
    expect(checkVerifyRateLimit(db, 'u-admin', 'admin', 'p-x', NOW).allowed).toBe(true);
  });

  it('allows a member their first verification', () => {
    expect(checkVerifyRateLimit(db, 'u-member', 'member', 'p-1', NOW).allowed).toBe(true);
  });

  it('stops a member re-verifying the same program within the hour', () => {
    attempt('u-member', 'p-1', '2026-08-02T11:30:00.000Z');
    const check = checkVerifyRateLimit(db, 'u-member', 'member', 'p-1', NOW);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('program_cooldown');
    // 11:30 + 1h - 12:00 = 30 minutes. A retry-after is a promise to the caller,
    // so it is computed, never a round number picked to look plausible.
    expect(check.retryAfterSec).toBe(1800);
  });

  it('allows a member a different program within the hour', () => {
    attempt('u-member', 'p-1', '2026-08-02T11:30:00.000Z');
    expect(checkVerifyRateLimit(db, 'u-member', 'member', 'p-2', NOW).allowed).toBe(true);
  });

  it('caps a member at 10 verifications per rolling hour', () => {
    for (let i = 0; i < 10; i += 1) attempt('u-member', `p-${i}`, '2026-08-02T11:30:00.000Z');
    const check = checkVerifyRateLimit(db, 'u-member', 'member', 'p-99', NOW);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('hourly_cap');
    // The cap frees up when the OLDEST attempt in the window ages out, which is
    // a real instant this table knows: 11:30 + 1h - 12:00 = 1800s.
    expect(check.retryAfterSec).toBe(1800);
  });

  it('forgets attempts older than the rolling hour', () => {
    for (let i = 0; i < 10; i += 1) attempt('u-member', `p-${i}`, '2026-08-02T10:00:00.000Z');
    expect(checkVerifyRateLimit(db, 'u-member', 'member', 'p-99', NOW).allowed).toBe(true);
  });

  it('counts only the asking user against the cap', () => {
    for (let i = 0; i < 10; i += 1) attempt('u-other', `p-${i}`, '2026-08-02T11:30:00.000Z');
    expect(checkVerifyRateLimit(db, 'u-member', 'member', 'p-99', NOW).allowed).toBe(true);
  });
});

describe('POST /api/programs/:id/verify', () => {
  let db: Database.Database;

  function buildApp(user: SessionUser, sources: SourceModule[], fetcher = fakeFetcher()) {
    const deps: RouterDeps = {
      db,
      now: () => NOW,
      requireAuth: (_req, _res, next) => next(),
      requireAdmin: (_req, _res, next) => next(),
      currentUser: () => user,
    };
    const runner = createVerifyRunner({ db, fetcher, sources, now: () => NOW });
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware());
    app.use('/api/programs', createVerifyRouter(deps, runner));
    app.use(errorHandler({ logger: () => undefined }));
    return app;
  }

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    primeProvenance(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lets a member verify and returns the diff', async () => {
    const res = await request(buildApp(MEMBER, [fakeSource([AFTER])]))
      .post('/api/programs/arrl-foundation-scholarship/verify');
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.diffs[0].after).toBe('December 30, 12:00 PM EST');
  });

  it('429s a member who exceeds the cooldown, with a machine-readable reason', async () => {
    const app = buildApp(MEMBER, [fakeSource([BEFORE])]);
    await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    const second = await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('rate_limited');
    expect(second.body.error.details.reason).toBe('program_cooldown');
    expect(second.body.error.details.retryAfterSec).toBeGreaterThan(0);
    expect(second.headers['retry-after']).toBeDefined();
  });

  it('does not rate-limit an admin', async () => {
    const app = buildApp(ADMIN, [fakeSource([BEFORE])]);
    await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    const second = await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    expect(second.status).toBe(200);
  });

  it('404s an unknown program', async () => {
    const res = await request(buildApp(ADMIN, [fakeSource([BEFORE])]))
      .post('/api/programs/nope/verify');
    expect(res.status).toBe(404);
  });

  /**
   * The blocklist lives in the fetcher and cannot be configured away, so a
   * refusal arrives here as a thrown error from `Fetcher.fetch`. It is a
   * successful REQUEST reporting an unsuccessful FETCH — 200 with `ok: false`
   * and the fetcher's own sentence, which names the host and says it cannot be
   * enabled by configuration. Not a 500: nothing went wrong here.
   */
  it('surfaces a blocklisted host as a refusal the user can read', async () => {
    const blocked = {
      fetch: vi.fn(async (): Promise<FetchedPayload> => {
        throw new Error(
          'Blocked host: farweb.org (https://www.farweb.org/scholarships). This host is listed in ' +
            'packages/server/src/fetcher/blocklist.ts and cannot be enabled by configuration.',
        );
      }),
    };
    const res = await request(buildApp(ADMIN, [fakeSource([BEFORE])], blocked))
      .post('/api/programs/arrl-foundation-scholarship/verify');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('farweb.org');
    expect(res.body.error).toContain('cannot be enabled by configuration');
    expect(res.body.lastVerifiedAt).toBe(SEEDED_VERIFIED_AT);
  });

  /** A refused fetch still spends the caller's quota, or the button becomes a retry hammer. */
  it('charges a failed refetch against the rate limit', async () => {
    const blocked = {
      fetch: vi.fn(async (): Promise<FetchedPayload> => {
        throw new Error('Blocked host: farweb.org');
      }),
    };
    const app = buildApp(MEMBER, [fakeSource([BEFORE])], blocked);
    await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    const second = await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    expect(second.status).toBe(429);
  });

  it('fans a detected change out to watchers in the same request', async () => {
    starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
    await request(buildApp(ADMIN, [fakeSource([AFTER])]))
      .post('/api/programs/arrl-foundation-scholarship/verify');
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?')
      .get('u-member') as { n: number };
    expect(n.n).toBe(1);
  });

  /**
   * ADDED 2026-08-04, not in the brief. THE FOURTH SUPPRESSION LEAK.
   *
   * The brief's existence test was `SELECT 1 FROM programs`, which knows nothing
   * about suppression, so this route answered 200 for every one of the ~553
   * `do_not_publish` records. Measured against a live `dist` server on the
   * seeded 703-record database, before the fix:
   *
   *   member: 6/6 suppressed ids answered 200, 4 performed a live refetch
   *   admin:  6/6 suppressed ids answered 200, 4 performed a live refetch
   *   change_events joined to do_not_publish programs afterwards: 21 of 21
   *
   * and the 200s carried the hidden records' own parsed fields —
   * `{"label":"recipient",…}` for the ARRL past award, `adjacencyHits` /
   * `adjacencyScore` for `usaspending--2045755`, `recordType: crosscheck` for the
   * ARRL summary table.
   *
   * Three of the four preceding leaks (the `:id` detail route, the corpus
   * profiler, the completeness meter) were each one read path that skipped the
   * shared predicate. This one is worse because it also WRITES and because it
   * turns unrate-limited admin verification into an amplifier aimed at ~25 small
   * volunteer-run sites. Every assertion below therefore pins the ABSENCE of the
   * side effect, not merely the status code.
   */
  describe('the suppression gate', () => {
    function verifyAttempts(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM verify_attempts').get() as { n: number }).n;
    }
    function changeEvents(): number {
      return (db.prepare('SELECT COUNT(*) AS n FROM change_events').get() as { n: number }).n;
    }
    function suppressedSource() {
      return fakeSource([BEFORE, SUPPRESSED_RAW]);
    }

    beforeEach(() => {
      seedSuppressed(db);
    });

    it.each([
      ['a member', MEMBER],
      ['an admin', ADMIN],
    ])('refuses %s on a do_not_publish record, with no refetch and no write', async (_who, user) => {
      const fetcher = fakeFetcher();
      const res = await request(buildApp(user, [suppressedSource()], fetcher))
        .post(`/api/programs/${SUPPRESSED_ID}/verify`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
      // NOTHING was aimed at the funder's server. This is the half a status-code
      // assertion misses, and it is the half that hits somebody else's hosting.
      expect(fetcher.fetch).not.toHaveBeenCalled();
      // The refusal leaves no trace in either table this route writes: no ledger
      // row to charge, and no change event to pollute the stream the watchlist
      // and the inbox both read.
      expect(verifyAttempts()).toBe(0);
      expect(changeEvents()).toBe(0);
      // And the record's own content never reaches the caller.
      expect(JSON.stringify(res.body)).not.toContain(SUPPRESSED_RECIPIENT);
    });

    it('answers a suppressed id exactly as it answers an id that does not exist', async () => {
      const app = buildApp(ADMIN, [suppressedSource()]);
      const suppressed = await request(app).post(`/api/programs/${SUPPRESSED_ID}/verify`);
      const absent = await request(app).post(`/api/programs/${SUPPRESSED_ID}-not-a-real-id/verify`);

      expect(suppressed.status).toBe(absent.status);
      // Same envelope, same sentence — only the id in it and the per-request id
      // differ. A `forbidden`, a different message or a different status would
      // each confirm the id exists, which is the whole thing being withheld.
      const shape = (body: { error: { code: string; message: string } }) => ({
        code: body.error.code,
        message: body.error.message.replace(SUPPRESSED_ID, '<id>').replace('-not-a-real-id', ''),
      });
      expect(shape(suppressed.body)).toEqual(shape(absent.body));
    });

    it('leaves the publishable sibling verifiable — this is suppression, not breakage', async () => {
      const fetcher = fakeFetcher();
      const res = await request(buildApp(MEMBER, [fakeSource([AFTER, SUPPRESSED_RAW])], fetcher))
        .post('/api/programs/arrl-foundation-scholarship/verify');
      expect(res.status).toBe(200);
      expect(res.body.changed).toBe(true);
      expect(fetcher.fetch).toHaveBeenCalled();
    });

    it('refuses inside the runner too, so no other caller can reach the refetch', async () => {
      // The router is the gate a REQUEST meets; the runner is what turns an id
      // into a request against somebody else's server and into change_events
      // rows. A script, an admin tool or a retry queue calling verify() directly
      // must hit the same wall — one caller skipping the predicate is precisely
      // how this boundary has now leaked four times.
      const fetcher = fakeFetcher();
      const runner = createVerifyRunner({
        db, fetcher, sources: [suppressedSource()], now: () => NOW,
      });
      const result = await runner.verify(SUPPRESSED_ID);

      expect(result.ok).toBe(false);
      expect(fetcher.fetch).not.toHaveBeenCalled();
      expect(result.diffs).toEqual([]);
      expect(result.changeEventIds).toEqual([]);
      expect(changeEvents()).toBe(0);
      expect(JSON.stringify(result)).not.toContain(SUPPRESSED_RECIPIENT);
    });
  });
});
