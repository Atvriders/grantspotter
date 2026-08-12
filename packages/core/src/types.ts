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

/**
 * ONE TIER of a requirement — the whole of `ConstraintSpec` before funders' disjunctions were
 * representable, and still the shape every reader of a spec understands.
 *
 * A tier holds a CONJUNCTION: `{ licenseMin: 'GENERAL', heldMonthsMin: 24 }` means General AND
 * held two years, and `stages: ['HS_SENIOR','UNDERGRAD']` is a list of equals, not a cascade.
 * What it cannot hold is the funder's OTHER offer at a different level of the same axis —
 * "Brevard County, or any Florida resident"; "General held two years, or Extra". See
 * {@link ConstraintAlternatives}, which is where that goes.
 */
export type ConstraintTier =
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

/**
 * THE FUNDER NAMED MORE THAN ONE ROUTE. Two optional fields, one per REASON the extra route could
 * not be written into the tier beside them — and they are different reasons with different honest
 * answers, so they are different fields.
 *
 * ================================ WHY THIS EXISTS ================================
 * Eight refusals were measured whose evidence — the funder's own sentence, the one GrantSpotter
 * prints under the verdict — says the applicant qualifies:
 *
 *   "Resident of Brevard County FL, OR ANY FL RESIDENT"          county[Brevard]  refused a Floridian
 *   "Resident of Gwinnett County GA, OR THE STATE OF GA"         county[Gwinnett] refused a Georgian
 *   "…North Texas Section. ADDITIONAL APPLICANTS TO BE
 *    CONSIDERED: … AND OKLAHOMA RESIDENTS…"                      section[NTX]     refused an Oklahoman
 *   "General Class for at least two years…, OR HOLD A
 *    CURRENT AMATEUR EXTRA CLASS LICENSE"                        GENERAL+24mo     refused an Extra
 *   "UNDERGRADUATE DEGREE or electronic technician
 *    certification program"                                      fields[ette]     refused a Biologist
 *
 * Every one is the same shape: alternatives AT DIFFERENT TIERS, a spec with room for one, an
 * extractor picking a winner, and the losing branch hardening into a refusal. `stages: []` and
 * `fields: []` are already disjunctions and needed nothing; a county AND a state, or a class AND a
 * higher class with no duration, cannot be said inside one tier at all.
 *
 * ============================== WHY THIS SHAPE ==================================
 * `anyOf` is a SIBLING LIST, not a new axis and not a new `ConstraintSpec` member. Every surface
 * that reads a spec today — `IneligibilityDrawer.specDetail`'s exhaustive `switch (spec.axis)`,
 * the printed eligibility report, the CSV, `constraints.spec` in SQLite, `specValues` in
 * `normalize/axes/preference.ts` — keeps reading the tier exactly as it did, because the tier is
 * still the whole object those readers see. A `{ axis: 'any_of' }` union member would have broken
 * every one of them; a per-axis bespoke field (`alsoGeo`, `orLicenseMin`) would have needed the
 * matcher to learn each one separately, which is how the ninth instance gets missed.
 *
 * The FIRST-NAMED, NARROWEST tier stays in the base object, so an unchanged reader shows something
 * the funder really wrote, merely incomplete — and the verbatim sentence beside it (`rawText`,
 * which CONTRACT §3 guarantees) has always carried the rest.
 *
 * NOT RECURSIVE, deliberately: `anyOf` holds {@link ConstraintTier}, not `ConstraintSpec`. Two
 * levels is what funders write and what the corpus contains; a tree would need a reader nobody has.
 *
 * ========================== WHY IT CANNOT HIDE MONEY ============================
 * Both fields are MONOTONE IN THE SAFE DIRECTION, by construction, and that is the property to
 * preserve if either is ever extended:
 *   - `anyOf` is a disjunction. It can only turn a `fail` into a `pass`. It can never invent a
 *     refusal, whatever an extractor puts in it.
 *   - `orUnrepresented` can only turn a `fail` into an `unknown`. Also never a refusal.
 * An extractor bug in either direction therefore costs an applicant a page-read, never an award.
 * "A false exclude hides the money forever, silently" — matcher.ts.
 */
export interface ConstraintAlternatives<Base extends ConstraintTier = ConstraintTier> {
  /**
   * OTHER TIERS OF THE SAME AXIS THE FUNDER NAMED. Any ONE of them satisfies the constraint, as
   * does the tier they hang off: the whole thing is an OR.
   *
   * Use it when the parser CAN say what the funder said and the tier has no room for it —
   * `geo: county[Brevard]` + `anyOf: [geo state[FL]]`, `GENERAL+24mo` + `anyOf: [EXTRA]`. It is
   * NOT for language a parser cannot close; see `orUnrepresented`.
   *
   * SAME AXIS AS ITS BASE, AND THAT IS NOW THE TYPE RATHER THAN A REQUEST. It used to be a comment
   * — "nothing enforces that in the type … extractors keep to their own axis" — and the whole
   * safety argument for `anyOf` rested on it, because a disjunction is only "the funder's other
   * route" while both routes answer the SAME question. Measured against the real `evaluateConstraint`
   * before this changed:
   *
   *   {axis:'field_of_study', fields:['Engineering']} + anyOf:[{axis:'geography', geo:{type:'any'}}]
   *     -> PASS for a Basket Weaving major. The geography tier answers "are you anywhere?", which
   *        everybody is, so an unrelated axis ADMITTED an applicant the field list refuses.
   *
   * That is `anyOf` doing the one thing this comment block swore it could not — inventing an
   * admission — and no test, schema or type stood between an extractor and it. `Base` closes it:
   * {@link ConstraintSpec} distributes over the thirteen tiers, so each arm's `anyOf` accepts only
   * tiers carrying its OWN `axis`, and the line above is a compile error rather than a verdict.
   *
   * The type is the first of two guards, not the only one. `constraints.spec` is a JSON column and
   * a stored row is data, not a checked literal, so `evaluateConstraint` ALSO ignores an alternative
   * whose axis differs from its base at run time. See its comment for why both are needed.
   */
  anyOf?: Array<Extract<ConstraintTier, { axis: Base['axis'] }>>;

  /**
   * THE FUNDER NAMED A ROUTE THIS SCHEMA CANNOT DESCRIBE — verbatim, in the funder's own words.
   *
   * Widening is the wrong remedy here and would be a fabrication. The Robert A. Rodriguez K5AUW
   * Scholarship is "open to graduating high school seniors, AND TO PREVIOUS AWARDEES": the second
   * audience is not a `Stage`, not a `DegreeLevel`, not anything `StudentProfile` holds, and there
   * is no value of any profile field that means "I won this last year". Adding a stage would put a
   * claim in the record the funder never made; refusing a graduate student quotes them a sentence
   * naming a route they might be on.
   *
   * So the axis declines to decide: {@link Verdict} `unknown` with an EMPTY
   * `missingProfileFields` — "something could not be worked out, and there is no input you could
   * fill in to change that", the state `VerdictBadge` already renders and the same one an
   * unmeasurable radius and an unrecorded audience produce. It is not a 'no'.
   *
   * Only consulted when the tier and every `anyOf` alternative have FAILED. An applicant who meets
   * the stated route is eligible, not uncertain.
   */
  orUnrepresented?: string;
}

/**
 * What a constraint requires: one tier, plus whatever else the funder offered.
 *
 * A DISTRIBUTED intersection rather than 13 hand-edited arms, so that the two optional fields
 * cannot drift between axes, and so `switch (spec.axis)` still narrows exactly as before — the
 * conditional type distributes over the union, giving `(A & Alt<A>) | (B & Alt<B>) | …`, and every
 * existing exhaustive switch over the axes still compiles and is still checked for exhaustiveness.
 *
 * The distribution is what carries each arm's own `axis` into its `anyOf` (see
 * {@link ConstraintAlternatives.anyOf}). A plain `ConstraintTier & ConstraintAlternatives` cannot:
 * the intersection is computed once, over the whole union, so `Base['axis']` there would be all
 * thirteen axes at once — which is exactly the hole that let a `geography` alternative admit an
 * applicant a `field_of_study` list refuses.
 */
export type ConstraintSpec = ConstraintTier extends infer Base
  ? Base extends ConstraintTier
    ? Base & ConstraintAlternatives<Base>
    : never
  : never;

/**
 * ONE ARM of {@link ConstraintSpec}, named — `ConstraintSpecFor<'field_of_study'>`.
 *
 * An extractor that builds its spec by SPREADING (`{ ...fieldSpec(…), ...(alts ? { anyOf } : {}) }`)
 * has to hold the arm, not the union: spread a `ConstraintSpec` and TypeScript keeps thirteen
 * possible `anyOf` element types beside one concrete `axis`, so the correlation the same-axis rule
 * is made of is lost and the assignment fails. Annotating with this restores it and is the reason
 * the failure is a compile error at the extractor rather than a wrong verdict at the matcher.
 */
export type ConstraintSpecFor<Axis extends ConstraintAxis> = Extract<ConstraintSpec, { axis: Axis }>;

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

/**
 * A value this tool FETCHED and wrote into a profile field, with the source that stated it and the
 * moment it was read.
 *
 * The product's whole premise is that a value it derived is never indistinguishable from a value
 * somebody stated. `field_provenance` already does that job for programs, but it is `program_id`
 * -keyed and says nothing about a profile — so without this type a licence class a lookup wrote is
 * stored in exactly the same shape as one the applicant typed, and nothing downstream can tell
 * them apart. That is the same silence-as-assertion defect as `costShareRequired` defaulting to
 * `false`, pointed the other way: the profile is what the matcher reasons over, and "the applicant
 * told us they are a General" carries a confidence that "callook.info said so on 4 August, and
 * nobody has checked it" does not.
 *
 * `value` is what makes the marker self-invalidating, and it is the reason this is not a bare
 * boolean flag. A flag has to be CLEARED by whichever code path edits the field, and a path that
 * forgets leaves a "from the FCC record" badge sitting on a value the user typed over it — the
 * precise misattribution this exists to prevent. Holding the filled value instead means an edit
 * invalidates the marker by arithmetic rather than by remembering: see {@link profileValueOrigin}.
 * It is the same device as `FactConfirmation.fingerprint` in `server/src/prose/facts.ts`, which
 * drops a stored confirmation when the text under it changes.
 */
export interface ProfileFieldSource {
  /** The only lookup source that exists today. A second one is an added member, not a rewrite. */
  source: 'callook.info';
  /** ISO. When the source was read — NOT when the record was granted or last updated. */
  fetchedAt: string;
  /**
   * THE VALUE THE SOURCE ITSELF RETURNED, exactly as it was written into the field. The marker
   * describes the field only while the field still holds it.
   *
   * "What the source returned" is narrower than "what was written into the field", and the gap is
   * where this type gets misused. A lookup panel shows the record beside editable inputs, so a
   * value can leave that panel having been TYPED OR CHOSEN BY THE APPLICANT seconds after the
   * record was fetched — most often a licence class, because the three legacy classes map onto
   * none of GrantSpotter's four and the panel deliberately makes the applicant pick one. Recording
   * the applicant's own pick here prints "read from callook.info" over something callook.info never
   * said, and eligibility then rests on a licence class no source stated. A value the applicant
   * picked or typed gets NO marker at all. See `web/src/lib/callsignFill.ts`, which is the one
   * place in this product that builds a marker, and which can only build one from a value carrying
   * `origin: 'source'`.
   */
  value: string;
}

/**
 * WHERE the value now in a profile field came from — with the case where there is no value.
 *
 * `'typed'` is not a weaker `'looked_up'`: it is the applicant's own assertion, which is the
 * strongest thing this tool ever holds. `'looked_up'` means a source said it and nobody has
 * confirmed it, which is what a renderer must be able to say out loud.
 */
export type ProfileValueOrigin = 'typed' | 'looked_up' | 'unset';

/**
 * The ONLY sanctioned way to read a profile field's provenance. Renderers, exporters and the
 * profile editor call this instead of testing the marker's presence, because
 * `if (profile.fieldSources?.state)` reports "filled from callook.info" for a value the applicant
 * has since typed over — a fetched-value badge on a stated value, which is the one mistake this
 * product refuses.
 *
 * A `switch` on the returned union is exhaustiveness-checked by tsc, so a consumer that forgets an
 * arm fails to compile rather than shipping the wrong attribution.
 */
export function profileValueOrigin(
  value: unknown,
  source: ProfileFieldSource | undefined,
): ProfileValueOrigin {
  if (value === undefined || value === null) return 'unset';
  if (source === undefined) return 'typed';
  // An edit makes the value the applicant's. Equality against the filled value is what makes that
  // true without any code path having to remember to clear the marker.
  return source.value === String(value) ? 'looked_up' : 'typed';
}

/**
 * WHICH profile fields a callsign lookup may fill, encoded as the shape of a type rather than as a
 * list somebody has to keep in step.
 *
 * A student's callsign, licence class and state are the three the FCC record can support. Two
 * absences are load-bearing, and both are traps somebody will otherwise walk into:
 *   - `licensedSince` is NOT here. callook's `grantDate` resets on every renewal and every vanity
 *     change, so it is not "date first licensed" — and `licensedSince` feeds `heldMonthsMin` in
 *     the matcher, where a wrong value produces a confidently wrong ELIGIBLE.
 *   - `county` is NOT here. The record carries a city and a state and no county at all.
 * `callDistrict` is absent for a third reason: it is DERIVED from the callsign by
 * `callDistrictFromCallsign`, so attributing it to callook.info would credit a source for this
 * tool's own arithmetic.
 */
export interface StudentFieldSources {
  /**
   * Present ONLY when the source answered with a DIFFERENT callsign than the applicant asked
   * about, which is the one case where the callsign is an answer rather than the question.
   *
   * callook answers a lookup of a SUPERSEDED callsign with the licensee's CURRENT record — see the
   * note beside `previous.callsign` in `server/src/callsign/callook.ts` — so accepting a record
   * found for "K9OLD" can put "W5NEW" in this field. That value came from the source, the applicant
   * never typed it, and without a marker it is stored exactly like a callsign they did. When the
   * record's callsign IS the one they typed it is theirs, and carries no marker.
   */
  callsign?: ProfileFieldSource;
  licenseClass?: ProfileFieldSource;
  state?: ProfileFieldSource;
}

/**
 * The organisation half. A club station's record has an ORGANISATION NAME and an EMPTY operator
 * class — a collegiate club station is exactly that shape — so `orgName` is fillable here and
 * there is no licence class to fill.
 */
export interface OrgFieldSources {
  orgName?: ProfileFieldSource;
  /** Same rule, same reason as {@link StudentFieldSources.callsign}: a club callsign is superseded
   * exactly as an individual's is, and an organisation profile holds one too. */
  callsign?: ProfileFieldSource;
  state?: ProfileFieldSource;
}

/**
 * Keys of a stored profile that are NOT fields an applicant fills in: the discriminant, and the
 * provenance map that describes the other keys.
 *
 * Exported because `web/src/lib/profileFields.test.ts` asserts the profile-field registry against
 * `Object.keys(studentProfileSchema.shape)` in BOTH directions — a field added to the contract
 * must arrive in the registry with a label and a help sentence, and a registry entry naming a
 * field that no longer exists must fail. That assertion needs to know which keys are not fields,
 * and a `k !== 'kind'` in the test file is a second place for that answer to live. Anything added
 * here is invisible to the registry check, so `profileProvenance.test.ts` pins the list.
 */
export const PROFILE_NON_FIELD_KEYS = ['kind', 'fieldSources'] as const;

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
  /** Read it with {@link profileFieldOrigin}, never by testing a key's presence. */
  fieldSources?: StudentFieldSources;
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
  /** Read it with {@link profileFieldOrigin}, never by testing a key's presence. */
  fieldSources?: OrgFieldSources;
}

export type Profile = StudentProfile | OrgProfile;

/**
 * `profileValueOrigin` for a field of a whole profile — what a renderer actually holds.
 *
 * `field` is a plain string because callers pass the matcher's own `missingProfileFields` names
 * and the profile-field registry's keys, neither of which is typed per profile kind. A field that
 * cannot carry a marker at all (`gpa`, `callDistrict`, `licensedSince`) answers `'typed'` whenever
 * it holds a value, which is the truth: nothing but the applicant can have put it there.
 */
export function profileFieldOrigin(profile: Profile, field: string): ProfileValueOrigin {
  // One cast, here, rather than at every call site: `Profile` is a union of interfaces, and an
  // interface gets no index signature, so neither half can be read by a computed key without it.
  const record = profile as unknown as {
    [key: string]: unknown;
    fieldSources?: Record<string, ProfileFieldSource | undefined>;
  };
  return profileValueOrigin(record[field], record.fieldSources?.[field]);
}

/**
 * The profile as it should be STORED: every marker that no longer describes the value beside it is
 * dropped.
 *
 * {@link profileValueOrigin} already makes a stale marker inert to anything that reads it
 * correctly, so this is the second half of the same guarantee rather than the first — it stops a
 * marker for a value the applicant typed over from sitting in the database, where the next reader
 * (a report, an export, a migration, a future agent's `if (fieldSources.state)`) has to be trusted
 * to discount it. A marker whose field is empty goes too: provenance for a value that is not there
 * describes nothing.
 *
 * Call it on the way IN to storage, not on the way out — dropping it on read would leave the
 * stored record disagreeing with every rendering of it.
 */
export function pruneFieldSources(profile: Profile): Profile {
  const record = profile as unknown as {
    [key: string]: unknown;
    fieldSources?: Record<string, ProfileFieldSource | undefined>;
  };
  if (record.fieldSources === undefined) return profile;

  const kept: Record<string, ProfileFieldSource> = {};
  for (const [field, source] of Object.entries(record.fieldSources)) {
    if (source === undefined) continue;
    if (profileValueOrigin(record[field], source) === 'looked_up') kept[field] = source;
  }

  const next: Record<string, unknown> = { ...record };
  // An empty map is deleted rather than stored as `{}`: "no field was filled by a lookup" and
  // "this profile predates provenance" are the same statement, and they should serialise the same.
  if (Object.keys(kept).length === 0) delete next.fieldSources;
  else next.fieldSources = kept;
  return next as unknown as Profile;
}

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

