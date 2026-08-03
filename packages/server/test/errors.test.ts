import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError, ERROR_STATUS, errorHandler, notFoundHandler, requestIdMiddleware } from '../src/api/errors.js';

function harness(handler: RequestHandler, logger = vi.fn()) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(requestIdMiddleware());
  app.post('/boom', handler);
  app.use(notFoundHandler());
  app.use(errorHandler({ logger }));
  return { app, logger };
}

describe('error envelope', () => {
  it('maps every AppError code to its documented status', async () => {
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      const { app } = harness(() => {
        throw new AppError(code as keyof typeof ERROR_STATUS, `failed: ${code}`);
      });
      const res = await request(app).post('/boom').send({});
      expect(res.status, code).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(res.body.error.message).toBe(`failed: ${code}`);
      expect(typeof res.body.requestId).toBe('string');
      expect(res.headers['x-request-id']).toBe(res.body.requestId);
    }
    expect(Object.keys(ERROR_STATUS)).toHaveLength(9);
  });

  it('carries structured details', async () => {
    const { app } = harness(() => {
      throw new AppError('rate_limited', 'Too many attempts.', { retryAfterSec: 900 });
    });
    const res = await request(app).post('/boom').send({});
    expect(res.status).toBe(429);
    expect(res.body.error.details).toEqual({ retryAfterSec: 900 });
  });

  it('turns a ZodError into 422 validation_failed with the issues attached', async () => {
    const schema = z.object({ email: z.string().email() });
    const { app } = harness((req) => {
      schema.parse(req.body);
    });
    const res = await request(app).post('/boom').send({ email: 'nope' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details[0].path).toEqual(['email']);
  });

  it('turns an unparsable JSON body into 400 bad_request', async () => {
    const { app } = harness((_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app)
      .post('/boom')
      .set('content-type', 'application/json')
      .send('{ not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('hides unexpected errors behind a generic 500 and logs them', async () => {
    const { app, logger } = harness(() => {
      throw new Error('secret database path /srv/private/db.sqlite');
    });
    const res = await request(app).post('/boom').send({});
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
    expect(res.body.error.message).toBe('Something went wrong.');
    expect(JSON.stringify(res.body)).not.toContain('/srv/private');
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0][0]).toContain('secret database path');
  });

  // `harness` is notFoundHandler in isolation — no SPA middleware — so a
  // non-/api path 404s here. In the assembled app that same path is answered
  // by the SPA history fallback Plan 5 Task 17 installs as the last statement
  // of Plan 3 Task 14's mountRoutes callback (RESOLUTIONS R16 + R25); the
  // createApp-level test below therefore probes an unknown /api path.
  it('answers an unknown route with a 404 envelope', async () => {
    const { app } = harness((_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app).get('/no/such/route');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('echoes a well-formed inbound x-request-id and replaces a hostile one', async () => {
    const { app } = harness((_req, res) => {
      res.json({ ok: true });
    });
    const good = await request(app).get('/no/such/route').set('x-request-id', 'abc-123_XYZ');
    expect(good.body.requestId).toBe('abc-123_XYZ');

    const bad = await request(app).get('/no/such/route').set('x-request-id', '<script>x</script>');
    expect(bad.body.requestId).not.toBe('<script>x</script>');
    expect(bad.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
