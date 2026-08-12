import { z } from 'zod';
import type {
  Constraint,
  Cycle,
  Funder,
  Profile,
  ProfileFieldSource,
  Program,
} from './types.js';

export const licenseClassSchema = z.enum(['NONE', 'TECH', 'GENERAL', 'EXTRA']);
export const degreeLevelSchema = z.enum(['CERT', 'ASSOC', 'BACH', 'GRAD']);
export const stageSchema = z.enum([
  'HS_SENIOR',
  'UNDERGRAD',
  'GRAD',
  'VETERAN',
  'RETRAINING_ADULT',
]);
export const citizenshipSchema = z.enum(['US_CITIZEN', 'US_RESIDENT', 'ANY']);
export const activityKindSchema = z.enum([
  'club_member',
  'ares_races_skywarn',
  'teaching',
  'on_air',
  'field_day',
  'contesting',
  'public_service',
]);
export const recommenderTypeSchema = z.enum([
  'none',
  'arrl_affiliated_club_officer',
  'sponsor_org_member',
  'teacher',
  'any',
]);
export const applicantEntitySchema = z.enum([
  'individual',
  'club_unincorporated',
  'club_501c3',
  'club_via_fiscal_sponsor',
  'school_lea',
  'university',
  'university_dept',
  'ieee_student_branch_chapter',
  'teacher',
  'nominated_by_institution',
]);
export const instrumentSchema = z.enum([
  'cash_range',
  'cash_fixed',
  'cash_tiered_blocks',
  'in_kind_equipment',
  'in_kind_service',
  'discounted_purchase',
  'per_member_rebate',
  'tuition_coverage',
  'unknown',
]);
export const deadlineKindSchema = z.enum([
  'n_fixed_dates',
  'n_fixed_windows',
  'annual_window',
  'rolling',
  'quarterly_rewritten',
  'ad_hoc',
  'inherited',
  'unpublished',
  'no_application_exists',
  'dormant',
]);
export const applyViaSchema = z.enum([
  'page_form',
  'external_spa_portal',
  'jotform_year_keyed',
  'self_hosted_portal',
  'email_pdf_packet',
  'contact_person',
  'none',
]);
export const programStatusSchema = z.enum([
  'open',
  'closed',
  'dormant',
  'discontinued',
  'contact_only',
  'no_application',
  'unknown',
]);
export const aiStanceSchema = z.enum([
  'permitted',
  'permitted_with_disclosure',
  'discouraged',
  'prohibited',
  'unaddressed',
]);
export const verificationMethodSchema = z.enum([
  'live_fetch',
  'api',
  'manual_curation',
  'seed_import',
]);
export const opportunityClassSchema = z.enum([
  'ham_grant',
  'ham_scholarship',
  'adjacent_stem',
  'equipment_in_kind',
]);
export const constraintAxisSchema = z.enum([
  'license',
  'geography',
  'field_of_study',
  'institution',
  'gpa',
  'arrl_membership',
  'recommendation',
  'citizenship',
  'age_stage',
  'ham_activity',
  'financial_need',
  'gender',
  'other',
]);

export const geoSpecSchema = z.object({
  type: z.enum([
    'any',
    'state',
    'arrl_division',
    'arrl_section',
    'county',
    'radius',
    'call_district',
  ]),
  values: z.array(z.string()),
  centerLat: z.number().optional(),
  centerLon: z.number().optional(),
  radiusMiles: z.number().optional(),
  centerLabel: z.string().optional(),
});

export const constraintSpecSchema = z.discriminatedUnion('axis', [
  z.object({
    axis: z.literal('license'),
    licenseMin: licenseClassSchema,
    heldMonthsMin: z.number().optional(),
    foreignLicenseOK: z.boolean().optional(),
  }),
  z.object({ axis: z.literal('geography'), geo: geoSpecSchema }),
  z.object({
    axis: z.literal('field_of_study'),
    fields: z.array(z.string()),
    excludedFields: z.array(z.string()),
  }),
  z.object({
    axis: z.literal('institution'),
    degreeLevels: z.array(degreeLevelSchema),
    tradeSchoolOK: z.boolean(),
    partTimeOK: z.boolean(),
    accreditationRequired: z.boolean(),
  }),
  z.object({
    axis: z.literal('gpa'),
    min: z.number().optional(),
    classRankTopPct: z.number().optional(),
  }),
  z.object({
    axis: z.literal('arrl_membership'),
    required: z.boolean(),
    minYears: z.number(),
  }),
  z.object({
    axis: z.literal('recommendation'),
    recommenderType: recommenderTypeSchema,
    count: z.number(),
  }),
  z.object({
    axis: z.literal('citizenship'),
    allowed: z.array(citizenshipSchema),
    withinMonthsOfCitizenship: z.number().optional(),
  }),
  z.object({
    axis: z.literal('age_stage'),
    ageMin: z.number().optional(),
    ageMax: z.number().optional(),
    asOf: z.string().optional(),
    stages: z.array(stageSchema),
  }),
  z.object({
    axis: z.literal('ham_activity'),
    activityKinds: z.array(activityKindSchema),
    cwProficiencyWpmMin: z.number().optional(),
    proofRequired: z.boolean(),
  }),
  z.object({ axis: z.literal('financial_need'), weighted: z.literal(true) }),
  z.object({
    axis: z.literal('gender'),
    allowed: z.array(z.enum(['female', 'male', 'any'])),
  }),
  z.object({ axis: z.literal('other'), note: z.string() }),
]);

export const constraintSchema = z.object({
  id: z.string(),
  hard: z.boolean(),
  fallbackRank: z.number(),
  rawText: z.string(),
  spec: constraintSpecSchema,
});

export const awardTierSchema = z.object({ count: z.number(), amount: z.number() });

export const amountSpecSchema = z.object({
  instrument: instrumentSchema,
  amountMin: z.number().optional(),
  amountMax: z.number().optional(),
  tiers: z.array(awardTierSchema).optional(),
  amountRaw: z.string(),
  awardCountRaw: z.string(),
});

export const deadlineSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('self') }),
  z.object({ kind: z.literal('inherited'), fromProgramId: z.string() }),
]);

export const deadlineSpecSchema = z.object({
  kind: deadlineKindSchema,
  source: deadlineSourceSchema,
  note: z.string(),
});

export const cycleSchema = z.object({
  id: z.string(),
  programId: z.string(),
  opensAt: z.string().optional(),
  closesAt: z.string().optional(),
  timezone: z.string(),
  label: z.string(),
  isEstimated: z.boolean(),
});

export const disputedClaimSchema = z.object({ claim: z.string(), sourceUrl: z.string() });

export const disputedSchema = z.object({
  claims: z.array(disputedClaimSchema),
  note: z.string(),
});

/**
 * An absolute http(s) URL, and nothing else. The store-side half of the same allowlist
 * `web/src/lib/safety.ts` applies before it renders an anchor.
 *
 * Three fields share this: `programSchema.applyUrl`, `trustFieldsSchema.sourceUrl` and
 * `aiPolicySchema.url`. All three were once a bare `z.string()`, and `POST
 * /api/inbox/:id/decision` validates an admin-edited candidate with nothing but `programSchema` —
 * so `javascript:…` was a storable value for any of them, and `SourceLink` renders `applyUrl`,
 * `trust.sourceUrl` and `aiPolicy.url` as `<a href>` with no guard of its own upstream (`applyUrl`
 * is the one field `Opportunity.tsx` also screens through `linkRefusal` before offering as the
 * "Apply at the funder" button; the other two go straight to `SourceLink`). `applyUrl` was
 * tightened first, closing the finding that named it; `sourceUrl` and `url` were the same shape
 * and stayed bare — latent, since every stored value happens to parse today, and exactly why it
 * is worth closing before a record proves it rather than after.
 *
 * NOT `z.string().url()`: zod's `.url()` accepts `javascript:alert(1)` — it checks that the URL
 * constructor succeeds, which is the same hole the browser-side copy had. The scheme is checked
 * by name. `//host/path` is rejected too: `new URL()` throws on it, and a browser resolves it to
 * the host — which is how a protocol-relative farweb.org link reached the page as a live anchor.
 *
 * A REGEX RATHER THAN `new URL()` because `core` is compiled with `lib: ["ES2022"]` and
 * `types: []` (spec §14 purity — no `node:`, no DOM, no host environment assumed at all), so
 * `URL` is not in scope here. The pattern is deliberately narrower than the constructor: scheme,
 * `//`, a non-empty authority with no whitespace, and an optional path/query/fragment. Verified
 * against every URL the corpus stores — 703 of 703 `applyUrl` values match, and every string
 * `web/src/lib/safety.ts` refuses is refused here too.
 */
const HTTP_URL = /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i;

export const httpUrlSchema = z
  .string()
  .refine((value) => HTTP_URL.test(value), { message: 'must be an absolute http or https URL' });

export const trustFieldsSchema = z.object({
  status: programStatusSchema,
  // Tightened alongside `applyUrl` (close-out review I5's deviation note): rendered as an anchor
  // by `SourceLink` on every detail page, unconditionally — there is no `blocked_host`-style guard
  // upstream of it the way `applyUrl` has one in `Opportunity.tsx`. `httpUrlSchema` is defined
  // once, above, precisely so this and `aiPolicy.url` do not each grow their own copy of the
  // allowlist and silently drift from it.
  sourceUrl: httpUrlSchema,
  lastVerifiedAt: z.string(),
  verificationMethod: verificationMethodSchema,
  contentHash: z.string(),
  disputed: disputedSchema.optional(),
  staleMirrorWarning: z.string().optional(),
});

export const aiPolicySchema = z.object({
  stance: aiStanceSchema,
  quote: z.string().optional(),
  // Same allowlist as `applyUrl` and `trust.sourceUrl` — also rendered through `SourceLink`,
  // also bare `z.string()` before this fix. Optional stays optional: the key is absent on every
  // record whose funder has not published an AI policy at all.
  url: httpUrlSchema.optional(),
});

export const obligationsSchema = z.object({
  licenseObligation: z.string().optional(),
  indirectCostCapPct: z.number().optional(),
  // Optional, and ABSENT MEANS UNSTATED — see the Obligations doc-comment in types.ts. A record
  // that carries neither key is a record no funder told us about cost sharing, which zod must
  // accept; making them required is what forced normalize/ to invent `false`.
  costShareRequired: z.boolean().optional(),
  coFunderPreference: z.boolean().optional(),
  sustainmentObligation: z.string().optional(),
  reportingObligation: z.string().optional(),
});

export const funderSchema = z.object({
  id: z.string(),
  name: z.string(),
  homepage: z.string(),
  ein: z.string().optional(),
  note: z.string().optional(),
});

export const programSchema = z.object({
  id: z.string(),
  funderId: z.string(),
  name: z.string(),
  klass: opportunityClassSchema,
  summary: z.string(),
  applicantEntities: z.array(applicantEntitySchema),
  amount: amountSpecSchema,
  deadline: deadlineSpecSchema,
  applyVia: applyViaSchema,
  applyUrl: httpUrlSchema.optional(),
  applyContact: z.string().optional(),
  constraints: z.array(constraintSchema),
  fundingRestrictions: z.array(z.string()),
  obligations: obligationsSchema,
  aiPolicy: aiPolicySchema,
  trust: trustFieldsSchema,
  rawOtherText: z.string(),
  tags: z.array(z.string()),
});

/**
 * The profile-side provenance marker. See the `ProfileFieldSource` doc comment in types.ts for why
 * it stores the filled VALUE rather than a bare "was auto-filled" flag.
 *
 * `source` is a literal, not a free string: it is rendered to the applicant as the name of who
 * said so, and an unvalidated one would let a client store any attribution it liked under a key a
 * later reader trusts. A second source is a `z.union` of two literals, added deliberately.
 */
export const profileFieldSourceSchema = z.object({
  source: z.literal('callook.info'),
  fetchedAt: z.string(),
  value: z.string(),
});

/**
 * WHICH fields a lookup may be recorded as having filled — enforced by the shape of the object,
 * not by a comment or a runtime allowlist.
 *
 * `z.object` strips every key it does not declare, exactly as `programSchema` does for the rest of
 * the profile (see the note in `api/profileRouter.ts` on persisting `parsed.data` rather than
 * `req.body`). So a client that posts `fieldSources: { licensedSince: … }` or
 * `fieldSources: { gpa: … }` does not get it stored: `licensedSince` cannot be honestly derived
 * from an FCC record at all, and no lookup supplies a GPA. The two spellings differ by profile
 * kind because the source's answer does — a club record has an organisation name and an empty
 * operator class.
 */
export const studentFieldSourcesSchema = z.object({
  // Storable because callook answers a superseded callsign with the licensee's CURRENT record, so
  // the callsign in the field can be one the applicant never typed. See `StudentFieldSources`.
  callsign: profileFieldSourceSchema.optional(),
  licenseClass: profileFieldSourceSchema.optional(),
  state: profileFieldSourceSchema.optional(),
});

export const orgFieldSourcesSchema = z.object({
  orgName: profileFieldSourceSchema.optional(),
  callsign: profileFieldSourceSchema.optional(),
  state: profileFieldSourceSchema.optional(),
});

export const studentProfileSchema = z.object({
  kind: z.literal('student'),
  callsign: z.string().optional(),
  licenseClass: licenseClassSchema.optional(),
  licensedSince: z.string().optional(),
  state: z.string().optional(),
  county: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  callDistrict: z.string().optional(),
  fieldOfStudy: z.string().optional(),
  degreeLevel: degreeLevelSchema.optional(),
  institution: z.string().optional(),
  accredited: z.boolean().optional(),
  partTime: z.boolean().optional(),
  gpa: z.number().optional(),
  classRankTopPct: z.number().optional(),
  arrlMemberSince: z.string().optional(),
  citizenship: citizenshipSchema.optional(),
  birthDate: z.string().optional(),
  stage: stageSchema.optional(),
  activityKinds: z.array(activityKindSchema).optional(),
  cwWpm: z.number().optional(),
  financialNeed: z.boolean().optional(),
  gender: z.enum(['female', 'male', 'other', 'prefer_not_to_say']).optional(),
  fieldSources: studentFieldSourcesSchema.optional(),
});

export const orgProfileSchema = z.object({
  kind: z.literal('organization'),
  entity: applicantEntitySchema,
  orgName: z.string().optional(),
  callsign: z.string().optional(),
  state: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  ein: z.string().optional(),
  is501c3: z.boolean().optional(),
  hasFiscalSponsor: z.boolean().optional(),
  arrlAffiliated: z.boolean().optional(),
  memberCount: z.number().optional(),
  institutionName: z.string().optional(),
  fieldSources: orgFieldSourcesSchema.optional(),
});

export const profileSchema = z.discriminatedUnion('kind', [
  studentProfileSchema,
  orgProfileSchema,
]);

// Compile-time drift guards. If types.ts and schema.ts ever disagree, these
// stop compiling. Bidirectional assignability is checked, not exact identity,
// because zod's inferred optionals are structurally equivalent but not identical.
const _inferredProgramIsProgram: Program = null as unknown as z.infer<typeof programSchema>;
const _programIsInferredProgram: z.infer<typeof programSchema> = null as unknown as Program;
const _inferredConstraintIsConstraint: Constraint =
  null as unknown as z.infer<typeof constraintSchema>;
const _constraintIsInferredConstraint: z.infer<typeof constraintSchema> =
  null as unknown as Constraint;
const _inferredProfileIsProfile: Profile = null as unknown as z.infer<typeof profileSchema>;
const _profileIsInferredProfile: z.infer<typeof profileSchema> = null as unknown as Profile;
// The per-kind maps are covered transitively by the `Profile` pair above; the leaf gets its own so
// that a drifted marker fails to compile HERE, naming itself, rather than as a mismatch buried
// three levels inside a discriminated union.
const _inferredFieldSourceIsFieldSource: ProfileFieldSource =
  null as unknown as z.infer<typeof profileFieldSourceSchema>;
const _fieldSourceIsInferredFieldSource: z.infer<typeof profileFieldSourceSchema> =
  null as unknown as ProfileFieldSource;
const _inferredCycleIsCycle: Cycle = null as unknown as z.infer<typeof cycleSchema>;
const _cycleIsInferredCycle: z.infer<typeof cycleSchema> = null as unknown as Cycle;
const _inferredFunderIsFunder: Funder = null as unknown as z.infer<typeof funderSchema>;
const _funderIsInferredFunder: z.infer<typeof funderSchema> = null as unknown as Funder;
void _inferredProgramIsProgram;
void _programIsInferredProgram;
void _inferredConstraintIsConstraint;
void _constraintIsInferredConstraint;
void _inferredProfileIsProfile;
void _profileIsInferredProfile;
void _inferredFieldSourceIsFieldSource;
void _fieldSourceIsInferredFieldSource;
void _inferredCycleIsCycle;
void _cycleIsInferredCycle;
void _inferredFunderIsFunder;
void _funderIsInferredFunder;
