import Database from 'better-sqlite3';
import type { FetchRequest, FetchedPayload, Program } from '@grantspotter/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { createCycleRepo } from '../db/repositories/cycles.js';
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
import { buildUserAgent } from '../config.js';
import { NSF_FEED_URLS } from '../federal/nsf.js';
import { createFetcher } from '../fetcher/index.js';
import { approveReviewItem, confidenceFor } from '../review/index.js';
import { funderFor, getSource, SOURCES } from '../sources/registry.js';
import { GRANTS_GOV_EXTRACT_RETENTION_DAYS } from '../federal/grantsGovExtract.js';
import { hasAlternativeRequests, healthMessageFor, runCrawl, runSource } from './runner.js';

/**
 * THE 5000 ms FLAKE, DIAGNOSED BEFORE IT WAS TIMED OUT.
 *
 * Symptom: this file passes 53/53 standalone and intermittently fails one or two tests with
 * "Test timed out in 5000ms" during a full `npm test`. In this repo four flaky-or-weak tests have
 * each turned out to be pointing at a real defect, so the timeout was the LAST thing changed.
 *
 * IT IS NOT A RACE. There is no timer, no polling, no `waitFor`, no retry and no network anywhere
 * in this file: `fixtureFetcher` resolves from a committed payload in the same tick, better-sqlite3
 * is synchronous, and every promise is awaited by the test that created it. There is nothing here
 * that can be satisfied before the work it is waiting on has happened — the failure mode that
 * produced the other four. What the tests below do is CPU work, and a lot of it: each
 * `crawlAndApprove('arrl-scholarship-descriptions')` runs cheerio over the real 144 KB captured
 * catalogue, normalizes 111 records, diffs them, queues 111 review items and then approves all 111
 * one at a time — the whole ingestion path, on purpose, because the defect this block exists to
 * prevent survived 37 commits of tests that hand-wrote the owner's id instead of crawling for it.
 *
 * MEASURED on this 36-core host, standalone, three runs: the worst test ("converges on IDENTICAL
 * cycle rows", which does FOUR of those crawl+approve cycles across two databases) takes
 * 3.39 s / 3.18 s / 3.24 s — 64-68% of the 5000 ms default already, with nothing left for a busy
 * machine. Reproduced deterministically by running this file with 36 competing busy loops: the same
 * test failed at 5242 ms and 6552 ms with "Test timed out in 5000ms", and never any other way.
 *
 * So the budget is the bug: a genuinely 3.4-second test was being given 5 seconds. Raised for the
 * whole file rather than sprinkled per test, because every test here drives the same real crawl and
 * the next one added will too. 30 s is ~9x the measured worst case, and still fails a real hang
 * inside half a minute — the reason it is not simply enormous.
 */
vi.setConfig({ testTimeout: 30_000 });

const NOW = '2026-08-02T00:00:00.000Z';
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db); // Plan 1 owns every CONTRACT §6 table
  ensureIngestionSchema(db);
  // Deliberately NO funders pre-seeding here (SEAM FIX, whole-branch review). runSource itself
  // now upserts the real funder for whatever source it runs — that IS the fix, and hand-seeding
  // every registry funder here would silently mask a regression in it. A few tests below need a
  // program to already exist BEFORE they ever call runSource; those seed only the one funder they
  // need, at the point they need it — see `seedFunder` below.
});

/**
 * Seeds exactly one real funder row, for a test that upserts a program directly (bypassing
 * runSource) to simulate "this record was already published by an earlier, successful
 * crawl+approve cycle" — which is the only way such a row could exist in production, and is
 * exactly how it would have acquired its funder row: through the same seam this file's "fresh
 * install" describe block below proves.
 */
function seedFunder(funderId: string): void {
  const f = funderFor(funderId);
  db.prepare(
    'INSERT OR IGNORE INTO funders (id, name, homepage, ein, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(f.id, f.name, f.homepage, f.ein ?? null, f.note ?? null, NOW, NOW);
}

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

/**
 * `forgetRobots` is stamped on here rather than written into every fixture literal below.
 *
 * `Fetcher` requires it since 2026-08-04 — `runCrawl` drops the robots cache at the start of every
 * run, which is what makes "add a Disallow and it takes effect tonight" true. A fixture fetcher has
 * no cache to drop, so the no-op is honest, and a no-op here would prove nothing anyway: the test
 * that shows the re-read really happens uses the REAL fetcher over a stub transport, two runs in
 * one process, and counts the robots.txt requests ("re-reads robots.txt on every crawl run").
 */
const deps = (fetcher: { fetch(req: FetchRequest): Promise<FetchedPayload> }) => ({
  db,
  fetcher: { forgetRobots: () => {}, ...fetcher },
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
      seedFunder('austin-arc'); // that prior crawl+approve is what created this funder row too
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
      'parent=1271': fixturePayload('ardc-grants', '01-children.json', 'https://www.ardc.net/wp-json/wp/v2/pages?parent=1271'),
    });
    const result = await runSource(deps(fetcher), 'ardc-grants');
    expect(fetched.some((u) => u.includes('slug=grants'))).toBe(true);
    // 1271 is the parent id in the REAL discovery capture (fetched 2026-08-03). The fixture used
    // to be hand-written and carried 4821, an id ardc.net has never served.
    expect(fetched.some((u) => u.includes('parent=1271'))).toBe(true);
    expect(result.parsedCount).toBe(8);
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

describe('the deadline owner is resolved from the REAL corpus, never from a written-down id', () => {
  /*
   * REMEDIATION (2026-08-03) — the dangling owner.
   *
   * `DEADLINE_INHERITANCE` held the literal `'arrl-foundation-scholarships'` and it was consumed
   * as a PROGRAM id. No program has ever carried that id: `programIdFor` derives every id from
   * (sourceId, externalKey), so the real record behind that page is
   * `arrl-scholarship-program--scholarship-program--<hash>`. All 112 inheriting records pointed at
   * nothing, 112 of 152 published programs had no deadline, and none of them reached the calendar.
   *
   * The defect survived 37 commits of remediation because every test of this path HAND-WROTE the
   * owner id into its own setup — the block that used to live here seeded a program with
   * `id: 'arrl-foundation-scholarships'` by hand and then asserted the crawler found it. So the
   * rule for everything below is: NO PROGRAM ID IS WRITTEN DOWN ANYWHERE IN THE SETUP. The owner
   * is produced by crawling its real captured page and approving it, exactly as a user would, and
   * the dependents have to find it on their own.
   */
  const PORTAL = fixturePayload(
    'arrl-scholarship-program',
    '00-www-arrl-org-scholarship-program.html',
    'http://www.arrl.org/scholarship-program',
  );
  const CATALOG = fixturePayload(
    'arrl-scholarship-descriptions',
    '00-www-arrl-org-scholarship-descriptions.html',
    'http://www.arrl.org/scholarship-descriptions',
  );
  const map = { '/scholarship-program': PORTAL, '/scholarship-descriptions': CATALOG };

  /** Crawls one source and approves everything it queued, as a reviewer would. */
  async function crawlAndApprove(sourceId: string): Promise<Program[]> {
    const { fetcher } = fixtureFetcher(map);
    const result = await runSource(deps(fetcher), sourceId);
    expect(result.error).toBeUndefined();
    for (const item of listReviewItems(db, 'pending')) approveReviewItem(db, item.id, 'user-1', NOW);
    return listProgramsBySource(db, sourceId);
  }

  const cycleRows = (): Array<Record<string, unknown>> =>
    db
      .prepare('SELECT id, program_id, closes_at, timezone, label, is_estimated FROM cycles ORDER BY id')
      .all() as Array<Record<string, unknown>>;

  it('publishes the ARRL portal as ONE record whose 2026 cycle its own page says is closed', async () => {
    const [owner] = await crawlAndApprove('arrl-scholarship-program');
    expect(listProgramsBySource(db, 'arrl-scholarship-program')).toHaveLength(1);
    // Straight off the captured page, which prints "The 2026 Scholarship Cycle is now closed."
    expect(owner.trust.status).toBe('closed');
    expect(owner.deadline.kind).toBe('annual_window');
  });

  it('makes every catalog entry point at the id the owner was ACTUALLY published under', async () => {
    const [owner] = await crawlAndApprove('arrl-scholarship-program');
    const catalog = await crawlAndApprove('arrl-scholarship-descriptions');

    expect(catalog.length).toBe(111);
    const inherited = catalog.filter((p) => p.deadline.source.kind === 'inherited');
    expect(inherited).toHaveLength(111);
    for (const entry of inherited) {
      const source = entry.deadline.source;
      if (source.kind !== 'inherited') throw new Error('unreachable');
      // The assertion the old suite could not make: the reference is checked against the id the
      // database really holds, which nothing in this test chose.
      expect(source.fromProgramId, entry.name).toBe(owner.id);
    }
  });

  it('gives those entries a real deadline and real calendar rows — 0 before this fix', async () => {
    await crawlAndApprove('arrl-scholarship-program');
    const catalog = await crawlAndApprove('arrl-scholarship-descriptions');
    const byProgram = new Set(
      (db.prepare('SELECT DISTINCT program_id FROM cycles').all() as Array<{ program_id: string }>)
        .map((r) => r.program_id),
    );
    // Every catalog entry that inherits now projects the owner's cycle under its own id. The
    // Winscott scholarship is the one deliberate exception: its own page says it is not currently
    // active, so it is `dormant` and carries no cycle.
    const riding = catalog.filter((p) => p.trust.status !== 'dormant');
    expect(riding.length).toBeGreaterThan(100);
    for (const entry of riding) expect(byProgram.has(entry.id), entry.name).toBe(true);
  });

  it('carries the owner’s STATE across the same hop, not just its dates', async () => {
    // THE SECOND DEFECT. Deadline inheritance was implemented and status inheritance was not, so
    // 110 of these 111 badged `open` while the page they ride says the cycle is closed — the most
    // expensive thing this product can tell a student. No status is written down here either: it
    // comes off the real portal page, one hop, through the crawl.
    await crawlAndApprove('arrl-scholarship-program');
    const first = await crawlAndApprove('arrl-scholarship-descriptions');
    // First crawl: the owner is published, so inheritance resolves immediately.
    const closed = first.filter((p) => p.trust.status === 'closed');
    expect(closed.length).toBe(110);
    expect(first.filter((p) => p.trust.status === 'open')).toHaveLength(0);
    // The one record whose OWN page overrides its owner: "This scholarship is not currently
    // active." A record's own evidence outranks the cycle it rides.
    const winscott = first.filter((p) => p.name.includes('Winscott'));
    expect(winscott).toHaveLength(1);
    expect(winscott[0].trust.status).toBe('dormant');
  });

  it('never invents a state: dependents crawled before the owner exists stay unknown', async () => {
    // NOT `open`. An inheriting record whose owner is unpublished is a record whose state nobody
    // has established, and `unknown` is the only honest answer — inventing `open` here is exactly
    // the failure being remediated.
    const catalog = await crawlAndApprove('arrl-scholarship-descriptions');
    expect(catalog.filter((p) => p.trust.status === 'open')).toHaveLength(0);
    expect(catalog.filter((p) => p.trust.status === 'unknown').length).toBe(110);
  });

  it('converges on IDENTICAL cycle rows whether the owner or the dependents are approved first', async () => {
    // Approval order must not matter. Row-for-row identity, not merely equal counts: a count
    // matches even when two orders produce different dates under different ids.
    await crawlAndApprove('arrl-scholarship-program');
    await crawlAndApprove('arrl-scholarship-descriptions');
    const ownerFirst = cycleRows();

    db = new Database(':memory:');
    migrate(db);
    ensureIngestionSchema(db);
    await crawlAndApprove('arrl-scholarship-descriptions');
    await crawlAndApprove('arrl-scholarship-program');
    const dependentsFirst = cycleRows();

    expect(dependentsFirst.length).toBeGreaterThan(100);
    expect(dependentsFirst).toEqual(ownerFirst);
  });

  it('warns, without failing the source, while the owner is not published yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fetcher } = fixtureFetcher(map);
    const result = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    // A missing owner must not fail the source: its 111 records are real and worth reviewing.
    expect(result.error).toBeUndefined();
    expect(result.parsedCount).toBe(111);
    expect(warn).toHaveBeenCalledTimes(1);
    // The warning names the derived id, so an operator can grep the corpus for it.
    expect(warn.mock.calls[0][0]).toContain('arrl-scholarship-program');
    warn.mockRestore();
  });

  it('stops warning once the owner is published — nothing is written down to make it stop', async () => {
    await crawlAndApprove('arrl-scholarship-program');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    seedFunder('qcwa');
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

describe('SEAM FIX — a fresh install seeds its own funders, nobody has to', () => {
  // No `funders` INSERT anywhere in this describe block, and none in this file's beforeEach
  // either (see the note there). This is deliberately "the way it broke": before the fix,
  // `db/repositories/programs.ts`'s upsert (called from `approveReviewItem`) died with
  // `SqliteError: FOREIGN KEY constraint failed` the moment anyone approved a fresh install's
  // first review item, because programs.funder_id REFERENCES funders(id) and nothing ever wrote
  // that table. manual-tier-d is used because it needs no fetcher at all, so this test proves the
  // funder seam specifically rather than depending on HTML fixtures.

  it('crawls, then approves, on a genuinely empty migrated database', async () => {
    expect((db.prepare('SELECT COUNT(*) AS n FROM funders').get() as { n: number }).n).toBe(0);

    const { fetcher } = fixtureFetcher({});
    const result = await runSource(deps(fetcher), 'manual-tier-d');
    expect(result.error).toBeUndefined();

    const pending = listReviewItems(db, 'pending');
    expect(pending.length).toBeGreaterThan(0);

    const published = approveReviewItem(db, pending[0].id, 'user-1', NOW);
    expect(published.id).toBe(pending[0].candidate.id);
    expect(listProgramsBySource(db, 'manual-tier-d')).toHaveLength(1);
  });

  it('seeds the real funder identity from the registry, not a placeholder', async () => {
    const { fetcher } = fixtureFetcher({});
    await runSource(deps(fetcher), 'manual-tier-d');
    const row = db.prepare('SELECT id, name, homepage FROM funders WHERE id = ?').get('various') as
      | { id: string; name: string; homepage: string }
      | undefined;
    expect(row).toEqual({
      id: 'various',
      name: funderFor('various').name,
      homepage: funderFor('various').homepage,
    });
    expect(row?.homepage).not.toBe('https://example.test/');
  });

  it('lets every review item from a whole no-argument nightly crawl be approved with no crash', async () => {
    // Every module actually gets fetched here (each returns 404 from fixtureFetcher's default),
    // so this exercises funderFor() against every one of the 16 distinct funderIds in the
    // registry, not just one.
    const { fetcher } = fixtureFetcher({});
    await runCrawl(deps(fetcher));
    const pending = listReviewItems(db, 'pending');
    expect(pending.length).toBeGreaterThan(0);
    for (const item of pending) {
      expect(() => approveReviewItem(db, item.id, 'user-1', NOW)).not.toThrow();
    }
  });
});

describe('registry funder coverage (SEAM FIX)', () => {
  it('resolves a real, non-placeholder funder for every registered module', () => {
    for (const m of SOURCES) {
      const funder = funderFor(m.funderId);
      expect(funder.id).toBe(m.funderId);
      expect(funder.name).not.toBe('');
      expect(funder.homepage).toMatch(/^https:\/\//);
      expect(funder.homepage).not.toBe('https://example.test/');
    }
  });

  it('throws a named, actionable error for an unregistered funderId', () => {
    expect(() => funderFor('not-a-real-funder-id')).toThrow(/not-a-real-funder-id/);
  });
});

describe('cycles end-to-end: real ARDC/ARRL fixtures through crawl -> approve -> cycles (SEAM FIX)', () => {
  // `expandCycles`/`createCycleRepo` had zero production callers before this fix. These are the
  // three real RECUR directives in `normalize/deadline.ts`'s RECURRENCE_BY_SOURCE, exercised here
  // through the ACTUAL crawl pipeline against committed real (non-pathological) fixtures — no
  // hand-built Program, no hand-written RECUR note — so this proves the whole seam: parse ->
  // normalize -> review -> approve -> cycles.
  const map = {
    'slug=grants': fixturePayload(
      'ardc-grants',
      '00-discovery.json',
      'https://www.ardc.net/wp-json/wp/v2/pages?slug=grants',
    ),
    'parent=1271': fixturePayload(
      'ardc-grants',
      '01-children.json',
      'https://www.ardc.net/wp-json/wp/v2/pages?parent=1271',
    ),
    '/amateur-radio-grants': fixturePayload(
      'arrl-amateur-radio-grants',
      '00-www-arrl-org-amateur-radio-grants.html',
      'http://www.arrl.org/amateur-radio-grants',
    ),
    '/scholarship-program': fixturePayload(
      'arrl-scholarship-program',
      '00-www-arrl-org-scholarship-program.html',
      'http://www.arrl.org/scholarship-program',
    ),
  };

  async function crawlThreeSources(): Promise<ReturnType<typeof fixtureFetcher>> {
    const served = fixtureFetcher(map);
    for (const sourceId of ['ardc-grants', 'arrl-amateur-radio-grants', 'arrl-scholarship-program']) {
      await runSource(deps(served.fetcher), sourceId);
    }
    return served;
  }

  it('lands real dated rows for the RECUR programs that have a live record, and none for the one that does not', async () => {
    expect((db.prepare('SELECT COUNT(*) AS n FROM cycles').get() as { n: number }).n).toBe(0);

    await crawlThreeSources();
    for (const item of listReviewItems(db, 'pending')) approveReviewItem(db, item.id, 'user-1', NOW);

    const cycles = createCycleRepo(db);
    const ardcGrants = listProgramsBySource(db, 'ardc-grants');
    const [arrlGrant] = listProgramsBySource(db, 'arrl-amateur-radio-grants');
    const [arrlScholarship] = listProgramsBySource(db, 'arrl-scholarship-program');
    expect(arrlGrant).toBeDefined();
    expect(arrlScholarship).toBeDefined();

    // ARDC — CHANGED BY CLOSE-OUT REVIEW B8, and this is the finding, not a weakened assertion.
    // The real /apply/grants/ children (captured 2026-08-03, parent id 1271) are eight YEAR
    // ARCHIVES of grants already made — "Information on 2025 Charitable Gifts can be found
    // below…" — so every record this source produces is recordType past_award, is suppressed by
    // buildReviewItems, and is never approved into `programs` at all. It used to project 13
    // future application deadlines onto "Grants awarded in 2025", through Sep 2029.
    //
    // RECURRENCE_BY_SOURCE['ardc-grants'] is therefore a directive with no live record to ride.
    // The dates in it are REAL — https://www.ardc.net/apply/ says verbatim "The 2026 application
    // deadlines are: February 1 April 1 July 1 September 1" — but that page is not a child of
    // /apply/grants/ and nothing fetches it, so ARDC has no publishable opportunity record here.
    expect(ardcGrants).toEqual([]);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM cycles').get() as { n: number }).n,
    ).toBeGreaterThan(0); // ...the ARRL two below, and nothing from ARDC.

    // ARRL Amateur Radio Grants — "RECUR n_fixed_windows tz=America/New_York
    // windows=02-01..02-28,06-01..06-30,10-01..10-31" — three windows a year, close 23:59 local.
    const grantCycles = cycles.listForProgram(arrlGrant.id);
    expect(grantCycles.map((c) => c.closesAt)).toEqual([
      '2026-11-01T03:59:00.000Z', // Oct 31, 2026 23:59 EDT (UTC-4)
      '2027-03-01T04:59:00.000Z', // Feb 28, 2027 23:59 EST (UTC-5)
      '2027-07-01T03:59:00.000Z', // Jun 30, 2027 23:59 EDT
      '2027-11-01T03:59:00.000Z', // Oct 31, 2027 23:59 EDT
    ]);

    // ARRL Foundation Scholarships — "RECUR annual_window tz=America/New_York
    // window=10-30..12-30 close=12:00" — one annual window a year, explicit close time.
    const scholarshipCycles = cycles.listForProgram(arrlScholarship.id);
    expect(scholarshipCycles.map((c) => c.closesAt)).toEqual([
      '2026-12-30T17:00:00.000Z', // Dec 30, 2026 12:00 EST (UTC-5)
      '2027-12-30T17:00:00.000Z', // Dec 30, 2027 12:00 EST
    ]);
  });

  it('approving the same review items twice does not duplicate cycle rows', async () => {
    await crawlThreeSources();
    const pending = listReviewItems(db, 'pending');
    expect(pending.length).toBeGreaterThan(0);
    for (const item of pending) approveReviewItem(db, item.id, 'user-1', NOW);

    const before = (db.prepare('SELECT COUNT(*) AS n FROM cycles').get() as { n: number }).n;
    expect(before).toBeGreaterThan(0);

    // Literally "approve twice": re-approving the SAME review item ids is legal (approve does not
    // check current decision) and is exactly what proves projectCycles's
    // removeEstimatedForProgram-then-upsertMany replaces rather than accumulates a second
    // projection on top of the first.
    for (const item of pending) approveReviewItem(db, item.id, 'user-1', NOW);

    const after = (db.prepare('SELECT COUNT(*) AS n FROM cycles').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe('SEAM FIX round 2 — real crawl+approve converges regardless of Inbox click order', () => {
  // Round 1 only re-projected the ONE program being published, so whether the 112 real
  // ARRL-catalog records that inherit from `arrl-foundation-scholarships` ever got cycles
  // depended on whether a human happened to approve that owner before or after them in the
  // Inbox. This runs the ACTUAL crawl pipeline (real `arrl-scholarship-program` fixture as the
  // deadline owner, real `arrl-scholarship-descriptions` pathological fixture as 6 dependents —
  // RESOLUTIONS R9's own reconciliation mechanism, exactly as Plan 5's seed corpus + the nightly
  // crawl would produce it) in both orders and asserts the resulting `cycles` rows are IDENTICAL.
  const map = {
    '/scholarship-program': fixturePayload(
      'arrl-scholarship-program',
      '00-www-arrl-org-scholarship-program.html',
      'http://www.arrl.org/scholarship-program',
    ),
    '/scholarship-descriptions': fixturePayload(
      'arrl-scholarship-descriptions',
      'pathological.html',
      'http://www.arrl.org/scholarship-descriptions',
    ),
  };

  /**
   * Sets up one fresh database: funder seeded, the canonical owner id pre-seeded under its real
   * source key (Plan 5's seed-corpus role — RESOLUTIONS R9 only resolves once this exists), then
   * crawls both real sources. Returns every pending review item split into "the owner's" and "the
   * six dependents'", so the caller controls approval order.
   */
  async function crawlOwnerAndDependents(freshDb: Database.Database) {
    migrate(freshDb);
    ensureIngestionSchema(freshDb);
    const f = funderFor('arrl-foundation');
    freshDb
      .prepare('INSERT INTO funders (id, name, homepage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(f.id, f.name, f.homepage, NOW, NOW);

    const placeholder = makeProgram({
      id: 'arrl-foundation-scholarships',
      funderId: 'arrl-foundation',
      name: 'ARRL Foundation Scholarship Program (pre-seeded, Plan 5)',
      tags: ['source:arrl-scholarship-program', 'key:scholarship-program'],
    });
    upsertProgram(freshDb, placeholder, {
      sourceId: 'arrl-scholarship-program',
      externalKey: 'scholarship-program',
    });

    const served = fixtureFetcher(map);
    // Same no-op as `deps` above, for the one helper that builds its own CrawlDeps against a
    // second database rather than the file-level `db`.
    const localDeps = {
      db: freshDb,
      fetcher: { forgetRobots: () => {}, ...served.fetcher },
      nowISO: () => NOW,
    };
    await runSource(localDeps, 'arrl-scholarship-program');
    await runSource(localDeps, 'arrl-scholarship-descriptions');

    const pending = listReviewItems(freshDb, 'pending');
    const ownerItem = pending.find((i) => i.candidate.id === 'arrl-foundation-scholarships');
    const dependentItems = pending.filter((i) => i.candidate.id !== 'arrl-foundation-scholarships');
    if (!ownerItem) throw new Error('owner review item not found — fixture or reconciliation broke');
    return { ownerItem, dependentItems };
  }

  function snapshotCycles(freshDb: Database.Database, programIds: string[]): Record<string, unknown> {
    const cycles = createCycleRepo(freshDb);
    const out: Record<string, unknown> = {};
    for (const id of programIds) out[id] = cycles.listForProgram(id);
    return out;
  }

  const countCycles = (d: Database.Database): number =>
    (d.prepare('SELECT COUNT(*) AS n FROM cycles').get() as { n: number }).n;

  it('produces the identical `cycles` rows whether the owner is approved first or last', async () => {
    const ownerFirstDb = new Database(':memory:');
    const { ownerItem: ownerA, dependentItems: depsA } = await crawlOwnerAndDependents(ownerFirstDb);
    approveReviewItem(ownerFirstDb, ownerA.id, 'user-1', NOW);
    for (const item of depsA) approveReviewItem(ownerFirstDb, item.id, 'user-1', NOW);

    const dependentsFirstDb = new Database(':memory:');
    const { ownerItem: ownerB, dependentItems: depsB } = await crawlOwnerAndDependents(dependentsFirstDb);
    for (const item of depsB) approveReviewItem(dependentsFirstDb, item.id, 'user-1', NOW);
    approveReviewItem(dependentsFirstDb, ownerB.id, 'user-1', NOW);

    const ids = [ownerA.candidate.id, ...depsA.map((i) => i.candidate.id)];
    const snapOwnerFirst = snapshotCycles(ownerFirstDb, ids);
    const snapDependentsFirst = snapshotCycles(dependentsFirstDb, ids);
    expect(snapDependentsFirst).toEqual(snapOwnerFirst);

    const totalOwnerFirst = countCycles(ownerFirstDb);
    const totalDependentsFirst = countCycles(dependentsFirstDb);
    // Real numbers, reported for the record, not just "equal": a real crawl + real approve of the
    // real ARRL fixtures lands 14 cycle rows (owner's own 2 + 6 dependents x 2 each) — see round 2
    // of remediation-seams-report.md.
    console.log(`owner-first total cycles: ${totalOwnerFirst}; dependents-first total cycles: ${totalDependentsFirst}`);
    expect(totalOwnerFirst).toBeGreaterThan(0);
    expect(totalDependentsFirst).toBe(totalOwnerFirst);
  });
});

/**
 * REMEDIATION 2026-08-03 — `do_not_publish`, end to end through the REAL crawl pipeline.
 *
 * Before this fix the tag was written by `normalize/` and read by nothing, so `arrl-pages.ts`'s
 * claim that a cross-check source "refuses to publish" and the identical promises in
 * `ardc-award-tables.ts`, `nsf-awards.ts` and `usaspending.ts` were all false of the running code.
 * Measured on the committed fixtures before the fix: club-grant queued 38 review items,
 * ardc-award-tables 24, nsf-awards 1, usaspending 1 — every one of them approvable, every one of
 * them a `Program` that would render as a live funding opportunity.
 *
 * These run `runSource` itself — real fixtures, real parse, real normalize, real diff, real queue —
 * and assert the exact contents of the queue, not merely that it shrank.
 */
describe('do_not_publish end-to-end: past awards are stored but never queued', () => {
  const clubGrantMap = {
    '/club-grant-program': fixturePayload(
      'arrl-club-grant',
      '00-www-arrl-org-club-grant-program.html',
      'http://www.arrl.org/club-grant-program',
    ),
  };

  /**
   * The candidate Programs the crawl STORED, read back out of `change_events.after_json` — the
   * evidence that suppression costs nothing. `parse_yield_dropped` alarms also land in
   * `change_events` and carry `after: { parsedCount }` rather than a Program, so they are filtered
   * out by shape rather than assumed absent.
   */
  const storedCandidates = (tag: string): Program[] =>
    listChangeEvents(db, 500)
      .map((e) => e.after as Program | undefined)
      .filter((p): p is Program => Array.isArray(p?.tags) && p.tags.includes(tag));

  it('queues the ONE real ARRL Club Grant Program and none of the 37 past recipients', async () => {
    const { fetcher } = fixtureFetcher(clubGrantMap);
    const result = await runSource(deps(fetcher), 'arrl-club-grant');
    expect(result.error).toBeUndefined();

    // The parser still finds all 38 — suppression is not a parse failure, and `parsedCount` is
    // what feeds source health and detectYieldDrop, so it must keep reporting the true yield.
    expect(result.parsedCount).toBe(38);
    expect(listSourceHealth(db).find((h) => h.sourceId === 'arrl-club-grant')?.lastRecordCount).toBe(38);

    const pending = listReviewItems(db, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].candidate.name).toBe('ARRL Club Grant Program');
    expect(pending[0].candidate.tags).not.toContain('do_not_publish');
    expect(result.reviewItems).toBe(1);

    // Named, not just counted: no row in the queue is one of the recipient records.
    expect(pending.filter((i) => i.candidate.name.includes('Club Grant recipient'))).toEqual([]);
  });

  it('keeps all 37 past recipients stored and retrievable as evidence', async () => {
    const { fetcher } = fixtureFetcher(clubGrantMap);
    await runSource(deps(fetcher), 'arrl-club-grant');

    const stored = storedCandidates('past_award');
    expect(stored).toHaveLength(37);

    // Retrievable in full, not as a bare id: a past recipient list tells an applicant a great deal
    // about who this funder actually funds, which is the whole reason these are stored at all.
    const named = stored.find((p) => p.name.startsWith('Oklahoma State University Amateur Radio Club'));
    expect(named).toBeDefined();
    expect(named?.trust.status).toBe('closed');
    expect(named?.tags).toContain('do_not_publish');
    expect(named?.trust.sourceUrl).toContain('club-grant-program');
  });

  it('the true positive still fires: approving the real club grant publishes it', async () => {
    const { fetcher } = fixtureFetcher(clubGrantMap);
    await runSource(deps(fetcher), 'arrl-club-grant');
    const [item] = listReviewItems(db, 'pending');

    const published = approveReviewItem(db, item.id, 'user-1', NOW);
    expect(published.name).toBe('ARRL Club Grant Program');

    const corpus = listProgramsBySource(db, 'arrl-club-grant');
    expect(corpus).toHaveLength(1);
    expect(corpus[0].name).toBe('ARRL Club Grant Program');
    // The published corpus contains no suppressed record, by the only path that can write to it.
    expect(corpus.filter((p) => p.tags.includes('do_not_publish'))).toEqual([]);
  });

  it('does the same for ardc-award-tables, nsf-awards and usaspending — four sources, one gate', async () => {
    // The other three `recordType: 'past_award'` sources. The fix deliberately lives in the shared
    // pipeline rather than in any one source module, so all four are covered by the same gate.
    const cases: Array<{ sourceId: string; map: Record<string, FetchedPayload>; parsed: number }> = [
      {
        sourceId: 'ardc-award-tables',
        // The same 3-row fixture is served for each of the eight year pages the module requests
        // (2019 through 2026), and `year` is part of the external key, so 3 x 8 = 24 distinct rows.
        map: {
          '-grants/': fixturePayload(
            'ardc-award-tables',
            'pathological.html',
            'https://www.ardc.net/apply/grants/2026-grants/',
          ),
        },
        parsed: 24,
      },
      {
        sourceId: 'nsf-awards',
        map: {
          'api.nsf.gov': fixturePayload(
            'nsf-awards',
            'awards-response.json',
            'https://api.nsf.gov/services/v1/awards.json',
          ),
        },
        parsed: 1,
      },
      {
        sourceId: 'usaspending',
        map: {
          'usaspending.gov': fixturePayload(
            'usaspending',
            'spending-by-award.json',
            'https://api.usaspending.gov/api/v2/search/spending_by_award/',
          ),
        },
        parsed: 1,
      },
    ];

    for (const { sourceId, map, parsed } of cases) {
      db.exec('DELETE FROM review_items; DELETE FROM change_events; DELETE FROM programs; DELETE FROM sources; DELETE FROM snapshots;');
      const { fetcher } = fixtureFetcher(map);
      const result = await runSource(deps(fetcher), sourceId);
      expect(result.error, sourceId).toBeUndefined();
      expect(result.parsedCount, `${sourceId} must still parse everything`).toBe(parsed);
      expect(listReviewItems(db, 'pending'), `${sourceId} must queue nothing`).toEqual([]);

      expect(
        storedCandidates('past_award'),
        `${sourceId} must keep its award history stored`,
      ).toHaveLength(parsed);
    }
  });

  it('does the same for the crosscheck-only ARRL summary table', async () => {
    // The record type that already carried the tag before this fix — and was queued anyway, which
    // is the single clearest proof the tag had no reader: it was tagged AND it was in the queue.
    const { fetcher } = fixtureFetcher({
      '/summary-of-scholarship-requirements': fixturePayload(
        'arrl-summary-of-scholarship-requirements',
        '00-www-arrl-org-summary-of-scholarship-requirements.html',
        'http://www.arrl.org/summary-of-scholarship-requirements',
      ),
    });
    const result = await runSource(deps(fetcher), 'arrl-summary-of-scholarship-requirements');
    expect(result.parsedCount).toBe(1);
    expect(listReviewItems(db, 'pending')).toEqual([]);
    expect(storedCandidates('crosscheck')).toHaveLength(1);
  });
});

/**
 * REMEDIATION 2026-08-03 — the adjacency signal, end to end through the REAL crawl pipeline.
 *
 * `federal/adjacency.ts` scores a candidate's relevance to amateur radio on a weighted vocabulary,
 * and five source modules compute it and write `rawFields.adjacencyScore`. It reached NOTHING:
 * `normalizeRaw` drops `rawFields` wholesale, and `confidenceFor`'s adjacency parameter was
 * optional and never passed. Measured on the committed captures BEFORE the fix, the one real open
 * federal opportunity (NTIA PWSCIF, adjacencyScore 6) was queued with confidence 0.85 — the flat
 * Tier-A number — and `nsf-funding-rss` queued all 45 of its real items at a flat 0.5.
 *
 * These run `runSource` itself against those same real captures, so the number asserted here is
 * the number a reviewer actually sees.
 */
describe('adjacencyScore end to end: the score reaches confidenceFor', () => {
  const SEARCH_FILES = [
    '00-api-grants-gov-v1-api-search2.json',
    '01-api-grants-gov-v1-api-search2.json',
    '02-api-grants-gov-v1-api-search2.json',
    '03-api-grants-gov-v1-api-search2.json',
    '04-api-grants-gov-v1-api-search2.json',
  ] as const;

  /**
   * The five keyword searches are answered in request order (the module builds one request per
   * GRANTS_GOV_KEYWORDS entry), and the single follow-up detail fetch is answered by the captured
   * fetchOpportunity response. Both legs hit api.grants.gov, so they are told apart by path.
   */
  function grantsGovFetcher() {
    let n = 0;
    return {
      async fetch(req: FetchRequest): Promise<FetchedPayload> {
        if (req.url.toLowerCase().includes('fetchopportunity')) {
          return fixturePayload(
            'grants-gov-federal',
            '05-api-grants-gov-v1-api-fetchopportunity.json',
            req.url,
          );
        }
        if (req.url.includes('search2')) {
          return fixturePayload(
            'grants-gov-federal',
            SEARCH_FILES[Math.min(n++, SEARCH_FILES.length - 1)],
            req.url,
          );
        }
        return { url: req.url, status: 404, contentType: 'text/html', body: '', fetchedAt: NOW };
      },
    };
  }

  it('gives the one real open federal call a confidence of exactly its score over 12', async () => {
    const result = await runSource(deps(grantsGovFetcher()), 'grants-gov-federal');
    expect(result.error).toBeUndefined();
    expect(result.parsedCount).toBe(1);

    const [item] = listReviewItems(db, 'pending');
    expect(item.candidate.name).toBe(
      'Public Wireless Supply Chain Innovation Fund Grant Program – Solutions for AI-Native RAN',
    );
    // NTIA PWSCIF scores exactly 6 (Public Wireless Supply Chain Innovation Fund + PWSCIF).
    // 6/12 = 0.5. Before the fix this row read 0.85 — TIER_CONFIDENCE.A, the score discarded.
    expect(item.confidence).toBe(0.5);
    expect(item.confidence).not.toBe(confidenceFor('A', 'new', undefined));
    expect(item.confidence).toBe(confidenceFor('A', 'new', 6));
  });
});

/**
 * REMEDIATION 2026-08-03 — the `nsf-funding-rss` nightly flood.
 *
 * Measured on the three real captured feeds BEFORE the fix: parsedCount 45, review items 45, every
 * one at a flat 0.5, every night, forever — and not one of the 45 is adjacent to amateur radio
 * (the best three score 1: Gravitational Physics, Chemical Oceanography, SBIR). A queue that is
 * 45-out-of-45 noise trains its reader to approve without reading.
 *
 * The fix scores every item in the source and gates the QUEUE downstream, in `buildReviewItems`,
 * rather than dropping items in `parse()`. The tests below are paired deliberately: the first
 * measures the queue, the second measures what a broken feed still does — because zeroing the
 * source's YIELD would have suppressed the noise and disabled `detectYieldDrop` at the same time,
 * which is exactly how `arrl-scholarship-program` parsed 0 records from its own real page while
 * the suite stayed green.
 */
describe('nsf-funding-rss: noise suppressed, breakage still detectable', () => {
  const FEED_FILES: ReadonlyArray<readonly [string, string]> = [
    ['00-www-nsf-gov-rss-rss-www-funding-xml.xml', NSF_FEED_URLS[0]],
    ['01-www-nsf-gov-rss-rss-www-funding-pgm-annc-inf-xml.xml', NSF_FEED_URLS[1]],
    ['02-www-nsf-gov-rss-rss-www-funding-upcoming-rss-xml.xml', NSF_FEED_URLS[2]],
  ];

  const feedFetcher = () => ({
    async fetch(req: FetchRequest): Promise<FetchedPayload> {
      const hit = FEED_FILES.find(([, url]) => url === req.url);
      if (!hit) return { url: req.url, status: 404, contentType: 'text/html', body: '', fetchedAt: NOW };
      return fixturePayload('nsf-funding-rss', hit[0], req.url);
    },
  });

  /** The three feeds still answer 200, but with the SPA shell every Grants.gov feed serves. */
  const brokenFetcher = () => ({
    async fetch(req: FetchRequest): Promise<FetchedPayload> {
      return {
        url: req.url,
        status: 200,
        contentType: 'text/html',
        body: '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
        fetchedAt: NOW,
      };
    },
  });

  it('queues NONE of the 45 real items, and still parses and reports all 45', async () => {
    const result = await runSource(deps(feedFetcher()), 'nsf-funding-rss');
    expect(result.error).toBeUndefined();

    // Was 45. This is the whole point of the fix.
    expect(result.reviewItems).toBe(0);
    expect(listReviewItems(db, 'pending')).toEqual([]);

    // Unchanged, and load-bearing: the parse yield is what the alarm watches.
    expect(result.parsedCount).toBe(45);
    expect(listSourceHealth(db).find((h) => h.sourceId === 'nsf-funding-rss')?.lastRecordCount).toBe(45);

    // No alarm on a healthy night: 45 >= expectedMinRecords of 10.
    expect(listChangeEvents(db, 500).filter((e) => e.kind === 'parse_yield_dropped')).toEqual([]);
  });

  it('keeps all 45 stored and retrievable, so suppression costs no evidence', async () => {
    await runSource(deps(feedFetcher()), 'nsf-funding-rss');
    const stored = listChangeEvents(db, 500)
      .map((e) => e.after as Program | undefined)
      .filter((p): p is Program => Array.isArray(p?.tags));
    expect(stored).toHaveLength(45);
    expect(stored.map((p) => p.name)).toContain('Research Experiences for Undergraduates (REU)');
  });

  it('STILL fires the yield alarm when the feed breaks — the property a parse() filter would lose', async () => {
    const result = await runSource(deps(brokenFetcher()), 'nsf-funding-rss');
    expect(result.error).toBeUndefined();
    expect(result.parsedCount).toBe(0);

    const alarms = listChangeEvents(db, 500).filter((e) => e.kind === 'parse_yield_dropped');
    expect(alarms).toHaveLength(1);
    expect(alarms[0].after).toEqual({ parsedCount: 0 });
    expect(alarms[0].before).toEqual({ expectedMinRecords: 10 });
    expect(listSourceHealth(db).find((h) => h.sourceId === 'nsf-funding-rss')?.lastRecordCount).toBe(0);
  });

  it('the true positive still fires: an adjacent NSF solicitation reaches the queue', async () => {
    // A synthetic feed in the REAL shape, carrying the language a genuinely relevant NSF
    // solicitation would carry. Without this, "the queue is empty" would be indistinguishable
    // from "the gate swallows everything" — which is the failure mode the gate itself creates.
    const item = (title: string, description: string, guid: string) =>
      `<item><title>${title}</title><link>https://www.nsf.gov/funding/${guid}</link>` +
      `<guid>https://www.nsf.gov/funding/${guid}</guid><description>${description}</description></item>`;
    const body =
      '<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>NSF</title>' +
      item(
        'Geospace Facilities',
        'Supports ionospheric radio science, HF propagation studies and space weather ' +
          'observation, including undergraduate research at minority serving institutions.',
        'geospace',
      ) +
      item('Chemical Oceanography', 'Supports research in marine chemistry.', 'chemocean') +
      '</channel></rss>';
    const fetcher = {
      async fetch(req: FetchRequest): Promise<FetchedPayload> {
        return {
          url: req.url,
          status: req.url === NSF_FEED_URLS[0] ? 200 : 404,
          contentType: 'application/rss+xml',
          body: req.url === NSF_FEED_URLS[0] ? body : '',
          fetchedAt: NOW,
        };
      },
    };
    const result = await runSource(deps(fetcher), 'nsf-funding-rss');
    expect(result.parsedCount).toBe(2);

    const pending = listReviewItems(db, 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].candidate.name).toBe('Geospace Facilities');
    // Tier B alone would be a flat 0.5; the score is what puts this above it.
    expect(pending[0].confidence).toBeGreaterThan(confidenceFor('B', 'new', undefined));
  });
});

/**
 * THE DOCUMENTED REMEDY, EXERCISED THROUGH THE REAL FETCHER (2026-08-04).
 *
 * The README and `.github/ISSUE_TEMPLATE/crawler-contact.md` both tell a site owner that
 * `User-agent: GrantSpotter` + `Disallow: /` stops every deployment of this software. Until this
 * commit that was true of a fresh process and false of a running one: `createFetcher` cached each
 * origin's robots.txt in a `Map` with no expiry and no eviction, so an instance up since February
 * was still crawling on February's rules, and `robots.ts` carried a comment claiming a re-read
 * ("until the next nightly poll re-reads it") that nothing implemented.
 *
 * Every other robots test in this repository uses a fixture fetcher, which has no cache and
 * therefore cannot see this. So this block uses the REAL fetcher over a stub transport and drives
 * it through `runCrawl` twice in one process — the shape of the thing that was broken: not two
 * fetches, two RUNS.
 */
describe('a robots.txt added between two crawl runs, in one process', () => {
  const AUSTIN_PAGE = 'https://austinhams.org/scholarships/';
  const AUSTIN_ROBOTS = 'https://austinhams.org/robots.txt';

  function stubTransport(robots: () => string) {
    const calls: string[] = [];
    const transport = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url === AUSTIN_ROBOTS) {
        return new Response(robots(), { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return new Response('<html><body><p>nothing today</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };
    return { calls, transport };
  }

  it('re-reads it, and the second run obeys the new file', async () => {
    let robots = 'User-agent: *\n';
    const { calls, transport } = stubTransport(() => robots);
    const fetcher = createFetcher({
      userAgent: buildUserAgent('https://w9xyz-radio-club.org/grantspotter'),
      contactUrl: 'https://w9xyz-radio-club.org/grantspotter',
      transport,
      sleep: async () => {},
      now: () => 0, // the clock never moves: any re-read is forgetRobots, not the TTL
      defaultMinIntervalMs: 0,
    });
    const crawlDeps = { db, fetcher, nowISO: () => NOW };

    const first = await runCrawl(crawlDeps, ['austin-arc']);
    expect(first[0].error).toBeUndefined();
    expect(calls).toEqual([AUSTIN_ROBOTS, AUSTIN_PAGE]);

    // The site owner reads the issue template and adds the two lines it gives them.
    robots = 'User-agent: GrantSpotter\nDisallow: /\n';

    const second = await runCrawl(crawlDeps, ['austin-arc']);
    // Read again — this is the assertion that was false before the fix.
    expect(calls.filter((u) => u === AUSTIN_ROBOTS)).toHaveLength(2);
    // …and acted on: the page is not fetched a second time, and the source records why.
    expect(calls.filter((u) => u === AUSTIN_PAGE)).toHaveLength(1);
    expect(second[0].error).toMatch(/robots\.txt disallows/);
    expect(listSourceHealth(db).find((h) => h.sourceId === 'austin-arc')?.lastError).toMatch(
      /robots\.txt disallows/,
    );
  });

  it('still reads it only once WITHIN a run, so the re-read costs one request a night', async () => {
    // The politeness property the cache exists for, which the fix must not have traded away.
    const { calls, transport } = stubTransport(() => 'User-agent: *\n');
    const fetcher = createFetcher({
      userAgent: buildUserAgent('https://w9xyz-radio-club.org/grantspotter'),
      contactUrl: 'https://w9xyz-radio-club.org/grantspotter',
      transport,
      sleep: async () => {},
      now: () => 0,
      defaultMinIntervalMs: 0,
    });
    await runCrawl({ db, fetcher, nowISO: () => NOW }, ['austin-arc', 'austin-arc']);
    expect(calls.filter((u) => u === AUSTIN_ROBOTS)).toHaveLength(1);
  });
});

/**
 * ALTERNATIVES, NOT A SET — the crawl loop's half of the Grants.gov extract memory fix.
 *
 * `grants-gov-extract` offers seven URLs because the Grants.gov bucket keeps a ~7-day rolling
 * window and today's file may not be published yet. Every one of them is a FULL SNAPSHOT of the
 * same corpus. The loop used to fetch and hold all seven: measured against the real archive on this
 * host before the change, one nightly run of this ONE source downloaded 545,297,718 bytes, wrote
 * 727,063,624 bytes of snapshots and peaked at 3,547 MB of RSS, to use one seventh of it.
 *
 * These four tests are the contract in both directions: the stop happens, it is keyed on something
 * the runner and the module both still spell the same way, it does not fire for anybody else, and
 * it CANNOT turn a failure into a quiet zero.
 */
describe('a source whose requests are alternatives stops at the first answer', () => {
  const extractZip = () => loadFixture('grants-gov-extract', '00-extract.zip.b64');
  const okPayload = (url: string): FetchedPayload => ({
    url,
    status: 200,
    contentType: 'application/zip',
    body: extractZip(),
    fetchedAt: NOW,
  });
  const missing = (url: string): FetchedPayload => ({
    url,
    status: 404,
    contentType: 'text/html',
    body: '',
    fetchedAt: NOW,
  });

  /** Answers the nth request of the run with `plan[n]`, falling back to the last entry. */
  function scriptedFetcher(plan: Array<(url: string) => FetchedPayload>) {
    const fetched: string[] = [];
    return {
      fetched,
      fetcher: {
        async fetch(req: FetchRequest): Promise<FetchedPayload> {
          const answer = plan[fetched.length] ?? plan[plan.length - 1];
          fetched.push(req.url);
          return answer(req.url);
        },
      },
    };
  }

  it('recognises the extract module, and nothing else in the registry', () => {
    expect(hasAlternativeRequests(getSource('grants-gov-extract'))).toBe(true);
    const others = SOURCES.filter((m) => m.id !== 'grants-gov-extract').filter((m) =>
      hasAlternativeRequests(m),
    );
    expect(others.map((m) => m.id)).toEqual([]);
  });

  it('makes ONE request when the first day answers, and snapshots one payload', async () => {
    const { fetched, fetcher } = scriptedFetcher([okPayload]);
    const result = await runSource(deps(fetcher), 'grants-gov-extract');
    expect(fetched).toHaveLength(1);
    expect(result.error).toBeUndefined();
    expect(result.parsedCount).toBe(2); // the two adjacent records in the committed fixture
    const snaps = db
      .prepare('SELECT COUNT(*) AS n FROM snapshots WHERE source_id = ?')
      .get('grants-gov-extract') as { n: number };
    expect(snaps.n).toBe(1);
  });

  it('walks back a day when the first archive is a short download, and stops at the good one', async () => {
    const truncated = (url: string): FetchedPayload => {
      const zip = Buffer.from(extractZip(), 'base64');
      const central = zip.readUInt32LE(zip.length - 22 + 16);
      zip.writeUInt32LE(zip.readUInt32LE(central + 20) + 4096, central + 20);
      return { ...okPayload(url), body: zip.toString('base64') };
    };
    const { fetched, fetcher } = scriptedFetcher([truncated, okPayload]);
    const result = await runSource(deps(fetcher), 'grants-gov-extract');
    expect(fetched).toHaveLength(2);
    expect(result.parsedCount).toBe(2);
    expect(result.error).toBeUndefined();
  });

  /**
   * THE STOP CAN ONLY EVER DROP REQUESTS. Nothing answers, so the loop runs to the end of the
   * window exactly as it did before — and the source is `failing` with a message that says the feed
   * could not be READ, which is the distinction 651b9f3 exists to hold and which a memory guard
   * must not be allowed to take back.
   */
  it('still fetches the whole window when nothing answers, and reports a read failure', async () => {
    const { fetched, fetcher } = scriptedFetcher([missing]);
    const result = await runSource(deps(fetcher), 'grants-gov-extract');
    expect(fetched).toHaveLength(GRANTS_GOV_EXTRACT_RETENTION_DAYS);
    expect(result.parsedCount).toBe(0);
    expect(result.error).toMatch(/read failure, not an empty feed/);
    const health = listSourceHealth(db).find((h) => h.sourceId === 'grants-gov-extract');
    expect(health?.lastError).toMatch(/read failure, not an empty feed/);
    expect(health?.lastSuccessAt).toBeUndefined();
  });
});
