/**
 * Capture a committed fixture for one source, THROUGH THE FETCHER, so the blocklist,
 * robots.txt handling and per-host crawl delay all apply exactly as they do in production.
 *
 *   npm run capture-fixture -- <sourceId>
 *
 * Writes fixtures/<sourceId>/NN-<slug>.<ext>. Review the diff before committing: refreshing a
 * fixture is a deliberate, reviewable act, never a silent drift. This script is never run by
 * CI and never run by a test.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { buildUserAgent } from '../packages/server/src/config.js';
import { createFetcher } from '../packages/server/src/fetcher/index.js';
import { getSource } from '../packages/server/src/sources/registry.js';
import { hasFollowUp, resolveRequests } from '../packages/server/src/sources/types.js';
import { slugId } from '../packages/server/src/sources/util/ids.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT: Record<FetchRequest['accept'], string> = {
  html: 'html',
  json: 'json',
  xml: 'xml',
  binary: 'bin',
};

function nameFor(index: number, req: FetchRequest): string {
  const u = new URL(req.url);
  const stem = slugId(`${u.hostname}${u.pathname}${u.search}`) || 'index';
  return `${String(index).padStart(2, '0')}-${stem}.${EXT[req.accept]}`;
}

async function main(): Promise<void> {
  const sourceId = process.argv[2];
  if (!sourceId) {
    console.error('usage: npm run capture-fixture -- <sourceId>');
    process.exitCode = 2;
    return;
  }
  const contactUrl = process.env.CONTACT_URL;
  if (!contactUrl) {
    console.error('CONTACT_URL must be set — it goes in the crawler User-Agent.');
    process.exitCode = 2;
    return;
  }

  const source = getSource(sourceId);
  const fetcher = createFetcher({ userAgent: buildUserAgent(contactUrl), contactUrl });
  const outDir = path.join(REPO_ROOT, 'fixtures', source.id);
  await mkdir(outDir, { recursive: true });

  const requests = await resolveRequests(source);
  const payloads: FetchedPayload[] = [];
  let index = 0;

  for (const req of requests) {
    const payload = await fetcher.fetch(req);
    payloads.push(payload);
    const file = path.join(outDir, nameFor(index, req));
    await writeFile(file, payload.body, 'utf8');
    console.log(`${payload.status}  ${req.url}\n      -> ${path.relative(REPO_ROOT, file)}`);
    index += 1;
  }

  if (hasFollowUp(source)) {
    for (const req of source.followUp(payloads)) {
      const payload = await fetcher.fetch(req);
      payloads.push(payload);
      const file = path.join(outDir, nameFor(index, req));
      await writeFile(file, payload.body, 'utf8');
      console.log(`${payload.status}  ${req.url}  (follow-up)\n      -> ${path.relative(REPO_ROOT, file)}`);
      index += 1;
    }
  }

  const parsed = source.parse(payloads);
  console.log(`\nparsed ${parsed.length} record(s); expectedMinRecords=${source.expectedMinRecords}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
