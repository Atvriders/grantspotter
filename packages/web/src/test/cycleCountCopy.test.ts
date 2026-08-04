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
 * a literal census of the corpus. A derived count is a JSX expression, not a literal, so
 * `Calendar`'s `{published} funder-published` passes and a typed-in `4 of 243 cycles` does not.
 *
 * THE HOLE THAT WAS IN IT, AND WHY THE SHAPE CHANGED. The first version of this guard matched a
 * quantity attached to one of four nouns — cycles, windows, deadlines, dates. So this passed it,
 * with the whole web suite green, while being the very sentence the guard exists to prevent:
 *
 *     Only 4 of the 243 dated EVENTS in this corpus are dates a funder has actually published
 *
 * Adding "events" to the list would have bought one synonym. What is actually being forbidden is
 * not a noun, it is a CENSUS: a literal number claiming what share of a population this corpus
 * holds. So there are three detectors now, and evading the guard means evading all three at once:
 *
 *   CENSUS  — "N of [the] M ⟨anything plural⟩". Noun-agnostic: the two numerals ARE the census,
 *             whatever it is counting. Catches the sentence above, and "4 of the 243 items",
 *             "4 of the 243 thingamabobs", and anything else the next author reaches for.
 *   SUBJECT — a quantity attached to a plural noun from the corpus-item family. This is the
 *             original rule, with the family widened, and it is what catches a census with only
 *             one numeral in it: "Four of the corpus's cycles", "243 cycles".
 *   CLAIM   — a partitive quantity ("N of …", "N in …", "2% of …") sharing a sentence with a
 *             phrase that asserts who published a date. Noun-agnostic AND numeral-count-agnostic:
 *             catches "only four of them are funder-published" and "just 2% of these are dates a
 *             funder has actually published", where the noun is a pronoun and there is no M.
 *
 * All three run over the WHOLE file rather than line by line, because JSX wraps prose: the
 * offending sentence occupied five lines, and a per-line sweep only ever saw the first of them.
 *
 * WHAT STILL EVADES IT, said plainly, because a guard that reads as complete and is not is worse
 * than a known gap:
 *
 *   1. A figure ASSEMBLED at render time — `{'4 of '}{total} events` — is not a literal and no
 *      source sweep can see it. `components/ExportMenu.test.tsx` and `routes/Exports.test.tsx`
 *      close this for the two screens that carried the defect, by asserting the rendered DOM
 *      states no count; every other screen is uncovered against that particular edit.
 *   2. A single-numeral census whose noun is outside SUBJECT and whose claim is paraphrased past
 *      CLAIM — "only 4 of the dated things here come straight from the grantmaker". CENSUS wants
 *      a second numeral, SUBJECT wants a known noun, CLAIM wants a known phrasing; that sentence
 *      has none of the three. Deliberately: requiring less of each is how a guard starts failing
 *      on ordinary prose ("One of these values was not accepted") and gets deleted.
 *   3. Vaguer quantities than a numeral — "a dozen", "hundreds of", "nine in ten". NUMBER stops
 *      at ten and at four digits.
 *   4. Copy outside `packages/web/src`: `components/*.css` comments, the server package and
 *      README all still carry 243/244 sentences. This sweep has never claimed them.
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
/**
 * EMPTY, and it reached empty the way the comment above says it must — by the copy being fixed,
 * not by the entries being deleted.
 *
 * The widening that added the CENSUS/SUBJECT/CLAIM rule immediately caught three sentences older
 * than the cycle-count defect it was written for, all three rendered to a user:
 *
 *   - `lib/profileFields.ts`  "110 of the 111 ARRL catalog entries gate on it" — and this one was
 *                             FALSE as well as fragile. 110 is how many catalog entries carry an
 *                             INSTITUTION constraint; all 111 carry a licence one.
 *   - `routes/Opportunity.tsx` "111 entries in the ARRL scholarship catalog share one close date" —
 *                             correct when written, which is precisely why it was worth removing.
 *   - `routes/Sources.tsx`    "the deadline 112 of 150 programmes inherit" — already drifting the
 *                             way 243/244 did: `normalize/deadline.ts` says 112 of 152 for the same
 *                             population, and `data/seed/` holds 143 records, so the denominator on
 *                             screen matched neither corpus.
 *
 * Each is now a claim that cannot rot. Keeping this map in place, empty, is deliberate: the next
 * person who needs to defer a fix has the mechanism and the rules already written down.
 */
const QUARANTINE: ReadonlyMap<string, string> = new Map([]);

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

/**
 * A literal quantity. `2%` is a census too — "only 2% of these are funder-published" rots at
 * exactly the same rate as "only 4 of 243".
 *
 * The trailing `(?!\w)` rather than `\b`, because `\b` does not exist between `%` and the space
 * after it, and `2% of these` slipped the whole guard while `2 of these` did not.
 */
const NUMBER = String.raw`\b(?:\d{1,4}\s?%|\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)(?!\w)`;

/**
 * "N of …", "N in …", "N out of …". The partitive is what makes a number a CENSUS rather than a
 * count of anything else, and it is the one piece every version of this defect has had.
 *
 * It is also what keeps the guard off ordinary prose. `ExportMenu` and `Exports` both say "which
 * of the two kinds it is" and "marked four ways" in the corrected copy: quantities, but not
 * partitive ones, so nothing here looks at them.
 */
const PARTITIVE = String.raw`${NUMBER}(?:\s+out)?\s+(?:of|in)\s+`;

/** Words a sentence may put between the denominator and its noun: "the 243 DATED windows". */
const PLURAL_OBJECT = String.raw`(?:[a-z’'-]+\s+){0,3}[a-z’'-]{3,}s\b`;
const DETERMINER = String.raw`(?:(?:the|these|those|this|its|their|our|all|a)\s+)?`;

/**
 * CENSUS. "N of [the] M ⟨anything plural⟩", and the noun is deliberately unconstrained: two
 * numerals either side of a partitive is a share-of-population claim whatever it is counting, and
 * "4 of the 243 dated events" must not be reachable by picking a noun this file has not heard of.
 */
const CENSUS = new RegExp(
  String.raw`${PARTITIVE}${DETERMINER}(?:corpus[’']?s?\s+)?${NUMBER}\s+${PLURAL_OBJECT}`,
  'gi',
);

/**
 * SUBJECT. The original rule, whose noun family is now wide enough to cover the words this corpus
 * is actually described with. It earns its place beside CENSUS by catching a census with only ONE
 * numeral in it — "Four of the corpus's cycles", "243 cycles" — where there is no denominator for
 * CENSUS to see.
 *
 * PLURAL ONLY, and that is a deliberate limit rather than an oversight. `MonthGrid`'s "One window"
 * and `Sources`' "one of them owned the deadline" are ordinary prose, and a guard that fails on
 * ordinary prose gets weakened or deleted — which is worse than no guard.
 */
const SUBJECT = String.raw`(?:cycles|windows|deadlines|dates|events|entries|items|records|rows|programmes|programs|opportunities|grants|listings|vevents)`;
const SUBJECT_COUNT = new RegExp(
  String.raw`${NUMBER}(?:\s+(?:of|in)\s+[^.!?<>]{0,50}?)?\s+${SUBJECT}\b`,
  'gi',
);

/**
 * CLAIM. A phrase that asserts WHO a date came from. Multi-word prose on purpose: `nextIsEstimated`
 * and `isEstimated` are identifiers all over this package, and a guard that trips on an identifier
 * would be read as noise.
 */
const PUBLISHED_CLAIM = String.raw`(?:funder[-\s]published|published by (?:the|a|its|their|that)\s+funder|(?:a|the)\s+funder\s+(?:has\s+|have\s+)?(?:not\s+)?(?:actually\s+)?(?:published|announced|printed)|dates?\s+a\s+funder|projected from a recurrence|projections?\s+from a recurrence|estimated by GrantSpotter)`;

/**
 * A partitive quantity in the same sentence as that claim, in either order. This is the detector
 * that needs neither a second numeral nor a known noun, so it reaches the phrasings where the
 * population is a pronoun: "only four of them are funder-published".
 *
 * `[^.!?<>]` bounds the window to one sentence and stops it crossing a JSX tag — the same fence
 * the original rule used, and the reason a `{derived}` count on the next element cannot drag an
 * unrelated literal into a match.
 */
const CLAIM_COUNT = new RegExp(
  String.raw`(?:${PARTITIVE}[^.!?<>]{0,80}?${PUBLISHED_CLAIM}|${PUBLISHED_CLAIM}[^.!?<>]{0,80}?${PARTITIVE})`,
  'gi',
);

const DETECTORS: ReadonlyMap<string, RegExp> = new Map([
  ['CENSUS', CENSUS],
  ['SUBJECT', SUBJECT_COUNT],
  ['CLAIM', CLAIM_COUNT],
]);

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

/**
 * WHOLE TEXT, NOT LINE BY LINE. JSX wraps prose at 100 columns, so the sentence this file exists
 * to forbid arrived spread over five lines; a per-line sweep saw "Only 4 of the 243 dated" and
 * nothing that followed it. Matching the file as one string costs a newline count to report the
 * line number and closes a hole that needed no cleverness at all to walk through.
 */
export function countClaims(text: string): { detector: string; line: number; text: string }[] {
  const found: { detector: string; line: number; text: string }[] = [];
  for (const [detector, pattern] of DETECTORS) {
    for (const match of text.matchAll(pattern)) {
      found.push({
        detector,
        line: text.slice(0, match.index).split('\n').length,
        text: match[0].replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return found;
}

function countClaimsIn(file: string): Hit[] {
  const relative = path.relative(WEB_SRC, file);
  return countClaims(stripComments(readFileSync(file, 'utf8'))).map((hit) => ({
    file: relative,
    line: hit.line,
    text: `[${hit.detector}] ${hit.text}`,
  }));
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

  /**
   * WHAT THE RULE IS, WRITTEN AS EXAMPLES INSTEAD OF AS A REGEX.
   *
   * The first version of this guard passed a green suite while `routes/Exports.tsx` printed
   * "Only 4 of the 243 dated EVENTS in this corpus are dates a funder has actually published",
   * because its noun list held four words and "events" was not one of them. Nothing in the file
   * said what the rule was FOR, so nothing noticed that the rule and its purpose had come apart.
   *
   * These are that purpose, as sentences. Each caught line is a phrasing the defect has taken or
   * could trivially take next; each ignored line is real copy from this package that must stay
   * legal, because a guard that fires on "One of these values was not accepted" is a guard the
   * next person deletes.
   */
  const CAUGHT = [
    'Only 4 of the 243 dated windows in this corpus are dates a funder has actually published',
    'Only 4 of the 243 dated events in this corpus are dates a funder has actually published',
    'Only 4 of the 243 dated thingamabobs in this corpus are the funder’s own',
    'only 4 of 243 cycles in this corpus are dates a funder has actually published',
    'Only 4 of the corpus’s 244 cycles are funder-published',
    'Four of the corpus’s cycles are of this kind',
    'The calendar carries 243 events',
    'Only four of them are funder-published; the rest are guesses',
    'Just 2% of these are dates a funder has actually published',
    // Wrapped the way JSX wraps it, which is how the last one hid from a line-by-line sweep.
    'Only 4 of the 243 dated\n          events in this corpus are dates a funder has\n          actually published',
  ];

  const IGNORED = [
    // The corrected copy, from ExportMenu and Exports. Quantities, but not a census.
    'Every date in the calendar file says which of the two kinds it is — a window the funder ' +
      'published, or one GrantSpotter projected from the recurrence that program has followed',
    'A projected event is marked four ways — an “(estimated)” title prefix, a tentative status, ' +
      'a custom property and a note in its description',
    // Ordinary prose that happens to be partitive or plural. `Profile`, `MonthGrid`, `Sources`.
    'One of these values was not accepted: the callsign is not a callsign',
    'One window',
    'Six parsers once returned zero records from their own live pages',
    // Derived, which is the sanctioned fix: an expression is not a literal.
    '{data.entries.length} dated cycles between {from} and {to} — {published} funder-published',
  ];

  it('catches every phrasing the census has taken, whatever noun it reaches for', () => {
    for (const sentence of CAUGHT) {
      expect(
        countClaims(sentence).map((h) => h.detector),
        `NOT CAUGHT: "${sentence}". A census this guard lets through is a false statistic on ` +
          'screen with a green suite behind it, which is exactly how the last one survived.',
      ).not.toEqual([]);
    }
  });

  it('leaves ordinary prose and derived counts alone, so it does not get deleted', () => {
    for (const sentence of IGNORED) {
      expect(
        countClaims(sentence),
        `FALSE POSITIVE: "${sentence}". This is legal copy. Narrow the detector that fired ` +
          'rather than rewording the product around a guard.',
      ).toEqual([]);
    }
  });

  it('finds none outside the quarantine', () => {
    const hits = files
      .flatMap(countClaimsIn)
      .filter((hit) => !QUARANTINE.has(hit.file))
      .map((hit) => `${hit.file}:${String(hit.line)} — "${hit.text}"`);
    expect(
      hits,
      'A census of the corpus typed into copy goes stale on its own, whatever noun it counts: ' +
        'the shipping corpus reports 252 cycles with 2 funder-published on 2026-08-04 and 248 ' +
        'with 0 on 2027-02-01, from the same unedited files. Derive it from the rows the ' +
        'component holds (see Calendar.tsx and Watchlist.tsx), or make the claim without the ' +
        'number, as ExportMenu.tsx and Exports.tsx do.',
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
