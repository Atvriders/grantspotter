import * as cheerio from 'cheerio';
import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { parseDateRange } from './util/dates.js';
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
 * The window dates exist ONLY in the title of the dated fillable PDF — never in the page body.
 * Read them from the anchor text first, then from the filename, using the /{YYYY}/{MM}/ upload
 * path as the fallback year. We deliberately never download or parse the PDF binary.
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

export const yaesuDr2x: SourceModule = {
  id: SOURCE_ID,
  funderId: 'yaesu-usa',
  label: 'Yaesu System Fusion DR-2X Repeater Program',
  tier: 'C',
  klass: 'equipment_in_kind',
  requests: [{ url: LANDING, method: 'GET', accept: 'html' }],
  expectedMinRecords: 1,
  notes:
    'A DISCOUNTED PURCHASE, NOT A GRANT: $1,450 for the DR-2X, $1,860 with the LAN-01A. Open to ' +
    'clubs, groups, organizations or individuals in North America; collegiate clubs qualify. ' +
    'Ad-hoc windows, roughly 2-4 a year. The window dates exist ONLY in the PDF title line of a ' +
    'dated fillable form under /wp-content/uploads/{YYYY}/{MM}/ — they appear nowhere in the ' +
    'page body — so we read them from the anchor text and filename and never download the PDF ' +
    'binary. The repeater must stay on the air for 12 months (sustainmentObligation).',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const payload = payloads.find((p) => p.url.includes('systemfusion.yaesu.com') && p.status === 200);
    if (!payload) return [];
    const flat = flattenHtml(payload.body);
    const links = findDr2xPdfLinks(payload.body, payload.url);

    for (const link of links) {
      const range = windowFromPdfLink(link);
      if (!range?.opensAt || !range.closesAt) continue;
      const rawFields: Record<string, string> = {
        opensAt: range.opensAt,
        closesAt: range.closesAt,
        formUrl: link.href,
        formTitle: link.text,
      };
      // `[^.\n]*` on the LEADING side only: it must not cross a newline INTO the sentence (that
      // was the bug — the prefix used to run backwards past the block boundary into the <h1> and
      // then, because the trailing `\$1,[0-9]{3}` anchor is free to land on either dollar figure,
      // it was non-deterministic which one anchored the match). The trailing side stays newline-
      // permissive on purpose, same as `sustainment` below, because a pricing sentence can itself
      // wrap across a soft line break the way "must remain\non the air" does.
      const pricing = /([^.\n]*\$1,[0-9]{3}[^.]*\.)/.exec(flat)?.[1]?.trim();
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
