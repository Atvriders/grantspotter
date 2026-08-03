import type { FetchedPayload } from '@grantspotter/core';

export function pickPayload(
  payloads: FetchedPayload[],
  urlPart: string,
): FetchedPayload | undefined {
  return payloads.find((p) => p.url.includes(urlPart) && p.status >= 200 && p.status < 300);
}

export function requirePayload(payloads: FetchedPayload[], urlPart: string): FetchedPayload {
  const found = pickPayload(payloads, urlPart);
  if (!found) throw new Error(`no successful payload matching "${urlPart}"`);
  return found;
}
