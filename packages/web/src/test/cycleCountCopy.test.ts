/**
 * NO HARD-CODED CYCLE COUNT MAY REAPPEAR IN COPY A USER READS.
 *
 * WHAT WENT WRONG. The corpus distinguishes a deadline a funder PUBLISHED from one GrantSpotter
 * PROJECTED from a recurrence rule. That distinction is real and its per-row labelling is proved
 * elsewhere. The COUNT quoted beside it was not proved anywhere, and it had been copied by hand
 * into 15 places across 12 files in three mutually exclusive versions — "4 of 243", "4 of 244"
 * and a bare "Four of the corpus's cycles". Counted with `git grep -n "24[34]" HEAD -- packages`,
 * discarding the unrelated hits (a SHA-256 constant, two Jotform ids, two quoted fixture line
 * numbers, and the feed-scope measurement "243 VEVENTs, then 5"), plus `AgendaList.tsx`'s wordless
 * one. FOUR of the 15 were strings a user reads: `ExportMenu`'s note, `Watchlist`'s deadline
 * tooltip, `AgendaList`'s provenance tooltip and a paragraph on `Exports`. So a tool whose entire
 * premise is that it never states what it cannot source was printing a statistic false on its own
 * corpus, in the sentence explaining why its statistics can be trusted.
 *
 * WHY IT COULD NOT SIMPLY BE CORRECTED. The figure is not a constant. It is a function of the
 * corpus AND of the wall clock, because a window that has closed stops resolving into a cycle.
 * Measured over `data/seed/` — the corpus a fresh install serves — through the ICS route's own
 * two-year window (`expandCycles` + `observedCycles` over `publishableSeedPrograms`):
 *
 *     2026-08-04   252 cycles, 2 funder-published
 *     2026-10-01   250 cycles, 1 funder-published
 *     2027-02-01   248 cycles, 0 funder-published
 *
 * Only three seed records declare a funder-published window at all, and all three close inside a
 * year. Any literal typed into a sentence here is therefore wrong by October without anyone
 * touching the file — which is precisely how the three contradictory versions survived.
 *
 * WHAT REPLACED IT. Two things, chosen per site:
 *   - DERIVED, where the component holds the rows: `Calendar` and `Watchlist` count the entries
 *     they are rendering, so their figures are true by construction for whatever corpus is
 *     installed on whatever day.
 *   - REWORDED, where it does not: `ExportMenu` is handed `filters` alone, and `AgendaList`'s and
 *     `Watchlist`'s per-row tooltips repeat on every row. Those now make the qualitative claim —
 *     every date says which kind it is — which is the part that is verified.
 *
 * WHAT THIS TEST DOES. It reads every non-test source file under `packages/web/src`, removes
 * comments (a comment may carry a figure, provided it names the corpus it describes), and fails on
 * a literal quantity attached to a plural "cycles" / "windows" / "deadlines" / "dates". A derived
 * count is a JSX expression, not a literal, so `Calendar`'s `{published} funder-published` passes
 * and a typed-in `4 of 243 cycles` does not.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files whose copy is NOT yet clean, each with the reason it is still listed.
 *
 * This list is not a permission slip. The test below fails if a quarantined file has STOPPED
 * violating the rule, so an entry cannot outlive the defect it names: whoever fixes the copy is
 * told, by a failing test, to delete the line. An allow-list that silently goes stale is the same
 * mechanism that produced the defect this file exists to prevent.
 */
const QUARANTINE: ReadonlyMap<string, string> = new Map([
  [
    'routes/Exports.tsx',
    'Owned by another pass in this change set: "Only 4 of the 243 dated windows in this corpus" ' +
      '(and its assertion in Exports.test.tsx) must move together, and neither file is this ' +
      'pass\'s to edit. The measured figure for the shipping corpus is in this file\'s header.',
  ],
]);

/**
 * Comments out, strings and JSX text kept.
 *
 * A regex sweep cannot do this: `'https://hooks.example.com/grantspotter'` in `Watchlist.tsx`
 * contains a `//` that a naive line-comment strip would treat as the start of a comment, silently
 * deleting the rest of the line and every claim on it. Walking the four states — line comment,
 * block comment (which covers `{/* … *\/}` too), quoted string, everything else — is what makes
 * "a string containing a URL" and "a comment" distinguishable at all.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        // Newlines survive so the reported line numbers stay the file's own.
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
        if (source[i - 1] === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const QUANTITY = String.raw`(?:\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)`;
/**
 * PLURAL ONLY, and that is a deliberate limit rather than an oversight. `MonthGrid`'s "One window"
 * and `Sources`' "one of them owned the deadline" are ordinary prose, and a guard that fails on
 * ordinary prose gets weakened or deleted — which is worse than no guard. A count claim about a
 * corpus is plural in every phrasing this repository has ever used for it, including "1 of 244
 * cycles".
 */
const SUBJECT = String.raw`(?:cycles|windows|deadlines|dates)`;
const COUNT_CLAIM = new RegExp(
  String.raw`\b${QUANTITY}\b(?:\s+(?:of|in)\s+[^.!?<>]{0,50}?)?\s+${SUBJECT}\b`,
  'gi',
);

interface Hit {
  file: string;
  line: number;
  text: string;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out.sort();
}

function countClaimsIn(file: string): Hit[] {
  const relative = path.relative(WEB_SRC, file);
  const hits: Hit[] = [];
  stripComments(readFileSync(file, 'utf8'))
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(COUNT_CLAIM)) {
        hits.push({ file: relative, line: index + 1, text: match[0].trim() });
      }
    });
  return hits;
}

describe('hard-coded cycle counts in user-facing copy', () => {
  const files = sourceFiles(WEB_SRC);

  it('sweeps a tree that is actually there', () => {
    // A silently-empty sweep is a green test that checks nothing — the failure mode this whole
    // file is about. Both surfaces the defect lived on must be in the set.
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((f) => path.relative(WEB_SRC, f))).toEqual(
      expect.arrayContaining(['components/ExportMenu.tsx', 'routes/Watchlist.tsx']),
    );
  });

  it('still sees the copy after comments are removed', () => {
    // The canary for the stripper. If a future edit breaks `stripComments` into returning
    // something empty or mangled, every assertion below passes for the wrong reason.
    const menu = stripComments(
      readFileSync(path.join(WEB_SRC, 'components/ExportMenu.tsx'), 'utf8'),
    );
    expect(menu).toContain('Export this view');
    expect(menu).not.toContain('NO COUNT IN THIS SENTENCE');
  });

  it('keeps a URL inside a string intact, so nothing hides behind one', () => {
    const probe = "const u = 'https://example.org/x'; const copy = '4 of 243 cycles';";
    expect(stripComments(probe)).toContain('4 of 243 cycles');
    expect(stripComments('// 4 of 243 cycles\nconst a = 1;')).not.toContain('cycles');
    expect(stripComments('{/* 4 of 243 cycles */}\nconst a = 1;')).not.toContain('cycles');
  });

  it('finds none outside the quarantine', () => {
    const hits = files
      .flatMap(countClaimsIn)
      .filter((hit) => !QUARANTINE.has(hit.file))
      .map((hit) => `${hit.file}:${String(hit.line)} — "${hit.text}"`);
    expect(
      hits,
      'A cycle/window/deadline count typed into copy goes stale on its own: the shipping corpus ' +
        'reports 252 cycles with 2 funder-published on 2026-08-04 and 248 with 0 on 2027-02-01. ' +
        'Derive it from the rows the component holds (see Calendar.tsx and Watchlist.tsx), or ' +
        'make the claim without the number.',
    ).toEqual([]);
  });

  it('drops a quarantined file the moment its copy is clean', () => {
    for (const [file, reason] of QUARANTINE) {
      const full = path.join(WEB_SRC, file);
      expect(
        countClaimsIn(full).length,
        `${file} is quarantined ("${reason}") but no longer states a count. Delete its entry ` +
          'from QUARANTINE in this file — a quarantine that outlives its defect is how the ' +
          'stale claim survived nine copies last time.',
      ).toBeGreaterThan(0);
    }
  });
});
