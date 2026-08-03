import * as cheerio from 'cheerio';
import { flattenHtml } from './text.js';

export interface RssItem {
  title: string;
  link: string;
  guid: string;
  description: string;
  pubDate: string;
}

/**
 * A conservative RSS 2.0 item reader. Guards on a top-level rss/feed/channel tag before
 * handing the body to cheerio's XML parser, so an HTML SPA shell served with a 200 status
 * (the Grants.gov failure mode; see registry.ts) parses to [] instead of silently succeeding
 * on whatever stray <item>-shaped markup a page happens to contain.
 */
export function parseRssItems(xml: string): RssItem[] {
  if (!/<\s*(rss|feed|channel)\b/i.test(xml)) return [];
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: RssItem[] = [];
  $('item').each((_, el) => {
    const $el = $(el);
    const title = flattenHtml($el.find('title').first().text());
    const link = $el.find('link').first().text().trim();
    const guid = $el.find('guid').first().text().trim() || link;
    const description = flattenHtml($el.find('description').first().text());
    const pubDate = $el.find('pubDate').first().text().trim();
    if (title === '' && link === '') return;
    items.push({ title, link, guid, description, pubDate });
  });
  return items;
}
