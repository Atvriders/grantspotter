import * as cheerio from 'cheerio';

const BLOCK_SELECTORS = [
  'p',
  'div',
  'li',
  'tr',
  'table',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'section',
  'article',
  'blockquote',
  'dt',
  'dd',
];

/** Collapse whitespace, kill \xa0, trim every line, drop blank lines. */
export function normalizeText(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * HTML -> line-per-block plain text. cheerio parses with parse5, which repairs the invalid
 * markup this corpus is full of (notably a <ul> opened inside a <p> on arrl.org).
 */
export function flattenHtml(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  $('br').replaceWith('\n');
  for (const selector of BLOCK_SELECTORS) {
    $(selector).each((_, el) => {
      $(el).prepend('\n').append('\n');
    });
  }
  return normalizeText($.root().text());
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A label pattern that tolerates stray whitespace anywhere inside a word and runs of
 * whitespace between words. Handles the typos observed on arrl.org: "R egion" and
 * "License   Requirement". Typos that drop a letter ("Scholarshp") are listed as explicit
 * alternates by the caller instead.
 */
export function looseLabelPattern(label: string): string {
  return label
    .split('')
    .map((ch) => (ch === ' ' ? '\\s+' : escapeRegExp(ch)))
    .join('\\s*');
}

/** Alternates sorted longest-first so "License Requirement" wins over "License". */
function sortedAlternates(alternatesByKey: Record<string, string[]>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, alternates] of Object.entries(alternatesByKey)) {
    for (const alternate of alternates) pairs.push([key, alternate]);
  }
  return pairs.sort((a, b) => b[1].length - a[1].length);
}

/**
 * One global regex matching any label at the start of a line, optionally preceded by a bullet
 * and optionally followed by "(s)" and a colon. Group 1 is the canonical key index.
 */
export function buildLabelRegExp(alternatesByKey: Record<string, string[]>): RegExp {
  const pairs = sortedAlternates(alternatesByKey);
  const body = pairs.map(([, alternate]) => `(${looseLabelPattern(alternate)})`).join('|');
  return new RegExp(`(?:^|\\n)[ \\t]*[\\u2022\\u00b7*\\-\\u2013]?[ \\t]*(?:${body})\\s*:?[ \\t]*`, 'gi');
}

/**
 * Split flattened text into { canonicalLabel: verbatimValue }. Text before the first label is
 * returned under the reserved key `__preamble`. Values keep their internal newlines verbatim.
 */
export function splitByLabels(
  flatText: string,
  alternatesByKey: Record<string, string[]>,
): Record<string, string> {
  if (flatText.trim() === '') return {};
  const pairs = sortedAlternates(alternatesByKey);
  const re = buildLabelRegExp(alternatesByKey);
  const hits: Array<{ key: string; start: number; valueStart: number }> = [];

  for (let m = re.exec(flatText); m !== null; m = re.exec(flatText)) {
    const groupIndex = m.slice(1).findIndex((g) => g !== undefined);
    if (groupIndex === -1) continue;
    hits.push({ key: pairs[groupIndex][0], start: m.index, valueStart: m.index + m[0].length });
  }

  const out: Record<string, string> = {};
  const preamble = (hits.length === 0 ? flatText : flatText.slice(0, hits[0].start)).trim();
  if (preamble !== '') out.__preamble = preamble;

  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : flatText.length;
    const value = flatText.slice(hit.valueStart, end).trim();
    // First occurrence wins; a repeated label is appended so nothing is silently dropped.
    out[hit.key] = out[hit.key] === undefined ? value : `${out[hit.key]}\n${value}`;
  });
  return out;
}

export function firstMatch(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  return (m[1] ?? m[0]).trim() || undefined;
}
