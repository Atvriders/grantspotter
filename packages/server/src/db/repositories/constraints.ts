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

/**
 * `constraints.id` is `TEXT PRIMARY KEY` — GLOBAL, across every program — but
 * `normalize/axes/preference.ts`'s `makeConstraint` derives an id from `${axis}-${index}-${hash
 * of axis|rawText}` alone, with no program-specific component. Two different scholarships that
 * happen to publish identical boilerplate for one axis (e.g. "Region: National", or the same
 * "must hold a Technician license or higher" sentence) legitimately produce the SAME `Constraint.
 * id`, and the real `arrl-scholarship-descriptions` fixture does this six ways among six records.
 * Approving a second such record used to throw `SQLITE_CONSTRAINT: UNIQUE constraint failed:
 * constraints.id` — a real crash on a real admin action, discovered while wiring the crawl runner
 * end-to-end (Task 25).
 *
 * The fix stays inside this file: rows are stored under a program-scoped key
 * (`${programId}::${constraint.id}`), which the schema's plain `TEXT PRIMARY KEY` accepts as-is —
 * no migration needed — while `listForProgram` strips the prefix back off before returning, so
 * every caller still sees exactly the `Constraint.id` `extractConstraints` produced. That matters
 * because `hashProgram` (packages/core/src/hash.ts) hashes `Constraint.id`: if the stored id
 * differed from the freshly-normalized id, every previously-published record would look changed
 * on its very next crawl for no real reason.
 */
function rowIdFor(programId: string, constraintId: string): string {
  return `${programId}::${constraintId}`;
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
            id: rowIdFor(programId, constraint.id),
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
      const prefix = rowIdFor(programId, '');
      return (listStmt.all(programId) as ConstraintRow[]).map((row) =>
        constraintSchema.parse({
          id: row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id,
          hard: row.hard === 1,
          fallbackRank: row.fallback_rank,
          rawText: row.raw_text,
          spec: JSON.parse(row.spec),
        }),
      );
    },
  };
}
