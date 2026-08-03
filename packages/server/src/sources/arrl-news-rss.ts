import type { FetchedPayload, RawOpportunity } from '@grantspotter/core';
import type { SignalSource } from './types.js';
import { parseRssItems } from './util/rss.js';

const SOURCE_ID = 'arrl-news-rss';
const FEED = 'http://www.arrl.org/news/rss';

export const GRANT_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\bgrants?\b/i,
  /\bscholarships?\b/i,
  /\bdeadlines?\b/i,
  /\bfunding\b/i,
  /\bapplications?\s+(?:open|close|due|period|window)\b/i,
  /\bawards?\s+(?:announced|recipients)\b/i,
  /\bARDC\b/,
  /\bYasme\b/i,
  /\bTeachers Institute\b/i,
];

export function isGrantRelevantText(text: string): boolean {
  return GRANT_SIGNAL_PATTERNS.some((re) => re.test(text));
}

export const arrlNewsRss: SignalSource = {
  id: SOURCE_ID,
  funderId: 'arrl',
  label: 'ARRL news RSS (change signal)',
  tier: 'B',
  klass: 'ham_grant',
  signalOnly: true,
  requests: [{ url: FEED, method: 'GET', accept: 'xml' }],
  expectedMinRecords: 5,
  notes:
    'The single most important change signal in the ham space: ~10-20 actionable deadline ' +
    'events a year, and the only practical way to hear Yasme Foundation announcements, ' +
    'because yasme.org 301s /feed/ and /wp-json/ to a 403 page for non-browser clients and we ' +
    'do not spoof a browser to defeat a deliberate access policy. Carries ZERO structured ' +
    'opportunities, so it is signalOnly: the runner emits ChangeEvents for a human and never ' +
    'a candidate Program. parse() returns EVERY item so expectedMinRecords catches a broken ' +
    'feed; relevance filtering happens afterwards via isRelevant.',
  isRelevant(raw: RawOpportunity): boolean {
    return isGrantRelevantText(`${raw.name}\n${raw.rawText}`);
  },
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const payload = payloads.find((p) => p.url.includes('/news/rss') && p.status === 200);
    if (!payload) return [];
    return parseRssItems(payload.body).map((item) => ({
      sourceId: SOURCE_ID,
      externalKey: item.guid,
      name: item.title,
      rawFields: { link: item.link, pubDate: item.pubDate, description: item.description },
      sourceUrl: item.link || FEED,
      rawText: [item.title, item.description].filter(Boolean).join('\n'),
    }));
  },
};
