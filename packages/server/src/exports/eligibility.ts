/**
 * THE ELIGIBILITY REPORT — "you are ineligible for 55 of these, and here is the specific sentence
 * for each".
 *
 * Spec §5 names that sentence as the feature that makes this a professional tool rather than a
 * list, and everything in this module exists to render it honestly:
 *
 *   - An exclusion the funder wrote carries the FUNDER'S OWN `rawText`, not a paraphrase. The
 *     reason a verdict can be trusted is that the reader can check the sentence it came from.
 *
 *     AND AN EXCLUSION GRANTSPOTTER WROTE IS KEPT OUT OF THAT COLUMN ENTIRELY. One reason in this
 *     product is composed at match time rather than read off a page — the applicant-entity gate —
 *     and it used to arrive with a `rawText` in the funder's voice. Measured, before the fix: a
 *     collegiate 501(c)(3) club's report carried 145 ineligible rows and 144 of them quoted a
 *     sentence GrantSpotter had written, 125 of those reproducing raw enum identifiers ("This
 *     program accepts applications from: ieee_student_branch_chapter.") under a column headed
 *     "Why not, in the funder's words". `reasons` now holds only what a funder wrote and
 *     `reasonsFromGrantSpotter` holds what this software wrote, in two columns that can never be
 *     read as each other.
 *   - `unknown` is never rendered as a soft "no". It is a real and, for a half-filled profile, the
 *     overwhelmingly common state — an empty profile leaves 136 of 150 unknown and refuses 9, every
 *     one of those 9 on an audience somebody researched — so its column says what the verdict is
 *     WAITING ON, and the two columns are never blurred: an exclusion is something the funder
 *     decided, a missing field is something the reader can do.
 *   - A geography exclusion (36 of the 55 for a licensed EE undergraduate) is CORRECT. Those
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
import { hasFunderWording, isApplicantEntityConstraint, matchAll } from '@grantspotter/core';
import type {
  Constraint,
  ConstraintTier,
  Cycle,
  Funder,
  OpportunityClass,
  Profile,
  Program,
  Verdict,
} from '@grantspotter/core';
import { toCsv } from './csv.js';
import { buildExportRows } from './rows.js';

/**
 * One reason, kept apart into the two things it can be. The HTML report needs them structured
 * (the flat `reasons` string was split back apart on ` | ` and paired with a DEDUPED axis list by
 * index, which mislabels the moment one program is barred on two axes with three constraints);
 * the CSV needs them flattened into two columns that cannot be mistaken for one another.
 */
export interface EligibilityReason {
  /** `applicant_entity`, or the `ConstraintAxis` the product read the rule as. */
  axis: string;
  /** The funder's verbatim sentence. Empty when no funder wrote one. */
  quoted: string;
  /** GrantSpotter's own statement about the record. Empty when the funder's sentence stands. */
  authored: string;
  /**
   * THE OTHER ROUTES THE FUNDER NAMED FOR THE SAME RULE — `ConstraintAlternatives.anyOf`, each
   * restated as a compact phrase, in the order the funder wrote them. Empty for the constraints
   * that state one thing, which is all but six in the shipped corpus.
   *
   * A THIRD FIELD RATHER THAN TEXT APPENDED TO `authored`, for the reason `authored` exists at all:
   * that column means "no funder sentence was recorded for this reason, so read GrantSpotter's
   * instead", and these constraints DO carry a funder sentence — the alternative is beside the
   * quote, not in place of it. Folding them together would put a `GrantSpotter, not the funder` tag
   * on rows whose quotation is perfectly real.
   */
  alsoAccepts: string[];
}

/**
 * ONE TIER, AS A COMPACT PHRASE — for the alternatives column and the printed reason cell.
 *
 * NOT A SENTENCE, and deliberately not the same rendering as `IneligibilityDrawer.tierDetail` in
 * `packages/web`. The screen has a paragraph and a reader looking at one programme; a report cell
 * and a spreadsheet column have neither, and "Needs EXTRA or higher, held at least 0 months." in a
 * cell beside forty others is noise where `licence EXTRA or higher` is a fact. The two renderings
 * answer to different audiences and are allowed to differ; what they may NOT do is disagree about
 * WHICH tiers exist, and neither invents or drops one — both map over `spec.anyOf` entire.
 *
 * `web -> core` and `server -> core`, never `web -> server`, so there is no third place to put a
 * shared one that both could reach. The exhaustive `switch` is what keeps this honest: an axis
 * added to core's union fails the typecheck here rather than printing an empty cell.
 */
function tierSummary(tier: ConstraintTier): string {
  switch (tier.axis) {
    case 'license':
      return tier.heldMonthsMin !== undefined
        ? `licence ${tier.licenseMin} or higher, held ${tier.heldMonthsMin} months`
        : `licence ${tier.licenseMin} or higher`;
    case 'geography':
      if (tier.geo.type === 'any') return 'anywhere';
      if (tier.geo.type === 'radius') {
        return `within ${tier.geo.radiusMiles} miles of ${tier.geo.centerLabel ?? 'the stated point'}`;
      }
      return `${tier.geo.type.replace(/_/g, ' ')} ${tier.geo.values.join(', ')}`;
    case 'field_of_study':
      if (tier.excludedFields.length > 0) {
        return tier.fields.length > 0
          ? `field of study ${tier.fields.join(', ')}, excluding ${tier.excludedFields.join(', ')}`
          : `any field of study except ${tier.excludedFields.join(', ')}`;
      }
      return tier.fields.length > 0
        ? `field of study ${tier.fields.join(', ')}`
        : 'any field of study';
    case 'institution':
      return `degree level ${tier.degreeLevels.join(', ')}`;
    case 'gpa':
      if (tier.min !== undefined) return `GPA ${tier.min} or higher`;
      if (tier.classRankTopPct !== undefined) return `top ${tier.classRankTopPct}% of class`;
      return 'GPA or class rank';
    case 'arrl_membership':
      return tier.minYears > 0 ? `ARRL member ${tier.minYears} year(s)` : 'ARRL member';
    case 'recommendation':
      return `${tier.count} recommendation(s) from ${tier.recommenderType.replace(/_/g, ' ')}`;
    case 'citizenship':
      return `citizenship ${tier.allowed.join(', ')}`;
    case 'age_stage':
      return `stage ${tier.stages.join(', ')}`;
    case 'ham_activity':
      return `activity in ${tier.activityKinds.join(', ')}`;
    case 'gender':
      return `open to ${tier.allowed.join(', ')}`;
    case 'financial_need':
      return 'financial need';
    case 'other':
      return tier.note === '' ? 'a requirement with no wording on record' : tier.note;
  }
}

/**
 * `spec.axis` is `'other'` for the applicant-entity constraint, because CONTRACT §3 has no axis
 * for a gate the matcher invents. Filing it under the long-tail bucket made a club's whole report
 * read `other`, which is the axis name for "a requirement no schema captures" — a different and
 * untrue claim about where the exclusion came from.
 */
export const APPLICANT_ENTITY_AXIS_KEY = 'applicant_entity';

function reasonAxisKey(constraint: Constraint): string {
  return isApplicantEntityConstraint(constraint) ? APPLICANT_ENTITY_AXIS_KEY : constraint.spec.axis;
}

function reasonDetail(constraint: Constraint): EligibilityReason {
  const authored =
    constraint.spec.axis === 'other' && !hasFunderWording(constraint) ? constraint.spec.note : '';
  return {
    axis: reasonAxisKey(constraint),
    quoted: hasFunderWording(constraint) ? constraint.rawText : '',
    authored,
    alsoAccepts: (constraint.spec.anyOf ?? []).map(tierSummary),
  };
}

/**
 * The alternatives as ONE CELL, with the attribution inside the sentence.
 *
 * A CSV CELL HAS NO STYLING. On screen a dashed rule and a tag can say whose words these are; in a
 * spreadsheet the cell is dropped into a mail merge, a slide, an email to a funder, and arrives
 * carrying nothing but its characters. So the word GrantSpotter is in the sentence — not in the
 * column header, which does not travel with the cell — for the same reason
 * `reasonsFromGrantSpotter` is a separate column rather than a marker inside `reasons`.
 */
export function alsoAcceptsCell(details: readonly EligibilityReason[]): string {
  return details
    .filter((detail) => detail.alsoAccepts.length > 0)
    .map(
      (detail) =>
        `GrantSpotter also treats the ${detail.axis} rule as satisfied by ` +
        `${detail.alsoAccepts.join('; or ')} — the funder named more than one route.`,
    )
    .join(' | ');
}

/**
 * A route the funder named that this schema cannot check, as one cell — attribution inside the
 * sentence, for the reason {@link alsoAcceptsCell} gives.
 *
 * ONLY FOR `unknown` ROWS, and it does not claim to be the cause. `orUnrepresented` can only turn a
 * refusal into an `unknown`, never into a `pass` and never into a refusal, so on an `eligible` row
 * it is irrelevant and on an `ineligible` row the constraint holding it is not among the reasons.
 * On an `unknown` row it is a true statement about the record and the one an applicant can act on;
 * whether it is what stopped THIS verdict is not something `Verdict.unknown` records, and this
 * sentence does not pretend otherwise.
 */
export function uncheckableRoutesCell(program: Program): string {
  return program.constraints
    .map((constraint) => constraint.spec.orUnrepresented)
    .filter((route): route is string => route !== undefined && route.trim() !== '')
    .map(
      (route) =>
        `GrantSpotter cannot check a route this funder named: ${route}. ` +
        'That is a reason a verdict stops at unknown rather than at no.',
    )
    .join(' | ');
}

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
  /**
   * The funder's own sentence for each of those constraints, ` | `-separated. ONLY the funder's:
   * a constraint GrantSpotter composed contributes nothing here, however plausible its wording.
   */
  reasons: string;
  /**
   * What GRANTSPOTTER said, for the reasons no funder wrote — ` | `-separated. A separate column
   * rather than a marker inside `reasons` because a spreadsheet reader sorts, filters and quotes
   * one column at a time, and "the funder said this" is exactly the claim that must not survive
   * being copied out of its context.
   */
  reasonsFromGrantSpotter: string;
  /**
   * The OTHER routes the funder named for a rule that excluded this applicant — `anyOf`, restated
   * by GrantSpotter, attribution inside the sentence. Empty on every row whose reasons state one
   * thing each, which is all but a handful.
   *
   * IT IS HERE BECAUSE THE STRUCTURED LINE WAS NARROWER THAN THE RULE. "Resident of Brevard County
   * FL, or any FL resident" reached this file as `geography` + the funder's sentence, and every
   * structured restatement of it said Brevard County — a requirement narrower than the one the
   * matcher applies, which is how an applicant reads a "no" into a rule that would have let them in.
   */
  alsoAcceptedRoutes: string;
  /**
   * A route the funder named that no rule here can check — `orUnrepresented`, on `unknown` rows.
   * The other half of the same silence: a verdict that stops at unknown for this reason named
   * nothing a reader could act on, and "previous awardees" is very much something a reader can act
   * on. See {@link uncheckableRoutesCell} for why it is not presented as the cause.
   */
  uncheckableRoutes: string;
  /**
   * The same reasons, structured, for `renderEligibilityReportHtml`. NOT a CSV column: `toCsv`
   * takes only the names in {@link ELIGIBILITY_CSV_COLUMNS}, so this never reaches the file.
   */
  reasonDetails: EligibilityReason[];
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
  'reasonsFromGrantSpotter',
  'alsoAcceptedRoutes',
  'missingFields',
  'uncheckableRoutes',
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
    const details = verdict.kind === 'ineligible' ? verdict.reasons.map(reasonDetail) : [];
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
      reasonAxes: [...new Set(details.map((d) => d.axis))].join('; '),
      reasons: details
        .map((d) => d.quoted)
        .filter((t) => t !== '')
        .join(' | '),
      reasonsFromGrantSpotter: details
        .map((d) => d.authored)
        .filter((t) => t !== '')
        .join(' | '),
      alsoAcceptedRoutes: alsoAcceptsCell(details),
      reasonDetails: details,
      missingFields: verdict.kind === 'unknown' ? verdict.missingProfileFields.join('; ') : '',
      uncheckableRoutes: verdict.kind === 'unknown' ? uncheckableRoutesCell(program) : '',
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
