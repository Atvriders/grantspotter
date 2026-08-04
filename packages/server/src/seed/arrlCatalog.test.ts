/**
 * The generated half of the corpus, as it ships.
 *
 * These assertions read `data/seed/programs.arrl-catalog.json` through the same loader and the
 * same validation harness the product uses, so they are about the FILE that installs, not about
 * the generator that wrote it. `scripts/generate-arrl-seed.test.ts` covers the other direction —
 * that the committed file is byte-for-byte what re-running the generator over the committed
 * capture produces, which is what makes "generated, not transcribed" a checked property rather
 * than a claim in a commit message.
 */
import { describe, expect, it } from 'vitest';
import { loadSeedCorpus, seedDir } from './load.js';

const corpus = loadSeedCorpus(seedDir());
const catalog = corpus.programs.filter((p) => p.id.startsWith('arrl-cat-'));
const byId = new Map(corpus.programs.map((p) => [p.id, p]));

const OWNER_ID = 'arrl-foundation-scholarships';

describe('generated ARRL catalog seed', () => {
  /**
   * 114 `li` on the captured page minus the 3 stubs the parser rejects (an untitled one, an
   * empty-bodied one, and the page's own "Click on a scholarship below to expand for more
   * information." boilerplate). The number is asserted exactly, not as a floor: a fixture refresh
   * that silently drops entries is the failure this source is most exposed to, and a floor of 100
   * would hide the loss of eleven scholarships.
   */
  it('contains all 111 entries the capture carries', () => {
    expect(catalog.length).toBe(111);
  });

  it('inherits its deadline from the scholarship programme record', () => {
    for (const program of catalog) {
      expect(program.deadline.kind).toBe('inherited');
      expect(program.deadline.source).toEqual({
        kind: 'inherited',
        fromProgramId: OWNER_ID,
      });
    }
  });

  it('inherits from a programme that exists, so expandCycles has something to resolve', () => {
    expect(byId.get(OWNER_ID)).toBeDefined();
  });

  it('classifies every entry as a ham scholarship for an individual', () => {
    for (const program of catalog) {
      expect(program.klass).toBe('ham_scholarship');
      expect(program.applicantEntities).toEqual(['individual']);
    }
  });

  it('cites the catalog page and the research date on every entry', () => {
    for (const program of catalog) {
      expect(program.trust.sourceUrl).toBe('http://www.arrl.org/scholarship-descriptions');
      expect(program.trust.lastVerifiedAt).toBe('2026-08-02');
      expect(program.trust.verificationMethod).toBe('seed_import');
    }
  });

  /**
   * THE 116-RECORD DEFECT, in the place it happened. 110 of these entries once shipped badged
   * `open` against a portal that says, twice, "The 2026 Scholarship Cycle is now closed." The
   * status is not typed here either: it is the status of the programme they ride, read back out
   * of the corpus, which is exactly what `crawl/runner.ts`'s `applyInheritedStatus` computes on
   * every crawl. Asserting against the owner rather than against the literal "closed" is what
   * makes this test survive the day ARRL opens the next cycle.
   */
  it('never claims open: every entry carries the status of the programme it rides', () => {
    const owner = byId.get(OWNER_ID);
    expect(owner).toBeDefined();
    expect(owner!.trust.status).not.toBe('unknown');
    const ownStatus = catalog.filter((p) => p.trust.status !== owner!.trust.status);
    // The Winscott scholarship says on the page that it is not currently active. A record's own
    // evidence outranks its owner's — the precedence `inferStatus` states in words.
    expect(ownStatus.map((p) => `${p.id}=${p.trust.status}`)).toEqual([
      'arrl-cat-the-william-c-winscott-n6cha-memorial-scholarship=dormant',
    ]);
    expect(catalog.some((p) => p.trust.status === 'open')).toBe(false);
  });

  it('preserves at least one verbatim constraint per entry', () => {
    for (const program of catalog) {
      expect(program.constraints.length).toBeGreaterThan(0);
      for (const constraint of program.constraints) {
        expect(constraint.rawText.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('never invents an amount: an entry with no parsed figure keeps amountRaw and omits min and max', () => {
    for (const program of catalog) {
      expect(program.amount.amountRaw.length).toBeGreaterThan(0);
      if (program.amount.amountMin === undefined) {
        expect(program.amount.amountMax).toBeUndefined();
      }
    }
  });

  /**
   * One entry's body carries $100,000, which is the size of the ENDOWMENT that funds it, not of
   * the award. A maximum-dollar regex reads it as a $100,000 scholarship. `parseAmount` reads the
   * clause it sits in and keeps the award at $1,000.
   */
  it('never records the $100,000 endowment figure as an award ceiling', () => {
    for (const program of catalog) {
      expect(program.amount.amountMax ?? 0).toBeLessThan(100000);
    }
    const salerno = catalog.find((p) => p.name.includes('Salerno'));
    expect(salerno, 'the entry that names the endowment must be present').toBeDefined();
    expect(salerno!.amount.amountMax).toBe(1000);
  });

  it('keeps awardCountRaw verbatim, including non-numeric values', () => {
    const values = catalog.map((p) => p.amount.awardCountRaw);
    expect(values.some((v) => /per year|Multiple|Three|\d/i.test(v))).toBe(true);
    // An entry whose page states no count keeps the empty string rather than a sentence we wrote.
    // "Not published in the catalog entry." would read like a fact from the page and would also
    // differ from what the nightly crawl computes for the same record, which is a phantom diff.
    expect(values.filter((v) => v === '')).toHaveLength(2);
  });

  /**
   * Several entries are funded by other organisations — ARDC, QCWA, YASME — but the ARRL
   * Foundation administers every one of them: one application, one deadline, one intake. The
   * catalogue record therefore names the administering funder, which is also what
   * `normalizeRaw` writes from the source module's `funderId` on every crawl. Splitting these
   * onto their own funder ids would put a nightly `funderId` diff on ~7 records forever, since
   * `hashProgram` covers `funderId`; the separately-seeded `ardc-grants` record is where ARDC's
   * own programme lives.
   */
  it('names a funder that exists in the corpus on every entry', () => {
    const funderIds = new Set(catalog.map((p) => p.funderId));
    expect([...funderIds]).toEqual(['arrl-foundation']);
    for (const id of funderIds) {
      expect(corpus.funders.some((f) => f.id === id)).toBe(true);
    }
  });

  it('does not duplicate a hand-curated record', () => {
    const curated = new Set(
      corpus.programs.filter((p) => !p.id.startsWith('arrl-cat-')).map((p) => p.name.toLowerCase()),
    );
    for (const program of catalog) {
      expect(curated.has(program.name.toLowerCase())).toBe(false);
    }
  });

  it('carries the crawler identity that stops the nightly crawl duplicating all 111', () => {
    for (const program of catalog) {
      const key = corpus.sourceKeys.get(program.id);
      expect(key, `no sourceKey on ${program.id}`).toBeDefined();
      expect(key!.sourceId).toBe('arrl-scholarship-descriptions');
      expect(key!.externalKey.length).toBeGreaterThan(0);
      // The parser's externalKey IS the entry name. If those two ever separate, the crawl mints a
      // fresh id for the record and the corpus doubles on night one.
      expect(key!.externalKey).toBe(program.name);
    }
  });

  it('is the bulk of the publishable corpus, and none of it is suppressed', () => {
    for (const program of catalog) {
      expect(program.tags).not.toContain('do_not_publish');
    }
  });
});
