import { funderSchema } from '@grantspotter/core';
import type { Funder } from '@grantspotter/core';
import type { Db } from '../migrate.js';

export interface FunderRepo {
  upsert(funder: Funder): void;
  get(id: string): Funder | undefined;
  list(): Funder[];
  remove(id: string): void;
  count(): number;
}

interface FunderRow {
  id: string;
  name: string;
  homepage: string;
  ein: string | null;
  note: string | null;
}

function toFunder(row: FunderRow): Funder {
  const funder: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    homepage: row.homepage,
  };
  if (row.ein !== null) funder.ein = row.ein;
  if (row.note !== null) funder.note = row.note;
  return funderSchema.parse(funder);
}

export function createFunderRepo(db: Db): FunderRepo {
  const upsertStmt = db.prepare(
    `INSERT INTO funders (id, name, homepage, ein, note, created_at, updated_at)
     VALUES (@id, @name, @homepage, @ein, @note, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, homepage = excluded.homepage,
       ein = excluded.ein, note = excluded.note, updated_at = excluded.updated_at`,
  );
  const getStmt = db.prepare('SELECT id, name, homepage, ein, note FROM funders WHERE id = ?');
  // Ascending by name: A-Z browse order, same convention as programs.list().
  const listStmt = db.prepare('SELECT id, name, homepage, ein, note FROM funders ORDER BY name');
  const removeStmt = db.prepare('DELETE FROM funders WHERE id = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM funders');

  return {
    upsert(funder) {
      upsertStmt.run({
        id: funder.id,
        name: funder.name,
        homepage: funder.homepage,
        ein: funder.ein ?? null,
        note: funder.note ?? null,
        now: new Date().toISOString(),
      });
    },
    get(id) {
      const row = getStmt.get(id) as FunderRow | undefined;
      return row === undefined ? undefined : toFunder(row);
    },
    list() {
      return (listStmt.all() as FunderRow[]).map(toFunder);
    },
    remove(id) {
      removeStmt.run(id);
    },
    count() {
      return (countStmt.get() as { n: number }).n;
    },
  };
}
