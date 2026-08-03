import { hashProgram } from '@grantspotter/core';
import type { Constraint, Cycle, Funder, Program } from '@grantspotter/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConstraintRepo } from '../src/db/repositories/constraints.js';
import { createCycleRepo } from '../src/db/repositories/cycles.js';
import { createFunderRepo } from '../src/db/repositories/funders.js';
import { createProgramRepo, withContentHash } from '../src/db/repositories/programs.js';
import { createTestDb, type TestDb } from './helpers/tempDb.js';

const funder: Funder = {
  id: 'ardc',
  name: 'Amateur Radio Digital Communications',
  homepage: 'https://www.ardc.net/',
  ein: '45-3751971',
};

function constraint(id: string, over: Partial<Constraint> = {}): Constraint {
  return {
    id,
    hard: true,
    fallbackRank: 0,
    rawText: `raw text for ${id}`,
    spec: { axis: 'gpa', min: 3 },
    ...over,
  };
}

function program(over: Partial<Program> = {}): Program {
  return {
    id: 'ardc-grants',
    funderId: 'ardc',
    name: 'ARDC Grants Program',
    klass: 'ham_grant',
    summary: 'Four fixed application deadlines a year; all output must be open-source.',
    applicantEntities: ['club_via_fiscal_sponsor', 'university', 'school_lea'],
    amount: {
      instrument: 'cash_range',
      amountMin: 1285,
      amountMax: 258000,
      amountRaw: '$1,285-$258,000',
      awardCountRaw: 'Multiple per year',
    },
    deadline: {
      kind: 'n_fixed_dates',
      source: { kind: 'self' },
      note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01',
    },
    applyVia: 'external_spa_portal',
    applyUrl: 'https://www.ardc.net/apply/',
    constraints: [],
    fundingRestrictions: ['for-profit entities are ineligible'],
    obligations: {
      licenseObligation: 'All output must be open-source/open-access (GPL/MIT/BSD/CERN-OHL/CC).',
      indirectCostCapPct: 20,
      costShareRequired: false,
      coFunderPreference: false,
    },
    aiPolicy: {
      stance: 'permitted',
      quote:
        'If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy.',
      url: 'https://www.ardc.net/apply/grant-application-instructions/',
    },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.ardc.net/apply/',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      verificationMethod: 'live_fetch',
      contentHash: 'seeded-hash',
    },
    rawOtherText: '',
    tags: ['ardc', 'grant'],
    ...over,
  };
}

let harness: TestDb;
beforeEach(() => {
  harness = createTestDb();
  createFunderRepo(harness.db).upsert(funder);
});
afterEach(() => harness.cleanup());

describe('funder repository', () => {
  it('round-trips, lists, counts and removes', () => {
    const repo = createFunderRepo(harness.db);
    expect(repo.get('ardc')).toEqual(funder);
    expect(repo.count()).toBe(1);

    repo.upsert({ ...funder, name: 'ARDC' });
    expect(repo.get('ardc')?.name).toBe('ARDC');
    expect(repo.count()).toBe(1);

    repo.upsert({ id: 'arrl-foundation', name: 'ARRL Foundation', homepage: 'https://www.arrl.org/' });
    expect(repo.list().map((f) => f.id)).toEqual(['arrl-foundation', 'ardc']);

    repo.remove('ardc');
    expect(repo.get('ardc')).toBeUndefined();
  });
});

describe('program repository', () => {
  it('round-trips a fully populated program exactly', () => {
    const repo = createProgramRepo(harness.db);
    const p = program();
    repo.upsert(p);
    expect(repo.get('ardc-grants')).toEqual(p);
  });

  it('round-trips constraints and preserves their order', () => {
    const repo = createProgramRepo(harness.db);
    const p = program({
      constraints: [
        constraint('c-geo', { spec: { axis: 'geography', geo: { type: 'any', values: [] } } }),
        constraint('c-need', { hard: false, fallbackRank: 2, spec: { axis: 'financial_need', weighted: true } }),
        constraint('c-gpa'),
      ],
    });
    repo.upsert(p);
    const loaded = repo.get('ardc-grants');
    expect(loaded?.constraints.map((c) => c.id)).toEqual(['c-geo', 'c-need', 'c-gpa']);
    expect(loaded?.constraints[1].hard).toBe(false);
    expect(loaded?.constraints[1].fallbackRank).toBe(2);
  });

  it('replaces constraints on upsert rather than accumulating them', () => {
    const repo = createProgramRepo(harness.db);
    repo.upsert(program({ constraints: [constraint('a'), constraint('b')] }));
    repo.upsert(program({ constraints: [constraint('c')] }));
    expect(repo.get('ardc-grants')?.constraints.map((c) => c.id)).toEqual(['c']);
    expect(createConstraintRepo(harness.db).listForProgram('ardc-grants')).toHaveLength(1);
  });

  it('filters by class, funder and status', () => {
    const repo = createProgramRepo(harness.db);
    repo.upsert(program());
    repo.upsert(
      program({
        id: 'ardc-scholarships',
        klass: 'ham_scholarship',
        trust: { ...program().trust, status: 'closed' },
      }),
    );
    expect(repo.list({ klass: 'ham_grant' }).map((p) => p.id)).toEqual(['ardc-grants']);
    expect(repo.list({ status: 'closed' }).map((p) => p.id)).toEqual(['ardc-scholarships']);
    expect(repo.list({ funderId: 'ardc' })).toHaveLength(2);
    expect(repo.list({ funderId: 'nobody' })).toEqual([]);
    expect(repo.count()).toBe(2);
  });

  it('cascades constraints and cycles when a program is removed', () => {
    const repo = createProgramRepo(harness.db);
    const cycles = createCycleRepo(harness.db);
    repo.upsert(program({ constraints: [constraint('a')] }));
    cycles.upsertMany([
      {
        id: 'ardc-grants:2027-02-02T07:59:00.000Z',
        programId: 'ardc-grants',
        closesAt: '2027-02-02T07:59:00.000Z',
        timezone: 'America/Los_Angeles',
        label: 'Feb 1, 2027 deadline',
        isEstimated: true,
      },
    ]);
    repo.remove('ardc-grants');
    expect(createConstraintRepo(harness.db).listForProgram('ardc-grants')).toEqual([]);
    expect(cycles.listForProgram('ardc-grants')).toEqual([]);
  });

  it('refuses to return a row whose JSON no longer matches the schema', () => {
    const repo = createProgramRepo(harness.db);
    repo.upsert(program());
    harness.db
      .prepare('UPDATE programs SET amount = ? WHERE id = ?')
      .run('{"instrument":"gold","amountRaw":"","awardCountRaw":""}', 'ardc-grants');
    expect(() => repo.get('ardc-grants')).toThrow();
  });

  // RESOLUTIONS R1/R9: the seed corpus owns program identity, and the nightly
  // crawler resolves it through (sourceId, externalKey). Without this, every
  // crawl mints a fresh id and diffPrograms reports the whole corpus as
  // `vanished` + `new`, every single night.
  it('finds a program by its source key', () => {
    const repo = createProgramRepo(harness.db);
    repo.upsert(program(), { sourceId: 'ardc-grants', externalKey: 'grants' });
    repo.upsert(
      program({ id: 'ardc-award-tables', name: 'ARDC award tables' }),
      { sourceId: 'ardc-award-tables', externalKey: 'tables' },
    );

    expect(repo.findBySourceKey('ardc-grants', 'grants')?.id).toBe('ardc-grants');
    expect(repo.findBySourceKey('ardc-award-tables', 'tables')?.id).toBe('ardc-award-tables');
    expect(repo.findBySourceKey('ardc-grants', 'tables')).toBeUndefined();
    expect(repo.findBySourceKey('no-such-source', 'grants')).toBeUndefined();
  });

  it('returns undefined for a program stored without a source key', () => {
    const repo = createProgramRepo(harness.db);
    repo.upsert(program({ id: 'hand-curated' }));
    expect(repo.get('hand-curated')?.id).toBe('hand-curated');
    expect(repo.findBySourceKey('ardc-grants', 'grants')).toBeUndefined();
  });

  it('keeps the stored source key when a later upsert omits it', () => {
    // The crawler upserts the normalized record with no sourceKey argument.
    // If that cleared the columns, reconciliation would work exactly once and
    // the corpus would start duplicating on the second night.
    const repo = createProgramRepo(harness.db);
    repo.upsert(program(), { sourceId: 'ardc-grants', externalKey: 'grants' });
    repo.upsert(program({ name: 'ARDC Grants Program (renamed)' }));

    expect(repo.get('ardc-grants')?.name).toBe('ARDC Grants Program (renamed)');
    expect(repo.findBySourceKey('ardc-grants', 'grants')?.id).toBe('ardc-grants');
  });

  it('stores the caller’s contentHash verbatim, and withContentHash computes one', () => {
    const repo = createProgramRepo(harness.db);
    const p = program();
    repo.upsert(p);
    expect(repo.get('ardc-grants')?.trust.contentHash).toBe('seeded-hash');

    const hashed = withContentHash(p);
    expect(hashed.trust.contentHash).toBe(hashProgram(p));
    expect(hashed.trust.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.trust.contentHash).toBe('seeded-hash'); // input not mutated
  });
});

describe('cycle repository', () => {
  const base: Cycle = {
    id: 'ardc-grants:2027-02-02T07:59:00.000Z',
    programId: 'ardc-grants',
    closesAt: '2027-02-02T07:59:00.000Z',
    timezone: 'America/Los_Angeles',
    label: 'Feb 1, 2027 deadline',
    isEstimated: true,
  };

  beforeEach(() => {
    createProgramRepo(harness.db).upsert(program());
  });

  it('upserts by id so a nightly re-projection does not duplicate rows', () => {
    const repo = createCycleRepo(harness.db);
    repo.upsertMany([base]);
    repo.upsertMany([{ ...base, label: 'Feb 1, 2027 deadline (revised)' }]);
    const rows = repo.listForProgram('ardc-grants');
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Feb 1, 2027 deadline (revised)');
  });

  it('lists cycles closing inside a window, in ascending order', () => {
    const repo = createCycleRepo(harness.db);
    repo.upsertMany([
      { ...base, id: 'c3', closesAt: '2027-07-02T06:59:00.000Z', label: 'Jul' },
      { ...base, id: 'c1', closesAt: '2027-02-02T07:59:00.000Z', label: 'Feb' },
      { ...base, id: 'c2', closesAt: '2027-04-02T06:59:00.000Z', label: 'Apr' },
      { ...base, id: 'c4', closesAt: '2028-02-02T07:59:00.000Z', label: 'next year' },
    ]);
    expect(
      repo
        .listClosingBetween('2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z')
        .map((c) => c.label),
    ).toEqual(['Feb', 'Apr', 'Jul']);
  });

  it('drops projected cycles without touching observed ones', () => {
    const repo = createCycleRepo(harness.db);
    repo.upsertMany([
      { ...base, id: 'projected', isEstimated: true },
      {
        ...base,
        id: 'observed',
        isEstimated: false,
        opensAt: '2027-01-01T05:00:00.000Z',
        label: 'observed on the page',
      },
    ]);
    repo.removeEstimatedForProgram('ardc-grants');
    const rows = repo.listForProgram('ardc-grants');
    expect(rows.map((c) => c.id)).toEqual(['observed']);
    expect(rows[0].opensAt).toBe('2027-01-01T05:00:00.000Z');
    expect(rows[0].isEstimated).toBe(false);
  });
});
