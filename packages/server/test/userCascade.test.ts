import { afterAll, describe, expect, it } from 'vitest';
import { openTestDb } from '../src/test/testDb.js';

/**
 * THE DELETED-USER-LEAVES-A-DOOR-OPEN INVARIANT.
 *
 * `adminUsersRouter.ts` deletes an account with one statement and lets SQLite do the rest:
 *
 *   // Every `REFERENCES users(id)` LEFT in the schema is ON DELETE CASCADE
 *   // (sessions, profiles, watches, applications — 001-init.sql) …
 *
 * (The word "left" is migration 094's: `enrollment_codes` no longer declares one, and the last
 * block in this file is what makes that safe rather than a hole. Everything below is unchanged.)
 *
 * That comment is TRUE TODAY. It is also a claim about every table this schema will ever grow,
 * written where nothing can check it — and this is the third time in this project a correct
 * observation about the present has been leaned on as a guarantee about the future (the others
 * being a migration index that was already redundant, and a source module whose note promised it
 * "refuses to publish" while nothing read the tag it set).
 *
 * THE CONCRETE THING COMING — WHICH CAME, AND WAS CAUGHT (updated 2026-08-04, Plan 5 Task 9).
 *
 * This file was written while `ics_tokens` existed only in a plan. Its planned shape carried a
 * `user_id` with NO foreign key, and the brief said so in as many words ("No FOREIGN KEY on
 * user_id: that would couple this migration to the exact column type Plan 1 chose for users.id.
 * Rows are cleaned up by the delete route."). Had that shipped, deleting a user would have stopped
 * revoking their calendar feed: the delete route would still report the account gone, `removed`
 * would still count profiles and watches and sessions, and a removed member's ICS subscription
 * would keep serving the organisation's programme data to whoever held the URL — indefinitely,
 * because nothing else in the system ever revisits that row. Nothing would fail. Nobody would be
 * told. Task 13's report already states "the ICS token dies with the row", and that statement
 * rested entirely on a cascade that did not exist.
 *
 * `090-ics-tokens.sql` shipped WITH the cascade, citing this file. So the assertions below now say
 * the opposite of what they said when they were written — `ics_tokens.user_id` is expected to be
 * in `CASCADING` — and that is the invariant working, not the invariant being weakened: the
 * classifier, the exemption guards and the fires-for-real probe are unchanged, and the trap
 * remains set for the next table keyed on a user.
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
 * condition it excuses — and the classifier is exercised on names it will meet later as well as
 * on the ones already in the schema.
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
 * All five are the same shape — a RECORD OF SOMETHING THAT HAPPENED, which an account deletion is
 * not entitled to rewrite — and nothing here keeps working on a deleted user's behalf, which is the
 * distinction that matters and the one `ics_tokens` would fall on the wrong side of.
 *
 * THE FIFTH USED TO BE THE ONLY ONE WHOSE ROW COULD. `enrollment_codes` held a live account-minting
 * credential, and it qualified for this list only because migration 094 made an account deletion
 * WITHDRAW those codes instead of erasing them — a trigger, kept in the schema so it could not be
 * routed around. Enrolment codes are retired (migration 095) and that trigger is dropped with them,
 * so the fifth entry is now the same shape as the other four: a record nothing acts on. The last
 * block in this file has moved with it, from proving the credential dies to proving the record does
 * not.
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
  [
    'enrollment_codes.created_by_user_id',
    'WHO ISSUED A CODE, which is a record of a past act and not a capability — the entry that had ' +
      'to EARN its place, because an enrollment code was once the one thing on this list that ' +
      'could keep working on a deleted account\'s behalf. It cannot now, and the reason is no ' +
      'longer a mechanism: enrolment codes are retired (migration 095), there is no route that ' +
      'redeems one, and the table is a closed record. What survives an account deletion is a ' +
      'club\'s intake history — the label, the use count, the expiry, and the subject of every ' +
      'user.enroll audit row that names the code an account came from. Cascading it back would ' +
      'erase that on a personnel change, which is what migration 091 did and what 094 was written ' +
      'to stop. The probes in the last block are what hold all of it; this reason may stand only ' +
      'while they pass.',
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

  it('caught the ics_tokens shape, and the table arrived with the cascade', () => {
    // WHAT THIS ASSERTED BEFORE 2026-08-04, and why it is inverted now. While `ics_tokens` was
    // only a plan, this played its PLANNED shape through the classifier and pinned the outcome:
    // a bare `user_id` is in neither CASCADING nor OUTLIVES_THE_USER, so rule 2 above would report
    // it. Plan 5 Task 9's `090-ics-tokens.sql` then shipped the table WITH
    // `REFERENCES users(id) ON DELETE CASCADE`, against its own brief, citing this file.
    //
    // So the expectation flips from `false` to `true` — and the flip is the point. The classifier
    // check is untouched, so a later narrowing of `namesAUser` still cannot quietly stop rule 2
    // applying to this column; the exemption check is untouched, so nobody may retire the cascade
    // by writing a reason instead; and the row-level probe below proves the DDL is not merely
    // decorative. Turning this back into `false` means the token table lost its foreign key.
    expect(namesAUser('user_id')).toBe(true);
    expect(TABLES).toContain('ics_tokens');
    expect(
      CASCADING.has('ics_tokens.user_id'),
      "ics_tokens.user_id lost ON DELETE CASCADE — a removed member's calendar feed now keeps " +
        "serving the organisation's programme data to whoever holds the URL, forever, while the " +
        'admin console reports the account gone',
    ).toBe(true);
    expect(OUTLIVES_THE_USER.has('ics_tokens.user_id')).toBe(false);
  });

  it('actually revokes a deleted user’s calendar feed, at the row', () => {
    // The DDL enforces nothing without `PRAGMA foreign_keys`, and this is the one cascade whose
    // failure hands out data rather than leaving litter — so it is proven by deletion, not by
    // reading `foreign_key_list`.
    const id = 'u-ics-cascade-probe';
    db.prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
       VALUES (?, ?, ?, 'x', 'member', ?, '2026-08-04T00:00:00.000Z')`,
    ).run(id, 'feed@example.test', 'feed@example.test', 'ics-feed-cascade-probe');
    db.prepare(
      `INSERT INTO ics_tokens (user_id, token_hash, created_at)
       VALUES (?, 'a-sha256-digest-stands-in-here', '2026-08-04T00:00:00.000Z')`,
    ).run(id);

    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM ics_tokens WHERE user_id = ?').get(id),
      'the calendar token outlived its user — the feed is still being served',
    ).toEqual({ n: 0 });
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
      'ics_tokens.user_id',
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

/**
 * THE ONE EXEMPTION THAT HAD TO EARN ITS PLACE, AND THE ASSERTION THAT REVERSED WHEN THE FEATURE
 * WENT.
 *
 * WHAT THIS BLOCK USED TO PROVE. Every other entry in `OUTLIVES_THE_USER` is a record nothing acts
 * on. An enrollment code was a live credential that minted accounts — the exact shape rule 2 above
 * calls "a key, a token, a subscription" and refuses to let anybody write a reason for. It was
 * exempt anyway, because migration 094 separated the two jobs 091's single cascade was doing: the
 * POLICY (an account's removal must leave no live credential behind) was kept by a trigger that
 * REVOKED, and the HOUSEKEEPING turned out to be the wrong thing to want from a column recording
 * who did something. So the middle test here asserted that deleting an issuer stamped `revoked_at`
 * on their open codes.
 *
 * THAT ASSERTION IS NOW WRONG, AND IT IS WRONG BECAUSE THE DESIGN CHANGED RATHER THAN BECAUSE IT
 * WAS FAILING. Enrolment codes are retired: no screen issues one, no route redeems one, and
 * `migrations/095-enrollment-codes-are-a-closed-record.sql` drops the trigger. The policy it kept
 * is now kept by something stronger — the absence of any mechanism that could spend a code — and
 * leaving the trigger in place would have made it the ONLY writer to this table, stamping "an
 * administrator withdrew this" on historical rows nobody withdrew, on the wall clock, with no audit
 * row, because the audited half of 094's design lived in `adminUsersRouter.ts` and went with the
 * repository module it called. 094 said of its own trigger that "revoking a corpse buys nothing and
 * costs the reason it died"; every row here is a corpse now.
 *
 * SO THE PROBE IS INVERTED, NOT DELETED, and what it holds is strictly easier to state and harder
 * to lose: deleting an issuer must leave the row COMPLETELY UNTOUCHED. That is the same rule this
 * suite already applies to `audit_log` — a record of something that happened is not something an
 * account deletion may rewrite — and it now applies to this table without an exception. The third
 * test is unchanged: a row attributed to nobody was already out of reach of a deletion, and it
 * still is.
 */
describe('deleting a user leaves the closed enrolment record exactly as it was', () => {
  const AT = '2026-08-11T00:00:00.000Z';
  /** Far future, so "would once have been open" is answered by the calendar and not by luck. */
  const FAR = '2099-01-01T00:00:00.000Z';

  function insertCode(id: string, issuer: string | null, uses: number): void {
    db.prepare(
      `INSERT INTO enrollment_codes
         (id, code_hash, label, max_uses, uses, expires_at, revoked_at, created_at,
          created_by_user_id, last_used_at, chosen, hash_scheme)
       VALUES (?, ?, ?, 30, ?, ?, NULL, ?, ?, NULL, 1, 'hmac-sha256')`,
    ).run(id, `digest-${id}`, `label-${id}`, uses, FAR, AT, issuer);
  }

  function codeRow(id: string): { uses: number; expires_at: string; revoked_at: string | null } {
    return db
      .prepare('SELECT uses, expires_at, revoked_at FROM enrollment_codes WHERE id = ?')
      .get(id) as { uses: number; expires_at: string; revoked_at: string | null };
  }

  it('really has lost the foreign key, and really does allow a code with no issuer', () => {
    // Read from the live schema, because 091's DDL text still declares the key this asserts is
    // gone — that file is the record of what the table WAS and says so in its own header.
    expect(foreignKeysOf('enrollment_codes')).toEqual([]);
    const column = (
      db.pragma('table_info("enrollment_codes")') as Array<{ name: string; notnull: number }>
    ).find((c) => c.name === 'created_by_user_id');
    expect(column, 'the column the exemption is written about is gone').toBeDefined();
    expect(column?.notnull, 'NOT NULL is back, so a code must name a person again').toBe(0);
  });

  /**
   * READ FROM `sqlite_master` RATHER THAN FROM THE MIGRATION TEXT, for the reason the rest of this
   * file gives: what a database HAS is the claim, and a `DROP TRIGGER` in a file proves nothing
   * about a database that ran it before the drop was written.
   */
  it('no longer carries 094’s revoke-on-delete trigger', () => {
    const triggers = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(
      triggers,
      'the revoke-on-delete trigger is back. It is the only thing that writes to enrollment_codes, ' +
        'it writes on the wall clock with no audit row, and there is no credential left for it to ' +
        'withdraw — see migration 095.',
    ).not.toContain('revoke_enrollment_codes_when_issuer_deleted');
  });

  it('keeps the whole record, including the codes that were still open', () => {
    const id = 'u-code-issuer-probe';
    db.prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
       VALUES (?, ?, ?, 'x', 'admin', ?, ?)`,
    ).run(id, 'issuer@example.test', 'issuer@example.test', 'ics-issuer-probe', AT);
    insertCode('c-issued-by-probe', id, 29);

    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    const after = codeRow('c-issued-by-probe');
    expect(after, 'the code was cascaded away with its issuer').toBeDefined();
    // NOT revoked, which is the reversal. Nothing can redeem this row, so stamping it would be
    // recording a withdrawal that never happened.
    expect(after.revoked_at).toBeNull();
    expect(after.uses).toBe(29);
    expect(after.expires_at).toBe(FAR);
    // The issuer is still named, which is the whole point of dropping the key: `user.enroll` audit
    // rows carry this code's id, and the trail needs its subject to still exist.
    expect(
      db
        .prepare('SELECT created_by_user_id AS u FROM enrollment_codes WHERE id = ?')
        .get('c-issued-by-probe'),
    ).toEqual({ u: id });

    db.prepare('DELETE FROM enrollment_codes WHERE id = ?').run('c-issued-by-probe');
  });

  it('does not touch the code the compose file set, because it names nobody', () => {
    const id = 'u-founder-probe';
    db.prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
       VALUES (?, ?, ?, 'x', 'admin', ?, ?)`,
    ).run(id, 'founder@example.test', 'founder@example.test', 'ics-founder-probe', AT);
    insertCode('c-from-the-file', null, 29);

    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    // Unchanged, as it was before this change and for a different reason: then because NULL never
    // matched the trigger's `created_by_user_id = OLD.id`, now because there is no trigger. Kept
    // because a row attributed to nobody is the one an operator is likeliest to still be looking
    // at — `ENROLLMENT_CODE` set it, and the compose file that did is still on their disk.
    expect(codeRow('c-from-the-file')).toEqual({ uses: 29, expires_at: FAR, revoked_at: null });

    db.prepare('DELETE FROM enrollment_codes WHERE id = ?').run('c-from-the-file');
  });
});
