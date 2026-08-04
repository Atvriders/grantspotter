/**
 * Browse-row fixtures shared by `Browse.test.tsx` and `ProgramTable.test.tsx`.
 *
 * These are typed as the real `Program` / `ProgramRow` / `BrowseResponse`, not as loose object
 * literals cast at the fetch boundary. That is deliberate: a fixture that only has to satisfy
 * `unknown` agrees with itself forever, and this suite's whole job is to catch the moment a wire
 * field stops arriving. `ProgramTable` reads `program.tags` (the `safety_warning` flag) and
 * `row.nextTimezone`; a partial literal would have shipped `undefined` for both and thrown or
 * silently mis-rendered at runtime while the test file typechecked clean.
 *
 * The numbers below are the real corpus's, not invented ones — see each row's comment.
 */
import type { Program } from '@grantspotter/core';
import type { ProgramRow } from '../components/ProgramTable.js';
import type { BrowseResponse, BrowseSummary } from '../routes/Browse.js';

export function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p-1',
    funderId: 'f-1',
    name: 'A programme',
    klass: 'ham_scholarship',
    summary: '',
    applicantEntities: ['individual'],
    amount: { instrument: 'unknown', amountRaw: 'Not published', awardCountRaw: 'Not published' },
    deadline: { kind: 'unpublished', source: { kind: 'self' }, note: '' },
    applyVia: 'page_form',
    constraints: [],
    fundingRestrictions: [],
    obligations: {},
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'unknown',
      sourceUrl: 'https://example.com/programme',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      verificationMethod: 'live_fetch',
      contentHash: 'hash-1',
    },
    rawOtherText: '',
    tags: [],
    ...overrides,
  };
}

export function makeRow(overrides: Partial<ProgramRow> = {}): ProgramRow {
  return {
    program: makeProgram(),
    funderName: 'A funder',
    verdict: { kind: 'eligible' },
    nextOpensAt: null,
    nextClosesAt: null,
    nextIsEstimated: false,
    nextTimezone: null,
    watched: false,
    ...overrides,
  };
}

export const EMPTY_SUMMARY: BrowseSummary = {
  total: 0,
  eligible: 0,
  preferred: 0,
  ineligible: 0,
  unknown: 0,
  ineligibleByAxis: [],
  unknownByField: [],
};

export function makeResponse(overrides: Partial<BrowseResponse> = {}): BrowseResponse {
  const rows = overrides.rows ?? [];
  return {
    rows,
    summary: { ...EMPTY_SUMMARY, total: rows.length },
    page: 1,
    pageSize: 50,
    total: rows.length,
    profileApplied: 'student',
    ...overrides,
  };
}

/** ARRL Foundation Scholarship Program — the corpus's largest single award range. */
export const ARRL_FOUNDATION_ROW: ProgramRow = makeRow({
  program: makeProgram({
    id: 'arrl-foundation-scholarship',
    name: 'ARRL Foundation Scholarship Program',
    klass: 'ham_scholarship',
    amount: {
      instrument: 'cash_range',
      amountMin: 500,
      amountMax: 25_000,
      amountRaw: '$500 - $25,000',
      awardCountRaw: '170+',
    },
    trust: {
      status: 'open',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
      verificationMethod: 'live_fetch',
      contentHash: 'x',
    },
    tags: ['tier:A', 'source:arrl-scholarship-program'],
  }),
  funderName: 'ARRL Foundation',
  verdict: { kind: 'eligible' },
  nextOpensAt: '2026-10-30T00:00:00.000Z',
  nextClosesAt: '2026-12-30T17:00:00.000Z',
  nextIsEstimated: false,
  nextTimezone: 'America/New_York',
});

/** Chicago FM Club Scholarship — discontinued, still mirrored by aggregators, no next cycle. */
export const CHICAGO_FM_ROW: ProgramRow = makeRow({
  program: makeProgram({
    id: 'chicago-fm-club-scholarship',
    name: 'Chicago FM Club Scholarship',
    klass: 'ham_scholarship',
    trust: {
      status: 'discontinued',
      lastVerifiedAt: '2026-01-05T00:00:00.000Z',
      sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
      verificationMethod: 'manual_curation',
      contentHash: 'y',
      staleMirrorWarning:
        'Still listed by 7 or more third-party aggregators, which mirror stale ARRL data.',
    },
    tags: ['tier:A', 'source:arrl-scholarship-descriptions'],
  }),
  funderName: 'Six Meter Club of Chicago',
  verdict: {
    kind: 'ineligible',
    reasons: [
      {
        id: 'c1',
        hard: true,
        fallbackRank: 0,
        rawText: 'This program is discontinued.',
        spec: { axis: 'other', note: 'discontinued' },
      },
    ],
  },
  nextClosesAt: null,
  nextIsEstimated: false,
  nextTimezone: null,
});

/**
 * ARRL Amateur Radio Grants — THE ROW THE ONE-DAY-LATE DEFECT WAS MEASURED ON.
 *
 * The funder publishes a "1-28 February 2027" window in America/New_York. Core stores the close
 * as the UTC instant of 23:59 local, `2027-03-01T04:59:00.000Z`. Rendered without the zone that
 * prints 2027-03-01 — a day the ARRL does not accept.
 */
export const ARRL_GRANTS_ROW: ProgramRow = makeRow({
  program: makeProgram({
    id: 'arrl-amateur-radio-grants',
    name: 'ARRL Amateur Radio Grants',
    klass: 'ham_grant',
    applicantEntities: ['club_501c3', 'school_lea'],
    amount: {
      instrument: 'cash_range',
      amountMin: 1000,
      amountMax: 25_000,
      amountRaw: 'Up to $25,000',
      awardCountRaw: 'Not published',
    },
    trust: {
      status: 'unknown',
      lastVerifiedAt: '2026-08-01T00:00:00.000Z',
      sourceUrl: 'https://www.arrl.org/arrl-grants',
      verificationMethod: 'live_fetch',
      contentHash: 'z',
    },
    tags: ['tier:A', 'source:arrl-amateur-radio-grants'],
  }),
  funderName: 'ARRL',
  verdict: { kind: 'unknown', missingProfileFields: ['is501c3'] },
  nextOpensAt: '2027-02-01T05:00:00.000Z',
  nextClosesAt: '2027-03-01T04:59:00.000Z',
  nextIsEstimated: true,
  nextTimezone: 'America/New_York',
});

/**
 * The compromised-domain safety warning. `farweb.org` was taken over between 2025-10-17 and
 * 2026-02-10 and now redirects to a gambling site; ARRL, QCWA and club pages still tell people to
 * "apply at the FAR website". The record exists to intercept that instruction, so browse must
 * render it as a warning and must never emit a link to that host.
 */
export const FAR_SAFETY_ROW: ProgramRow = makeRow({
  program: makeProgram({
    // The real corpus id, verified against a full offline corpus build: the record IS published.
    id: 'manual-tier-d--far-farweb-org-compromised--66f1149e',
    name: 'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
    klass: 'ham_scholarship',
    summary:
      'SAFETY WARNING. The Foundation for Amateur Radio’s domain no longer belongs to FAR: it ' +
      'now redirects to an online-gambling site. Apply through the ARRL Foundation instead.',
    applyVia: 'none',
    trust: {
      status: 'discontinued',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      sourceUrl: 'https://www.arrl.org/scholarship-program',
      verificationMethod: 'manual_curation',
      contentHash: 'far',
    },
    tags: ['tier:D', 'source:manual-tier-d', 'key:far-farweb-org-compromised', 'safety_warning'],
  }),
  funderName: 'Foundation for Amateur Radio',
  verdict: null,
  nextClosesAt: null,
  nextIsEstimated: false,
  nextTimezone: null,
});

/** A cycle whose zone was never recorded. Null means "not recorded", never "the server's zone". */
export const NO_ZONE_ROW: ProgramRow = makeRow({
  program: makeProgram({
    id: 'zoneless-programme',
    name: 'Zoneless programme',
    tags: ['tier:C'],
  }),
  funderName: 'Some club',
  verdict: { kind: 'eligible' },
  nextClosesAt: '2027-03-01T04:59:00.000Z',
  nextIsEstimated: true,
  nextTimezone: null,
});
