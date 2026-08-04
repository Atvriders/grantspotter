import type { RawOpportunity, SourceModule } from '@grantspotter/core';
import { withProseWindowDates } from './tier-c-b.js';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

/**
 * The ETP window sentence, named so the config's `fieldPatterns.window` and the
 * `withProseWindowDates` wrapper below read ONE pattern — the reviewable field and the published
 * dates must come from the same sentence or they can drift apart silently.
 *
 * Ordinal suffixes and "AND" as a separator both appear on the live page ("OCTOBER 1ST AND OCTOBER
 * 31ST"), alongside the plainer dash form used elsewhere on the site.
 */
const ETP_WINDOW = /(Oct(?:ober)?\.?\s*1(?:st)?\s*(?:[-–]|and)\s*(?:Oct(?:ober)?\.?\s*)?31(?:st)?[^.]*\.)/i;

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
      // The live page states the exclusion as two adjacent, back-to-back <li> sentences (no
      // filler between them, unlike the amount/amountNote split above), so concatenating them
      // verbatim is faithful rather than fabricated. The synthetic pathological fixture instead
      // uses a single "does not fund X or Y" sentence from an older capture; both are kept.
      restrictions:
        /(does not fund[^.]*\.|Grant requests for emergency communications[^.]*\.\s*Grant requests for ongoing operations[^.]*\.)/i,
      // "made to organizations" was the older capture's wording; the live page (2026-08-02) says
      // "Grants are awarded only to organizations, not individuals." instead.
      applicant: /(made to organizations[^.]*\.|Grants are awarded only to organizations[^.]*\.)/i,
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
      // UNFIXABLE FROM THE CAPTURED HTML (round 2 sweep, 2026-08-03): the live page (captured
      // 2026-08-02) contains no occurrence of "affiliat" or "eligib" anywhere in its raw HTML,
      // in any form — this pattern only ever matches the synthetic pathological fixture, which
      // states an ARRL-affiliation requirement an OLDER capture of the real page apparently
      // carried. The page genuinely does not state an affiliation/eligibility requirement in
      // this snapshot, so `eligibility` stays undefined on the real record rather than being
      // rewritten to match nothing, or worse, to invent wording the page doesn't have. Omission
      // here is deliberate: a missing constraint under-restricts (an applicant sees the award
      // and can self-correct by reading the funder's page); inventing one would over-restrict
      // and hide the award from someone it may be for, silently.
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
      'cannot be determined programmatically. `eligibility` is also currently unresolvable: the ' +
      'live 2026-08-02 capture states no ARRL-affiliation requirement anywhere in its HTML.',
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
      window: ETP_WINDOW,
      jotformId: /jotform\.com\/(?:form\/)?(\d{8,})/i,
      // The live page never says "available to teachers" as one contiguous phrase (that wording
      // is only in the synthetic fixture); its actual applicant-eligibility sentence is "Grant
      // applicants must be a current ARRL member to be eligible to apply."
      applicant: /(available to teachers[^.]*\.|Grant applicants? must be[^.]*\.)/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 1,
    notes:
      'US K-12 schools and teachers, not colleges. Applicant must be an ARRL member and must ' +
      'file a signed antenna-approval form. Cash amount is genuinely unpublished — keep ' +
      'amountRaw verbatim and leave amountMin/amountMax undefined. The URL is year-agnostic ' +
      'but the Jotform id and the attached xlsx/pdf change underneath, so the Jotform id is ' +
      'captured as a change signal. Page text still said "of 2025" on 2026-08-02 — stale. THAT ' +
      'STALENESS IS NOW PUBLISHED RATHER THAN HIDDEN: the sentence states its own year, so the ' +
      'window resolves to 2025-10-01..2025-10-31 and the record reads `closed`. It is the only ' +
      'one of the four prose windows in the corpus that names a year, and the honest reading of a ' +
      'page frozen on last year\'s cycle is that last year\'s cycle is over — not that a new one ' +
      'is open. The record still ships so the programme stays findable and its terms readable.',
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

/**
 * AN AWARD-HISTORY ROLL IS NOT ELIGIBILITY TEXT.
 *
 * The Special Funds page publishes, in the middle of its prose, the Bill Orr W6SAI Technical
 * Writing Award's list of past winners — 23 lines under a bare "Winners:" label:
 *
 *     Winners:
 *     2002 Ian Poole, G3YWX, for "Understanding Solar Indices"
 *     …
 *     2024 Carl Luetzelschwab, K9LA, for "Worldwide Fun with 100 W and a Dipole"
 *
 * That block reached every axis, because `makeSinglePageSource` files the whole flattened page as
 * `rawText` and this source labels only a `summary`. Two things follow from its SHAPE that no
 * downstream text rule can undo:
 *
 *  - It carries no sentence terminator for 23 lines, so `splitClauses` cannot break it. The
 *    citizenship, ham-activity and recommendation constraints on this programme all quoted a
 *    ~1,200-character slab beginning "Winners:\n2002 Ian Poole, G3YWX, …" as the funder's stated
 *    eligibility wording.
 *  - `withoutSiteChrome` cannot reach it either, and a previous round measured exactly why: the
 *    quoted ARTICLE TITLES contain colons ("Lightning: Understand It or Suffer the Consequences")
 *    and the contributors' initials contain periods, so the roll never stands four label-shaped
 *    lines deep. That round tightened `isChromeLine`, measured that it removed NEITHER constraint,
 *    and reverted rather than ship a complication that did nothing.
 *
 * The separator is PROVENANCE, not wording. A roll of past recipients is a different KIND of block
 * from a statement of terms: it records who has already won, not who may apply. This file already
 * makes exactly that judgement one config up — `parseClubGrantRecipients` lifts the Club Grant
 * page's recipient list out of the programme record because a funder's award history is its own
 * kind of evidence, not part of the programme's rules.
 *
 * WHAT IT REMOVED. `citizenship` HARD `{allowed: ["ANY"]}`, minted because `OPEN_WORLDWIDE` found
 * the word "Worldwide" — inside the 2024 winner's ARTICLE TITLE, "Worldwide Fun with 100 W and a
 * Dipole". The ARRL Foundation says nothing whatever about nationality on that page. The
 * `ham_activity` and `recommendation` constraints keep matching, but now quote the funder's actual
 * sentence about the Victor C. Clark Youth Incentive Fund instead of two decades of QST bylines.
 *
 * WHY THE RECOGNISER IS THE SHAPE AND NOT THE WORD "Winners". A label line on its own is just a
 * label; what makes this a roll is the RUN of year-led entries beneath it. Requiring four
 * consecutive lines that each begin with a 4-digit year is what keeps it off ordinary prose: a
 * sentence beginning "2026 applications open…" stands alone and is never inside a run, and no
 * eligibility statement in this corpus is a column of years. The same discipline as
 * `withoutSiteChrome`'s `CHROME_RUN_MIN`, for the same reason — a run is what a human eye reads as
 * a table, and a table of past winners is not a rule.
 */
const AWARD_ROLL_LABEL = /^(?:winners|recipients|awardees|past (?:winners|recipients|awardees))\s*:$/i;
const AWARD_ROLL_ENTRY = /^(?:19|20)\d{2}\b/;
const AWARD_ROLL_MIN = 4;

export function withoutAwardHistory(text: string): string {
  const lines = text.split('\n');
  const keep = lines.map(() => true);
  for (let i = 0; i < lines.length; i += 1) {
    if (!AWARD_ROLL_LABEL.test(lines[i].trim())) continue;
    let end = i + 1;
    while (end < lines.length && AWARD_ROLL_ENTRY.test(lines[end].trim())) end += 1;
    if (end - (i + 1) >= AWARD_ROLL_MIN) for (let j = i; j < end; j += 1) keep[j] = false;
  }
  return lines.filter((_, i) => keep[i]).join('\n');
}

/**
 * Applied to the whole ARRL page family rather than to Special Funds alone: the roll shape is what
 * identifies it, so a config that grows one later is covered without a second edit, and a config
 * that has none — all five others today — is provably untouched because `withoutAwardHistory`
 * returns its input unchanged when no run of four year-led lines follows a roll label.
 */
function withoutAwardHistoryInRawText(module: SourceModule): SourceModule {
  const inner = module.parse.bind(module);
  return {
    ...module,
    parse: (payloads) =>
      inner(payloads).map((raw) =>
        raw.rawText === undefined ? raw : { ...raw, rawText: withoutAwardHistory(raw.rawText) },
      ),
  };
}

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

const [amateur, club, etp, special, program, summary] = CONFIGS.map(makeSinglePageSource).map(
  withoutAwardHistoryInRawText,
);

export const arrlAmateurRadioGrants = amateur;
export const arrlClubGrant = club;
export const arrlEtpGrants = withProseWindowDates(etp, ETP_WINDOW);
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
