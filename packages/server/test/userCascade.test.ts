import { afterAll, describe, expect, it } from 'vitest';
import { openTestDb } from '../src/test/testDb.js';

/**
 * THE DELETED-USER-LEAVES-A-DOOR-OPEN INVARIANT.
 *
 * `adminUsersRouter.ts` deletes an account with one statement and lets SQLite do the rest:
 *
 *   // Every `REFERENCES users(id)` in the schema is ON DELETE CASCADE
 *   // (sessions, profiles, watches, applications — 001-init.sql) …
 *
 * That comment is TRUE TODAY. It is also a claim about every table this schema will ever grow,
 * written where nothing can check it — and this is the third time in this project a correct
 * observation about the present has been leaned on as a guarantee about the future (the others
 * being a migration index that was already redundant, and a source module whose note promised it
 * "refuses to publish" while nothing read the tag it set).
 *
 * THE CONCRETE THING COMING. Plan 5 adds an `ics_tokens` table, and its planned shape carries a
 * `user_id` with NO foreign key. The moment that lands, deleting a user stops revoking their
 * calendar feed: the delete route still reports the account gone, `removed` still counts profiles
 * and watches and sessions, and a removed member's ICS subscription keeps serving the
 * organisation's programme data to whoever holds the URL — indefinitely, because nothing else in
 * the system ever revisits that row. Nothing fails. Nobody is told. Task 13's report already
 * states "the ICS token dies with the row", and that statement rests entirely on a cascade that
 * would not exist.
 *
 * `ics_tokens` is not in any migration yet, which is exactly why the answer is an invariant rather
 * than a fix: there is nothing to repair, and the trap is set for any future table keyed on a
 * user, of which Plan 5 adds several.
 *
 * WHAT IT ASSERTS, read from the LIVE SCHEMA (`PRAGMA foreign_key_list` / `table_info` on a
 * freshly migrated database) rather than from the migration text, so it holds no matter which
 * `.sql` file — or `ensureIngestionSchema` call — declares the table:
 *   1. every column that REFERENCES `users` does so `ON DELETE CASCADE`, never `SET NULL`,
 *      `RESTRICT` or `NO ACTION`;
 *   2. every column that IDENTIFIES a user by name — `user_id`, `*_user_id`, `*_by` — has such a
 *      foreign key, or is named in `OUTLIVES_THE_USER` below with a written reason;
 *   3. the cascade actually FIRES, proven by deleting a user and watching the row go, because
 *      SQLite enforces none of this unless `PRAGMA foreign_keys` is ON — the DDL can be perfect
 *      and the deletion still leave orphans if that pragma is ever dropped from `openDatabase`.
 *
 * Guarded the way this repo's other invariants are (`sources/registry.test.ts`,
 * `normalize/rawFieldsContract.test.ts`, `test/vitestCoverageContract.test.ts`,
 * `test/blocklistParity.test.ts`): the scan must be shown to still see the schema, every exemption
 * must name a column that exists and STILL lacks the cascade — so an exemption cannot outlive the
 * condition it excuses — and the classifier is exercised on names that are not in the schema yet,
 * `ics_tokens.user_id` among them.
 *
 * Proven by deliberate break on 2026-08-04, both ways: a scratch table with a bare `user_id`
 * turned rule 2 red naming `drift_probe.user_id`, and the same column with
 * `REFERENCES users(id) ON DELETE SET NULL` turned rule 1 red naming the action. Reverted after,
 * and the schema confirmed byte-identical.
 */

const db = openTestDb();
afterAll(() => {
  db.close();
});

/**
 * Columns that name a user and are DELIBERATELY not cascaded, with the reason each one outlives
 * the account. An entry here is a signed statement that a removed user's data staying behind is
 * the intended behaviour; the guards at the bottom refuse an entry that names a column which does
 * not exist, or one that has since gained the cascade.
 *
 * All four are the same shape — a RECORD OF SOMETHING THAT HAPPENED, which an account deletion is
 * not entitled to rewrite. None of them is a credential, a subscription or a key: nothing here
 * keeps working on a deleted user's behalf, which is the distinction that matters and the one
 * `ics_tokens` would fall on the wrong side of.
 */
const OUTLIVES_THE_USER: ReadonlyMap<string, string> = new Map([
  [
    'audit_log.actor_user_id',
    'The trail of what an account did — including the record of its own deletion, written inside ' +
      'the same transaction as the DELETE. Cascading it would mean an admin could erase the ' +
      'evidence of an action by deleting the actor, which is the one thing an audit log exists ' +
      'to prevent. adminUsersRouter.ts says so in prose; this entry is the enforcement.',
  ],
  [
    'verify_attempts.user_id',
    'A politeness ledger about traffic WE sent to somebody else\'s server, per migration ' +
      '036-verify-attempts.sql: "it must not be erased by an account deletion cascade while the ' +
      'request it describes is still fresh in the window". Cascading it would let a delete-and- ' +
      'recreate cycle reset the rate limit aimed at a small volunteer-run funder site.',
  ],
  [
    'review_items.decided_by',
    'Provenance of a MODERATION decision (inboxRouter writes `user.id` here). The published or ' +
      'rejected record outlives the reviewer\'s account, and a null decider would make an ' +
      'approved change look machine-made. Not a key or a subscription: nothing acts on it.',
  ],
  [
    'review_rejects.decided_by',
    'The reject memory that stops a rejected candidate coming back every crawl. It is keyed by ' +
      'the candidate, not the person; losing the decider would either resurrect the rejection or ' +
      'silently drop it, and the row does nothing on the departed reviewer\'s behalf.',
  ],
]);

/**
 * Names that identify a user.
 *
 * Wider than `user_id` on purpose. `review_items.decided_by` holds `user.id` and would have been
 * invisible to a `user_id`-only rule, and a future `owner_id`/`member_id` is exactly the sort of
 * name a new table reaches for. `user_agent` must NOT match — a rule that flags it teaches people
 * to widen the allow-list, and an allow-list people are comfortable widening is not a guard.
 */
export function namesAUser(column: string): boolean {
  return /^(?:user|owner|account|member|actor)_id$|(?:^|_)user_id$|_by$/.test(column);
}

interface ForeignKey {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly onDelete: string;
}

function tableNames(): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnsOf(table: string): string[] {
  return (db.pragma(`table_info("${table}")`) as Array<{ name: string }>).map((c) => c.name);
}

function foreignKeysOf(table: string): ForeignKey[] {
  return (
    db.pragma(`foreign_key_list("${table}")`) as Array<{
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
    }>
  ).map((fk) => ({ table: fk.table, from: fk.from, to: fk.to ?? 'id', onDelete: fk.on_delete }));
}

const TABLES = tableNames().filter((t) => t !== 'schema_migrations');

/** Every `table.column` in the live schema that declares a foreign key into `users`. */
const REFERENCES_USERS = TABLES.flatMap((table) =>
  foreignKeysOf(table)
    .filter((fk) => fk.table === 'users')
    .map((fk) => ({ table, column: fk.from, to: fk.to, onDelete: fk.onDelete.toUpperCase() })),
);

/** Every `table.column` whose NAME identifies a user, whether or not it declares a key. */
const LOOKS_LIKE_A_USER_COLUMN = TABLES.filter((t) => t !== 'users').flatMap((table) =>
  columnsOf(table)
    .filter(namesAUser)
    .map((column) => ({ table, column, key: `${table}.${column}` })),
);

const CASCADING = new Set(
  REFERENCES_USERS.filter((r) => r.onDelete === 'CASCADE').map((r) => `${r.table}.${r.column}`),
);

describe('deleting a user takes everything that belongs to them', () => {
  it('cascades every foreign key into users, so none is left to SET NULL or RESTRICT', () => {
    const wrong = REFERENCES_USERS.filter((r) => r.onDelete !== 'CASCADE').map(
      (r) => `${r.table}.${r.column} → users(${r.to}) ON DELETE ${r.onDelete || 'NO ACTION'}`,
    );
    expect(
      wrong,
      wrong.length === 0
        ? ''
        : 'These columns reference users(id) WITHOUT ON DELETE CASCADE:\n  ' +
          `${wrong.join('\n  ')}\n` +
          'adminUsersRouter.ts deletes an account with a single DELETE and relies on the cascade ' +
          'to take the rest. Anything else leaves a row behind that still names a user who is ' +
          'gone: SET NULL turns it into an anonymous orphan the delete route has already counted ' +
          'as removed, and RESTRICT/NO ACTION makes the deletion fail with a raw SQLite error ' +
          'the route does not handle. Add ON DELETE CASCADE, or — if the row is MEANT to outlive ' +
          'the account — drop the key and add the column to OUTLIVES_THE_USER with a reason.',
    ).toEqual([]);
  });

  it('gives every user-identifying column either a cascade or a written exemption', () => {
    const unguarded = LOOKS_LIKE_A_USER_COLUMN.filter(
      (c) => !CASCADING.has(c.key) && !OUTLIVES_THE_USER.has(c.key),
    ).map((c) => c.key);
    expect(
      unguarded,
      unguarded.length === 0
        ? ''
        : 'These columns name a user and have no ON DELETE CASCADE into users(id):\n  ' +
          `${unguarded.join('\n  ')}\n` +
          'A deleted account keeps whatever these rows grant. If the row is a key, a token, a ' +
          "subscription or a preference, it must cascade — an ICS feed row without a foreign " +
          "key keeps serving the organisation's data to a removed member forever, while the " +
          'delete route reports the account gone. If the row is a RECORD OF SOMETHING THAT ' +
          'HAPPENED and is meant to survive, add it to OUTLIVES_THE_USER with the reason. What ' +
          'is not allowed is leaving it undecided, which is what every one of these is today.',
    ).toEqual([]);
  });

  it('actually deletes the dependent rows, because the DDL alone enforces nothing', () => {
    // PRAGMA foreign_keys is per-connection and defaults to OFF. Every cascade above is inert if
    // `openDatabase` ever stops setting it, and no schema assertion would notice.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    const id = 'u-cascade-probe';
    db.prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
       VALUES (?, ?, ?, 'x', 'member', ?, '2026-08-04T00:00:00.000Z')`,
    ).run(id, 'probe@example.test', 'probe@example.test', 'ics-cascade-probe');
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
       VALUES ('s-cascade-probe', ?, '2026-08-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z',
               '2026-08-04T00:00:00.000Z')`,
    ).run(id);
    db.prepare(
      `INSERT INTO audit_log (at, actor_user_id, action, entity_type, entity_id)
       VALUES ('2026-08-04T00:00:00.000Z', ?, 'user.delete', 'user', ?)`,
    ).run(id, id);

    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(id),
      'the session outlived its user — the cascade did not fire, whatever the DDL says',
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE actor_user_id = ?').get(id),
      'the audit trail was cascaded away with the account it describes',
    ).toEqual({ n: 1 });

    db.prepare('DELETE FROM audit_log WHERE actor_user_id = ?').run(id);
  });
});

describe('deleting a user — the invariant can still see', () => {
  it('reads a real schema with a users table in it', () => {
    expect(TABLES).toContain('users');
    expect(TABLES.length).toBeGreaterThan(15);
    expect(columnsOf('users')).toContain('id');
  });

  it('finds the four cascades adminUsersRouter.ts names, plus the ones added since', () => {
    // The router's comment, turned into an assertion. `removed` is computed from exactly these
    // four, so a cascade lost here makes the count the route reports a lie.
    for (const key of [
      'sessions.user_id',
      'profiles.user_id',
      'watches.user_id',
      'applications.user_id',
    ]) {
      expect(CASCADING, `${key} lost its cascade`).toContain(key);
    }
    expect(CASCADING.size).toBeGreaterThanOrEqual(7);
  });

  it('classifies the names it will meet, including the one Plan 5 is bringing', () => {
    for (const name of [
      'user_id',
      'actor_user_id',
      'owner_id',
      'member_id',
      'account_id',
      'decided_by',
      'created_by',
    ]) {
      expect(namesAUser(name), `${name} names a user`).toBe(true);
    }
    for (const name of ['user_agent', 'program_id', 'id', 'funder_id', 'created_at', 'username']) {
      expect(namesAUser(name), `${name} does not name a user`).toBe(false);
    }
  });

  it('would have caught the ics_tokens shape before it was written', () => {
    // Plan 5's planned table, played through the classifier: a `user_id` with no foreign key is
    // not in CASCADING and is not in OUTLIVES_THE_USER, so rule 2 reports it. This is the whole
    // reason the file exists, pinned so that a later narrowing of `namesAUser` cannot quietly
    // stop it applying.
    expect(namesAUser('user_id')).toBe(true);
    expect(CASCADING.has('ics_tokens.user_id')).toBe(false);
    expect(OUTLIVES_THE_USER.has('ics_tokens.user_id')).toBe(false);
  });

  it('sees every user-identifying column the schema has today', () => {
    // A scan that stopped reading `table_info` would report an empty set and pass rule 2 vacuously.
    // CONTAINMENT, not equality: a new user-keyed table must turn rule 2 red on its own merits,
    // not produce a second red here that a maintainer clears by editing a list. Every name below
    // must still be found, so a column vanishing is still caught.
    const seen = LOOKS_LIKE_A_USER_COLUMN.map((c) => c.key).sort();
    expect(seen).toEqual(expect.arrayContaining([
      'applications.user_id',
      'audit_log.actor_user_id',
      'notification_channel_health.user_id',
      'notification_channels.user_id',
      'notifications.user_id',
      'profiles.user_id',
      'review_items.decided_by',
      'review_rejects.decided_by',
      'sessions.user_id',
      'verify_attempts.user_id',
      'watches.user_id',
    ]));
    expect(seen.length).toBeGreaterThanOrEqual(11);
  });
});

describe('deleting a user — no exemption may be vacuous', () => {
  it('names only columns that exist in the live schema', () => {
    const missing = [...OUTLIVES_THE_USER.keys()].filter((key) => {
      const [table, column] = key.split('.');
      return !TABLES.includes(table) || !columnsOf(table).includes(column);
    });
    expect(
      missing,
      'listed in OUTLIVES_THE_USER but gone from the schema — delete the entry; a stale ' +
        'exemption is indistinguishable from a guard, and hides the next real one',
    ).toEqual([]);
  });

  it('names only columns that still lack the cascade', () => {
    const nowCascading = [...OUTLIVES_THE_USER.keys()].filter((key) => CASCADING.has(key));
    expect(
      nowCascading,
      'these columns gained ON DELETE CASCADE, so the written reason for exempting them is no ' +
        'longer true — delete the entry rather than leaving a signed statement that contradicts ' +
        'the schema',
    ).toEqual([]);
  });

  it('gives every exemption a real written reason', () => {
    for (const [key, reason] of OUTLIVES_THE_USER) {
      expect(reason.trim().length, `${key} needs a reason, not a placeholder`).toBeGreaterThan(60);
    }
  });
});
