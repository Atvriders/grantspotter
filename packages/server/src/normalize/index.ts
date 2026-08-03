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
 */
const OBLIGATIONS_BY_RECORD: Readonly<Record<string, Partial<Obligations>>> = Object.freeze({
  [sourceKeyOf('manual-tier-d', 'yasme-supporting-grants')]: {
    reportingObligation: 'Year-end activity report to the YASME Foundation board.',
  },
  [sourceKeyOf('manual-tier-d', 'ncdxf-dxpedition-grants')]: { costShareRequired: true },
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
  'ncdxf-grants': 'email_pdf_packet',
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
  if (recordType === 'crosscheck') tags.add('do_not_publish');
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
