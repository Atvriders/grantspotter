import { cycleSchema } from '@grantspotter/core';
import type { Cycle } from '@grantspotter/core';
import type { Db } from '../migrate.js';

export interface CycleRepo {
  upsertMany(cycles: Cycle[]): void;
  listForProgram(programId: string): Cycle[];
  listClosingBetween(fromISO: string, toISO: string): Cycle[];
  removeEstimatedForProgram(programId: string): void;
  count(): number;
}

interface CycleRow {
  id: string;
  program_id: string;
  opens_at: string | null;
  closes_at: string | null;
  timezone: string;
  label: string;
  is_estimated: number;
}

function toCycle(row: CycleRow): Cycle {
  const draft: Record<string, unknown> = {
    id: row.id,
    programId: row.program_id,
    timezone: row.timezone,
    label: row.label,
    isEstimated: row.is_estimated === 1,
  };
  if (row.opens_at !== null) draft.opensAt = row.opens_at;
  if (row.closes_at !== null) draft.closesAt = row.closes_at;
  return cycleSchema.parse(draft);
}

const COLUMNS = 'id, program_id, opens_at, closes_at, timezone, label, is_estimated';

export function createCycleRepo(db: Db): CycleRepo {
  const upsertStmt = db.prepare(
    `INSERT INTO cycles (id, program_id, opens_at, closes_at, timezone, label, is_estimated)
     VALUES (@id, @program_id, @opens_at, @closes_at, @timezone, @label, @is_estimated)
     ON CONFLICT(id) DO UPDATE SET
       program_id = excluded.program_id, opens_at = excluded.opens_at,
       closes_at = excluded.closes_at, timezone = excluded.timezone,
       label = excluded.label, is_estimated = excluded.is_estimated`,
  );
  const listForProgramStmt = db.prepare(
    `SELECT ${COLUMNS} FROM cycles WHERE program_id = ? ORDER BY closes_at, id`,
  );
  const listBetweenStmt = db.prepare(
    `SELECT ${COLUMNS} FROM cycles WHERE closes_at IS NOT NULL AND closes_at >= ? AND closes_at <= ?
     ORDER BY closes_at, id`,
  );
  const removeEstimatedStmt = db.prepare(
    'DELETE FROM cycles WHERE program_id = ? AND is_estimated = 1',
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM cycles');

  return {
    upsertMany(cycles) {
      db.transaction(() => {
        for (const cycle of cycles) {
          upsertStmt.run({
            id: cycle.id,
            program_id: cycle.programId,
            opens_at: cycle.opensAt ?? null,
            closes_at: cycle.closesAt ?? null,
            timezone: cycle.timezone,
            label: cycle.label,
            is_estimated: cycle.isEstimated ? 1 : 0,
          });
        }
      })();
    },
    listForProgram(programId) {
      return (listForProgramStmt.all(programId) as CycleRow[]).map(toCycle);
    },
    listClosingBetween(fromISO, toISO) {
      return (listBetweenStmt.all(fromISO, toISO) as CycleRow[]).map(toCycle);
    },
    removeEstimatedForProgram(programId) {
      removeEstimatedStmt.run(programId);
    },
    count() {
      return (countStmt.get() as { n: number }).n;
    },
  };
}
