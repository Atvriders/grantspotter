import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/migrate.js';

export interface BootstrapState {
  /** True while no account exists. Recomputed from the database on each call. */
  required(): boolean;
  /** The one-time token, or null once an account exists. */
  token(): string | null;
  /** Timing-safe comparison; clears the token on success. */
  consume(candidate: string): boolean;
}

function banner(token: string): string {
  return [
    '============================================================',
    ' GrantSpotter first-run setup',
    '',
    ' No accounts exist yet. Create the first administrator by',
    ' POSTing to /api/auth/bootstrap with this one-time token:',
    '',
    `     ${token}`,
    '',
    ' { "token": "...", "email": "...", "password": "..." }',
    '',
    ' A fresh token is printed on every restart until an admin',
    ' account exists. There is no public signup.',
    '============================================================',
  ].join('\n');
}

export function createBootstrapState(
  db: Db,
  log: (line: string) => void = (line) => console.log(line),
): BootstrapState {
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM users');
  const userCount = (): number => (countStmt.get() as { n: number }).n;

  let token: string | null = null;
  if (userCount() === 0) {
    token = randomBytes(24).toString('hex');
    log(banner(token));
  }

  return {
    required() {
      return userCount() === 0;
    },
    token() {
      return userCount() === 0 ? token : null;
    },
    consume(candidate) {
      if (token === null || userCount() > 0) return false;
      const a = Buffer.from(candidate);
      const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      token = null;
      return true;
    },
  };
}
