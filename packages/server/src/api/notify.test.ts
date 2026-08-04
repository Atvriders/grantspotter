import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, starProgram, arrlScholarship } from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { insertChangeEvents } from '../db/repositories/ingestion.js';
import { detectYieldDrop, diffPrograms } from '../diff/index.js';
import { drainChangeEvents, describeChange, fanoutHealth } from './notify.js';

const NOW = '2026-08-02T12:00:00.000Z';
const LATER = '2026-08-03T12:00:00.000Z';
const ARRL_SOURCE = 'arrl-scholarship-descriptions';

/**
 * RESOLUTIONS R19: `watches` has ON DELETE CASCADE foreign keys to `users` and
 * `programs`, so the star goes through `starProgram`, which inserts both
 * parents first. A bare INSERT here fails with `FOREIGN KEY constraint failed`.
 */
function watch(db: Database.Database, userId: string, programId: string) {
  starProgram(db, userId, programId, NOW);
}

/** The event the product exists to deliver (spec §11.2). */
function seedDeadlineMove(db: Database.Database, id = 'ce-1') {
  db.prepare(
    `INSERT INTO change_events
       (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ARRL_SOURCE,
    'arrl-foundation-scholarship',
    'deadline_changed',
    JSON.stringify('2027-01-31T17:00:00.000Z'),
    JSON.stringify('2026-12-30T17:00:00.000Z'),
    NOW,
    'deadline.closesAt',
  );
}

/**
 * `programs.source_id` is Plan 1's ingest identity (RESOLUTIONS R9) and the
 * channel a source-scoped alarm reaches watchers through. The fixture corpus
 * upserts without a sourceKey — hand-curated records legitimately have none —
 * so a test about source-scoped fan-out has to attribute the record first.
 */
function attributeToSource(db: Database.Database, programId: string, sourceId = ARRL_SOURCE) {
  db.prepare('UPDATE programs SET source_id = ?, external_key = ? WHERE id = ?')
    .run(sourceId, programId, programId);
}

function seedYieldDrop(db: Database.Database, id: string, at: string) {
  insertChangeEvents(db, [
    {
      id,
      sourceId: ARRL_SOURCE,
      kind: 'parse_yield_dropped',
      detectedAt: at,
      fieldPath: 'parsedCount',
      before: { expectedMinRecords: 111 },
      after: { parsedCount: 0 },
    },
  ]);
}

function ledger(db: Database.Database): Array<{
  change_event_id: string;
  recipient_count: number;
  suppressed_count: number;
  suppressed_reason: string | null;
}> {
  return db
    .prepare(
      `SELECT change_event_id, recipient_count, suppressed_count, suppressed_reason
         FROM change_event_fanout ORDER BY change_event_id`,
    )
    .all() as Array<{
      change_event_id: string;
      recipient_count: number;
      suppressed_count: number;
      suppressed_reason: string | null;
    }>;
}

const deadlineSpec = (note: string): Program['deadline'] => ({
  kind: 'annual_window',
  source: { kind: 'self' },
  note,
});

describe('describeChange', () => {
  it('writes the deadline move as a sentence a human can act on', () => {
    const { title, body } = describeChange(
      'deadline_changed',
      '2027-01-31T17:00:00.000Z',
      '2026-12-30T17:00:00.000Z',
      'deadline.closesAt',
      'ARRL Foundation Scholarship Program',
    );
    expect(title).toBe('Deadline changed: ARRL Foundation Scholarship Program');
    expect(body).toContain('2027-01-31T17:00:00.000Z');
    expect(body).toContain('2026-12-30T17:00:00.000Z');
    expect(body).toContain('deadline.closesAt');
  });

  it('names the parse-yield alarm plainly, because it is how the app rots', () => {
    const { title } = describeChange('parse_yield_dropped', 111, 0, null, 'ARRL scholarships');
    expect(title).toBe('Parser yield dropped: ARRL scholarships');
  });

  it('handles a change with no program name', () => {
    const { title } = describeChange('vanished', 'x', null, null, null);
    expect(title).toBe('Record vanished from its source');
  });

  /**
   * THE SHAPE A REAL CRAWL ACTUALLY EMITS. `diffPrograms` puts the whole
   * `DeadlineSpec` in before/after and `field_path: 'deadline'` — never an ISO
   * string and never `deadline.closesAt`. Rendered naively that is a wall of
   * JSON with a RECUR directive in it, which is exactly the notification a user
   * cannot act on.
   */
  it('renders a real DeadlineSpec as dates, not as the JSON the differ stored', () => {
    const { body } = describeChange(
      'deadline_changed',
      deadlineSpec('RECUR annual_window tz=America/New_York window=10-30..01-31 close=17:00 | Closes Jan 31.'),
      deadlineSpec('RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | Moved.'),
      'deadline',
      'ARRL Foundation Scholarship Program',
    );
    expect(body).toContain('Jan 31');
    expect(body).toContain('Dec 30');
    expect(body).not.toContain('RECUR');
    expect(body).not.toContain('{');
  });

  /**
   * `isEstimated: false` — a window the funder published — is a much stronger
   * signal than a date projected from a recurrence rule, and the digest has to
   * say which one moved or the reader cannot weigh it.
   */
  it('says whether the new window is the funder’s own or a projection', () => {
    const projected = describeChange(
      'deadline_changed',
      null,
      deadlineSpec('RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 |'),
      'deadline',
      'ARRL Foundation Scholarship Program',
    );
    expect(projected.body).toContain('projected');

    const published = describeChange(
      'deadline_changed',
      null,
      {
        kind: 'ad_hoc',
        source: { kind: 'self' },
        note: 'Window published by the funder: opens 2026-10-30, closes 2026-12-30.',
      },
      'deadline',
      'ARISS Proposal Window',
    );
    expect(published.body).toContain('published by the funder');
    expect(published.body).toContain('2026-12-30');
    expect(published.body).not.toContain('projected');
  });

  it('renders the real yield-drop payload as counts', () => {
    const { body } = describeChange(
      'parse_yield_dropped',
      { expectedMinRecords: 111 },
      { parsedCount: 0 },
      'parsedCount',
      null,
    );
    expect(body).toContain('111');
    expect(body).toContain('0');
    expect(body).not.toContain('{');
  });

  it('renders an AmountSpec as the funder’s own words', () => {
    const { body } = describeChange(
      'amount_changed',
      { instrument: 'cash_range', amountMin: 500, amountMax: 25000, amountRaw: '$500 - $25,000' },
      { instrument: 'cash_fixed', amountMin: 1000, amountMax: 1000, amountRaw: '$1,000' },
      'amount',
      'ARRL Foundation Scholarship Program',
    );
    expect(body).toContain('$500 - $25,000');
    expect(body).toContain('$1,000');
    expect(body).not.toContain('instrument');
  });

  it('names a vanished program instead of dumping the whole record', () => {
    const { body } = describeChange('vanished', arrlScholarship, null, null, null);
    expect(body).toContain('ARRL Foundation Scholarship Program');
    expect(body).not.toContain('contentHash');
    expect(body.length).toBeLessThan(400);
  });

  /**
   * farweb.org was taken over and now 301s to a gambling site (domain fact 4).
   * The corpus keeps a `safety_warning` record for it ON PURPOSE, and that
   * record is publishable, so it can be starred and it can change — which is
   * the one path by which a hijacked URL could reach a student inside a
   * notification. The rendered digest carries no blocklisted host at all.
   */
  it('never puts a blocklisted host in a notification, not even as text', () => {
    const { body } = describeChange(
      'status_changed',
      'live at http://www.farweb.org/scholarships.html',
      'redirects to https://batualam.org/slot',
      'trust.sourceUrl',
      'FAR — Foundation for Amateur Radio (SAFETY WARNING)',
    );
    expect(body).not.toContain('farweb');
    expect(body).not.toContain('batualam');
    expect(body).toContain('blocklisted');
  });
});

describe('drainChangeEvents', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates one notification per watcher of the changed program', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    watch(db, 'u-b', 'arrl-foundation-scholarship');
    watch(db, 'u-c', 'ardc-grants');
    seedDeadlineMove(db);

    expect(drainChangeEvents(db, NOW)).toBe(2);
    const rows = db.prepare('SELECT user_id FROM notifications ORDER BY user_id').all() as Array<{ user_id: string }>;
    expect(rows.map((r) => r.user_id)).toEqual(['u-a', 'u-b']);
  });

  it('carries the before and after values so the digest can show the move', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    seedDeadlineMove(db);
    drainChangeEvents(db, NOW);
    const row = db.prepare('SELECT before_text, after_text, kind, source_id FROM notifications').get() as {
      before_text: string;
      after_text: string;
      kind: string;
      source_id: string;
    };
    expect(row.kind).toBe('deadline_changed');
    expect(row.before_text).toBe('2027-01-31T17:00:00.000Z');
    expect(row.after_text).toBe('2026-12-30T17:00:00.000Z');
    expect(row.source_id).toBe(ARRL_SOURCE);
  });

  it('never fans the same event out twice', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    seedDeadlineMove(db);
    expect(drainChangeEvents(db, NOW)).toBe(1);
    expect(drainChangeEvents(db, NOW)).toBe(0);
    const n = db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('marks an event with no watchers as fanned out so it is not rescanned forever', () => {
    seedDeadlineMove(db);
    expect(drainChangeEvents(db, NOW)).toBe(0);
    expect(ledger(db)).toEqual([
      { change_event_id: 'ce-1', recipient_count: 0, suppressed_count: 0, suppressed_reason: null },
    ]);
  });

  it('fans a source-level alarm out to everyone watching a program from that source', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    watch(db, 'u-b', 'ardc-grants');
    attributeToSource(db, 'arrl-foundation-scholarship');
    seedYieldDrop(db, 'ce-yield', NOW);

    expect(drainChangeEvents(db, NOW)).toBe(1);
    const row = db.prepare('SELECT kind, program_id, source_id, user_id FROM notifications').get() as {
      kind: string;
      program_id: string | null;
      source_id: string;
      user_id: string;
    };
    expect(row.kind).toBe('parse_yield_dropped');
    expect(row.program_id).toBeNull();
    expect(row.source_id).toBe(ARRL_SOURCE);
    expect(row.user_id).toBe('u-a');
  });

  it('tells one watcher once, however many of that source’s programs they watch', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    watch(db, 'u-a', 'arrl-club-grant');
    attributeToSource(db, 'arrl-foundation-scholarship');
    attributeToSource(db, 'arrl-club-grant');
    seedYieldDrop(db, 'ce-yield', NOW);

    expect(drainChangeEvents(db, NOW)).toBe(1);
  });

  /**
   * DOMAIN FACT 5, measured against the committed fixtures: all 111 ARRL catalog
   * entries inherit their cycle and NOT ONE carries a rule of its own, so the
   * night ARRL moves the close date `diffPrograms` raises exactly ONE event — on
   * the owner — and every programme that actually moves raises nothing. The
   * fixture corpus has the same shape: QCWA rides the ARRL cycle.
   */
  it('tells the riders when the cycle they inherit moves', () => {
    watch(db, 'u-rider', 'qcwa-memorial-scholarship');
    seedDeadlineMove(db);

    expect(drainChangeEvents(db, NOW)).toBe(1);
    const row = db.prepare('SELECT user_id, title, body, program_id FROM notifications').get() as {
      user_id: string;
      title: string;
      body: string;
      program_id: string;
    };
    expect(row.user_id).toBe('u-rider');
    // Named for the programme whose date actually moved, so the reader can check it.
    expect(row.title).toBe('Deadline changed: ARRL Foundation Scholarship Program');
    expect(row.program_id).toBe('arrl-foundation-scholarship');
    expect(row.body).toContain('1 other programme inherits this cycle');
  });

  it('does not tell the riders about anything but the cycle', () => {
    watch(db, 'u-rider', 'qcwa-memorial-scholarship');
    db.prepare(
      `INSERT INTO change_events
         (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ce-amount', ARRL_SOURCE, 'arrl-foundation-scholarship', 'amount_changed',
      JSON.stringify({ instrument: 'cash_range', amountRaw: '$500 - $25,000' }),
      JSON.stringify({ instrument: 'cash_range', amountRaw: '$500 - $30,000' }), NOW, 'amount');

    expect(drainChangeEvents(db, NOW)).toBe(0);
  });

  /**
   * "Parser yield dropped" on its own does not say which of a user's sources
   * went quiet, and that is the only fact they can act on. `sources.label` is
   * Plan 1's column and Plan 2 fills it; the id is the fallback so a database
   * whose registry has not been synced still names something.
   */
  it('names the source that broke, not just the alarm', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    attributeToSource(db, 'arrl-foundation-scholarship');
    db.prepare(
      `INSERT INTO sources (id, label, tier, klass, expected_min_records)
       VALUES (?, ?, 'A', 'ham_scholarship', 100)`,
    ).run(ARRL_SOURCE, 'ARRL scholarship descriptions');
    seedYieldDrop(db, 'ce-yield', NOW);

    drainChangeEvents(db, NOW);
    const row = db.prepare('SELECT title FROM notifications').get() as { title: string };
    expect(row.title).toBe('Parser yield dropped: ARRL scholarship descriptions');
  });

  it('falls back to the source id when no label is registered', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    attributeToSource(db, 'arrl-foundation-scholarship');
    seedYieldDrop(db, 'ce-yield', NOW);

    drainChangeEvents(db, NOW);
    const row = db.prepare('SELECT title FROM notifications').get() as { title: string };
    expect(row.title).toBe(`Parser yield dropped: ${ARRL_SOURCE}`);
  });

  it('processes several pending events in one drain', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    watch(db, 'u-a', 'ardc-grants');
    seedDeadlineMove(db, 'ce-1');
    db.prepare(
      `INSERT INTO change_events
         (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ce-2', 'ardc-grants-page', 'ardc-grants', 'status_changed',
      JSON.stringify('open'), JSON.stringify('closed'), NOW, 'trust.status');

    expect(drainChangeEvents(db, NOW)).toBe(2);
  });

  /**
   * `watches.notify_changes` had NO reader in this repository before this
   * function — Plan 1 declares it `CHECK (notify_changes IN (0,1))`, the
   * schema-conformance map names it, the fixture writes it, and nothing acted
   * on it. A star with the flag off is a user saying "keep this on my list,
   * stop mailing me"; delivering anyway is not noise, it is ignoring consent.
   */
  it('honours a muted star, and records why nobody was told', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    db.prepare('UPDATE watches SET notify_changes = 0 WHERE user_id = ?').run('u-a');
    seedDeadlineMove(db);

    expect(drainChangeEvents(db, NOW)).toBe(0);
    expect(ledger(db)).toEqual([
      { change_event_id: 'ce-1', recipient_count: 0, suppressed_count: 1, suppressed_reason: 'muted' },
    ]);
  });

  /**
   * THE nsf-funding-rss LESSON. A source that breaks stays broken, and
   * `detectYieldDrop` fires again every single night with a fresh event id. Three
   * nights of an identical unread alarm is three notifications the user learns
   * to clear without reading. The alarm is not deleted anywhere — every event
   * still lands in `change_events` and every one is ledgered — only the repeat
   * DELIVERY is suppressed.
   */
  it('does not repeat an alarm the user has not read yet', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    attributeToSource(db, 'arrl-foundation-scholarship');
    seedYieldDrop(db, 'ce-night-1', NOW);
    seedYieldDrop(db, 'ce-night-2', LATER);
    seedYieldDrop(db, 'ce-night-3', '2026-08-04T12:00:00.000Z');

    expect(drainChangeEvents(db, LATER)).toBe(1);
    const events = db.prepare('SELECT COUNT(*) AS n FROM change_events').get() as { n: number };
    expect(events.n).toBe(3);
    expect(ledger(db).map((r) => [r.recipient_count, r.suppressed_count, r.suppressed_reason])).toEqual([
      [1, 0, null],
      [0, 1, 'duplicate_unread'],
      [0, 1, 'duplicate_unread'],
    ]);
  });

  it('tells the user again once they have read the last one', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    attributeToSource(db, 'arrl-foundation-scholarship');
    seedYieldDrop(db, 'ce-night-1', NOW);
    drainChangeEvents(db, NOW);
    db.prepare('UPDATE notifications SET read_at = ?').run(NOW);

    seedYieldDrop(db, 'ce-night-2', LATER);
    expect(drainChangeEvents(db, LATER)).toBe(1);
  });

  /**
   * ~553 of the corpus's records are stored but suppressed (`do_not_publish`):
   * past awards, and the crosscheck table. Browse, the review queue and the
   * approve path all drop them through the single shared `isDoNotPublish`
   * predicate. A notification about one would open a page the product refuses
   * to show, which is a notification the user cannot act on.
   */
  it('does not deliver a change to a record the product refuses to publish', () => {
    createProgramRepo(db).upsert({
      ...arrlScholarship,
      id: 'arrl-club-grant-past-award',
      name: 'Past award: 2024 club grant recipient',
      tags: [...arrlScholarship.tags, 'do_not_publish'],
    });
    watch(db, 'u-a', 'arrl-club-grant-past-award');
    db.prepare(
      `INSERT INTO change_events
         (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ce-past', ARRL_SOURCE, 'arrl-club-grant-past-award', 'amount_changed',
      JSON.stringify({ instrument: 'cash_fixed', amountRaw: '$500' }),
      JSON.stringify({ instrument: 'cash_fixed', amountRaw: '$600' }), NOW, 'amount');

    expect(drainChangeEvents(db, NOW)).toBe(0);
    expect(ledger(db)).toEqual([
      {
        change_event_id: 'ce-past',
        recipient_count: 0,
        suppressed_count: 1,
        suppressed_reason: 'not_publishable',
      },
    ]);
  });

  /**
   * RESOLUTIONS R26: approving a `vanished` event DELETES the program row, and
   * "the programme you were watching disappeared" is the single most important
   * thing this digest ever says. `notifications.program_id` therefore carries NO
   * foreign key and the name is denormalized onto the row: a cascade would
   * delete the notice, and a plain REFERENCES would refuse to write it.
   */
  function seedVanished(db2: Database.Database) {
    watch(db2, 'u-a', 'chicago-fm-club-scholarship');
    const gone = createProgramRepo(db2).get('chicago-fm-club-scholarship');
    expect(gone).not.toBeUndefined();
    insertChangeEvents(db2, [
      {
        id: 'ce-gone',
        sourceId: 'chicago-fm-club',
        programId: 'chicago-fm-club-scholarship',
        kind: 'vanished',
        detectedAt: NOW,
        before: gone,
      },
    ]);
  }

  it('keeps the vanished notice, and its name, after the program row is deleted', () => {
    seedVanished(db);
    expect(drainChangeEvents(db, NOW)).toBe(1);
    db.prepare('DELETE FROM programs WHERE id = ?').run('chicago-fm-club-scholarship');

    const row = db.prepare('SELECT program_name, title, program_id FROM notifications').get() as {
      program_name: string;
      title: string;
      program_id: string | null;
    };
    expect(row.program_name).toBe('Chicago FM Club Scholarship');
    expect(row.title).toContain('Chicago FM Club Scholarship');
    expect(row.program_id).toBe('chicago-fm-club-scholarship');
  });

  /**
   * FOUND BY EXECUTING THIS TASK, and it is an ordering constraint on Task 12,
   * not a defect this file can fix. `watches.program_id` is
   * `REFERENCES programs(id) ON DELETE CASCADE` (Plan 1 001-init.sql), so
   * deleting the program deletes every star on it FIRST. A drain that runs
   * afterwards has no recipients left to find, and the one notice that matters
   * most is silently undeliverable. The ledger still records the event with
   * `recipient_count = 0`, which is how it stays visible, but the fix is to
   * DRAIN BEFORE DELETING: `drainChangeEvents` is idempotent and cheap, so the
   * Inbox approve route must call it before `deleteProgram`, not only after the
   * publish.
   */
  it('cannot reach a watcher once a program delete has cascaded the stars away', () => {
    seedVanished(db);
    db.prepare('DELETE FROM programs WHERE id = ?').run('chicago-fm-club-scholarship');
    expect(db.prepare('SELECT COUNT(*) AS n FROM watches').get()).toEqual({ n: 0 });

    expect(drainChangeEvents(db, NOW)).toBe(0);
    expect(ledger(db)).toEqual([
      { change_event_id: 'ce-gone', recipient_count: 0, suppressed_count: 0, suppressed_reason: null },
    ]);
  });

  /**
   * END TO END THROUGH THE REAL DIFFER. Not a hand-written event: the exact
   * rows `diffPrograms` and `detectYieldDrop` write on a night when ARRL moves
   * the close date and the scholarship parser returns nothing.
   */
  it('turns a real crawl’s events into sentences', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    attributeToSource(db, 'arrl-foundation-scholarship');

    const previous: Program = {
      ...arrlScholarship,
      deadline: deadlineSpec(
        'RECUR annual_window tz=America/New_York window=10-30..01-31 close=17:00 | Closes Jan 31.',
      ),
    };
    const events = diffPrograms([previous], [arrlScholarship], ARRL_SOURCE, NOW);
    const yieldDrop = detectYieldDrop(ARRL_SOURCE, 0, 111, NOW);
    expect(events.map((e) => e.kind)).toEqual(['deadline_changed']);
    expect(yieldDrop).not.toBeNull();
    insertChangeEvents(db, yieldDrop === null ? events : [...events, yieldDrop]);

    expect(drainChangeEvents(db, NOW)).toBe(2);
    const rows = db
      .prepare('SELECT kind, title, body FROM notifications ORDER BY kind')
      .all() as Array<{ kind: string; title: string; body: string }>;

    const deadline = rows.find((r) => r.kind === 'deadline_changed');
    expect(deadline?.title).toBe('Deadline changed: ARRL Foundation Scholarship Program');
    expect(deadline?.body).toContain('Jan 31');
    expect(deadline?.body).toContain('Dec 30');
    expect(deadline?.body).not.toContain('RECUR');

    const yieldRow = rows.find((r) => r.kind === 'parse_yield_dropped');
    expect(yieldRow?.body).toContain('111');
    expect(yieldRow?.body).not.toContain('{');
  });
});

describe('fanoutHealth', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * "No notifications tonight" and "the fan-out never ran" and "every alarm
   * reached nobody" look identical from a user's empty digest. Suppressing
   * noise is only safe while those three stay distinguishable to an operator,
   * which is what this reads `recipient_count` and `suppressed_count` for.
   */
  it('tells a quiet night apart from a drain that never ran', () => {
    seedYieldDrop(db, 'ce-yield', NOW);
    const before = fanoutHealth(db);
    expect(before.pendingEvents).toBe(1);
    expect(before.fannedOutEvents).toBe(0);

    drainChangeEvents(db, NOW);
    const after = fanoutHealth(db);
    expect(after.pendingEvents).toBe(0);
    expect(after.fannedOutEvents).toBe(1);
    expect(after.zeroRecipientEvents).toBe(1);
    expect(after.lastFanoutAt).toBe(NOW);
    expect(after.notifications).toEqual({ total: 0, unread: 0 });
  });

  /**
   * Events AND watchers, because they answer different questions. A real crawl
   * ledgers 553 `not_publishable` events a night that suppress 0 watchers — the
   * stored-but-never-published corpus re-diffs as `new` every night — and
   * reporting only the watcher total would render that as a silent zero.
   */
  it('counts what was suppressed, and why', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    attributeToSource(db, 'arrl-foundation-scholarship');
    seedYieldDrop(db, 'ce-night-1', NOW);
    seedYieldDrop(db, 'ce-night-2', LATER);
    createProgramRepo(db).upsert({
      ...arrlScholarship,
      id: 'past-award',
      name: 'Past award',
      tags: [...arrlScholarship.tags, 'do_not_publish'],
    });
    insertChangeEvents(db, [
      {
        id: 'ce-past',
        sourceId: ARRL_SOURCE,
        programId: 'past-award',
        kind: 'new',
        detectedAt: NOW,
        after: { name: 'Past award', tags: ['do_not_publish'] },
      },
    ]);
    drainChangeEvents(db, LATER);

    const health = fanoutHealth(db);
    expect(health.suppressed).toEqual([
      { reason: 'duplicate_unread', events: 1, watchers: 1 },
      { reason: 'not_publishable', events: 1, watchers: 0 },
    ]);
    expect(health.notifications).toEqual({ total: 1, unread: 1 });
  });
});
