import type Database from 'better-sqlite3';
import type { SourceModule } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import type { NormalizeContext } from '../normalize/index.js';
import { DEADLINE_INHERITANCE } from '../normalize/deadline.js';
import { programIdFor } from '../sources/util/ids.js';

/**
 * Builds the NormalizeContext. This lives in crawl/ rather than normalize/ because it needs the
 * three things normalize/ must not import (spec §14): the registry, `programIdFor` (node:crypto)
 * and a database handle.
 *
 * `db` is optional. With it, RESOLUTIONS R9's reconciliation is active: an already-stored record
 * with this (sourceId, externalKey) keeps its id, so the nightly crawl updates Plan 5's seeded
 * corpus instead of minting parallel ids and duplicating every record every night. Without it —
 * parser tests, `verify-sources` — ids are simply minted.
 */
export function contextForSource(
  m: SourceModule,
  nowISO: string,
  db?: Database.Database,
): NormalizeContext {
  const ctx: NormalizeContext = {
    sourceId: m.id,
    funderId: m.funderId,
    klass: m.klass,
    tier: m.tier,
    nowISO,
    deadlineInheritsFrom: DEADLINE_INHERITANCE[m.id],
    verificationMethod: m.tier === 'A' ? 'api' : m.tier === 'D' ? 'manual_curation' : 'live_fetch',
    mintId: programIdFor,
  };
  if (db !== undefined) {
    const programs = createProgramRepo(db);
    ctx.existingIdFor = (sourceId, externalKey) =>
      programs.findBySourceKey(sourceId, externalKey)?.id;
  }
  return ctx;
}
