/**
 * The generator, against the committed capture.
 *
 * The point of these tests is that `data/seed/programs.arrl-catalog.json` — 111 records, three
 * quarters of the publishable corpus — is a FUNCTION of a 144 KB HTML file that is committed
 * beside it, and stays one. `packages/server/src/seed/arrlCatalog.test.ts` checks the shipped
 * file's properties; this file checks that the shipped file is the one this generator produces
 * from that capture, so an edit typed into the JSON by hand (or a fixture refreshed without
 * re-running the generator) fails here rather than shipping.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CATALOG_SEED_FILE,
  CATALOG_SOURCE_ID,
  generateArrlCatalogSeed,
  serializeArrlCatalogSeed,
} from './generate-arrl-seed.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE = readFileSync(
  path.join(
    REPO_ROOT,
    'fixtures',
    CATALOG_SOURCE_ID,
    '00-www-arrl-org-scholarship-descriptions.html',
  ),
  'utf8',
);

const programs = generateArrlCatalogSeed();
const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'grantspotter-seed-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, 'fixtures', CATALOG_SOURCE_ID), { recursive: true });
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('generate-arrl-seed', () => {
  /**
   * 114 `li` on the page, of which the parser rejects 3 as stubs: an untitled one, an
   * empty-bodied one, and the page's own "Click on a scholarship below to expand for more
   * information." preamble. Exact, not a floor — the module's `expectedMinRecords` of 100 leaves
   * eleven records of slack, and a floor here would let a fixture refresh lose eleven
   * scholarships without a word.
   */
  it('produces exactly 111 records from the committed capture', () => {
    expect(programs).toHaveLength(111);
  });

  it('the committed seed file is byte-for-byte what this generator produces', () => {
    const committed = readFileSync(path.join(REPO_ROOT, 'data', 'seed', CATALOG_SEED_FILE), 'utf8');
    expect(serializeArrlCatalogSeed(programs)).toBe(committed);
  });

  it('is deterministic: a second run produces the same bytes', () => {
    expect(serializeArrlCatalogSeed(generateArrlCatalogSeed())).toBe(
      serializeArrlCatalogSeed(programs),
    );
  });

  /**
   * The verbatim fields, checked against the capture's own bytes rather than against another
   * copy of the parser. Every name, every award amount and every award count in the shipped
   * corpus is a substring of the 144 KB file — which is the property "generated, not
   * transcribed" is worth having: no fat-fingered `$5,00` can survive it.
   */
  it('takes every name, amount and award count verbatim from the capture', () => {
    const missing: string[] = [];
    for (const program of programs) {
      if (!CAPTURE.includes(program.name)) missing.push(`name: ${program.name}`);
      if (program.amount.amountRaw !== '' && !CAPTURE.includes(program.amount.amountRaw)) {
        missing.push(`amountRaw: ${program.name} → ${program.amount.amountRaw}`);
      }
      if (program.amount.awardCountRaw !== '' && !CAPTURE.includes(program.amount.awardCountRaw)) {
        missing.push(`awardCountRaw: ${program.name} → ${program.amount.awardCountRaw}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * One whole record, pinned. The capture reads, byte for byte:
   *
   *   <p class="title"><a href="#">The 10-10 International Scholarships</a></p>
   *   <p>The 10-10 Scholarships are open to all radio amateurs. US licensure, US residence and
   *   US citizenship are not requirements.</p>
   *   <p>\xa0•\tAward Amount: $3,000</p>
   *   <p>•\tNumber of Awards: Three</p>
   *   <p>•\tLicense Requirement:  Any active amateur radio license (FCC-issued or foreign)</p>
   *   <p>•\tRegion: Any</p>
   *   <p>•\tField of Study: No preference.</p>
   *   <p>•\tInstitution: An accredited 2-or 4- year college, university, or trade school.
   *   Graduate studies accepted.</p>
   *
   * Note what is NOT there: a "Go Now" anchor. This is one of the 22 entries that names no
   * application route of its own, so `applyUrl` stays on the catalogue page rather than
   * borrowing the sidebar's application link.
   */
  it('maps one entry end to end exactly as the page states it', () => {
    const tenTen = programs.find((p) => p.id === 'arrl-cat-the-10-10-international-scholarships');
    expect(tenTen).toBeDefined();
    expect(tenTen!.name).toBe('The 10-10 International Scholarships');
    expect(tenTen!.summary).toBe(
      'The 10-10 Scholarships are open to all radio amateurs. US licensure, US residence and US ' +
        'citizenship are not requirements.',
    );
    expect(tenTen!.amount).toEqual({
      instrument: 'cash_fixed',
      amountMin: 3000,
      amountMax: 3000,
      amountRaw: '$3,000',
      awardCountRaw: 'Three',
    });
    expect(tenTen!.applyUrl).toBe('http://www.arrl.org/scholarship-descriptions');
    expect(tenTen!.constraints.map((c) => c.rawText)).toEqual([
      'Any active amateur radio license (FCC-issued or foreign)',
      'Any',
      'No preference.',
      'An accredited 2-or 4- year college, university, or trade school. Graduate studies accepted.',
      'US licensure, US residence and US citizenship are not requirements.',
    ]);
    expect(tenTen!.obligations).toEqual({});
    expect(tenTen!.trust).toEqual({
      status: 'closed',
      sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
      lastVerifiedAt: '2026-08-02',
      verificationMethod: 'seed_import',
      contentHash: '',
    });
    expect(tenTen!.sourceKey).toEqual({
      sourceId: 'arrl-scholarship-descriptions',
      externalKey: 'The 10-10 International Scholarships',
    });
    expect(tenTen!.dates).toEqual({ basis: 'unpublished' });
  });

  /**
   * 89 of the 111 entries carry a "Go Now" anchor whose href is the application form; the other
   * 22 name no route and keep the catalogue URL. The anchor's TEXT is chrome and is stripped —
   * a record whose apply button says "Go Now" and lands on the page you are already reading is
   * the 345-wrong-destinations defect in miniature.
   */
  it('keeps each entry on the destination its own body names', () => {
    const byUrl = new Map<string, number>();
    for (const program of programs) {
      byUrl.set(program.applyUrl ?? '', (byUrl.get(program.applyUrl ?? '') ?? 0) + 1);
    }
    expect(Object.fromEntries(byUrl)).toEqual({
      'http://www.arrl.org/scholarship-application': 89,
      'http://www.arrl.org/scholarship-descriptions': 22,
    });
    expect(programs.some((p) => /go now/i.test(JSON.stringify(p)))).toBe(false);
  });

  it('inherits every deadline from the seeded owner, never from a minted hash id', () => {
    for (const program of programs) {
      expect(program.deadline.source).toEqual({
        kind: 'inherited',
        fromProgramId: 'arrl-foundation-scholarships',
      });
    }
  });

  /**
   * The headline defect of this whole product, in the exact place it happened: 110 of these
   * entries once shipped badged `open` against the portal page they ride, which says twice that
   * the 2026 cycle is closed.
   */
  it('badges none of them open', () => {
    const counts: Record<string, number> = {};
    for (const program of programs) {
      counts[program.trust.status] = (counts[program.trust.status] ?? 0) + 1;
    }
    expect(counts).toEqual({ closed: 110, dormant: 1 });
  });

  /**
   * One entry's body names a $100,000 ENDOWMENT — the size of the fund, not of the award. A
   * maximum-dollar regex reads it as a $100,000 scholarship; `parseAmount` reads the clause.
   */
  it('never mistakes the endowment for the award', () => {
    expect(CAPTURE).toContain('$100,000');
    expect(programs.filter((p) => (p.amount.amountMax ?? 0) >= 100000)).toEqual([]);
  });

  it('asserts no obligation, because the catalogue page states none', () => {
    for (const program of programs) expect(program.obligations).toEqual({});
  });

  it('refuses a fixture directory whose only file is the synthetic pathological capture', () => {
    const root = tempRoot();
    writeFileSync(
      path.join(root, 'fixtures', CATALOG_SOURCE_ID, 'pathological.html'),
      '<html></html>',
      'utf8',
    );
    expect(() => generateArrlCatalogSeed(root)).toThrow(/holds 0 captures/);
  });

  it('refuses to ship a corpus that lost entries', () => {
    const root = tempRoot();
    writeFileSync(
      path.join(root, 'fixtures', CATALOG_SOURCE_ID, '00-truncated.html'),
      '<html><body><p>the page moved</p></body></html>',
      'utf8',
    );
    expect(() => generateArrlCatalogSeed(root)).toThrow(/Refusing to ship a corpus that lost entries/);
  });
});
