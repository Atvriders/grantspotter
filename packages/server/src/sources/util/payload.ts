import type { FetchedPayload } from '@grantspotter/core';

/**
 * Did this payload carry the resource we asked for? 2xx, and nothing else.
 *
 * THE ONE DEFINITION OF "WE GOT THE PAGE", and it exists as a named export because the two halves
 * of the crawl used to disagree about it. `pickPayload` has always skipped anything outside
 * 200-299, so a 403 reached a parser as "no page here" and the parser correctly returned nothing;
 * `crawl/runner.ts` then called `recordPollSuccess` because a `FetchedPayload` had come back at
 * all. The result was `students.ieee.org refused us` stored as a successful poll with zero records
 * and drawn on the Sources screen as `yield_dropped` — "your parser stopped working" — for a site
 * that had simply said no. One exported predicate, imported by both, is what stops the two sides
 * from drifting apart again; see `PageNotReadError` in `crawl/runner.ts` for the other half.
 *
 * A 3xx is outside the range on purpose. The fetcher hands the redirect itself back as the payload
 * when a chain runs out of hops or of its request purse, and a `Location` header is not the page:
 * we never arrived, which is a different fact from arriving somewhere empty.
 *
 * NOT ABOUT robots.txt, AND THE DIFFERENCE IS THE WHOLE POINT. `fetcher/robots.ts` reads a 4xx on
 * `/robots.txt` as "this site publishes no rules", which RFC 9309 §2.3.1.3 makes permission rather
 * than refusal. That path must keep answering the opposite way from this one, and
 * `crawl/runner.test.ts` asserts both in the same test so a later tidy-up cannot merge them.
 */
export function isReadablePayload(p: FetchedPayload): boolean {
  return p.status >= 200 && p.status < 300;
}

export function pickPayload(
  payloads: FetchedPayload[],
  urlPart: string,
): FetchedPayload | undefined {
  return payloads.find((p) => p.url.includes(urlPart) && isReadablePayload(p));
}

export function requirePayload(payloads: FetchedPayload[], urlPart: string): FetchedPayload {
  const found = pickPayload(payloads, urlPart);
  if (!found) throw new Error(`no successful payload matching "${urlPart}"`);
  return found;
}
