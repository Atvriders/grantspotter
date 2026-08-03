import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { formatVerifyReport, verifyExitCode, verifyRowFor, verifySources } from './verify.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('verifyRowFor', () => {
  it('marks a source ok when the yield meets its floor', () => {
    const row = verifyRowFor('qcwa', 200, 1, 1, 'https://www.qcwa.org/scholarship-program.htm', 'C');
    expect(row.ok).toBe(true);
    expect(row.note).toBe('');
  });

  it('marks a source not-ok and explains when the yield drops', () => {
    const row = verifyRowFor('arrl-scholarship-descriptions', 200, 4, 100, 'http://www.arrl.org/x', 'C');
    expect(row.ok).toBe(false);
    expect(row.note).toMatch(/expected at least 100/);
  });

  it('treats a legitimately empty source as ok', () => {
    expect(verifyRowFor('austin-arc', 200, 0, 0, 'https://austinhams.org/scholarships/', 'C').ok).toBe(true);
  });

  it('marks a transport error not-ok without throwing', () => {
    const row = verifyRowFor('ncdxf-grants', 'error', 0, 1, 'https://www.ncdxf.org/x', 'C');
    expect(row.ok).toBe(false);
    expect(row.note).toMatch(/fetch failed/i);
  });

  it('flags a non-2xx status', () => {
    const row = verifyRowFor('s', 403, 0, 1, 'https://example.test/x', 'C');
    expect(row.ok).toBe(false);
    expect(row.note).toMatch(/403/);
  });
});

describe('formatVerifyReport', () => {
  const rows = [
    verifyRowFor('qcwa', 200, 1, 1, 'https://www.qcwa.org/scholarship-program.htm', 'C'),
    verifyRowFor('arrl-scholarship-descriptions', 200, 4, 100, 'http://www.arrl.org/x', 'C'),
  ];

  it('prints one line per source with the yield against the floor', () => {
    const out = formatVerifyReport(rows);
    expect(out).toContain('qcwa');
    expect(out).toContain('1/1');
    expect(out).toContain('4/100');
  });

  it('says WARN, never FAIL — this is not a gate', () => {
    const out = formatVerifyReport(rows);
    expect(out).toContain('WARN');
    expect(out).not.toMatch(/\bFAIL\b/);
  });

  it('summarises the warning count', () => {
    expect(formatVerifyReport(rows)).toMatch(/1 warning/);
  });

  it('handles an empty run', () => {
    expect(formatVerifyReport([])).toContain('0 sources');
  });
});

describe('verifyExitCode', () => {
  it('is always 0, even when everything is down — the network is not a build dependency', () => {
    expect(verifyExitCode()).toBe(0);
  });
});

describe('verifySources', () => {
  it('reports a row per source and never throws when a fetch fails', async () => {
    const fetcher = {
      async fetch(req: FetchRequest): Promise<FetchedPayload> {
        if (req.url.includes('austinhams')) throw new Error('ECONNRESET');
        return { url: req.url, status: 200, contentType: 'text/html', body: '<p>x</p>', fetchedAt: '2026-08-02T00:00:00.000Z' };
      },
    };
    const rows = await verifySources(fetcher, ['austin-arc', 'manual-tier-d']);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('error');
    expect(rows[1].ok).toBe(true);
  });
});

describe('the script is never a CI gate', () => {
  it('always exits 0 in the CLI wrapper', async () => {
    const src = await readFile(path.join(REPO_ROOT, 'scripts/verify-sources.ts'), 'utf8');
    expect(src).toMatch(/process\.exitCode\s*=\s*verifyExitCode\(\)/);
    expect(src).not.toMatch(/process\.exit\(1\)|exitCode\s*=\s*1/);
  });

  it('is not referenced by any GitHub Actions workflow', async () => {
    const dir = path.join(REPO_ROOT, '.github/workflows');
    const fs = await import('node:fs/promises');
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      const yaml = await fs.readFile(path.join(dir, file), 'utf8');
      expect(yaml, `${file} must not run verify-sources`).not.toContain('verify-sources');
    }
  });
});
