import { constraintSchema } from '@grantspotter/core';
import type { Constraint } from '@grantspotter/core';
import type { Db } from '../migrate.js';

export interface ConstraintRepo {
  replaceForProgram(programId: string, constraints: Constraint[]): void;
  listForProgram(programId: string): Constraint[];
}

interface ConstraintRow {
  id: string;
  hard: number;
  fallback_rank: number;
  raw_text: string;
  spec: string;
}

export function createConstraintRepo(db: Db): ConstraintRepo {
  const deleteStmt = db.prepare('DELETE FROM constraints WHERE program_id = ?');
  const insertStmt = db.prepare(
    `INSERT INTO constraints (id, program_id, ordinal, hard, fallback_rank, raw_text, axis, spec)
     VALUES (@id, @program_id, @ordinal, @hard, @fallback_rank, @raw_text, @axis, @spec)`,
  );
  const listStmt = db.prepare(
    'SELECT id, hard, fallback_rank, raw_text, spec FROM constraints WHERE program_id = ? ORDER BY ordinal',
  );

  return {
    replaceForProgram(programId, constraints) {
      db.transaction(() => {
        deleteStmt.run(programId);
        constraints.forEach((constraint, ordinal) => {
          insertStmt.run({
            id: constraint.id,
            program_id: programId,
            ordinal,
            hard: constraint.hard ? 1 : 0,
            fallback_rank: constraint.fallbackRank,
            raw_text: constraint.rawText,
            axis: constraint.spec.axis,
            spec: JSON.stringify(constraint.spec),
          });
        });
      })();
    },
    listForProgram(programId) {
      return (listStmt.all(programId) as ConstraintRow[]).map((row) =>
        constraintSchema.parse({
          id: row.id,
          hard: row.hard === 1,
          fallbackRank: row.fallback_rank,
          rawText: row.raw_text,
          spec: JSON.parse(row.spec),
        }),
      );
    },
  };
}
