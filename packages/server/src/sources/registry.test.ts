import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ROOT } from '../../test/fixtures.js';
import { SOURCES, getSource, listSourceIds } from './registry.js';
import { hasFollowUp, isSignalSource, resolveRequests } from './types.js';

const SOURCES_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = ['globalThis.fetch', 'node-fetch', 'node:https', 'node:http', 'better-sqlite3'];

describe('source registry invariants', () => {
  it('has unique kebab-case ids', () => {
    const ids = listSourceIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('gives every module a funderId, label, tier, klass and a non-negative expectedMinRecords', () => {
    for (const m of SOURCES) {
      expect(m.funderId).not.toBe('');
      expect(m.label).not.toBe('');
      expect(['A', 'B', 'C', 'D']).toContain(m.tier);
      expect(['ham_grant', 'ham_scholarship', 'adjacent_stem', 'equipment_in_kind']).toContain(
        m.klass,
      );
      expect(m.expectedMinRecords).toBeGreaterThanOrEqual(0);
    }
  });

  it('resolves every requests list without touching the network', async () => {
    for (const m of SOURCES) {
      const requests = await resolveRequests(m);
      for (const r of requests) {
        expect(['GET', 'POST']).toContain(r.method);
        expect(['html', 'json', 'xml', 'binary']).toContain(r.accept);
        expect(() => new URL(r.url)).not.toThrow();
        expect(new URL(r.url).protocol).toMatch(/^https?:$/);
      }
    }
  });

  it('getSource throws a useful error for an unknown id', () => {
    expect(() => getSource('nope')).toThrow(/nope/);
  });

  it('type guards agree with the shape of each module', () => {
    for (const m of SOURCES) {
      if (hasFollowUp(m)) expect(typeof m.followUp).toBe('function');
      if (isSignalSource(m)) expect(m.signalOnly).toBe(true);
    }
  });

  it('every registered source has a fixture directory', async () => {
    for (const m of SOURCES) {
      if (m.expectedMinRecords === 0 && (await resolveRequests(m)).length === 0) continue;
      const dir = path.join(FIXTURE_ROOT, m.id);
      const entries = await readdir(dir).catch(() => [] as string[]);
      expect(entries.length, `missing fixtures for source "${m.id}" at ${dir}`).toBeGreaterThan(0);
    }
  });

  it('no source module performs I/O — the fetcher is the only egress path', async () => {
    const files = (await readdir(SOURCES_DIR, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
      // Node 20.11.0 (this project's pinned runtime) leaves Dirent.parentPath undefined for
      // recursive readdir results and only populates the older `.path` alias; `.parentPath` is
      // kept first so this still works once the host runtime catches up.
      .map((e) => path.join(e.parentPath ?? e.path ?? SOURCES_DIR, e.name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      for (const forbidden of FORBIDDEN) {
        expect(src, `${file} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
