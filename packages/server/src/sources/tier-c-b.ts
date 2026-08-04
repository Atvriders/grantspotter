import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { parseDateRange } from './util/dates.js';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

/**
 * EVERY LEADING WILDCARD IN THIS FILE IS `[^.\n]*`, NEVER `[^.]*`.
 *
 * The six real captures committed alongside this file (fixtures/<id>/00-*.html, pulled
 * 2026-08-03) are what forced the rule. `flattenHtml` emits one line per block element, and a
 * modern CMS page is mostly periodless navigation and card teasers — nasa.gov's CSLI page opens
 * with a newsroom carousel ("article 1 week ago 4 min read ...") containing no sentence-ending
 * period for well over a thousand characters. A leading `[^.]*` happily crosses all of it,
 * because `[^.]` matches newlines, so `nasa-csli`'s `benefit` field on the REAL page used to
 * capture 1,100 characters of unrelated Artemis/Curiosity headlines ending at the false boundary
 * inside "built by U.S." — a fabricated field value that no synthetic fixture could ever produce.
 * `[^.\n]*` cannot leave the line the anchor phrase lives on, so the worst case is one wrong
 * line, not a whole page.
 */

/**
 * ARISS rewrites one window sentence quarterly at a stable URL. Both ends or nothing.
 *
 * The pattern demands an open verb AND a close verb inside the same sentence. The bare
 * `proposal window[^.]*\.` this used to be matched the FIRST occurrence of the phrase on the
 * real page — "…you can complete the ARISS Proposal Form and submit it during the proposal
 * window." — and produced the field value "proposal window.", a two-word non-fact, while the
 * sentence carrying the actual dates sat six paragraphs lower.
 */
const ARISS_WINDOW = /(proposal window[^.\n]*?\bopen\w*\b[^.\n]*?\bclos\w*\b[^.]*\.)/i;

/**
 * `defaultYear` exists because the live sentence prints NO year: "Proposal window opened July 1
 * and closes on September 30 for contacts to be held from January to June 2027." `parseDateRange`
 * returns undefined for a year-less range, so without a default the resolved dates were silently
 * empty on the live page while the synthetic fixture (which spelled out "July 1, 2026") stayed
 * green. An explicit year in the sentence always wins — the default only fills a gap.
 */
export function parseArissWindow(
  flatText: string,
  defaultYear?: number,
): { opensAt?: string; closesAt?: string } | undefined {
  const sentence = ARISS_WINDOW.exec(flatText)?.[1];
  if (!sentence) return undefined;
  return parseDateRange(sentence, defaultYear);
}

/* ------------------------------------------ windows funders state in prose -------------------- */

/**
 * THE PROSE-WINDOW READER, and the four programmes it exists for.
 *
 * `normalize/deadline.ts` reads a funder-published window BY NAME out of `rawFields.opensAt` /
 * `closesAt` — that is the only channel a source has for saying "the funder printed these dates",
 * and it is the channel the precedence rule runs on (a date parsed off the funder's own page beats
 * every table in that file). Four programmes print an application window on their page, in prose,
 * and until this parser existed nothing turned any of them into dates:
 *
 *   arrl-etp-grants  "APPLICATIONS WILL ONLY BE ACCEPTED FOR REVIEW BETWEEN OCTOBER 1ST AND
 *                     OCTOBER 31ST of 2025."
 *   austin-arc       "Applications open May 1 and close July 31 each year."
 *   ieee-mtts        "IMPORTANT: All requests for MTT chapter funding must be received by
 *                     October 1 or the chapter may be asked to make its application in the
 *                     following year."
 *   ieee-student-…   "Student Branch Annual Plans are due 15 March."
 *
 * These are hand-written by volunteers, not to a schema, so the reader has to survive shouting
 * caps, ordinal suffixes, `and` used as a range separator, a year that arrives as "of 2025" three
 * words after the day it governs, the same-month shorthand "October 1 - 31", day-before-month
 * ("15 March"), and a month-granular range whose year sits at the far end of a filename-ish token
 * ("Jun-thru-Aug_2026"). Every one of those shapes is taken from a committed capture.
 *
 * WHAT IT REFUSES TO DO, and why that is the whole point of it.
 *
 * `yearUnstated` is a first-class result, not a failure. Three of the four sentences above name a
 * month and a day and NO YEAR anywhere on the page — Austin ARC's only four-digit number is the
 * footer's "© 2026 Austin Amateur Radio Club", IEEE's is "© Copyright 2026 IEEE", and a site
 * copyright is not a deadline. Filling that gap from the clock, or from the year the capture
 * happened to be taken in, would publish "closes 2026-10-01" over IEEE's name when IEEE has never
 * written 2026 next to that deadline. This parser therefore returns the month-day it read and says
 * the year is unstated, and the callers below publish NO date rather than a plausible one. A
 * yearless annual rule ("open May 1 and close July 31 each year") is a RECURRENCE, and the
 * representation for a recurrence — `RECUR annual_window window=05-01..07-31`, which carries no
 * year by construction — lives in `normalize/deadline.ts`'s `RECURRENCE_BY_SOURCE`, not in a
 * source's rawFields. There is no rawFields channel for one, which is exactly why these three stay
 * unresolved here instead of being coerced into the `opensAt`/`closesAt` channel, which means
 * something different: ONE dated window, never repeated.
 *
 * It also lives here, next to `parseArissWindow` — the single-purpose window reader it generalises
 * — rather than in `sources/util/`, so that every reader of a funder's window sentence sits in one
 * file and a change to one is read against the others.
 */
const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

const MONTH_ALT = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
/** `1ST`, `2nd`, `3rd`, `31st` — matched case-insensitively with the rest of the pattern. */
const ORDINAL = '(?:st|nd|rd|th)';
const MAX_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function lastDayOf(month: number, year: number): number {
  return month === 2 && isLeap(year) ? 29 : MAX_DAY[month - 1];
}

/**
 * A month/day pair, in page order, WITH A DAY. A bare month name is deliberately never a token on
 * this path: "…or the chapter **may** be asked to make its application in the following year"
 * contains the month name `may`, and a scanner that accepted bare months would read IEEE MTT-S's
 * one-deadline sentence as a May-to-October window. The month-granular shape that legitimately has
 * no days is handled by `MONTH_RANGE` below, which requires two month names AND a year and so
 * cannot fire on an English sentence that happens to use "may" as a verb.
 *
 * Both orders in one alternation, scanned once left to right, so the two halves can never produce
 * overlapping tokens for the same text: groups 1-2 are `15 March`, groups 3-4 are `October 1ST`.
 */
const DATE_TOKEN = new RegExp(
  `(?:\\b(\\d{1,2})${ORDINAL}?\\s+(?:of\\s+)?(${MONTH_ALT})[a-z]*\\.?)` +
    `|(?:\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?!\\d)${ORDINAL}?)`,
  'gi',
);

/**
 * A year that belongs to the date token immediately before it — ANCHORED at the token's end, so
 * only text glued to the date can supply it.
 *
 * That anchoring is the guard against the footer. "Applications open May 1 and close July 31 each
 * year." sits on a page whose only four-digit number is a copyright, and an unanchored "find a year
 * somewhere nearby" search is precisely how a copyright becomes a deadline. Accepts ", 2025",
 * " of 2025", " in 2025", "_2026" and a bare " 2025", plus a leading ordinal for the "31ST of 2025"
 * shape where the token stopped before the suffix.
 */
const TRAILING_YEAR = new RegExp(`^${ORDINAL}?\\s*,?[\\s_]*(?:of\\s+|in\\s+)?((?:19|20)\\d{2})\\b`, 'i');

/**
 * The same-month shorthand: "October 1 - 31 of 2025" states two days and names the month once, so
 * `DATE_TOKEN` sees only one date. Consulted only when exactly one token was found, and it must
 * re-find the same month, so it can never invent a second window out of an unrelated number.
 */
const SAME_MONTH_RANGE = new RegExp(
  `\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})${ORDINAL}?\\s*[-\\u2013\\u2014]\\s*(\\d{1,2})${ORDINAL}?`,
  'i',
);

/**
 * A month-granular range with its year at the end: Yaesu's "Jun-thru-Aug_2026". Consulted only when
 * no day-bearing token was found at all.
 *
 * THREE things are required together, and each one keeps this off ordinary English. The year, so a
 * month-only range that could never resolve does not pretend to. A DASH or `thru`/`through` as the
 * separator — never a bare "to" or "and" — because a hyphenated or `thru` range is compact range
 * NOTATION, while "to" is how a sentence talks: ARISS's window sentence ends "…for contacts to be
 * held from January to June 2027", which is when a contact happens and not when anyone may apply,
 * and reading it as a window would put a six-month application period on the calendar out of a
 * clause about the ISS crew schedule. And two month names, so the lone "may" that is really a verb
 * cannot start one.
 */
const MONTH_RANGE = new RegExp(
  `\\b(${MONTH_ALT})[a-z]*\\.?` +
    `(?:[\\s_]*[-\\u2013\\u2014][\\s_]*|[\\s_\\-\\u2013\\u2014]*(?:thru|through)[\\s_\\-\\u2013\\u2014]*)` +
    `(${MONTH_ALT})[a-z]*\\.?[\\s_,\\-]*(?:of\\s+|in\\s+)?((?:19|20)\\d{2})\\b`,
  'i',
);

/**
 * Which end of a window a LONE date is. A sentence with two dates states both ends; a sentence with
 * one states a deadline far more often than an opening ("must be received by October 1", "due 15
 * March"), so `closesOn` is the default and only an opening verb with no closing verb anywhere
 * moves it. Getting this backwards is not symmetric: an open date alone leaves `inferStatus`'s
 * inference untouched, while a close date alone can turn a live programme `closed`.
 */
const OPEN_VERB = /\b(?:open|opens|opened|opening|begins?|beginning|starts?|starting)\b/i;
const CLOSE_VERB =
  /\b(?:close[sd]?|closing|due|deadlines?|received by|no later than|ends?|ending|submitted by)\b/i;

/** A funder's stated window, as far as the sentence itself supports. */
export interface ProseWindow {
  /** `MM-DD`, always present when a date was read at all. */
  opensOn?: string;
  closesOn?: string;
  /** `YYYY-MM-DD` — present ONLY when the sentence states the year itself. */
  opensAt?: string;
  closesAt?: string;
  /** True when month and day were read but no year is stated. The dates stay unpublished. */
  yearUnstated: boolean;
}

interface DateToken {
  month: number;
  day: number;
  year?: number;
}

function tokenYear(sentence: string, endIndex: number): number | undefined {
  const m = TRAILING_YEAR.exec(sentence.slice(endIndex));
  if (!m) return undefined;
  const year = Number.parseInt(m[1], 10);
  return year >= 1990 && year <= 2100 ? year : undefined;
}

function validToken(month: number, day: number, year?: number): DateToken | undefined {
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > lastDayOf(month, year ?? 2001)) return undefined;
  const token: DateToken = { month, day };
  if (year !== undefined) token.year = year;
  return token;
}

function monthDay(token: DateToken): string {
  return `${String(token.month).padStart(2, '0')}-${String(token.day).padStart(2, '0')}`;
}

function isoDay(token: DateToken, year: number): string | undefined {
  if (token.day > lastDayOf(token.month, year)) return undefined;
  return `${String(year).padStart(4, '0')}-${monthDay(token)}`;
}

function scanTokens(sentence: string): DateToken[] {
  const found: DateToken[] = [];
  DATE_TOKEN.lastIndex = 0;
  for (let m = DATE_TOKEN.exec(sentence); m !== null; m = DATE_TOKEN.exec(sentence)) {
    const dayFirst = m[1] !== undefined;
    const monthWord = (dayFirst ? m[2] : m[3]).toLowerCase().slice(0, 3);
    const day = Number.parseInt(dayFirst ? m[1] : m[4], 10);
    const token = validToken(MONTHS[monthWord], day, tokenYear(sentence, m.index + m[0].length));
    if (token) found.push(token);
  }

  if (found.length === 1) {
    const bare = SAME_MONTH_RANGE.exec(sentence);
    if (bare) {
      const month = MONTHS[bare[1].toLowerCase().slice(0, 3)];
      const second = validToken(
        month,
        Number.parseInt(bare[3], 10),
        tokenYear(sentence, bare.index + bare[0].length),
      );
      // Only when it really is the token we already have, extended by a second day.
      if (second && month === found[0].month && Number.parseInt(bare[2], 10) === found[0].day) {
        found.push(second);
      }
    }
  }
  return found;
}

function monthGranularWindow(sentence: string): ProseWindow | undefined {
  const m = MONTH_RANGE.exec(sentence);
  if (!m) return undefined;
  const openMonth = MONTHS[m[1].toLowerCase().slice(0, 3)];
  const closeMonth = MONTHS[m[2].toLowerCase().slice(0, 3)];
  const year = Number.parseInt(m[3], 10);
  if (year < 1990 || year > 2100) return undefined;
  const open: DateToken = { month: openMonth, day: 1 };
  const close: DateToken = { month: closeMonth, day: lastDayOf(closeMonth, year) };
  return {
    opensOn: monthDay(open),
    closesOn: monthDay(close),
    opensAt: isoDay(open, year),
    closesAt: isoDay(close, year),
    yearUnstated: false,
  };
}

/**
 * The window one sentence states, or `undefined` when it states no date at all.
 *
 * `yearUnstated: true` means "the funder named these month-days and no year": `opensOn`/`closesOn`
 * are filled and `opensAt`/`closesAt` are NOT, and the caller publishes nothing. A window whose
 * close precedes its open within one year is rejected WHOLE rather than half-kept, on the same
 * reasoning `normalize/deadline.ts` gives: both halves came out of one sentence, so if they
 * contradict each other neither is trustworthy, and keeping the close alone would let a mis-parse
 * decide whether a programme reads as closed.
 */
export function parseProseWindow(sentence: string): ProseWindow | undefined {
  const tokens = scanTokens(sentence);
  if (tokens.length === 0) return monthGranularWindow(sentence);

  const open = tokens.length >= 2 ? tokens[0] : undefined;
  const close = tokens.length >= 2 ? tokens[tokens.length - 1] : undefined;
  const lone = tokens.length === 1 ? tokens[0] : undefined;
  const loneIsOpen = lone !== undefined && OPEN_VERB.test(sentence) && !CLOSE_VERB.test(sentence);

  const opensToken = open ?? (loneIsOpen ? lone : undefined);
  const closesToken = close ?? (loneIsOpen ? undefined : lone);

  // A year stated on EITHER end governs both, last-stated first — "May 1 and July 31, 2027" puts
  // the year only on the close, and "October 1ST … 31ST of 2025" only on the last token too.
  const statedYear = closesToken?.year ?? opensToken?.year;
  const window: ProseWindow = { yearUnstated: statedYear === undefined };
  if (opensToken) window.opensOn = monthDay(opensToken);
  if (closesToken) window.closesOn = monthDay(closesToken);
  if (statedYear === undefined) return window;

  const opensAt = opensToken ? isoDay(opensToken, opensToken.year ?? statedYear) : undefined;
  const closesAt = closesToken ? isoDay(closesToken, closesToken.year ?? statedYear) : undefined;
  if (opensAt !== undefined && closesAt !== undefined && closesAt < opensAt) {
    return { ...window, yearUnstated: false };
  }
  if (opensAt !== undefined) window.opensAt = opensAt;
  if (closesAt !== undefined) window.closesAt = closesAt;
  return window;
}

/**
 * Publishes `rawFields.opensAt` / `closesAt` for a source whose page states its window in prose.
 *
 * The sentence is re-matched off `rawText` with the SAME RegExp constant the config's
 * `fieldPatterns` uses, so the field a reviewer reads and the dates the product publishes can never
 * come from two different sentences. `rawFields.window` / `rawFields.deadline` are deliberately NOT
 * read: they are the same text, and reading one here would silently retire an entry in
 * `normalize/rawFieldsContract.test.ts`'s write-only ledger without the defect it names being fixed.
 *
 * Adds NOTHING when the sentence states no year. That is the common case among these four pages and
 * it is the correct output — see `parseProseWindow`.
 */
export function withProseWindowDates(module: SourceModule, sentence: RegExp): SourceModule {
  const inner = module.parse.bind(module);
  const re = new RegExp(sentence.source, sentence.flags.replace('g', ''));
  return {
    ...module,
    parse: (payloads) =>
      inner(payloads).map((raw) => {
        // Same ellipsis collapse `makeSinglePageSource` applies before matching, so a page that
        // abbreviates with "..." cannot make the wrapper and the field disagree.
        const m = re.exec(raw.rawText.replace(/\.{2,}/g, ' '));
        if (!m) return raw;
        const window = parseProseWindow((m[1] ?? m[0]).replace(/\s+/g, ' ').trim());
        if (!window || (window.opensAt === undefined && window.closesAt === undefined)) return raw;
        const rawFields = { ...raw.rawFields };
        if (window.opensAt !== undefined) rawFields.opensAt = window.opensAt;
        if (window.closesAt !== undefined) rawFields.closesAt = window.closesAt;
        return { ...raw, rawFields };
      }),
  };
}

/**
 * The two IEEE deadline sentences, named so the config below and `withProseWindowDates` share ONE
 * pattern each. Both pages state a month and a day and no year at all — see the notes on each
 * config for what that costs and why nothing is invented to cover it.
 */
const MTTS_DEADLINE = /([^.\n]*\bOctober 1\b[^.]*\.)/i;
const REBATE_DEADLINE = /([^.\n]*(?:15 March|March 15)[^.\n]*\.)/i;

const CONFIGS: SinglePageConfig[] = [
  {
    id: 'ncdxf-grants',
    funderId: 'ncdxf',
    label: 'NCDXF Grant Program',
    tier: 'C',
    klass: 'ham_grant',
    url: 'https://www.ncdxf.org/pages/grant-app.html',
    name: 'NCDXF Grant Program',
    externalKey: 'ncdxf-grant-program',
    fieldPatterns: {
      // "The Foundation makes cash grants to projects it believes will benefit amateur radio in
      // general and DXing in particular." — real capture line 251. Named `summary` because
      // normalize/index.ts's buildSummary reads that key FIRST and otherwise falls back to
      // rawText, which on this Dreamweaver-era page begins with a 28-item navigation column;
      // every one of these six records used to publish its nav menu as its summary.
      summary: /(The Foundation makes cash grants[^.]*\.)/i,
      audience: /(individuals? and groups[^.]*\.)/i,
      leadTime: /(two months[^.]*\.)/i,
      // REAL-PAGE FIX. The live page contains no such word as "treasurer" anywhere, so this
      // required field never matched and ncdxf-grants parsed ZERO records from its own page
      // while the synthetic-only suite stayed green. The page's actual intake sentence is
      // "Applications must be made by completing (1) a Budget Worksheet and (2) an Application
      // Form, and submitting both to NCDXF." (line 255). The treasurer alternative is kept only
      // so the synthetic pathological fixture keeps exercising the sentence-capture path.
      applyNote: /((?:Applications must be made by|[^.\n]*treasurer)[^.]*\.)/i,
      stake: /([^.\n]*financial stake[^.]*\.)/i,
      // "With the exception of excess baggage charges, we do not consider commercially available
      // transportation costs…" (line 272) — the funder's own words behind
      // RESTRICTIONS_BY_SOURCE['ncdxf-grants'].
      restrictions: /([^.\n]*commercially available transportation[^.]*\.)/i,
      // "This page was updated January 3, 2014" (line 250). Load-bearing provenance, not trivia:
      // the guidelines text is twelve years old even though the program itself is live.
      pageUpdated: /(This page was updated [A-Z][a-z]+ \d{1,2}, \d{4})/i,
    },
    requiredFields: ['applyNote'],
    expectedMinRecords: 1,
    notes:
      'Rolling, allow ~2 months lead. In practice DXpedition teams to top-100 DXCC entities — ' +
      'NOT a collegiate program, and the record says so rather than implying eligibility. ' +
      'Amounts unpublished (~$1.2M over ~48 years, so many small awards). Applicant must have ' +
      'a personal financial stake. INTAKE, corrected against the real page: a Budget Worksheet ' +
      'spreadsheet emailed to dxbudget@ncdxf.org PLUS a web application form POSTed from ' +
      '/pages/grant_app.php — not, as this note previously claimed, a packet emailed to the ' +
      'treasurer (the word "treasurer" appears nowhere on either page). The guidelines page ' +
      'itself says "This page was updated January 3, 2014". ncdxf.org 403s BOTH its robots.txt ' +
      'and its sitemap.xml; the fetcher treats a 403 robots.txt as "no rules published", which ' +
      'is what keeps this source reachable without spoofing a browser.',
  },
  {
    id: 'ncdxf-scholarships',
    funderId: 'ncdxf',
    label: 'NCDXF W6EEN Memorial Scholarship and Youth Grant',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://www.ncdxf.org/pages/scholarships.html',
    name: 'NCDXF W6EEN Memorial Scholarship',
    externalKey: 'ncdxf-w6een-scholarship',
    fieldPatterns: {
      summary: /((?:NCDXF will provide|The award covers)[^.]*\.)/i,
      // REAL-PAGE FIX. The live page never writes "25 or younger": it writes "25 years of age
      // and younger" (line 240) and "25 years of age or younger" (line 241). The old pattern
      // allowed an optional "years " but not "of age ", so the age cap — the entire eligibility
      // rule of this scholarship — silently failed to match on the real page.
      age: /([^.\n]*\b25(?: years)?(?: of age)? (?:or|and) (?:younger|under)[^.]*\.)/i,
      benefit: /([^.\n]*tuition[^.]*\.)/i,
      // "If you are a licensed amateur radio operator 25 years of age or younger, you can apply
      // for a free tuition scholarship by contacting the appropriate University directly:"
      // (line 241). Ends in a COLON, not a period — the two university contact URLs follow as
      // their own lines. normalize publishes this as applyContact.
      applyNote: /(If you are a licensed[^.\n]*contacting the appropriate University directly:)/i,
      // THE LICENCE REQUIREMENT ITSELF, which this config used to drop on the floor — the third
      // and last instance of a defect already fixed in tier-c-a.ts for QCWA and for the three
      // YLRL scholarships. `extractLicense` (normalize/axes/license.ts) reads ONLY the
      // `License Requirement` and `license` rawFields. Both of this page's licence sentences
      // landed elsewhere — one inside `age`, one inside `applyNote` — so this record published
      // with NO licence constraint at all, and a scholarship the funder restricts to licensed
      // hams showed as open to an applicant holding no amateur licence. It escaped the
      // hs-unlicensed regression canary only because a missing constraint lands such an applicant
      // in the `unknown` bucket rather than `eligible`, so it never moved the number.
      //
      // POLARITY, which is what makes this class dangerous. The live sentence (real capture line
      // 240) is "There is no restriction as to class of license." That is ANY CLASS QUALIFIES: it
      // PRESUPPOSES a licence and disclaims only a floor above the entry level. It is NOT "no
      // licence needed", one word away in English. license.ts's CLASS_AGNOSTIC check — ordered
      // before NO_LICENSE for exactly this shape — resolves it to TECH, the entry-level US class
      // that every higher class also satisfies. The job here is only to make the sentence REACH it.
      //
      // ANCHORED AWAY FROM THE PAGE'S OTHER LICENCE SENTENCE ON PURPOSE. Line 241 states the rule
      // too ("If you are a licensed amateur radio operator 25 years of age or younger…") and is
      // the more obvious anchor, but `extractLicense` runs `heldMonthsFrom` over whatever text it
      // is handed, and that sentence's "25 years" would parse as heldMonthsMin: 300 — a
      // twenty-five-year licence-tenure requirement this funder never stated, and a far worse
      // error than the one being fixed. The captured sentence must carry the licence rule and no
      // unrelated number, which the class-restriction sentence does and the age sentence does not.
      //
      // Two alternatives, one per fixture: the live page's "no restriction as to class of
      // license", and the "any license class" wording of the synthetic pathological.html (also
      // the shape 40+ ARRL catalog entries use), which keeps that fixture exercising this path.
      license: /([^.\n]*\b(?:no restrictions? as to (?:the )?class of licen[sc]e|any licen[sc]e class)\b[^.]*\.)/i,
      // The page also carries the RETIRED predecessor: "Previous ARRL Foundation Scholarship
      // Program (No Longer Active)" over a 1998-2012 recipient table. Captured explicitly so a
      // reviewer can see that the "No Longer Active" text on this page belongs to the old cash
      // scholarship and NOT to the current tuition benefit. See the notes below for the
      // normalize-side consequence.
      retiredPredecessor: /(Previous ARRL Foundation Scholarship Program \(No Longer Active\))/i,
    },
    // `license` is required for a sharper reason than `benefit`, and the same one tier-c-a.ts
    // gives for QCWA: if `benefit` goes quiet the record merely gets thinner, but if the licence
    // sentence goes quiet the record gets WIDER — it silently reverts to publishing a
    // licensed-hams-only scholarship as open to everyone, which is the defect this entry exists
    // to prevent. An empty yield is loud and a human fixes it the same day; a missing licence
    // floor is silent and misleads applicants until someone re-reads the page.
    requiredFields: ['benefit', 'license'],
    expectedMinRecords: 1,
    notes:
      'Licensed hams 25 or younger, any class. Benefit is full tuition at DX University or ' +
      'Contest University with no dollar figure, so the instrument is tuition_coverage. Apply by ' +
      'contacting the university directly, not NCDXF. No published deadlines — it tracks course ' +
      'schedules, so DeadlineKind is unpublished. The companion Youth Grant page renders as nav ' +
      '+ title only with no terms at all. CAUTION, from the real page: the tuition text was ' +
      'written in 2013 ("for the next year") and the recipient table under "Previous ARRL ' +
      'Foundation Scholarship Program (No Longer Active)" stops at 2012, so the page states no ' +
      'current cycle either way. That "No Longer Active" heading describes the RETIRED cash ' +
      'scholarship, but it lives in the same rawText that normalize/deadline.ts scans for ' +
      'inactivity, so this record currently computes status=dormant off a sentence about a ' +
      'different program. The $20,000 figures on the page are DONATIONS INTO the fund, never ' +
      'award amounts — no amount field is extracted here, deliberately. AN AMATEUR RADIO LICENCE ' +
      'IS A HARD REQUIREMENT, floor TECH: the page says "If you are a licensed amateur radio ' +
      'operator 25 years of age or younger, you can apply", and "There is no restriction as to ' +
      'class of license" is ANY CLASS QUALIFIES — not "no licence needed". The two must never be ' +
      'conflated; the second reading publishes a licensed-operators-only award to an unlicensed ' +
      'applicant.',
  },
  {
    id: 'ariss',
    funderId: 'ariss-usa',
    label: 'ARISS-USA ISS Contact Proposals',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://ariss-usa.org/proposal-overview/',
    name: 'ARISS-USA ISS Contact Proposal',
    externalKey: 'ariss-iss-contact-proposal',
    fieldPatterns: {
      summary: /(A scheduled ARISS contact is[^.]*\.)/i,
      window: ARISS_WINDOW,
      // "US schools and educational organizations may download the ARISS Proposal Form…"
      // (real capture line 190) — the eligibility wording the notes below are careful about.
      eligibility: /(US schools and educational organizations[^.]*\.)/i,
      // "Proposals from schools and organizations in the US are accepted during four proposal
      // windows each year – one each quarter." (line 243) — the cadence behind
      // DeadlineKind quarterly_rewritten, in the funder's own words.
      cadence: /(Proposals from schools and organizations[^.\n]*four proposal windows[^.]*\.)/i,
      // "If you have questions regarding the proposal process, please send an email to:
      // education@ariss-usa.org" (line 260). No trailing period — the address ends the line.
      applyNote: /((?:If you have questions[^.\n]*)?please send an email to:\s*[\w.+-]+@[\w.-]+)/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 1,
    extraParse: (): RawOpportunity[] => [],
    notes:
      'No cash at all: a scheduled ISS crew contact plus technical mentoring, so the instrument ' +
      'is in_kind_service. Four windows a year, rewritten quarterly at a STABLE URL, which ' +
      'makes it one of the better scrape targets in the corpus. Eligibility reads "US schools ' +
      'and educational organizations" — colleges and universities are NOT explicitly named and ' +
      'K-12 dominates; that ambiguity is preserved in rawOtherText and never resolved by ' +
      'guessing. Confirmed against the real page 2026-08-03: the widest wording there is ' +
      '"formal and informal education institutions and organizations", and INDIVIDUALS are ' +
      'named nowhere — an ARISS contact is hosted by an organization, which is what ' +
      'ENTITIES_BY_SOURCE encodes. The live window sentence prints month and day but NO YEAR, ' +
      'so the resolved dates use the capture year (see parseArissWindow); the four windows sit ' +
      'inside calendar quarters and never straddle a year boundary.',
  },
  {
    id: 'ieee-mtts',
    funderId: 'ieee-mtts',
    label: 'IEEE MTT-S Chapter Support',
    tier: 'C',
    klass: 'adjacent_stem',
    url: 'https://mtt.org/chapter-support/',
    name: 'IEEE MTT-S Chapter Support',
    externalKey: 'ieee-mtts-chapter-support',
    fieldPatterns: {
      summary: /((?:MTT-S provides annual financial support|Single-society Student Branch Chapters)[^.]*\.)/i,
      // REAL-PAGE FIX. The live page does not say "due October 1"; it says "IMPORTANT: All
      // requests for MTT chapter funding must be received by October 1 or the chapter may be
      // asked to make its application in the following year." (real capture line 619). This
      // required field never matched, so ieee-mtts parsed ZERO records from its own page.
      deadline: MTTS_DEADLINE,
      amount: /([^.\n]*\$1,000[^.]*\.)/i,
      // REAL-PAGE FIX. "Minimum of ten (10) members; five (5) members for Student Branch
      // Chapters" (line 588) — a bullet with NO trailing period, and with the digit form the old
      // `five members` pattern could not see. Line-bounded on BOTH sides: a trailing `[^.]*\.`
      // would have run through three more periodless bullets and a heading before finding one.
      // Capturing the whole bullet keeps the ten-vs-five distinction the old note got wrong.
      requirements: /([^.\n]*\bfive\s*(?:\(5\)\s*)?members[^.\n]*)/i,
      // "The fund provides $500 seed money per chapter…" (line 611) and "up to $2,250 per year
      // to send a Chapter Officer to attend one of the Chapter Chair Meetings" (line 663) —
      // two funding lines this source never carried at all.
      workshopFund: /([^.\n]*\$500 seed money[^.]*\.)/i,
      travelSupport: /([^.\n]*\$2,250[^.]*\.)/i,
      // Read live from the anchor rather than hardcoded, because the Jotform id is year-keyed
      // (243523980737161 is the 2024-series form) — that is exactly what APPLY_VIA_BY_SOURCE's
      // 'jotform_year_keyed' means. Lives only in an href, so it matches on the raw-HTML
      // fallback; if MTT-S ever renames the link, applyUrl degrades to the page URL.
      formUrl: /https:\/\/form\.jotform\.com\/\d+(?="[^>]*>\s*Chapter Funding\s*<)/i,
    },
    requiredFields: ['deadline'],
    expectedMinRecords: 1,
    notes:
      'The most RF-relevant IEEE money. Oct 1 annual, stated inline as "must be received by ' +
      'October 1". $1,000/yr single-society Student Branch Chapter, $500 joint; $500 seed money ' +
      'for a chapter workshop/symposium; up to $2,250/yr for a Chapter Officer to attend a ' +
      'Chapter Chair Meeting. THE DEADLINE STATES NO YEAR, on any part of the page: the sentence ' +
      'is "must be received by October 1 or the chapter may be asked to make its application in ' +
      'the following year", and the only four-digit numbers on the capture are unrelated event ' +
      'names and "© Copyright 2026 IEEE". `parseProseWindow` reads 10-01 and refuses to resolve ' +
      'it, so no opensAt/closesAt is published — an October 1 with a year we chose would be a ' +
      'deadline IEEE never printed. "the following year" is IEEE stating an ANNUAL RULE, and the ' +
      'representation for one is a RECUR annual_window directive (which carries no year), not a ' +
      'dated window. Eligibility, corrected against the real page: a minimum of TEN ' +
      'members for an ordinary chapter and FIVE for a Student Branch Chapter (this note used to ' +
      'say ">= 5 members" flatly), plus a current vTools officer roster and >= 2 reported ' +
      'technical meetings in the previous year. Chapters are also told to apply to their IEEE ' +
      'Section first. Jotform application, id read live from the page. The undergraduate ' +
      'scholarships and graduate fellowships are a DIFFERENT MTT-S program on ' +
      'mtt.org/students/ — this page states no scholarship terms, so none are claimed here.',
  },
  {
    id: 'ieee-student-branch-rebate',
    funderId: 'ieee',
    label: 'IEEE Student Branch Rebate',
    tier: 'C',
    klass: 'adjacent_stem',
    url: 'https://students.ieee.org/topics/submit-your-student-branch-annual-plan/',
    name: 'IEEE Student Branch Rebate',
    externalKey: 'ieee-student-branch-rebate',
    fieldPatterns: {
      summary: /(Submitting an Annual Plan is required[^.]*\.)/i,
      // The old pattern started AT "15 March" and so captured the two-word fragment "15 March."
      // from the real page. Line-bounded prefix: the whole three-sentence body is one <p>, but
      // the nearest preceding period is up in the site chrome ("IEEE.org"), which an unbounded
      // `[^.]*` would have swallowed along with forty lines of navigation.
      deadline: REBATE_DEADLINE,
      // "Submit your Branch's Annual Plan through vTools Student Branch Reporting." — the
      // apostrophe is U+2019 on the live page, so this never spells the word out.
      applyNote: /(Submit your Branch[^.\n]*Annual Plan through[^.]*\.)/i,
    },
    requiredFields: ['deadline'],
    expectedMinRecords: 1,
    notes:
      'A REBATE, NOT A GRANT — the page\'s own words: "Submitting an Annual Plan is required to ' +
      'qualify for a Student Branch Rebate." The Annual Plan is a reporting obligation that ' +
      'qualifies a branch for money it does not apply for, which is why the instrument is ' +
      'per_member_rebate and not a cash grant. Annual Plan due 15 March, submitted through ' +
      'vTools Student Branch Reporting. THE DEADLINE STATES NO YEAR: the whole body is one ' +
      'sentence, "Student Branch Annual Plans are due 15 March.", and the page\'s only dates are ' +
      'the post\'s own 2022 byline and a 2026 IEEE copyright — neither is the deadline\'s year. ' +
      '`parseProseWindow` reads 03-15 and refuses to resolve it, so no closesAt is published. ' +
      '"Annual Plans" is an annual rule, whose home is a RECUR annual_window directive, not a ' +
      'dated window. Rebate figures ($50/yr under 50 members, $100/yr at ' +
      '50+, plus $2/member and $1/chapter member) appear NOWHERE on this page — it contains no ' +
      'dollar sign at all — and the amounts page mga.ieee.org/.../rebates returns HTTP 418 to ' +
      'bots, so no amount is extracted and the record publishes none. We do not spoof a browser ' +
      'to read it. The source URL is a 2022 "Hot Topics" post, the only IEEE page stating the ' +
      'deadline in crawlable form.',
  },
  {
    id: 'nasa-csli',
    funderId: 'nasa',
    label: 'NASA CubeSat Launch Initiative',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/',
    name: 'NASA CubeSat Launch Initiative (CSLI)',
    externalKey: 'nasa-csli',
    fieldPatterns: {
      // REAL-PAGE FIX, the worst capture the six real fixtures exposed. The old
      // `[^.]*launch[^.]*services[^.]*\.` produced 1,100 characters of NASA newsroom carousel
      // ("…Curiosity Mars Rover Discovers Field of Honeycomb Textures article 5 days ago…")
      // terminated at the false sentence boundary inside "built by U.S." — a wholly fabricated
      // field. Anchored on the sentence itself (real capture line 1432), and periods are allowed
      // through only when glued to a letter, which is what lets "U.S." stay inside the sentence.
      benefit:
        /((?:NASA[’']s )?(?:CubeSat Launch Initiative|CSLI) provides (?:opportunities|launch)(?:[^.]|(?<=\b[A-Z])\.)*\.)/i,
      summary: /(Through innovative technology partnerships[^.]*\.)/i,
      // "CSLI's Announcements of Partnership Opportunity is typically released each August with
      // proposals due in November." — the only cycle statement the page now makes.
      applicationCycle: /(CSLI[’']s Announcements? of Partnership Opportunity[^.]*\.)/i,
      // Renamed from `status`: normalize/deadline.ts READS rawFields.status as a ProgramStatus
      // override and only ignored this prose because a sentence never equals a known status —
      // a writer that collides with a reader by name and misses by luck. No dollar figure is
      // extracted anywhere in this config: CSLI is a launch slot, not money, and an `amount`
      // key here would make buildAmount publish a cash instrument for it.
      statusNote: /((?:anticipates?|expects?)[^.\n]*\d{4}[^.]*\.)/i,
    },
    requiredFields: ['benefit'],
    expectedMinRecords: 1,
    notes:
      'No cash: launch and deployment services only; the team funds its own hardware, so the ' +
      'instrument is in_kind_service and no amount is parsed. Eligibility per the live page: ' +
      'CubeSats built by U.S. educational institutions and non-profit organizations, including ' +
      'informal educational institutions such as museums and science centers. The page was ' +
      'rewritten between rounds: it no longer says NASA "anticipates an update in spring 2026" ' +
      '(that sentence is now exercised only by the synthetic fixture) and instead states the ' +
      'historical cadence, "CSLI\'s Announcements of Partnership Opportunity is typically ' +
      'released each August with proposals due in November." Typically is not a date, so there ' +
      'is still NO confirmed open window and status: unknown remains the honest rendered state. ' +
      'NSPIRES has no API, RSS, XML, JSON or CSV (session-stateful Struts/JSF .do app); ' +
      'Grants.gov is the only machine route to NASA opportunities.',
  },
];

const modules = CONFIGS.map(makeSinglePageSource);

/**
 * The year the payload was fetched. Data carried on the payload, not a clock read — parse()
 * stays a pure function of its inputs, and replaying a committed fixture keeps giving the year
 * the page was actually captured in.
 */
function captureYear(payloads: FetchedPayload[]): number | undefined {
  for (const payload of payloads) {
    const year = Number.parseInt(payload.fetchedAt.slice(0, 4), 10);
    if (Number.isFinite(year) && year > 1900) return year;
  }
  return undefined;
}

/** ARISS additionally resolves its window sentence into ISO dates for normalize/. */
function withArissDates(module: SourceModule): SourceModule {
  const inner = module.parse.bind(module);
  return {
    ...module,
    parse: (payloads) => {
      const year = captureYear(payloads);
      return inner(payloads).map((raw) => {
        const range = parseArissWindow(raw.rawText, year);
        if (!range?.opensAt || !range.closesAt) return raw;
        return {
          ...raw,
          rawFields: { ...raw.rawFields, opensAt: range.opensAt, closesAt: range.closesAt },
        };
      });
    },
  };
}

export const ncdxfGrants = modules[0];
export const ncdxfScholarships = modules[1];
export const ariss = withArissDates(modules[2]);
// Both wrapped on the SAME path as arrl-etp-grants, and both currently publish nothing: their
// pages state a month-day and no year (see each config's notes). The wrapper is not decorative —
// it is what makes the refusal a tested behaviour of the live capture rather than a claim in a
// comment, and what makes the dates appear by themselves the day either page prints a year.
export const ieeeMtts = withProseWindowDates(modules[3], MTTS_DEADLINE);
export const ieeeStudentBranchRebate = withProseWindowDates(modules[4], REBATE_DEADLINE);
export const nasaCsli = modules[5];

export const TIER_C_B_SOURCES: SourceModule[] = [
  ncdxfGrants,
  ncdxfScholarships,
  ariss,
  ieeeMtts,
  ieeeStudentBranchRebate,
  nasaCsli,
];
