import type { Db } from '../migrate.js';

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string;
}

export interface CreateSessionInput {
  /** sha256 of the raw session id — the raw value never touches the database. */
  id: string;
  userId: string;
  expiresAt: string;
  userAgent?: string;
  nowISO?: string;
}

export interface SessionRepo {
  create(input: CreateSessionInput): SessionRecord;
  find(id: string): SessionRecord | undefined;
  touch(id: string, atISO: string): void;
  remove(id: string): void;
  removeAllForUser(userId: string): void;
  removeExpired(nowISO: string): number;
  count(): number;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string;
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
  };
}

const COLUMNS = 'id, user_id, created_at, expires_at, last_seen_at, user_agent';

export function createSessionRepo(db: Db): SessionRepo {
  const insertStmt = db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)
     VALUES (@id, @user_id, @created_at, @expires_at, @last_seen_at, @user_agent)`,
  );
  const findStmt = db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`);
  const touchStmt = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
  const removeStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  const removeUserStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const removeExpiredStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM sessions');

  return {
    create(input) {
      const now = input.nowISO ?? new Date().toISOString();
      const row: SessionRow = {
        id: input.id,
        user_id: input.userId,
        created_at: now,
        expires_at: input.expiresAt,
        last_seen_at: now,
        user_agent: input.userAgent ?? '',
      };
      insertStmt.run(row);
      return toSession(row);
    },
    find(id) {
      const row = findStmt.get(id) as SessionRow | undefined;
      return row === undefined ? undefined : toSession(row);
    },
    touch(id, atISO) {
      touchStmt.run(atISO, id);
    },
    remove(id) {
      removeStmt.run(id);
    },
    removeAllForUser(userId) {
      removeUserStmt.run(userId);
    },
    removeExpired(nowISO) {
      return removeExpiredStmt.run(nowISO).changes;
    },
    count() {
      return (countStmt.get() as { n: number }).n;
    },
  };
}
