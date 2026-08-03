import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// This test file is ALLOWED to use node: imports. The purity rule applies to
// packages/core/src only — the shipped library — not to the tests that police it.
const CORE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_ROOT = join(CORE_ROOT, 'src');

const ALLOWED_RUNTIME_DEPS = ['zod'];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Comments are stripped before scanning so that a doc comment explaining
// "we deliberately do not use node:crypto here" does not trip the scanner.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const fromRe = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const re of [fromRe, bareRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
  }
  return specs;
}

describe('packages/core purity', () => {
  it('declares exactly one runtime dependency: zod', () => {
    const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(ALLOWED_RUNTIME_DEPS);
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([]);
  });

  it('imports nothing but zod and relative paths', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const spec of importSpecifiers(src)) {
        const ok = spec.startsWith('.') || ALLOWED_RUNTIME_DEPS.includes(spec);
        if (!ok) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('contains no node: imports and no host globals', () => {
    const banned: Array<[RegExp, string]> = [
      [/\bnode:/, 'node: builtin import'],
      [/\bprocess\s*\./, 'process.*'],
      [/\b__dirname\b/, '__dirname'],
      [/\brequire\s*\(/, 'require()'],
      [/\bimport\.meta\b/, 'import.meta'],
      [/\bfetch\s*\(/, 'fetch()'],
      [/\bBuffer\b/, 'Buffer'],
    ];
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const [re, label] of banned) {
        if (re.test(src)) offenders.push(`${file}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
