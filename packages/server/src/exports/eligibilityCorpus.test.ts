import { beforeAll, describe, expect, it } from 'vitest';
import type { ConstraintAxis, Profile, Program, StudentProfile } from '@grantspotter/core';
import { matchAll } from '@grantspotter/core';
import { PROFILES } from '../../../../scripts/profile-corpus.js';
import { buildEligibilityReport, type EligibilityReport } from './eligibility.js';
import { escapeHtml, renderEligibilityReportHtml } from './html.js';
import { loadExportCorpus, type ExportCorpus } from './testCorpus.js';

/**
 * THE ELIGIBILITY REPORT, RUN OVER THE REAL CORPUS.
 *
 * `eligibility.test.ts` proves the shaping against four hand-built records. This file proves the
 * only things that matter about the feature, and neither is provable against hand-built records:
 *
 *   1. The census a real applicant actually gets, per axis. 68 of 150 for a licensed EE
 *      undergraduate, with 36 of the exclusions on GEOGRAPHY — and geography excluding 36 is
 *      CORRECT. Those scholarships genuinely are ARRL-Division, Section and state restricted.
 *      Presenting a correct exclusion as a fixable gap would be the report lying in the applicant's
 *      favour, which is the same defect as lying against them.
 *   2. `unknown` is a real, common, honest state and NEVER a soft "no". An empty profile leaves
 *      117 of 150 unknown and excludes ZERO of them: every ineligible verdict it produces comes
 *      from the applicant-entity gate — a fact about the programme, not an unanswered question.
 *
 * These counts move when fixtures land. UPDATE them, never soften them: they are the same numbers
 * `npm run profile-corpus -- ee-undergrad` prints, and `corpus.test.ts` pins the population they
 * are taken from.
 */

let corpus: ExportCorpus;
let report: EligibilityReport;

const EE_UNDERGRAD = PROFILES.find((p) => p.key === 'ee-undergrad')!.profile;

/**
 * The six hard-bar axes this corpus actually carries enough of to test, each with the profile
 * field the matcher asks for. `institution`, `recommendation`, `arrl_membership` and `gender` are
 * hard axes too, but these six are the ones that bar the most records: 117, 106, 84, 27, 13 and 12
 * hard constraints respectively.
 */
const HARD_BAR_AXES: ConstraintAxis[] = [
  'license',
  'field_of_study',
  'geography',
  'citizenship',
  'gpa',
  'age_stage',
];

beforeAll(async () => {
  corpus = await loadExportCorpus();
  report = buildEligibilityReport(
    EE_UNDERGRAD,
    corpus.programs,
    corpus.funders,
    corpus.cyclesByProgramId,
    corpus.now,
  );
});

describe('the census a licensed EE undergraduate actually gets', () => {
  it('reports 68 eligible-or-preferred of 150', () => {
    expect(report.rows).toHaveLength(150);
    expect(report.counts).toEqual({
      eligible: 55,
      eligible_preferred: 13,
      unknown: 8,
      ineligible: 74,
    });
    expect(report.counts.eligible + report.counts.eligible_preferred).toBe(68);
  });

  it('breaks the exclusions down by axis: geography 36, other 28, then the small ones', () => {
    const byAxis = new Map<string, number>();
    for (const row of report.rows) {
      if (row.verdict !== 'ineligible') continue;
      for (const axis of new Set(row.reasonAxes.split('; ').filter((a) => a.length > 0))) {
        byAxis.set(axis, (byAxis.get(axis) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries([...byAxis].sort((a, b) => b[1] - a[1]))).toEqual({
      geography: 36,
      other: 28,
      age_stage: 5,
      field_of_study: 5,
      ham_activity: 1,
      gpa: 1,
    });
  });

  it('quotes the funder’s own sentence on every excluded record — nothing is refused silently', () => {
    const excluded = report.rows.filter((r) => r.verdict === 'ineligible');
    expect(excluded).toHaveLength(74);
    expect(excluded.every((r) => r.reasons.trim().length > 0)).toBe(true);
    expect(excluded.every((r) => r.reasonAxes.trim().length > 0)).toBe(true);
  });

  it('renders a geography exclusion as the funder’s own restriction, quoted', () => {
    const geo = report.rows.find(
      (r) => r.verdict === 'ineligible' && r.reasonAxes.includes('geography'),
    )!;
    // A real one: "Residence in ARRL Rocky Mountain Division (CO, NM, UT or WY)".
    expect(geo.reasons).toMatch(/ARRL|Division|Section|County|resident|Residence|[A-Z]{2}\b/);
    expect(geo.missingFields).toBe('');
    const html = renderEligibilityReportHtml(report);
    // The funder's sentence, verbatim, with the axis the product read it as beside it.
    expect(html).toContain(
      `<span class="axis">geography</span><span class="rawtext">${escapeHtml(geo.reasons)}</span>`,
    );
  });

  it('never files an ineligible record under "missing from your profile"', () => {
    // The two columns answer different questions and the report must not blur them: an exclusion
    // is something the funder decided, a missing field is something the reader can do.
    expect(report.rows.every((r) => r.verdict !== 'ineligible' || r.missingFields === '')).toBe(
      true,
    );
    expect(report.rows.every((r) => r.verdict !== 'unknown' || r.reasons === '')).toBe(true);
  });
});

describe('an unset profile field yields unknown, never ineligible', () => {
  let empty: EligibilityReport;
  let verdicts: ReturnType<typeof matchAll>;

  beforeAll(() => {
    const blank: StudentProfile = { kind: 'student' };
    empty = buildEligibilityReport(
      blank as Profile,
      corpus.programs,
      corpus.funders,
      corpus.cyclesByProgramId,
      corpus.now,
    );
    verdicts = matchAll(blank as Profile, corpus.programs, corpus.now);
  });

  it('leaves 117 of 150 unknown and refuses none of them', () => {
    expect(empty.counts).toEqual({
      eligible: 5,
      eligible_preferred: 0,
      unknown: 117,
      ineligible: 28,
    });
  });

  it('excludes ONLY on the applicant-entity gate, which is a fact and not an unanswered field', () => {
    const axes = new Set(
      empty.rows
        .filter((r) => r.verdict === 'ineligible')
        .flatMap((r) => r.reasonAxes.split('; ')),
    );
    expect([...axes]).toEqual(['other']);
  });

  it.each(HARD_BAR_AXES)(
    'a hard %s bar with nothing to check it against is unknown, never a refusal',
    (axis) => {
      const carriers = corpus.programs.filter((p: Program) =>
        p.constraints.some((c) => c.hard && c.spec.axis === axis),
      );
      // Non-vacuous: this axis really is a hard bar somewhere in the corpus.
      expect(carriers.length).toBeGreaterThan(0);

      const refusedOnThisAxis = carriers.filter((p) => {
        const v = verdicts.get(p.id);
        return v?.kind === 'ineligible' && v.reasons.some((c) => c.spec.axis === axis);
      });
      expect(refusedOnThisAxis).toEqual([]);

      // ...and at least one of them says so out loud rather than falling through to `eligible`.
      const said = carriers.filter((p) => verdicts.get(p.id)?.kind === 'unknown');
      expect(said.length).toBeGreaterThan(0);
    },
  );

  it('names the field each unknown is waiting on wherever the profile could supply one', () => {
    const unknowns = empty.rows.filter((r) => r.verdict === 'unknown');
    expect(unknowns).toHaveLength(117);
    expect(unknowns.every((r) => r.missingFields.length > 0)).toBe(true);
  });
});

describe('what the printed page says about the corpus it was built from', () => {
  it('never turns an unstated obligation into a funder’s "no"', () => {
    // Across the 150, `costShareRequired` is unstated on 148 and `false` on ZERO.
    const states = new Map<string, number>();
    for (const row of report.rows) states.set(row.costShare, (states.get(row.costShare) ?? 0) + 1);
    expect(states.get('unstated')).toBe(148);
    expect(states.get('not required') ?? 0).toBe(0);
    expect(renderEligibilityReportHtml(report)).not.toContain('not required');
  });

  it('marks a projected deadline as projected — only 4 of the corpus’ cycles are published', () => {
    const bases = new Set(report.rows.map((r) => r.deadlineBasis).filter((b) => b.length > 0));
    expect([...bases].some((b) => /estimated by GrantSpotter, not the funder/.test(b))).toBe(true);
  });

  it('renders 150 table rows and no suppressed record', () => {
    const html = renderEligibilityReportHtml(report);
    expect((html.match(/<tr>/g) ?? []).length).toBe(151); // 150 rows + the header row
    for (const suppressed of corpus.suppressedPrograms.slice(0, 25)) {
      expect(html).not.toContain(`>${suppressed.id}<`);
    }
  });
});
