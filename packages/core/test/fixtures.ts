import type {
  Constraint,
  ConstraintSpec,
  Funder,
  OrgProfile,
  Program,
  StudentProfile,
} from '../src/types.js';

export function makeFunder(over: Partial<Funder> = {}): Funder {
  return {
    id: 'arrl-foundation',
    name: 'ARRL Foundation',
    homepage: 'https://www.arrl.org/arrl-foundation',
    ...over,
  };
}

let constraintSeq = 0;

export function makeConstraint(
  spec: ConstraintSpec,
  over: Partial<Omit<Constraint, 'spec'>> = {},
): Constraint {
  constraintSeq += 1;
  return {
    id: `c${constraintSeq}`,
    hard: true,
    fallbackRank: 0,
    rawText: `constraint on ${spec.axis}`,
    spec,
    ...over,
  };
}

export function makeProgram(over: Partial<Program> = {}): Program {
  return {
    id: 'arrl-foundation-scholarships',
    funderId: 'arrl-foundation',
    name: 'ARRL Foundation Scholarship Program',
    klass: 'ham_scholarship',
    summary:
      'A single application across a catalogue of 111 named scholarship entries awarding 170+ scholarships to licensed students in higher education.',
    applicantEntities: ['individual'],
    amount: {
      instrument: 'cash_range',
      amountMin: 500,
      amountMax: 25000,
      amountRaw: '$500-$25,000',
      awardCountRaw: '170+',
    },
    deadline: {
      kind: 'annual_window',
      source: { kind: 'self' },
      note: 'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | Opens about Oct 30 and closes Dec 30 at 12:00 PM Eastern. Moved from Jan 31 — never hardcode the old date.',
    },
    applyVia: 'external_spa_portal',
    applyUrl: 'https://www.arrl.org/scholarship-program',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.arrl.org/scholarship-descriptions',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      verificationMethod: 'manual_curation',
      contentHash: '',
    },
    rawOtherText: '',
    tags: ['arrl', 'scholarship'],
    ...over,
  };
}

export function makeStudent(over: Partial<StudentProfile> = {}): StudentProfile {
  return { kind: 'student', ...over };
}

export function makeOrg(over: Partial<OrgProfile> = {}): OrgProfile {
  return { kind: 'organization', entity: 'club_501c3', ...over };
}
