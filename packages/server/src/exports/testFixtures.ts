/**
 * Shared builders for the export suites. Every task in Plan 5 builds its records from these, so
 * that a fact about a record is stated once and every format's tests describe the same programme.
 *
 * DEVIATION FROM THE TASK BRIEF, and the reason it matters more here than anywhere else.
 *
 * The brief's `makeProgram` set `obligations: { costShareRequired: false, coFunderPreference: false }`.
 * Those two fields are TRI-STATE (`ObligationState` in `@grantspotter/core`): `true` means the
 * funder said it is required, `false` means the funder said it is NOT, and ABSENT means no page
 * this pipeline fetched addressed the question. Writing `false` into the default fixture bakes the
 * exact claim the tri-state exists to prevent — "this funder does not require cost sharing" — into
 * every record every later task in this plan tests against, and it does not describe the corpus:
 * across the 150 publishable programmes `costShareRequired` is unstated on 148, `true` on 2 and
 * `false` on ZERO. A default of `{}` means "unstated", which is both the honest default and the
 * overwhelmingly common one. Tests that need a stated obligation pass it explicitly.
 */
import type { Cycle, Funder, Program } from '@grantspotter/core';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';

export function makeFunder(overrides: Partial<Funder> = {}): Funder {
  return {
    id: 'ardc',
    name: 'Amateur Radio Digital Communications',
    homepage: 'https://www.ardc.net/',
    ...overrides,
  };
}

export function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'ardc-grants',
    funderId: 'ardc',
    name: 'ARDC Grants Program',
    klass: 'ham_grant',
    summary: 'Grants for amateur radio, digital communication and related education.',
    applicantEntities: ['club_via_fiscal_sponsor', 'school_lea', 'university'],
    amount: {
      instrument: 'cash_range',
      amountMin: 1285,
      amountMax: 258000,
      amountRaw: '$1,285-$258,000 observed in 2026',
      awardCountRaw: 'Multiple per year',
    },
    deadline: {
      kind: 'n_fixed_dates',
      source: { kind: 'self' },
      note: 'February 1, April 1, July 1, September 1.',
    },
    applyVia: 'external_spa_portal',
    applyUrl: 'https://www.ardc.net/apply/',
    constraints: [],
    fundingRestrictions: [],
    // Unstated, not "not required". See the file header.
    obligations: {},
    aiPolicy: { stance: 'permitted' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.ardc.net/apply/',
      lastVerifiedAt: '2026-08-02',
      verificationMethod: 'seed_import',
      contentHash: '',
    },
    rawOtherText: '',
    tags: ['ham', 'grant'],
    ...overrides,
  };
}

export function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: 'ardc-grants-2027-02',
    programId: 'ardc-grants',
    closesAt: '2027-02-01',
    timezone: 'America/Los_Angeles',
    label: 'Feb 2027 deadline',
    isEstimated: false,
    ...overrides,
  };
}

/**
 * A record the product STORES and must never publish: a past award, a cross-check row, one of the
 * ~37 ARRL clubs already funded. `isDoNotPublish` is the only reader of the tag; this builder is
 * the only place the export suites write it, so a test that forgets to gate fails loudly.
 */
export function makeSuppressedProgram(overrides: Partial<Program> = {}): Program {
  const base = makeProgram({
    id: 'ardc-2019-award-11225',
    name: 'ARDC 2019 grant to Example Radio Club',
    summary: 'Money already awarded in 2019. Evidence of who this funder funds, not an opportunity.',
    ...overrides,
  });
  // The TAG CONSTANT, never the literal. A copy of the string here would be a second definition
  // of suppression, free to drift from the one `isDoNotPublish` reads.
  return { ...base, tags: [...base.tags, 'past_award', DO_NOT_PUBLISH_TAG] };
}
