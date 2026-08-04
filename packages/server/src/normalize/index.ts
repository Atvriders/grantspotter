import type {
  AiPolicy,
  AmountSpec,
  ApplicantEntity,
  ApplyVia,
  OpportunityClass,
  Obligations,
  Program,
  RawOpportunity,
  SourceTier,
  VerificationMethod,
} from '@grantspotter/core';
import { hashProgram, parseAmount } from '@grantspotter/core';
import { extractConstraints } from './axes/index.js';
import { inferDeadline, inferInstrument, inferStatus } from './deadline.js';
import { DISPUTED_OVERRIDES, sourceKeyOf } from './disputed.js';

export interface NormalizeContext {
  sourceId: string;
  funderId: string;
  klass: OpportunityClass;
  tier: SourceTier;
  nowISO: string;
  deadlineInheritsFrom?: string;
  verificationMethod: VerificationMethod;
  /**
   * Injected, not imported: `programIdFor` lives in ../sources/util/ids.ts and uses node:crypto,
   * and spec §14 requires normalize/ to be pure. Task 25's crawl/context.ts supplies it.
   */
  mintId: (sourceId: string, externalKey: string) => string;
  /**
   * RESOLUTIONS R9. Returns the id of an already-stored program with this source key, if any.
   * Task 25 wires it to Plan 1's createProgramRepo(db).findBySourceKey(). Without it the crawler
   * mints a fresh id every night, `diffPrograms` sees the whole seeded corpus vanish and the
   * whole crawled corpus appear, and it does that forever.
   */
  existingIdFor?: (sourceId: string, externalKey: string) => string | undefined;
}

const OBLIGATIONS_BY_SOURCE: Readonly<Record<string, Partial<Obligations>>> = Object.freeze({
  'ardc-grants': {
    licenseObligation:
      'All output must be open-source or open-access (GPL, MIT, BSD, CERN-OHL, Creative Commons).',
    indirectCostCapPct: 20,
  },
  'ardc-award-tables': { indirectCostCapPct: 20 },
  'arrl-amateur-radio-grants': { coFunderPreference: true },
  'arrl-club-grant': { coFunderPreference: true },
  'yaesu-dr2x': { sustainmentObligation: 'The repeater must remain on the air for 12 months.' },
  // NCDXF expects the applicant to have a personal stake in the DXpedition it part-funds.
  'ncdxf-grants': { costShareRequired: true },
});

/**
 * Per-record obligations, keyed by sourceKeyOf(sourceId, externalKey). `manual-tier-d` carries
 * many different funders' records under one source id, so a source-level entry cannot express
 * "YASME reports, the others do not".
 *
 * This exists because seed records re-enter this same pipeline whenever a human presses
 * "Verify now" (Plan 3 Task 10). An obligation that only ever existed as a literal in Plan 5's
 * seed JSON is an obligation that gets silently dropped on the first re-verify.
 *
 * FIX ROUND 1 (Task 15 review, Important): this used to also carry
 * `sourceKeyOf('manual-tier-d', 'ncdxf-dxpedition-grants')`, which was a no-op — no
 * `TIER_D_RECORDS` entry has that externalKey. 'ncdxf-dxpedition-grants' is the externalKey of
 * the REAL, separately-crawled NCDXF DXpedition Grants program, whose cost-share requirement is
 * already applied above via `OBLIGATIONS_BY_SOURCE['ncdxf-grants']`. The Tier D record actually
 * keyed `ncdxf-youth-grant` is a different NCDXF program (the Youth Grant) whose page "renders as
 * navigation and a title only — it publishes no terms" per manual-tier-d.ts, so it carries no
 * known obligation to encode here. Removed rather than repointed.
 */
const OBLIGATIONS_BY_RECORD: Readonly<Record<string, Partial<Obligations>>> = Object.freeze({
  [sourceKeyOf('manual-tier-d', 'yasme-supporting-grants')]: {
    reportingObligation: 'Year-end activity report to the YASME Foundation board.',
  },
});

const RESTRICTIONS_BY_SOURCE: Readonly<Record<string, string[]>> = Object.freeze({
  'arrl-amateur-radio-grants': [
    'Does not fund emergency communications equipment.',
    'Does not fund ongoing operating expenses.',
  ],
  'arrl-club-grant': ['Does not fund ongoing operating expenses.'],
  'ncdxf-grants': ['Does not fund commercial transport.'],
});

const AI_POLICY_BY_FUNDER: Readonly<Record<string, AiPolicy>> = Object.freeze({
  ardc: {
    stance: 'permitted',
    quote:
      'If you choose to use AI when writing your proposal be sure to thoroughly edit for ' +
      'clarity, brevity, and accuracy. If the proposal is extremely long and hard to ' +
      'understand, we can’t evaluate or support it.',
    url: 'https://www.ardc.net/apply/grant-application-instructions/',
  },
  nsf: {
    stance: 'permitted_with_disclosure',
    quote:
      'Proposers are encouraged to indicate in the project description the extent to which, if ' +
      'any, generative AI technology was used.',
    url: 'https://www.nsf.gov/policies/ai/merit-review',
  },
  'arrl-foundation': {
    stance: 'unaddressed',
    quote: undefined,
    url: 'https://www.arrl.org/files/file/Foundation/Grant%20Application%20Form.pdf',
  },
  arrl: { stance: 'unaddressed', url: 'http://www.arrl.org/' },
});

const APPLY_VIA_BY_SOURCE: Readonly<Record<string, ApplyVia>> = Object.freeze({
  'ardc-grants': 'external_spa_portal',
  'arrl-scholarship-descriptions': 'external_spa_portal',
  'arrl-scholarship-program': 'external_spa_portal',
  qcwa: 'external_spa_portal',
  'arrl-club-grant': 'external_spa_portal',
  'arrl-etp-grants': 'jotform_year_keyed',
  'ieee-mtts': 'jotform_year_keyed',
  'austin-arc': 'self_hosted_portal',
  // ROUND 4. Was 'email_pdf_packet', pinned on the Budget Worksheet alone. NCDXF's intake is
  // genuinely TWO channels, both on https://www.ncdxf.org/pages/grant_app.php (fetched live
  // 2026-08-03; the committed fixture is the guidelines page that links to it):
  //   Part 1  a Budget Worksheet SPREADSHEET, saved and emailed to dxbudget@ncdxf.org — not a
  //           PDF, and not sufficient on its own;
  //   Part 2  <form action="ncdxf_grant.php" method="post"> with a "SUBMIT APPLICATION" button —
  //           an ordinary HTML form on the funder's own site.
  // ApplyVia can name only one, and Plan 3 renders it as the apply button, so it names the half
  // an applicant can complete unaided in a browser. The emailed half is not lost: the funder's
  // own "completing (1) a Budget Worksheet and (2) an Application Form, and submitting both"
  // sentence is kept by the parser in `applyNote` and published below as `applyContact`.
  'ncdxf-grants': 'page_form',
  sara: 'email_pdf_packet',
  'manual-tier-d': 'contact_person',
  'ardc-award-tables': 'none',
});

const ENTITIES_BY_SOURCE: Readonly<Record<string, ApplicantEntity[]>> = Object.freeze({
  'ardc-grants': ['club_via_fiscal_sponsor', 'club_501c3', 'school_lea', 'university', 'university_dept'],
  'arrl-amateur-radio-grants': ['club_unincorporated', 'club_501c3', 'school_lea', 'university'],
  'arrl-club-grant': ['club_unincorporated', 'club_501c3'],
  'arrl-etp-grants': ['teacher', 'school_lea'],
  'arrl-scholarship-descriptions': ['individual'],
  'arrl-scholarship-program': ['individual'],
  qcwa: ['individual'],
  ylrl: ['individual'],
  'austin-arc': ['individual'],
  'ncdxf-scholarships': ['individual'],
  ariss: ['school_lea', 'university'],
  'ieee-mtts': ['ieee_student_branch_chapter'],
  'ieee-student-branch-rebate': ['ieee_student_branch_chapter'],
  'nasa-csli': ['university', 'school_lea'],
  'yaesu-dr2x': ['club_unincorporated', 'club_501c3', 'individual'],
  sara: ['individual', 'teacher', 'school_lea'],
});

function firstOf(fields: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return '';
}

function buildSummary(raw: RawOpportunity): string {
  // Our own short excerpt, never a full text dump. Facts are not copyrightable; long verbatim
  // descriptions are a different matter.
  const source = firstOf(raw.rawFields, ['summary', 'audience', 'eligibility', '__preamble']) || raw.rawText;
  const oneLine = source.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 400 ? oneLine : `${oneLine.slice(0, 397)}...`;
}

function buildAmount(raw: RawOpportunity, ctx: NormalizeContext): AmountSpec {
  const amountRaw = firstOf(raw.rawFields, ['Award Amount', 'amountRaw', 'amount', 'pricing']);
  const awardCountRaw = firstOf(raw.rawFields, ['Number of Awards', 'awardCountRaw']);
  const parsed = amountRaw === '' ? {} : parseAmount(amountRaw);
  return {
    instrument: inferInstrument(raw, ctx),
    amountMin: parsed.amountMin,
    amountMax: parsed.amountMax,
    tiers: parsed.tiers,
    amountRaw,
    awardCountRaw,
  };
}

function buildRawOtherText(raw: RawOpportunity): string {
  const parts = [raw.rawFields.Other, raw.rawFields.rawOtherText].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  if (parts.length > 0) return parts.join('\n');
  // No modelled Other field: keep the whole flattened body rather than losing an unmodelled
  // requirement such as "preference to a student ham from a ham family".
  return raw.rawText.trim();
}

/**
 * The suppression tag. A program carrying it is EVIDENCE, not an opportunity: store it, keep it
 * retrievable, never queue it for review and never publish it.
 *
 * WHY THIS IS DEFINED HERE, NEXT TO ITS ENFORCEMENT PREDICATE. Until 2026-08-03 this string was
 * written by `buildTags` and read by absolutely nothing — `diffPrograms`, `buildReviewItems` and
 * the approve path all ignored it — so `arrl-pages.ts`'s claim that "normalize/ refuses to publish
 * it" was simply false of the running code, and `ardc-award-tables.ts` / `nsf-awards.ts` /
 * `usaspending.ts` each carried the same false assurance in their own `notes`. The tag has to be
 * defined together with `isDoNotPublish`, the predicate every enforcement point calls, so that a
 * writer with no reader cannot silently reappear: deleting the reader now breaks an import.
 *
 * `review/index.ts` is the reader. See `SuppressedProgramError` there for where suppression is
 * actually enforced and why it lives at those two seams rather than in the crawl.
 */
export const DO_NOT_PUBLISH_TAG = 'do_not_publish';

/**
 * Record types that are historical or diagnostic and must never surface as fundable.
 *
 * - `past_award` — money that has ALREADY been handed out. Four sources emit it: the ARRL
 *   club-grant page (~37 past recipients alongside the one real grant program),
 *   `ardc-award-tables`, `nsf-awards` and `usaspending`. Every one of these normalizes into a
 *   `Program` with the same `klass` and `applicantEntities` as a real opportunity; only
 *   `trust.status: 'closed'` distinguishes them, and `matcher.ts` does not read `trust.status`.
 *   They currently miss the individual-facing candidates only because the club-grant source's
 *   `applicantEntities` happen to be org-only — coincidence, not design. A funder's grant history
 *   is genuinely valuable evidence about who that funder funds, so these are stored, never
 *   published.
 * - `crosscheck` — `arrl-summary-of-scholarship-requirements` exists purely to corroborate other
 *   sources. Its own `notes` call it "STALE… 79 entries against the catalog's 111, abbreviated
 *   non-joinable keys, and it still lists dropped scholarships". Publishing a dropped scholarship
 *   as live is precisely the harm this whole pipeline exists to prevent.
 */
export const SUPPRESSED_RECORD_TYPES: ReadonlySet<string> = new Set(['past_award', 'crosscheck']);

/**
 * Record types that ARE meant to reach the review queue, listed explicitly so that the classes are
 * exhaustive and a NEW record type cannot quietly default into either one. `normalize/index.test.ts`
 * scans `sources/` on disk for every `recordType:` literal and fails if any is in neither set.
 *
 * `verified_negative` and `safety_warning` are deliberately publishable: "we checked, this program
 * does not exist" and "farweb.org was taken over and now serves a gambling site, do not apply" are
 * exactly the answers a searcher most needs to see. Suppressing those would hide the warning.
 */
export const PUBLISHABLE_RECORD_TYPES: ReadonlySet<string> = new Set([
  'manual',
  'guided_workflow',
  'verified_negative',
  'safety_warning',
]);

/**
 * The ONLY reader of {@link DO_NOT_PUBLISH_TAG}. Every enforcement point calls this rather than
 * matching the string itself, so `grep isDoNotPublish` enumerates the complete set of places
 * suppression is honoured — which is the property whose absence was the original defect.
 */
export function isDoNotPublish(program: Pick<Program, 'tags'>): boolean {
  return program.tags.includes(DO_NOT_PUBLISH_TAG);
}

function buildTags(raw: RawOpportunity, ctx: NormalizeContext): string[] {
  // `source:` and `key:` together ARE the ingest identity (RESOLUTIONS R1/R9). CONTRACT §3's
  // Program has no field for them, and review/index.ts reads them back out of here on approval
  // so the record lands in programs.source_id / programs.external_key. diffPrograms ignores
  // tags-only changes, so carrying them costs nothing.
  const tags = new Set<string>([
    `tier:${ctx.tier}`,
    `source:${ctx.sourceId}`,
    `key:${raw.externalKey}`,
  ]);
  const recordType = raw.rawFields.recordType;
  if (recordType) tags.add(recordType);
  // Was `recordType === 'crosscheck'` only, which left `past_award` — the ~37 already-funded ARRL
  // clubs plus every ARDC/NSF/USAspending award row — indistinguishable from a live opportunity.
  if (recordType !== undefined && SUPPRESSED_RECORD_TYPES.has(recordType)) tags.add(DO_NOT_PUBLISH_TAG);
  if (raw.rawFields.year) tags.add(`year:${raw.rawFields.year}`);
  return [...tags];
}

export function normalizeRaw(raw: RawOpportunity, ctx: NormalizeContext): Program {
  // RESOLUTIONS R9: the SEED CORPUS owns identity. Ask for an already-stored id under this
  // source key before minting a new one, or every night's crawl duplicates every seeded record.
  const id = ctx.existingIdFor?.(ctx.sourceId, raw.externalKey) ?? ctx.mintId(ctx.sourceId, raw.externalKey);
  const recordKey = sourceKeyOf(ctx.sourceId, raw.externalKey);
  const obligations: Obligations = {
    costShareRequired: false,
    coFunderPreference: false,
    ...OBLIGATIONS_BY_SOURCE[ctx.sourceId],
    ...OBLIGATIONS_BY_RECORD[recordKey],
  };

  const program: Program = {
    id,
    funderId: ctx.funderId,
    name: raw.name,
    klass: ctx.klass,
    summary: buildSummary(raw),
    applicantEntities: ENTITIES_BY_SOURCE[ctx.sourceId] ?? [],
    amount: buildAmount(raw, ctx),
    deadline: inferDeadline(raw, ctx),
    applyVia: APPLY_VIA_BY_SOURCE[ctx.sourceId] ?? 'page_form',
    applyUrl: raw.rawFields.formUrl ?? raw.rawFields.detailUrl ?? raw.sourceUrl,
    applyContact: raw.rawFields.applyNote,
    constraints: extractConstraints(raw),
    fundingRestrictions: RESTRICTIONS_BY_SOURCE[ctx.sourceId] ?? [],
    obligations,
    aiPolicy: AI_POLICY_BY_FUNDER[ctx.funderId] ?? { stance: 'unaddressed' },
    trust: {
      status: inferStatus(raw, ctx),
      sourceUrl: raw.sourceUrl,
      lastVerifiedAt: ctx.nowISO,
      verificationMethod: ctx.verificationMethod,
      contentHash: '',
      disputed: DISPUTED_OVERRIDES[recordKey],
      staleMirrorWarning: raw.rawFields.staleMirrorWarning,
    },
    rawOtherText: buildRawOtherText(raw),
    tags: buildTags(raw, ctx),
  };

  // Computed LAST, and hashProgram excludes TrustFields by contract — lastVerifiedAt moves
  // every night, so including it would mark every record changed every night.
  program.trust.contentHash = hashProgram(program);
  return program;
}
