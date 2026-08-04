import type Database from 'better-sqlite3';
import type { Funder, Program } from '@grantspotter/core';
import { createFunderRepo } from '../../db/repositories/funders.js';
import { createProgramRepo } from '../../db/repositories/programs.js';

export const funders: Funder[] = [
  { id: 'arrl-foundation', name: 'ARRL Foundation', homepage: 'https://www.arrl.org/arrl-foundation' },
  { id: 'ardc', name: 'Amateur Radio Digital Communications', homepage: 'https://www.ardc.net/', ein: '45-3751971' },
  { id: 'qcwa', name: 'Quarter Century Wireless Association', homepage: 'https://www.qcwa.org/' },
  { id: 'chicago-fm-club', name: 'Six Meter Club of Chicago', homepage: 'https://www.chicagofmclub.org/' },
];

/**
 * DEVIATION FROM THE TASK BRIEF, and why (2026-08-03).
 *
 * The brief gives each `deadline.note` as human prose only ("Opens about Oct 30; closes Dec 30 at
 * 12:00 PM EST…"), and in the same breath asserts in `reindex.test.ts` that QCWA — which INHERITS
 * this program's deadline — projects to `2026-12-30T17:00:00.000Z`. Those two cannot both be true.
 * CONTRACT §3 freezes `DeadlineSpec` as `{ kind, source, note }` with no field for a date, so the
 * dates travel in `note` as core's `RECUR` micro-format; `parseRecurrence` returns `{kind:'none'}`
 * for any note without the `RECUR ` prefix and `expandCycles` then yields no cycle at all. Prose
 * alone therefore projects NOTHING, and every deadline assertion in this task would be asserting
 * `null`.
 *
 * Resolved towards the assertions, because they are the specification of the behaviour: the
 * directive is prepended and the brief's prose is kept verbatim after the ` | `, which is exactly
 * the shape `parseRecurrence` defines (directive before the pipe, human text after) and exactly
 * what `packages/core/test/recurrence.test.ts:80` pins for this same ARRL window. Nothing is lost
 * and the dates the brief asserts are now the dates the corpus states.
 */
export const arrlScholarship: Program = {
  id: 'arrl-foundation-scholarship',
  funderId: 'arrl-foundation',
  name: 'ARRL Foundation Scholarship Program',
  klass: 'ham_scholarship',
  summary: 'One application covers the whole ARRL Foundation catalog: 111 entries, 170+ awards.',
  applicantEntities: ['individual'],
  amount: {
    instrument: 'cash_range',
    amountMin: 500,
    amountMax: 25000,
    amountRaw: '$500 - $25,000',
    awardCountRaw: '170+',
  },
  deadline: {
    kind: 'annual_window',
    source: { kind: 'self' },
    note: 'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | Opens about Oct 30; closes Dec 30 at 12:00 PM EST. Moved from Jan 31 - do not hardcode.',
  },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.arrl.org/scholarship-program',
  constraints: [
    {
      id: 'arrl-sch-license',
      hard: true,
      fallbackRank: 0,
      rawText: 'License Requirement: Any class of FCC amateur radio license.',
      spec: { axis: 'license', licenseMin: 'TECH' },
    },
  ],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'unaddressed' },
  trust: {
    status: 'open',
    sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
    lastVerifiedAt: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'live_fetch',
    contentHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  },
  rawOtherText: '',
  tags: ['scholarship', 'arrl'],
};

export const qcwaScholarship: Program = {
  id: 'qcwa-memorial-scholarship',
  funderId: 'qcwa',
  name: 'QCWA Memorial Scholarship Fund',
  klass: 'ham_scholarship',
  summary: 'Licensed hams in accredited degree programs, sponsored by an active QCWA member.',
  applicantEntities: ['individual'],
  amount: {
    instrument: 'cash_fixed',
    amountMin: 3000,
    amountMax: 3000,
    amountRaw: '$3,000',
    awardCountRaw: '19',
  },
  deadline: {
    kind: 'inherited',
    source: { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarship' },
    note: 'QCWA accepts requests from Oct 31; the packet must reach ARRL before the first week of January. Intake is ARRL’s portal, not QCWA’s.',
  },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.qcwa.org/scholarship-program.htm',
  constraints: [
    {
      id: 'qcwa-sponsor',
      hard: true,
      fallbackRank: 0,
      rawText: 'Applicant must be sponsored by an active QCWA member.',
      spec: { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 1 },
    },
    {
      id: 'qcwa-institution',
      hard: true,
      fallbackRank: 0,
      rawText: 'Must be enrolled in an accredited degree program.',
      spec: {
        axis: 'institution',
        degreeLevels: ['ASSOC', 'BACH', 'GRAD'],
        tradeSchoolOK: false,
        partTimeOK: false,
        accreditationRequired: true,
      },
    },
  ],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'unaddressed' },
  trust: {
    status: 'open',
    sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
    lastVerifiedAt: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'live_fetch',
    contentHash: 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  },
  rawOtherText: 'Ver. 04/2025 application PDF. FAR is named as an alternate route on some club pages - that domain is blocklisted.',
  tags: ['scholarship', 'qcwa'],
};

export const ardcGrants: Program = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Support & Growth, Education, and R&D grants. Clubs and individuals apply through a fiscal sponsor.',
  applicantEntities: [
    'club_501c3', 'club_via_fiscal_sponsor', 'school_lea', 'university', 'university_dept',
  ],
  amount: {
    instrument: 'cash_range',
    amountMin: 1285,
    amountMax: 258000,
    amountRaw: '$1,285 - $258,000 (2026 page range)',
    awardCountRaw: 'Multiple per cycle',
  },
  deadline: {
    kind: 'n_fixed_dates',
    source: { kind: 'self' },
    // See the RECUR note on `arrlScholarship` above. ARDC is in California, so the directive
    // carries America/Los_Angeles — the same zone `packages/core/test/cycles.test.ts` pins for
    // these four dates.
    note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | Four fixed cycles: Feb 1, Apr 1, Jul 1, Sep 1. After Sep 1 the next intake is Feb 1. Evaluation takes 60-120 days.',
  },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.ardc.net/apply/',
  constraints: [
    {
      id: 'ardc-entity',
      hard: true,
      fallbackRank: 0,
      rawText: 'US 501(c)(3), government, schools and universities; international nonprofits and universities. Clubs and individuals need a fiscal sponsor. For-profits ineligible.',
      spec: { axis: 'other', note: 'Fiscal sponsor required for unincorporated clubs and individuals.' },
    },
  ],
  fundingRestrictions: ['For-profit entities are ineligible.'],
  obligations: {
    licenseObligation: 'All output must be open-source / open-access (GPL, MIT, BSD, CERN-OHL, or Creative Commons).',
    indirectCostCapPct: 20,
    costShareRequired: false,
    coFunderPreference: false,
  },
  aiPolicy: {
    stance: 'permitted',
    quote: 'If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy. If the proposal is extremely long and hard to understand, we can’t evaluate or support it.',
    url: 'https://www.ardc.net/apply/grant-application-instructions/',
  },
  trust: {
    status: 'open',
    sourceUrl: 'https://www.ardc.net/apply/',
    lastVerifiedAt: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'api',
    contentHash: 'c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  },
  rawOtherText: '',
  tags: ['grant', 'ardc'],
};

export const arrlClubGrant: Program = {
  id: 'arrl-club-grant',
  funderId: 'arrl-foundation',
  name: 'ARRL Club Grant Program',
  klass: 'ham_grant',
  summary: 'ARDC-funded grants to ARRL-affiliated clubs, collegiate clubs included. 2024: $500,502 to 37 of 110 applicants.',
  applicantEntities: ['club_501c3', 'club_unincorporated'],
  amount: {
    instrument: 'cash_range',
    amountMin: 1000,
    amountMax: 25000,
    amountRaw: '$1,000 - $25,000',
    awardCountRaw: '37 in 2024',
  },
  deadline: {
    kind: 'unpublished',
    source: { kind: 'self' },
    note: 'The deadline is not published on the page. The only signal is the ARRL news RSS feed.',
  },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.arrl.org/club-grant-program',
  constraints: [
    {
      id: 'club-grant-affiliation',
      hard: true,
      fallbackRank: 0,
      rawText: 'Club must be ARRL-affiliated.',
      spec: { axis: 'arrl_membership', required: true, minYears: 0 },
    },
  ],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: true },
  aiPolicy: { stance: 'unaddressed' },
  trust: {
    status: 'unknown',
    sourceUrl: 'https://www.arrl.org/club-grant-program',
    lastVerifiedAt: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'manual_curation',
    contentHash: 'd1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    disputed: {
      note: 'Three researchers reached three different conclusions about the current cycle. Every reading is shown with its source; none is chosen.',
      claims: [
        {
          claim: 'Dormant. The page shows only 2024 results, with no open cycle and no application link.',
          sourceUrl: 'https://www.arrl.org/club-grant-program',
        },
        {
          claim: 'An autumn window. Historically Sep 7 - Nov 4 2022, described as "open until November 4".',
          sourceUrl: 'https://www.arrl.org/club-grant-program',
        },
        {
          claim: 'Feb 1-28, Jun 1-30, Oct 1-31. Probably a conflation with the separate ARRL Amateur Radio Grants cycle.',
          sourceUrl: 'http://www.arrl.org/amateur-radio-grants',
        },
      ],
    },
  },
  rawOtherText: 'The application portal is a JavaScript single-page app and returns no server-side text, so open/closed status cannot be determined programmatically.',
  tags: ['grant', 'arrl', 'club'],
};

export const chicagoFmScholarship: Program = {
  id: 'chicago-fm-club-scholarship',
  funderId: 'chicago-fm-club',
  name: 'Chicago FM Club Scholarship',
  klass: 'ham_scholarship',
  summary: 'Discontinued. Retained as a negative record so a future maintainer does not re-research it.',
  applicantEntities: ['individual'],
  amount: {
    instrument: 'unknown',
    amountRaw: 'Not published',
    awardCountRaw: 'Not published',
  },
  deadline: {
    kind: 'dormant',
    source: { kind: 'self' },
    note: 'No cycle. The program is discontinued.',
  },
  applyVia: 'none',
  constraints: [],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'unaddressed' },
  trust: {
    status: 'discontinued',
    sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
    lastVerifiedAt: '2026-01-05T00:00:00.000Z',
    verificationMethod: 'manual_curation',
    contentHash: 'e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    staleMirrorWarning: 'Zero hits in the live ARRL scholarship catalog, and no occurrence of the word "scholarship" on the club site. Still listed by 7 or more third-party aggregators, which mirror stale ARRL data.',
  },
  rawOtherText: '',
  tags: ['scholarship', 'discontinued'],
};

export const fixturePrograms: Program[] = [
  arrlScholarship,
  qcwaScholarship,
  ardcGrants,
  arrlClubGrant,
  chicagoFmScholarship,
];

/**
 * Insert the fixture funders and programs into a test database, through Plan 1's
 * repository factories. Hand-written INSERTs are forbidden here: `funders` and
 * `programs` both carry NOT NULL columns (`homepage`, `created_at`,
 * `updated_at`, `summary`, `applicant_entities`, …) that only the repositories
 * populate, and `programs` has no `data` column (RESOLUTIONS R1).
 *
 * Funders go in FIRST and unconditionally. `programs.funder_id` is a real
 * foreign key and `openDatabase` sets `PRAGMA foreign_keys = ON`, so a fixture
 * that assumes a `funders` row already exists works only where an earlier test
 * left one behind — which is precisely how the fresh-install approve crash hid
 * in this repo. `reindex.test.ts` runs this against a database that has only
 * ever been migrated, so the assumption cannot come back.
 */
export function seedFixtureCorpus(db: Database.Database): void {
  const funderRepo = createFunderRepo(db);
  for (const f of funders) funderRepo.upsert(f);

  const programRepo = createProgramRepo(db);
  for (const p of fixturePrograms) programRepo.upsert(p);
}

/**
 * RESOLUTIONS R19. `profiles.user_id` and `watches.user_id` are
 * `REFERENCES users(id) ON DELETE CASCADE` in Plan 1's 001-init.sql, and
 * `openDatabase` sets `PRAGMA foreign_keys = ON`, so a fixture that writes a
 * profile or a star for `u-member` without a `users` row fails the INSERT.
 *
 * Plan 1's `createUserRepo(db).create()` mints its own id; these tests pin ids
 * (`u-member`, `u-admin`, `u-other`) so the assertions can name them, hence the
 * explicit INSERT. Every NOT NULL / UNIQUE column in Plan 1's `users` DDL is
 * populated: `email_normalized` and `ics_token` are both UNIQUE and are derived
 * from the id so two calls never collide.
 */
export function seedTestUser(
  db: Database.Database,
  userId: string,
  role: 'admin' | 'member' = 'member',
  atISO = '2026-08-02T00:00:00.000Z',
): void {
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, email, email_normalized, password_hash, role, display_name,
        ics_token, disabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    userId,
    `${userId}@example.com`,
    `${userId}@example.com`,
    '$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture-not-a-real-hash',
    role,
    userId,
    `ics-${userId}`,
    atISO,
  );
}

/**
 * Star a program in a test database. RESOLUTIONS R19: `watches` has ON DELETE
 * CASCADE foreign keys to BOTH `users` and `programs`, so this helper makes sure
 * both parents exist before the star. It is the ONLY way Plan 3's fixtures write
 * to `watches` — a bare `INSERT INTO watches (...)` in a test file is a
 * foreign-key failure waiting for whichever fixture forgot a parent.
 *
 * The program is inserted only when it is ABSENT: several suites star a program
 * after deliberately mutating it (an approved candidate, a verified refetch),
 * and an unconditional upsert would quietly roll that mutation back.
 *
 * `notify_changes` is written explicitly rather than left to its DEFAULT 1, so
 * the column named in the conformance map is exercised by real inserts.
 */
export function starProgram(
  db: Database.Database,
  userId: string,
  programId: string,
  atISO: string,
): void {
  seedTestUser(db, userId);

  const present = db.prepare('SELECT 1 FROM programs WHERE id = ?').get(programId);
  if (present === undefined) {
    const program = fixturePrograms.find((p) => p.id === programId);
    if (program === undefined) {
      throw new Error(
        `starProgram: "${programId}" is neither in the database nor in ` +
          'fixturePrograms, so the watches foreign key to programs would fail. ' +
          'Seed the program first, or add it to the fixture corpus.',
      );
    }
    const funder = funders.find((f) => f.id === program.funderId);
    if (funder !== undefined) createFunderRepo(db).upsert(funder);
    createProgramRepo(db).upsert(program);
  }

  db.prepare(
    `INSERT INTO watches (id, user_id, program_id, notify_changes, created_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (user_id, program_id) DO NOTHING`,
  ).run(`${userId}:${programId}`, userId, programId, atISO);
}
