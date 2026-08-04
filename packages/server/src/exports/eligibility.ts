/**
 * THE ELIGIBILITY REPORT — "you are ineligible for 74 of these, and here is the specific sentence
 * for each".
 *
 * Spec §5 names that sentence as the feature that makes this a professional tool rather than a
 * list, and everything in this module exists to render it honestly:
 *
 *   - Every exclusion carries the FUNDER'S OWN `rawText`, not a paraphrase. The reason a verdict
 *     can be trusted is that the reader can check the sentence it came from.
 *   - `unknown` is never rendered as a soft "no". It is a real and, for a half-filled profile, the
 *     overwhelmingly common state — an empty profile leaves 117 of 150 unknown and refuses zero of
 *     them — so its column says what the verdict is WAITING ON, and the two columns are never
 *     blurred: an exclusion is something the funder decided, a missing field is something the
 *     reader can do.
 *   - A geography exclusion (36 of the 74 for a licensed EE undergraduate) is CORRECT. Those
 *     scholarships genuinely are ARRL-Division, Section and state restricted. The page says so, so
 *     a correct exclusion is never presented as a fixable gap.
 *
 * ROW SHAPING IS NOT RE-ANSWERED HERE. Funder name, the funder's own calendar day, projected
 * versus published, the tri-state obligations and — critically — the suppression gate all come
 * from `buildExportRows` (`rows.ts`), the single funnel every export format in this package goes
 * through. This module adds the verdict and nothing else.
 *
 * DEVIATION FROM THE TASK BRIEF, twice, both for that reason:
 *   1. The brief mapped over `programs` directly, so the report had NO SUPPRESSION GATE — the same
 *      defect Task 1 found in the CSV filter. An eligibility report of the full stored corpus would
 *      publish 553 past awards as opportunities.
 *   2. The brief computed the next close date itself as `closesAt.slice(0, 10)`. That is the UTC
 *      slice `rows.ts` exists to prevent: the ARRL's "closes 28 February 2027" is stored as
 *      `2027-03-01T04:59:00.000Z` and prints one day LATE, telling an applicant they have a day
 *      they do not have.
 *
 * THIRD DEVIATION: `matchAll` is called with the report's own `nowISO`. The brief let it default
 * to `new Date()`, which makes an age-gated verdict disagree with the `generatedAt` stamp printed
 * at the top of the same page, and makes the report irreproducible.
 */
import { matchAll } from '@grantspotter/core';
import type {
  Cycle,
  Funder,
  OpportunityClass,
  Profile,
  Program,
  Verdict,
} from '@grantspotter/core';
import { toCsv } from './csv.js';
import { buildExportRows } from './rows.js';

/** PLAN-LOCAL. */
export interface EligibilityRow {
  programId: string;
  programName: string;
  funderName: string;
  klass: OpportunityClass;
  verdict: Verdict['kind'];
  /** The soft-preference rank, for `eligible_preferred` only. Preferences rank; they never bar. */
  rank: string;
  /** The funder's own wording for each soft preference this profile met. */
  metPreferences: string;
  /** The axis of each hard constraint that excluded this applicant, `; `-separated. */
  reasonAxes: string;
  /** The funder's own sentence for each of those constraints, ` | `-separated. */
  reasons: string;
  /** What an `unknown` is WAITING ON. Never a promise that filling it produces an answer. */
  missingFields: string;
  /** The funder's own calendar day, from the shared row model. */
  nextCloses: string;
  /** Whether that day is one the funder published or one GrantSpotter projected. */
  deadlineBasis: string;
  amountRaw: string;
  /** Tri-state. `unstated` is not `not required`; across the corpus it is unstated on 148 of 150. */
  costShare: string;
  applyUrl: string;
  sourceUrl: string;
  lastVerifiedAt: string;
}

/** PLAN-LOCAL. */
export interface EligibilityReport {
  generatedAt: string;
  profileKind: 'student' | 'organization';
  counts: { eligible: number; eligible_preferred: number; ineligible: number; unknown: number };
  rows: EligibilityRow[];
}

export const ELIGIBILITY_CSV_COLUMNS = [
  'programId',
  'programName',
  'funderName',
  'klass',
  'verdict',
  'rank',
  'metPreferences',
  'reasonAxes',
  'reasons',
  'missingFields',
  'nextCloses',
  'deadlineBasis',
  'amountRaw',
  'costShare',
  'applyUrl',
  'sourceUrl',
  'lastVerifiedAt',
] as const;

/**
 * Eligible first, then preferred, then unknown, then ineligible.
 *
 * `unknown` sits ABOVE `ineligible` on purpose. It is not a weaker refusal; it is not a refusal at
 * all, and burying it under 74 exclusions would tell the reader by layout what the copy explicitly
 * denies.
 */
const VERDICT_ORDER: Record<Verdict['kind'], number> = {
  eligible: 0,
  eligible_preferred: 1,
  unknown: 2,
  ineligible: 3,
};

export function buildEligibilityReport(
  profile: Profile,
  programs: readonly Program[],
  funders: readonly Funder[],
  cyclesByProgramId: ReadonlyMap<string, Cycle[]>,
  nowISO: string,
): EligibilityReport {
  // The gate runs here, once, and it is not optional. Everything downstream sees only what may
  // leave, so the matcher is never even asked about a record the reader must not be shown.
  const exportRows = buildExportRows(programs, funders, cyclesByProgramId);
  const verdicts = matchAll(
    profile,
    exportRows.map((r) => r.program),
    nowISO,
  );
  const counts = { eligible: 0, eligible_preferred: 0, ineligible: 0, unknown: 0 };

  const rows: EligibilityRow[] = exportRows.map(({ program, funderName, cells }) => {
    const verdict: Verdict = verdicts.get(program.id) ?? {
      kind: 'unknown',
      missingProfileFields: [],
    };
    counts[verdict.kind] += 1;

    const metById = new Map(program.constraints.map((c) => [c.id, c]));
    return {
      programId: program.id,
      programName: program.name,
      funderName,
      klass: program.klass,
      verdict: verdict.kind,
      rank: verdict.kind === 'eligible_preferred' ? String(verdict.rank) : '',
      metPreferences:
        verdict.kind === 'eligible_preferred'
          ? verdict.met
              .map((id) => metById.get(id)?.rawText ?? id)
              .filter((t) => t.length > 0)
              .join(' | ')
          : '',
      reasonAxes:
        verdict.kind === 'ineligible'
          ? [...new Set(verdict.reasons.map((c) => c.spec.axis))].join('; ')
          : '',
      reasons: verdict.kind === 'ineligible' ? verdict.reasons.map((c) => c.rawText).join(' | ') : '',
      missingFields: verdict.kind === 'unknown' ? verdict.missingProfileFields.join('; ') : '',
      nextCloses: cells.nextCloses,
      deadlineBasis: cells.deadlineBasis,
      amountRaw: cells.amountRaw,
      costShare: cells.costShareRequired,
      applyUrl: cells.applyUrl,
      sourceUrl: cells.sourceUrl,
      lastVerifiedAt: cells.lastVerifiedAt,
    };
  });

  rows.sort((a, b) => {
    const byVerdict = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
    if (byVerdict !== 0) return byVerdict;
    const byName = a.programName.localeCompare(b.programName);
    // Ties break on id so two runs of the same report produce the same file.
    return byName !== 0 ? byName : a.programId.localeCompare(b.programId);
  });

  return { generatedAt: nowISO, profileKind: profile.kind, counts, rows };
}

export function eligibilityReportToCsv(report: EligibilityReport): string {
  const rows = report.rows.map((r) => ({ ...r })) as unknown as Array<Record<string, string>>;
  return toCsv(rows, [...ELIGIBILITY_CSV_COLUMNS]);
}
