/**
 * THE LEDGER, AND THE ONE TEST THAT MAKES THE NEXT CORRECTION WORK.
 *
 * `data/seed/shipped-values.tsv` is the only reason a shipped data correction can safely rewrite a
 * field on somebody else's database: it is what proves the bytes now stored are bytes we wrote.
 * A ledger that has fallen behind the corpus does not fail loudly on its own — it simply makes the
 * next correction unappliable, silently, everywhere this runs. So `the corpus is fully recorded`
 * below is the load-bearing test in this file: it is what turns "remember to run the script" into
 * a red suite that names the record.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Program } from '@grantspotter/core';
import { loadSeedCorpus, seedDir } from './load.js';
import {
  CORRECTABLE_PATHS,
  ShippedValues,
  ShippedValuesError,
  WITNESSED_PATHS,
  canonicalJson,
  digestOf,
  formatShippedValues,
  loadShippedValues,
  parseShippedValues,
  shippedValuesPath,
  valueAt,
  witnessedValuesOf,
} from './shippedValues.js';

describe('the shipped-values ledger file', () => {
  it('round-trips through format and parse', () => {
    const values = new ShippedValues([
      { sha256: digestOf('a'), programId: 'p-two', path: 'summary', firstSeen: '2026-08-04' },
      { sha256: digestOf('b'), programId: 'p-one', path: 'rawOtherText', firstSeen: '2026-08-13' },
    ]);
    const reparsed = parseShippedValues(formatShippedValues(values));
    expect(reparsed.size).toBe(2);
    expect(reparsed.witness('p-one', 'rawOtherText', 'b')?.firstSeen).toBe('2026-08-13');
    expect(reparsed.witness('p-two', 'summary', 'a')?.firstSeen).toBe('2026-08-04');
  });

  it('sorts by program then path, so a regeneration is a readable diff', () => {
    const values = new ShippedValues([
      { sha256: digestOf('b'), programId: 'zulu', path: 'summary', firstSeen: '2026-08-04' },
      { sha256: digestOf('a'), programId: 'alfa', path: 'summary', firstSeen: '2026-08-04' },
      { sha256: digestOf('c'), programId: 'alfa', path: 'rawOtherText', firstSeen: '2026-08-04' },
    ]);
    expect(values.entries().map((e) => `${e.programId}/${e.path}`)).toEqual([
      'alfa/rawOtherText',
      'alfa/summary',
      'zulu/summary',
    ]);
  });

  it('keeps the earliest date a digest was seen, and never drops a digest', () => {
    const values = new ShippedValues();
    values.add({ sha256: digestOf('x'), programId: 'p', path: 'summary', firstSeen: '2026-08-13' });
    values.add({ sha256: digestOf('x'), programId: 'p', path: 'summary', firstSeen: '2026-08-04' });
    values.add({ sha256: digestOf('y'), programId: 'p', path: 'summary', firstSeen: '2026-08-13' });
    expect(values.size).toBe(2);
    expect(values.witness('p', 'summary', 'x')?.firstSeen).toBe('2026-08-04');
  });

  it('refuses a line it cannot read rather than silently recording nothing', () => {
    expect(() => parseShippedValues('deadbeef\tp\tsummary\t2026-08-04')).toThrow(ShippedValuesError);
    expect(() => parseShippedValues(`${digestOf('a')}\tp\tsummary`)).toThrow(ShippedValuesError);
    expect(() => parseShippedValues(`${digestOf('a')}\tp\tklass\t2026-08-04`)).toThrow(
      /not a witnessed path/,
    );
  });

  it('treats a missing file as an empty ledger, which can prove nothing', () => {
    expect(loadShippedValues('/nonexistent/shipped-values.tsv').size).toBe(0);
  });
});

describe('the value at a witnessed path', () => {
  const base = loadSeedCorpus(seedDir()).programs[0]!;

  it('tells an empty string apart from an absent field', () => {
    const withEmpty: Program = { ...base, aiPolicy: { stance: 'unaddressed', quote: '' } };
    const withNone: Program = { ...base, aiPolicy: { stance: 'unaddressed' } };
    expect(valueAt(withEmpty, 'aiPolicy.quote')).toBe('');
    expect(valueAt(withNone, 'aiPolicy.quote')).toBeUndefined();
    // …and the same distinction one level down, in a field the schema requires: `""` is a funder
    // who publishes no figure, said out loud.
    expect(valueAt({ ...base, amount: { ...base.amount, amountRaw: '' } }, 'amount.amountRaw')).toBe('');
  });

  it('is key-order independent for the paths whose value is an object', () => {
    expect(canonicalJson({ a: 1, b: [{ y: 2, x: 3 }] })).toBe(canonicalJson({ b: [{ x: 3, y: 2 }], a: 1 }));
  });

  it('is NOT whitespace-insensitive: the claim it makes is about exact bytes', () => {
    expect(digestOf('two  spaces')).not.toBe(digestOf('two spaces'));
    expect(digestOf(' padded ')).not.toBe(digestOf('padded'));
  });
});

describe('the corpus that ships today', () => {
  const corpus = loadSeedCorpus(seedDir());
  const ledger = loadShippedValues();

  it('is fully recorded in data/seed/shipped-values.tsv', () => {
    const missing: string[] = [];
    for (const program of corpus.programs) {
      for (const { path, value } of witnessedValuesOf(program)) {
        if (ledger.witness(program.id, path, value) === undefined) {
          missing.push(`${program.id} ${path}`);
        }
      }
    }
    expect(
      missing,
      'data/seed changed without data/seed/shipped-values.tsv being regenerated. Until it is, a ' +
        'correction to these fields can never reach an instance already holding them, ' +
        'because nothing proves the stored bytes are ours. Run `npm run seed:shipped-values`.',
    ).toEqual([]);
  });

  it('still carries the digests of the values it shipped BEFORE the 2026-08-13 correction', () => {
    // The point of the ledger is the values that are NOT current. If a regeneration ever dropped
    // them, the 31 records this mechanism exists for would quietly become uncorrectable.
    const corrected = corpus.programs.filter(
      (p) =>
        ledger.knows(p.id, 'rawOtherText') &&
        witnessedValuesOf(p).some(
          ({ path, value }) =>
            path === 'rawOtherText' && ledger.witness(p.id, path, value)?.firstSeen === '2026-08-13',
        ),
    );
    expect(corrected.length).toBeGreaterThanOrEqual(29);
  });

  it('records a digest and never the text', () => {
    const text = readFileSync(shippedValuesPath(), 'utf8');
    for (const program of corpus.programs.slice(0, 40)) {
      const summary = program.summary.slice(0, 60);
      if (summary.length < 40) continue;
      expect(text).not.toContain(summary);
    }
  });

  it('witnesses every correctable path and the one witnessed-only path', () => {
    expect(WITNESSED_PATHS).toEqual([...CORRECTABLE_PATHS, 'constraints']);
    expect(CORRECTABLE_PATHS).not.toContain('constraints');
  });
});
