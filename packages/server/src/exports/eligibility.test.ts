import { describe, expect, it } from 'vitest';
import type { Constraint, Cycle, Profile, StudentProfile } from '@grantspotter/core';
import {
  ELIGIBILITY_CSV_COLUMNS,
  buildEligibilityReport,
  eligibilityReportToCsv,
} from './eligibility.js';
import { escapeHtml, renderEligibilityReportHtml } from './html.js';
import { makeCycle, makeFunder, makeProgram, makeSuppressedProgram } from './testFixtures.js';

/**
 * DEVIATION FROM THE TASK BRIEF: no `vi.mock('@grantspotter/core')`.
 *
 * The brief stubbed `matchAll` with a lookup table keyed by programme id. That tests the report's
 * plumbing and nothing else — in particular it cannot test the one claim this report exists to
 * make, that an UNSET PROFILE FIELD PRODUCES `unknown` AND NEVER `ineligible`, because a stub
 * decides that answer by hand. Worse, a stubbed matcher cannot drift into disagreement with the
 * real one, so the suite would stay green through a matcher change that silently turned unknowns
 * into refusals.
 *
 * So the four verdicts below are produced by the REAL matcher from real constraints:
 *   - eligible            — a programme with no constraints at all;
 *   - eligible_preferred  — a SOFT constraint that passes (soft constraints rank, never exclude);
 *   - ineligible          — a hard licence bar the profile provably fails (TECH < GENERAL);
 *   - unknown             — a hard GPA floor and a profile with no `gpa` recorded.
 *
 * `eligibilityCorpus.test.ts` then repeats the exercise against all 150 publishable records.
 */

function constraint(over: Partial<Constraint> & Pick<Constraint, 'spec'>): Constraint {
  return { id: 'c-1', hard: true, fallbackRank: 0, rawText: '', ...over };
}

const LICENCE_TEXT = 'Applicant must hold a General class licence or higher.';
const PREFERENCE_TEXT = 'Preference is given to residents of Texas.';
const GPA_TEXT = 'A cumulative grade point average of 3.0 or better is required.';

const PROGRAMS = [
  makeProgram({
    id: 'p-eligible',
    name: 'Eligible Program',
    applicantEntities: ['individual'],
    constraints: [],
  }),
  makeProgram({
    id: 'p-preferred',
    name: 'Preferred Program',
    applicantEntities: ['individual'],
    constraints: [
      constraint({
        id: 'c-geo',
        hard: false,
        fallbackRank: 2,
        rawText: PREFERENCE_TEXT,
        spec: { axis: 'geography', geo: { type: 'state', values: ['TX'] } },
      }),
    ],
  }),
  makeProgram({
    id: 'p-ineligible',
    name: 'Ineligible Program',
    applicantEntities: ['individual'],
    constraints: [
      constraint({
        id: 'c-license',
        rawText: LICENCE_TEXT,
        spec: { axis: 'license', licenseMin: 'GENERAL' },
      }),
    ],
  }),
  makeProgram({
    id: 'p-unknown',
    name: 'Unknown Program',
    applicantEntities: ['individual'],
    constraints: [
      constraint({ id: 'c-gpa', rawText: GPA_TEXT, spec: { axis: 'gpa', min: 3.0 } }),
    ],
  }),
];

const PROFILE: StudentProfile = {
  kind: 'student',
  callsign: 'W8UM',
  licenseClass: 'TECH',
  state: 'TX',
};
const FUNDERS = [makeFunder()];
const CYCLES = new Map<string, Cycle[]>([['p-eligible', [makeCycle({ programId: 'p-eligible' })]]]);
const NOW = '2026-08-02T12:00:00.000Z';

const report = (): ReturnType<typeof buildEligibilityReport> =>
  buildEligibilityReport(PROFILE as Profile, PROGRAMS, FUNDERS, CYCLES, NOW);

describe('buildEligibilityReport', () => {
  it('counts each verdict kind', () => {
    const r = report();
    expect(r.counts).toEqual({ eligible: 1, eligible_preferred: 1, ineligible: 1, unknown: 1 });
    expect(r.profileKind).toBe('student');
    expect(r.generatedAt).toBe(NOW);
  });

  it('records the specific constraint text that excluded an ineligible program', () => {
    const row = report().rows.find((x) => x.programId === 'p-ineligible')!;
    expect(row.verdict).toBe('ineligible');
    expect(row.reasons).toContain('General class licence');
    expect(row.reasonAxes).toBe('license');
  });

  it('records what an unknown is WAITING ON, and never calls it ineligible', () => {
    const row = report().rows.find((x) => x.programId === 'p-unknown')!;
    expect(row.verdict).toBe('unknown');
    expect(row.missingFields).toBe('gpa');
    // No reasons: nothing excluded this applicant. An empty "why not" cell and an `unknown`
    // verdict are the same claim said twice, on purpose.
    expect(row.reasons).toBe('');
  });

  it('orders rows eligible, preferred, unknown, ineligible', () => {
    expect(report().rows.map((x) => x.verdict)).toEqual([
      'eligible',
      'eligible_preferred',
      'unknown',
      'ineligible',
    ]);
  });

  it('resolves the funder name and the next close date', () => {
    const row = report().rows[0];
    expect(row.funderName).toBe('Amateur Radio Digital Communications');
    expect(row.nextCloses).toBe('2027-02-01');
  });

  it('carries a preferred verdict as a RANK, never as a bar', () => {
    const row = report().rows.find((x) => x.programId === 'p-preferred')!;
    expect(row.verdict).toBe('eligible_preferred');
    expect(row.rank).toBe('2');
    expect(row.reasons).toBe('');
    expect(row.metPreferences).toContain(PREFERENCE_TEXT);
  });

  it('SUPPRESSES the records that may never leave, exactly as every other export does', () => {
    const suppressed = makeSuppressedProgram({ applicantEntities: ['individual'] });
    const withSuppressed = buildEligibilityReport(
      PROFILE as Profile,
      [...PROGRAMS, suppressed],
      FUNDERS,
      CYCLES,
      NOW,
    );
    expect(withSuppressed.rows.map((x) => x.programId)).not.toContain(suppressed.id);
    // Task 1's standard: appending the suppressed set changes nothing at all.
    expect(JSON.stringify(withSuppressed)).toBe(JSON.stringify(report()));
  });

  it('renders the funder’s own calendar day, not a UTC slice of the instant', () => {
    // 2027-02-28 23:59 America/New_York. Sliced from the UTC instant this prints 2027-03-01 —
    // one day LATE, which hands an applicant a day they do not have. `rows.ts` answers this once.
    const cycles = new Map<string, Cycle[]>([
      [
        'p-eligible',
        [
          makeCycle({
            programId: 'p-eligible',
            closesAt: '2027-03-01T04:59:00.000Z',
            timezone: 'America/New_York',
          }),
        ],
      ],
    ]);
    const r = buildEligibilityReport(PROFILE as Profile, PROGRAMS, FUNDERS, cycles, NOW);
    expect(r.rows.find((x) => x.programId === 'p-eligible')!.nextCloses).toBe('2027-02-28');
  });

  it('says a projected deadline is projected', () => {
    const cycles = new Map<string, Cycle[]>([
      ['p-eligible', [makeCycle({ programId: 'p-eligible', isEstimated: true })]],
    ]);
    const r = buildEligibilityReport(PROFILE as Profile, PROGRAMS, FUNDERS, cycles, NOW);
    const row = r.rows.find((x) => x.programId === 'p-eligible')!;
    expect(row.deadlineBasis).toMatch(/estimated by GrantSpotter, not the funder/);
  });

  it('prints an unstated cost share as unstated, never as "not required"', () => {
    const row = report().rows[0];
    expect(row.costShare).toBe('unstated');
    expect(row.costShare).not.toMatch(/not required/);
  });
});

describe('eligibilityReportToCsv', () => {
  it('writes a header and one row per program', () => {
    const csv = eligibilityReportToCsv(report());
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('verdict');
    expect(lines[0]).toContain('reasons');
  });

  it('writes every declared column, and the funder’s own sentence inside one of them', () => {
    const csv = eligibilityReportToCsv(report());
    const header = csv.trimEnd().split('\r\n')[0].split(',');
    expect(header).toEqual([...ELIGIBILITY_CSV_COLUMNS]);
    expect(csv).toContain(LICENCE_TEXT);
  });
});

describe('escapeHtml', () => {
  it('escapes the five XML entities', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('renderEligibilityReportHtml', () => {
  const html = renderEligibilityReportHtml(report());

  it('is a standalone document with the print stylesheet inlined', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('@media print');
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it('carries a Print / Save as PDF button that is hidden when printing', () => {
    expect(html).toContain('Print / Save as PDF');
    expect(html).toContain('class="no-print"');
  });

  it('shows the counts and the funder’s own sentence for each verdict', () => {
    expect(html).toContain('Eligible');
    expect(html).toContain('General class licence');
    expect(html).toContain('gpa');
  });

  it('quotes the constraint as the funder wrote it, and names the axis beside it', () => {
    expect(html).toContain(escapeHtml(LICENCE_TEXT));
    expect(html).toContain('license');
  });

  it('WORDS AN UNKNOWN AS "WAITING ON" — never as a resolution it cannot promise', () => {
    // The matcher stops at the first axis it cannot decide, so answering one field commonly moves
    // a verdict from one unknown to a DIFFERENT unknown. `UnknownFields.tsx` and `VerdictBadge`
    // already hold this line on screen; a printed report a student takes to a funder must not
    // undo it.
    expect(html).toMatch(/waiting on/i);
    expect(html).not.toMatch(/becomes? an answer|will resolve|the verdict resolves|guarantee/i);
  });

  it('does not present an unknown as a soft no', () => {
    expect(html).toMatch(/not a (rejection|&ldquo;no&rdquo;|"no")/i);
  });

  it('says a geography exclusion is a real restriction, not a gap in the profile', () => {
    expect(html).toMatch(/genuinely restricted|really are restricted|is not a gap/i);
    expect(html).toMatch(/ARRL Division|Section|state/i);
  });

  it('escapes program names so a hostile record cannot inject markup', () => {
    const evil = buildEligibilityReport(
      PROFILE as Profile,
      [makeProgram({ id: 'p-eligible', name: '<script>alert(1)</script>', applicantEntities: ['individual'] })],
      FUNDERS,
      CYCLES,
      NOW,
    );
    const out = renderEligibilityReportHtml(evil);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('refuses to render a non-http(s) address as a live anchor', () => {
    const hostile = buildEligibilityReport(
      PROFILE as Profile,
      [
        makeProgram({
          id: 'p-eligible',
          applicantEntities: ['individual'],
          applyUrl: 'javascript:alert(1)',
        }),
      ],
      FUNDERS,
      CYCLES,
      NOW,
    );
    const out = renderEligibilityReportHtml(hostile);
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain('javascript:alert(1)'); // shown as text, so the reader can see it
  });

  it('refuses to link a blocklisted host, and says why', () => {
    const far = buildEligibilityReport(
      PROFILE as Profile,
      [
        makeProgram({
          id: 'p-eligible',
          applicantEntities: ['individual'],
          applyUrl: 'https://www.farweb.org/scholarships',
        }),
      ],
      FUNDERS,
      CYCLES,
      NOW,
    );
    const out = renderEligibilityReportHtml(far);
    expect(out).not.toContain('href="https://www.farweb.org/scholarships"');
    expect(out).toMatch(/do not visit|not safe to visit/i);
  });
});

/**
 * THE TWO ROUTES BESIDE THE ONE THE SPEC RECORDS — `ConstraintAlternatives`, in the report and in
 * the file.
 *
 * `anyOf` and `orUnrepresented` arrived in core with the extractors that emit them and NO reader:
 * `grep -rn "anyOf\|orUnrepresented" packages/web/src packages/server/src/exports
 * packages/server/src/api` found zero references the day before this block was written. So a
 * printed report of "Resident of Brevard County FL, or any FL resident" named `geography` and the
 * funder's sentence and said nothing about the second route the matcher was actually applying, and
 * a verdict that stopped at `unknown` because the funder named a route this schema cannot check
 * gave the reader no way to learn that — which is a fact a person could act on.
 *
 * The two are disjoint by verdict and stay in separate columns: `anyOf` can only turn a refusal
 * into a pass, so it is read off the reasons of an `ineligible` row; `orUnrepresented` can only
 * turn a refusal into an `unknown`, so it is read off the record of an `unknown` one.
 */
const DISJUNCTION_PROGRAMS = [
  makeProgram({
    id: 'p-brevard',
    name: 'IRARC Memorial Scholarship',
    applicantEntities: ['individual'],
    constraints: [
      constraint({
        id: 'c-geo',
        rawText: 'Resident of Brevard County FL, or any FL resident.',
        spec: {
          axis: 'geography',
          geo: { type: 'county', values: ['Brevard, FL'] },
          anyOf: [{ axis: 'geography', geo: { type: 'state', values: ['FL'] } }],
        },
      }),
    ],
  }),
  makeProgram({
    id: 'p-rodriguez',
    name: 'Robert A. Rodriguez K5AUW Scholarship',
    applicantEntities: ['individual'],
    constraints: [
      constraint({
        id: 'c-stage',
        rawText:
          'The scholarship is open to graduating high school seniors, and to previous awardees.',
        spec: { axis: 'age_stage', stages: ['HS_SENIOR'], orUnrepresented: 'previous awardees' },
      }),
    ],
  }),
  makeProgram({
    id: 'p-plain',
    name: 'Ordinary Program',
    applicantEntities: ['individual'],
    constraints: [
      constraint({
        id: 'c-license',
        rawText: LICENCE_TEXT,
        spec: { axis: 'license', licenseMin: 'GENERAL' },
      }),
    ],
  }),
];

/** A Texan Tech: fails Brevard AND fails FL, is not an HS senior, and holds less than General. */
const OHIO_PROFILE: StudentProfile = {
  kind: 'student',
  callsign: 'W8UM',
  licenseClass: 'TECH',
  state: 'OH',
  county: 'Franklin',
  stage: 'UNDERGRAD',
};

const disjunctionReport = (): ReturnType<typeof buildEligibilityReport> =>
  buildEligibilityReport(OHIO_PROFILE as Profile, DISJUNCTION_PROGRAMS, FUNDERS, new Map(), NOW);

describe('the routes beside the one the spec records', () => {
  it('names the other route the funder gave, on the row the narrower one excluded', () => {
    const row = disjunctionReport().rows.find((r) => r.programId === 'p-brevard')!;
    expect(row.verdict).toBe('ineligible');
    expect(row.alsoAcceptedRoutes).toBe(
      'GrantSpotter also treats the geography rule as satisfied by state FL — ' +
        'the funder named more than one route.',
    );
    // The funder's own column is untouched: their sentence is theirs, and it already said so.
    expect(row.reasons).toBe('Resident of Brevard County FL, or any FL resident.');
    expect(row.reasonsFromGrantSpotter).toBe('');
  });

  it('names the route it cannot check, on a verdict that stopped at unknown because of it', () => {
    const row = disjunctionReport().rows.find((r) => r.programId === 'p-rodriguez')!;
    expect(row.verdict).toBe('unknown');
    // Nothing to fill in: "previous awardee" is not a value of any field a profile holds.
    expect(row.missingFields).toBe('');
    expect(row.uncheckableRoutes).toBe(
      'GrantSpotter cannot check a route this funder named: previous awardees. ' +
        'That is a reason a verdict stops at unknown rather than at no.',
    );
  });

  it('says nothing extra about a rule that states one thing', () => {
    const row = disjunctionReport().rows.find((r) => r.programId === 'p-plain')!;
    expect(row.alsoAcceptedRoutes).toBe('');
    expect(row.uncheckableRoutes).toBe('');
  });

  /**
   * A CSV CELL HAS NO STYLING. On screen a dashed rule and a tag can carry the attribution; a cell
   * dropped into a mail merge or an email to a funder arrives with nothing but its characters. So
   * the word GrantSpotter is INSIDE the sentence, not in the column header — which does not travel
   * with the cell — and the funder's own columns never acquire a sentence this software wrote.
   */
  it('carries its attribution inside the cell, where a spreadsheet cannot strip it', () => {
    const csv = eligibilityReportToCsv(disjunctionReport());
    const header = csv.trimEnd().split('\r\n')[0].split(',');
    expect(header).toEqual([...ELIGIBILITY_CSV_COLUMNS]);
    expect(header).toContain('alsoAcceptedRoutes');
    expect(header).toContain('uncheckableRoutes');
    for (const row of disjunctionReport().rows) {
      if (row.alsoAcceptedRoutes !== '') expect(row.alsoAcceptedRoutes).toContain('GrantSpotter');
      if (row.uncheckableRoutes !== '') expect(row.uncheckableRoutes).toContain('GrantSpotter');
      // ...and neither ever leaks into the column headed with the funder's words.
      expect(row.reasons).not.toContain('GrantSpotter');
    }
  });

  it('keeps both out of the printed report’s verbatim class, and explains them in the footer', () => {
    const html = renderEligibilityReportHtml(disjunctionReport());
    expect(html).toContain(
      '<span class="alt-route">GrantSpotter also treats this as satisfied by state FL — ' +
        'the funder named more than one route.</span>',
    );
    expect(html).toContain('GrantSpotter cannot check a route this funder named: previous awardees');
    // `.rawtext` means "the funder published these exact words" and may wrap nothing else.
    const rawtexts = [...html.matchAll(/<span class="rawtext">(.*?)<\/span>/g)].map((m) => m[1]);
    expect(rawtexts.length).toBeGreaterThan(0);
    for (const quoted of rawtexts) expect(quoted).not.toContain('GrantSpotter');
    // A reader of the printed page has no hover and no legend, so the footer says what both are.
    expect(html).toContain('GrantSpotter also treats this as satisfied by&hellip;');
    expect(html).toContain('GrantSpotter cannot check a route this funder named&hellip;');
  });
});
