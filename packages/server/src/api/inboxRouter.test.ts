import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { ChangeEvent, FetchRequest, FetchedPayload, Program } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { fixturePayload } from '../../test/fixtures.js';
import { seedFixtureCorpus, starProgram, arrlScholarship } from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { runSource } from '../crawl/runner.js';
import { contextForSource } from '../crawl/context.js';
import { DO_NOT_PUBLISH_TAG, normalizeRaw } from '../normalize/index.js';
import { TIER_D_RECORDS, manualTierD } from '../sources/manual-tier-d.js';
import { buildReviewItems, editReviewItem, rejectKeyFor, reprojectAllCycles } from '../review/index.js';
import { reindexBrowse } from './reindex.js';
import { createInboxRouter } from './inboxRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const SOURCE_ID = 'arrl-scholarship-descriptions';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };
const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@example.com', role: 'admin' };

function buildApp(db: Database.Database, user: SessionUser) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => {
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/inbox', createInboxRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

/** The published record, read back through Plan 1's repository (R1). */
function published(db: Database.Database, id = 'arrl-foundation-scholarship') {
  const program = createProgramRepo(db).get(id);
  if (program === undefined) throw new Error(`expected ${id} to be in the corpus`);
  return program;
}

/**
 * The published fixture's own note already says "Dec 30", so the assertions use
 * a sentinel phrase that exists ONLY on the candidate. Without it,
 * `not.toContain('Dec 30')` would pass against the seeded record and the
 * "a rejection must not publish" test would prove nothing.
 */
const CANDIDATE_SENTINEL = 'confirmed on the ARRL portal';

/**
 * RESOLUTIONS R9/R26. Plan 2's `normalizeRaw` stamps `source:<sourceId>` and
 * `key:<externalKey>` into `Program.tags`, and `sourceKeyFor` reads them back on
 * the way into `programs.source_id` / `programs.external_key`. A candidate
 * without them approves into the corpus with a NULL source key, and then fires
 * `new` again every single night.
 */
const CANDIDATE_TAGS = [
  ...arrlScholarship.tags,
  `source:${SOURCE_ID}`,
  'key:arrl-foundation-scholarship-program',
];

const candidateFor = (over: Partial<Program> = {}): Program => ({
  ...arrlScholarship,
  deadline: {
    ...arrlScholarship.deadline,
    note: `Opens about Oct 30; closes Dec 30 at 12:00 PM EST (${CANDIDATE_SENTINEL}).`,
  },
  tags: CANDIDATE_TAGS,
  ...over,
});

/**
 * The reject key EXACTLY as Plan 2 mints it. `buildReviewItems` computes
 * `rejectKeyFor(sourceId, candidate)` and asks `isRejected` about that key, so a
 * row whose stored key is anything else remembers a rejection nothing will ever
 * look up — see "reject memory" below, which proves it end to end.
 */
const PRODUCTION_REJECT_KEY = rejectKeyFor(SOURCE_ID, candidateFor());

/** A pending review item: the ARRL close moved from Jan 31 to Dec 30. */
function seedPendingItem(db: Database.Database, rejectKey: string | null = PRODUCTION_REJECT_KEY) {
  db.prepare(
    `INSERT INTO change_events
       (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ce-1', SOURCE_ID, 'arrl-foundation-scholarship',
    'deadline_changed', JSON.stringify('January 31'), JSON.stringify('December 30, 12:00 PM EST'),
    NOW, 'deadline.note');

  db.prepare(
    `INSERT INTO review_items
       (id, change_event_id, candidate_json, decision, decided_by, decided_at, confidence, reject_key)
     VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
  ).run('ri-1', 'ce-1', JSON.stringify(candidateFor()), 0.82, rejectKey);
}

/**
 * A second pending item whose change event says the record VANISHED from its
 * source. Approving it must DELETE the program, not republish it — which is
 * exactly the divergence RESOLUTIONS R26 closes by delegating to
 * `approveReviewItem` instead of upserting the candidate unconditionally.
 */
function seedVanishedItem(db: Database.Database) {
  db.prepare(
    `INSERT INTO change_events
       (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
  ).run('ce-2', SOURCE_ID, 'arrl-foundation-scholarship',
    'vanished', JSON.stringify('ARRL Foundation Scholarship Program'), NOW);

  db.prepare(
    `INSERT INTO review_items
       (id, change_event_id, candidate_json, decision, decided_by, decided_at, confidence, reject_key)
     VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
  ).run('ri-2', 'ce-2', JSON.stringify({ ...arrlScholarship, tags: CANDIDATE_TAGS }), 0.5);
}

describe('inbox API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    seedPendingItem(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lets a member read the queue', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/inbox');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].decision).toBe('pending');
    expect(res.body.rows[0].changeEvent.kind).toBe('deadline_changed');
  });

  it('tells the client the viewer cannot decide, so the UI can render read-only', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/inbox');
    expect(res.body.canDecide).toBe(false);
    const admin = await request(buildApp(db, ADMIN)).get('/api/inbox');
    expect(admin.body.canDecide).toBe(true);
  });

  it('shows the before and after of the pending change to a member', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/inbox');
    expect(res.body.rows[0].changeEvent.before).toBe('January 31');
    expect(res.body.rows[0].changeEvent.after).toBe('December 30, 12:00 PM EST');
  });

  /**
   * Every field of `InboxRow` in one assertion. A row shape whose fields are
   * only spot-checked is how "written but never read" survives review: the
   * Inbox UI (Task 23) renders `confidence` and keys its reject button off the
   * row, so both have to arrive, and `rejectKey` has to arrive as the key the
   * next crawl will actually look up.
   */
  it('returns the whole row, not a subset the UI then has to refetch', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/inbox');
    expect(res.body.rows[0]).toEqual({
      id: 'ri-1',
      decision: 'pending',
      decidedBy: null,
      decidedAt: null,
      confidence: 0.82,
      rejectKey: PRODUCTION_REJECT_KEY,
      candidate: expect.objectContaining({ id: 'arrl-foundation-scholarship' }),
      changeEvent: {
        id: 'ce-1',
        sourceId: SOURCE_ID,
        programId: 'arrl-foundation-scholarship',
        kind: 'deadline_changed',
        before: 'January 31',
        after: 'December 30, 12:00 PM EST',
        detectedAt: NOW,
        fieldPath: 'deadline.note',
      },
    });
  });

  it('refuses a member decision with 403 in the one error envelope', async () => {
    const res = await request(buildApp(db, MEMBER))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'approved' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    const row = db.prepare('SELECT decision FROM review_items WHERE id = ?').get('ri-1') as { decision: string };
    expect(row.decision).toBe('pending');
  });

  /**
   * Read-only for members is a PRODUCT decision with a security consequence, so
   * it is proved against every decision the route accepts rather than against
   * the one the happy path uses. The guard runs before the body is looked at,
   * so an invalid decision from a member is still a 403 and never a 422 that
   * leaks which values exist.
   */
  it('refuses a member on every decision value, and writes nothing at all', async () => {
    const app = buildApp(db, MEMBER);
    for (const body of [
      { decision: 'approved' },
      { decision: 'rejected', reason: 'no' },
      { decision: 'edited', candidate: candidateFor() },
      { decision: 'maybe' },
    ]) {
      const res = await request(app).post('/api/inbox/ri-1/decision').send(body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_rejects').get()).toEqual({ n: 0 });
    expect(published(db).deadline.note).not.toContain(CANDIDATE_SENTINEL);
  });

  it('lets an admin approve, publishing the candidate into the corpus', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'approved' });
    expect(res.status).toBe(200);
    expect(published(db).deadline.note).toContain(CANDIDATE_SENTINEL);
  });

  // --- RESOLUTIONS R26: the four behaviours that only Plan 2's review pipeline
  //     gets right, asserted here because this route is the ONLY path a human
  //     ever takes to reach it. -------------------------------------------------

  it('lands the source key on approval, so tomorrow’s crawl does not re-fire `new`', async () => {
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const row = db
      .prepare('SELECT source_id, external_key FROM programs WHERE id = ?')
      .get('arrl-foundation-scholarship');
    // With source_id NULL, listProgramsBySource misses the record, diffPrograms
    // sees an empty `previous`, and it fires `new` every night forever (R9).
    expect(row).toEqual({
      source_id: SOURCE_ID,
      external_key: 'arrl-foundation-scholarship-program',
    });
  });

  it('deletes the program when an approved change event says it vanished', async () => {
    seedVanishedItem(db);
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-2/decision')
      .send({ decision: 'approved' });
    expect(res.status).toBe(200);
    expect(createProgramRepo(db).get('arrl-foundation-scholarship')).toBeUndefined();
    // The browse projection is rebuilt wholesale, so the row goes with it.
    expect(
      db.prepare('SELECT 1 FROM program_search WHERE program_id = ?').get('arrl-foundation-scholarship'),
    ).toBeUndefined();
  });

  it('writes review_rejects on a rejection, so the same candidate never returns', async () => {
    await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'rejected', reason: 'past award, not an opportunity' });
    const row = db
      .prepare('SELECT decided_by, decided_at FROM review_rejects WHERE reject_key = ?')
      .get(PRODUCTION_REJECT_KEY);
    expect(row).toEqual({ decided_by: 'u-admin', decided_at: NOW });
  });

  it('appends an audit_log row for every decision, so the provenance trail is never empty', async () => {
    const actions = (id: string) =>
      db
        .prepare('SELECT actor_user_id, action, entity_type FROM audit_log WHERE entity_id = ? ORDER BY id')
        .all(id);
    const app = buildApp(db, ADMIN);

    await request(app).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    await request(app)
      .post('/api/inbox/ri-1/decision')
      .send({
        decision: 'edited',
        candidate: { ...arrlScholarship, tags: CANDIDATE_TAGS, name: 'ARRL Foundation Scholarships' },
      });
    expect(actions('ri-1')).toEqual([
      { actor_user_id: 'u-admin', action: 'review.approve', entity_type: 'review_item' },
      { actor_user_id: 'u-admin', action: 'review.edit', entity_type: 'review_item' },
    ]);

    seedVanishedItem(db);
    await request(app)
      .post('/api/inbox/ri-2/decision')
      .send({ decision: 'rejected', reason: 'the page was just down' });
    expect(actions('ri-2')).toEqual([
      { actor_user_id: 'u-admin', action: 'review.reject', entity_type: 'review_item' },
    ]);
  });

  it('reindexes browse after an approval so filters see the new value', async () => {
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const row = db
      .prepare('SELECT deadline_kind FROM program_search WHERE program_id = ?')
      .get('arrl-foundation-scholarship') as { deadline_kind: string };
    expect(row.deadline_kind).toBe('annual_window');
  });

  it('notifies watchers when a change is approved', async () => {
    starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const n = db.prepare('SELECT title FROM notifications WHERE user_id = ?').get('u-member') as
      | { title: string }
      | undefined;
    expect(n?.title).toBe('Deadline changed: ARRL Foundation Scholarship Program');
  });

  /**
   * `watches.program_id` is `ON DELETE CASCADE` and approving a `vanished` event
   * DELETES the program, so the fan-out has to happen BEFORE the decision is
   * delegated: deleting first cascades away the very rows that say who to tell,
   * `drainChangeEvents` finds no watchers, and `change_event_fanout` then
   * records that event as delivered-to-nobody forever. "This programme
   * disappeared from its funder's site" is the single most important thing the
   * digest ever says, and the one person guaranteed not to hear it would be the
   * user who asked to be told about that programme. (Found by Task 8.)
   */
  it('tells the watcher a record vanished, before the delete takes the watch with it', async () => {
    starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
    seedVanishedItem(db);
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-2/decision').send({ decision: 'approved' });
    const n = db
      .prepare("SELECT title, program_name FROM notifications WHERE user_id = ? AND kind = 'vanished'")
      .get('u-member') as { title: string; program_name: string } | undefined;
    expect(n?.title).toBe('Record vanished from its source: ARRL Foundation Scholarship Program');
    expect(n?.program_name).toBe('ARRL Foundation Scholarship Program');
    expect(createProgramRepo(db).get('arrl-foundation-scholarship')).toBeUndefined();
  });

  /**
   * A rejection is the reviewer saying "this change is not real". Fanning it out
   * would tell every watcher of the program about a move that never happened.
   */
  it('notifies nobody when the change is rejected', async () => {
    starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
    await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'rejected', reason: 'the page was mid-edit' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
  });

  it('records who decided and when', async () => {
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const row = db
      .prepare('SELECT decision, decided_by, decided_at FROM review_items WHERE id = ?')
      .get('ri-1') as { decision: string; decided_by: string; decided_at: string };
    expect(row).toEqual({ decision: 'approved', decided_by: 'u-admin', decided_at: NOW });
  });

  it('lets an admin reject, and a rejection publishes nothing', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'rejected', reason: 'past award, not an opportunity' });
    expect(res.status).toBe(200);
    expect(res.body.published).toBe(false);
    const row = db
      .prepare('SELECT decision, reject_key FROM review_items WHERE id = ?')
      .get('ri-1') as { decision: string; reject_key: string };
    expect(row.decision).toBe('rejected');
    expect(row.reject_key).toBe(PRODUCTION_REJECT_KEY);
    // A rejection must NOT publish. The sentinel is on the CANDIDATE only —
    // the seeded record's own note already mentions Dec 30.
    expect(published(db).deadline.note).not.toContain(CANDIDATE_SENTINEL);
  });

  it('lets an admin edit the candidate before publishing it', async () => {
    const edited = {
      ...arrlScholarship,
      tags: CANDIDATE_TAGS,
      deadline: { ...arrlScholarship.deadline, note: 'Closes Dec 30 at 12:00 PM EST (hand-checked).' },
    };
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'edited', candidate: edited });
    expect(res.status).toBe(200);
    expect(published(db).deadline.note).toContain('hand-checked');
  });

  it('rejects an edited candidate that fails the core schema, with 422', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'edited', candidate: { id: 'x' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('rejects an unknown decision value with 422', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'maybe' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  /** `pending` is the queue's own resting state, not a decision a human takes. */
  it('rejects "pending" as a decision with 422, leaving the row untouched', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'pending' });
    expect(res.status).toBe(422);
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual({ n: 0 });
  });

  it('404s an unknown review item', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/nope/decision')
      .send({ decision: 'approved' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('filters by decision so the UI can default to pending', async () => {
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const pending = await request(buildApp(db, MEMBER)).get('/api/inbox?decision=pending');
    expect(pending.body.rows).toEqual([]);
    const approved = await request(buildApp(db, MEMBER)).get('/api/inbox?decision=approved');
    expect(approved.body.rows).toHaveLength(1);
  });

  it('ignores a decision filter it does not recognise rather than returning nothing', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/inbox?decision=; DROP TABLE review_items');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
  });
});

/**
 * REJECT MEMORY, END TO END — and the brief's own defect.
 *
 * The brief (and Task 23's UI, which posts it) had this route take a
 * `rejectKey` FROM THE CLIENT and write it over the row before delegating:
 * `'arrl-scholarship-descriptions:deadline.note:December 30, 12:00 PM EST'`.
 * `rememberReject` then stores that human-readable string in `review_rejects`.
 *
 * But `buildReviewItems` — the only constructor of the queue — looks memory up
 * under `rejectKeyFor(sourceId, candidate)`, a sha256 of
 * `sourceId|program.id|hashProgram(program)`. A key a human typed is one the
 * next crawl will never compute, so the rejection suppresses NOTHING and the
 * candidate returns tomorrow night, and every night after, under a fresh review
 * item id. That is precisely the bug the brief says delegating to Plan 2 avoids,
 * reintroduced one line above the delegation.
 *
 * The route therefore derives the key server-side and ignores the client's.
 */
describe('reject memory survives the next crawl', () => {
  let db: Database.Database;

  const CLIENT_SUPPLIED_KEY = `${SOURCE_ID}:deadline.note:December 30, 12:00 PM EST`;

  const event = (id: string): ChangeEvent => ({
    id,
    sourceId: SOURCE_ID,
    programId: 'arrl-foundation-scholarship',
    kind: 'deadline_changed',
    fieldPath: 'deadline.note',
    before: 'January 31',
    after: 'December 30, 12:00 PM EST',
    detectedAt: NOW,
  });

  /** Tonight's queue, built the way the crawler builds it. */
  const queue = async (eventId: string) =>
    buildReviewItems(
      db,
      [event(eventId)],
      new Map([['arrl-foundation-scholarship', candidateFor()]]),
      'C',
      SOURCE_ID,
      undefined,
      undefined,
    );

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  it('suppresses the same candidate on the next crawl', async () => {
    db.prepare(
      `INSERT INTO change_events (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES ('ce-tonight', ?, 'arrl-foundation-scholarship', 'deadline_changed', '"January 31"', '"December 30"', ?, 'deadline.note')`,
    ).run(SOURCE_ID, NOW);
    const [item] = await queue('ce-tonight');
    expect(item).toBeDefined();

    const res = await request(buildApp(db, ADMIN))
      .post(`/api/inbox/${item!.id}/decision`)
      // exactly what Task 23's UI posts — and it must change nothing.
      .send({ decision: 'rejected', rejectKey: CLIENT_SUPPLIED_KEY, reason: 'not an opportunity' });
    expect(res.status).toBe(200);

    // Tomorrow night: same source, same candidate, a new change event id.
    db.prepare(
      `INSERT INTO change_events (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES ('ce-tomorrow', ?, 'arrl-foundation-scholarship', 'deadline_changed', '"January 31"', '"December 30"', ?, 'deadline.note')`,
    ).run(SOURCE_ID, NOW);
    expect(await queue('ce-tomorrow')).toEqual([]);
  });

  it('never lets the client choose the key the next crawl will look up', async () => {
    seedPendingItem(db);
    await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'rejected', rejectKey: CLIENT_SUPPLIED_KEY });
    const keys = db.prepare('SELECT reject_key FROM review_rejects').all();
    expect(keys).toEqual([{ reject_key: PRODUCTION_REJECT_KEY }]);
    expect(
      db.prepare('SELECT reject_key FROM review_items WHERE id = ?').get('ri-1'),
    ).toEqual({ reject_key: PRODUCTION_REJECT_KEY });
  });

  /**
   * `review_items.reject_key` is nullable and every row Plan 2 builds carries
   * one — but `rejectReviewItem` only remembers `if (item.rejectKey)`, so a row
   * that somehow has none is a rejection that silently remembers nothing. The
   * route derives it with Plan 2's own `rejectKeyFor` rather than inventing a
   * second key format, so the memory it writes is the one tomorrow's
   * `buildReviewItems` looks up.
   */
  it('derives the key for a row that has none, instead of remembering nothing', async () => {
    seedPendingItem(db, null);
    await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'rejected', reason: 'not an opportunity' });
    expect(db.prepare('SELECT reject_key FROM review_rejects').all()).toEqual([
      { reject_key: PRODUCTION_REJECT_KEY },
    ]);
  });
});

/**
 * The suppressed corpus. 37 ARRL clubs that have ALREADY been funded, 424 ARDC
 * award rows, 45 USAspending and 38 NSF historical awards are all stored on
 * purpose and are all publishable-looking `Program` records. `buildReviewItems`
 * keeps them out of the queue; `approveReviewItem` refuses them at the publish
 * branch. This route must route around neither gate — and when the backstop
 * fires it has to arrive in Plan 1's envelope, not as a 500 that reads like the
 * server broke.
 */
describe('records the pipeline suppresses', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSuppressedItem(candidate: Program) {
    db.prepare(
      `INSERT INTO change_events (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES ('ce-old', 'arrl-club-grant', ?, 'new', NULL, ?, ?, NULL)`,
    ).run(candidate.id, JSON.stringify(candidate), NOW);
    db.prepare(
      `INSERT INTO review_items (id, change_event_id, candidate_json, decision, confidence, reject_key)
       VALUES ('ri-old', 'ce-old', ?, 'pending', 0.5, NULL)`,
    ).run(JSON.stringify(candidate));
  }

  const pastAward: Program = {
    ...arrlScholarship,
    id: 'arrl-club-grant-past-recipient',
    name: 'Some Radio Club (2024 club grant recipient)',
    tags: ['arrl', DO_NOT_PUBLISH_TAG],
  };

  it('refuses to approve a do_not_publish record, in the envelope and with no publish', async () => {
    seedSuppressedItem(pastAward);
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-old/decision')
      .send({ decision: 'approved' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.message).toMatch(/do_not_publish/);
    expect(createProgramRepo(db).get(pastAward.id)).toBeUndefined();
    expect(
      db.prepare('SELECT decision FROM review_items WHERE id = ?').get('ri-old'),
    ).toEqual({ decision: 'pending' });
  });

  it('refuses an EDIT that would publish a do_not_publish record', async () => {
    seedSuppressedItem(pastAward);
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-old/decision')
      .send({ decision: 'edited', candidate: { ...pastAward, name: 'Some Radio Club' } });
    expect(res.status).toBe(409);
    expect(createProgramRepo(db).get(pastAward.id)).toBeUndefined();
  });

  /**
   * spec §domain-fact 4. `farweb.org` was taken over and now 301s to a gambling
   * site, while ARRL, QCWA and club pages still say "apply at the FAR website".
   * The corpus answers that search with a WARNING record, and this queue has to
   * carry it as exactly that: `discontinued`, never `open`, and with no string
   * anywhere in the response that names the hijacked host — a reviewer reading
   * an Inbox row is one click from republishing whatever link it contains.
   *
   * The record's `applyUrl` is deliberately NOT empty: it is
   * `arrl.org/scholarship-program`, the intake FAR's portfolio moved to, because
   * this record exists to intercept "apply at FAR" and send the applicant
   * somewhere real. The assertion is therefore about the HOST, not about
   * absence.
   */
  it('carries the farweb.org record as a warning and never as a link', async () => {
    // The REAL corpus record, normalized exactly as the crawl normalizes it —
    // not a hand-built stand-in, which could not catch the record acquiring a
    // link or an `open` status later.
    const raw = TIER_D_RECORDS.find((r) => r.externalKey === 'far-farweb-org-compromised');
    expect(raw).toBeDefined();
    const warning = normalizeRaw(raw!, contextForSource(manualTierD, NOW));
    expect(warning.name).toMatch(/do not apply/i);

    db.prepare(
      `INSERT INTO change_events (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES ('ce-far', 'manual-tier-d', ?, 'new', NULL, ?, ?, NULL)`,
    ).run(warning.id, JSON.stringify(warning), NOW);
    db.prepare(
      `INSERT INTO review_items (id, change_event_id, candidate_json, decision, confidence, reject_key)
       VALUES ('ri-far', 'ce-far', ?, 'pending', 0.95, NULL)`,
    ).run(JSON.stringify(warning));

    const res = await request(buildApp(db, MEMBER)).get('/api/inbox');
    const row = res.body.rows.find((r: { id: string }) => r.id === 'ri-far');
    expect(row.candidate.trust.status).toBe('discontinued');
    expect(new URL(String(row.candidate.applyUrl)).host).toBe('www.arrl.org');
    expect(JSON.stringify(res.body)).not.toContain('farweb.org');
  });
});

/**
 * The parent's fresh-install case, done for real: nothing but migrations, then a
 * genuine crawl of committed fixtures, then a genuine approve through HTTP.
 * Both tests the brief shipped hand-wrote their `funders` INSERT, which is
 * exactly how the fresh install's first approve came to die on a raw
 * `FOREIGN KEY constraint failed` with the whole suite green.
 */
describe('a real crawl into an empty migrated database', () => {
  let db: Database.Database;

  const CRAWL_NOW = '2026-08-02T00:00:00.000Z';

  const fixtureFetcher = (files: Record<string, [string, string]>) => ({
    // No cache to drop: this fake never reads a robots.txt. `Fetcher` requires the method because
    // every real fetcher must be able to forget one — see crawl/runner.ts.
    forgetRobots(): void {},
    async fetch(req: FetchRequest): Promise<FetchedPayload> {
      for (const [part, [sourceId, file]] of Object.entries(files)) {
        if (req.url.includes(part)) return { ...fixturePayload(sourceId, file, req.url), url: req.url };
      }
      return { url: req.url, status: 404, contentType: 'text/html', body: '', fetchedAt: CRAWL_NOW };
    },
  });

  beforeEach(async () => {
    db = openTestDb(); // migrations only: no corpus, no funders, no users
    const fetcher = fixtureFetcher({
      '/club-grant-program': ['arrl-club-grant', '00-www-arrl-org-club-grant-program.html'],
      'rss_www_funding.xml': ['nsf-funding-rss', '00-www-nsf-gov-rss-rss-www-funding-xml.xml'],
      'rss_www_funding_pgm_annc_inf.xml': [
        'nsf-funding-rss',
        '01-www-nsf-gov-rss-rss-www-funding-pgm-annc-inf-xml.xml',
      ],
      'rss_www_funding-upcoming/rss.xml': [
        'nsf-funding-rss',
        '02-www-nsf-gov-rss-rss-www-funding-upcoming-rss-xml.xml',
      ],
    });
    await runSource({ db, fetcher, nowISO: () => CRAWL_NOW }, 'arrl-club-grant');
    await runSource({ db, fetcher, nowISO: () => CRAWL_NOW }, 'nsf-funding-rss');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * 38 club-grant records parse (1 real programme + 37 clubs that already got
   * the money) and 45 NSF solicitations parse, every one of them scoring 0 or 1
   * against an adjacency threshold of 6. All 83 are STORED as change events;
   * exactly one is a thing a human should be asked about. A queue that is 82/83
   * noise trains its reviewer to approve without reading.
   */
  it('shows the reviewer 1 row out of 83 stored change events', async () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_events').get()).toEqual({ n: 83 });

    const res = await request(buildApp(db, MEMBER)).get('/api/inbox');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].candidate.name).toBe('ARRL Club Grant Program');
    expect(JSON.stringify(res.body)).not.toContain(DO_NOT_PUBLISH_TAG);
  });

  it('lets an admin approve the very first item on a fresh install', async () => {
    const list = await request(buildApp(db, ADMIN)).get('/api/inbox');
    const id = list.body.rows[0].id as string;

    const res = await request(buildApp(db, ADMIN)).post(`/api/inbox/${id}/decision`).send({ decision: 'approved' });
    // A raw FOREIGN KEY failure here would arrive as a 500 `internal`.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, decision: 'approved', decidedBy: 'u-admin', decidedAt: NOW, published: true });

    const program = createProgramRepo(db).list()[0];
    expect(program?.name).toBe('ARRL Club Grant Program');
    expect(
      db.prepare('SELECT source_id FROM programs WHERE id = ?').get(program!.id),
    ).toEqual({ source_id: 'arrl-club-grant' });
    // ...and the browse projection the same request rebuilt now carries it.
    expect(db.prepare('SELECT COUNT(*) AS n FROM program_search').get()).toEqual({ n: 1 });
  });

  it('refuses the same first decision to a member', async () => {
    const list = await request(buildApp(db, MEMBER)).get('/api/inbox');
    expect(list.body.canDecide).toBe(false);
    const id = list.body.rows[0].id as string;

    const res = await request(buildApp(db, MEMBER)).post(`/api/inbox/${id}/decision`).send({ decision: 'approved' });
    expect(res.status).toBe(403);
    expect(createProgramRepo(db).list()).toEqual([]);
  });
});

/**
 * ORDER INDEPENDENCE. 112 of 181 real ARRL-catalog candidates inherit their
 * deadline from `arrl-foundation-scholarships`, so which Inbox row a human
 * clicks first decided whether the majority of the corpus ever got a calendar
 * entry. Plan 2 fixed that with `backfillInheritedDependents`; this route
 * inherits the fix only for as long as it keeps delegating, so the guard lives
 * where a human's clicks actually enter the system.
 */
describe('approval order', () => {
  const OWNER: Program = {
    ...arrlScholarship,
    id: 'order-owner',
    name: 'Owner Programme',
    tags: ['source:order-src', 'key:owner'],
  };
  const DEPENDENT: Program = {
    ...arrlScholarship,
    id: 'order-dependent',
    name: 'Dependent Programme',
    deadline: {
      kind: 'annual_window',
      source: { kind: 'inherited', fromProgramId: 'order-owner' },
      note: 'Deadline set by the Owner Programme.',
    },
    tags: ['source:order-src', 'key:dependent'],
  };

  function seedPair(db: Database.Database) {
    for (const [n, program] of [OWNER, DEPENDENT].entries()) {
      db.prepare(
        `INSERT INTO change_events (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
         VALUES (?, 'order-src', ?, 'new', NULL, ?, ?, NULL)`,
      ).run(`ce-${n}`, program.id, JSON.stringify(program), NOW);
      db.prepare(
        `INSERT INTO review_items (id, change_event_id, candidate_json, decision, confidence, reject_key)
         VALUES (?, ?, ?, 'pending', 0.8, NULL)`,
      ).run(`ri-${program.id}`, `ce-${n}`, JSON.stringify(program));
    }
  }

  async function approveInOrder(ids: string[]): Promise<unknown[]> {
    const db = openTestDb();
    try {
      seedFixtureCorpus(db); // for the `arrl-foundation` funder row both candidates reference
      seedPair(db);
      const app = buildApp(db, ADMIN);
      for (const id of ids) {
        const res = await request(app).post(`/api/inbox/${id}/decision`).send({ decision: 'approved' });
        expect(res.status).toBe(200);
      }
      return db
        .prepare('SELECT id, program_id, opens_at, closes_at, timezone, label, is_estimated FROM cycles ORDER BY id')
        .all();
    } finally {
      db.close();
    }
  }

  it('converges on byte-identical cycles whichever row the admin clicks first', async () => {
    const ownerFirst = await approveInOrder(['ri-order-owner', 'ri-order-dependent']);
    const dependentFirst = await approveInOrder(['ri-order-dependent', 'ri-order-owner']);
    expect(dependentFirst).toEqual(ownerFirst);
    expect(ownerFirst.length).toBeGreaterThan(0);
    // and the dependent really did get a calendar of its own, not just the owner
    expect(
      (ownerFirst as Array<{ program_id: string }>).some((c) => c.program_id === 'order-dependent'),
    ).toBe(true);
  });
});

/**
 * THE ONE EDIT THAT DELETES DATES, AND THE ONLY PLACE IT CAN BE REFUSED.
 *
 * `DeadlineSpec.note` carries the `RECUR` directive `expandCycles` reads, and `editReviewItem`
 * re-projects the record's cycles from the EDITED note — `writeCyclesFor` deletes the old ones
 * before writing the new. So an edit that drops the directive does not stop adding dates: it
 * removes every future date already published for that programme, and for every programme that
 * inherits its deadline.
 *
 * MEASURED THROUGH THE BROWSER, on the corpus a real deployment gets (`data/seed/`, 143 records,
 * built by booting the server on an empty DATA_DIR). An administrator opened "Edit" on a pending
 * candidate, deleted the `RECUR …|` prefix, kept the prose, and pressed "Save and approve":
 * `arrl-foundation-scholarships` went from 2 projected cycles to 0, its 112 inheritors from 224 to
 * 0, and the whole `cycles` table from 243 rows to 17. The same walk on the fixture corpus: 2 → 0,
 * 224 → 0, 244 → 18.
 *
 * Task 23's panel no longer puts the directive in the textarea, which is the fix a human meets.
 * This is the one that holds for a request that did not come from that panel — the route takes a
 * whole `Program` from any administrator's HTTP client, and an invariant enforced only in a
 * browser is not enforced.
 */
describe('the recurrence rule inside an edited deadline note', () => {
  let db: Database.Database;

  /** The candidate is the fixture's own ARRL record, whose note really carries the directive. */
  const DIRECTIVE = 'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00';
  const PROSE = 'Opens about Oct 30; closes Dec 30 at 12:00 PM EST. Moved from Jan 31 - do not hardcode.';
  const ruleCandidate = (note: string): Program => ({
    ...arrlScholarship,
    tags: CANDIDATE_TAGS,
    deadline: { ...arrlScholarship.deadline, note },
  });

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    db.prepare(
      `INSERT INTO change_events
         (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES ('ce-rule', ?, 'arrl-foundation-scholarship', 'deadline_changed', ?, ?, ?, 'deadline')`,
    ).run(
      SOURCE_ID,
      JSON.stringify(arrlScholarship.deadline),
      JSON.stringify(ruleCandidate(`${DIRECTIVE} | ${PROSE}`).deadline),
      NOW,
    );
    db.prepare(
      `INSERT INTO review_items
         (id, change_event_id, candidate_json, decision, confidence, reject_key)
       VALUES ('ri-rule', 'ce-rule', ?, 'pending', 0.82, NULL)`,
    ).run(JSON.stringify(ruleCandidate(`${DIRECTIVE} | ${PROSE}`)));
    // The state a deployment is in from its first crawl onward: the rule has been projected, so
    // there are dates to lose.
    reprojectAllCycles(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  const cycleCount = (programId = 'arrl-foundation-scholarship'): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM cycles WHERE program_id = ?').get(programId) as { n: number }).n;

  /**
   * WHAT THE GUARD IS GUARDING, stated by running the deletion past it. `editReviewItem` is Plan
   * 2's own writer and has no opinion about notes; called with a stripped one it does exactly what
   * the route used to let a browser ask for.
   */
  it('really does delete the projected dates when the directive goes (this is the mechanism)', () => {
    expect(cycleCount()).toBeGreaterThan(0);
    editReviewItem(db, 'ri-rule', ADMIN.id, NOW, ruleCandidate(PROSE));
    expect(cycleCount()).toBe(0);
  });

  it('refuses an edit that drops the rule, with 422 and the corpus untouched', async () => {
    const before = cycleCount();
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-rule/decision')
      .send({ decision: 'edited', candidate: ruleCandidate(PROSE) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(cycleCount()).toBe(before);
    expect(published(db).deadline.note).toBe(arrlScholarship.deadline.note);
    expect(
      db.prepare('SELECT decision FROM review_items WHERE id = ?').get('ri-rule'),
    ).toEqual({ decision: 'pending' });
  });

  /**
   * The message is the whole of the refusal a reviewer meets: it has to say what the rule is FOR
   * and where a wrong one gets fixed, or the next thing that happens is a second attempt.
   */
  it('says what would have been lost and where the rule is actually fixed', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-rule/decision')
      .send({ decision: 'edited', candidate: ruleCandidate(PROSE) });
    expect(res.body.error.message).toBe(
      'The deadline note on this candidate carries the repeat rule GrantSpotter reads to ' +
        'generate every future date for this programme, and this edit does not carry the same ' +
        'rule. Saving it would delete those dates, here and on every record that inherits this ' +
        'deadline. The review queue edits the funder’s own sentences and leaves the rule alone; ' +
        'a rule that is itself wrong is a fix to the source this record came from, not to one ' +
        'queued candidate.',
    );
  });

  it('refuses an edit that MOVES the rule as well as one that deletes it', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-rule/decision')
      .send({
        decision: 'edited',
        candidate: ruleCandidate(
          `RECUR annual_window tz=America/New_York window=10-30..12-15 close=12:00 | ${PROSE}`,
        ),
      });
    expect(res.status).toBe(422);
    expect(cycleCount()).toBeGreaterThan(0);
  });

  /**
   * A directive core cannot parse is its own value, not "no rule": it projects nothing today, but
   * it is still the record of what the source said, and an edit is not where it disappears.
   */
  it('refuses to drop a directive it cannot even read', async () => {
    db.prepare('UPDATE review_items SET candidate_json = ? WHERE id = ?').run(
      JSON.stringify(ruleCandidate(`RECUR n_fixed_dates tz=Mars/Olympus dates=02-01 | ${PROSE}`)),
      'ri-rule',
    );
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-rule/decision')
      .send({ decision: 'edited', candidate: ruleCandidate(PROSE) });
    expect(res.status).toBe(422);
  });

  it('accepts the edit this panel exists for: the rule kept, the sentences rewritten', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-rule/decision')
      .send({
        decision: 'edited',
        candidate: ruleCandidate(`${DIRECTIVE} | Closes Dec 30, hand-checked on the ARRL portal.`),
      });
    expect(res.status).toBe(200);
    expect(published(db).deadline.note).toBe(
      `${DIRECTIVE} | Closes Dec 30, hand-checked on the ARRL portal.`,
    );
    // The dates survived the edit, which is the point of refusing the other one.
    expect(cycleCount()).toBeGreaterThan(0);
  });

  it('accepts a directive written differently for the same schedule, because it is the same dates', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-rule/decision')
      .send({
        decision: 'edited',
        candidate: ruleCandidate(
          `RECUR  annual_window   tz=America/New_York window=10-30..12-30 close=12:00 | ${PROSE}`,
        ),
      });
    expect(res.status).toBe(200);
    expect(cycleCount()).toBeGreaterThan(0);
  });

  /**
   * DIRECTIONAL, and deliberately so. The failure being closed is the silent deletion of a rule
   * the reviewer was never shown. A stored note carrying none has nothing to lose, and refusing
   * that case would forbid a reviewer encoding a schedule the source states — for no reason this
   * route could give.
   */
  it('lets a note that carried no rule gain one', async () => {
    db.prepare('UPDATE review_items SET candidate_json = ? WHERE id = ?').run(
      JSON.stringify(ruleCandidate('Closes Dec 30 at 12:00 PM EST.')),
      'ri-rule',
    );
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-rule/decision')
      .send({ decision: 'edited', candidate: ruleCandidate(`${DIRECTIVE} | ${PROSE}`) });
    expect(res.status).toBe(200);
    expect(published(db).deadline.note).toBe(`${DIRECTIVE} | ${PROSE}`);
  });

  it('leaves approvals and rejections alone — this is a rule about EDITS', async () => {
    const approved = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-rule/decision')
      .send({ decision: 'approved' });
    expect(approved.status).toBe(200);
    expect(cycleCount()).toBeGreaterThan(0);
  });
});
