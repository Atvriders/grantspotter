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

/**
 * Obligations we assert for every record of a source. EVERY ENTRY HERE IS AN ASSERTION ABOUT A
 * FUNDER'S TERMS MADE FROM A TABLE IN OUR CODE, so the bar is the same as for a parsed field:
 * a sentence on a page we actually fetched. `Obligations` has no provenance field (unlike
 * `AiPolicy`, which requires `quote` + `url`), so the quote lives in the comment beside the
 * entry and the capture it came from is named.
 *
 * REMOVED 2026-08-03, close-out review B3 — four assertions no capture supports. TWO OF THE FOUR
 * CAME BACK the same day, once a source actually fetched ARDC's application pages; they are now in
 * OBLIGATIONS_BY_RECORD below, with their quotes. The other two stay removed:
 *
 *   yaesu-dr2x  sustainmentObligation "The repeater must remain on the air for 12 months."
 *     `twelve`, `12 month`, `on the air`, `remain` and `obligation` all appear ZERO times in the
 *     145,639-byte real capture (fixtures/yaesu-dr2x/00-systemfusion-yaesu-com.html). The
 *     sentence existed only in three synthetic fixtures an implementer wrote, while the module's
 *     own notes said the obligation "is NOT stated anywhere on the landing page … so
 *     sustainmentObligation is absent from the live record rather than asserted" — false of the
 *     shipped record. It is now read from `rawFields.sustainment` instead (below), which the
 *     Yaesu parser writes when, and only when, a page really does carry the sentence.
 *
 *   arrl-club-grant  coFunderPreference: true
 *     Copied from its sibling. `sole funder`, `preference`, `matching` and `co-fund` appear zero
 *     times in fixtures/arrl-club-grant/00-www-arrl-org-club-grant-program.html. The sentence
 *     belongs to arrl-amateur-radio-grants, which keeps the entry below.
 */
const OBLIGATIONS_BY_SOURCE: Readonly<Record<string, Partial<Obligations>>> = Object.freeze({
  // fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html, verbatim: "The
  // ARRL Foundation does not wish to be the sole funder of a proposal and gives preference to
  // groups that provide evidence of other successful fundraising conducted prior to applying."
  'arrl-amateur-radio-grants': { coFunderPreference: true },
  // fixtures/ncdxf-grants/00-www-ncdxf-org-pages-grant-app-html.html, verbatim: "A basic
  // philosophy of the NCDXF is that expedition participants themselves should have a significant
  // financial stake in their expedition and that the expedition should be likely to proceed even
  // without financial support from the NCDXF."
  'ncdxf-grants': { costShareRequired: true },
});

/**
 * Obligations the FUNDER's own page stated and a parser captured, per record. These outrank the
 * table above: a sentence on the page beats our research about the source.
 *
 * `sustainment` — the Yaesu parser's `/([^.]*(?:twelve months|12 months)[^.]*\.)/` over the
 *   flattened page. Absent from the live capture, present in the synthetic ones, which is
 *   exactly the behaviour wanted: where a page says it, we publish the funder's own sentence;
 *   where no page says it, the record carries no obligation at all.
 * `costSharing` — Grants.gov's own boolean on the opportunity detail. NTIA PWSCIF's capture
 *   (fixtures/grants-gov-federal/05-…-fetchopportunity.json) carries `"costSharing":true` in the
 *   same JSON object `parseOpportunityDetail` already reads `responseDate` out of, while the
 *   product published `costShareRequired: false`. A cost-share requirement discovered late is
 *   a wasted application.
 *
 *   ALL THREE STATES COME OUT OF THIS ONE FUNCTION, which is why the `else if` is spelled out
 *   rather than written `found.costShareRequired = costSharing === 'true'`: `'true'` is the
 *   funder saying required, `'false'` is the funder saying not required — a real answer worth
 *   publishing — and ANY OTHER VALUE, missing key included, leaves the key unset so the record
 *   reads as unstated. A hit whose detail leg never ran must not answer the question.
 */
function obligationsFromRawFields(raw: RawOpportunity): Partial<Obligations> {
  const found: Partial<Obligations> = {};
  const sustainment = raw.rawFields.sustainment;
  if (sustainment !== undefined && sustainment.trim() !== '') {
    found.sustainmentObligation = sustainment.trim();
  }
  const costSharing = raw.rawFields.costSharing;
  if (costSharing === 'true') found.costShareRequired = true;
  else if (costSharing === 'false') found.costShareRequired = false;
  return found;
}

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

  /**
   * RESTORED 2026-08-03, and only because the bytes finally exist. B3 removed both of these as
   * assertions about pages nothing fetched, and its removal note ended "The enumerated licence
   * list is not on that page either" — THAT NOTE IS NOW WRONG IN BOTH DIRECTIONS. `ardc-grants.ts`
   * now requests https://www.ardc.net/apply/ and .../apply/grant-application-instructions/ as
   * first-phase requests (HTTP 200 both, committed as fixtures/ardc-grants/02-apply.html, 69,778
   * bytes, and 03-apply-instructions.html, 85,018 bytes), and the licence list is on the FIRST of
   * those two, not the instructions page the note was talking about. Grepped, not remembered:
   * `freely available` 2 hits in 02, `indirect` 5 hits in 03, `open access` 2 hits in each.
   *
   * KEYED PER RECORD, not per source, deliberately. `ardc-grants` also emits eight year-archive
   * children (`past_award`, `do_not_publish`) that are histories of money already handed out; the
   * 2026 application terms are not their terms. `'apply'` is the externalKey of the one record
   * these two pages produced, and ardc-grants.ts pins it as "stable and independent of the CMS".
   *
   * NOT SET HERE: `costShareRequired`. The instructions page's only cost-share sentence is
   * CONDITIONAL — "If your organization's indirect cost rate is more than 20%, we ask that you
   * cost-share any indirect amount over 20%" — so `true` over-states it for an organisation at or
   * under 20% and `false` contradicts the page for one above it. Unstated is the honest third
   * answer, and the reason this field became optional.
   */
  [sourceKeyOf('ardc-grants', 'apply')]: {
    // fixtures/ardc-grants/02-apply.html @46128, section "Open Access Requirement", verbatim
    // apart from the page's three <li> line breaks rendered here as "; ".
    licenseObligation:
      'Because ARDC works with and for the public, we require that the work of the projects we ' +
      'fund be freely available to everyone who can benefit and to everyone who can contribute. ' +
      'Thus, all technology, documentation, and other materials produced using ARDC funds must ' +
      'be made freely available to the public, ideally using one of the below open source ' +
      'licenses: Software: GPL licenses (esp. AGPLv3), MIT, BSD, LGPL; Hardware: CERN Open ' +
      'Hardware License; Media, writing, images etc.: Free Culture subset of the Creative ' +
      'Commons licenses, particularly CC-BY-SA, as well as CC-BY and CC0.',
    // fixtures/ardc-grants/03-apply-instructions.html @50638, list item "Indirect
    // costs/contingency", verbatim: "You may include up to 20% for indirect costs, such as
    // phone, internet, rent, accountants, software, bank fees, human resources, lawyers, small
    // supplies, contingency for unexpected project costs, and anything else that can be hard to
    // itemize."
    indirectCostCapPct: 20,
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

export const ENTITIES_BY_SOURCE: Readonly<Record<string, ApplicantEntity[]>> = Object.freeze({
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
  // ADDED with this fix, from the funder's own captured page. NCDXF's grant guidelines
  // (fixtures/ncdxf-grants/00-www-ncdxf-org-pages-grant-app-html.html) name the audience in one
  // sentence the parser already extracts as `audience`: "individuals and groups who use amateur
  // radio communications to advance and promote education, science and international goodwill."
  // With no entry here it published `applicantEntities: []`, and the matcher's entity gate reads
  // an empty list as "accepts nobody" — a real, live ham grant that no profile in the corpus
  // could reach. "Groups" is left at the two club shapes and NOT extended to universities: the
  // page's own subject is DXpeditions and expedition teams, and it never mentions an institution.
  'ncdxf-grants': ['individual', 'club_unincorporated', 'club_501c3'],
});

/**
 * WHAT AN UNKNOWN APPLICANT-ENTITY LIST MEANS, decided here rather than defaulted.
 *
 * `applicantEntities: ENTITIES_BY_SOURCE[ctx.sourceId] ?? []` treated two completely different
 * findings as the same value: "the funder accepts none of the entities we model" (rare, and a
 * real answer) and "nobody has established who may apply" (common, and not an answer at all).
 * `matcher.ts` hard-fails on the empty list either way — its own reason string even reads
 * "(none recorded)" — so the second one silently barred 76 of 197 candidates from every profile.
 * That is the same silence-as-prohibition shape as `licenseMin` defaulting to `'NONE'` and
 * `partTimeOK` defaulting to `false`.
 *
 * THE RULE, in precedence order — see `applicantEntitiesFor`:
 *   1. what the FUNDER published, per record (`rawFields.applicantTypes`), including its own
 *      explicit refusal to enumerate;
 *   2. `ENTITIES_BY_SOURCE`, which is our research on that source's own page;
 *   3. an entry in THIS table, which keeps the empty list but makes it a statement somebody
 *      signed rather than a value that fell out of a `??`.
 *
 * WHY (3) IS STILL EMPTY AND NOT "EVERY ENTITY", measured rather than assumed. Defaulting the
 * unknown case to every entity was tried against the real corpus: it takes the individual-facing
 * candidate pool from 121 to 187 and the unlicensed-high-school-senior profile from 2 eligible
 * programmes to 63 — 45 of those being `nsf-funding-rss` items that `buildReviewItems` already
 * drops (every one scores 1 or 0 against an adjacency threshold of 6, so no user is ever shown
 * one), and 16 being `manual-tier-d` records whose own researched status is `no_application` or
 * `contact_only`. The asymmetry argument for permissiveness holds when a false include costs one
 * applicant one page-read; it inverts when the false includes outnumber the true answers 30 to 1
 * and bury them. So the unknown case stays empty AND STAYS VISIBLE: `normalize/index.test.ts`
 * fails if any candidate-producing source id is absent from both tables, which is what turns the
 * next new source's blank entity list from a silent exclusion into a build failure.
 */
export const ENTITIES_UNKNOWN_BY_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  'grants-gov-federal':
    'Per RECORD, not per source: entities come from the detail leg’s rawFields.applicantTypes ' +
    '(see APPLICANT_TYPE_RULES). A hit whose detail fetch did not run carries no eligibility ' +
    'list at all, and Grants.gov posts ~5,000 opportunities with no shared audience, so there is ' +
    'no source-level answer to write here.',
  'grants-gov-extract':
    'The daily XML extract publishes no applicant-type element at all — OpportunitySynopsisDetail ' +
    'carries title, agency, description, dates and status, and nothing about eligibility. The ' +
    'hydrated search2+detail leg (grants-gov-federal) is where that answer exists.',
  'nsf-funding-rss':
    'An NSF solicitation feed: title, link and synopsis, no eligibility field. NSF’s PAPPG ' +
    'audience is institutional, but the feed never states it per solicitation and guessing it ' +
    'here would be a table entry with no page behind it. All 45 real items score 1 or 0 against ' +
    'ADJACENCY_THRESHOLD 6, so buildReviewItems drops every one and none has ever reached a user.',
  'manual-tier-d':
    'Sixteen different funders under one source id, so a source-level list cannot be right for ' +
    'all of them (OBLIGATIONS_BY_RECORD exists for the same reason). Their researched statuses ' +
    'are mostly no_application or contact_only — YASME and HamSCI select recipients themselves, ' +
    'the Icom/DXE record is a relationship, and RCA is nominated_by_institution — so an entity ' +
    'list would describe an application route most of them do not have.',
  'arrl-foundation-special-funds':
    'A funder-provenance page for named donor endowments. Its one sentence — "The ARRL Foundation ' +
    'manages special funds that provide awards to celebrate individual accomplishments and grant ' +
    'for youth-oriented Amateur Radio activities" — describes what the funds do, never who may ' +
    'apply, and the page carries no application at all.',
  'ardc-award-tables':
    'Every record it produces is recordType past_award, tagged do_not_publish: money already ' +
    'handed out. Stored as evidence about a funder, never queued and never matched, so it has no ' +
    'applicant to model.',
  'nsf-awards': 'Past NSF awards, recordType past_award and do_not_publish. Same as ardc-award-tables.',
  usaspending:
    'Past federal obligations, recordType past_award and do_not_publish. Same as ardc-award-tables.',
  'arrl-summary-of-scholarship-requirements':
    'A crosscheck-only source (recordType crosscheck, do_not_publish) whose own notes call it ' +
    'STALE — 79 entries against the catalog’s 111. It corroborates other sources and never ' +
    'publishes, so it has no applicant of its own.',
});

/**
 * Every entity CONTRACT §3 models except `nominated_by_institution`, which is not an applicant
 * type at all — it is the marker for "you cannot apply; an institution puts you forward", and
 * `inferStatus` turns it into `contact_only`. Including it in a permissive set would advertise a
 * direct application route that does not exist.
 */
const ALL_APPLICANT_ENTITIES: readonly ApplicantEntity[] = Object.freeze([
  'individual',
  'teacher',
  'club_unincorporated',
  'club_501c3',
  'club_via_fiscal_sponsor',
  'school_lea',
  'university',
  'university_dept',
  'ieee_student_branch_chapter',
]);

/** The organisation half of the above: everything that is not a natural person. */
const ORGANISATION_ENTITIES: readonly ApplicantEntity[] = Object.freeze(
  ALL_APPLICANT_ENTITIES.filter((e) => e !== 'individual' && e !== 'teacher'),
);

/**
 * Grants.gov's applicant-type vocabulary, mapped onto the entities CONTRACT §3 models. Matched in
 * order, first rule wins per listed type, and the results are unioned across the whole list.
 *
 * The two non-enumerable values are the interesting ones, and they are NOT the same:
 *
 *   "Others (see text field entitled ..." — the funder declining to pick from the vocabulary.
 *     Mapped to the ORGANISATION entities only, because `Individuals` is itself one of the values
 *     in that vocabulary: a NOFO open to natural persons selects it, and one that instead reaches
 *     for "Others" is naming organisation shapes the list cannot express. The committed capture
 *     confirms it — NTIA PWSCIF lists exactly this value, and its own applicantEligibilityDesc
 *     reads "The applicant must be organized under the laws of the United States or a State
 *     thereof, with its principal place of business in the United States", which no individual
 *     can satisfy. Reading it as "everyone" put a $-millions AI-RAN NOFO in front of an
 *     unlicensed high-school senior as ELIGIBLE.
 *
 *   "Unrestricted (i.e., open to any type of entity above)" — the funder saying every type
 *     qualifies, `Individuals` included, in so many words. Mapped to everything. Absent from the
 *     current captures; pinned by test so the distinction cannot rot into the rule above.
 *
 * A type with no counterpart here (state/county/city governments, tribal governments, housing
 * authorities, small businesses, other for-profits) contributes nothing. If a NOFO's whole list
 * is such types, the mapped result is genuinely empty — and that empty list is the FUNDER's
 * answer, not our silence.
 */
const APPLICANT_TYPE_RULES: ReadonlyArray<{ match: RegExp; entities: readonly ApplicantEntity[] }> =
  Object.freeze([
    // Must precede the bare 501(c)(3) rule below — this description contains that string too.
    { match: /\bdo(?:es)? not have a 501\(c\)\(3\)/i, entities: ['club_unincorporated'] },
    { match: /\b501\(c\)\(3\)/i, entities: ['club_501c3'] },
    { match: /institutions? of higher education/i, entities: ['university', 'university_dept'] },
    { match: /independent school districts?/i, entities: ['school_lea'] },
    { match: /^individuals\b/i, entities: ['individual'] },
    { match: /^unrestricted\b/i, entities: ALL_APPLICANT_ENTITIES },
    { match: /^others\b/i, entities: ORGANISATION_ENTITIES },
  ]);

/**
 * `rawFields.applicantTypes` — Grants.gov's real eligibility list, written by `federal/grantsGov.ts`
 * as `'; '`-joined descriptions — turned into entities. `undefined` when the source published no
 * list, which is what hands the decision back to the tables above.
 */
export function entitiesFromApplicantTypes(value: string | undefined): ApplicantEntity[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const found = new Set<ApplicantEntity>();
  for (const type of value.split(';')) {
    const text = type.trim();
    if (text === '') continue;
    const rule = APPLICANT_TYPE_RULES.find((r) => r.match.test(text));
    if (rule) for (const entity of rule.entities) found.add(entity);
  }
  // Stable order, so two runs of the crawler cannot produce two different contentHashes for the
  // same record just because a Set iterated differently.
  return ALL_APPLICANT_ENTITIES.filter((entity) => found.has(entity));
}

/** Precedence: what the funder published, then our research on the source, then the signed blank. */
function applicantEntitiesFor(raw: RawOpportunity, ctx: NormalizeContext): ApplicantEntity[] {
  return (
    entitiesFromApplicantTypes(raw.rawFields.applicantTypes) ?? ENTITIES_BY_SOURCE[ctx.sourceId] ?? []
  );
}

/**
 * Where this program says to apply, in the order of how directly the funder said it.
 *
 * `applyUrl` FIRST, and it is the whole of close-out review B2. `sources/tier-c-a.ts` parses
 * QCWA's own sentence — "Applications are available and completed online via the ARRL Foundation
 * website: https://www.arrl.org/scholarship-descriptions" — into `rawFields.applyUrl`, its test
 * asserts the capture, and until now NOTHING READ IT: the record published qcwa.org instead, the
 * page the reader was already on. `arrl-scholarship-descriptions` now writes the same key from
 * the "Go Now" href it had been deleting, which moves 89 more records off the catalogue page and
 * onto the application form.
 *
 * `?? raw.sourceUrl` is the honest last resort, not an answer: it means no page named a route,
 * and it is indistinguishable in the output from one that did. That is worth fixing at the type
 * level (`applyUrl?: string` is optional in CONTRACT §3 — a record could carry no apply URL and
 * let Plan 3 render "no application link published" instead of a link that goes nowhere useful),
 * but changing it is a `packages/core` decision and every consumer's, not this file's alone.
 */
function applyUrlFor(raw: RawOpportunity): string {
  return (
    raw.rawFields.applyUrl ?? raw.rawFields.formUrl ?? raw.rawFields.detailUrl ?? raw.sourceUrl
  );
}

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
  // `excerpt` — the WordPress REST API's own summary field on an ARDC page — was listed in
  // rawFieldsContract.test.ts as a write-only DEFECT for want of exactly this reader. It sits
  // after the parsed fields and before the raw-text dump: the funder's own one-line summary is
  // better than a flattened page, and worse than a field a parser understood.
  const source =
    firstOf(raw.rawFields, ['summary', 'audience', 'eligibility', 'excerpt', '__preamble']) ||
    raw.rawText;
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
  /**
   * NO DEFAULTS. This object used to open with `costShareRequired: false, coFunderPreference:
   * false`, and those two literals were the whole defect: a page that never mentions cost sharing
   * produced a record that positively told the reader no cost share is required. 144 of the 150
   * publishable records carried that claim and no funder had made it — the same shape as
   * `licenseMin` defaulting to `'NONE'` past a matcher that skips the check at `NONE`.
   *
   * Both fields are now optional (CONTRACT §3, §10 amendment 7) and ABSENT MEANS UNSTATED. A
   * spread of `undefined`-valued keys would defeat that — `{...{a: undefined}}` still creates the
   * key — but nothing here ever writes one: the tables below are hand-written and omit rather than
   * blank, and `obligationsFromRawFields` only assigns on a value it recognised.
   */
  const obligations: Obligations = {
    ...OBLIGATIONS_BY_SOURCE[ctx.sourceId],
    ...OBLIGATIONS_BY_RECORD[recordKey],
    // Last, because the funder's own published value outranks any table in this file.
    ...obligationsFromRawFields(raw),
  };

  const program: Program = {
    id,
    funderId: ctx.funderId,
    name: raw.name,
    klass: ctx.klass,
    summary: buildSummary(raw),
    applicantEntities: applicantEntitiesFor(raw, ctx),
    amount: buildAmount(raw, ctx),
    deadline: inferDeadline(raw, ctx),
    applyVia: APPLY_VIA_BY_SOURCE[ctx.sourceId] ?? 'page_form',
    applyUrl: applyUrlFor(raw),
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
