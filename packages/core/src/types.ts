// ---------- enums ----------
export type LicenseClass = 'NONE' | 'TECH' | 'GENERAL' | 'EXTRA';
export type DegreeLevel = 'CERT' | 'ASSOC' | 'BACH' | 'GRAD';
export type Stage = 'HS_SENIOR' | 'UNDERGRAD' | 'GRAD' | 'VETERAN' | 'RETRAINING_ADULT';
export type Citizenship = 'US_CITIZEN' | 'US_RESIDENT' | 'ANY';
export type ActivityKind =
  | 'club_member'
  | 'ares_races_skywarn'
  | 'teaching'
  | 'on_air'
  | 'field_day'
  | 'contesting'
  | 'public_service';
export type RecommenderType =
  | 'none'
  | 'arrl_affiliated_club_officer'
  | 'sponsor_org_member'
  | 'teacher'
  | 'any';

export type ApplicantEntity =
  | 'individual'
  | 'club_unincorporated'
  | 'club_501c3'
  | 'club_via_fiscal_sponsor'
  | 'school_lea'
  | 'university'
  | 'university_dept'
  | 'ieee_student_branch_chapter'
  | 'teacher'
  | 'nominated_by_institution';

export type Instrument =
  | 'cash_range'
  | 'cash_fixed'
  | 'cash_tiered_blocks'
  | 'in_kind_equipment'
  | 'in_kind_service'
  | 'discounted_purchase'
  | 'per_member_rebate'
  | 'tuition_coverage'
  | 'unknown';

export type DeadlineKind =
  | 'n_fixed_dates'
  | 'n_fixed_windows'
  | 'annual_window'
  | 'rolling'
  | 'quarterly_rewritten'
  | 'ad_hoc'
  | 'inherited'
  | 'unpublished'
  | 'no_application_exists'
  | 'dormant';

export type ApplyVia =
  | 'page_form'
  | 'external_spa_portal'
  | 'jotform_year_keyed'
  | 'self_hosted_portal'
  | 'email_pdf_packet'
  | 'contact_person'
  | 'none';

export type ProgramStatus =
  | 'open'
  | 'closed'
  | 'dormant'
  | 'discontinued'
  | 'contact_only'
  | 'no_application'
  | 'unknown';

export type AiStance =
  | 'permitted'
  | 'permitted_with_disclosure'
  | 'discouraged'
  | 'prohibited'
  | 'unaddressed';

export type VerificationMethod = 'live_fetch' | 'api' | 'manual_curation' | 'seed_import';

export type OpportunityClass =
  | 'ham_grant'
  | 'ham_scholarship'
  | 'adjacent_stem'
  | 'equipment_in_kind';

export type ConstraintAxis =
  | 'license'
  | 'geography'
  | 'field_of_study'
  | 'institution'
  | 'gpa'
  | 'arrl_membership'
  | 'recommendation'
  | 'citizenship'
  | 'age_stage'
  | 'ham_activity'
  | 'financial_need'
  | 'gender'
  | 'other';

// ---------- geography ----------
export interface GeoSpec {
  type: 'any' | 'state' | 'arrl_division' | 'arrl_section' | 'county' | 'radius' | 'call_district';
  values: string[];
  centerLat?: number;
  centerLon?: number;
  radiusMiles?: number;
  centerLabel?: string;
}

// ---------- constraints ----------
export type ConstraintSpec =
  | { axis: 'license'; licenseMin: LicenseClass; heldMonthsMin?: number; foreignLicenseOK?: boolean }
  | { axis: 'geography'; geo: GeoSpec }
  | { axis: 'field_of_study'; fields: string[]; excludedFields: string[] }
  | {
      axis: 'institution';
      degreeLevels: DegreeLevel[];
      tradeSchoolOK: boolean;
      partTimeOK: boolean;
      accreditationRequired: boolean;
    }
  | { axis: 'gpa'; min?: number; classRankTopPct?: number }
  | { axis: 'arrl_membership'; required: boolean; minYears: number }
  | { axis: 'recommendation'; recommenderType: RecommenderType; count: number }
  | { axis: 'citizenship'; allowed: Citizenship[]; withinMonthsOfCitizenship?: number }
  | { axis: 'age_stage'; ageMin?: number; ageMax?: number; asOf?: string; stages: Stage[] }
  | {
      axis: 'ham_activity';
      activityKinds: ActivityKind[];
      cwProficiencyWpmMin?: number;
      proofRequired: boolean;
    }
  | { axis: 'financial_need'; weighted: true }
  | { axis: 'gender'; allowed: Array<'female' | 'male' | 'any'> }
  | { axis: 'other'; note: string };

export interface Constraint {
  id: string;
  hard: boolean;
  fallbackRank: number;
  rawText: string;
  spec: ConstraintSpec;
}

// ---------- money ----------
export interface AwardTier {
  count: number;
  amount: number;
}

export interface AmountSpec {
  instrument: Instrument;
  amountMin?: number;
  amountMax?: number;
  tiers?: AwardTier[];
  amountRaw: string;
  awardCountRaw: string;
}

// ---------- deadlines ----------
export type DeadlineSource = { kind: 'self' } | { kind: 'inherited'; fromProgramId: string };

export interface DeadlineSpec {
  kind: DeadlineKind;
  source: DeadlineSource;
  note: string;
}

export interface Cycle {
  id: string;
  programId: string;
  opensAt?: string;
  closesAt?: string;
  timezone: string;
  label: string;
  isEstimated: boolean;
}

// ---------- trust ----------
export interface DisputedClaim {
  claim: string;
  sourceUrl: string;
}

export interface Disputed {
  claims: DisputedClaim[];
  note: string;
}

export interface TrustFields {
  status: ProgramStatus;
  sourceUrl: string;
  lastVerifiedAt: string;
  verificationMethod: VerificationMethod;
  contentHash: string;
  disputed?: Disputed;
  staleMirrorWarning?: string;
}

export interface AiPolicy {
  stance: AiStance;
  quote?: string;
  url?: string;
}

/**
 * What a funder said about a yes/no obligation, WITH the case where they said nothing.
 *
 * `'unstated'` is not a soft `'no'`. It means no page this pipeline fetched addressed the
 * question, so the reader must go and check — which is a different instruction to the applicant
 * than "the funder has told us this is not required".
 */
export type ObligationState = 'yes' | 'no' | 'unstated';

/**
 * The ONLY sanctioned way to read a tri-state obligation flag. Renderers and matchers call this
 * instead of testing the boolean, because `if (o.costShareRequired)` and
 * `o.costShareRequired ? … : 'not required'` both collapse `undefined` into "no" — the exact
 * defect this tri-state exists to prevent — and neither reads as wrong at the call site.
 *
 * A `switch` on the returned union is exhaustiveness-checked by tsc, so a consumer that forgets
 * the unstated arm fails to compile rather than shipping a false negative.
 */
export function obligationState(value: boolean | undefined): ObligationState {
  if (value === undefined) return 'unstated';
  return value ? 'yes' : 'no';
}

/**
 * CONTRACT §3 + §10 amendment 7. `costShareRequired` and `coFunderPreference` are OPTIONAL, and
 * their absence means UNSTATED — no fetched page addressed it.
 *
 * They used to be non-optional booleans defaulted to `false` in `normalize/index.ts`, which made
 * every record whose page never mentions cost sharing publish the positive claim "this funder
 * does not require cost sharing". 144 of 150 published records carried that claim, and not one
 * funder had made it. It is the same silence-as-assertion shape as `licenseMin` defaulting to
 * `'NONE'` (71 of 111 entries, and the matcher SKIPS the licence check at `NONE`), `partTimeOK`
 * defaulting to `false` (104 of 112 candidates barred a part-time adult learner) and
 * `ENTITIES_BY_SOURCE[…] ?? []` (an unlisted source accepted nobody).
 *
 * It surfaced on a real capture: Grants.gov's NTIA PWSCIF detail JSON carries `"costSharing":true`
 * while the product published `false`. A cost-share requirement found late is what makes an award
 * unusable to a club with no matching funds — a blank prompts a check, a false negative does not.
 *
 * Read them with {@link obligationState}, never as a bare boolean.
 */
export interface Obligations {
  licenseObligation?: string;
  indirectCostCapPct?: number;
  /** `true` required · `false` the funder said it is not required · absent unstated. */
  costShareRequired?: boolean;
  /** `true` preferred · `false` the funder said it is not · absent unstated. */
  coFunderPreference?: boolean;
  sustainmentObligation?: string;
  reportingObligation?: string;
}

// ---------- the record ----------
export interface Funder {
  id: string;
  name: string;
  homepage: string;
  ein?: string;
  note?: string;
}

export interface Program {
  id: string;
  funderId: string;
  name: string;
  klass: OpportunityClass;
  summary: string;
  applicantEntities: ApplicantEntity[];
  amount: AmountSpec;
  deadline: DeadlineSpec;
  applyVia: ApplyVia;
  applyUrl?: string;
  applyContact?: string;
  constraints: Constraint[];
  fundingRestrictions: string[];
  obligations: Obligations;
  aiPolicy: AiPolicy;
  trust: TrustFields;
  rawOtherText: string;
  tags: string[];
}

// ---------- profiles ----------
export interface StudentProfile {
  kind: 'student';
  callsign?: string;
  licenseClass?: LicenseClass;
  licensedSince?: string;
  state?: string;
  county?: string;
  lat?: number;
  lon?: number;
  callDistrict?: string;
  fieldOfStudy?: string;
  degreeLevel?: DegreeLevel;
  institution?: string;
  accredited?: boolean;
  partTime?: boolean;
  gpa?: number;
  classRankTopPct?: number;
  arrlMemberSince?: string;
  citizenship?: Citizenship;
  birthDate?: string;
  stage?: Stage;
  activityKinds?: ActivityKind[];
  cwWpm?: number;
  financialNeed?: boolean;
  gender?: 'female' | 'male' | 'other' | 'prefer_not_to_say';
}

export interface OrgProfile {
  kind: 'organization';
  entity: ApplicantEntity;
  orgName?: string;
  callsign?: string;
  state?: string;
  lat?: number;
  lon?: number;
  ein?: string;
  is501c3?: boolean;
  hasFiscalSponsor?: boolean;
  arrlAffiliated?: boolean;
  memberCount?: number;
  institutionName?: string;
}

export type Profile = StudentProfile | OrgProfile;

// ---------- matcher ----------
export type Verdict =
  | { kind: 'eligible' }
  | { kind: 'eligible_preferred'; rank: number; met: string[] }
  | { kind: 'ineligible'; reasons: Constraint[] }
  | { kind: 'unknown'; missingProfileFields: string[] };

// ---------- ingestion ----------
export type SourceTier = 'A' | 'B' | 'C' | 'D';

export interface FetchRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  accept: 'html' | 'json' | 'xml' | 'binary';
}

export interface FetchedPayload {
  url: string;
  status: number;
  contentType: string;
  body: string;
  fetchedAt: string;
}

export interface RawOpportunity {
  sourceId: string;
  externalKey: string;
  name: string;
  rawFields: Record<string, string>;
  sourceUrl: string;
  rawText: string;
}

export interface SourceModule {
  id: string;
  funderId: string;
  label: string;
  tier: SourceTier;
  klass: OpportunityClass;
  requests: FetchRequest[] | (() => Promise<FetchRequest[]>);
  parse(payloads: FetchedPayload[]): RawOpportunity[];
  expectedMinRecords: number;
  notes?: string;
}

// ---------- change detection ----------
export type ChangeKind =
  | 'new'
  | 'deadline_changed'
  | 'amount_changed'
  | 'eligibility_changed'
  | 'status_changed'
  | 'vanished'
  | 'parse_yield_dropped';

export interface ChangeEvent {
  id: string;
  sourceId: string;
  programId?: string;
  kind: ChangeKind;
  before?: unknown;
  after?: unknown;
  detectedAt: string;
  fieldPath?: string;
}

export type ReviewDecision = 'pending' | 'approved' | 'rejected' | 'edited';

export interface ReviewItem {
  id: string;
  changeEventId: string;
  candidate: Program;
  decision: ReviewDecision;
  decidedBy?: string;
  decidedAt?: string;
  confidence: number;
  rejectKey?: string;
}
