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
 */
export const ARRL_SCHOLARSHIP_LABELS: Record<string, string[]> = {
  'Field of Study': ['Field of Study', 'Fields of Study', 'Field of Studies'],
  'License Requirement': ['License Requirement', 'License Requirements', 'License'],
  Region: ['Region', 'Regions'],
  Institution: ['Institution', 'Institutions'],
  'Award Amount': ['Award Amount', 'Award Amounts', 'Amount'],
  'Number of Awards': [
    'Number of Awards',
    'Number of Award',
    'Number of Scholarships',
    'Number of Scholarshps',
  ],
  Age: ['Age Requirement', 'Age'],
  Other: ['Other Requirements', 'Additional Requirements', 'Other'],
};

const FIELD_KEYS = Object.keys(ARRL_SCHOLARSHIP_LABELS);

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
      const bodyHtml = $li.find('div.content').first().html() ?? '';
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
      // Zero recognised fields is therefore both necessary and sufficient for "stub" here.
      const isStub = name === '' || recognisedFieldCount === 0;
      if (isStub) {
        stubCount += 1;
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
