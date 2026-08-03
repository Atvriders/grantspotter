import type { RawOpportunity, SourceModule } from '@grantspotter/core';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

/**
 * Two recipient-line grammars have been observed on the live Club Grant page across years:
 *   - "Kansas State University Amateur Radio Club, KS — $18,000" (comma before the state,
 *     dash-amount suffix) — the 2023-era format this pattern originally targeted.
 *   - "Kansas State University Amateur Radio Club - KS" (dash before the state, no comma, no
 *     amount at all) — what the live 2024 recipient list (captured 2026-08-02, ~37 rows)
 *     actually uses. The old comma-anchored pattern matched zero of these.
 * Em dash, en dash and hyphen all appear in the wild for both the name/state separator and the
 * state/amount separator, so both are accepted via `[—–-]`. The lazy `.+?` name group is what
 * lets recipient names that themselves contain a comma ("WB4SA, Radio Scouting - FL",
 * "Nixa Amateur Radio Club, Inc. - MO") still resolve correctly: it backtracks past the
 * embedded comma until it reaches a separator that is actually followed by a bare two-letter
 * state code and nothing else.
 */
const RECIPIENT_LINE = /^(.+?)(?:,\s*| +[—–-] +)([A-Z]{2})(?:\s*[—–-]\s*(\$[\d,]+))?\s*$/;

export function parseClubGrantRecipients(flatText: string, sourceUrl: string): RawOpportunity[] {
  const out: RawOpportunity[] = [];
  for (const line of flatText.split('\n')) {
    const m = RECIPIENT_LINE.exec(line.trim());
    if (!m) continue;
    const recipient = m[1].trim();
    const state = m[2];
    const amountRaw = m[3] ?? '';
    if (recipient.length < 4) continue;
    out.push({
      sourceId: 'arrl-club-grant',
      externalKey: `past-award:${recipient}:${state}`,
      name: `${recipient} (ARRL Club Grant recipient)`,
      rawFields: { recordType: 'past_award', recipient, state, amountRaw },
      sourceUrl,
      rawText: line.trim(),
    });
  }
  return out;
}

const CONFIGS: SinglePageConfig[] = [
  {
    id: 'arrl-amateur-radio-grants',
    funderId: 'arrl-foundation',
    label: 'ARRL Amateur Radio Grants',
    tier: 'C',
    klass: 'ham_grant',
    url: 'https://www.arrl.org/amateur-radio-grants',
    name: 'ARRL Amateur Radio Grants',
    externalKey: 'amateur-radio-grants',
    fieldPatterns: {
      // The live page spells the third window out as "October 1 - October 31" rather than the
      // shorthand "October 1 - 31" used elsewhere on the site; the trailing month name is
      // optional so both forms match.
      windows: /(February\s*1[^.]*?October\s*1\s*[-–]\s*(?:October\s*)?31)/i,
      // The live page states the $3,000 cap and the "$5,000 in 2026" footnote as two SEPARATE
      // sentences three paragraphs apart (the footnote is a starred aside, not a trailing
      // clause) — unlike the single semicolon-joined sentence used elsewhere on the site. A
      // single `[^.]*` span reaching from one to the other would swallow the unrelated
      // paragraphs in between, so they are captured as two fields instead.
      amount: /(generally do not exceed[^.]*\.)/i,
      amountNote: /(In support of[^.]*\$5,000[^.]*\.)/i,
      restrictions: /(does not fund[^.]*\.)/i,
      applicant: /(made to organizations[^.]*\.)/i,
    },
    requiredFields: ['windows'],
    expectedMinRecords: 1,
    notes:
      'Three fixed windows per year: Feb 1-28, Jun 1-30, Oct 1-31, stated inline. US ' +
      'organizations only, never individuals. Excludes emergency-communications equipment and ' +
      'ongoing operating expenses; prefers co-funded projects. Generally <= $3,000; the ' +
      '"$5,000 in 2026" (Year of the Club) footnote lives in `amountNote`, not `amount`, ' +
      'because the live page states it as a separate starred sentence.',
  },
  {
    id: 'arrl-club-grant',
    funderId: 'arrl-foundation',
    label: 'ARRL Club Grant Program',
    tier: 'C',
    klass: 'ham_grant',
    url: 'https://www.arrl.org/club-grant-program',
    name: 'ARRL Club Grant Program',
    externalKey: 'club-grant-program',
    fieldPatterns: {
      // Lazy rather than a literal "to": the live page reads "as small as $1,000 to as large as
      // the maximum $25,000", not the terser "$1,000 to $25,000".
      amount: /(\$1,000[^.]*?\$25,000)/i,
      eligibility: /(ARRL[-\s]affiliated[^.]*\.)/i,
    },
    requiredFields: ['amount'],
    expectedMinRecords: 1,
    extraParse: (flat, _html, sourceUrl) => parseClubGrantRecipients(flat, sourceUrl),
    notes:
      'ARDC-funded; $1,000-$25,000; 2024 awarded $500,502 to 37 of 110 applicants. There is ' +
      'deliberately NO deadline pattern here: the page has never published a deadline field, ' +
      'and three researchers reached three different conclusions on 2026-08-02 (dormant / ' +
      'autumn window / Feb-Jun-Oct, the last probably conflating it with the separate Amateur ' +
      'Radio Grants cycle). The record ships `disputed` rather than a guessed date. The ' +
      'application portal is a JS SPA and returns no server-side text, so open/closed status ' +
      'cannot be determined programmatically.',
  },
  {
    id: 'arrl-etp-grants',
    funderId: 'arrl',
    label: 'ARRL Teachers Institute / ETP Grants',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://www.arrl.org/etp-grants',
    name: 'ARRL ETP Grants (School Station and Progress)',
    externalKey: 'etp-grants',
    fieldPatterns: {
      // Ordinal suffixes and "AND" as a separator both appear on the live page ("OCTOBER 1ST
      // AND OCTOBER 31ST"), alongside the plainer dash form used elsewhere on the site.
      window:
        /(Oct(?:ober)?\.?\s*1(?:st)?\s*(?:[-–]|and)\s*(?:Oct(?:ober)?\.?\s*)?31(?:st)?[^.]*\.)/i,
      jotformId: /jotform\.com\/(?:form\/)?(\d{8,})/i,
      applicant: /(available to teachers[^.]*\.)/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 1,
    notes:
      'US K-12 schools and teachers, not colleges. Applicant must be an ARRL member and must ' +
      'file a signed antenna-approval form. Cash amount is genuinely unpublished — keep ' +
      'amountRaw verbatim and leave amountMin/amountMax undefined. The URL is year-agnostic ' +
      'but the Jotform id and the attached xlsx/pdf change underneath, so the Jotform id is ' +
      'captured as a change signal. Page text still said "of 2025" on 2026-08-02 — stale.',
  },
  {
    id: 'arrl-foundation-special-funds',
    funderId: 'arrl-foundation',
    label: 'ARRL Foundation Special Funds',
    tier: 'C',
    klass: 'ham_grant',
    url: 'https://www.arrl.org/arrl-foundation-special-funds',
    name: 'ARRL Foundation Special Funds',
    externalKey: 'foundation-special-funds',
    fieldPatterns: {
      // A bare `special funds?[^.]*\.` matches the page TITLE first ("ARRL Foundation Special
      // Funds", no trailing period) and then runs `[^.]*` — which crosses newlines — straight
      // through the entire nav menu chrome until it finally hits the first period in the
      // document, 600+ characters later. Anchoring on "The [ARRL ]Foundation <verb> special
      // fund(s)" skips the bare heading (no verb follows "Special Funds" there) and lands on
      // the actual summary sentence instead.
      summary: /(The\s+(?:ARRL\s+)?Foundation\s+\w+\s+special\s*funds?[^.]*\.)/i,
    },
    requiredFields: ['summary'],
    expectedMinRecords: 1,
    notes: 'Named donor endowments. Prose page; low volume, used for funder provenance.',
  },
  {
    id: 'arrl-scholarship-program',
    funderId: 'arrl-foundation',
    label: 'ARRL Foundation Scholarship Program (cycle owner)',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://www.arrl.org/scholarship-program',
    name: 'ARRL Foundation Scholarship Program',
    externalKey: 'scholarship-program',
    fieldPatterns: {
      // A closed cycle is a real, representable state, not "no record": the live page (captured
      // 2026-08-02) reads only "The 2026 Scholarship Cycle is now closed." — no "opens" token
      // anywhere — so the open/close-sentence alternative alone matched nothing and this source,
      // which owns the deadline 112 of 181 candidates inherit, silently produced zero records.
      // The second alternative captures the closed-cycle sentence verbatim instead of dropping
      // it; it deliberately does NOT invent an open/close date the page doesn't state.
      window: /(opens?[^.]*?clos[^.]*\.|scholarship cycle is (?:now )?closed\.)/i,
      closeTime: /(\d{1,2}:\d{2}\s*(?:AM|PM)\s*E[SD]T)/i,
      // Only matches during a closed cycle; `rawFields.status` is read by
      // normalize/deadline.ts's `inferStatus` as an override, so this is what turns "no dates
      // published" into `status: 'closed'` instead of the generic default of 'open'.
      status: /scholarship cycle is (?:now )?(closed)\b/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 1,
    notes:
      'THIS PAGE OWNS THE DEADLINE that all 111 catalog entries inherit (see normalize/, ' +
      'DeadlineSource.inherited). Opens ~Oct 30, closes ~Dec 30 12:00 PM EST. It MOVED from ' +
      'Jan 31, so the date is read from the page every night and never hardcoded. Between ' +
      'cycles the page states only that the current cycle is closed, with no open/close dates ' +
      'at all — that is captured as `rawFields.status = \'closed\'` (never fabricated dates), ' +
      'and the record still ships so downstream inheritance has something to point at.',
  },
  {
    id: 'arrl-summary-of-scholarship-requirements',
    funderId: 'arrl-foundation',
    label: 'ARRL summary-of-requirements table (cross-check only)',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://www.arrl.org/summary-of-scholarship-requirements',
    name: 'ARRL summary of scholarship requirements',
    externalKey: 'summary-of-scholarship-requirements',
    fieldPatterns: { table: /(Scholarship[\s\S]{0,4000})/i },
    requiredFields: [],
    expectedMinRecords: 0,
    notes:
      'STALE. 80-row table, easiest page on the site to parse and the most misleading: 79 ' +
      'entries against the catalog’s 111, abbreviated non-joinable keys, and it still lists ' +
      'dropped scholarships. expectedMinRecords is 0 and every record is tagged crosscheck so ' +
      'normalize/ refuses to publish it. Secondary geography cross-check only.',
  },
];

function withCrosscheckTag(module: SourceModule): SourceModule {
  const inner = module.parse.bind(module);
  return {
    ...module,
    parse: (payloads) =>
      inner(payloads).map((raw) => ({
        ...raw,
        rawFields: { ...raw.rawFields, recordType: 'crosscheck' },
      })),
  };
}

const [amateur, club, etp, special, program, summary] = CONFIGS.map(makeSinglePageSource);

export const arrlAmateurRadioGrants = amateur;
export const arrlClubGrant = club;
export const arrlEtpGrants = etp;
export const arrlFoundationSpecialFunds = special;
export const arrlScholarshipProgram = program;
export const arrlSummaryOfScholarshipRequirements = withCrosscheckTag(summary);

export const ARRL_PAGE_SOURCES: SourceModule[] = [
  arrlAmateurRadioGrants,
  arrlClubGrant,
  arrlEtpGrants,
  arrlFoundationSpecialFunds,
  arrlScholarshipProgram,
  arrlSummaryOfScholarshipRequirements,
];
