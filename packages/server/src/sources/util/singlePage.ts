import type {
  FetchedPayload,
  OpportunityClass,
  RawOpportunity,
  SourceModule,
  SourceTier,
} from '@grantspotter/core';
import { pickPayload } from './payload.js';
import { flattenHtml } from './text.js';

export interface SinglePageConfig {
  id: string;
  funderId: string;
  label: string;
  tier: SourceTier;
  klass: OpportunityClass;
  url: string;
  name: string;
  externalKey: string;
  /** rawFields key -> pattern run over the flattened page text. Group 1 wins, else group 0. */
  fieldPatterns: Record<string, RegExp>;
  /** If any of these keys fails to match, parse() returns [] so the yield alarm fires. */
  requiredFields: string[];
  expectedMinRecords: number;
  notes?: string;
  /** Optional extra records mined from the same page (e.g. the Club Grant recipient list). */
  extraParse?: (flatText: string, html: string, sourceUrl: string) => RawOpportunity[];
}

/**
 * Most Tier C ham funders publish exactly one opportunity on one prose page, and the useful
 * facts are sentences rather than markup. This turns a config into a SourceModule that runs
 * label-free regexes over the FLATTENED page text — the same discipline as the ARRL catalog
 * parser, for the same reason: these pages are hand-edited and their markup is not stable.
 */
export function makeSinglePageSource(cfg: SinglePageConfig): SourceModule {
  const pathPart = new URL(cfg.url).pathname;
  return {
    id: cfg.id,
    funderId: cfg.funderId,
    label: cfg.label,
    tier: cfg.tier,
    klass: cfg.klass,
    requests: [{ url: cfg.url, method: 'GET', accept: 'html' }],
    expectedMinRecords: cfg.expectedMinRecords,
    notes: cfg.notes,
    parse(payloads: FetchedPayload[]): RawOpportunity[] {
      const payload = pickPayload(payloads, pathPart);
      if (!payload) return [];
      const flat = flattenHtml(payload.body);
      // fieldPatterns lean on `[^.]*?` specifically so a capture never crosses INTO the next
      // sentence. A run of two or more literal periods is an in-sentence ellipsis (an elision),
      // not a sentence boundary, and is otherwise indistinguishable from one to that character
      // class — a required field would silently fail to match prose the page-editor happened to
      // abbreviate with "...". Collapsed only for matching; `flat`/rawText stay verbatim.
      const matchText = flat.replace(/\.{2,}/g, ' ');

      const rawFields: Record<string, string> = {};
      for (const [key, pattern] of Object.entries(cfg.fieldPatterns)) {
        const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
        // Text first — that is where prose sentences live. A pattern that finds nothing there
        // (e.g. a Jotform id, which lives only in an <a href> attribute that flattenHtml
        // deliberately strips as markup, not content) falls back to the raw HTML.
        const m = re.exec(matchText) ?? re.exec(payload.body);
        if (!m) continue;
        const value = (m[1] ?? m[0]).replace(/\s+/g, ' ').trim();
        if (value !== '') rawFields[key] = value;
      }

      const missing = cfg.requiredFields.filter((k) => rawFields[k] === undefined);
      const main: RawOpportunity[] =
        missing.length > 0
          ? []
          : [
              {
                sourceId: cfg.id,
                externalKey: cfg.externalKey,
                name: cfg.name,
                rawFields,
                sourceUrl: payload.url,
                rawText: flat,
              },
            ];

      const extra = cfg.extraParse ? cfg.extraParse(flat, payload.body, payload.url) : [];
      return [...main, ...extra];
    },
  };
}
