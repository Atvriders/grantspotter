import * as cheerio from 'cheerio';
import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { pickPayload } from './util/payload.js';
import { flattenHtml, normalizeText, splitByLabels } from './util/text.js';

const SOURCE_ID = 'arrl-scholarship-descriptions';
const URL = 'http://www.arrl.org/scholarship-descriptions';

/**
 * Canonical label -> alternates seen on the page. Whitespace typos ("R egion",
 * "License   Requirement") need no explicit alternate: looseLabelPattern already tolerates
 * stray/extra whitespace between and inside the letters of every alternate below. Typos that
 * DROP a letter ("Scholarshps") do need an explicit alternate, since no amount of whitespace
 * tolerance recovers a missing character. Order inside a key does not matter — the matcher in
 * util/text.ts sorts every alternate longest-first so "License Requirement" beats "License".
 *
 * EVERY bare single-word alternate below ("Amount:", "License:", "Region:", "Regions:",
 * "Institution:", "Institutions:", "Age:", "Other:") carries a trailing literal colon that the
 * multi-word phrase alternates do not. util/text.ts's buildLabelRegExp makes the colon after a
 * matched alternate OPTIONAL and matches at the start of any line (post-<br>/block-boundary),
 * not only after a real "Label:" — so a bare "Region", "Institution", "Age", "Other", "Amount"
 * or "License" would also match ordinary prose that merely starts a line with that common word,
 * e.g. "Age is not a factor...", "Region-specific rules...", "Institution transfer...", "Other
 * scholarships...", "Amount awarded may vary...", "License to practice is not required...".
 * (Fix round 1 corrected only Amount/License and rationalised leaving Region/Institution/Age/
 * Other colon-optional on the theory that "a single common word" was the risk and those four
 * were somehow different — they are not: they are ALSO single common words, and round 2 fixed
 * that inconsistency. There is no bare-word alternate left colon-optional in this table.)
 * Baking the colon into the alternate string itself (looseLabelPattern still tolerates
 * whitespace before it, so "Amount :" or "R egion:" both still match) makes it a REQUIRED part
 * of the match for every one of these single-word alternates, closing this off without widening
 * the shared, other-parsers-depend-on-it util/text.ts contract. The full-phrase alternates
 * ("Award Amount", "License Requirement", "Age Requirement", "Other Requirements", "Additional
 * Requirements") are left colon-optional: a two-plus-word phrase beginning a line is not a
 * credible prose opener the way a single common word is, and every label on this page has in
 * practice always carried a colon regardless.
 */
export const ARRL_SCHOLARSHIP_LABELS: Record<string, string[]> = {
  'Field of Study': ['Field of Study', 'Fields of Study', 'Field of Studies'],
  'License Requirement': ['License Requirement', 'License Requirements', 'License:'],
  // "Regional Preference:" (The Edmond A. Metzger Scholarship, live page) used to be a SILENT
  // false-positive match on the bare "Region" alternate before this file required a colon: old
  // code matched "Region" as a substring of "Regional" and captured "al Preference: Resident of
  // ARRL Central Division (IL, IN, WI)" as the Region value, garbage prefix and all. Requiring
  // the colon correctly stopped that substring match, which would otherwise have left this
  // entry's Region unrecovered — so it is listed here explicitly instead, recovering the clean
  // value ("Resident of ARRL Central Division (IL, IN, WI)") rather than leaving it dropped.
  Region: ['Region:', 'Regions:', 'Regional Preference:'],
  Institution: ['Institution:', 'Institutions:'],
  'Award Amount': ['Award Amount', 'Award Amounts', 'Amount:'],
  'Number of Awards': [
    'Number of Awards',
    'Number of Award',
    'Number of Scholarships',
    'Number of Scholarshps',
  ],
  Age: ['Age Requirement', 'Age:'],
  Other: ['Other Requirements', 'Additional Requirements', 'Other:'],
};

const FIELD_KEYS = Object.keys(ARRL_SCHOLARSHIP_LABELS);

/** The site-wide "Go Now" call-to-action always links here, in absolute or relative form. */
const APPLICATION_LINK_PATTERN = /scholarship-application/i;

/**
 * A real award figure ($1,000) or a recognisable date/year is corroborating evidence that an
 * li with zero recognised labels is a genuine scholarship whose labels were all typo'd beyond
 * what looseLabelPattern and the explicit alternates above can recover — not one of the site's
 * real stubs (an untitled li, an nbsp-only body, or the "Click on a scholarship below..."
 * boilerplate), none of which carry either.
 */
const DOLLAR_AMOUNT_RE = /\$[\d,]+(?:\.\d{2})?/;
const DATE_RE =
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\b(?:19|20)\d{2}\b/i;

export interface ScholarshipParseResult {
  entries: RawOpportunity[];
  stubCount: number;
  accordionCount: number;
}

/**
 * Entry boundaries come from the DOM (`div.tabArea.f-widget.f-accordion` -> `ul.accordion > li`).
 * Field values come from a label regex over the FLATTENED text of each li — never from DOM
 * shape. Body markup is inconsistent across the 111 entries: some are a flat
 * `<p>&bull; Label: value<br></p>`, some are `<ul><li><strong>Label:</strong> value</li></ul>`,
 * and some open a `<ul>` inside a `<p>`, which is invalid HTML that cheerio's parse5 backend
 * silently repairs. Keying a field off a `<strong>`, an `<li>` position or a bullet character
 * would break on at least one of those three shapes.
 */
export function parseScholarshipCatalog(html: string, sourceUrl: string): ScholarshipParseResult {
  const $ = cheerio.load(html);
  const entries: RawOpportunity[] = [];
  let stubCount = 0;
  let accordionCount = 0;

  $('div.tabArea.f-widget.f-accordion').each((_, accordion) => {
    const $accordion = $(accordion);
    const heading = normalizeText($accordion.find('h3.tab').first().text());
    // The fifth accordion on the live page is headed "EXPLORE ARRL" and is site chrome (nav
    // links like "Membership" and "ARRL Store"), not a scholarship range like "A - D".
    if (/explore\s*arrl/i.test(heading)) return;
    const items = $accordion.find('ul.accordion > li');
    if (items.length === 0) return;
    accordionCount += 1;

    items.each((__, li) => {
      const $li = $(li);
      const name = normalizeText($li.find('p.title').first().text());
      const $content = $li.find('div.content').first();
      // The "Go Now" call-to-action (visible text varies: "Go Now", "Go now", " Go Now") is
      // trailing site chrome that appears on ~80% of entries and has no closing label to stop
      // it, so a naive flatten appends "\nGo Now" to whichever field happens to be last. Key on
      // the href, not the visible text, so a future copy change ("Apply Now") cannot reopen
      // this: the CTA always links to /scholarship-application (absolute or relative).
      $content.find('a').each((___, a) => {
        const href = $(a).attr('href') ?? '';
        if (APPLICATION_LINK_PATTERN.test(href)) $(a).remove();
      });
      const bodyHtml = $content.html() ?? '';
      const rawText = flattenHtml(bodyHtml);
      const split = splitByLabels(rawText, ARRL_SCHOLARSHIP_LABELS);

      const rawFields: Record<string, string> = {};
      for (const key of FIELD_KEYS) {
        const value = split[key];
        if (value !== undefined && value !== '') rawFields[key] = value;
      }
      const preamble = split.__preamble;
      if (preamble !== undefined && preamble !== '') rawFields.__preamble = preamble;

      const recognisedFieldCount = FIELD_KEYS.filter((key) => rawFields[key] !== undefined).length;
      // 3 of the 114 li on the live page are stubs: an untitled li, an li whose body is
      // effectively empty (nbsp-only / "TBA"), and — observed only on the live page, not
      // reproducible from the brief's synthetic fixture alone — three "Scholarships" li's
      // whose entire body is the accordion boilerplate "Click on a scholarship below to expand
      // for more information." with no label at all. A body length threshold is not a reliable
      // signal (that boilerplate is 60 characters, comfortably "long"). What every one of the
      // 111 real entries has in common, per the live label-frequency count, is a recognised
      // "Field of Study" — in fact all eight labels appear zero times together only on stubs.
      //
      // But zero recognised labels can also mean every label on a genuine entry got typo'd
      // beyond what looseLabelPattern and the explicit alternates recover (this site's typo
      // history — "R egion", "License   Requirement", "Scholarshps" — is real and ongoing).
      // expectedMinRecords=100 leaves 11 records of slack before parse_yield_dropped fires, so a
      // single bad copy-edit silently deleting one scholarship would otherwise go unnoticed. A
      // dollar figure or a recognisable date in the body is corroborating evidence that this is
      // a real, if mangled, entry rather than one of the three known stub shapes (none of which
      // carry either) — so it overrides the stub verdict and the entry is kept with whatever
      // fields (possibly zero) were recovered. Every rejection is logged either way (console.debug,
      // not .warn — the crawl runner spies on console.warn for its own, unrelated deadline-
      // inheritance diagnostics, and the 3 stub rejections that fire on literally every parse of
      // the real page are routine, not alarms), so a genuine stub-shaped scholarship is at least
      // visible instead of silently gone.
      const hasCorroboratingEvidence = DOLLAR_AMOUNT_RE.test(rawText) || DATE_RE.test(rawText);
      const isStub = name === '' || (recognisedFieldCount === 0 && !hasCorroboratingEvidence);
      if (isStub) {
        stubCount += 1;
        const firstLine = rawText.split('\n')[0]?.slice(0, 80) ?? '';
        console.debug(
          `[${SOURCE_ID}] rejected as stub: name=${JSON.stringify(name)} firstLine=${JSON.stringify(firstLine)}`,
        );
        return;
      }

      entries.push({
        sourceId: SOURCE_ID,
        externalKey: name,
        name,
        rawFields,
        sourceUrl,
        rawText,
      });
    });
  });

  return { entries, stubCount, accordionCount };
}

export const arrlScholarshipDescriptions: SourceModule = {
  id: SOURCE_ID,
  funderId: 'arrl-foundation',
  label: 'ARRL Foundation Scholarship catalog',
  tier: 'C',
  klass: 'ham_scholarship',
  requests: [{ url: URL, method: 'GET', accept: 'html' }],
  expectedMinRecords: 100,
  notes:
    'Highest-yield source in the product: ~75% of the corpus. 114 li minus 3 stubs = 111 real ' +
    'entries across 4 accordions; a 5th "EXPLORE ARRL" accordion is chrome and is excluded. ' +
    'Parsed by label regex over flattened text because body markup is inconsistent, includes ' +
    'invalid HTML (<ul> inside <p>), \\xa0, and typos ("R egion", "License   Requirement", ' +
    '"Number of Scholarshps"). All 111 share ONE deadline, applied by normalize/ via deadline ' +
    'inheritance (not here). arrl.org sends Cache-Control: nocache with no ETag and no ' +
    'Last-Modified, and its sitemap <lastmod> is frozen at 2010 — change detection must hash ' +
    'parsed entries, never headers or raw HTML.',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const payload = pickPayload(payloads, '/scholarship-descriptions');
    if (!payload) return [];
    return parseScholarshipCatalog(payload.body, payload.url).entries;
  },
};
