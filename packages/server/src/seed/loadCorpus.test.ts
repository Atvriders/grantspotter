/**
 * THE LOADER'S FOUR REFUSALS, EACH READ IN THE STATE THAT PRODUCES IT.
 *
 * `loadSeedCorpus` is the gate every installation boots through: it throws `SeedValidationError`
 * carrying a list of violations, and an operator reads those sentences at the prompt with nothing
 * else to go on. Four of them had no test anywhere in this repository.
 *
 * WHY THIS FILE EXISTS RATHER THAN A HIGHER BUDGET NUMBER. `userFacingCopyContract.test.ts` scored
 * two of the four — "duplicate funder id in the seed corpus." and "duplicate program id in the
 * seed corpus." — as ALREADY ASSERTED, and they were not. Its `isAsserted` credits a sentence when
 * any sixteen-character run of it appears inside any string or regex literal in any test, and the
 * run it matched on both was " the seed corpus", which occurs in `seed/funderVoice.test.ts` inside
 * `/\bseed (?:record|corpus|import)\b/` — a rule for detecting maintainer notes in a funder-voice
 * field, which has nothing to do with the loader refusing a duplicate. The budget for `load.ts` had
 * therefore fallen from 4 to 2 without anybody asserting anything, and the ratchet's other tooth
 * ("leave no slack behind once a file is covered") was demanding the number be lowered to match.
 * Lowering it would have written the accidental credit into the baseline. The tests below are the
 * assertions those two sentences never had; with them the file is genuinely at 0 and its budget
 * entry is deleted.
 *
 * WHAT EACH ASSERTION IS FOR. Not that the sentence exists — that a sentence naming a thing names
 * the RIGHT thing. "names funder X, which is not in the seed corpus" is the loader's version of
 * the defect this project keeps finding: it is only true if X is the funder that is actually
 * missing, and a test that accepts any funder id there would pass over "FCC record for undefined".
 * So each case below builds a corpus with exactly one fault, and reads back the id, the file and
 * the rule the violation blames.
 *
 * THE FIXTURES ARE REAL RECORDS. Every corpus here is assembled from `data/seed/*.json` rather
 * than hand-written, because a hand-written record has to be kept passing ~800 lines of
 * `validate.ts` forever, and the day it stops the test starts failing for a reason that is not the
 * one it is about. Copying a shipped record and introducing ONE fault means every violation the
 * loader reports is the fault under test.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SeedValidationError, loadSeedCorpus, seedDir } from './load.js';
import type { SeedViolation } from './validate.js';

const SEED = seedDir();

function readSeedFile(name: string): { funders?: unknown[]; programs?: unknown[] } {
  return JSON.parse(readFileSync(join(SEED, name), 'utf8')) as {
    funders?: unknown[];
    programs?: unknown[];
  };
}

/** A shipped funder and a shipped programme that names it. */
function realRecords(): { funder: { id: string }; other: { id: string }; program: { id: string; funderId: string } } {
  const funders = readSeedFile('funders.json').funders as Array<{ id: string }>;
  const programs = readSeedFile('programs.curated.json').programs as Array<{
    id: string;
    funderId: string;
  }>;
  const program = programs[0];
  if (program === undefined) throw new Error('data/seed/programs.curated.json has no programmes');
  const funder = funders.find((f) => f.id === program.funderId);
  const other = funders.find((f) => f.id !== program.funderId);
  if (funder === undefined || other === undefined) {
    throw new Error('data/seed/funders.json does not carry the two funders this test needs');
  }
  return { funder, other, program };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A corpus directory holding exactly the files given. */
function corpusOf(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gs-seed-load-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

/** Load, expecting a refusal, and hand back what it blamed. */
function violationsFrom(dir: string): readonly SeedViolation[] {
  try {
    loadSeedCorpus(dir);
  } catch (error) {
    if (error instanceof SeedValidationError) return error.violations;
    throw error;
  }
  throw new Error('loadSeedCorpus accepted a corpus this test built to be refused');
}

describe('a corpus the loader accepts', () => {
  it('loads the shipped files and stamps every record with a computed hash', () => {
    const { funder, program } = realRecords();
    const dir = corpusOf({
      'funders.json': { funders: [funder] },
      'programs.json': { programs: [program] },
    });

    const corpus = loadSeedCorpus(dir);

    expect(corpus.funders.map((f) => f.id)).toEqual([funder.id]);
    expect(corpus.programs.map((p) => p.id)).toEqual([program.id]);
    // The loader's contract: the file carries "" and the loader computes the real thing.
    expect(corpus.programs[0]?.trust.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a file that is not JSON', () => {
  it('says so, names the file it could not parse, and carries the parser’s own reason', () => {
    const { funder, program } = realRecords();
    const violations = violationsFrom(
      corpusOf({
        'funders.json': { funders: [funder] },
        'programs.json': { programs: [program] },
        'programs.truncated.json': '{"programs": [',
      }),
    );

    expect(violations).toHaveLength(1);
    const only = violations[0];
    expect(only?.rule).toBe('json');
    expect(only?.file).toBe('programs.truncated.json');
    expect(only?.message).toMatch(/^is not valid JSON: /);
    /*
     * The reason has to be the parser's, not a fixed string. A message that said only "is not
     * valid JSON" would leave an operator with a 4,000-line file and no position, and it would
     * still pass an assertion that checked the prefix alone.
     */
    expect(only?.message.replace(/^is not valid JSON: /, '')).not.toBe('');
    // The two good files are not blamed for the bad one.
    expect(violations.map((v) => v.file)).not.toContain('funders.json');
    expect(violations.map((v) => v.file)).not.toContain('programs.json');
  });
});

describe('the same funder in two files', () => {
  it('blames the second file, names the duplicated funder, and keeps the first', () => {
    const { funder, program } = realRecords();
    const violations = violationsFrom(
      corpusOf({
        'a-funders.json': { funders: [funder] },
        'b-funders.json': { funders: [funder] },
        'programs.json': { programs: [program] },
      }),
    );

    expect(violations).toHaveLength(1);
    const only = violations[0];
    expect(only?.message).toBe('duplicate funder id in the seed corpus.');
    expect(only?.rule).toBe('duplicate-id');
    expect(only?.recordId).toBe(funder.id);
    /*
     * Files are read in sorted order, so the SECOND one is the duplicate. Blaming `a-funders.json`
     * would send a maintainer to delete the copy that the corpus is actually using.
     */
    expect(only?.file).toBe('b-funders.json');
  });
});

describe('the same programme in two files', () => {
  it('blames the second file, names the duplicated programme, and keeps the first', () => {
    const { funder, program } = realRecords();
    const violations = violationsFrom(
      corpusOf({
        'funders.json': { funders: [funder] },
        'a-programs.json': { programs: [program] },
        'b-programs.json': { programs: [program] },
      }),
    );

    expect(violations).toHaveLength(1);
    const only = violations[0];
    expect(only?.message).toBe('duplicate program id in the seed corpus.');
    expect(only?.rule).toBe('duplicate-id');
    expect(only?.recordId).toBe(program.id);
    expect(only?.file).toBe('b-programs.json');
  });
});

describe('a programme naming a funder the corpus does not have', () => {
  it('names the funder that is missing, and not some other funder that is present', () => {
    const { funder, other, program } = realRecords();
    expect(other.id).not.toBe(funder.id);

    // The programme still names its real funder; the corpus ships a DIFFERENT one.
    const violations = violationsFrom(
      corpusOf({
        'funders.json': { funders: [other] },
        'programs.json': { programs: [program] },
      }),
    );

    expect(violations).toHaveLength(1);
    const only = violations[0];
    expect(only?.rule).toBe('orphan-funder');
    expect(only?.recordId).toBe(program.id);
    expect(only?.message).toBe(
      `names funder "${program.funderId}", which is not in the seed corpus.`,
    );
    /*
     * THE POINT OF THIS CASE. The sentence quotes a funder id, and it is true only if that id is
     * the one actually absent. An assertion that matched /names funder "/ alone would pass while
     * the loader printed the funder that IS present, or `undefined`.
     */
    expect(only?.message).toContain(`"${funder.id}"`);
    expect(only?.message).not.toContain(`"${other.id}"`);
    expect(only?.message).not.toContain('undefined');
    /*
     * The corpus, not a file, is what lacks the funder — no single file can be blamed for it.
     */
    expect(only?.file).toBe('<corpus>');
  });
});

describe('more than one fault', () => {
  it('reports every one of them, so a batch is fixed in a single pass', () => {
    const { funder, other, program } = realRecords();
    const violations = violationsFrom(
      corpusOf({
        'a-funders.json': { funders: [other] },
        'b-funders.json': { funders: [other] },
        'c-broken.json': 'not json at all',
        'd-programs.json': { programs: [program] },
      }),
    );

    expect(new Set(violations.map((v) => v.rule))).toEqual(
      new Set(['duplicate-id', 'json', 'orphan-funder']),
    );
    expect(violations.map((v) => v.message)).toContain('duplicate funder id in the seed corpus.');
    expect(violations.map((v) => v.message)).toContain(
      `names funder "${funder.id}", which is not in the seed corpus.`,
    );
  });
});
