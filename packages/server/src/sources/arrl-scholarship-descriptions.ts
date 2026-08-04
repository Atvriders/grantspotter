import * as cheerio from 'cheerio';
import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { pickPayload } from './util/payload.js';
import { flattenHtml, normalizeText, splitByLabels } from './util/text.js';

const SOURCE_ID = 'arrl-scholarship-descriptions';
/**
 * Renamed from `URL` on 2026-08-03. A module-level `const URL` SHADOWS the global URL
 * constructor for the whole file, so `new URL(href, sourceUrl)` in `absoluteApplyUrl` below
 * threw "URL is not a constructor" and the catch silently returned undefined — the apply href
 * was parsed, resolved to nothing, and every record fell back to the catalogue page again.
 */
const CATALOG_URL = 'http://www.arrl.org/scholarship-descriptions';

/**
 * Canonical label -> alternates seen on the page. Whitespace typos ("R egion",
 * "License   Requirement") need no explicit alternate: looseLabelPattern already tolerates
 * stray/extra whitespace between and inside the letters of every alternate below. Typos that
 * DROP a letter ("Scholarshps") do need an explicit alternate, since no amount of whitespace
 * tolerance recovers a missing character. Order inside a key does not matter — the matcher in
 * util/text.ts sorts every alternate longest-first so "License Requirement" beats "License".
 *
 * EVERY alternate below carries a trailing literal colon — not just the historically-bare
 * single words ("Amount:", "License:", "Region:", "Institution:", "Age:", "Other:", ...) but
 * also every multi-word phrase ("Award Amount:", "License Requirement:", "Field of Study:", ...).
 * util/text.ts's buildLabelRegExp makes the colon after a matched alternate OPTIONAL and matches
 * at the start of any line — fix rounds 1 and 2 baked a mandatory colon into the bare single-word
 * alternates for exactly that reason (a bare "Region" or "Other" would otherwise match ordinary
 * prose that merely starts a line with that common word, e.g. "Region-specific rules..." or
 * "Other scholarships..."), but left the multi-word phrases colon-optional on the reasoning that
 * a two-plus-word phrase isn't a credible prose opener.
 *
 * That reasoning was correct as a PROBABILITY judgement, but it left the table's safety resting
 * on "this collision looks unlikely today" rather than on anything checked. Requiring the colon
 * everywhere closes the whole class of PREFIX COLLISION by construction, not just the bare-word
 * subset of it: "License Requirement" is a literal string prefix of "License Requirements" (and
 * "Award Amount" of "Award Amounts", and "Number of Award" of "Number of Awards") — harmless
 * today only because util/text.ts's global longest-first alternate sort happens to always try
 * the longer one first, but with the colon appended to EVERY alternate, "License Requirement:"
 * is no longer a literal prefix of "License Requirements:" at all (they diverge at the colon vs.
 * "s"), so the two can never collide regardless of sort order or any future edit to this table.
 * `noAlternateIsAProperPrefixOfAnother()` below is the executable version of this invariant —
 * import it and run it (or read arrl-scholarship-descriptions.test.ts) to see it fail loudly
 * against a deliberately reintroduced collision.
 */
export const ARRL_SCHOLARSHIP_LABELS: Record<string, string[]> = {
  'Field of Study': ['Field of Study:', 'Fields of Study:', 'Field of Studies:'],
  'License Requirement': ['License Requirement:', 'License Requirements:', 'License:'],
  // "Regional Preference:" (The Edmond A. Metzger Scholarship, live page) used to be a SILENT
  // false-positive match on the bare "Region" alternate before fix round 2 required a colon: old
  // code matched "Region" as a substring of "Regional" and captured "al Preference: Resident of
  // ARRL Central Division (IL, IN, WI)" as the Region value, garbage prefix and all. Requiring
  // the colon correctly stopped that substring match, which would otherwise have left this
  // entry's Region unrecovered — so it is listed here explicitly instead, recovering the clean
  // value ("Resident of ARRL Central Division (IL, IN, WI)") rather than leaving it dropped.
  Region: ['Region:', 'Regions:', 'Regional Preference:'],
  Institution: ['Institution:', 'Institutions:'],
  'Award Amount': ['Award Amount:', 'Award Amounts:', 'Amount:'],
  'Number of Awards': [
    'Number of Awards:',
    'Number of Award:',
    'Number of Scholarships:',
    'Number of Scholarshps:',
  ],
  Age: ['Age Requirement:', 'Age:'],
  Other: ['Other Requirements:', 'Additional Requirements:', 'Other:'],
};

/**
 * Structural invariant: no alternate anywhere in the table (across every key — a cross-key
 * collision is exactly as dangerous as a same-key one, since util/text.ts builds ONE combined
 * regex over every alternate from every key) may be a proper prefix of another. If it were, the
 * shorter alternate could match at a position where the longer one was the correct, intended
 * label, truncating whichever field's value happened to precede the match and either polluting
 * an existing field (same-key) or fabricating/corrupting a different one entirely (cross-key) —
 * exactly the "Region" vs. "Regional Preference" defect class, just generalised to every pair
 * instead of trusted to "no instance of it happens to exist today".
 *
 * Returns every colliding pair so a failure is diagnosable, not just "false".
 */
export function findAlternatePrefixCollisions(
  labels: Record<string, string[]>,
): Array<{ shorter: string; longer: string }> {
  const all = Object.values(labels).flat();
  const collisions: Array<{ shorter: string; longer: string }> = [];
  for (const a of all) {
    for (const b of all) {
      if (a === b) continue;
      if (a.length < b.length && b.startsWith(a)) {
        collisions.push({ shorter: a, longer: b });
      }
    }
  }
  return collisions;
}

/**
 * THE INVARIANT THAT ACTUALLY BINDS. `findAlternatePrefixCollisions` above compares alternates to
 * each other, which is a closed question about this table; it says nothing about the OPEN one —
 * whether an alternate can match running prose on the funder's page.
 *
 * A reviewer proved the gap by adding one entry, `Recipient: ['Recipient']`, and the whole suite
 * stayed green while the real capture's YASME record grew a fabricated field cut mid-sentence:
 *
 *   "Recipient": "is to provide YASME a brief report of his/her Amateur Radio activities…"
 *
 * — sliced out of the middle of the funder's sentence "...the recipient is to provide YASME a
 * brief report...", with `Other` silently losing its tail. No pair of alternates collided; the
 * alternate collided with the PAGE. `util/text.ts` makes the colon optional after a matched
 * alternate and matches at the start of any line, so a bare word matches ordinary prose that
 * merely opens a line with it, and there is no prefix relation anywhere for the check above to
 * see. That is a CROSS-KEY, prose-collision defect, and it is unbounded: no list of alternate
 * pairs can rule it out, because the other half of the collision lives on arrl.org.
 *
 * Requiring the trailing colon closes it by construction. The page writes real labels as
 * "Other:", "Region:", "Award Amount:" — with the colon — and prose never opens a line with
 * "Recipient:". This is the property the table's own doc comment claims ("EVERY alternate below
 * carries a trailing literal colon"), which until now nothing checked: a claim in a comment is
 * not an invariant.
 *
 * Returns every offender so a failure names the entry to fix, not just "false".
 */
export function findAlternatesWithoutColon(labels: Record<string, string[]>): string[] {
  return Object.entries(labels)
    .flatMap(([key, alternates]) => alternates.map((alternate) => ({ key, alternate })))
    .filter(({ alternate }) => !alternate.endsWith(':'))
    .map(({ key, alternate }) => `${key}: ${JSON.stringify(alternate)}`);
}

/**
 * The site-wide "Go Now" call-to-action always links here, in absolute or relative form.
 *
 * IT IS THE APPLICATION URL, AND IT USED TO BE THROWN AWAY. The real capture carries
 * `href="http://www.arrl.org/scholarship-application"` 87 times and `href="/scholarship-application"`
 * 3 times — 89 of the 111 real entries carry one inside their own accordion body, and the 90th
 * occurrence is the sidebar callout "Scholarship Application … Complete your application now!".
 * The anchor's TEXT is chrome and is still removed (see the `each` below); its HREF is the one
 * thing on the page that says where to apply, and `normalize/index.ts` publishes it as
 * `Program.applyUrl` — the URL Plan 3 renders as the apply button. Discarding it left all 111
 * records pointing at the catalogue page a reader was already looking at.
 */
const APPLICATION_LINK_PATTERN = /scholarship-application/i;

/**
 * The href resolved against the page it was found on, so a relative `/scholarship-application`
 * becomes the same absolute URL as the 87 anchors that spell it out. Returns undefined rather
 * than a half-formed URL if either side is unparseable — an apply button that 404s is worse than
 * a fallback to the catalogue.
 */
function absoluteApplyUrl(href: string, sourceUrl: string): string | undefined {
  try {
    return new URL(href, sourceUrl).toString();
  } catch {
    return undefined;
  }
}

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
export function parseScholarshipCatalog(
  html: string,
  sourceUrl: string,
  // A SEAM, not a knob: the shipped table is the default and every caller uses it. It exists so
  // the label invariants can be proven against the REAL capture — parsing this page with a
  // deliberately broken table and asserting the damage — without mutating the exported constant
  // that the rest of the process shares.
  labels: Record<string, string[]> = ARRL_SCHOLARSHIP_LABELS,
): ScholarshipParseResult {
  const fieldKeys = Object.keys(labels);
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
      let applyUrl: string | undefined;
      $content.find('a').each((___, a) => {
        const href = $(a).attr('href') ?? '';
        if (!APPLICATION_LINK_PATTERN.test(href)) return;
        applyUrl ??= absoluteApplyUrl(href, sourceUrl);
        $(a).remove();
      });
      const bodyHtml = $content.html() ?? '';
      const rawText = flattenHtml(bodyHtml);
      const split = splitByLabels(rawText, labels);

      const rawFields: Record<string, string> = {};
      for (const key of fieldKeys) {
        const value = split[key];
        if (value !== undefined && value !== '') rawFields[key] = value;
      }
      const preamble = split.__preamble;
      if (preamble !== undefined && preamble !== '') rawFields.__preamble = preamble;
      // Written by name, never through the computed subscript above, so that
      // rawFieldsContract.test.ts's scanner can see it — a key written through a subscript is
      // invisible to the written-but-never-read invariant, which is exactly how QCWA's own
      // parsed applyUrl went unread for a whole plan.
      if (applyUrl !== undefined) rawFields.applyUrl = applyUrl;

      const recognisedFieldCount = fieldKeys.filter((key) => rawFields[key] !== undefined).length;
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
  requests: [{ url: CATALOG_URL, method: 'GET', accept: 'html' }],
  expectedMinRecords: 100,
  notes:
    'Highest-yield source in the product: ~75% of the corpus. 114 li minus 3 stubs = 111 real ' +
    'entries across 4 accordions; a 5th "EXPLORE ARRL" accordion is chrome and is excluded. ' +
    'Parsed by label regex over flattened text because body markup is inconsistent, includes ' +
    'invalid HTML (<ul> inside <p>), \\xa0, and typos ("R egion", "License   Requirement", ' +
    '"Number of Scholarshps"). The "Go Now" CTA beside 89 of the 111 entries links to ' +
    'http://www.arrl.org/scholarship-application: its TEXT is chrome and is stripped, its HREF ' +
    'is the application URL and is kept as rawFields.applyUrl. The other 22 entries state no ' +
    'route of their own and keep the catalogue URL rather than borrowing the sidebar’s. ' +
    'All 111 share ONE deadline, applied by normalize/ via deadline ' +
    'inheritance (not here). arrl.org sends Cache-Control: nocache with no ETag and no ' +
    'Last-Modified, and its sitemap <lastmod> is frozen at 2010 — change detection must hash ' +
    'parsed entries, never headers or raw HTML.',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const payload = pickPayload(payloads, '/scholarship-descriptions');
    if (!payload) return [];
    return parseScholarshipCatalog(payload.body, payload.url).entries;
  },
};
