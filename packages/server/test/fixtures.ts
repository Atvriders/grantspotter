import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchedPayload } from '@grantspotter/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** <repo>/fixtures — committed real (and synthetic pathological) payloads. */
export const FIXTURE_ROOT = path.resolve(HERE, '../../..', 'fixtures');

export function fixtureFile(sourceId: string, file: string): string {
  return path.join(FIXTURE_ROOT, sourceId, file);
}

export function hasFixture(sourceId: string, file: string): boolean {
  return existsSync(fixtureFile(sourceId, file));
}

export function loadFixture(sourceId: string, file: string): string {
  return readFileSync(fixtureFile(sourceId, file), 'utf8');
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/rss+xml; charset=utf-8',
};

export function fixturePayload(
  sourceId: string,
  file: string,
  url: string,
  contentType?: string,
): FetchedPayload {
  return {
    url,
    status: 200,
    contentType: contentType ?? CONTENT_TYPE_BY_EXT[path.extname(file)] ?? 'text/plain',
    body: loadFixture(sourceId, file),
    fetchedAt: '2026-08-02T00:00:00.000Z',
  };
}
