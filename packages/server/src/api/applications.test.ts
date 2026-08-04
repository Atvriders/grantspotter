import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Profile } from '@grantspotter/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertApplicationSchema, assertExportReady } from '../db/repositories/applications.js';
import { createProfileRepo } from '../db/repositories/profiles.js';
import { seedFixtureCorpus, seedTestUser } from '../test/fixtures/programs.js';
import { openTestDb } from '../test/testDb.js';
import { createApplicationsRouter } from './applications.js';
import type { RouterDeps, SessionUser } from './deps.js';
import { AppError, errorHandler, notFoundHandler } from './errors.js';

let db: Database.Database;
let base: string;
let close: () => Promise<void>;

const NOW = '2026-08-02T00:00:00.000Z';

/** The signed-in caller for this suite. Swapped by the cross-user test. */
let caller: SessionUser = { id: 'user-1', email: 'one@example.org', role: 'member' };

async function start(): Promise<void> {
  // RESOLUTIONS R24: `applications` and `template_instances` come from Plan 1's
  // 001-init.sql, applied by Plan 1's migration runner behind Plan 3's
  // openTestDb(). This suite does NOT exec a migration file of its own — there
  // is no 040-application-writing.sql, and a hand-rolled CREATE TABLE here
  // would let a schema drift between test and production go unnoticed.
  db = openTestDb();

  // `applications.user_id` and `applications.program_id` are REFERENCES with
  // PRAGMA foreign_keys = ON, so both parents have to exist before an insert.
  seedFixtureCorpus(db); // supplies the real `ardc-grants` row
  seedTestUser(db, 'user-1');
  seedTestUser(db, 'user-2');

  caller = { id: 'user-1', email: 'one@example.org', role: 'member' };

  // Fakes for Plan 3's RouterDeps, so this suite tests the router alone and
  // never imports Plan 1's auth module.
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => caller,
  };

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/applications', createApplicationsRouter(deps));
  app.use(notFoundHandler());
  app.use(errorHandler({ logger: () => undefined }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
    });
}

const json = async (
  pathname: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

interface StoredConfirmation {
  confirmed: boolean;
  note: string;
  fingerprint?: string;
}

/** Everything the checklist currently lists, confirmed, exactly as the UI would send it back. */
const confirmAll = (
  items: Array<{ id: string; fingerprint: string }>,
  note = '',
): Record<string, StoredConfirmation> => {
  const out: Record<string, StoredConfirmation> = {};
  for (const item of items) out[item.id] = { confirmed: true, note, fingerprint: item.fingerprint };
  return out;
};

const storedConfirmations = (id: string): Record<string, StoredConfirmation> =>
  JSON.parse(
    (db.prepare('SELECT fact_confirmations_json AS j FROM applications WHERE id = ?').get(id) as {
      j: string;
    }).j,
  ) as Record<string, StoredConfirmation>;

const draft = async (title = 'x'): Promise<string> =>
  (await json('/api/applications', { method: 'POST', body: JSON.stringify({ title }) })).body
    .id as string;

beforeEach(start);
afterEach(async () => close());

describe('applications router', () => {
  it('creates, lists, reads and updates a draft', async () => {
    const created = await json('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ title: 'ARDC station rebuild', programId: 'ardc-grants' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTruthy();
    expect(created.body.title).toBe('ARDC station rebuild');
    expect(created.body.includeDisclosure).toBe(true);

    const listed = await json('/api/applications');
    expect(listed.body.applications).toHaveLength(1);

    const patched = await json(`/api/applications/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        bodyMarkdown: 'W8UM will buy one IC-7300 for $1,099.',
        answers: { 'club.city': 'Ann Arbor' },
      }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.bodyMarkdown).toContain('IC-7300');
    expect(patched.body.answers['club.city']).toBe('Ann Arbor');

    const read = await json(`/api/applications/${created.body.id}`);
    expect(read.body.bodyMarkdown).toContain('$1,099');
  });

  it('timestamps every write from the injected clock, never the wall clock', async () => {
    const created = await json('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ title: 'clocked' }),
    });
    expect(created.body.createdAt).toBe(NOW);
    expect(created.body.updatedAt).toBe(NOW);

    const patched = await json(`/api/applications/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'still clocked' }),
    });
    expect(patched.body.updatedAt).toBe(NOW);
  });

  it('rejects an unknown slot key in answers with the shared error envelope', async () => {
    const id = await draft();
    const bad = await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ answers: { 'made.upKey': 'W1AW' } }),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.message).toMatch(/unknown slot/i);
    expect(bad.body.error.details).toEqual({ slot: 'made.upKey' });
    expect(typeof bad.body.requestId).toBe('string');
  });

  it('returns 422 validation_failed for a body zod rejects, never 400', async () => {
    const bad = await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: '' }) });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(Array.isArray(bad.body.error.details)).toBe(true);

    const id = await draft();
    const badPatch = await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ includeDisclosure: 'yes-please' }),
    });
    expect(badPatch.status).toBe(422);
    expect(badPatch.body.error.code).toBe('validation_failed');
  });

  it('returns 404 not_found in the envelope for a draft that does not exist', async () => {
    const missing = await json('/api/applications/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
    expect(missing.body.error.message).toMatch(/no draft/i);

    const del = await fetch(`${base}/api/applications/does-not-exist`, { method: 'DELETE' });
    expect(del.status).toBe(404);
  });

  it('surfaces the fact checklist and blocks export until every item is confirmed', async () => {
    const id = await draft();
    await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: 'W8UM spent $1,099 on March 7, 2027.' }),
    });

    const before = await json(`/api/applications/${id}/export-readiness`);
    expect(before.body.ready).toBe(false);
    expect(before.body.items.length).toBeGreaterThanOrEqual(3);

    const put = await json(`/api/applications/${id}/facts`, {
      method: 'PUT',
      body: JSON.stringify({ confirmations: confirmAll(before.body.items) }),
    });
    expect(put.status).toBe(200);
    expect(put.body.ready).toBe(true);

    const after = await json(`/api/applications/${id}/export-readiness`);
    expect(after.body.ready).toBe(true);
    expect(after.body.unconfirmed).toBe(0);
  });

  it('blocks export while a TODO marker remains', async () => {
    const id = await draft();
    await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: 'Our club [TODO: club.callsign — callsign] applies.' }),
    });
    const readiness = await json(`/api/applications/${id}/export-readiness`);
    expect(readiness.body.ready).toBe(false);
    expect(readiness.body.openTodos).toBe(1);
  });

  it('never returns another user’s draft', async () => {
    const id = await draft('mine');
    db.prepare('UPDATE applications SET user_id = ? WHERE id = ?').run('user-2', id);

    const read = await json(`/api/applications/${id}`);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('not_found');
    expect((await json('/api/applications')).body.applications).toEqual([]);

    // Every route, not only the read: a checklist or a confirmation that crossed
    // users would leak the draft's prose just as completely as GET would.
    expect((await json(`/api/applications/${id}/facts`)).status).toBe(404);
    expect((await json(`/api/applications/${id}/export-readiness`)).status).toBe(404);
    expect(
      (
        await json(`/api/applications/${id}/facts`, {
          method: 'PUT',
          body: JSON.stringify({ confirmations: {} }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await json(`/api/applications/${id}`, { method: 'PATCH', body: JSON.stringify({ title: 'z' }) }))
        .status,
    ).toBe(404);
    expect((await fetch(`${base}/api/applications/${id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('identifies the caller through deps.currentUser, not req.user', async () => {
    await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: 'user one draft' }) });
    caller = { id: 'user-2', email: 'two@example.org', role: 'member' };
    expect((await json('/api/applications')).body.applications).toEqual([]);
    caller = { id: 'user-1', email: 'one@example.org', role: 'member' };
    expect((await json('/api/applications')).body.applications).toHaveLength(1);
  });

  it('deletes a draft and its template instances', async () => {
    const id = await draft();
    db.prepare(
      'INSERT INTO template_instances (id, application_id, template_id, position, filled_markdown, unresolved_slots_json, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run('ti-1', id, 'need-statement', 0, 'text', '[]', NOW);

    const del = await fetch(`${base}/api/applications/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(db.prepare('SELECT COUNT(*) AS n FROM template_instances').get()).toEqual({ n: 0 });
  });

  it('refuses a programId no opportunity has, instead of dying on the foreign key', async () => {
    const bad = await json('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ title: 'typo', programId: 'ardc-grantz' }),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.details).toEqual({ programId: 'ardc-grantz' });
    expect((await json('/api/applications')).body.applications).toEqual([]);
  });
});

/**
 * THE POINT OF THE FINGERPRINT (Task 14 -> Task 16 carry-forward).
 *
 * A `FactAssertion.id` is `${kind}:${start}` — a POSITION — so an edit that swaps one value for
 * another of the same width reuses it, and a confirmation stored under it then reports a number
 * nobody read as checked by a human. A checklist that manufactures confidence is worse than no
 * checklist. These four tests are the ones that go red if the fingerprint is dropped anywhere on
 * the way in: by the zod schema, by the repository, or by the checklist builder.
 */
describe('a confirmation cannot survive an edit to the value it confirms', () => {
  const AT_1450 = 'W8UM spent $1,450 on March 7, 2027.';
  // Byte-for-byte the same length as $1,450, so every id in the draft is unchanged. That is the
  // whole trap: without a fingerprint this edit is invisible to the checklist.
  const AT_9999 = 'W8UM spent $9,999 on March 7, 2027.';

  const confirmedDraft = async (
    build: (items: Array<{ id: string; fingerprint: string; kind: string }>) => Record<
      string,
      StoredConfirmation
    >,
  ): Promise<string> => {
    const id = await draft();
    await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: AT_1450 }),
    });
    const before = await json(`/api/applications/${id}/export-readiness`);
    const put = await json(`/api/applications/${id}/facts`, {
      method: 'PUT',
      body: JSON.stringify({ confirmations: build(before.body.items) }),
    });
    expect(put.body.ready).toBe(true);
    return id;
  };

  it('drops the confirmation the edited value carried, and keeps the untouched ones', async () => {
    const id = await confirmedDraft((items) => confirmAll(items, 'checked the invoice'));

    await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: AT_9999 }),
    });

    const after = await json(`/api/applications/${id}/export-readiness`);
    expect(after.body.ready).toBe(false);
    expect(after.body.unconfirmed).toBe(1);

    const money = after.body.items.find((i: { kind: string }) => i.kind === 'money');
    expect(money.text).toBe('$9,999');
    expect(money.confirmed).toBe(false);
    expect(money.staleConfirmation).toBe(true);
    // The note the applicant wrote is evidence about the item; it outlives the value.
    expect(money.note).toBe('checked the invoice');

    const callsign = after.body.items.find((i: { kind: string }) => i.kind === 'callsign');
    expect(callsign.confirmed).toBe(true);
    expect(callsign.staleConfirmation).toBe(false);

    // And the gate agrees with the screen.
    expect(() => assertExportReady(db, id, 'user-1')).toThrow(/unconfirmed/i);
  });

  it('still drops it when the client sent no fingerprint at all', async () => {
    // The pre-Task-14 client shape, `{confirmed, note}` and nothing else. The server knows what
    // the document said at the moment of the PUT, so it records that rather than storing a
    // confirmation with no expiry.
    const id = await confirmedDraft((items) => {
      const out: Record<string, StoredConfirmation> = {};
      for (const item of items) out[item.id] = { confirmed: true, note: '' };
      return out;
    });

    for (const stored of Object.values(storedConfirmations(id))) {
      expect(typeof stored.fingerprint).toBe('string');
    }

    await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: AT_9999 }),
    });
    const after = await json(`/api/applications/${id}/export-readiness`);
    expect(after.body.ready).toBe(false);
    expect(after.body.items.find((i: { kind: string }) => i.kind === 'money').confirmed).toBe(false);
  });

  it('stores the fingerprint the client sent verbatim, so zod cannot strip it', async () => {
    const id = await draft();
    await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: AT_1450 }),
    });
    const before = await json(`/api/applications/${id}/export-readiness`);
    const money = before.body.items.find((i: { kind: string }) => i.kind === 'money');

    // A client confirming a view of the draft that is already out of date. Storing "what the text
    // says now" would silently upgrade that into a confirmation of the current value; storing what
    // the client sent keeps the disagreement visible.
    const put = await json(`/api/applications/${id}/facts`, {
      method: 'PUT',
      body: JSON.stringify({
        confirmations: { [money.id]: { confirmed: true, note: '', fingerprint: 'stale-fp' } },
      }),
    });
    expect(put.status).toBe(200);
    expect(storedConfirmations(id)[money.id]?.fingerprint).toBe('stale-fp');

    const after = await json(`/api/applications/${id}/export-readiness`);
    const moneyAfter = after.body.items.find((i: { kind: string }) => i.kind === 'money');
    expect(moneyAfter.confirmed).toBe(false);
    expect(moneyAfter.staleConfirmation).toBe(true);
  });

  it('refuses a confirmation for an id the draft has no fact at', async () => {
    const id = await draft();
    await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: AT_1450 }),
    });
    const bad = await json(`/api/applications/${id}/facts`, {
      method: 'PUT',
      body: JSON.stringify({
        confirmations: { 'money:9999': { confirmed: true, note: 'pre-confirming the future' } },
      }),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.details).toEqual({ unknownFactIds: ['money:9999'] });
    expect(storedConfirmations(id)).toEqual({});
  });
});

/**
 * `buildFactChecklist(text, confirmations, sources)` defaults `sources` to `[]`, so a router that
 * forgets the third argument still renders a complete, plausible checklist — in which the funder's
 * own published name and a sentence a model invented are the same undifferentiated checkbox. These
 * tests fail the moment the argument is dropped from either endpoint.
 */
describe('fact checklist attribution', () => {
  const ORG: Profile = {
    kind: 'organization',
    entity: 'club_501c3',
    orgName: 'Wolverine Amateur Radio Club',
    callsign: 'W8UM',
    state: 'MI',
    memberCount: 34,
  };

  const BODY =
    'W8UM applies to Amateur Radio Digital Communications from Ann Arbor for $9,999.';

  const attributedDraft = async (): Promise<string> => {
    createProfileRepo(db).upsert('user-1', ORG);
    const created = await json('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ title: 'attributed', programId: 'ardc-grants' }),
    });
    await json(`/api/applications/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: BODY, answers: { 'club.city': 'Ann Arbor' } }),
    });
    return created.body.id as string;
  };

  const byText = (
    items: Array<{ text: string }>,
    text: string,
  ): { origin: string; slots: string[]; provenance: string } =>
    items.find((i) => i.text === text) as unknown as {
      origin: string;
      slots: string[];
      provenance: string;
    };

  it('names who stated each value on GET /:id/facts', async () => {
    const id = await attributedDraft();
    const { body } = await json(`/api/applications/${id}/facts`);

    expect(byText(body.items, 'W8UM').origin).toBe('profile');
    expect(byText(body.items, 'W8UM').slots).toContain('club.callsign');

    expect(byText(body.items, 'Amateur Radio Digital Communications').origin).toBe('program');
    expect(byText(body.items, 'Amateur Radio Digital Communications').slots).toContain('funder.name');
    expect(byText(body.items, 'Amateur Radio Digital Communications').provenance).toMatch(
      /funder's own published page/,
    );

    expect(byText(body.items, 'Ann Arbor').origin).toBe('answer');
    expect(byText(body.items, 'Ann Arbor').slots).toEqual(['club.city']);

    // Prose nobody stated. This is the one the reviewer has to go and look up.
    expect(byText(body.items, '$9,999').origin).toBe('unattributed');
    expect(byText(body.items, '$9,999').slots).toEqual([]);
  });

  it('carries the same attribution on /:id/export-readiness', async () => {
    const id = await attributedDraft();
    const { body } = await json(`/api/applications/${id}/export-readiness`);
    expect(byText(body.items, 'W8UM').origin).toBe('profile');
    expect(byText(body.items, 'Amateur Radio Digital Communications').origin).toBe('program');
    expect(byText(body.items, 'Ann Arbor').origin).toBe('answer');
  });

  it('a program-sourced value still blocks export until a human ticks it', async () => {
    const id = await attributedDraft();
    const { body } = await json(`/api/applications/${id}/export-readiness`);
    const funderName = body.items.find(
      (i: { text: string }) => i.text === 'Amateur Radio Digital Communications',
    );
    expect(funderName.origin).toBe('program');
    expect(funderName.confirmed).toBe(false);
    expect(body.ready).toBe(false);
    expect(() => assertExportReady(db, id, 'user-1')).toThrow(AppError);
  });

  it('attaches and detaches the opportunity through PATCH, and attribution follows', async () => {
    const id = await draft();
    await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: BODY }),
    });

    const detached = await json(`/api/applications/${id}/facts`);
    expect(byText(detached.body.items, 'Amateur Radio Digital Communications').origin).toBe(
      'unattributed',
    );

    const attached = await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ programId: 'ardc-grants' }),
    });
    expect(attached.body.programId).toBe('ardc-grants');
    expect(
      byText((await json(`/api/applications/${id}/facts`)).body.items, 'Amateur Radio Digital Communications')
        .origin,
    ).toBe('program');

    const cleared = await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ programId: null }),
    });
    expect(cleared.body.programId).toBeUndefined();

    const rejected = await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ programId: 'ardc-grantz' }),
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.details).toEqual({ programId: 'ardc-grantz' });
  });
});

/**
 * The spec §10.4 export gate. Plan 5's export endpoints call this and let the
 * throw propagate to Plan 1's errorHandler, which renders conflict as HTTP 409.
 * These assertions are the contract Plan 5 codes against.
 */
describe('assertExportReady', () => {
  const draftWith = async (bodyMarkdown: string): Promise<string> => {
    const id = await draft('gate');
    await json(`/api/applications/${id}`, { method: 'PATCH', body: JSON.stringify({ bodyMarkdown }) });
    return id;
  };

  it('throws conflict (409) while any factual assertion is unconfirmed', async () => {
    const id = await draftWith('W8UM spent $1,099 on March 7, 2027.');
    const err = (() => {
      try {
        assertExportReady(db, id, 'user-1');
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err?.code).toBe('conflict');
    expect(err?.status).toBe(409);
    expect(err?.message).toMatch(/unconfirmed/i);
  });

  it('throws conflict (409) while a [TODO: …] marker remains, even with every fact confirmed', async () => {
    const id = await draftWith('Our club [TODO: club.callsign — callsign] applies.');
    const readiness = await json(`/api/applications/${id}/export-readiness`);
    await json(`/api/applications/${id}/facts`, {
      method: 'PUT',
      body: JSON.stringify({ confirmations: confirmAll(readiness.body.items) }),
    });
    expect(() => assertExportReady(db, id, 'user-1')).toThrow(/TODO/);
  });

  it('throws not_found (404) for another user’s draft, so export cannot read across users', async () => {
    const id = await draftWith('Nothing to confirm here.');
    try {
      assertExportReady(db, id, 'user-2');
      throw new Error('expected assertExportReady to throw');
    } catch (e) {
      expect((e as AppError).code).toBe('not_found');
      expect((e as AppError).status).toBe(404);
    }
  });

  it('returns silently once every fact is confirmed and no TODO marker is left', async () => {
    const id = await draftWith('W8UM spent $1,099 on March 7, 2027.');
    const readiness = await json(`/api/applications/${id}/export-readiness`);
    await json(`/api/applications/${id}/facts`, {
      method: 'PUT',
      body: JSON.stringify({ confirmations: confirmAll(readiness.body.items, 'checked the invoice') }),
    });
    expect(() => assertExportReady(db, id, 'user-1')).not.toThrow();
  });
});

/**
 * RESOLUTIONS R24. The guard ASSERTS Plan 1's shape and CREATES NOTHING. These
 * three assertions are what stops the defect coming back: a second
 * `CREATE TABLE IF NOT EXISTS applications` in a later migration is a silent
 * no-op against a migrated database, so the only safe posture for this plan is
 * to fail loudly and name the file that owns the shape.
 */
describe('assertApplicationSchema (assert, never create)', () => {
  it('passes against a database migrated by Plan 1', () => {
    expect(() => assertApplicationSchema(db)).not.toThrow();
  });

  it('names 001-init.sql when the applications table is absent', () => {
    const bare = new Database(':memory:');
    try {
      expect(() => assertApplicationSchema(bare)).toThrow(/001-init\.sql/);
    } finally {
      bare.close();
    }
  });

  it('names the missing column when an earlier migration created a conflicting shape', () => {
    const partial = new Database(':memory:');
    partial.exec('CREATE TABLE applications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL)');
    partial.exec('CREATE TABLE template_instances (id TEXT PRIMARY KEY, application_id TEXT NOT NULL)');
    try {
      expect(() => assertApplicationSchema(partial)).toThrow(/answers_json/);
    } finally {
      partial.close();
    }
  });

  it('creates nothing: an empty database still has neither table afterwards', () => {
    const bare = new Database(':memory:');
    try {
      expect(() => assertApplicationSchema(bare)).toThrow();
      const tables = bare
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('applications', 'template_instances')",
        )
        .all();
      expect(tables).toEqual([]);
    } finally {
      bare.close();
    }
  });

  it('refuses to build the router against a database Plan 1 never migrated', () => {
    const bare = new Database(':memory:');
    try {
      expect(() =>
        createApplicationsRouter({
          db: bare,
          now: () => NOW,
          requireAuth: (_req, _res, next) => next(),
          requireAdmin: (_req, _res, next) => next(),
          currentUser: () => caller,
        }),
      ).toThrow(/001-init\.sql/);
    } finally {
      bare.close();
    }
  });
});
