/**
 * THE SEED VALIDATION HARNESS.
 *
 * The seeded corpus is the product's starting content. A wrong value here ships to every
 * installation and looks authoritative, because it arrives with a source URL, a verification date
 * and a content hash beside it. This codebase has already had to remove, at length:
 *
 *   - a Yaesu "12-month on-air obligation" that appears ZERO times in the funder's 145,639-byte
 *     capture and existed only in three fixtures an implementer wrote;
 *   - 148 records asserting "no cost share required" when no funder had said so in words;
 *   - 345 awards advertising a grant recipient's Facebook page as where to apply;
 *   - 116 programmes badged `open` against a portal that says twice "The 2026 Scholarship Cycle
 *     is now closed."
 *
 * Every one of those was a plausible value nobody checked, and every one passed zod. So the
 * deliverable of Task 11 is not the four anchor records — it is this file: the thing that stops
 * the NEXT batch from shipping a fact no page supports.
 *
 * WHAT IT CANNOT DO. It has no network and no page text, so it cannot confirm that a quote
 * appears at the URL beside it, that an amount is the amount the funder published, or that a
 * programme still exists. What it CAN do is refuse a record that makes a claim without declaring
 * where the claim came from, and refuse a record that contradicts itself. Both of those describe
 * every defect in the list above.
 *
 * THE SIDE-CAR KEYS. CONTRACT §3 freezes `Program`, and `Obligations` has no provenance field
 * (unlike `AiPolicy`, which requires `quote` + `url`). So the provenance a seed record must
 * declare travels BESIDE the record in the same JSON object, exactly as `sourceKey` does:
 *
 *   "sourceKey": { "sourceId": …, "externalKey": … }   optional — RESOLUTIONS R9, Task 16 writes it
 *   "dates":     { "basis": "projected" | "funder_published" | "unpublished" }        REQUIRED
 *   "evidence":  { "obligations": { "<field>": { "quote": …, "sourceUrl": … } } }     per obligation
 *
 * `programSchema` is a plain (non-strict) zod object and strips all three on parse, so they never
 * reach the database as part of the record; they are read here from the same raw JSON.
 */
import { z } from 'zod';
import type { Funder, Obligations, Program } from '@grantspotter/core';
import {
  OBSERVED_WINDOW_MARKER,
  RECURRENCE_PREFIX,
  funderSchema,
  httpUrlSchema,
  parseObservedWindow,
  parseRecurrence,
  programSchema,
} from '@grantspotter/core';
import { BLOCKED_HOSTS, assertNotBlocked } from '../fetcher/blocklist.js';
import { PRIVATE_IPV4_PROSE_PATTERNS } from '../net/hosts.js';
import { DO_NOT_PUBLISH_TAG, isDoNotPublish } from '../normalize/index.js';

/**
 * A record whose purpose is to WARN rather than to offer — the hijacked `farweb.org` domain that
 * live ARRL and QCWA pages still link to, and anything else in that class Task 14 adds. It is a
 * real seed record so that a student searching "FAR" is told what happened instead of finding
 * nothing, and the shape rules below are what stop it from ever reading as an opportunity.
 */
export const SAFETY_WARNING_TAG = 'safety_warning';

export const SEED_RULE_IDS = [
  'json',
  'schema',
  'unknown-key',
  'funder-homepage',
  'content-hash-placeholder',
  'verification-stamp',
  'summary-excerpt',
  'constraint-shape',
  'obligation-evidence',
  'dates-basis',
  'dates-basis-consistency',
  'undeclared-date',
  'utc-instant-in-prose',
  'status-contradiction',
  'terminal-has-application',
  'blocked-host',
  'blocked-host-in-prose',
  'safety-warning-shape',
  'suppression-tag',
  'private-host-detail',
  'duplicate-id',
  'orphan-funder',
  'duplicate-source-key',
  'source-key-orphan',
] as const;

export type SeedRuleId = (typeof SEED_RULE_IDS)[number];

export interface SeedViolation {
  /** Seed file the record came from, so the message names something a maintainer can open. */
  file: string;
  /** Program or funder id, or `''` when the record is too malformed to have one. */
  recordId: string;
  rule: SeedRuleId;
  message: string;
}

export class SeedValidationError extends Error {
  readonly violations: readonly SeedViolation[];
  constructor(violations: readonly SeedViolation[]) {
    const shown = violations.slice(0, 20);
    super(
      `The seed corpus failed validation with ${violations.length} violation(s):\n` +
        shown.map((v) => `  [${v.rule}] ${v.file} ${v.recordId}: ${v.message}`).join('\n') +
        (violations.length > shown.length ? `\n  …and ${violations.length - shown.length} more.` : ''),
    );
    this.name = 'SeedValidationError';
    this.violations = violations;
  }
}

/* ------------------------------------------------------------------ side-car declarations ---- */

export type DateBasis = 'projected' | 'funder_published' | 'unpublished';

export const DATE_BASES: readonly DateBasis[] = ['projected', 'funder_published', 'unpublished'];

/**
 * How rare `funder_published` is IN THE CORPUS THIS FILE GUARDS, said once so the two messages
 * below cannot disagree.
 *
 * The messages used to read "Only 4 of 244 cycles in this corpus are funder-published". Neither
 * number described `data/seed/`: 4-of-243 and 4-of-244 were both committed for the same claim, and
 * both were taken over the FIXTURE corpus (`scripts/profile-corpus.ts`), which is a different
 * population from the records a seed author is editing when they read this. Worse, a CYCLE count
 * is not a fact about the corpus at all — it is a fact about the corpus AND the day you ask, since
 * a window that has closed stops resolving. Counting RECORDS instead gives the author the number
 * that is actually true of the files in front of them, and holds still.
 *
 * `validate.test.ts` recomputes both figures from `data/seed/` and fails naming the new ones, so
 * a batch that adds records cannot leave this sentence quietly wrong the way the last one was.
 */
export const SEED_RECORD_COUNT = 144;
export const SEED_FUNDER_PUBLISHED_RECORDS = 3;

const FUNDER_PUBLISHED_IS_RARE =
  `Only ${String(SEED_FUNDER_PUBLISHED_RECORDS)} of the ${String(SEED_RECORD_COUNT)} records in ` +
  'data/seed/ declare basis "funder_published"';

/**
 * The six fields of `Obligations`. Enumerated rather than derived from a value, because a field
 * added to the type without a line here would ship unevidenced — which is how the removed 148
 * got in.
 */
export const OBLIGATION_FIELDS = [
  'licenseObligation',
  'indirectCostCapPct',
  'costShareRequired',
  'coFunderPreference',
  'sustainmentObligation',
  'reportingObligation',
] as const;

export type ObligationField = (typeof OBLIGATION_FIELDS)[number];

const obligationEvidenceSchema = z.object({
  quote: z.string(),
  sourceUrl: httpUrlSchema,
});

export const sideCarSchema = z.object({
  sourceKey: z
    .object({ sourceId: z.string().min(1), externalKey: z.string().min(1) })
    .strict()
    .optional(),
  dates: z.object({ basis: z.enum(['projected', 'funder_published', 'unpublished']) }).strict(),
  evidence: z
    .object({
      obligations: z
        .object({
          licenseObligation: obligationEvidenceSchema.optional(),
          indirectCostCapPct: obligationEvidenceSchema.optional(),
          costShareRequired: obligationEvidenceSchema.optional(),
          coFunderPreference: obligationEvidenceSchema.optional(),
          sustainmentObligation: obligationEvidenceSchema.optional(),
          reportingObligation: obligationEvidenceSchema.optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
});

export type SeedSideCar = z.infer<typeof sideCarSchema>;

/** Program fields (CONTRACT §3) plus the three side-car keys. Anything else is a typo. */
const ALLOWED_PROGRAM_KEYS: ReadonlySet<string> = new Set([
  'id', 'funderId', 'name', 'klass', 'summary', 'applicantEntities', 'amount', 'deadline',
  'applyVia', 'applyUrl', 'applyContact', 'constraints', 'fundingRestrictions', 'obligations',
  'aiPolicy', 'trust', 'rawOtherText', 'tags',
  'sourceKey', 'dates', 'evidence',
]);

const ALLOWED_FUNDER_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'homepage', 'ein', 'note']);

/* ------------------------------------------------------------------------------ detectors ---- */

/** A full calendar date, in any shape a curator would plausibly type. */
const CONCRETE_DATE_PATTERNS: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
  /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/i,
];

/**
 * An ISO instant. `2027-03-01T04:59Z` IS the funder's 28 February in America/New_York — a record
 * that prints the instant instead of the local wall date has already lost the day, and the reader
 * has no way to tell which day was meant.
 */
const UTC_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?\s?(?:Z|[+-]\d{2}:?\d{2})/i;

/**
 * The canonical IANA area prefixes. `Intl.DateTimeFormat` — which is all `parseRecurrence` can
 * check — also accepts the legacy fixed-offset aliases `EST`, `MST`, `HST`, `EST5EDT` and the
 * `US/…`, `Etc/…` and `SystemV/…` containers. A fixed-offset zone silently ignores daylight
 * saving, so a 23:59 deadline projected under `tz=EST` is an hour out for seven months of the
 * year and can land on the wrong calendar day. A deadline zone must be a real place.
 */
const IANA_AREAS: ReadonlySet<string> = new Set([
  'Africa', 'America', 'Antarctica', 'Arctic', 'Asia', 'Atlantic', 'Australia', 'Europe',
  'Indian', 'Pacific',
]);

/**
 * A funder saying the door is shut. `status: 'open'` over any of these is the exact shape of the
 * 116-record defect: the closure sentence was captured INTO the record and the badge above it
 * still said open.
 */
const CLOSED_PHRASES: readonly RegExp[] = [
  /\b(?:cycle|round|window|application|applications|program|programme)\b[^.]{0,60}?\b(?:is|are)\s+(?:now\s+)?closed\b/i,
  /\bno longer accept(?:ing|s|ed)?\b/i,
  /\bapplications?\s+(?:have\s+)?closed\b/i,
  /\bis\s+(?:now\s+)?discontinued\b/i,
];

/**
 * Host detail that must never reach a public repository (feedback: no real LAN IPs or paths).
 *
 * The three IP ranges are no longer written here. `config.ts` needs the same ranges to refuse a
 * CONTACT_URL pointing into somebody's LAN, and two hand-maintained copies of "what is a private
 * address" is the shape of defect this repository keeps finding; `net/hosts.ts` holds the one list
 * and exports it word-bounded for prose (here) and anchored for a hostname (there).
 * `net/hosts.test.ts` pins these patterns against the literals this array used to contain, so the
 * merge is provably verdict-preserving for the seed corpus.
 */
const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  ...PRIVATE_IPV4_PROSE_PATTERNS,
  /\/home\/[a-z0-9_.-]+\//i,
  /\/Users\/[A-Za-z0-9_.-]+\//,
  /\bC:\\Users\\/i,
];

/**
 * Spellings of suppression that are NOT the one predicate. The boundary has leaked four times in
 * this project, every time from a private filter; a second tag would be a fifth leak that no
 * `grep isDoNotPublish` could find.
 */
const LOOKALIKE_SUPPRESSION_TAGS: ReadonlySet<string> = new Set([
  'dnp', 'hidden', 'suppressed', 'internal', 'private', 'do-not-publish', 'donotpublish',
  'do_not_show', 'noindex', 'unlisted',
]);

/** Statuses that assert there is nothing to apply to right now, ever again. */
const TERMINAL_STATUSES: ReadonlySet<Program['trust']['status']> = new Set([
  'discontinued',
  'no_application',
]);

/** DeadlineKinds that assert there is no cycle at all — `open` over one is a contradiction. */
const KINDS_ASSERTING_NO_CYCLE: ReadonlySet<Program['deadline']['kind']> = new Set([
  'no_application_exists',
  'dormant',
]);

/** Kinds `expandCycles` can project. A RECUR directive is only meaningful for these. */
const PROJECTABLE_KINDS: ReadonlySet<Program['deadline']['kind']> = new Set([
  'n_fixed_dates',
  'n_fixed_windows',
  'annual_window',
]);

/* ------------------------------------------------------------------------------- helpers ----- */

/** Every free-text field of a record, joined. Used by the prose detectors. */
function recordText(program: Program): string {
  return [
    program.name,
    program.summary,
    program.rawOtherText,
    program.deadline.note,
    program.applyContact ?? '',
    ...program.fundingRestrictions,
    ...program.tags,
    ...program.constraints.flatMap((c) => [c.rawText, c.spec.axis === 'other' ? c.spec.note : '']),
    program.obligations.licenseObligation ?? '',
    program.obligations.sustainmentObligation ?? '',
    program.obligations.reportingObligation ?? '',
    program.aiPolicy.quote ?? '',
    program.trust.staleMirrorWarning ?? '',
    program.trust.disputed?.note ?? '',
    ...(program.trust.disputed?.claims ?? []).map((c) => c.claim),
  ].join('\n');
}

/** Every URL field of a record. */
function recordUrls(program: Program, sideCar: SeedSideCar | undefined): string[] {
  const urls = [program.trust.sourceUrl];
  if (program.applyUrl !== undefined) urls.push(program.applyUrl);
  if (program.aiPolicy.url !== undefined) urls.push(program.aiPolicy.url);
  for (const claim of program.trust.disputed?.claims ?? []) urls.push(claim.sourceUrl);
  for (const evidence of Object.values(sideCar?.evidence?.obligations ?? {})) {
    if (evidence !== undefined) urls.push(evidence.sourceUrl);
  }
  return urls;
}

function statedObligations(obligations: Obligations): ObligationField[] {
  return OBLIGATION_FIELDS.filter((field) => obligations[field] !== undefined);
}

/* ------------------------------------------------------------------------------ the rules ---- */

interface Collector {
  add(rule: SeedRuleId, message: string): void;
}

function checkUnknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, out: Collector): void {
  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) continue;
    out.add(
      'unknown-key',
      `unknown key "${key}". programSchema is a plain (non-strict) zod object, so it would strip ` +
        'this silently and the value would never reach the record — a typo\'d field name is ' +
        'indistinguishable from a field nobody wrote.',
    );
  }
}

function checkUrls(program: Program, sideCar: SeedSideCar | undefined, out: Collector): void {
  for (const url of recordUrls(program, sideCar)) {
    try {
      assertNotBlocked(url);
    } catch (error) {
      out.add('blocked-host', (error as Error).message);
    }
  }
}

function checkBlockedHostInProse(program: Program, out: Collector): void {
  const text = recordText(program).toLowerCase();
  const named = BLOCKED_HOSTS.filter((host) => text.includes(host));
  if (named.length === 0) return;
  if (program.tags.includes(SAFETY_WARNING_TAG)) return;
  out.add(
    'blocked-host-in-prose',
    `names the blocklisted host(s) ${named.join(', ')} in prose without carrying the ` +
      `"${SAFETY_WARNING_TAG}" tag. A blocklisted domain may appear in a seed record only when the ` +
      'record exists to warn about it; anywhere else it reads as a place to go.',
  );
}

function checkSafetyWarningShape(program: Program, out: Collector): void {
  if (!program.tags.includes(SAFETY_WARNING_TAG)) return;
  const problems: string[] = [];
  if (program.trust.status === 'open') problems.push('status is "open"');
  if (program.applyVia !== 'none') problems.push(`applyVia is "${program.applyVia}"`);
  if (program.applyUrl !== undefined) problems.push('it carries an applyUrl');
  if (program.amount.instrument !== 'unknown') problems.push(`amount.instrument is "${program.amount.instrument}"`);
  if (program.amount.amountMin !== undefined || program.amount.amountMax !== undefined) {
    problems.push('it carries a numeric award amount');
  }
  if (problems.length === 0) return;
  out.add(
    'safety-warning-shape',
    `is tagged "${SAFETY_WARNING_TAG}" but reads as an opportunity: ${problems.join('; ')}. ` +
      'A record whose purpose is to warn must offer nothing — no money, no status of open, and ' +
      'nowhere to apply.',
  );
}

function checkSuppressionTags(program: Program, out: Collector): void {
  for (const tag of program.tags) {
    if (tag === DO_NOT_PUBLISH_TAG) continue;
    if (!LOOKALIKE_SUPPRESSION_TAGS.has(tag.toLowerCase())) continue;
    out.add(
      'suppression-tag',
      `carries the tag "${tag}", which reads as suppression but is not "${DO_NOT_PUBLISH_TAG}". ` +
        'isDoNotPublish (normalize/index.ts) is the only implementation of the suppression ' +
        'boundary and reads exactly one tag; a second spelling is a hidden record no enforcement ' +
        'point can see.',
    );
  }
}

function checkObligationEvidence(
  program: Program,
  sideCar: SeedSideCar | undefined,
  out: Collector,
): void {
  const evidence = sideCar?.evidence?.obligations ?? {};
  const stated = statedObligations(program.obligations);

  for (const field of stated) {
    const value = program.obligations[field];
    const found = evidence[field];
    if (found === undefined) {
      const tail =
        value === false
          ? ' `false` is the funder saying it is NOT required — a real answer worth publishing, ' +
            'and a claim like any other. If no page addressed it, DELETE THE KEY: absent means ' +
            'UNSTATED, and absent means UNSTATED is the whole reason this field is optional.'
          : ' Quote the sentence and name the page it is on.';
        out.add(
          'obligation-evidence',
          `states obligations.${field} = ${JSON.stringify(value)} with no ` +
            `evidence.obligations.${field}.${tail}`,
        );
      continue;
    }
    if (found.quote.trim() === '') {
      out.add(
        'obligation-evidence',
        `evidence.obligations.${field} has an empty quote. The quote is the funder's own words; ` +
          'a blank one is an assertion with a citation stapled to it.',
      );
    }
  }

  for (const field of OBLIGATION_FIELDS) {
    if (evidence[field] === undefined) continue;
    if (stated.includes(field)) continue;
    out.add(
      'obligation-evidence',
      `carries evidence.obligations.${field} but does not state obligations.${field}. Either the ` +
        'obligation was dropped and the evidence was left behind, or the field name is a typo.',
    );
  }
}

function checkDates(program: Program, sideCar: SeedSideCar | undefined, out: Collector): void {
  if (sideCar === undefined) return; // the side-car schema already reported it
  const { basis } = sideCar.dates;
  const note = program.deadline.note;
  const hasDirective = note.startsWith(RECURRENCE_PREFIX);
  const hasObservedMarker = note.includes(OBSERVED_WINDOW_MARKER);

  if (basis === 'projected') {
    if (!hasDirective) {
      out.add(
        'dates-basis-consistency',
        'declares dates.basis = "projected" but deadline.note carries no RECUR directive. ' +
          'expandCycles projects nothing without one, so the calendar would be silently empty ' +
          'for this programme and no other test would notice.',
      );
      return;
    }
    if (!PROJECTABLE_KINDS.has(program.deadline.kind)) {
      out.add(
        'dates-basis-consistency',
        `declares dates.basis = "projected" on deadline.kind "${program.deadline.kind}", which ` +
          'expandCycles never projects.',
      );
      return;
    }
    let recurrence;
    try {
      recurrence = parseRecurrence(note);
    } catch (error) {
      out.add(
        'dates-basis-consistency',
        `has an unparseable RECUR directive: ${(error as Error).message}. A projected deadline is ` +
          'a 23:59 LOCAL wall time repeated forwards; without a valid tz=<IANA zone> the stored ' +
          'UTC instant is wrong by hours and can be wrong by a day.',
      );
      return;
    }
    const area = ('timezone' in recurrence ? recurrence.timezone : '').split('/')[0];
    if (!IANA_AREAS.has(area)) {
      out.add(
        'dates-basis-consistency',
        `projects its deadline in the zone "${'timezone' in recurrence ? recurrence.timezone : ''}", ` +
          'which is not an IANA Area/Location zone. Intl accepts the legacy fixed-offset aliases ' +
          '(EST, MST, US/Eastern, Etc/GMT+5) and they ignore daylight saving, so a 23:59 local ' +
          'deadline projected under one is an hour out for most of the year and can land on the ' +
          'wrong day. Name the place: America/New_York, America/Los_Angeles.',
      );
      return;
    }
    if (recurrence.kind !== program.deadline.kind) {
      out.add(
        'dates-basis-consistency',
        `has a RECUR ${recurrence.kind} directive on a deadline of kind ` +
          `"${program.deadline.kind}". normalize/deadline.ts's noteFor drops a mismatched ` +
          'directive and expandCycles projects nothing, so the mismatch empties the calendar in ' +
          'silence rather than failing.',
      );
      return;
    }
    if (hasObservedMarker) {
      out.add(
        'dates-basis-consistency',
        `declares dates.basis = "projected" while deadline.note also carries the observed-window ` +
          `marker "${OBSERVED_WINDOW_MARKER}". Declare "funder_published" if the funder printed ` +
          'the dates; a record may not claim both at once.',
      );
    }
    return;
  }

  if (basis === 'funder_published') {
    if (hasDirective) {
      out.add(
        'dates-basis-consistency',
        'declares dates.basis = "funder_published" but deadline.note leads with a RECUR ' +
          `directive, which is a rule we project forward — not a date the funder printed. ` +
          `${FUNDER_PUBLISHED_IS_RARE}; badging a projection as one is the confident-wrong-date ` +
          'failure this product exists to avoid.',
      );
      return;
    }
    if (!hasObservedMarker || parseObservedWindow(note) === undefined) {
      out.add(
        'dates-basis-consistency',
        `declares dates.basis = "funder_published" but deadline.note carries no window ` +
          `parseObservedWindow can read — that is, no window this funder published. The marker is ` +
          `"${OBSERVED_WINDOW_MARKER}", followed by "opens YYYY-MM-DD" and/or "closes YYYY-MM-DD".`,
      );
    }
    return;
  }

  // basis === 'unpublished'
  if (hasDirective || hasObservedMarker) {
    out.add(
      'dates-basis-consistency',
      'declares dates.basis = "unpublished" but deadline.note carries a RECUR directive or an ' +
        'observed-window marker. Declare which of the two it is.',
    );
    return;
  }
  for (const pattern of CONCRETE_DATE_PATTERNS) {
    const match = pattern.exec(note);
    if (match === null) continue;
    out.add(
      'undeclared-date',
      `declares dates.basis = "unpublished" yet deadline.note prints the concrete date ` +
        `"${match[0]}". A date with no declared origin is a date the reader will trust and we ` +
        'cannot defend. Declare "funder_published" with the observed-window marker, or "projected" ' +
        'with a RECUR rule, or drop the date.',
    );
    return;
  }
}

function checkUtcInstantInProse(program: Program, out: Collector): void {
  const match = UTC_INSTANT.exec(recordText(program));
  if (match === null) return;
  out.add(
    'utc-instant-in-prose',
    `prints the UTC instant "${match[0]}". A deadline in this corpus is a 23:59 LOCAL wall time in ` +
      'the funder\'s own zone, and the instant is derived from it — 2027-03-01T04:59Z IS the ' +
      "funder's 28 February in America/New_York. Write the local date and let the RECUR directive's " +
      'tz carry the conversion; a record that prints the instant has already lost the day.',
  );
}

function checkStatus(program: Program, out: Collector): void {
  if (program.trust.status !== 'open') return;

  if (KINDS_ASSERTING_NO_CYCLE.has(program.deadline.kind)) {
    out.add(
      'status-contradiction',
      `is badged status "open" on deadline.kind "${program.deadline.kind}", which asserts there is ` +
        'no application cycle at all.',
    );
    return;
  }

  const text = recordText(program);
  for (const pattern of CLOSED_PHRASES) {
    const match = pattern.exec(text);
    if (match === null) continue;
    out.add(
      'status-contradiction',
      `is badged status "open" while its own text says "${match[0].trim()}". 116 programmes once ` +
        'shipped exactly this way, against a page that said twice that the cycle was closed. ' +
        '`closed`, `dormant`, `contact_only`, `no_application`, `discontinued` and `unknown` are ' +
        'all real values; `open` is a claim.',
    );
    return;
  }
}

function checkTerminalHasApplication(program: Program, out: Collector): void {
  if (!TERMINAL_STATUSES.has(program.trust.status)) return;
  const problems: string[] = [];
  if (program.applyUrl !== undefined) problems.push(`applyUrl ${program.applyUrl}`);
  if (program.applyVia !== 'none') problems.push(`applyVia "${program.applyVia}"`);
  if (problems.length === 0) return;
  out.add(
    'terminal-has-application',
    `is badged status "${program.trust.status}" and still offers ${problems.join(' and ')}. A ` +
      'record that says the programme is over must not also say where to apply — that pairing is ' +
      'how 345 awards came to advertise the wrong destination.',
  );
}

function checkPrivateHostDetail(program: Program, sideCar: SeedSideCar | undefined, out: Collector): void {
  const haystack = [recordText(program), ...recordUrls(program, sideCar)].join('\n');
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    const match = pattern.exec(haystack);
    if (match === null) continue;
    out.add(
      'private-host-detail',
      `contains "${match[0]}", which is a private address or a host filesystem path. Seed data ` +
        'ships in a public repository: use example.com, *.invalid or an RFC 5737 range.',
    );
    return;
  }
}

function checkTrustAndShape(program: Program, seedLastVerified: string, out: Collector): void {
  if (program.trust.contentHash !== '') {
    out.add(
      'content-hash-placeholder',
      'ships a non-empty trust.contentHash. hashProgram excludes TrustFields by contract, so a ' +
        'hash written into the file is stale the moment anything else in the record changes. The ' +
        'empty string is the honest "computed at load" placeholder; loadSeedCorpus fills it.',
    );
  }
  if (program.trust.lastVerifiedAt !== seedLastVerified) {
    out.add(
      'verification-stamp',
      `has trust.lastVerifiedAt "${program.trust.lastVerifiedAt}"; every record in this corpus was ` +
        `verified in the ${seedLastVerified} research pass and must say so.`,
    );
  }
  if (program.trust.verificationMethod !== 'seed_import' && program.trust.verificationMethod !== 'manual_curation') {
    out.add(
      'verification-stamp',
      `has trust.verificationMethod "${program.trust.verificationMethod}"; a seeded record was not ` +
        'fetched live by this installation, so it is seed_import or manual_curation.',
    );
  }
  const summary = program.summary.trim();
  if (summary.length === 0 || summary.length > 600) {
    out.add(
      'summary-excerpt',
      `has a ${summary.length}-character summary. Seed data is structured facts plus SHORT ` +
        'excerpts (spec §13): 1 to 600 characters, never a page dump.',
    );
  }
  for (const constraint of program.constraints) {
    if (constraint.rawText.trim() === '') {
      out.add(
        'constraint-shape',
        `constraint "${constraint.id}" has empty rawText. The matcher can be wrong; the funder's ` +
          'own sentence is what lets a user check it, so a constraint without one is unreviewable.',
      );
    }
    if (!Number.isInteger(constraint.fallbackRank)) {
      out.add('constraint-shape', `constraint "${constraint.id}" has a non-integer fallbackRank.`);
    }
  }
}

/* ------------------------------------------------------------------------------ the entry ---- */

export interface SeedFileResult {
  violations: SeedViolation[];
  funders: Funder[];
  programs: Program[];
  /** programId → its declared provenance. Empty for any record that failed validation. */
  sideCars: Map<string, SeedSideCar>;
}

const rawFileSchema = z
  .object({
    funders: z.array(z.record(z.unknown())).optional(),
    programs: z.array(z.record(z.unknown())).optional(),
  })
  .strict();

/**
 * Validate one parsed seed file. Pure: no I/O, no network, no clock. Returns EVERY violation
 * rather than throwing on the first, because a batch of twelve records with three problems should
 * be fixed in one pass.
 */
export function validateSeedFile(
  file: string,
  parsed: unknown,
  seedLastVerified = '2026-08-02',
): SeedFileResult {
  const violations: SeedViolation[] = [];
  const funders: Funder[] = [];
  const programs: Program[] = [];
  const sideCars = new Map<string, SeedSideCar>();

  const shape = rawFileSchema.safeParse(parsed);
  if (!shape.success) {
    const first = shape.error.issues[0];
    violations.push({
      file,
      recordId: '',
      rule: 'schema',
      message:
        `is not a seed file: ${first.message} at ${first.path.join('.') || '<root>'}. A seed file ` +
        'is an object with a "funders" array, a "programs" array, or both — nothing else.',
    });
    return { violations, funders, programs, sideCars };
  }

  for (const raw of shape.data.funders ?? []) {
    const id = typeof raw.id === 'string' ? raw.id : '';
    const out: Collector = {
      add: (rule, message) => violations.push({ file, recordId: id, rule, message }),
    };
    const parsedFunder = funderSchema.safeParse(raw);
    if (!parsedFunder.success) {
      const first = parsedFunder.error.issues[0];
      out.add('schema', `${first.message} at ${first.path.join('.')}`);
      continue;
    }
    checkUnknownKeys(raw, ALLOWED_FUNDER_KEYS, out);
    // funderSchema.homepage is a bare z.string() (CONTRACT §3 mirror), so the URL allowlist that
    // guards applyUrl / sourceUrl / aiPolicy.url does not reach it. It is rendered as an anchor.
    if (!httpUrlSchema.safeParse(parsedFunder.data.homepage).success) {
      out.add(
        'funder-homepage',
        `homepage "${parsedFunder.data.homepage}" is not an absolute http or https URL. It is ` +
          'rendered as a link, and funderSchema does not screen it.',
      );
    } else {
      try {
        assertNotBlocked(parsedFunder.data.homepage);
      } catch (error) {
        out.add('blocked-host', (error as Error).message);
      }
    }
    for (const pattern of PRIVATE_HOST_PATTERNS) {
      if (!pattern.test(`${parsedFunder.data.homepage}\n${parsedFunder.data.note ?? ''}`)) continue;
      out.add('private-host-detail', 'contains a private address or a host filesystem path.');
      break;
    }
    funders.push(parsedFunder.data);
  }

  for (const raw of shape.data.programs ?? []) {
    const id = typeof raw.id === 'string' ? raw.id : '';
    const out: Collector = {
      add: (rule, message) => violations.push({ file, recordId: id, rule, message }),
    };

    const parsedProgram = programSchema.safeParse(raw);
    if (!parsedProgram.success) {
      const first = parsedProgram.error.issues[0];
      out.add('schema', `${first.message} at ${first.path.join('.')}`);
      continue;
    }
    const program = parsedProgram.data;

    checkUnknownKeys(raw, ALLOWED_PROGRAM_KEYS, out);

    const parsedSideCar = sideCarSchema.safeParse(raw);
    let sideCar: SeedSideCar | undefined;
    if (parsedSideCar.success) {
      sideCar = parsedSideCar.data;
      sideCars.set(program.id, sideCar);
    } else {
      const first = parsedSideCar.error.issues[0];
      const path = first.path.join('.');
      out.add(
        path.startsWith('dates') || path === '' ? 'dates-basis' : 'schema',
        `${first.message} at ${path || 'dates'}. Every seed record must declare where its dates ` +
          `came from: "dates": { "basis": "${DATE_BASES.join('" | "')}" }. ` +
          `${FUNDER_PUBLISHED_IS_RARE}; a projection and a published date are different claims ` +
          'and the record has to say which it is making.',
      );
    }

    checkTrustAndShape(program, seedLastVerified, out);
    checkObligationEvidence(program, sideCar, out);
    checkDates(program, sideCar, out);
    checkUtcInstantInProse(program, out);
    checkStatus(program, out);
    checkTerminalHasApplication(program, out);
    checkUrls(program, sideCar, out);
    checkBlockedHostInProse(program, out);
    checkSafetyWarningShape(program, out);
    checkSuppressionTags(program, out);
    checkPrivateHostDetail(program, sideCar, out);

    programs.push(program);
  }

  return { violations, funders, programs, sideCars };
}

/**
 * The publishable subset of a seed corpus.
 *
 * THE ONLY FILTER. `isDoNotPublish` (normalize/index.ts) is the single implementation of the
 * suppression boundary; this function is a call to it, not a copy of it. The boundary has leaked
 * four times in this project and every leak was a private filter written at a read site, so any
 * consumer of the seed corpus that needs "what a user may see" calls this and never re-tests the
 * tag itself.
 */
export function publishableSeedPrograms(programs: readonly Program[]): Program[] {
  return programs.filter((program) => !isDoNotPublish(program));
}
