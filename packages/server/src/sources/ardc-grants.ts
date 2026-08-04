import * as cheerio from 'cheerio';
import type { FetchRequest, FetchedPayload, RawOpportunity } from '@grantspotter/core';
import type { FollowUpContext, FollowUpSource } from './types.js';
import { pickPayload } from './util/payload.js';
import { flattenHtml, normalizeText } from './util/text.js';

const SOURCE_ID = 'ardc-grants';
const API = 'https://www.ardc.net/wp-json/wp/v2/pages';
const DISCOVERY_URL = `${API}?slug=grants&per_page=100&_fields=id,slug,link,parent,title,modified`;
const CHILD_FIELDS = 'id,slug,link,title,date,modified,parent,excerpt';

/** The application itself. Not a child of /apply/grants/, so the API leg above cannot reach it. */
export const APPLY_URL = 'https://www.ardc.net/apply/';
export const INSTRUCTIONS_URL = 'https://www.ardc.net/apply/grant-application-instructions/';

export interface WpPage {
  id?: number;
  slug?: string;
  link?: string;
  parent?: number;
  title?: { rendered?: string };
  date?: string;
  modified?: string;
  excerpt?: { rendered?: string };
}

/**
 * A child page of /apply/grants/ that is a YEAR ARCHIVE of grants already made — not an
 * opportunity. Three independent signals, every one of them present in the real capture
 * (fixtures/ardc-grants/01-children.json, fetched 2026-08-03 from
 * `wp/v2/pages?parent=1271`): the slug (`2025-grants`), the title (`2025 Grants`), and the
 * funder's own excerpt, which is the award table itself — verbatim, for the 2025 page:
 *
 *   "Information on 2025 Charitable Gifts can be found below. … Date Grantee Project Amount
 *    October 2025 Central Kansas Amateur Radio Club Inc. FieldLab WØCY $35,640 …"
 *
 * ALL EIGHT children the live API returns (2019 … 2026) match. There is not one application
 * page among them: ARDC's application lives at /apply/ and its instructions at
 * /apply/grant-application-instructions/, neither of which is a child of this parent and
 * neither of which this source fetches.
 *
 * `ardc-award-tables` fetches these same eight URLs and classifies every row inside them
 * `past_award`. Publishing the container as an open, club-eligible grant while suppressing its
 * contents is the repo contradicting itself about the same bytes.
 */
const YEAR_ARCHIVE_SLUG = /^\d{4}-grants$/;
const YEAR_ARCHIVE_TITLE = /^\d{4}\s+grants$/i;
const YEAR_ARCHIVE_EXCERPT = /\bgrants awarded in \d{4}\b|\bcharitable gifts\b/i;

/**
 * A per-project page. Not present among the live children today, but 376 distinct links of
 * exactly this shape appear inside the eight captured award tables
 * (fixtures/ardc-award-tables/0*.html), e.g.
 * `/apply/grants/2025-grants/grant-digital-communications-enhancement/` — every one of them a
 * row in a table of money already handed out, and not one of them without the `{YYYY}-grants`
 * segment. The `grant-` slug prefix is ARDC's own marker for "this is a grant we made".
 */
const FUNDED_PROJECT_SLUG = /^grant-/;

/**
 * `past_award` when the funder's own metadata says this page is a record of grants already
 * made, `undefined` when it does not. `normalize/` turns `past_award` into status `closed` plus
 * the `do_not_publish` tag, which is what keeps a page of history out of the review queue.
 *
 * Silence is NOT read as history: a child page this function cannot classify still publishes as
 * an opportunity, because suppressing a page nobody has described would hide a real award.
 */
export function pastAwardClassification(page: WpPage, excerpt: string): string | undefined {
  const slug = page.slug ?? '';
  const title = (page.title?.rendered ?? '').replace(/\s+/g, ' ').trim();
  if (YEAR_ARCHIVE_SLUG.test(slug) || YEAR_ARCHIVE_TITLE.test(title)) return 'past_award';
  if (YEAR_ARCHIVE_EXCERPT.test(excerpt)) return 'past_award';
  if (FUNDED_PROJECT_SLUG.test(slug)) return 'past_award';
  return undefined;
}

/* ------------------------------------------------------------- the application itself -------- */

/**
 * THE OPPORTUNITY LEG (added 2026-08-03).
 *
 * The API leg above returns ARDC's HISTORY and nothing else — eight year archives, every one of
 * them correctly suppressed — which left the largest funder in this corpus, and the only ham
 * source with a real API, publishing NOTHING. The application is not missing from ARDC's site; it
 * was missing from this pipeline, because it lives at /apply/ and /apply/grant-application-
 * instructions/, neither of which is a child of /apply/grants/ and neither of which anything
 * fetched. Both are now first-phase requests: they are ordinary pages with no id to resolve, so
 * they must not be made to depend on the WordPress discovery call succeeding.
 *
 * Every field below is lifted from those two captures and nothing is asserted from research. The
 * three facts an applicant cannot act without — WHEN, the open-access condition on the funded
 * work, and the 20% indirect-cost ceiling — are quoted verbatim in `sources/ardc-grants.test.ts`
 * against the committed bytes, which is the check that would have caught the Yaesu "12-month
 * on-air obligation" that no page has ever contained.
 *
 * DELIBERATELY NOT PARSED: "in 2026 we aim to fund approximately $3.8 million" (instructions page)
 * is ARDC's ANNUAL GRANTMAKING BUDGET, not an award size. Writing it into `amountRaw` would put
 * "$3.8 million" on the record as what an applicant could receive — the same class of error as
 * reading QCWA's lifetime giving as this year's award — so this source publishes no amount at all.
 */
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * `February 1` -> `02-01`; `September 1 + Scholarship Program Applications Due` -> `09-01`.
 * Anything that does not START with a month name and a day is not a deadline and returns
 * undefined — which is what keeps "Applications received after September 1, 2026 will be reviewed
 * February 1, 2027" (a rollover sentence, two dates, one of them in another year) from being read
 * as two more application deadlines.
 */
export function monthDayOf(text: string): string | undefined {
  const m = /^\s*([A-Za-z]+)\s+(\d{1,2})(?!\d)/.exec(text);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number.parseInt(m[2], 10);
  if (month === -1 || day < 1 || day > 31) return undefined;
  return `${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface ApplyFacts {
  /** The funder's own <h1>. */
  name?: string;
  /** The Overview paragraph. */
  summary?: string;
  /** Where ARDC says to apply: the grants.ardc.net portal it links, verbatim. */
  applyUrl?: string;
  /** The funder's own "reach out to us" sentence. */
  applyNote?: string;
  /** The deadline paragraph, its four list items and the rollover sentence, verbatim. */
  deadlineText?: string;
  /** `02-01`, `04-01`, … — the list items above, in page order. */
  deadlineDates: string[];
  /** The Open Access Requirement section, verbatim, including the licence list. */
  openAccess?: string;
  /** The Eligibility section, verbatim. */
  eligibility?: string;
}

/** One element's text as a line per block, or undefined when the selector matched nothing. */
function textOf($: cheerio.CheerioAPI, nodes: cheerio.Cheerio<never>): string | undefined {
  const parts = nodes
    .toArray()
    .map((el) => flattenHtml($.html(el)))
    .filter((t) => t !== '');
  return parts.length === 0 ? undefined : parts.join('\n');
}

/**
 * A section of an ARDC page: the heading with this id, plus every sibling up to the next heading.
 * ARDC's pages are ordinary WordPress prose with real `<h2 id>`/`<h3 id>` anchors — the page even
 * links to them itself ("adhere to our <a href="#open-access">open access requirement</a>") — so
 * the anchor is the funder's own structure and not a shape we imposed on the text.
 */
function sectionText($: cheerio.CheerioAPI, id: string): string | undefined {
  const heading = $(`#${id}`);
  if (heading.length === 0) return undefined;
  return textOf($, heading.nextUntil('h1, h2, h3') as cheerio.Cheerio<never>);
}

export function parseApplyPage(html: string): ApplyFacts {
  const $ = cheerio.load(html);
  const facts: ApplyFacts = { deadlineDates: [] };

  /**
   * The page's own heading ("Apply for a Grant"), falling back to its <title>. Never a literal of
   * ours: a name we typed would outlive the page that justified it — and it nearly did. ardc.net
   * opens with `<h1 class="image-logo">` wrapping the site logo IMAGE, so `$('h1').first().text()`
   * is the empty string, and an earlier draft of this parser fell through to a hardcoded
   * 'Apply for a Grant' that happened to be right. Its test passed while asserting our own literal
   * back to us. The first h1 WITH TEXT is the page title; ARDC marks it `class="page-title"`, but
   * matching on emptiness rather than on their class name survives a re-skin.
   */
  const heading = $('h1')
    .toArray()
    .map((el) => normalizeText($(el).text()))
    .find((text) => text !== '');
  const title = normalizeText($('title').first().text());
  if (heading !== undefined) facts.name = heading;
  else if (title !== '') facts.name = title;

  const overview = $('#overview').nextUntil('h1, h2, h3').filter('p').first();
  const summary = normalizeText(overview.text());
  if (summary !== '') facts.summary = summary;

  // "The 2026 application deadlines are:" followed by a <ul> of four dates. The intro paragraph is
  // matched on the funder's own words, and the dates are read off the list rather than off a table
  // in our code — if ARDC republishes with different dates, this reports the new ones.
  const intro = $('p')
    .filter((_, el) => /application deadlines are/i.test($(el).text()))
    .first();
  if (intro.length > 0) {
    const list = intro.nextAll('ul').first();
    const items = list
      .find('li')
      .toArray()
      .map((li) => normalizeText($(li).text()))
      .filter((t) => t !== '');
    for (const item of items) {
      const md = monthDayOf(item);
      if (md !== undefined) facts.deadlineDates.push(md);
    }
    // The sentence directly after the list, which is what makes these a RECURRING rule rather than
    // four dates in one year: ARDC states its own rollover into the next February.
    const rollover = list.nextAll('p').first();
    const rolloverText = /will be reviewed/i.test(rollover.text()) ? normalizeText(rollover.text()) : '';
    facts.deadlineText = [normalizeText(intro.text()), ...items, rolloverText]
      .filter((t) => t !== '')
      .join(' ');
  }

  // The apply route ARDC names: "please apply here: https://grants.ardc.net", and an APPLY button
  // on the same href. Taken from the funder's own link, never constructed.
  const portal = $('a[href]')
    .toArray()
    .map((el) => $(el).attr('href') ?? '')
    .find((href) => {
      try {
        return new URL(href, APPLY_URL).hostname === 'grants.ardc.net';
      } catch {
        return false;
      }
    });
  if (portal !== undefined) facts.applyUrl = portal;

  const reachOut = $('p')
    .filter((_, el) => /reach out to us at any time/i.test($(el).text()))
    .first();
  const reachOutText = normalizeText(reachOut.text());
  if (reachOutText !== '') facts.applyNote = reachOutText;

  facts.openAccess = sectionText($, 'open-access');
  facts.eligibility = sectionText($, 'eligibility');
  return facts;
}

export interface InstructionFacts {
  /** "You may include up to 20% for indirect costs…", verbatim. */
  indirectCost?: string;
  /** "…projects that are not open source and open access are not eligible.", verbatim. */
  openAccessRule?: string;
  /** "You can apply for a grant at any time during the year. Four times a year, we review…" */
  reviewCadence?: string;
}

/** The first list item matching `re`, verbatim. */
function listItem($: cheerio.CheerioAPI, re: RegExp): string | undefined {
  const hit = $('li')
    .filter((_, el) => re.test($(el).text()))
    .first();
  const text = normalizeText(hit.text());
  return text === '' ? undefined : text;
}

export function parseInstructionsPage(html: string): InstructionFacts {
  const $ = cheerio.load(html);
  const facts: InstructionFacts = {};
  facts.indirectCost = listItem($, /indirect costs/i);
  facts.openAccessRule = listItem($, /open source and open access/i);
  const cadence = $('p')
    .filter((_, el) => /times a year, we review applications/i.test($(el).text()))
    .first();
  const cadenceText = normalizeText(cadence.text());
  if (cadenceText !== '') facts.reviewCadence = cadenceText;
  return facts;
}

/**
 * The one open ARDC opportunity, or undefined when the apply page did not come back. NOTHING IS
 * SYNTHESISED: no deadline text, no apply URL, no record at all is produced from a failed fetch —
 * an honestly empty source beats a fabricated opportunity, which is the whole lesson of the
 * hand-written fixture this leg replaces.
 */
export function buildApplyRecord(
  apply: FetchedPayload | undefined,
  instructions: FetchedPayload | undefined,
): RawOpportunity | undefined {
  if (apply === undefined) return undefined;
  const facts = parseApplyPage(apply.body);
  // Four dates or no record. The deadline is the single thing an applicant cannot act without, and
  // publishing this page with none of them would put ARDC's grants back in the corpus with the
  // `n_fixed_dates` RECUR directive projecting cycles that this capture never confirmed.
  if (facts.deadlineDates.length === 0 || facts.deadlineText === undefined) return undefined;
  const extra = instructions === undefined ? {} : parseInstructionsPage(instructions.body);

  // Every verbatim block, in one field the product actually publishes (`normalize/index.ts`'s
  // buildRawOtherText reads `rawFields.rawOtherText`). The open-access requirement and the 20%
  // indirect-cost cap have no field of their own in CONTRACT §3's Obligations that a source can
  // fill — `OBLIGATIONS_BY_SOURCE` is a table in normalize/, not a parsed value — so they travel
  // as the funder's own sentences rather than as an assertion of ours.
  const clean = (parts: Array<string | undefined>): string[] =>
    parts.filter((t): t is string => typeof t === 'string' && t !== '');

  /**
   * The funder's TERMS: when to apply, and what applies to the work once funded. These are the
   * sentences an eligibility axis should read, and they go in `rawText`.
   */
  const terms = clean([
    facts.deadlineText,
    extra.reviewCadence,
    facts.openAccess,
    extra.openAccessRule,
    extra.indirectCost,
  ]);

  /**
   * ...plus WHO MAY APPLY, which is published but deliberately kept OUT of `rawText`. ARDC's
   * eligibility is entity-shaped — 501(c)(3), school, university, or a club working through a
   * fiscal sponsor — and this pipeline models that structurally, in `ENTITIES_BY_SOURCE`, not as
   * free text. The axes that read `rawText` are the student-facing extractors, and MEASURED on
   * this exact capture, handing them an org grant's org-eligibility prose produced one wholly
   * invented HARD constraint: `axes/recommendation.ts` reads "unless they have a nonprofit fiscal
   * sponsor" as a demand for one letter of recommendation, which ARDC has never asked anybody for.
   * A funder's own sentence still reaches the reader — `buildRawOtherText` publishes every line
   * below — it just is not fed to extractors that cannot mean anything by it.
   */
  const evidence = [...terms, ...clean([facts.eligibility])];

  const rawFields: Record<string, string> = {
    deadline: facts.deadlineText,
    rawOtherText: evidence.join('\n'),
  };
  if (facts.summary !== undefined) rawFields.summary = facts.summary;
  if (facts.applyUrl !== undefined) rawFields.applyUrl = facts.applyUrl;
  if (facts.applyNote !== undefined) rawFields.applyNote = facts.applyNote;

  return {
    sourceId: SOURCE_ID,
    // Stable and independent of the CMS: the path ARDC's application has lived at throughout.
    externalKey: 'apply',
    name: facts.name ?? APPLY_URL,
    rawFields,
    sourceUrl: APPLY_URL,
    rawText: clean([facts.name, facts.summary, ...terms]).join('\n'),
  };
}

function parseJsonArray(json: string): WpPage[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as WpPage[]) : [];
  } catch {
    return [];
  }
}

/**
 * ARDC has NO grant custom-post-type (wp/v2/types returns post/page/attachment only) — grants
 * are hierarchical PAGES under /apply/grants/. The parent id must be resolved at runtime;
 * hardcoding it breaks the moment ARDC re-publishes the page. More than one page can carry
 * the slug "grants", so we match on the link path, not on the slug alone.
 */
export function resolveGrantsParentId(discoveryJson: string): number | undefined {
  for (const page of parseJsonArray(discoveryJson)) {
    if (typeof page.id !== 'number' || typeof page.link !== 'string') continue;
    if (new URL(page.link).pathname.replace(/\/$/, '') === '/apply/grants') return page.id;
  }
  return undefined;
}

export function buildChildrenRequest(parentId: number, sinceISO?: string): FetchRequest {
  const params = new URLSearchParams({
    parent: String(parentId),
    per_page: '100',
  });
  // modified_after is confirmed working on ardc.net and is the whole point of using the API.
  if (sinceISO) params.set('modified_after', sinceISO);
  // _fields is appended manually (not via URLSearchParams) so its commas stay literal instead
  // of being percent-encoded — WordPress's REST API only recognizes the literal comma form.
  const url = `${API}?${params.toString()}&_fields=${CHILD_FIELDS}`;
  return { url, method: 'GET', accept: 'json' };
}

export const ardcGrants: FollowUpSource = {
  id: SOURCE_ID,
  funderId: 'ardc',
  label: 'ARDC Grants Program (WordPress REST API)',
  tier: 'A',
  klass: 'ham_grant',
  requests: [{ url: DISCOVERY_URL, method: 'GET', accept: 'json' }],
  expectedMinRecords: 1,
  notes:
    'The only ham-relevant source in existence with a real, key-free API. ARDC has no grant ' +
    'custom-post-type (wp/v2/types = post/page/attachment only): grants are hierarchical ' +
    'PAGES under /apply/grants/, so the parent page id is resolved at runtime and never ' +
    'hardcoded. modified_after is the confirmed working incremental lever. WHAT THE API LEG ' +
    'ACTUALLY RETURNS, captured live 2026-08-03 (parent id 1271): EIGHT children, one per year ' +
    '2019-2026, every one of them an archive of grants already made — the funder’s own excerpt ' +
    'is the award table ("Information on 2025 Charitable Gifts can be found below. Date ' +
    'Grantee Project Amount…"). Not one is an application page, so every record that leg ' +
    'produces carries recordType past_award and is suppressed; ardc-award-tables mines ' +
    'the same eight URLs row by row. THE OPPORTUNITY IS ON A THIRD AND FOURTH PAGE, fetched ' +
    'since 2026-08-03 (HTTP 200 both): https://www.ardc.net/apply/ carries the application ' +
    'route (grants.ardc.net), the four deadlines ("The 2026 application deadlines are: ' +
    'February 1 April 1 July 1 September 1 + Scholarship Program Applications Due", verbatim, ' +
    'with ARDC’s own rollover "Applications received after September 1, 2026 will be reviewed ' +
    'February 1, 2027") and the Open Access Requirement ("all technology, documentation, and ' +
    'other materials produced using ARDC funds must be made freely available to the public"); ' +
    '/apply/grant-application-instructions/ carries the 20% indirect-cost cap ("You may include ' +
    'up to 20% for indirect costs") and "Four times a year, we review applications", which is ' +
    'what makes the four dates a recurrence rather than one published year. Neither page is a ' +
    'child of /apply/grants/, which is why the API leg alone left this funder publishing ' +
    'nothing at all. NO AMOUNT is parsed: "in 2026 we aim to fund approximately $3.8 million" ' +
    'is ARDC’s annual budget, not an award. ardc.net/feed/ carries news only and zero grant ' +
    'announcements — deliberately not a source.',

  /**
   * The children query, then the two apply pages.
   *
   * The apply pages need nothing from phase one — they are ordinary URLs — and they are listed
   * LAST and UNCONDITIONALLY on purpose. Unconditionally, because a WordPress API that stops
   * answering must not also take the one open opportunity off the board: `return []` on a failed
   * discovery would do exactly that, so the children request is the only thing that drops out.
   * Last, because the tools that replay committed fixtures (scripts/profile-corpus.ts,
   * normalize/rawFieldsContract.test.ts) pair `NN-` files to requests POSITIONALLY, so this order
   * is the order of fixtures/ardc-grants/ — and putting the new pages after the existing
   * `01-children.json` keeps that fixture's name, which crawl/runner.test.ts pins by hand.
   */
  followUp(payloads: FetchedPayload[], ctx?: FollowUpContext): FetchRequest[] {
    const requests: FetchRequest[] = [];
    const discovery = pickPayload(payloads, 'slug=grants');
    const parentId = discovery === undefined ? undefined : resolveGrantsParentId(discovery.body);
    if (parentId !== undefined) requests.push(buildChildrenRequest(parentId, ctx?.sinceISO));
    requests.push({ url: APPLY_URL, method: 'GET', accept: 'html' });
    requests.push({ url: INSTRUCTIONS_URL, method: 'GET', accept: 'html' });
    return requests;
  },

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    // Matched EXACTLY, not by substring: `/apply/grant-application-instructions/` contains
    // `/apply/`, so a substring match would hand the instructions page to the apply parser the
    // moment /apply/ itself failed to fetch — and that page carries no deadlines at all.
    const exact = (url: string): FetchedPayload | undefined =>
      payloads.find((p) => p.url === url && p.status >= 200 && p.status < 300);
    const applyRecord = buildApplyRecord(exact(APPLY_URL), exact(INSTRUCTIONS_URL));
    if (applyRecord) out.push(applyRecord);

    const children = payloads.find((p) => p.url.includes('parent=') && p.status === 200);
    if (!children) return out;
    for (const page of parseJsonArray(children.body)) {
      if (typeof page.id !== 'number' || typeof page.link !== 'string') continue;
      const name = flattenHtml(page.title?.rendered ?? '') || page.slug || String(page.id);
      const excerpt = flattenHtml(page.excerpt?.rendered ?? '');
      const recordType = pastAwardClassification(page, excerpt);
      const rawFields: Record<string, string> = {
        slug: page.slug ?? '',
        link: page.link,
        date: page.date ?? '',
        modified: page.modified ?? '',
        excerpt,
      };
      if (recordType !== undefined) {
        rawFields.recordType = recordType;
        // Without this the record keeps KIND_BY_SOURCE's `n_fixed_dates` and its RECUR directive,
        // and `expandCycles` projects application deadlines onto a page of finished grants — 13
        // future rows for "2025 Grants" alone, through Sep 2029. `dormant` is the kind
        // `ardc-award-tables` already gives the very same URLs.
        rawFields.deadlineKind = 'dormant';
      }
      out.push({
        sourceId: SOURCE_ID,
        externalKey: String(page.id),
        name,
        rawFields,
        sourceUrl: page.link,
        rawText: [name, excerpt].filter(Boolean).join('\n'),
      });
    }
    return out;
  },
};
