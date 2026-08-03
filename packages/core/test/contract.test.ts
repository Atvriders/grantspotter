import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import type { Profile, Program, Verdict } from '../src/index.js';
import { makeProgram, makeStudent } from './fixtures.js';

describe('@grantspotter/core public surface', () => {
  it('exports every CONTRACT §4 function', () => {
    const required = [
      'parseAmount',
      'expandCycles',
      'resolveDeadlineOwner',
      'statesForArrlDivision',
      'statesForArrlSection',
      'withinRadius',
      'matchProgram',
      'matchAll',
      'hashProgram',
    ];
    for (const name of required) {
      expect(typeof (core as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(required).toHaveLength(9);
  });

  it('keeps internals internal', () => {
    expect('sha256Hex' in core).toBe(false);
  });

  it('exports the zod schemas the server validates JSON columns with', () => {
    for (const name of [
      'programSchema',
      'constraintSpecSchema',
      'amountSpecSchema',
      'obligationsSchema',
      'profileSchema',
      'cycleSchema',
      'funderSchema',
      'trustFieldsSchema',
    ]) {
      expect(
        typeof (core as unknown as Record<string, { parse?: unknown }>)[name]?.parse,
        name,
      ).toBe('function');
    }
  });

  it('is callable end to end through the barrel alone', () => {
    const program: Program = makeProgram({
      id: 'ardc-grants',
      applicantEntities: ['university'],
      deadline: {
        kind: 'n_fixed_dates',
        source: { kind: 'self' },
        note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01',
      },
    });
    const profile: Profile = makeStudent({ state: 'CA' });

    expect(core.parseAmount('$500-$5,000')).toEqual({ amountMin: 500, amountMax: 5000 });
    expect(core.hashProgram(program)).toMatch(/^[0-9a-f]{64}$/);
    expect(core.resolveDeadlineOwner(program, [program]).id).toBe('ardc-grants');
    expect(
      core.expandCycles(program, [program], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z'),
    ).toHaveLength(4);
    expect(core.statesForArrlDivision('Central')).toEqual(['IL', 'IN', 'WI']);
    expect(core.statesForArrlSection('MDC')).toEqual(['MD', 'DC']);
    expect(
      core.withinRadius(42.6526, -73.7562, {
        type: 'radius',
        values: [],
        centerLat: 42.8142,
        centerLon: -73.9396,
        radiusMiles: 70,
      }),
    ).toBe(true);

    const verdict: Verdict = core.matchProgram(profile, program, '2027-03-01T00:00:00.000Z');
    expect(verdict.kind).toBe('ineligible'); // a student cannot apply as a university
    expect(core.matchAll(profile, [program], '2027-03-01T00:00:00.000Z').size).toBe(1);
  });

  it('re-exports the domain types Plans 2-5 depend on', () => {
    // Type-only assertions: these fail at compile time, not at run time.
    const status: core.ProgramStatus = 'unknown';
    const kind: core.DeadlineKind = 'inherited';
    const entity: core.ApplicantEntity = 'club_via_fiscal_sponsor';
    const change: core.ChangeKind = 'parse_yield_dropped';
    const tier: core.SourceTier = 'C';
    expect([status, kind, entity, change, tier]).toHaveLength(5);
  });
});
