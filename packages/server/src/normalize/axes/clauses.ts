/**
 * The shared, safe sentence/clause splitter.
 *
 * Six extractors (citizenship, ageStage, gender, recommendation, hamActivity, financialNeed) used
 * to carve a "sentence" out of a record with the idiom `/[^.]*KEYWORD[^.]*\./i`, i.e. "everything
 * between the surrounding periods". `[^.]` cannot cross a period, so that idiom is wrong in three
 * ways that all occur in this corpus:
 *
 *  - decimals: "Applicant must be a U.S. citizen with a 3.0 GPA or higher" (Rev. Paul E. Bittner)
 *    yielded the citizenship rawText `"citizen with a 3."`;
 *  - abbreviations: "open to graduation high school seniors, undergraduate students and U.S.
 *    military veterans." (Chick Allen) yielded `"citizen; open to graduation high school seniors,
 *    undergraduate students and U."` — the trailing "military veterans" silently dropped;
 *  - no terminator at all: a record whose fields contain no sentence-ending period (very common
 *    here — "Other: U.S. citizenship") made the match balloon across EVERY field of the flattened
 *    record, so unrelated wording such as "License Requirement: ... with preference for basic
 *    Morse code capability" bled in and flipped a hard requirement soft via preference.ts.
 *
 * The logic is the one gpa.ts introduced and membership.ts/institution.ts each re-derived, with
 * three additions this corpus forced (see ABBREVIATIONS, the tight-abbreviation rule, and the
 * bullet boundary below). It lives here so the six axes share ONE implementation instead of
 * adding a seventh private copy.
 *
 * gpa.ts and membership.ts have since been collapsed onto this module too: both called
 * `splitClauses`/`findClause` with exactly this idiom's shape (DOT safety + numbered-list
 * marker, gpa.ts also had its own field-label rule), so they now import `splitClauses`,
 * `findClause` and `candidateTexts` directly.
 *
 * institution.ts and fieldOfStudy.ts (`splitSentences`) were NOT collapsed the same way: both
 * deliberately split on more than this module does — institution.ts on every ";" and "\n"
 * (unconditionally, not just list-marker/bullet/field-label-shaped ones), because its
 * degree-level matching wants much finer-grained clauses than the other axes' free-text
 * sentences — and this module explicitly does NOT split on ";" at all (see below). Importing
 * `splitClauses` wholesale there would have silently dropped that granularity. Instead they
 * import `sentenceEndBoundaries` — the DOT-only half of this idiom, which IS identical across
 * all four files and is the actual duplication risk described above — and layer their own
 * additional boundaries on top of it, so the abbreviation/decimal safety logic still lives in
 * exactly one place without changing either file's broader splitting behaviour.
 */

/**
 * Lowercase-tailed abbreviations whose period is not a sentence end. `St.` is the one that
 * matters most here ("Residence in the St. Louis metropolitan area" is a real geography
 * phrasing). Single capitals ("U.S.", "Paul E. Bittner") are handled structurally below, not
 * listed here.
 *
 * `etc.` is deliberately NOT in this set. It is the one abbreviation in this corpus that reliably
 * DOES end a sentence — the CARA Merit Scholarship's activity list ends "GOTA, Field Day, etc."
 * and the citizenship requirement starts immediately after it — so treating it as an
 * abbreviation merged two unrelated requirements into one clause.
 */
const ABBREVIATIONS = new Set([
  'approx',
  'dr',
  'eg',
  'ie',
  'inc',
  'jr',
  'llc',
  'ltd',
  'max',
  'min',
  'mr',
  'mrs',
  'ms',
  'no',
  'prof',
  'rev',
  'sr',
  'st',
  'vs',
]);

/**
 * The positions right after every "." in `text` that is a genuine sentence end — never a decimal
 * point ("2.5", "4.0"), never an initial or an abbreviation ("U.S.", "Ph.D.", "St. Louis", "etc.").
 * Exported on its own (not just as a private step inside `splitClauses`) so a splitter with
 * different higher-level boundary rules — institution.ts splits additionally on every ";" and
 * "\n", fieldOfStudy.ts's `splitSentences` splits on nothing else at all — can still share this
 * one DOT-safety implementation instead of re-deriving it, which is exactly the kind of duplicate
 * that drifted before (see the file header).
 */
export function sentenceEndBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>();
  const DOT = /\./g;
  for (let m = DOT.exec(text); m !== null; m = DOT.exec(text)) {
    const before = text[m.index - 1];
    const beforeBefore = text[m.index - 2];
    const after = text[m.index + 1];
    const isDecimalPoint =
      before !== undefined && after !== undefined && /\d/.test(before) && /\d/.test(after);
    // A single capital letter preceded by whitespace/start-of-string or another period is an
    // initial ("U.S.", "U.S.A."), not a sentence end.
    const isInitial =
      before !== undefined &&
      /[A-Z]/.test(before) &&
      (beforeBefore === undefined || beforeBefore === '.' || /\s/.test(beforeBefore));
    // A period with a letter on BOTH sides and no space after it is inside a word, not between
    // two sentences: "Ph.D.", "e.g.", "U.S.A". Sentences in this corpus always put a space (or a
    // newline) after the terminator.
    const isTightAbbreviation =
      before !== undefined && after !== undefined && /[A-Za-z]/.test(before) && /[A-Za-z]/.test(after);
    const word = /([A-Za-z]+)$/.exec(text.slice(0, m.index))?.[1]?.toLowerCase();
    const isKnownAbbreviation = word !== undefined && ABBREVIATIONS.has(word);
    if (!isDecimalPoint && !isInitial && !isTightAbbreviation && !isKnownAbbreviation) {
      boundaries.add(m.index + 1);
    }
  }
  return boundaries;
}

/**
 * Splits `text` into clauses on:
 *  - a "." only when it is a genuine sentence end (see `sentenceEndBoundaries`);
 *  - a "1)"/"2)"-style numbered-list marker ("Other:\n1) U.S. citizen\n2) Financial need");
 *  - a "\n· " bullet marker (several entries are bulleted lists with no terminating periods);
 *  - a "\nLabel:" field boundary — this corpus's `rawText` is a flattened "Label: value\nLabel:
 *    value\n..." record, and without this boundary a fallback search over the whole record lets a
 *    DIFFERENT field's content bleed into the extracted clause.
 * Deliberately does NOT split on ";": several real entries state one requirement across a
 * semicolon ("Applicant must be a US citizen; open only to graduating high school seniors and
 * undergraduate students"), and splitting there would truncate it.
 */
export function splitClauses(text: string): string[] {
  const boundaries = sentenceEndBoundaries(text);
  const LIST_MARKER = /\n(?=\d+\))/g;
  for (let m = LIST_MARKER.exec(text); m !== null; m = LIST_MARKER.exec(text)) boundaries.add(m.index);
  const BULLET = /\n(?=[·•▪‣]\s)/g;
  for (let m = BULLET.exec(text); m !== null; m = BULLET.exec(text)) boundaries.add(m.index);
  // A capitalized word followed by up to three more words and then ":" right after a newline —
  // the shape of every field label this corpus's flattener produces ("Award Amount:", "License
  // Requirement:", "Field of Study:", "Number of Awards:"). Deliberately generic (no hardcoded
  // label list) so it isn't coupled to one source's schema; the continuation words allow any case
  // because real labels here mix them ("Award amount:", "Number of awards:").
  const FIELD_LABEL = /\n(?=[A-Z][a-zA-Z]*(?:\s+[a-zA-Z]+){0,3}\s*:)/g;
  for (let m = FIELD_LABEL.exec(text); m !== null; m = FIELD_LABEL.exec(text)) boundaries.add(m.index);
  const cuts = [0, ...[...boundaries].sort((a, b) => a - b), text.length];
  const clauses: string[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) clauses.push(text.slice(cuts[i], cuts[i + 1]).trim());
  return clauses.filter((c) => c !== '');
}

/**
 * The first clause matching `anchor`, so a multi-clause candidate never bleeds unrelated prose
 * from a neighbouring, differently-scoped clause into the one we extract.
 */
export function findClause(text: string, anchor: RegExp): string | undefined {
  return splitClauses(text).find((c) => anchor.test(c));
}

/**
 * Structured fields are tried as SELF-CONTAINED candidates before `rawText`, mirroring gpa.ts's
 * `candidateTexts`. `rawText` is the whole flattened record and already contains every structured
 * field as a substring, so scanning a field on its own keeps the extracted clause down to the
 * funder's actual wording for that requirement; `rawText` stays as the fallback for the (real,
 * common) entries that file a requirement under a label this axis does not know about.
 */
export function candidateTexts(fields: Array<string | undefined>, rawText: string): string[] {
  return [...fields, rawText].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * The first clause matching `anchor` across `candidates`, in priority order. Returns `undefined`
 * only when no candidate contains a matching clause at all.
 */
export function firstClause(candidates: string[], anchor: RegExp): string | undefined {
  for (const text of candidates) {
    const clause = findClause(text, anchor);
    if (clause !== undefined) return clause;
  }
  return undefined;
}
