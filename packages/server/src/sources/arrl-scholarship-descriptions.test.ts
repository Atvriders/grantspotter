/// <reference types="vite/client" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixturePayload, fixtureFile, hasFixture, loadFixture } from '../../test/fixtures.js';
import { splitByLabels } from './util/text.js';
import {
  ARRL_SCHOLARSHIP_LABELS,
  arrlScholarshipDescriptions,
  findAlternatePrefixCollisions,
  findAlternatesWithoutColon,
  parseScholarshipCatalog,
} from './arrl-scholarship-descriptions.js';

const SOURCE_ID = 'arrl-scholarship-descriptions';
const URL = 'http://www.arrl.org/scholarship-descriptions';
const LIVE = '00-www-arrl-org-scholarship-descriptions.html';

const pathological = () => parseScholarshipCatalog(loadFixture(SOURCE_ID, 'pathological.html'), URL);

/**
 * The committed capture of the real page, loaded with a failure that says what is wrong.
 *
 * Every test that reads the live page went through `skipIf(!hasFixture(...))` until now, which
 * meant the strongest evidence in this file — the damage the label rules prevent, measured on the
 * funder's actual 111 records — was one `rm` away from reporting "skipped" inside a green run.
 */
function theLiveCapture(): string {
  expect(
    hasFixture(SOURCE_ID, LIVE),
    `the committed capture of the real ARRL catalogue is missing from ${fixtureFile(SOURCE_ID, LIVE)}. ` +
      'It is tracked in git and is the only evidence that the label rules prevent real damage; ' +
      'restore it rather than skipping the tests that read it.',
  ).toBe(true);
  return loadFixture(SOURCE_ID, LIVE);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Fix round 3: the reviewer's point was that rounds 1-2 proved the table clean EMPIRICALLY
// (against today's page) but nothing made a future prefix collision structurally impossible or
// loud when it happens. This is the "registry-completeness" pattern applied to labels instead
// of source ids (see sources/registry.test.ts's "every registered source has a fixture
// directory" and "no source module performs I/O" tests): a static invariant over the table
// itself, checked every run, that fails with a diagnosable message instead of a silently
// mangled value.
describe('the no-alternate-is-a-prefix-of-another invariant', () => {
  it('holds for the real ARRL_SCHOLARSHIP_LABELS table shipped in this file', () => {
    expect(findAlternatePrefixCollisions(ARRL_SCHOLARSHIP_LABELS)).toEqual([]);
  });

  // Proves the checker itself is not vacuously trivial — mirrors "deliberately break it and
  // confirm the test goes red", but as a permanent, self-contained test rather than a one-time
  // manual verification step that evaporates once this session ends. Reproduces the exact
  // historical defect: "Region" is a literal prefix of "Regional Preference", the same relation
  // that silently corrupted the Metzger entry before "Regional Preference:" was added.
  it('flags a deliberately reintroduced collision — e.g. a future "Age Requirement:" alongside a stray bare "Age" with no colon', () => {
    const broken: Record<string, string[]> = {
      ...ARRL_SCHOLARSHIP_LABELS,
      Age: ['Age Requirement:', 'Age'], // colon dropped from the bare alternate — reintroduces the bug class
    };
    const collisions = findAlternatePrefixCollisions(broken);
    expect(collisions).toContainEqual({ shorter: 'Age', longer: 'Age Requirement:' });
  });

  it('flags the historical "Region" / "Regional Preference" collision directly', () => {
    const broken: Record<string, string[]> = {
      ...ARRL_SCHOLARSHIP_LABELS,
      Region: ['Region', 'Regions:', 'Regional Preference:'], // colon dropped from "Region" itself
    };
    const collisions = findAlternatePrefixCollisions(broken);
    expect(collisions).toContainEqual({ shorter: 'Region', longer: 'Regional Preference:' });
  });

  it('does not flag unrelated alternates, or two alternates of equal length', () => {
    expect(findAlternatePrefixCollisions({ A: ['Region:'], B: ['Institution:'] })).toEqual([]);
    expect(findAlternatePrefixCollisions({ A: ['Foo:'], B: ['Bar:'] })).toEqual([]);
  });
});

/**
 * THE GAP THE PREFIX CHECK ABOVE DOES NOT COVER, with its confirmed reproduction.
 *
 * A reviewer added `Recipient: ['Recipient']` to ARRL_SCHOLARSHIP_LABELS. Every test in this file
 * stayed green — 33 of 33 — while the real captured page's YASME record gained a fabricated field
 * sliced out of the middle of a sentence:
 *
 *   "Recipient": "is to provide YASME a brief report of his/her Amateur Radio activities…"
 *
 * and `Other` silently lost its tail. No two alternates collided: the alternate collided with the
 * FUNDER'S PROSE ("…the recipient is to provide YASME a brief report…"), which no comparison
 * between alternates can ever see. util/text.ts makes the trailing colon optional and matches at
 * the start of any line, so a BARE alternate matches ordinary prose; a colon-terminated one
 * cannot. 111 of the corpus's records come off this page, so an invented field here is 111
 * chances to publish a requirement the funder never wrote.
 */
describe('the every-alternate-ends-in-a-colon invariant', () => {
  it('holds for the real ARRL_SCHOLARSHIP_LABELS table shipped in this file', () => {
    expect(findAlternatesWithoutColon(ARRL_SCHOLARSHIP_LABELS)).toEqual([]);
  });

  it('flags the exact entry the reviewer used to break the parser, by name', () => {
    const broken: Record<string, string[]> = { ...ARRL_SCHOLARSHIP_LABELS, Recipient: ['Recipient'] };
    expect(findAlternatesWithoutColon(broken)).toEqual(['Recipient: "Recipient"']);
  });

  it('flags a bare alternate added to an EXISTING key, which the prefix check cannot see', () => {
    // "Sponsor" is a proper prefix of nothing in the table and collides with no other alternate,
    // so findAlternatePrefixCollisions returns [] — and it would still match the live page's
    // "Sponsor must be an active QCWA member" prose at the start of a line.
    const broken: Record<string, string[]> = {
      ...ARRL_SCHOLARSHIP_LABELS,
      Other: [...ARRL_SCHOLARSHIP_LABELS.Other, 'Sponsor'],
    };
    expect(findAlternatePrefixCollisions(broken)).toEqual([]);
    expect(findAlternatesWithoutColon(broken)).toEqual(['Other: "Sponsor"']);
  });

  it('accepts a colon-terminated alternate, however ordinary the word', () => {
    expect(findAlternatesWithoutColon({ Recipient: ['Recipient:'], Other: ['Other:'] })).toEqual([]);
  });

  /**
   * The end-to-end half: the two checks together are what make the reproduction impossible, and
   * this asserts the DAMAGE, not just the table. Against the real capture, the bare alternate
   * invents a `Recipient` field on the YASME record and truncates `Other`; the colon-terminated
   * form does neither.
   *
   * NO LONGER `it.skipIf(!hasFixture(...))` (close-out review, verdict 2: "delete the fixture and
   * it reports SKIPPED, not failed"). MEASURED before the change: moving
   * `00-www-arrl-org-scholarship-descriptions.html` aside turned this file into
   * "31 passed | 7 skipped — Test Files 1 passed", so the one test that proves the DAMAGE — and
   * the six that check the live page — evaporated while the run stayed green. A conditional skip
   * is only honest when the condition can legitimately hold; this one cannot. The capture is
   * COMMITTED (`git ls-files fixtures/arrl-scholarship-descriptions/`), `fixtures/` is not
   * ignored, and `sources/registry.test.ts` independently fails any registered source with no
   * real `NN-*` capture. So its absence is a broken checkout or a deleted fixture, and both of
   * those should be a red, which `theLiveCapture()` below makes them.
   */
  it(
    'proves the damage on the real page: a bare alternate invents a field, a colon-terminated one does not',
    () => {
      const html = theLiveCapture();
      const yasmeFrom = (labels: Record<string, string[]>) =>
        parseScholarshipCatalog(html, URL, labels).entries.find((e) => /YASME/i.test(e.name));

      const bare = yasmeFrom({ ...ARRL_SCHOLARSHIP_LABELS, Recipient: ['Recipient'] });
      expect(bare?.rawFields.Recipient).toMatch(/^is to provide YASME a brief report/);
      expect(bare?.rawFields.Other).not.toMatch(/brief report/);

      const withColon = yasmeFrom({ ...ARRL_SCHOLARSHIP_LABELS, Recipient: ['Recipient:'] });
      expect(withColon?.rawFields.Recipient).toBeUndefined();
      expect(withColon?.rawFields.Other).toMatch(/brief report/);
    },
  );
});

// ------------------------------------------------------------------ the widened guard
/**
 * WHY THE TWO CHECKS ABOVE ARE NOT YET AN INVARIANT (close-out review, verdict 2).
 *
 * "Binds for one constant only. Discovery is a single imported `ARRL_SCHOLARSHIP_LABELS`, not a
 * scan; `splitByLabels` is generic and a second label table anywhere is invisible."
 *
 * That is the same defect class as the egress rule's, which was rooted at `sources/` while two
 * live modules already imported out of it: a rule that is true of the one thing somebody
 * remembered to import. `splitByLabels` is a general facility over funder prose — any source that
 * ever parses a labelled block will declare a table — and the prose-collision defect it guards
 * against (a bare alternate matching the funder's own sentence) is a property of ANY table, not of
 * this one. MEASURED: a second table with a bare alternate, declared and used in a new file under
 * `sources/`, left every test in this file green.
 *
 * So discovery is now a scan, in four parts, each of which fails by name:
 *
 *   H0 — `splitByLabels` may only be reached from the trees this file scans. A parser that starts
 *        splitting funder prose from `normalize/` or `api/` would otherwise declare its table
 *        outside the walk, which is exactly how the egress rule was defeated.
 *   H1 — every EXPORTED label table in those trees passes BOTH checks, not just the one imported
 *        by name at the top of this file.
 *   H2a — every label table is exported, so H1 can see it. A module-local table is invisible to a
 *        runtime scan by construction, so the static half closes that door instead.
 *   H2b — no `splitByLabels` call may pass a table H1 cannot reach: never an inline object
 *         literal, and only an identifier that resolves to a scanned export.
 *
 * H1's detector and H2's parsers are pure functions, exercised below against hand-built inputs
 * that reproduce each escape, so the scan cannot rot into "found nothing, therefore fine".
 */
const SOURCE_TREE_MODULES = import.meta.glob(
  ['./**/*.ts', '!./**/*.test.ts', '../federal/**/*.ts', '!../federal/**/*.test.ts'],
  { eager: true },
) as Record<string, Record<string, unknown>>;

/**
 * `packages/server/src` — H0 walks all of it; H1/H2 scan only the trees below.
 *
 * Resolved WITHOUT `new URL(...)`: this file declares a module-level `const URL` above, which
 * shadows the global constructor for the whole module — the same shadowing that made
 * `absoluteApplyUrl` silently return undefined and cost all 111 records their apply link (see the
 * `CATALOG_URL` rename in the module under test). `fileURLToPath` takes the string directly.
 */
const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The trees that parse funder prose, and therefore the trees a label table may live in. */
const SCANNED_TREES = ['sources', 'federal'] as const;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Prose about splitting labels is not splitting labels. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * The shape of a label table at runtime: a non-empty plain object whose every value is a non-empty
 * array of non-empty strings — i.e. exactly what `splitByLabels` accepts. Deliberately structural
 * rather than name-based (`/_LABELS$/`), because a table called `FIELDS` is the same hazard.
 */
export function isLabelTable(value: unknown): value is Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([, v]) =>
      Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0),
  );
}

/** Every label-shaped export of one module namespace. Pure, so the negative control can drive it. */
export function labelTablesIn(
  namespace: Record<string, unknown>,
): Array<{ name: string; table: Record<string, string[]> }> {
  return Object.entries(namespace)
    .filter(([, v]) => isLabelTable(v))
    .map(([name, v]) => ({ name, table: v as Record<string, string[]> }));
}

/** Every exported label table in the scanned trees, keyed by where it lives. */
function discoveredLabelTables(): Array<{
  where: string;
  name: string;
  table: Record<string, string[]>;
}> {
  return Object.entries(SOURCE_TREE_MODULES).flatMap(([where, namespace]) =>
    labelTablesIn(namespace).map((t) => ({ where, ...t })),
  );
}

/**
 * The second argument of every `splitByLabels(...)` call in a file, as written. `null` marks a call
 * whose table is not a plain identifier — an inline object literal, a call, a member expression —
 * which is a table no runtime export scan can ever reach.
 */
export function splitByLabelsCallSites(src: string): Array<string | null> {
  const clean = stripComments(src);
  const out: Array<string | null> = [];
  // CALL sites only. `util/text.ts` DECLARES `export function splitByLabels(flatText, byKey)`,
  // whose parameter list is not an argument list — counting it as one made the scan report the
  // facility's own definition as an unreachable table.
  const re = /(?<!function\s)\bsplitByLabels\s*\(/g;
  for (let m = re.exec(clean); m !== null; m = re.exec(clean)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < clean.length && depth > 0; i += 1) {
      const ch = clean[i];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    }
    const inner = clean.slice(start, i - 1);
    // Top-level comma split: nested calls/objects must not be mistaken for an argument boundary.
    const args: string[] = [];
    let d = 0;
    let last = 0;
    for (let j = 0; j < inner.length; j += 1) {
      const ch = inner[j];
      if (ch === '(' || ch === '[' || ch === '{') d += 1;
      else if (ch === ')' || ch === ']' || ch === '}') d -= 1;
      else if (ch === ',' && d === 0) {
        args.push(inner.slice(last, j));
        last = j + 1;
      }
    }
    args.push(inner.slice(last));
    const second = (args[1] ?? '').trim();
    out.push(/^[A-Za-z_$][\w$]*$/.test(second) ? second : null);
  }
  return out;
}

/** Every `const X: Record<string, string[]>` declaration in a file, and whether it is exported. */
export function labelTableDeclarations(src: string): Array<{ name: string; exported: boolean }> {
  const clean = stripComments(src);
  const out: Array<{ name: string; exported: boolean }> = [];
  const re = /(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*:\s*Record\s*<\s*string\s*,\s*string\s*\[\s*\]\s*>/g;
  for (let m = re.exec(clean); m !== null; m = re.exec(clean)) {
    out.push({ name: m[2], exported: m[1] !== undefined });
  }
  return out;
}

/** Names a file imports, so an identifier passed to `splitByLabels` can be traced to its module. */
function importedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of stripComments(src).matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name !== '') names.add(name);
    }
  }
  return names;
}

/**
 * A parameter typed as a label table whose DEFAULT is another identifier — the shape
 * `parseScholarshipCatalog` uses (`labels: Record<string, string[]> = ARRL_SCHOLARSHIP_LABELS`).
 * The seam is legitimate; what matters is that the default it falls back to is a scanned table.
 */
function labelTableParameterDefaults(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /([A-Za-z_$][\w$]*)\s*:\s*Record\s*<\s*string\s*,\s*string\s*\[\s*\]\s*>\s*=\s*([A-Za-z_$][\w$]*)/g;
  for (let m = re.exec(stripComments(src)); m !== null; m = re.exec(stripComments(src))) {
    out.set(m[1], m[2]);
  }
  return out;
}

describe('the label-table invariants bind every table, not the one imported by name', () => {
  const discovered = discoveredLabelTables();

  // VACUITY GUARD. If the glob stops resolving, or the shape detector stops recognising a table,
  // every assertion below passes over an empty list — the "gate that checks nothing" failure.
  // Pinned by IDENTITY, not by name: this must be the very object the parser ships.
  it('finds the shipped ARRL table by scanning, not by importing it', () => {
    expect(Object.keys(SOURCE_TREE_MODULES).length).toBeGreaterThan(20);
    const arrl = discovered.find((d) => d.name === 'ARRL_SCHOLARSHIP_LABELS');
    expect(arrl?.where).toBe('./arrl-scholarship-descriptions.ts');
    expect(arrl?.table).toBe(ARRL_SCHOLARSHIP_LABELS);
  });

  // H1 — both checks, over every discovered table.
  it('holds the no-prefix and every-alternate-ends-in-a-colon rules for EVERY discovered table', () => {
    const offenders: string[] = [];
    for (const { where, name, table } of discovered) {
      for (const c of findAlternatePrefixCollisions(table)) {
        offenders.push(
          `${where} :: ${name} — ${JSON.stringify(c.shorter)} is a proper prefix of ` +
            `${JSON.stringify(c.longer)}; the shorter can match where the longer was meant.`,
        );
      }
      for (const bare of findAlternatesWithoutColon(table)) {
        offenders.push(
          `${where} :: ${name} — ${bare} does not end in a colon, so it matches the funder's own ` +
            'prose wherever a line happens to open with that word (the YASME/"Recipient" defect).',
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  // H0 — the walk covers every file that can reach `splitByLabels`.
  it('lets nothing outside the scanned trees reach splitByLabels', () => {
    const strays = tsFilesUnder(SERVER_SRC)
      .filter((f) => /\bsplitByLabels\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SERVER_SRC, f))
      .filter((rel) => !SCANNED_TREES.some((tree) => rel.startsWith(`${tree}${path.sep}`)));
    expect(
      strays,
      'these files split funder prose by label but live outside the trees this invariant scans, ' +
        `so their tables are unguarded. Either move the parser into ${SCANNED_TREES.join('/')}, ` +
        'or widen SCANNED_TREES and the glob above together.',
    ).toEqual([]);
  });

  // H2a + H2b — the static half, for tables a runtime export scan cannot see.
  it('keeps every label table reachable by the scan: exported, and never passed inline', () => {
    const exportedByFile = new Map<string, Set<string>>();
    for (const { where, name } of discovered) {
      const abs = path.resolve(SERVER_SRC, 'sources', where);
      exportedByFile.set(abs, (exportedByFile.get(abs) ?? new Set()).add(name));
    }

    const problems: string[] = [];
    for (const tree of SCANNED_TREES) {
      for (const file of tsFilesUnder(path.join(SERVER_SRC, tree))) {
        const src = readFileSync(file, 'utf8');
        const rel = path.relative(SERVER_SRC, file);

        for (const decl of labelTableDeclarations(src)) {
          if (decl.exported) continue;
          problems.push(
            `${rel} declares a module-local label table \`${decl.name}\`. A table nothing exports ` +
              'is invisible to the scan above, so its alternates are unchecked — export it.',
          );
        }

        const calls = splitByLabelsCallSites(src);
        if (calls.length === 0) continue;
        const localExports = exportedByFile.get(file) ?? new Set<string>();
        const imported = importedNames(src);
        const defaults = labelTableParameterDefaults(src);
        const known = (id: string | undefined): boolean =>
          id !== undefined && (localExports.has(id) || imported.has(id));
        // A parameter is covered by the table it DEFAULTS to; one hop only, so a chain of
        // defaults cannot launder an unscanned table through two parameters.
        const covered = (id: string): boolean => known(id) || known(defaults.get(id));
        for (const id of calls) {
          if (id === null) {
            problems.push(
              `${rel} passes splitByLabels a table that is not a plain identifier (an inline ` +
                'object literal or an expression). Such a table can never be reached by the scan ' +
                'above — hoist it to an exported const.',
            );
            continue;
          }
          if (!covered(id)) {
            problems.push(
              `${rel} passes splitByLabels \`${id}\`, which is neither an exported label table in ` +
                'this file, nor an imported name, nor a parameter defaulting to one. The scan ' +
                'above cannot check its alternates.',
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  // ---- negative controls: the scan's own parts, driven against the escapes they exist to catch.

  it('recognises a label table by shape, and refuses things that only look like one', () => {
    expect(isLabelTable({ Other: ['Other:'] })).toBe(true);
    expect(isLabelTable({})).toBe(false);
    expect(isLabelTable({ a: [] })).toBe(false);
    expect(isLabelTable({ a: ['x'], b: 'y' })).toBe(false);
    expect(isLabelTable(['Other:'])).toBe(false);
    expect(isLabelTable(null)).toBe(false);
  });

  it('would flag a SECOND table declared anywhere in the scanned trees', () => {
    // The exact break the close-out review described, as a module namespace the scan would meet.
    const secondModule = {
      QCWA_LABELS: { Recipient: ['Recipient'], Amount: ['Award Amount:'] },
      parseSomething: () => undefined,
    };
    const found = labelTablesIn(secondModule);
    expect(found.map((f) => f.name)).toEqual(['QCWA_LABELS']);
    expect(findAlternatesWithoutColon(found[0].table)).toEqual(['Recipient: "Recipient"']);
  });

  it('reads the table out of a splitByLabels call, and flags one it cannot reach', () => {
    expect(splitByLabelsCallSites('const x = splitByLabels(text, MY_LABELS);')).toEqual([
      'MY_LABELS',
    ]);
    expect(
      splitByLabelsCallSites('splitByLabels(flatten(html, { keep: true }), TABLE)'),
    ).toEqual(['TABLE']);
    expect(splitByLabelsCallSites('splitByLabels(text, { Recipient: ["Recipient"] })')).toEqual([
      null,
    ]);
    expect(splitByLabelsCallSites('// splitByLabels(text, GHOST)\n')).toEqual([]);
    // The facility's own declaration is not a call, and its parameter list is not a table.
    expect(
      splitByLabelsCallSites(
        'export function splitByLabels(flat: string, byKey: Record<string, string[]>) {}',
      ),
    ).toEqual([]);
  });

  it('sees an unexported table declaration, and does not mistake an exported one for it', () => {
    expect(
      labelTableDeclarations('const HIDDEN: Record<string, string[]> = { A: ["A"] };'),
    ).toEqual([{ name: 'HIDDEN', exported: false }]);
    expect(
      labelTableDeclarations('export const SHOWN: Record<string, string[]> = { A: ["A:"] };'),
    ).toEqual([{ name: 'SHOWN', exported: true }]);
  });
});

/**
 * THE COLON RULE IS A CLAIM ABOUT THE PARSER, AND THIS IS WHERE IT IS CHECKED.
 *
 * `findAlternatesWithoutColon` inspects the TABLE. It says nothing about what `util/text.ts` then
 * does with it — and the whole reason a trailing colon is safe is a property of
 * `buildLabelRegExp`: the alternate's own colon is inside the pattern and therefore REQUIRED,
 * while the `:?` it appends afterwards is a second, optional one. If a future edit stripped the
 * colon before building the pattern, or made it optional, every table in the repo would keep
 * passing the check above while the parser went straight back to matching prose.
 *
 * So this asserts the behaviour, on the exact sentence that produced the defect.
 */
describe('a colon-terminated alternate cannot match the funder’s prose', () => {
  const PROSE =
    'Applicant must be an active member.\n' +
    'Recipient is to provide YASME a brief report of his/her Amateur Radio activities.\n' +
    'Other scholarships may also be combined with this one.';

  it('matches a real "Label:" line and ignores the same word opening a sentence', () => {
    const withColon = splitByLabels(PROSE, { Recipient: ['Recipient:'], Other: ['Other:'] });
    expect(withColon.Recipient).toBeUndefined();
    expect(withColon.Other).toBeUndefined();
    expect(withColon.__preamble).toBe(PROSE);

    const labelled = splitByLabels(`Recipient: Jane Doe\n${PROSE}`, { Recipient: ['Recipient:'] });
    expect(labelled.Recipient).toMatch(/^Jane Doe/);
  });

  it('shows the same table WITHOUT the colon slicing the sentence in half — the defect itself', () => {
    const bare = splitByLabels(PROSE, { Recipient: ['Recipient'], Other: ['Other'] });
    expect(bare.Recipient).toMatch(/^is to provide YASME a brief report/);
    expect(bare.Other).toMatch(/^scholarships may also be combined/);
  });
});

describe('parseScholarshipCatalog against the pathological fixture', () => {
  it('reads exactly the four catalog accordions and excludes EXPLORE ARRL chrome', () => {
    const result = pathological();
    expect(result.accordionCount).toBe(4);
    const names = result.entries.map((e) => e.name);
    expect(names).not.toContain('Membership');
    expect(names).not.toContain('ARRL Store');
  });

  it('drops the stub entries and keeps the real ones', () => {
    const result = pathological();
    expect(result.stubCount).toBe(3);
    expect(result.entries).toHaveLength(6);
    expect(result.entries.map((e) => e.name)).toEqual([
      'ARDC Scholarships',
      'Challenge Met Scholarship',
      'Edmond A. Metzger Scholarship',
      'Larry Hodges Memorial Scholarship',
      'QCWA Memorial Scholarship',
      'YASME Foundation Scholarship',
    ]);
  });

  it('reads the typo’d labels: "R egion", "License   Requirement", "Number of Scholarshps"', () => {
    const ardc = pathological().entries.find((e) => e.name === 'ARDC Scholarships');
    expect(ardc?.rawFields.Region).toContain('worldwide');
    expect(ardc?.rawFields['License Requirement']).toBe('Any class, licensed at least one year');
    expect(ardc?.rawFields['Number of Awards']).toBe('45');
  });

  // Challenge Met's Other field doubles as the regression fixture for fix round 1, finding 3
  // (see below) — its body now ends in two decoy sentences that open a line with a bare
  // "Amount"/"License" and no colon. These three assertions (Field of Study, Award Amount,
  // Number of Awards all exact) were already here before the fix and would themselves have
  // failed under the old bug, since the decoy text used to get appended onto Award Amount.
  it('parses a flat <p>• Label: value<br> body identically to a <ul><li><strong>…</strong></li> body', () => {
    const flat = pathological().entries.find((e) => e.name === 'Challenge Met Scholarship');
    expect(flat?.rawFields['Field of Study']).toBe('Any');
    expect(flat?.rawFields['Award Amount']).toBe('$1,000');
    expect(flat?.rawFields['Number of Awards']).toBe('1 per year');
    expect(flat?.rawFields.Other).toContain('diagnosed learning disability');
  });

  it('recovers fields from invalid HTML with a <ul> opened inside a <p>', () => {
    const metzger = pathological().entries.find((e) => e.name === 'Edmond A. Metzger Scholarship');
    expect(metzger?.rawFields['Field of Study']).toBe('Electrical Engineering');
    expect(metzger?.rawFields.Region).toBe('ARRL Central Division (IL, IN, WI)');
    expect(metzger?.rawFields.Age).toBe('17 to 25');
  });

  it('normalises \\xa0 out of every value', () => {
    for (const entry of pathological().entries) {
      for (const value of Object.values(entry.rawFields)) {
        expect(value).not.toContain(' ');
      }
    }
  });

  it('preserves the whole flattened entry verbatim in rawText', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    expect(hodges?.rawText).toContain('If no qualified');
    expect(hodges?.rawText).toContain('at-risk-youth turnaround');
  });

  it('keeps the "Any, except for Liberal Arts" exclusion verbatim', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    expect(hodges?.rawFields['Field of Study']).toBe('Any, except for Liberal Arts');
  });

  // Also doubles as fix round 2 regression coverage: Hodges' Other field now ends in a decoy
  // "Region-specific rules..." line (see below), which used to append onto this exact value.
  it('keeps the radius region verbatim so the geography extractor can read it', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    expect(hodges?.rawFields.Region).toBe('Residing within 250 miles of Seaford, Delaware');
  });

  it('uses the scholarship name as a stable externalKey and stamps the sourceUrl', () => {
    const entry = pathological().entries[0];
    expect(entry.externalKey).toBe('ARDC Scholarships');
    expect(entry.sourceId).toBe(SOURCE_ID);
    expect(entry.sourceUrl).toBe(URL);
  });

  // Fix round 1, finding 1 (CRITICAL): the site-wide "Go Now" application-link CTA has no
  // closing label to stop it, so a naive flatten appends "\nGo Now" to whichever field happens
  // to be last — 88 of 111 live entries (79%) carried it. QCWA's <div class="content"> now ends
  // in exactly this shape: a trailing <p><a title="Go Now" href=".../scholarship-application">
  // Go Now</a></p> after the real bullet list, reproducing the live markup byte-for-byte.
  it('strips the trailing "Go Now" application-link CTA instead of appending it to the last field', () => {
    const qcwa = pathological().entries.find((e) => e.name === 'QCWA Memorial Scholarship');
    expect(qcwa?.rawFields.Other).toBe('Applicant must be sponsored by an active QCWA member.');
    expect(qcwa?.rawText).not.toContain('Go Now');
  });

  // ...and keeps the one thing on that anchor that is not chrome: where to apply. A relative
  // href resolves against the page it was found on, so it lands as the same absolute URL the 87
  // spelled-out anchors carry.
  it('keeps the CTA href as the application URL, absolute even when the page writes it relative', () => {
    const entries = parseScholarshipCatalog(
      '<div class="tabArea f-widget f-accordion"><h3 class="tab">A - D</h3><ul class="accordion">' +
        '<li><p class="title">The Relative Href Scholarship</p><div class="content">' +
        '<p>Award Amount: $1,000</p><p><a href="/scholarship-application">Go Now</a></p>' +
        '</div></li></ul></div>',
      URL,
    ).entries;
    expect(entries[0]?.rawFields.applyUrl).toBe('http://www.arrl.org/scholarship-application');
    expect(entries[0]?.rawText).not.toContain('Go Now');
  });

  // Fix round 1, finding 3 (IMPORTANT): util/text.ts makes the colon after a label optional and
  // matches at the start of any line, not only after a real "Label:" — so the bare 'Amount' and
  // 'License' alternates used to also match ordinary prose that merely started a line with that
  // word. Before the fix, this appended the decoy text onto Award Amount and License Requirement
  // and silently truncated Other to just its first sentence — exactly the shape the reviewer
  // reported. These three exact-value assertions fail under the old bug and pass under the fix.
  it('does not let a bare "Amount"/"License" sentence-opener steal text from Other or pollute a real field', () => {
    const flat = pathological().entries.find((e) => e.name === 'Challenge Met Scholarship');
    expect(flat?.rawFields['Award Amount']).toBe('$1,000');
    expect(flat?.rawFields['License Requirement']).toBe('Technician or higher');
    expect(flat?.rawFields.Other).toBe(
      'Applicant must provide documentation of a diagnosed learning disability.\n' +
        "Amount awarded may vary depending on the review committee's judgement.\n" +
        'License to practice is not required for this field.',
    );
  });

  // Fix round 2 (correcting an inaccuracy in the round 1 report): Region, Institution, Age and
  // Other were ALSO left as bare, colon-optional single-word alternates — the same exploit class
  // as Amount/License, just not yet fixed. Hodges' Other field now ends in four decoy lines, one
  // per label, each opening a line with the bare word and no colon:
  //   "Age is not a factor in this award."
  //   "Region-specific rules may apply in exceptional cases."
  //   "Institution transfer students remain eligible."
  //   "Other scholarships may also be combined with this one."
  // Before the fix these fabricated an Age field, appended onto Region and Institution (see the
  // two tests above), and fragmented Other. Verified red before the fix and green after by
  // temporarily reverting the colon requirement and re-running this file.
  it('does not let bare "Age"/"Region"/"Institution"/"Other" sentence-openers fabricate or corrupt fields', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    // "Age is not a factor..." must not fabricate an Age field — Hodges never had one.
    expect(hodges?.rawFields.Age).toBeUndefined();
    // Institution must stay exactly what it was, not "Any\ntransfer students remain eligible.".
    expect(hodges?.rawFields.Institution).toBe('Any');
    // Other must retain everything, including the trailing "Other scholarships..." decoy line
    // itself (its own bare "Other" must not consume itself as a second label match).
    expect(hodges?.rawFields.Other).toBe(
      'Preference will be given to applicants residing in Louisiana. If no qualified\n' +
        'applicant is identified, the award is open to any eligible applicant. A letter describing an\n' +
        'at-risk-youth turnaround is required.\n' +
        'Age is not a factor in this award.\n' +
        'Region-specific rules may apply in exceptional cases.\n' +
        'Institution transfer students remain eligible.\n' +
        'Other scholarships may also be combined with this one.',
    );
  });

  it('logs every stub rejection by name/first-line so a dropped record is visible', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const result = pathological();
    expect(debugSpy).toHaveBeenCalledTimes(result.stubCount);
    const messages = debugSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('Chicago FM Club Scholarship'))).toBe(true);
    expect(messages.some((m) => m.includes('Placeholder'))).toBe(true);
  });

  // The lesson of fix round 1: presence/count assertions cannot catch a value silently
  // corrupted by an over-eager or under-eager label match. Pin exact, whole-object field
  // values for a couple of known entries so a future regression that mangles one field but
  // keeps the field *present* still fails a test.
  it('produces exact field values for QCWA end to end, not just presence', () => {
    const qcwa = pathological().entries.find((e) => e.name === 'QCWA Memorial Scholarship');
    expect(qcwa?.rawFields).toEqual({
      'Field of Study': 'Any',
      'License Requirement': 'Any',
      Region: 'Any',
      Institution: 'Accredited degree program',
      'Award Amount': '$3,000',
      'Number of Awards': '19',
      Other: 'Applicant must be sponsored by an active QCWA member.',
      // The "Go Now" CTA's href, kept while its text is stripped. This fixture reproduces the
      // live markup byte-for-byte, CTA included, so the entry carries an application URL.
      applyUrl: 'http://www.arrl.org/scholarship-application',
    });
  });

  it('produces exact field values for YASME end to end, not just presence', () => {
    const yasme = pathological().entries.find((e) => e.name === 'YASME Foundation Scholarship');
    expect(yasme?.rawFields).toEqual({
      'Field of Study': 'Sciences or Engineering',
      'License Requirement': 'General or higher, licensed at least two years',
      Region: 'Any',
      Institution: 'Any accredited institution',
      'Award Amount': '$5,000',
      'Number of Awards': 'Three',
      Other:
        'Applicant must rank in the top 5 to 10 percent of the class and submit a\n' +
        'year-end activity report.',
    });
  });
});

// Fix round 1, finding 2 (IMPORTANT): a real entry whose labels are ALL typo'd beyond what
// looseLabelPattern's whitespace tolerance and the explicit alternates recover
// (recognisedFieldCount === 0, same shape as a stub) must not be silently dropped — this site's
// typo history ("R egion", "License   Requirement", "Scholarshps") is real and ongoing, and
// expectedMinRecords=100 leaves 11 records of slack before parse_yield_dropped would ever notice
// one going missing. Deliberately a standalone, hand-built HTML snippet rather than an addition
// to the shared pathological.html fixture: crawl/runner.test.ts pins that fixture's real-entry
// count at exactly 6, and this scenario needs its own dedicated, uncoupled page.
const TYPO_STORM_URL = 'http://www.arrl.org/scholarship-descriptions';
const TYPO_STORM_HTML = `<!DOCTYPE html>
<html><body>
<div class="tabArea f-widget f-accordion">
  <h3 class="tab">A - D</h3>
  <ul class="accordion">
    <li>
      <p class="title"><a href="#">Typo Storm Memorial Scholarship</a></p>
      <div class="content">
        <p>&bull; Feild of Study: Any<br>
        &bull; Lisence Requiremnt: General or higher<br>
        &bull; Regoin: Any<br>
        &bull; Institooshun: Any accredited institution<br>
        &bull; Awrd Amunt: $2,500<br>
        &bull; Numbr of Awards: 2<br>
        &bull; Othr: Preference given to applicants pursuing wireless engineering.</p>
      </div>
    </li>
    <li>
      <p class="title"><a href="#">Untouched Stub</a></p>
      <div class="content"><p>&nbsp;</p></div>
    </li>
  </ul>
</div>
</body></html>`;

describe('the stub-rescue safety net (dollar amount / date corroboration)', () => {
  it('rescues a real entry whose labels are all typoed beyond recognition when a dollar amount corroborates it', () => {
    const result = parseScholarshipCatalog(TYPO_STORM_HTML, TYPO_STORM_URL);
    expect(result.stubCount).toBe(1); // only "Untouched Stub" (nbsp-only body) is dropped
    expect(result.entries).toHaveLength(1);
    const stormed = result.entries[0];
    expect(stormed.name).toBe('Typo Storm Memorial Scholarship');
    const recognised = Object.keys(stormed.rawFields).filter((k) => k !== '__preamble');
    expect(recognised).toEqual([]);
    expect(stormed.rawText).toContain('$2,500');
  });

  it('does not log the rescued entry as a stub, but does log the genuine one', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    parseScholarshipCatalog(TYPO_STORM_HTML, TYPO_STORM_URL);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(String(debugSpy.mock.calls[0][0])).toContain('Untouched Stub');
    expect(String(debugSpy.mock.calls[0][0])).not.toContain('Typo Storm');
  });
});

// Discovered while re-verifying the live page for fix round 2: requiring a colon on the bare
// "Region" alternate (so it can no longer match "Regional" as a substring) also stopped an
// EXISTING silent false positive — the live "Edmond A. Metzger Scholarship" entry uses the label
// "Regional Preference:", which the old colon-optional "Region" alternate matched as a substring,
// capturing "al Preference: Resident of ARRL Central Division (IL, IN, WI)" (garbage prefix and
// all) as its Region value. The colon requirement alone would have left this entry's Region
// unrecovered instead, so "Regional Preference:" was added as an explicit alternate to recover
// the clean value. Standalone snippet, not the shared fixture, for the same reason as the typo
// storm test above.
const REGIONAL_PREFERENCE_HTML = `<!DOCTYPE html>
<html><body>
<div class="tabArea f-widget f-accordion">
  <h3 class="tab">E - L</h3>
  <ul class="accordion">
    <li>
      <p class="title"><a href="#">Regional Preference Scholarship</a></p>
      <div class="content">
        <ul>
          <li>License Requirement: Any active Amateur Radio License Class</li>
          <li>Regional Preference: Resident of ARRL Central Division (IL, IN, WI)</li>
          <li>Field of Study: Any</li>
        </ul>
      </div>
    </li>
  </ul>
</div>
</body></html>`;

describe('the "Regional Preference" label variant', () => {
  it('recovers the clean value instead of matching "Region" as a substring of "Regional"', () => {
    const result = parseScholarshipCatalog(REGIONAL_PREFERENCE_HTML, TYPO_STORM_URL);
    const entry = result.entries.find((e) => e.name === 'Regional Preference Scholarship');
    expect(entry?.rawFields.Region).toBe('Resident of ARRL Central Division (IL, IN, WI)');
    expect(entry?.rawFields.Region).not.toContain('al Preference');
  });
});

describe('the SourceModule wrapper', () => {
  it('declares the contract fields the runner needs', () => {
    expect(arrlScholarshipDescriptions.id).toBe(SOURCE_ID);
    expect(arrlScholarshipDescriptions.tier).toBe('C');
    expect(arrlScholarshipDescriptions.klass).toBe('ham_scholarship');
    expect(arrlScholarshipDescriptions.expectedMinRecords).toBe(100);
    expect(arrlScholarshipDescriptions.requests).toEqual([
      { url: URL, method: 'GET', accept: 'html' },
    ]);
  });

  it('parses from a FetchedPayload array', () => {
    const payload = fixturePayload(SOURCE_ID, 'pathological.html', URL);
    expect(arrlScholarshipDescriptions.parse([payload])).toHaveLength(6);
  });

  it('returns [] rather than throwing when the payload is missing', () => {
    expect(arrlScholarshipDescriptions.parse([])).toEqual([]);
  });
});

describe('against the captured live page', () => {
  it('finds four accordions and at least 100 real entries', () => {
    const result = parseScholarshipCatalog(theLiveCapture(), URL);
    expect(result.accordionCount).toBe(4);
    expect(result.entries.length).toBeGreaterThanOrEqual(100);
  });

  it('names every entry and gives almost all of them a Field of Study', () => {
    const { entries } = parseScholarshipCatalog(theLiveCapture(), URL);
    for (const e of entries) expect(e.name.length).toBeGreaterThan(2);
    const withField = entries.filter((e) => e.rawFields['Field of Study'] !== undefined);
    expect(withField.length / entries.length).toBeGreaterThan(0.9);
  });

  it('does not contain the discontinued Chicago FM Club Scholarship', () => {
    const { entries } = parseScholarshipCatalog(theLiveCapture(), URL);
    expect(entries.map((e) => e.name).join('|')).not.toMatch(/Chicago FM Club/i);
  });

  // Fix round 1, finding 1: the "Go Now" application-link CTA appeared in div.content on 88 of
  // 111 (79%) live entries, with no closing label to stop it, and used to append onto whichever
  // field happened to be last. It must be gone from every field now, not merely reduced.
  it('strips the "Go Now" CTA from every one of the 111 live entries', () => {
    const { entries } = parseScholarshipCatalog(theLiveCapture(), URL);
    const polluted = entries.filter((e) =>
      Object.values(e.rawFields).some((v) => /go\s*now/i.test(v)),
    );
    expect(polluted.map((e) => e.name)).toEqual([]);
  });

  /**
   * CLOSE-OUT REVIEW B2. Stripping the CTA's TEXT was right; discarding its HREF was not. The
   * capture carries `href="http://www.arrl.org/scholarship-application"` 87 times and
   * `href="/scholarship-application"` 3 times — 89 of them inside an entry's own accordion body,
   * the 90th in the sidebar callout. All 111 records used to publish
   * `applyUrl: http://www.arrl.org/scholarship-descriptions`, the catalogue page the reader was
   * already looking at, because normalize/ had nothing else to fall back to.
   */
  it('keeps the application href off the CTA it strips, for the 89 entries that carry one', () => {
    const { entries } = parseScholarshipCatalog(theLiveCapture(), URL);
    const withApply = entries.filter((e) => e.rawFields.applyUrl !== undefined);
    expect(withApply).toHaveLength(89);
    for (const e of withApply) {
      expect(e.rawFields.applyUrl, e.name).toBe('http://www.arrl.org/scholarship-application');
    }
  });

  // The other 22 entries state no route of their own. The page's sidebar does — "Scholarship
  // Application … Complete your application now!" — but attributing a page-level callout to an
  // entry that does not carry it is an inference, not a reading, so those keep the catalogue URL
  // and the record says so by omission.
  it('writes no applyUrl for an entry whose own body names no route', () => {
    const { entries } = parseScholarshipCatalog(theLiveCapture(), URL);
    const without = entries.filter((e) => e.rawFields.applyUrl === undefined);
    expect(without).toHaveLength(entries.length - 89);
    expect(without.map((e) => e.name)).toContain('The Louisiana Memorial Scholarship');
  });
});
