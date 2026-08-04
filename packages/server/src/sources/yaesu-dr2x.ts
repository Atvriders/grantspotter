import * as cheerio from 'cheerio';
import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { parseDateRange, parseUsDate } from './util/dates.js';
import { flattenHtml } from './util/text.js';

const SOURCE_ID = 'yaesu-dr2x';
const LANDING = 'https://systemfusion.yaesu.com/';
const UPLOAD_PATH = /\/wp-content\/uploads\/(\d{4})\/(\d{2})\//;
const PROGRAM_PDF = /(dr-?2x|repeater[-\s]?program)/i;

export interface Dr2xLink {
  href: string;
  text: string;
  uploadYear?: number;
  uploadMonth?: number;
}

export function findDr2xPdfLinks(html: string, baseUrl: string): Dr2xLink[] {
  const $ = cheerio.load(html);
  const links: Dr2xLink[] = [];
  $('a[href]').each((_, a) => {
    const raw = $(a).attr('href');
    if (!raw || !/\.pdf(?:$|\?)/i.test(raw)) return;
    const href = new URL(raw, baseUrl).toString();
    const path = new URL(href).pathname;
    if (!UPLOAD_PATH.test(path)) return;
    const text = $(a).text().replace(/\s+/g, ' ').trim();
    if (!PROGRAM_PDF.test(`${path} ${text}`)) return;
    const m = UPLOAD_PATH.exec(path);
    links.push({
      href,
      text,
      uploadYear: m ? Number.parseInt(m[1], 10) : undefined,
      uploadMonth: m ? Number.parseInt(m[2], 10) : undefined,
    });
  });
  return links.sort(
    (a, b) =>
      (b.uploadYear ?? 0) - (a.uploadYear ?? 0) || (b.uploadMonth ?? 0) - (a.uploadMonth ?? 0),
  );
}

/**
 * Day-precision window from the dated fillable PDF's title: the anchor text first, then the
 * filename, using the /{YYYY}/{MM}/ upload path as the fallback year. We deliberately never
 * download or parse the PDF binary.
 *
 * This is no longer sufficient on its own. The live form (captured 2026-08-03) is
 * `DR-2X_Jun-thru-Aug_2026-FILLABLE.pdf` behind the anchor text "DR-2X REPEATER APPLICATION":
 * MONTH-granular, no day numbers on either end, so there is no day-precision window to read out
 * of it at all. See `closeDateFromBody` for where the real date now comes from.
 */
export function windowFromPdfLink(
  link: Dr2xLink,
): { opensAt?: string; closesAt?: string } | undefined {
  const filename = decodeURIComponent(new URL(link.href).pathname.split('/').pop() ?? '')
    .replace(/\.pdf$/i, '')
    .replace(/[-_]+/g, ' ');
  for (const candidate of [link.text, filename]) {
    const range = parseDateRange(candidate, link.uploadYear);
    if (range?.opensAt && range.closesAt) return range;
  }
  return undefined;
}

/** "August 31st, 2026" — ordinal suffixes are not something parseUsDate is asked to know about. */
const CLOSE_SENTENCE =
  /\b(?:through|thru|until|ends?\s+on|closes?\s+on)\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/i;

/**
 * The close date as the LANDING PAGE ITSELF states it.
 *
 * The module used to assert that the window "exists ONLY in the PDF title line … never in the
 * page body". The live page falsifies that: it says, in an <h4> above the application button,
 * "Yaesu USA is please to offer this DR-2X Program offering to our loyal customers once again
 * through August 31st, 2026." That sentence is the only day-precision date anywhere on the page
 * now that the form filename has gone month-granular, and it is the more authoritative of the
 * two anyway — it is prose Yaesu maintains, not a filename.
 *
 * Only a CLOSE date is available this way; the page states no opening date. We do not invent
 * one from the "Jun" in the filename or from the /2026/06/ upload path, because month
 * granularity is not day granularity and a guessed opensAt is exactly the kind of fabricated
 * date this corpus refuses to publish.
 */
export function closeDateFromBody(flatText: string): string | undefined {
  const m = CLOSE_SENTENCE.exec(flatText);
  if (!m) return undefined;
  return parseUsDate(m[1].replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, '$1'));
}

export const yaesuDr2x: SourceModule = {
  id: SOURCE_ID,
  funderId: 'yaesu-usa',
  label: 'Yaesu System Fusion DR-2X Repeater Program',
  tier: 'C',
  klass: 'equipment_in_kind',
  requests: [{ url: LANDING, method: 'GET', accept: 'html' }],
  expectedMinRecords: 1,
  notes:
    'A DISCOUNTED PURCHASE, NOT A GRANT: the live page states two prices verbatim, confirmed ' +
    '2026-08-03, cents and all — "The new program price is either $1,450.00 or $1,860.00." — ' +
    'but never says what distinguishes them. The "$1,860 = with the LAN-01A accessory" pairing ' +
    'that circulated in earlier notes and in docs/research is UNCONFIRMED: "LAN-01A" and ' +
    '"network module" appear zero times on the page. ELIGIBILITY: the page states none either — ' +
    '"North America", "individual" and "organization" each appear zero times, so no audience or ' +
    'geography claim is asserted here (the earlier "clubs, groups, organizations or individuals ' +
    'in North America" line was never on the live page; collegiate clubs are not excluded by ' +
    'anything it states, but nothing on it names them). Ad-hoc windows, roughly 2-4 a year. WINDOW: the ' +
    'earlier claim that the dates exist ONLY in the PDF title and "appear nowhere in the page ' +
    'body" is FALSE against the live page, which states the close date in prose above the ' +
    'application button ("…once again through August 31st, 2026") while the current form ' +
    'filename, DR-2X_Jun-thru-Aug_2026-FILLABLE.pdf, is month-granular and yields no ' +
    'day-precision window at all. We read a day-precise range from the PDF title when there is ' +
    'one and otherwise take the close date from the page prose, recording which in ' +
    'rawFields.windowSource. No opening date is inferred from a month name. We still never ' +
    'download the PDF binary. SUSTAINMENT: the 12-month on-air obligation is NOT stated ' +
    'anywhere on the landing page — it lives in the application PDF we deliberately do not ' +
    'fetch — so sustainmentObligation is absent from the live record rather than asserted.',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const payload = payloads.find((p) => p.url.includes('systemfusion.yaesu.com') && p.status === 200);
    if (!payload) return [];
    const flat = flattenHtml(payload.body);
    const links = findDr2xPdfLinks(payload.body, payload.url);
    const bodyCloses = closeDateFromBody(flat);

    for (const link of links) {
      const range = windowFromPdfLink(link);
      // A close date is what makes this record actionable; an open date is a nicety. Requiring
      // BOTH is what made this source yield nothing from its own live page, whose form filename
      // ("Jun thru Aug 2026") carries no day numbers. Prefer the PDF title when it is fully
      // day-precise, and fall back to the date the page states in prose.
      const closesAt = range?.closesAt ?? bodyCloses;
      if (!closesAt) continue;
      const rawFields: Record<string, string> = {
        closesAt,
        // Provenance, because these two are not equally trustworthy and a reviewer should be
        // able to tell at a glance which one a given date came from.
        windowSource: range?.closesAt ? 'pdf_title' : 'page_body',
        formUrl: link.href,
        formTitle: link.text,
      };
      if (range?.opensAt) rawFields.opensAt = range.opensAt;
      // `[^.\n]*` on the LEADING side only: it must not cross a newline INTO the sentence (that
      // was the bug — the prefix used to run backwards past the block boundary into the <h1> and
      // then, because the trailing `\$1,[0-9]{3}` anchor is free to land on either dollar figure,
      // it was non-deterministic which one anchored the match). The trailing side stays newline-
      // permissive on purpose, same as `sustainment` below, because a pricing sentence can itself
      // wrap across a soft line break the way "must remain\non the air" does.
      //
      // `\.(?=\d)` on the trailing side: the live page writes the prices with cents — "The new
      // program price is either $1,450.00 or $1,860.00." — and a plain `[^.]*` treats the cents
      // separator as the end of the sentence. That truncated the capture to "…either $1,450.",
      // which dropped the $1,860 option entirely and collapsed the published range to a flat
      // $1,450. A period immediately followed by a digit is a decimal point, not a full stop.
      const pricing = /([^.\n]*\$1,[0-9]{3}(?:[^.]|\.(?=\d))*\.)/.exec(flat)?.[1]?.trim();
      if (pricing) {
        rawFields.pricing = pricing;
        // This is a DISCOUNTED PURCHASE with two option prices ($1,450 alone, $1,860 with the
        // LAN-01A), not a single award figure — feeding the raw prose straight to the shared
        // `parseAmount` heuristic is what collapsed the range to a single `amountMin: 1860`
        // (the accessory-inclusive ceiling standing in for the floor). Extract every dollar
        // figure actually present in the pricing sentence and hand the shared parser an
        // unambiguous bare range expression ("$1,450 to $1,860.") instead of prose it has to
        // guess about.
        const figures = [...new Set(pricing.match(/\$\d{1,3}(?:,\d{3})*/g) ?? [])]
          .map((text) => ({ text, value: Number(text.replace(/[$,]/g, '')) }))
          .sort((a, b) => a.value - b.value);
        if (figures.length > 0) {
          const min = figures[0];
          const max = figures[figures.length - 1];
          rawFields.amount = min.text === max.text ? `${min.text}.` : `${min.text} to ${max.text}.`;
        }
      }
      const sustainment = /([^.]*(?:twelve months|12 months)[^.]*\.)/i.exec(flat)?.[1]?.trim();
      if (sustainment) rawFields.sustainment = sustainment;

      return [
        {
          sourceId: SOURCE_ID,
          externalKey: 'yaesu-dr2x-repeater-program',
          name: 'Yaesu System Fusion DR-2X Repeater Program',
          rawFields,
          sourceUrl: payload.url,
          rawText: flat,
        },
      ];
    }
    return [];
  },
};
