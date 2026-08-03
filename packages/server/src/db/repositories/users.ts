import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../migrate.js';

export type Role = 'admin' | 'member';

export interface UserRecord {
  id: string;
  email: string;
  emailNormalized: string;
  passwordHash: string;
  role: Role;
  displayName: string;
  icsToken: string;
  disabled: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

/** What the API is allowed to serialise. Never the hash, never the ICS token. */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: string;
  lastLoginAt?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toPublicUser(user: UserRecord): PublicUser {
  const publicUser: PublicUser = {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
  };
  if (user.lastLoginAt !== undefined) publicUser.lastLoginAt = user.lastLoginAt;
  return publicUser;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  role: Role;
  displayName?: string;
}

export interface UserRepo {
  create(input: CreateUserInput): UserRecord;
  findById(id: string): UserRecord | undefined;
  findByEmail(email: string): UserRecord | undefined;
  findByIcsToken(token: string): UserRecord | undefined;
  list(): UserRecord[];
  count(): number;
  recordLogin(id: string, atISO: string): void;
  setRole(id: string, role: Role): void;
  setDisabled(id: string, disabled: boolean): void;
}

interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  password_hash: string;
  role: Role;
  display_name: string;
  ics_token: string;
  disabled: number;
  created_at: string;
  last_login_at: string | null;
}

function toUser(row: UserRow): UserRecord {
  const user: UserRecord = {
    id: row.id,
    email: row.email,
    emailNormalized: row.email_normalized,
    passwordHash: row.password_hash,
    role: row.role,
    displayName: row.display_name,
    icsToken: row.ics_token,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
  if (row.last_login_at !== null) user.lastLoginAt = row.last_login_at;
  return user;
}

const COLUMNS =
  'id, email, email_normalized, password_hash, role, display_name, ics_token, disabled, created_at, last_login_at';

export function createUserRepo(db: Db): UserRepo {
  const insertStmt = db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, role, display_name, ics_token, created_at)
     VALUES (@id, @email, @email_normalized, @password_hash, @role, @display_name, @ics_token, @created_at)`,
  );
  const byIdStmt = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`);
  const byEmailStmt = db.prepare(`SELECT ${COLUMNS} FROM users WHERE email_normalized = ?`);
  const byIcsStmt = db.prepare(`SELECT ${COLUMNS} FROM users WHERE ics_token = ?`);
  const listStmt = db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY created_at, email_normalized`);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM users');
  const loginStmt = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');
  const roleStmt = db.prepare('UPDATE users SET role = ? WHERE id = ?');
  const disabledStmt = db.prepare('UPDATE users SET disabled = ? WHERE id = ?');

  return {
    create(input) {
      const row = {
        id: randomUUID(),
        email: input.email.trim(),
        email_normalized: normalizeEmail(input.email),
        password_hash: input.passwordHash,
        role: input.role,
        display_name: input.displayName ?? '',
        ics_token: randomBytes(24).toString('base64url'),
        created_at: new Date().toISOString(),
      };
      insertStmt.run(row);
      return toUser({ ...row, disabled: 0, last_login_at: null });
    },
    findById(id) {
      const row = byIdStmt.get(id) as UserRow | undefined;
      return row === undefined ? undefined : toUser(row);
    },
    findByEmail(email) {
      const row = byEmailStmt.get(normalizeEmail(email)) as UserRow | undefined;
      return row === undefined ? undefined : toUser(row);
    },
    findByIcsToken(token) {
      const row = byIcsStmt.get(token) as UserRow | undefined;
      return row === undefined ? undefined : toUser(row);
    },
    list() {
      return (listStmt.all() as UserRow[]).map(toUser);
    },
    count() {
      return (countStmt.get() as { n: number }).n;
    },
    recordLogin(id, atISO) {
      loginStmt.run(atISO, id);
    },
    setRole(id, role) {
      roleStmt.run(role, id);
    },
    setDisabled(id, disabled) {
      disabledStmt.run(disabled ? 1 : 0, id);
    },
  };
}
