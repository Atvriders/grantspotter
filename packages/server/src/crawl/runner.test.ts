import Database from 'better-sqlite3';
import type { FetchRequest, FetchedPayload, Program } from '@grantspotter/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { ensureIngestionSchema } from '../db/ingestSchema.js';
import { migrate } from '../db/migrate.js';
import {
  ProgramUpsertConflictError,
  listChangeEvents,
  listProgramsBySource,
  listReviewItems,
  listSourceHealth,
  upsertProgram,
} from '../db/repositories/ingestion.js';
import { approveReviewItem } from '../review/index.js';
import { SOURCES } from '../sources/registry.js';
import { healthMessageFor, runCrawl, runSource } from './runner.js';

const NOW = '2026-08-02T00:00:00.000Z';
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db); // Plan 1 owns every CONTRACT §6 table
  ensureIngestionSchema(db);
  // programs.funder_id references funders(id); seed every funder the registry names.
  // funders.created_at / updated_at are NOT NULL with no DEFAULT in 001-init.sql.
  const insertFunder = db.prepare(
    'INSERT OR IGNORE INTO funders (id, name, homepage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const m of SOURCES) insertFunder.run(m.funderId, m.funderId, 'https://example.test/', NOW, NOW);
});

/** Serves committed fixtures instead of the network. */
function fixtureFetcher(map: Record<string, FetchedPayload>) {
  const fetched: string[] = [];
  return {
    fetched,
    fetcher: {
      async fetch(req: FetchRequest): Promise<FetchedPayload> {
        fetched.push(req.url);
        for (const [part, payload] of Object.entries(map)) {
          if (req.url.includes(part)) return { ...payload, url: req.url };
        }
        return { url: req.url, status: 404, contentType: 'text/html', body: '', fetchedAt: NOW };
      },
    },
  };
}

const deps = (fetcher: { fetch(req: FetchRequest): Promise<FetchedPayload> }) => ({
  db,
  fetcher,
  nowISO: () => NOW,
});

/** A minimal, schema-valid Program for tests that need to pre-seed the published corpus. */
function makeProgram(overrides: Partial<Program> & Pick<Program, 'id' | 'funderId'>): Program {
  return {
    name: 'Test Program',
    klass: 'ham_scholarship',
    summary: 'A test program.',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_fixed', amountMin: 500, amountMax: 500, amountRaw: '$500', awardCountRaw: '1' },
    deadline: { kind: 'rolling', source: { kind: 'self' }, note: '' },
    applyVia: 'page_form',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://example.test/',
      lastVerifiedAt: NOW,
      verificationMethod: 'live_fetch',
      contentHash: 'seed-hash',
    },
    rawOtherText: '',
    tags: [],
    ...overrides,
  };
}

describe('runSource on a normal Tier C source', () => {
  const map = {
    '/scholarship-descriptions': fixturePayload(
      'arrl-scholarship-descriptions',
      'pathological.html',
      'http://www.arrl.org/scholarship-descriptions',
    ),
  };

  it('parses, diffs, records health, and queues review items on the first run', async () => {
    const { fetcher } = fixtureFetcher(map);
    const result = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(result.parsedCount).toBe(6);
    expect(result.error).toBeUndefined();
    expect(listReviewItems(db, 'pending')).toHaveLength(6);
    expect(listChangeEvents(db, 50).every((e) => e.kind === 'new' || e.kind === 'parse_yield_dropped')).toBe(true);
  });

  it('publishes nothing until a human approves', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(listProgramsBySource(db, 'arrl-scholarship-descriptions')).toEqual([]);
    const first = listReviewItems(db, 'pending')[0];
    approveReviewItem(db, first.id, 'user-1', NOW);
    expect(listProgramsBySource(db, 'arrl-scholarship-descriptions')).toHaveLength(1);
  });

  it('emits nothing new on a second identical run after approval', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    for (const item of listReviewItems(db, 'pending')) approveReviewItem(db, item.id, 'user-1', NOW);
    const before = listChangeEvents(db, 100).length;
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(listChangeEvents(db, 100).length).toBe(before);
  });

  it('fires parse_yield_dropped when the page stops parsing', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    const alarms = listChangeEvents(db, 100).filter((e) => e.kind === 'parse_yield_dropped');
    // The pathological fixture yields 6 against expectedMinRecords 100, so the alarm must fire.
    expect(alarms).toHaveLength(1);
    expect(alarms[0].after).toEqual({ parsedCount: 6 });
  });

  it('records a snapshot row per fetched payload', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('records poll start, success and record count on the sources table', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    const [health] = listSourceHealth(db);
    expect(health.lastPolledAt).toBe(NOW);
    expect(health.lastSuccessAt).toBe(NOW);
    expect(health.lastRecordCount).toBe(6);
    expect(health.expectedMinRecords).toBe(100);
    expect(health.consecutiveFailures).toBe(0);
  });

  it('reconciles with a seeded record instead of duplicating it — RESOLUTIONS R9', async () => {
    const { fetcher } = fixtureFetcher(map);
    // First crawl + approve everything: the corpus now holds this source's records with their
    // (source_id, external_key) written.
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    for (const item of listReviewItems(db, 'pending')) approveReviewItem(db, item.id, 'user-1', NOW);
    const published = listProgramsBySource(db, 'arrl-scholarship-descriptions');
    expect(published).toHaveLength(6);

    // Re-seed one of them under a HAND-WRITTEN id, exactly as Plan 5's seed corpus does, and
    // drop the crawler-minted row. Tonight's crawl must find it by source key.
    const seeded = { ...published[0], id: 'arrl-foundation-scholarships' };
    const key = { sourceId: 'arrl-scholarship-descriptions', externalKey: published[0].tags.find((t) => t.startsWith('key:'))?.slice(4) ?? '' };
    db.prepare('DELETE FROM programs WHERE id = ?').run(published[0].id);
    upsertProgram(db, seeded, key);

    const idsBefore = new Set(listChangeEvents(db, 500).map((e) => e.id));
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    const fresh = listChangeEvents(db, 500).filter((e) => !idsBefore.has(e.id));
    expect(fresh.filter((e) => e.kind === 'new')).toEqual([]);
    expect(fresh.filter((e) => e.kind === 'vanished')).toEqual([]);
    expect(listProgramsBySource(db, 'arrl-scholarship-descriptions')).toHaveLength(6);
  });
});

describe('runSource — the AI assist is strictly optional (spec §9, Task 29)', () => {
  const map = {
    '/scholarship-descriptions': fixturePayload(
      'arrl-scholarship-descriptions',
      'pathological.html',
      'http://www.arrl.org/scholarship-descriptions',
    ),
  };

  it('behaves identically with a disabled assist and with none at all', async () => {
    const { fetcher } = fixtureFetcher(map);
    const disabled = { isEnabled: () => false, parseAssist: async () => [], preScore: async () => undefined };
    const a = await runSource({ ...deps(fetcher), assist: disabled }, 'arrl-scholarship-descriptions');
    db.exec('DELETE FROM review_items; DELETE FROM change_events; DELETE FROM programs; DELETE FROM sources; DELETE FROM snapshots;');
    const b = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(a.parsedCount).toBe(b.parsedCount);
    expect(a.events).toBe(b.events);
    expect(a.reviewItems).toBe(b.reviewItems);
    expect(a.error).toBe(b.error);
  });

  it('never calls an enabled assist when the deterministic parser already found records', async () => {
    const { fetcher } = fixtureFetcher(map);
    const parseAssist = vi.fn(async () => []);
    const preScore = vi.fn(async () => 0.9);
    const assist = { isEnabled: () => true, parseAssist, preScore };
    const result = await runSource({ ...deps(fetcher), assist }, 'arrl-scholarship-descriptions');
    // The pathological fixture parses to 6 real records — salvage never fires, but preScore is
    // still consulted per review item since the assist is enabled.
    expect(result.parsedCount).toBe(6);
    expect(parseAssist).not.toHaveBeenCalled();
    expect(preScore).toHaveBeenCalled();
  });

  it('salvages a zero-yield parse only when the assist is enabled, never with no key', async () => {
    // arrl-scholarship-descriptions expects far more than the pathological fixture yields, but a
    // genuinely-empty/unparseable payload drives the deterministic parser itself to zero — the
    // only condition under which the salvage path may fire.
    const { fetcher } = fixtureFetcher({
      '/scholarship-descriptions': {
        url: 'http://www.arrl.org/scholarship-descriptions',
        status: 200,
        contentType: 'text/html',
        body: '<html><body>nothing recognisable here</body></html>',
        fetchedAt: NOW,
      },
    });

    const disabledResult = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(disabledResult.parsedCount).toBe(0); // no assist at all: salvage never fires

    db.exec('DELETE FROM review_items; DELETE FROM change_events; DELETE FROM programs; DELETE FROM sources; DELETE FROM snapshots;');
    const parseAssist = vi.fn(async () => [
      {
        sourceId: 'arrl-scholarship-descriptions',
        externalKey: 'salvaged-1',
        name: 'Salvaged Scholarship',
        rawFields: { aiAssisted: 'true' },
        sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
        rawText: '',
      },
    ]);
    const enabled = { isEnabled: () => true, parseAssist, preScore: async () => undefined };
    const salvagedResult = await runSource({ ...deps(fetcher), assist: enabled }, 'arrl-scholarship-descriptions');
    expect(parseAssist).toHaveBeenCalledTimes(1);
    expect(salvagedResult.parsedCount).toBe(1);
  });
});

describe('runSource failure handling', () => {
  it('records the failure and does not throw', async () => {
    const fetcher = {
      async fetch(): Promise<FetchedPayload> {
        throw new Error('ECONNREFUSED');
      },
    };
    const result = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(result.error).toContain('ECONNREFUSED');
    const [health] = listSourceHealth(db);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toContain('ECONNREFUSED');
    expect(health.lastSuccessAt).toBeUndefined();
  });
});

describe('runSource on a legitimately empty source', () => {
  it('records success with a zero yield and emits no alarm and no vanished events', async () => {
    const { fetcher } = fixtureFetcher({
      'austinhams.org': fixturePayload('austin-arc', 'empty-window.html', 'https://austinhams.org/scholarships/'),
    });
    const result = await runSource(deps(fetcher), 'austin-arc');
    expect(result.parsedCount).toBe(0);
    expect(result.error).toBeUndefined();
    expect(listChangeEvents(db, 50).filter((e) => e.kind === 'parse_yield_dropped')).toEqual([]);
    expect(listChangeEvents(db, 50).filter((e) => e.kind === 'vanished')).toEqual([]);
    expect(listSourceHealth(db)[0].lastSuccessAt).toBe(NOW);
  });

  it(
    'carry-forward #1 — does not vanish a program published from a PRIOR season when this ' +
      'season legitimately scrapes zero (shouldSuppressVanished must actually be wired into ' +
      'runSource, not just exported by diff/)',
    async () => {
      // A prior crawl (last spring) published Austin ARC's scholarship. It is August now:
      // grants.austinhams.org legitimately shows "No opportunities available" until April 30.
      const prior = makeProgram({
        id: 'austin-arc--austin-arc-scholarships--deadbeef',
        funderId: 'austin-arc',
        name: 'Austin ARC Copeland and Greenwood Scholarships',
        tags: ['source:austin-arc', 'key:austin-arc-scholarships'],
      });
      upsertProgram(db, prior, { sourceId: 'austin-arc', externalKey: 'austin-arc-scholarships' });
      expect(listProgramsBySource(db, 'austin-arc')).toHaveLength(1);

      const { fetcher } = fixtureFetcher({
        'austinhams.org': fixturePayload('austin-arc', 'empty-window.html', 'https://austinhams.org/scholarships/'),
      });
      const result = await runSource(deps(fetcher), 'austin-arc');
      expect(result.parsedCount).toBe(0);
      expect(result.error).toBeUndefined();
      // Without shouldSuppressVanished wired in, diffPrograms would emit exactly this event for
      // `prior`, and approving it would DELETE a real, still-current program.
      expect(listChangeEvents(db, 50).filter((e) => e.kind === 'vanished')).toEqual([]);
      expect(listReviewItems(db, 'pending')).toEqual([]);
      // The previously-published record is untouched.
      expect(listProgramsBySource(db, 'austin-arc')).toHaveLength(1);
    },
  );
});

describe('runSource on a signal-only source', () => {
  it('emits ChangeEvents for relevant items and NO review items', async () => {
    const { fetcher } = fixtureFetcher({
      '/news/rss': fixturePayload('arrl-news-rss', 'pathological.xml', 'http://www.arrl.org/news/rss'),
    });
    const result = await runSource(deps(fetcher), 'arrl-news-rss');
    expect(result.parsedCount).toBe(4);
    expect(listReviewItems(db)).toEqual([]);
    const events = listChangeEvents(db, 50).filter((e) => e.sourceId === 'arrl-news-rss');
    const news = events.filter((e) => e.kind === 'new');
    expect(news).toHaveLength(3); // the contest item is filtered out by isRelevant
    // detectYieldDrop runs before the signal/normal branch for every source (arrlNewsRss's own
    // expectedMinRecords is 5, and this fixture only carries 4 items), so the alarm is real and
    // expected here too — it is a separate, correctly-firing event, not a bug in isRelevant.
    expect(events.filter((e) => e.kind === 'parse_yield_dropped')).toHaveLength(1);
    expect(events).toHaveLength(4);
  });

  it('does not re-signal the same item on a second run', async () => {
    const { fetcher } = fixtureFetcher({
      '/news/rss': fixturePayload('arrl-news-rss', 'pathological.xml', 'http://www.arrl.org/news/rss'),
    });
    await runSource(deps(fetcher), 'arrl-news-rss');
    const first = listChangeEvents(db, 50).length;
    await runSource(deps(fetcher), 'arrl-news-rss');
    expect(listChangeEvents(db, 50).length).toBe(first);
  });
});

describe('runSource on a follow-up source', () => {
  it('fetches the discovery request, then the follow-up request it produces', async () => {
    const { fetcher, fetched } = fixtureFetcher({
      'slug=grants': fixturePayload('ardc-grants', '00-discovery.json', 'https://www.ardc.net/wp-json/wp/v2/pages?slug=grants'),
      'parent=4821': fixturePayload('ardc-grants', '01-children.json', 'https://www.ardc.net/wp-json/wp/v2/pages?parent=4821'),
    });
    const result = await runSource(deps(fetcher), 'ardc-grants');
    expect(fetched.some((u) => u.includes('slug=grants'))).toBe(true);
    expect(fetched.some((u) => u.includes('parent=4821'))).toBe(true);
    expect(result.parsedCount).toBe(3);
  });
});

describe('runCrawl', () => {
  it('runs the named sources serially and returns one result each', async () => {
    const { fetcher } = fixtureFetcher({});
    const results = await runCrawl(deps(fetcher), ['manual-tier-d', 'austin-arc']);
    expect(results.map((r) => r.sourceId)).toEqual(['manual-tier-d', 'austin-arc']);
  });

  it('keeps going when one source fails', async () => {
    const fetcher = {
      calls: 0,
      async fetch(req: FetchRequest): Promise<FetchedPayload> {
        this.calls += 1;
        if (req.url.includes('austinhams')) throw new Error('boom');
        return { url: req.url, status: 200, contentType: 'text/html', body: '<p>x</p>', fetchedAt: NOW };
      },
    };
    const results = await runCrawl(deps(fetcher), ['austin-arc', 'manual-tier-d']);
    expect(results[0].error).toContain('boom');
    expect(results[1].error).toBeUndefined();
  });

  it('runs every registered source when no ids are given', async () => {
    const { fetcher } = fixtureFetcher({});
    const results = await runCrawl(deps(fetcher));
    // Registry-derived on purpose: Tasks 27 and 28 add three more Tier A modules and this
    // assertion must not need editing to stay honest.
    expect(results).toHaveLength(SOURCES.length);
  });

  it('handles manual-tier-d, which fetches nothing at all', async () => {
    const fetcher = {
      async fetch(): Promise<FetchedPayload> {
        throw new Error('should not fetch');
      },
    };
    const [result] = await runCrawl(deps(fetcher), ['manual-tier-d']);
    expect(result.error).toBeUndefined();
    expect(result.parsedCount).toBeGreaterThanOrEqual(15);
  });
});

describe('runCrawl honours sources.enabled — RESOLUTIONS R20 (carry-forward #4)', () => {
  /** Exactly what Plan 3's `PATCH /api/sources/:id` writes when an admin flips the toggle off. */
  function pause(sourceId: string): void {
    db.prepare(
      `INSERT INTO sources (id, label, tier, klass, expected_min_records, enabled)
       VALUES (?, ?, 'C', 'ham_scholarship', 0, 0)
       ON CONFLICT(id) DO UPDATE SET enabled = 0`,
    ).run(sourceId, sourceId);
  }

  const snapshotCount = (sourceId: string): number =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE source_id = ?').get(sourceId) as {
        n: number;
      }
    ).n;

  it('skips a paused source during a full crawl: no fetch, no last_polled_at, no snapshot', async () => {
    pause('austin-arc');
    const { fetcher, fetched } = fixtureFetcher({});
    const results = await runCrawl(deps(fetcher), ['manual-tier-d', 'austin-arc']);
    expect(results.map((r) => r.sourceId)).toEqual(['manual-tier-d']);
    expect(fetched.some((u) => u.includes('austinhams'))).toBe(false);
    expect(listSourceHealth(db).find((h) => h.sourceId === 'austin-arc')?.lastPolledAt).toBeUndefined();
    expect(snapshotCount('austin-arc')).toBe(0);
  });

  it('skips a paused source even when it is the only id asked for', async () => {
    pause('austin-arc');
    const { fetcher, fetched } = fixtureFetcher({});
    expect(await runCrawl(deps(fetcher), ['austin-arc'])).toEqual([]);
    expect(fetched).toEqual([]);
    expect(listSourceHealth(db).find((h) => h.sourceId === 'austin-arc')?.lastPolledAt).toBeUndefined();
    expect(snapshotCount('austin-arc')).toBe(0);
  });

  it('drops a paused source from the no-arguments nightly crawl', async () => {
    pause('austin-arc');
    const { fetcher } = fixtureFetcher({});
    const results = await runCrawl(deps(fetcher));
    expect(results).toHaveLength(SOURCES.length - 1);
    expect(results.map((r) => r.sourceId)).not.toContain('austin-arc');
  });

  it('runs a source that has no sources row yet — the default is enabled', async () => {
    const { fetcher } = fixtureFetcher({});
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number },
    ).toEqual({ n: 0 });
    const [result] = await runCrawl(deps(fetcher), ['manual-tier-d']);
    expect(result.sourceId).toBe('manual-tier-d');
    expect(result.error).toBeUndefined();
  });

  it('re-enabling restores the source, and recordPollStart never clears the pause', async () => {
    pause('austin-arc');
    const { fetcher } = fixtureFetcher({});
    await runCrawl(deps(fetcher), ['manual-tier-d', 'austin-arc']);
    // recordPollStart upserts `sources` for every source it DOES poll; the paused row must still
    // read enabled = 0 afterwards, or the pause would last exactly one night.
    expect(
      (db.prepare('SELECT enabled FROM sources WHERE id = ?').get('austin-arc') as {
        enabled: number;
      }).enabled,
    ).toBe(0);

    db.prepare('UPDATE sources SET enabled = 1 WHERE id = ?').run('austin-arc');
    const results = await runCrawl(deps(fetcher), ['austin-arc']);
    expect(results.map((r) => r.sourceId)).toEqual(['austin-arc']);
    expect(listSourceHealth(db).find((h) => h.sourceId === 'austin-arc')?.lastPolledAt).toBe(NOW);
  });
});

describe('RESOLUTIONS R9 — DEADLINE_INHERITANCE reconciliation (carry-forward #3)', () => {
  const map = {
    '/scholarship-descriptions': fixturePayload(
      'arrl-scholarship-descriptions',
      'pathological.html',
      'http://www.arrl.org/scholarship-descriptions',
    ),
  };

  it(
    'warns instead of failing silently when the seeded arrl-foundation-scholarships record ' +
      'does not exist yet — "arrl-scholarship-descriptions" inherits its deadline from it',
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { fetcher } = fixtureFetcher(map);
      const result = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
      // A missing reconciliation target must not fail the source: the 6 records it DOES own are
      // still real and still worth reviewing.
      expect(result.error).toBeUndefined();
      expect(result.parsedCount).toBe(6);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('arrl-foundation-scholarships');
      warn.mockRestore();
    },
  );

  it('does not warn once the canonical target program is published under a matching source key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const target = makeProgram({
      id: 'arrl-foundation-scholarships',
      funderId: 'arrl-foundation',
      name: 'ARRL Foundation Scholarship Program',
      tags: ['source:arrl-scholarship-program', 'key:scholarship-program'],
    });
    upsertProgram(db, target, { sourceId: 'arrl-scholarship-program', externalKey: 'scholarship-program' });

    const { fetcher } = fixtureFetcher(map);
    const result = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(result.error).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('carry-forward #2 — catching the source-key UNIQUE violation (RESOLUTIONS R9)', () => {
  it('healthMessageFor identifies a ProgramUpsertConflictError distinctly from any other error', () => {
    // Reproduce Task 20's own conflict exactly: two different ids claiming one (source_id,
    // external_key) pair. This is precisely what "a stale or missed existingIdFor" produces —
    // the programs upsert targets ON CONFLICT(id) only, so the second write hits the
    // partial-unique-index on (source_id, external_key) and SQLite refuses it.
    const key = { sourceId: 'qcwa', externalKey: 'qcwa-memorial-scholarship' };
    const original = makeProgram({ id: 'qcwa--original--aaaaaaaa', funderId: 'qcwa' });
    upsertProgram(db, original, key);
    const collider = makeProgram({ id: 'qcwa--a-different-minted-id', funderId: 'qcwa' });

    let thrown: unknown;
    try {
      upsertProgram(db, collider, key);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProgramUpsertConflictError);

    // This is the exact function runSource's catch block calls to build sources.last_error —
    // it must name the conflict specifically, not just relay a generic message, so an operator
    // reading source health can tell "reconciliation is broken for this record" apart from
    // "the site is down".
    const message = healthMessageFor(thrown);
    expect(message).toContain('source-key conflict');
    expect(message).toContain('qcwa--a-different-minted-id');
    expect(message).toContain('qcwa-memorial-scholarship');

    // A plain, unrelated error is passed through unchanged rather than being mislabeled.
    expect(healthMessageFor(new Error('ECONNREFUSED'))).toBe('ECONNREFUSED');
  });

  it(
    'one source throwing mid-crawl (of any error type, including a source-key conflict) never ' +
      'stops runCrawl from finishing the other sources — RESOLUTIONS R9 / "keep crawling the ' +
      'other 22"',
    async () => {
      // runSource's catch is generic: it wraps EVERY error the same way (recordPollFailure, then
      // continue) regardless of type, and healthMessageFor (proven above) is what makes a
      // ProgramUpsertConflictError specifically identifiable inside that same catch. This proves
      // the crawl-level resilience half of the contract using the fetch failure this suite
      // already exercises for other error types, so the assertion is a real, replayable state
      // (SOURCES.length results, all present) rather than a guess about unreachable code.
      const fetcher = {
        async fetch(req: FetchRequest): Promise<FetchedPayload> {
          if (req.url.includes('austinhams')) throw new Error('boom');
          return { url: req.url, status: 200, contentType: 'text/html', body: '<p>x</p>', fetchedAt: NOW };
        },
      };
      const results = await runCrawl(deps(fetcher));
      expect(results).toHaveLength(SOURCES.length);
      const austin = results.find((r) => r.sourceId === 'austin-arc');
      expect(austin?.error).toContain('boom');
      expect(results.filter((r) => r.sourceId !== 'austin-arc' && r.error === undefined).length).toBeGreaterThan(
        0,
      );
    },
  );
});
