import type { RawOpportunity, SourceModule } from '@grantspotter/core';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

/**
 * "Kansas State University Amateur Radio Club, KS — $18,000" on the Club Grant page.
 * Em dash, en dash and hyphen all appear in the wild; the amount is optional because some
 * years list recipients without figures.
 */
const RECIPIENT_LINE = /^(.+?),\s*([A-Z]{2})\s*[—–-]\s*(\$[\d,]+)?\s*$/;

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
    url: 'http://www.arrl.org/amateur-radio-grants',
    name: 'ARRL Amateur Radio Grants',
    externalKey: 'amateur-radio-grants',
    fieldPatterns: {
      // The live page spells the third window out as "October 1 - October 31" rather than the
      // shorthand "October 1 - 31" used elsewhere on the site; the trailing month name is
      // optional so both forms match.
      windows: /(February\s*1[^.]*?October\s*1\s*[-–]\s*(?:October\s*)?31)/i,
      amount: /(generally do not exceed[^.]*\.(?:[^.]*\$[\d,]+[^.]*\.)?)/i,
      restrictions: /(does not fund[^.]*\.)/i,
      applicant: /(made to organizations[^.]*\.)/i,
    },
    requiredFields: ['windows'],
    expectedMinRecords: 1,
    notes:
      'Three fixed windows per year: Feb 1-28, Jun 1-30, Oct 1-31, stated inline. US ' +
      'organizations only, never individuals. Excludes emergency-communications equipment and ' +
      'ongoing operating expenses; prefers co-funded projects. Generally <= $3,000, up to ' +
      '$5,000 in 2026 ("Year of the Club").',
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
    url: 'http://www.arrl.org/etp-grants',
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
    url: 'http://www.arrl.org/arrl-foundation-special-funds',
    name: 'ARRL Foundation Special Funds',
    externalKey: 'foundation-special-funds',
    fieldPatterns: { summary: /(special funds?[^.]*\.)/i },
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
    url: 'http://www.arrl.org/scholarship-program',
    name: 'ARRL Foundation Scholarship Program',
    externalKey: 'scholarship-program',
    fieldPatterns: {
      window: /(opens?[^.]*?clos[^.]*\.)/i,
      closeTime: /(\d{1,2}:\d{2}\s*(?:AM|PM)\s*E[SD]T)/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 1,
    notes:
      'THIS PAGE OWNS THE DEADLINE that all 111 catalog entries inherit (see normalize/, ' +
      'DeadlineSource.inherited). Opens ~Oct 30, closes ~Dec 30 12:00 PM EST. It MOVED from ' +
      'Jan 31, so the date is read from the page every night and never hardcoded.',
  },
  {
    id: 'arrl-summary-of-scholarship-requirements',
    funderId: 'arrl-foundation',
    label: 'ARRL summary-of-requirements table (cross-check only)',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'http://www.arrl.org/summary-of-scholarship-requirements',
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
