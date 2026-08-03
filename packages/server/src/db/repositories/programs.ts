import { hashProgram, programSchema } from '@grantspotter/core';
import type { OpportunityClass, Program, ProgramStatus } from '@grantspotter/core';
import type { Db } from '../migrate.js';
import { createConstraintRepo } from './constraints.js';

export interface ProgramListFilter {
  klass?: OpportunityClass;
  funderId?: string;
  status?: ProgramStatus;
}

/**
 * PLAN-LOCAL (RESOLUTIONS R1/R9). CONTRACT §3 freezes `Program` with no field
 * for the source record it came from, so ingest identity travels alongside it
 * and lands in the programs.source_id / programs.external_key columns.
 */
export interface ProgramSourceKey {
  sourceId: string;
  externalKey: string;
}

export interface ProgramRepo {
  /**
   * `sourceKey` is written only when supplied. Omitting it preserves whatever
   * is already stored, so a crawler re-upsert never orphans a seeded record
   * from its source identity.
   */
  upsert(program: Program, sourceKey?: ProgramSourceKey): void;
  get(id: string): Program | undefined;
  /** Plan 2's crawler resolves an existing id through this before minting one. */
  findBySourceKey(sourceId: string, externalKey: string): Program | undefined;
  list(filter?: ProgramListFilter): Program[];
  remove(id: string): void;
  count(): number;
}

/**
 * Returns a copy of `program` with trust.contentHash set to hashProgram(program).
 * The repository never does this itself: the hash is an input to change
 * detection, and Plan 2's normalizer owns when it is (re)computed.
 */
export function withContentHash(program: Program): Program {
  return { ...program, trust: { ...program.trust, contentHash: hashProgram(program) } };
}

interface ProgramRow {
  id: string;
  funder_id: string;
  name: string;
  klass: string;
  summary: string;
  applicant_entities: string;
  amount: string;
  deadline: string;
  apply_via: string;
  apply_url: string | null;
  apply_contact: string | null;
  funding_restrictions: string;
  obligations: string;
  ai_policy: string;
  trust: string;
  raw_other_text: string;
  tags: string;
}

export function createProgramRepo(db: Db): ProgramRepo {
  const constraints = createConstraintRepo(db);

  const COLUMNS = `id, funder_id, name, klass, summary, applicant_entities, amount, deadline,
    apply_via, apply_url, apply_contact, funding_restrictions, obligations, ai_policy, trust,
    raw_other_text, tags`;

  const upsertStmt = db.prepare(
    `INSERT INTO programs (${COLUMNS}, source_id, external_key, content_hash, status,
             last_verified_at, created_at, updated_at)
     VALUES (@id, @funder_id, @name, @klass, @summary, @applicant_entities, @amount, @deadline,
             @apply_via, @apply_url, @apply_contact, @funding_restrictions, @obligations,
             @ai_policy, @trust, @raw_other_text, @tags, @source_id, @external_key,
             @content_hash, @status, @last_verified_at, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       funder_id = excluded.funder_id, name = excluded.name, klass = excluded.klass,
       summary = excluded.summary, applicant_entities = excluded.applicant_entities,
       amount = excluded.amount, deadline = excluded.deadline, apply_via = excluded.apply_via,
       apply_url = excluded.apply_url, apply_contact = excluded.apply_contact,
       funding_restrictions = excluded.funding_restrictions, obligations = excluded.obligations,
       ai_policy = excluded.ai_policy, trust = excluded.trust,
       raw_other_text = excluded.raw_other_text, tags = excluded.tags,
       -- COALESCE, not excluded.*: an upsert that supplies no sourceKey must
       -- keep the identity the seed importer or an earlier crawl wrote.
       source_id = COALESCE(excluded.source_id, programs.source_id),
       external_key = COALESCE(excluded.external_key, programs.external_key),
       content_hash = excluded.content_hash, status = excluded.status,
       last_verified_at = excluded.last_verified_at, updated_at = excluded.updated_at`,
  );
  const getStmt = db.prepare(`SELECT ${COLUMNS} FROM programs WHERE id = ?`);
  const findBySourceKeyStmt = db.prepare(
    `SELECT ${COLUMNS} FROM programs WHERE source_id = ? AND external_key = ?`,
  );
  const removeStmt = db.prepare('DELETE FROM programs WHERE id = ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM programs');

  function toProgram(row: ProgramRow): Program {
    const draft: Record<string, unknown> = {
      id: row.id,
      funderId: row.funder_id,
      name: row.name,
      klass: row.klass,
      summary: row.summary,
      applicantEntities: JSON.parse(row.applicant_entities),
      amount: JSON.parse(row.amount),
      deadline: JSON.parse(row.deadline),
      applyVia: row.apply_via,
      constraints: constraints.listForProgram(row.id),
      fundingRestrictions: JSON.parse(row.funding_restrictions),
      obligations: JSON.parse(row.obligations),
      aiPolicy: JSON.parse(row.ai_policy),
      trust: JSON.parse(row.trust),
      rawOtherText: row.raw_other_text,
      tags: JSON.parse(row.tags),
    };
    if (row.apply_url !== null) draft.applyUrl = row.apply_url;
    if (row.apply_contact !== null) draft.applyContact = row.apply_contact;
    // CONTRACT §6: JSON-shaped columns are validated on read.
    return programSchema.parse(draft);
  }

  return {
    upsert(program, sourceKey) {
      db.transaction(() => {
        upsertStmt.run({
          id: program.id,
          funder_id: program.funderId,
          name: program.name,
          klass: program.klass,
          summary: program.summary,
          applicant_entities: JSON.stringify(program.applicantEntities),
          amount: JSON.stringify(program.amount),
          deadline: JSON.stringify(program.deadline),
          apply_via: program.applyVia,
          apply_url: program.applyUrl ?? null,
          apply_contact: program.applyContact ?? null,
          funding_restrictions: JSON.stringify(program.fundingRestrictions),
          obligations: JSON.stringify(program.obligations),
          ai_policy: JSON.stringify(program.aiPolicy),
          trust: JSON.stringify(program.trust),
          raw_other_text: program.rawOtherText,
          tags: JSON.stringify(program.tags),
          source_id: sourceKey?.sourceId ?? null,
          external_key: sourceKey?.externalKey ?? null,
          content_hash: program.trust.contentHash,
          status: program.trust.status,
          last_verified_at: program.trust.lastVerifiedAt,
          now: new Date().toISOString(),
        });
        constraints.replaceForProgram(program.id, program.constraints);
      })();
    },
    get(id) {
      const row = getStmt.get(id) as ProgramRow | undefined;
      return row === undefined ? undefined : toProgram(row);
    },
    findBySourceKey(sourceId, externalKey) {
      const row = findBySourceKeyStmt.get(sourceId, externalKey) as ProgramRow | undefined;
      return row === undefined ? undefined : toProgram(row);
    },
    list(filter = {}) {
      const wheres: string[] = [];
      const params: unknown[] = [];
      if (filter.klass !== undefined) {
        wheres.push('klass = ?');
        params.push(filter.klass);
      }
      if (filter.funderId !== undefined) {
        wheres.push('funder_id = ?');
        params.push(filter.funderId);
      }
      if (filter.status !== undefined) {
        wheres.push('status = ?');
        params.push(filter.status);
      }
      const sql = `SELECT ${COLUMNS} FROM programs${
        wheres.length > 0 ? ` WHERE ${wheres.join(' AND ')}` : ''
      } ORDER BY name`;
      return (db.prepare(sql).all(...params) as ProgramRow[]).map(toProgram);
    },
    remove(id) {
      removeStmt.run(id);
    },
    count() {
      return (countStmt.get() as { n: number }).n;
    },
  };
}
