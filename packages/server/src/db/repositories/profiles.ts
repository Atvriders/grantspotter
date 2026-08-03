import { randomUUID } from 'node:crypto';
import { profileSchema } from '@grantspotter/core';
import type { Profile } from '@grantspotter/core';
import type { Db } from '../migrate.js';

export type ProfileKind = Profile['kind'];

export interface ProfileRepo {
  upsert(userId: string, profile: Profile): void;
  get(userId: string, kind: ProfileKind): Profile | undefined;
  listForUser(userId: string): Profile[];
  remove(userId: string, kind: ProfileKind): void;
}

export function createProfileRepo(db: Db): ProfileRepo {
  const upsertStmt = db.prepare(
    `INSERT INTO profiles (id, user_id, kind, data, updated_at)
     VALUES (@id, @user_id, @kind, @data, @updated_at)
     ON CONFLICT(user_id, kind) DO UPDATE SET
       data = excluded.data, updated_at = excluded.updated_at`,
  );
  const getStmt = db.prepare('SELECT data FROM profiles WHERE user_id = ? AND kind = ?');
  const listStmt = db.prepare('SELECT data FROM profiles WHERE user_id = ? ORDER BY kind');
  const removeStmt = db.prepare('DELETE FROM profiles WHERE user_id = ? AND kind = ?');

  return {
    upsert(userId, profile) {
      upsertStmt.run({
        id: randomUUID(),
        user_id: userId,
        kind: profile.kind,
        data: JSON.stringify(profile),
        updated_at: new Date().toISOString(),
      });
    },
    get(userId, kind) {
      const row = getStmt.get(userId, kind) as { data: string } | undefined;
      if (row === undefined) return undefined;
      // CONTRACT §6: JSON columns are validated on read.
      return profileSchema.parse(JSON.parse(row.data));
    },
    listForUser(userId) {
      return (listStmt.all(userId) as Array<{ data: string }>).map((row) =>
        profileSchema.parse(JSON.parse(row.data)),
      );
    },
    remove(userId, kind) {
      removeStmt.run(userId, kind);
    },
  };
}
