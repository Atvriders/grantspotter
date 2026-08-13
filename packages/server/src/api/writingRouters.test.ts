import Database from 'better-sqlite3';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouterDeps } from './deps.js';
import { AppError, errorHandler, notFoundHandler, requestIdMiddleware } from './errors.js';
import { createPromptsRouter } from './prompts.js';
import { createProseRouter } from './prose.js';
import { createTemplatesRouter } from './templates.js';

let base: string;
let stop: () => Promise<void>;
let db: Database.Database;
/** Flipped by the auth test to prove deps.requireAuth is really applied. */
let signedIn = true;

const PROGRAM = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Grants for amateur radio.',
  applicantEntities: ['university'],
  amount: { instrument: 'cash_range', amountRaw: '$1,285-$258,000', awardCountRaw: 'Multiple per year' },
  deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: 'February 1, April 1, July 1, September 1' },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.ardc.net/apply/',
  constraints: [],
  fundingRestrictions: ['For-profit companies are not eligible.'],
  obligations: { indirectCostCapPct: 20, costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'permitted', quote: 'edit for clarity, brevity, and accuracy', url: 'https://www.ardc.net/apply/grant-application-instructions/' },
  trust: { status: 'open', sourceUrl: 'https://www.ardc.net/apply/', lastVerifiedAt: '2026-08-02', verificationMethod: 'live_fetch', contentHash: 'x' },
  rawOtherText: '',
  tags: [],
};

const PROFILE = {
  kind: 'organization',
  entity: 'club_unincorporated',
  orgName: 'Example Collegiate Amateur Radio Club',
  callsign: 'W8UM',
  state: 'MI',
  memberCount: 34,
};

/** Fakes for Plan 3's RouterDeps. `requireAuth` is a real gate here so the
 * "requires a session" assertions below cannot pass by accident. */
function fakeDeps(database: Database.Database): RouterDeps {
  return {
    db: database,
    now: () => '2026-08-02T00:00:00.000Z',
    requireAuth: (_req, _res, next) =>
      signedIn ? next() : next(new AppError('unauthorized', 'Sign in to continue.')),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => ({ id: 'user-1', email: 'one@example.org', role: 'member' }),
  };
}

beforeAll(async () => {
  db = new Database(':memory:');

  const app = express();
  app.use(requestIdMiddleware());
  app.use(express.json({ limit: '2mb' }));
  const deps = fakeDeps(db);
  app.use('/api/templates', createTemplatesRouter(deps));
  app.use('/api/prose', createProseRouter(deps));
  app.use('/api/prompts', createPromptsRouter(deps));
  app.use(notFoundHandler());
  app.use(errorHandler({ logger: () => undefined }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        db.close();
        resolve();
      }),
    );
});

afterAll(async () => stop());

interface JsonResponse {
  status: number;
  /**
   * `fetch`'s `json()` is `unknown` under strict TypeScript. These tests assert against the WIRE
   * shape rather than against a compiled type — deliberately, since the SPA reads the wire — so
   * the body is loosened here exactly as `res.body` is `any` in the supertest-based suites beside
   * this one. Tightening it would pin the routers' JSON to a server-side type and hide a rename.
   */
  body: any;
}

const postTo = async (root: string, p: string, body: unknown): Promise<JsonResponse> => {
  const res = await fetch(root + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const getFrom = async (root: string, p: string): Promise<JsonResponse> => {
  const res = await fetch(root + p);
  return { status: res.status, body: await res.json() };
};
const post = async (p: string, body: unknown) => postTo(base, p, body);
const get = async (p: string) => getFrom(base, p);

describe('templates router', () => {
  it('lists components, overlays and playbooks for a program', async () => {
    const { body } = await get('/api/templates?klass=ham_grant&programId=ardc-grants');
    expect(body.components.length).toBeGreaterThanOrEqual(8);
    expect(body.overlays.map((t: { id: string }) => t.id)).toContain('funder-ardc');
    expect(body.playbooks.map((t: { id: string }) => t.id)).toContain('funder-campus-sga');
    expect(body.components[0].body).toBeUndefined(); // summaries only
  });

  /**
   * The bare request the nav rail makes. `overlays` is empty — nothing named a funder, and the
   * writing desk must not be handed another funder's criteria as "yours" — while the library it
   * ships is reported in full, because "none applies here" and "none exists" are different
   * answers and `/templates` was printing the second one.
   */
  it('reports the whole overlay library even when the query names no funder', async () => {
    const { body } = await get('/api/templates');
    expect(body.overlays).toEqual([]);
    const ids = body.libraryOverlays.map((t: { id: string }) => t.id);
    expect(ids).toContain('funder-ardc');
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(ids).not.toContain('funder-campus-sga'); // a playbook is not an overlay
    expect(body.libraryOverlays[0].body).toBeUndefined(); // summaries only
  });

  it('refuses an unknown klass rather than silently narrowing the library', async () => {
    // `selectTemplates` keeps only components whose `appliesTo` includes the klass, so an
    // unrecognised value does not fail — it returns the handful with an empty `appliesTo` and
    // looks like a small library. Same silence Task 1 closed inside the loader.
    const { status, body } = await get('/api/templates?klass=ham_grantz');
    expect(status).toBe(422);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toMatch(/ham_grantz/);
  });

  it('serves the slot vocabulary before it tries to match an id', async () => {
    const { status, body } = await get('/api/templates/slots');
    expect(status).toBe(200);
    expect(body.all.length).toBeGreaterThan(50);
    expect(body.userAnswerable.every((s: { source: string }) => s.source === 'user')).toBe(true);
  });

  it('serves one template with its body', async () => {
    const { body } = await get('/api/templates/need-statement');
    expect(body.id).toBe('need-statement');
    expect(body.body).toContain('{{club.callsign}}');
    expect(body.slots).toContain('club.name');
  });

  it('404s an unknown template rather than throwing, in the shared envelope', async () => {
    const { status, body } = await get('/api/templates/nope');
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toMatch(/unknown template "nope"/);
    expect(typeof body.requestId).toBe('string');
  });

  it('fills a template from a profile and marks the rest as TODO', async () => {
    const { body } = await post('/api/templates/need-statement/fill', {
      profile: PROFILE,
      program: PROGRAM,
      answers: { 'club.city': 'Ann Arbor' },
    });
    expect(body.markdown).toContain('Example Collegiate Amateur Radio Club');
    expect(body.markdown).toContain('W8UM');
    expect(body.markdown).toContain('Ann Arbor');
    expect(body.markdown).toContain('[TODO: project.problem');
    expect(body.unresolvedSlots).toContain('project.problem');
  });

  it('resolves a Space Grant consortium by state and never claims it is verified', async () => {
    const { body } = await get('/api/templates/consortium/MI');
    expect(body.consortium.name).toMatch(/Michigan Space Grant/);
    expect(body.consortium.verified).toBe(false);
    const missing = await get('/api/templates/consortium/ZZ');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('keeps the library public but puts fill behind deps.requireAuth', async () => {
    signedIn = false;
    try {
      expect((await get('/api/templates?klass=ham_grant')).status).toBe(200);
      expect((await get('/api/templates/slots')).status).toBe(200);
      const blocked = await post('/api/templates/need-statement/fill', { profile: PROFILE, program: PROGRAM });
      expect(blocked.status).toBe(401);
      expect(blocked.body.error.code).toBe('unauthorized');
    } finally {
      signedIn = true;
    }
  });
});

/**
 * THE 404-VERSUS-500 DISTINCTION, proved against a real malformed file on disk.
 *
 * `getTemplate` loads the WHOLE library to answer for one id, so `try { getTemplate(id) } catch
 * { 404 }` — what this task's brief drafted — turns ONE broken file into "unknown template" for
 * EVERY id. The library would vanish and the error would name the applicant's request as the
 * problem. Task 1 made the loader throw on exactly the mistakes that used to pass silently
 * (a missing `appliesTo`, a quoted `alwaysAvailable`, a scalar `programIds`); collapsing those
 * throws into a 404 hands that silence straight back.
 */
describe('a malformed template reports as broken, never as missing', () => {
  let brokenBase: string;
  let healthyBase: string;
  let brokenRoot: string;
  let healthyRoot: string;
  const servers: Server[] = [];
  const dirs: string[] = [];

  const VALID = `---
id: mini-need
title: Mini need statement
layer: component
order: 10
appliesTo: []
---

{{club.name}} ({{club.callsign}}) needs one radio.
`;

  // Missing \`appliesTo\`. Task 1 made this throw because the absent key silently WIDENED a
  // restricted component to all four opportunity classes.
  const BROKEN = `---
id: mini-broken
title: Broken on purpose
layer: component
order: 20
---

Body.
`;

  const serve = async (templatesRoot: string): Promise<string> => {
    const app = express();
    app.use(requestIdMiddleware());
    app.use(express.json());
    app.use('/api/templates', createTemplatesRouter(fakeDeps(db), { templatesRoot }));
    app.use(notFoundHandler());
    app.use(errorHandler({ logger: () => undefined }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const makeRoot = (files: Record<string, string>): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'gs-templates-'));
    dirs.push(root);
    mkdirSync(path.join(root, 'components'), { recursive: true });
    mkdirSync(path.join(root, 'funders'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(root, 'components', name), content, 'utf8');
    }
    return root;
  };

  beforeAll(async () => {
    healthyRoot = makeRoot({ 'mini-need.md': VALID });
    brokenRoot = makeRoot({ 'mini-need.md': VALID, 'mini-broken.md': BROKEN });
    healthyBase = await serve(healthyRoot);
    brokenBase = await serve(brokenRoot);
  });

  afterAll(async () => {
    await Promise.all(
      servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('serves a healthy library from the same seam, so the 500 below is the broken file', async () => {
    const listed = await getFrom(healthyBase, '/api/templates');
    expect(listed.status).toBe(200);
    expect(listed.body.components.map((t: { id: string }) => t.id)).toEqual(['mini-need']);
    const one = await getFrom(healthyBase, '/api/templates/mini-need');
    expect(one.status).toBe(200);
    expect(one.body.body).toContain('{{club.callsign}}');
    expect((await getFrom(healthyBase, '/api/templates/nope')).status).toBe(404);
  });

  it('does NOT 404 every other id when one file is malformed', async () => {
    const one = await getFrom(brokenBase, '/api/templates/mini-need');
    expect(one.status).not.toBe(404);
    expect(one.status).toBe(500);
    expect(one.body.error.code).toBe('internal');
    // The naive `catch { 404 }` produced exactly this message for a template that exists.
    expect(one.body.error.message).not.toMatch(/unknown template/);
  });

  it('does not answer an unknown id with a confident 404 it cannot back', async () => {
    // The library did not load, so "no template carries this id" is not a fact anyone knows.
    const missing = await getFrom(brokenBase, '/api/templates/nope');
    expect(missing.status).toBe(500);
    expect(missing.body.error.code).toBe('internal');
  });

  it('reports the list and the fill route as broken too, not as an empty library', async () => {
    const listed = await getFrom(brokenBase, '/api/templates');
    expect(listed.status).toBe(500);
    expect(listed.body.error.code).toBe('internal');
    const filled = await postTo(brokenBase, '/api/templates/mini-need/fill', { profile: PROFILE });
    expect(filled.status).toBe(500);
    expect(filled.body.error.code).toBe('internal');
  });
});

describe('prose router', () => {
  it('returns the report plus per-paragraph densities', async () => {
    const { body } = await post('/api/prose/analyze', {
      text: 'Furthermore, this comprehensive initiative underscores our unwavering commitment to leveraging robust community engagement and fostering meaningful outcomes for everyone involved.',
    });
    expect(body.report.paragraphs[0].verdict).toBe('generic');
    expect(body.report.paragraphs[0].stockTransitionHits).toContain('Furthermore');
    expect(body.densities[0].referentDensity).toBe(0);
    expect(body.densities[0].styleDensity).toBeGreaterThan(0);
  });

  it('leaves a short paragraph unjudged rather than calling it generic', async () => {
    // Under twelve words a density is noise in both directions, so the analyzer measures and
    // does not judge. A router that presented `thin` as a verdict about quality would be
    // inventing a finding the module deliberately refuses to make.
    const { body } = await post('/api/prose/analyze', {
      text: 'Furthermore, this comprehensive initiative underscores our unwavering commitment.',
    });
    expect(body.report.paragraphs[0].verdict).toBe('thin');
    expect(body.densities[0].words).toBe(8);
  });

  it('returns a fact checklist with every item unconfirmed', async () => {
    const { body } = await post('/api/prose/facts', { text: 'W8UM spent $1,099 on March 7, 2027.' });
    expect(body.items.length).toBeGreaterThanOrEqual(3);
    expect(body.items.every((i: { confirmed: boolean }) => i.confirmed === false)).toBe(true);
  });

  it('attributes a fact to whoever stated it when the caller sends its context', async () => {
    // Without the third `sources` argument every item reads `unattributed` and the origin
    // distinction — the thing that makes the checklist reviewable — disappears silently.
    const text = 'W8UM spent $1,099 on March 7, 2027.';
    const bare = await post('/api/prose/facts', { text });
    expect(bare.body.items.find((i: { kind: string }) => i.kind === 'callsign').origin).toBe(
      'unattributed',
    );

    const { body } = await post('/api/prose/facts', { text, profile: PROFILE, program: PROGRAM });
    const callsign = body.items.find((i: { kind: string }) => i.kind === 'callsign');
    expect(callsign.origin).toBe('profile');
    expect(callsign.slots).toContain('club.callsign');
    // Origin never means confirmed: a stated fact still blocks export until a human ticks it.
    expect(callsign.confirmed).toBe(false);
    // Nothing stated covers the money, and the router must not guess one.
    expect(body.items.find((i: { kind: string }) => i.kind === 'money').origin).toBe('unattributed');
  });

  it('rejects a missing or oversized body with 422 validation_failed, never 400', async () => {
    const bad = await post('/api/prose/analyze', {});
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.message).toMatch(/"text"/);
  });

  it('requires a session for both prose endpoints', async () => {
    signedIn = false;
    try {
      expect((await post('/api/prose/analyze', { text: 'Anything at all.' })).status).toBe(401);
      expect((await post('/api/prose/facts', { text: 'Anything at all.' })).status).toBe(401);
    } finally {
      signedIn = true;
    }
  });
});

describe('prompts router', () => {
  it('composes a prompt and returns the exact button copy', async () => {
    const { body } = await post('/api/prompts/compose', {
      program: PROGRAM,
      profile: PROFILE,
      includeDisclosure: true,
    });
    expect(body.label).toBe('Copy AI Prompt — includes AI-detection avoidance');
    expect(body.subtitle).toMatch(/interview/i);
    expect(body.prompt).toContain('ARDC Grants Program');
    expect(body.prompt).toContain('For-profit companies are not eligible.');
    expect(body.prompt).toContain('10.1126/sciadv.adt3813');
    expect(body.prompt).toMatch(/AI-use disclosure/);
  });

  it('404s a templateId that names no template, instead of composing without it', async () => {
    const { status, body } = await post('/api/prompts/compose', {
      program: PROGRAM,
      templateId: 'nope',
      includeDisclosure: false,
    });
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toMatch(/unknown template "nope"/);
  });

  it('returns the editable disclosure sentence and its policy note', async () => {
    const { body } = await post('/api/prompts/disclosure', {
      stance: 'unaddressed',
      funderName: 'ARRL Foundation',
      toolName: 'Claude',
      authorName: 'Dana Ruiz',
    });
    expect(body.defaultOn).toBe(true);
    expect(body.sentence).toContain('Dana Ruiz');
    expect(body.note).toMatch(/has not published/i);
  });

  it('rejects a body that is not a program with 422 validation_failed', async () => {
    const bad = await post('/api/prompts/compose', { program: { id: 'x' }, includeDisclosure: false });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(Array.isArray(bad.body.error.details)).toBe(true);
  });

  it('requires a session for both prompts endpoints', async () => {
    signedIn = false;
    try {
      expect(
        (await post('/api/prompts/compose', { program: PROGRAM, includeDisclosure: true })).status,
      ).toBe(401);
      expect(
        (await post('/api/prompts/disclosure', { stance: 'unaddressed', funderName: 'ARDC' })).status,
      ).toBe(401);
    } finally {
      signedIn = true;
    }
  });
});
