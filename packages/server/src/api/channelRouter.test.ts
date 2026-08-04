import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedTestUser } from '../test/fixtures/programs.js';
import { createChannelRouter } from './channelRouter.js';
import { loadChannel, recordDelivery } from './channels.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(
  db: Database.Database,
  fetchImpl: typeof fetch = (() => {
    throw new Error('no fetch expected');
  }) as unknown as typeof fetch,
  user: SessionUser = MEMBER,
) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/channels', createChannelRouter(deps, fetchImpl));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

describe('channels API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedTestUser(db, 'u-member');
  });

  afterEach(() => {
    db.close();
  });

  it('reports the in-app default, with no delivery history yet', async () => {
    const res = await request(buildApp(db)).get('/api/channels');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      inApp: true,
      webhookUrl: null,
      ntfyServer: null,
      ntfyTopic: null,
      health: [],
    });
  });

  it('saves a configuration and reads it back', async () => {
    const app = buildApp(db);
    const put = await request(app).put('/api/channels').send({
      inApp: true,
      webhookUrl: 'https://hooks.example.com/grantspotter',
      ntfyServer: 'https://ntfy.example.com',
      ntfyTopic: 'grantspotter-deadlines',
    });
    expect(put.status).toBe(200);
    expect(put.body.ntfyTopic).toBe('grantspotter-deadlines');
    const get = await request(app).get('/api/channels');
    expect(get.body.webhookUrl).toBe('https://hooks.example.com/grantspotter');
    expect(loadChannel(db, 'u-member').ntfyServer).toBe('https://ntfy.example.com');
  });

  it('treats blank strings as "unset" rather than storing empty destinations', async () => {
    const res = await request(buildApp(db)).put('/api/channels').send({
      inApp: true, webhookUrl: '   ', ntfyServer: '', ntfyTopic: '',
    });
    expect(res.status).toBe(200);
    expect(loadChannel(db, 'u-member')).toEqual({
      inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null,
    });
  });

  it('surfaces the reason a URL was refused, in the one error envelope', async () => {
    const res = await request(buildApp(db)).put('/api/channels').send({
      inApp: true, webhookUrl: 'http://hooks.example.com/x',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toMatch(/https/i);
    expect(res.body.error.details).toEqual({ field: 'webhookUrl' });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it('refuses a private webhook destination', async () => {
    const res = await request(buildApp(db)).put('/api/channels').send({
      inApp: true, webhookUrl: 'https://169.254.169.254/latest/meta-data',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/private/i);
    expect(loadChannel(db, 'u-member').webhookUrl).toBeNull();
  });

  it('refuses a blocklisted webhook destination, naming the field', async () => {
    const res = await request(buildApp(db)).put('/api/channels').send({
      inApp: true, webhookUrl: 'https://farweb.org/hook',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual({ field: 'webhookUrl' });
  });

  it('validates the ntfy server with the same rule as the webhook', async () => {
    const res = await request(buildApp(db)).put('/api/channels').send({
      inApp: true, ntfyServer: 'https://127.0.0.1:8080', ntfyTopic: 'gs',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual({ field: 'ntfyServer' });
  });

  it('refuses half an ntfy configuration, which would deliver nowhere', async () => {
    const res = await request(buildApp(db)).put('/api/channels').send({
      inApp: true, ntfyServer: 'https://ntfy.example.com',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/both a server and a topic/i);
  });

  it('refuses an ntfy topic with a path separator in it', async () => {
    const res = await request(buildApp(db)).put('/api/channels').send({
      inApp: true, ntfyServer: 'https://ntfy.example.com', ntfyTopic: '../../admin',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual({ field: 'ntfyTopic' });
  });

  it('rejects a non-string where a URL belongs, rather than coercing it', async () => {
    const res = await request(buildApp(db)).put('/api/channels').send({
      inApp: true, webhookUrl: { toString: 'nope' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual({ field: 'webhookUrl' });
  });

  it('leaves the previous configuration intact when the new one is refused', async () => {
    const app = buildApp(db);
    await request(app).put('/api/channels').send({
      inApp: true, webhookUrl: 'https://hooks.example.com/good',
    });
    await request(app).put('/api/channels').send({
      inApp: true, webhookUrl: 'https://10.0.0.5/bad',
    });
    expect(loadChannel(db, 'u-member').webhookUrl).toBe('https://hooks.example.com/good');
  });

  describe('POST /test', () => {
    it('is a 409 when there is nothing external to test', async () => {
      const res = await request(buildApp(db)).post('/api/channels/test');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('conflict');
    });

    it('delivers a test notification and reports the outcome', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
      const app = buildApp(db, fetchImpl as unknown as typeof fetch);
      await request(app).put('/api/channels').send({
        inApp: true, webhookUrl: 'https://hooks.example.com/gs',
      });
      const res = await request(app).post('/api/channels/test');
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([{ channel: 'webhook', ok: true, status: 204 }]);
      const sent = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(sent.kind).toBe('new');
      expect(sent.title).toMatch(/test/i);
    });

    /**
     * The precedent: an absence of deliveries has to stay distinguishable from
     * a broken pipeline. A failed test POST is a 200 whose body says the
     * delivery failed, and the same failure is durable in `health` — a 500 here
     * would blame GrantSpotter for the user's endpoint being down.
     */
    it('reports a failure as data, and leaves it in health', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const app = buildApp(db, fetchImpl as unknown as typeof fetch);
      await request(app).put('/api/channels').send({
        inApp: true, webhookUrl: 'https://hooks.example.com/gs',
      });
      const res = await request(app).post('/api/channels/test');
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([
        { channel: 'webhook', ok: false, error: 'ECONNREFUSED' },
      ]);
      const get = await request(app).get('/api/channels');
      expect(get.body.health).toEqual([
        {
          channel: 'webhook',
          lastAttemptAt: NOW,
          lastOkAt: null,
          lastStatus: null,
          lastError: 'ECONNREFUSED',
          consecutiveFailures: 1,
        },
      ]);
    });
  });

  it('reads back health written by any deliverer, not only by the test route', async () => {
    recordDelivery(db, 'u-member', [{ channel: 'ntfy', ok: true, status: 200 }], NOW);
    const res = await request(buildApp(db)).get('/api/channels');
    expect(res.body.health).toEqual([
      {
        channel: 'ntfy',
        lastAttemptAt: NOW,
        lastOkAt: NOW,
        lastStatus: 200,
        lastError: null,
        consecutiveFailures: 0,
      },
    ]);
  });

  it('scopes every route to the session user', async () => {
    seedTestUser(db, 'u-other');
    await request(buildApp(db)).put('/api/channels').send({
      inApp: true, webhookUrl: 'https://hooks.example.com/mine',
    });
    const other = await request(
      buildApp(db, undefined, { id: 'u-other', email: 'other@example.com', role: 'member' }),
    ).get('/api/channels');
    expect(other.body.webhookUrl).toBeNull();
  });
});
