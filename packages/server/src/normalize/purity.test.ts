import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RADIUS_CENTERS } from './axes/radiusCenters.js';

const NORMALIZE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(NORMALIZE_DIR, '../../../..');

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(NORMALIZE_DIR, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => path.join(e.parentPath ?? e.path ?? NORMALIZE_DIR, e.name));
}

describe('normalize/ is pure', () => {
  it('finds the modules it is about to check', async () => {
    expect((await sourceFiles()).length).toBeGreaterThan(5);
  });

  it('imports nothing from node:', async () => {
    for (const file of await sourceFiles()) {
      const src = await readFile(file, 'utf8');
      expect(src, `${file} must not import from node:`).not.toMatch(/from\s+'node:/);
      expect(src, `${file} must not require node:`).not.toMatch(/require\(['"]node:/);
    }
  });

  it('reads no file, no clock and no environment', async () => {
    for (const file of await sourceFiles()) {
      const src = await readFile(file, 'utf8');
      for (const forbidden of ['readFileSync', 'process.env', 'Date.now()', 'new Date(']) {
        expect(src, `${file} must not use ${forbidden} — inject it through NormalizeContext`)
          .not.toContain(forbidden);
      }
    }
  });

  it('reaches outside normalize/ only for @grantspotter/core', async () => {
    for (const file of await sourceFiles()) {
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1];
        if (spec === '@grantspotter/core') continue;
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//);
        expect(path.resolve(path.dirname(file), spec).startsWith(NORMALIZE_DIR)).toBe(true);
      }
    }
  });

  it('keeps radiusCenters.ts and data/reference/radius-centers.json in agreement', async () => {
    const json = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'data/reference/radius-centers.json'), 'utf8'),
    ) as Record<string, unknown>;
    const fromJson = Object.fromEntries(
      Object.entries(json).filter(([key]) => !key.startsWith('_')),
    );
    expect(RADIUS_CENTERS).toEqual(fromJson);
    expect(Object.isFrozen(RADIUS_CENTERS)).toBe(true);
  });
});
