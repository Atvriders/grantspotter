import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, arrlClubGrant } from '../test/fixtures/programs.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { contextForSource } from '../crawl/context.js';
import { normalizeRaw } from '../normalize/index.js';
import { TIER_D_RECORDS, manualTierD } from '../sources/manual-tier-d.js';
import { reindexBrowse } from './reindex.js';
import { createProgramsRouter } from './programsRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => MEMBER,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/programs', createProgramsRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

describe('GET /api/programs/:id', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('404s for an unknown id, in the one error envelope', async () => {
    const res = await request(buildApp(db)).get('/api/programs/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.message).toContain('does-not-exist');
    expect(typeof res.body.requestId).toBe('string');
  });

  it('returns the full record, the funder with its homepage, and the resolved cycles', async () => {
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.status).toBe(200);
    expect(res.body.program.name).toBe('ARDC Grants Program');
    expect(res.body.funder.name).toBe('Amateur Radio Digital Communications');
    expect(res.body.funder.homepage).toBe('https://www.ardc.net/');
    expect(res.body.cycles.length).toBeGreaterThan(0);
  });

  it('names the program a deadline was inherited from', async () => {
    const res = await request(buildApp(db)).get('/api/programs/qcwa-memorial-scholarship');
    expect(res.body.deadlineOwner).toEqual({
      programId: 'arrl-foundation-scholarship',
      programName: 'ARRL Foundation Scholarship Program',
    });
  });

  it('reports deadlineOwner null for a program that owns its own deadline', async () => {
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.body.deadlineOwner).toBeNull();
  });

  it('returns every disputed claim with its source rather than picking one', async () => {
    const res = await request(buildApp(db)).get('/api/programs/arrl-club-grant');
    expect(res.body.program.trust.disputed.claims).toHaveLength(3);
    for (const claim of res.body.program.trust.disputed.claims) {
      expect(claim.sourceUrl).toMatch(/^https?:\/\//);
    }
  });

  it('returns the obligations that applicants miss', async () => {
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.body.program.obligations.indirectCostCapPct).toBe(20);
    expect(res.body.program.obligations.licenseObligation).toContain('open-source');
  });

  it('returns the aiPolicy quote with its url', async () => {
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.body.program.aiPolicy.stance).toBe('permitted');
    expect(res.body.program.aiPolicy.url)
      .toBe('https://www.ardc.net/apply/grant-application-instructions/');
  });

  it('returns provenance rows when they exist', async () => {
    db.prepare(
      `INSERT INTO field_provenance
        (program_id, field_path, source_id, snapshot_id, raw_label, raw_value, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'ardc-grants', 'deadline.note', 'ardc-wp-pages', 'snap-9',
      'Application deadlines', 'February 1, April 1, July 1, September 1', NOW,
    );
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.body.provenance).toHaveLength(1);
    expect(res.body.provenance[0].rawValue)
      .toBe('February 1, April 1, July 1, September 1');
  });

  it('returns an empty provenance array rather than omitting the key', async () => {
    const res = await request(buildApp(db)).get('/api/programs/arrl-club-grant');
    expect(res.body.provenance).toEqual([]);
  });

  /**
   * ADDED BY TASK 5, not in the brief. A row that names a real snapshot must
   * resolve to the page that snapshot recorded, or the detail panel shows a
   * value, a label and no address.
   *
   * The snapshot is written the way Plan 1's DDL actually defines it, which is
   * how a second brief defect surfaced: `snapshots.id` is
   * `INTEGER PRIMARY KEY AUTOINCREMENT` and `snapshots.source_id` is a real
   * foreign key to `sources`, so the `'snap-1'` / `'snap-9'` ids the brief
   * passes to `recordProvenance` are not snapshot ids and never could be. That
   * is survivable only because `source_url` is stored on the row itself; with
   * the brief's seven columns, a provenance row's sole route to a url would
   * have been a join that never matches.
   */
  it('resolves a provenance row that names a snapshot to that snapshot\'s url', async () => {
    db.prepare(
      `INSERT INTO sources (id, funder_id, label, tier, klass) VALUES (?, ?, ?, ?, ?)`,
    ).run('ardc-wp-pages', 'ardc', 'ARDC WordPress pages', 'B', 'ham_grant');
    const snapshotId = db
      .prepare(
        `INSERT INTO snapshots (source_id, url, status, body_sha256, fetched_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('ardc-wp-pages', 'https://www.ardc.net/apply/', 200, 'a'.repeat(64), NOW)
      .lastInsertRowid;
    db.prepare(
      `INSERT INTO field_provenance
        (program_id, field_path, source_id, snapshot_id, raw_label, raw_value, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'ardc-grants', 'deadline.note', 'ardc-wp-pages', String(snapshotId),
      'Application deadlines', 'February 1, April 1, July 1, September 1', NOW,
    );
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.body.provenance[0].sourceUrl).toBe('https://www.ardc.net/apply/');
  });

  /**
   * ADDED BY TASK 5, not in the brief. THE HOLE THE BRIEF LEAVES OPEN.
   *
   * ~553 of the corpus's records carry `do_not_publish` — past ARDC/NSF/
   * USAspending awards and the ARRL clubs that have already been funded. Task 3
   * proved none is reachable through browse, because `reindexBrowse` filters
   * them with the shared `isDoNotPublish` predicate and browse reads only the
   * projection. This route does NOT read the projection: it goes straight to
   * `createProgramRepo(db).get(id)`, which knows nothing about suppression. The
   * brief's route therefore serves every suppressed record in full to anyone
   * who can guess an id — and a "past award" record IS the class whose apply
   * url was a grant recipient's Facebook page.
   *
   * The predicate is imported, never reimplemented: when a new suppressed record
   * type is classified in `normalize/index.ts`, this route starts hiding it in
   * the same commit.
   */
  it('404s a do_not_publish record instead of serving it by direct id', async () => {
    const suppressed: Program = {
      ...arrlClubGrant,
      id: 'arrl-club-grant-2024-award',
      name: 'ARRL Club Grant — 2024 award to a funded club',
      tags: [...arrlClubGrant.tags, 'past_award', 'do_not_publish'],
    };
    createProgramRepo(db).upsert(suppressed);

    const res = await request(buildApp(db)).get('/api/programs/arrl-club-grant-2024-award');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    // The published sibling is untouched: this is suppression, not breakage.
    expect((await request(buildApp(db)).get('/api/programs/arrl-club-grant')).status).toBe(200);
  });

  /**
   * ADDED BY TASK 5, not in the brief. The brief's route builds `cycles` from
   * `expandCycles` alone, which only ever yields `isEstimated: true` rows
   * projected from a RECUR rule. A window the funder actually PUBLISHED arrives
   * through core's other channel, `observedCycles`, and `reindexBrowse` merges
   * both — with a documented tie-break that lets the funder's own date win.
   *
   * With `expandCycles` alone the detail page for such a program shows either
   * nothing or a projection, while the browse row beside it shows the funder's
   * real date. Two surfaces disagreeing about a deadline is precisely the
   * failure this product exists to prevent, and `isEstimated` is the flag the
   * UI uses to tell "the funder said so" from "we projected it".
   */
  it('shows the window the funder published, not only the projected ones', async () => {
    const published: Program = {
      ...arrlClubGrant,
      id: 'arrl-club-grant-observed',
      deadline: {
        kind: 'n_fixed_windows',
        source: { kind: 'self' },
        note: 'Application window published by the funder: opens 2026-09-07, closes 2026-11-04.',
      },
    };
    createProgramRepo(db).upsert(published);

    const res = await request(buildApp(db)).get('/api/programs/arrl-club-grant-observed');
    expect(res.status).toBe(200);
    const stated = res.body.cycles.filter((c: { isEstimated: boolean }) => !c.isEstimated);
    expect(stated).toHaveLength(1);
    expect(stated[0].closesAt).toBe('2026-11-04T23:59:59.999Z');
  });

  /**
   * ADDED BY TASK 5, not in the brief, and built from the REAL Tier-D record
   * rather than a hand-written fixture. farweb.org was taken over between
   * 2025-10-17 and 2026-02-10 and now redirects to a gambling site, while ARRL,
   * QCWA and club pages still tell applicants to "apply at the FAR website".
   * The record exists to intercept that instruction, so the one thing the
   * detail response must never contain is the hijacked domain itself — in
   * `applyUrl`, in `trust.sourceUrl`, or anywhere in the serialized body.
   */
  it('serves the farweb.org safety warning without ever emitting the hijacked domain', async () => {
    const far = TIER_D_RECORDS.find((r) => r.externalKey === 'far-farweb-org-compromised');
    if (far === undefined) throw new Error('the FAR safety-warning record is missing from Tier D');
    const program = normalizeRaw(far, contextForSource(manualTierD, NOW));
    createFunderRepo(db).upsert({ id: program.funderId, name: 'Various funders', homepage: '' });
    createProgramRepo(db).upsert(program);

    const res = await request(buildApp(db)).get(`/api/programs/${program.id}`);
    expect(res.status).toBe(200);
    expect(res.body.program.trust.status).toBe('discontinued');
    expect(JSON.stringify(res.body)).toMatch(/Foundation for Amateur Radio/);
    expect(JSON.stringify(res.body)).not.toMatch(/farweb\.org/i);
  });
});
