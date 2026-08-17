/**
 * THE LEDGER OF TEXT THIS PROJECT HAS SHIPPED, AND WHY A CORRECTION NEEDS ONE.
 *
 * `importSeedIfEmpty` refuses to write into a database that already holds programs, and that
 * refusal is correct: it is what stops an image upgrade from destroying an operator's review
 * decisions. Its consequence is that a correction to shipped seed data can never reach a running
 * deployment. Commits f466f8e and 82727f4 rewrote 31 records whose "Unstructured requirements,
 * verbatim" panel was printing this project's own notes under a heading promising the funder's own
 * words; every one of those records is still wrong on every instance that was seeded before the
 * fix, and no amount of pulling a newer image changes that.
 *
 * The only safe way to rewrite a field on somebody else's database is to be able to prove that
 * nobody has touched it. This file is that proof: for every value the seed corpus has ever
 * carried, it records the SHA-256 of the exact bytes. If the value a deployment holds today
 * hashes to something in this ledger, that value is one WE wrote and nobody has edited it since.
 * If it hashes to anything else — one character of an operator's edit, one approved crawl
 * candidate — it is not ours to overwrite, and `corrections.ts` leaves it alone and says so.
 *
 * WHY A HASH AND NOT THE TEXT. Shipping the old text back would put the sentences this project is
 * apologising for into the image a second time, where a reader could mistake the ledger for
 * corpus content. A digest is a fingerprint, not a copy: it can recognise the bad text on a
 * deployment without ever restating it. What the operator gets told, when a row is rewritten,
 * comes out of their own database (see `corrections.ts`), which is the only place the old text
 * still legitimately exists.
 *
 * WHY A .tsv IN data/seed. `loadSeedCorpus` treats every `*.json` in this directory as a corpus
 * file and refuses anything it cannot validate, which is a property worth keeping — a stray record
 * file must never be silently ignored. `MAINTAINER-NOTES.md` already establishes that
 * non-`.json` files live here beside the corpus they describe. Tab-separated so an operator can
 * `grep <program-id> data/seed/shipped-values.tsv` and so a reviewer reads one line per fact in
 * the diff.
 *
 * HOW IT STAYS TRUE. `scripts/record-shipped-values.ts` regenerates it — from the working tree and
 * from any git revision — and `shippedValues.test.ts` fails if the corpus carries a value whose
 * digest is not in here. That test is the whole mechanism for the NEXT correction: a maintainer
 * who edits a seed value and does not re-run the script gets a red suite naming the record.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Program } from '@grantspotter/core';
import { seedDir } from './load.js';

/**
 * THE ONLY FIELDS A SHIPPED-DATA CORRECTION MAY REWRITE.
 *
 * Every one of them is prose the product PRINTS. None of them is read by `matcher.ts`, and none
 * carries a number, a date, an entity list or a status that anything reasons over. That is the
 * line this mechanism draws and `corrections.ts` enforces at write time (`meaningOf`): a
 * correction may change what a record SAYS; it may never change what a record MEANS.
 *
 * `deadline.note` is on this list and is the one that has to be argued. It is prose, but it also
 * carries the `RECUR` micro-format `expandCycles` projects a calendar from, and the sentence
 * `parseObservedWindow` reads a funder-stated window out of. So it is admitted here and then
 * fenced at write time: a correction whose note parses to a different recurrence or a different
 * observed window is refused, reported, and left for a human. All four notes the 2026-08-13
 * correction touches keep their directive byte-identical and only rewrite the prose after it.
 *
 * A constraint's SENTENCE is correctable too, one constraint at a time, but it cannot be named in
 * a fixed list because its path carries the constraint's own id — see `constraintRawTextPath`. A
 * constraint's RULES are not correctable at all; see `WITNESSED_ONLY_PATHS`.
 */
export const CORRECTABLE_PATHS = [
  'summary',
  'rawOtherText',
  'amount.amountRaw',
  'amount.awardCountRaw',
  'deadline.note',
  'aiPolicy.quote',
  'fundingRestrictions',
] as const;

export type FixedCorrectablePath = (typeof CORRECTABLE_PATHS)[number];

/* ------------------------------------------------ the two halves of a constraint -------------- */

/**
 * A CONSTRAINT IS TWO THINGS, AND ONE PATH WAS TREATING IT AS ONE.
 *
 * `constraints` used to be a single witnessed-only value covering the whole array. That call was
 * half right, and the half that was wrong printed three sentences no funder wrote to every student
 * who opened those records — under a heading promising the funder's own words — with no way for a
 * correction to reach them. `docker compose pull` reported the records and deliberately did not
 * rewrite them, exactly as designed, for eight days.
 *
 * The half that was right is `constraints.rules`, below: the id, the hardness, the fallback rank
 * and the `spec` are what `matcher.ts` reasons over, and rewriting them at boot changes who is
 * told they are eligible. MEASURED over the shipped corpus and the seven shipped profiles, 1,001
 * (profile, programme) pairs: flipping every `hard` moves 596 answers, renumbering every
 * `fallbackRank` moves 25. That stays witnessed-only, and the whole rules half of a record moves
 * or does not move together, because a constraint the corpus dropped and a constraint the corpus
 * added are the same event seen from two sides.
 *
 * The half that was wrong is `constraints[<id>].rawText`: the sentence the product PRINTS. It gets
 * its own path, per constraint, so a corrected quotation is proved and rewritten under the same
 * byte-identity rule as every other displayed sentence, and an operator who has rewritten ONE
 * sentence does not thereby freeze the other four on the same record.
 *
 * IT IS NOT INERT AND IT IS NOT TREATED AS INERT. `rawText` reaches `evaluateConstraint`, which
 * asks whether the funder called their own list illustrative; erasing every `rawText` in the corpus
 * moves 16 answers. So this path is admitted here and then FENCED at write time by `meaningOf` in
 * `corrections.ts`, through `matcherReadingOf` — the same shape as `deadline.note`, which is prose
 * that also carries a `RECUR` directive and is admitted only because the parse is compared.
 */
export const WITNESSED_ONLY_PATHS = ['constraints.rules'] as const;

export type WitnessedOnlyPath = (typeof WITNESSED_ONLY_PATHS)[number];

/**
 * The path naming one constraint's displayed sentence. `[` and `]` cannot appear in a seed
 * constraint id (`validate.ts` restricts them to a slug), so the grammar is unambiguous, and a tab
 * cannot appear either — which is what keeps the ledger's four columns four columns.
 */
const CONSTRAINT_RAW_TEXT = /^constraints\[([^[\]\t]+)\]\.rawText$/;

export function constraintRawTextPath(constraintId: string): ConstraintRawTextPath {
  return `constraints[${constraintId}].rawText`;
}

export type ConstraintRawTextPath = `constraints[${string}].rawText`;

/** The constraint id inside a `constraints[<id>].rawText` path, or `undefined` for any other. */
export function constraintIdOfRawTextPath(path: string): string | undefined {
  return CONSTRAINT_RAW_TEXT.exec(path)?.[1];
}

export type CorrectablePath = FixedCorrectablePath | ConstraintRawTextPath;

export type WitnessedPath = CorrectablePath | WitnessedOnlyPath;

/**
 * The paths every record has, in ledger order. A record's constraint-sentence paths are not in
 * here because they depend on the record; `witnessedValuesOf` adds them.
 */
export const WITNESSED_PATHS: readonly WitnessedPath[] = [
  ...CORRECTABLE_PATHS,
  ...WITNESSED_ONLY_PATHS,
];

export function isCorrectablePath(path: string): path is CorrectablePath {
  return (
    (CORRECTABLE_PATHS as readonly string[]).includes(path) ||
    constraintIdOfRawTextPath(path) !== undefined
  );
}

export function isWitnessedPath(path: string): path is WitnessedPath {
  return isCorrectablePath(path) || (WITNESSED_ONLY_PATHS as readonly string[]).includes(path);
}

/**
 * PATHS THE LEDGER USED TO CARRY AND NOTHING COMPUTES ANY MORE.
 *
 * `constraints` was one value covering a whole constraint array, sentence and rules together.
 * Splitting it means nothing ever produces that value again, so its digests can never match
 * anything and are dead weight — but a ledger file written before the split still holds 283 of
 * them, and a ledger file that will not PARSE is worse than one carrying dead rows: `loadShipped
 * Values` would throw, `corrections.ts` would report `ran: false`, and every correction in the
 * release would stop arriving. Worse, `record-shipped-values.ts` reads the existing file before it
 * unions, so a hard failure here would make the ledger un-regenerable — you could not even run the
 * command that fixes it.
 *
 * So a retired path is READ AND DROPPED, not rejected: the file loads, the dead rows do not enter
 * the ledger, and the next regeneration writes a file without them. Anything that is neither
 * witnessed nor retired is still a hard error, because that is a typo or a path somebody invented,
 * and silently ignoring one would mean a correction that never fires and never says why.
 */
export const RETIRED_PATHS = ['constraints'] as const;

export function isRetiredPath(path: string): boolean {
  return (RETIRED_PATHS as readonly string[]).includes(path);
}

/**
 * Stable JSON for the two paths whose value is not a bare string.
 *
 * Keys are sorted because the same object reaches this function two ways — parsed out of a seed
 * file, and parsed out of a database column that a zod round-trip may have re-keyed — and a
 * difference in key ORDER is not a difference in the value. Nothing else is normalised: no
 * whitespace collapsing, no trimming. `hashProgram` (core/hash.ts) deliberately does collapse
 * whitespace, which is right for change detection and wrong here, because the whole claim this
 * ledger makes is about exact bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The value at one witnessed path, as the exact string the ledger fingerprints, or `undefined`
 * when the record does not carry that field at all.
 *
 * `undefined` is not the empty string and must never be conflated with it: `"amountRaw": ""` is a
 * funder who publishes no figure, said out loud, and an absent `amountRaw` is a record that never
 * had the field. A correction can rewrite the first and must refuse the second (there is nothing
 * to prove untouched).
 */
export function valueAt(program: Program, path: WitnessedPath): string | undefined {
  switch (path) {
    case 'summary':
      return program.summary;
    case 'rawOtherText':
      return program.rawOtherText;
    case 'amount.amountRaw':
      return program.amount.amountRaw;
    case 'amount.awardCountRaw':
      return program.amount.awardCountRaw;
    case 'deadline.note':
      return program.deadline.note;
    case 'aiPolicy.quote':
      return program.aiPolicy.quote;
    case 'fundingRestrictions':
      return canonicalJson(program.fundingRestrictions);
    case 'constraints.rules':
      // THE SENTENCE IS BLANKED, NOT DROPPED. Blanking keeps the shape of the value — one entry
      // per constraint, in order — so a constraint the corpus added or dropped still changes this
      // digest and is still reported. Dropping the key instead would make an EMPTY rawText and an
      // ABSENT one hash alike, and an empty rawText is a real state this product uses: it is how
      // `hasFunderWording` says "no funder wrote this", which is the whole basis of the quote box.
      return canonicalJson(program.constraints.map((c) => ({ ...c, rawText: '' })));
    default: {
      const constraintId = constraintIdOfRawTextPath(path);
      if (constraintId === undefined) return undefined;
      return program.constraints.find((c) => c.id === constraintId)?.rawText;
    }
  }
}

/** SHA-256 of the UTF-8 bytes of a value. `node:crypto`, because this is server-side only. */
export function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface ShippedValueEntry {
  sha256: string;
  programId: string;
  path: WitnessedPath;
  /** The date the corpus first carried these exact bytes, from the commit that introduced them. */
  firstSeen: string;
}

/** One (program, path) key. `\u0000` cannot appear in either half. */
function keyFor(programId: string, path: WitnessedPath): string {
  return `${programId}\u0000${path}`;
}

export class ShippedValues {
  private readonly byKey = new Map<string, Map<string, ShippedValueEntry>>();

  constructor(entries: readonly ShippedValueEntry[] = []) {
    for (const entry of entries) this.add(entry);
  }

  /** Keeps the EARLIEST `firstSeen` for a digest: the ledger is a union, never a replacement. */
  add(entry: ShippedValueEntry): void {
    const key = keyFor(entry.programId, entry.path);
    let bucket = this.byKey.get(key);
    if (bucket === undefined) {
      bucket = new Map<string, ShippedValueEntry>();
      this.byKey.set(key, bucket);
    }
    const existing = bucket.get(entry.sha256);
    if (existing === undefined || entry.firstSeen < existing.firstSeen) bucket.set(entry.sha256, entry);
  }

  /** The ledger entry proving this project shipped exactly these bytes, or `undefined`. */
  witness(programId: string, path: WitnessedPath, value: string): ShippedValueEntry | undefined {
    return this.byKey.get(keyFor(programId, path))?.get(digestOf(value));
  }

  /** Whether the ledger knows anything at all about a (program, path) — used to tell "we have no
   * record of ever shipping this field" apart from "we shipped something else". */
  knows(programId: string, path: WitnessedPath): boolean {
    return (this.byKey.get(keyFor(programId, path))?.size ?? 0) > 0;
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.byKey.values()) total += bucket.size;
    return total;
  }

  entries(): ShippedValueEntry[] {
    const all: ShippedValueEntry[] = [];
    for (const bucket of this.byKey.values()) all.push(...bucket.values());
    return all.sort(
      (a, b) =>
        (a.programId < b.programId ? -1 : a.programId > b.programId ? 1 : 0) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        (a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : 0) ||
        (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0),
    );
  }
}

export const SHIPPED_VALUES_FILE = 'shipped-values.tsv';

export function shippedValuesPath(dir: string = seedDir()): string {
  return join(dir, SHIPPED_VALUES_FILE);
}

const HEADER = [
  '# GrantSpotter — every value the shipped seed corpus has ever carried, by digest.',
  '#',
  '# One line per (program, field, exact bytes):',
  '#   <sha256>\\t<programId>\\t<path>\\t<first date the corpus carried these bytes>',
  '#',
  '# A CONSTRAINT HAS TWO PATHS, because it is two things. `constraints[<id>].rawText` is the',
  '# sentence a record DISPLAYS, one line per constraint, and a correction may rewrite it.',
  '# `constraints.rules` is the id, hardness, fallback rank and spec of every constraint on the',
  '# record — what decides who is eligible — and it is witnessed here only so a difference can be',
  '# REPORTED to the operator. Nothing ever rewrites it.',
  '#',
  '# This file is what lets a shipped data correction reach a deployment that was seeded before',
  '# the correction existed WITHOUT overwriting anything a human changed: a field is rewritten',
  '# only when the value it holds today hashes to a line below, which proves the bytes are ours.',
  '# It records digests, never text — restating the sentences we are correcting would ship them',
  '# twice. See packages/server/src/seed/shippedValues.ts and corrections.ts.',
  '#',
  '# GENERATED. Re-run `npm run seed:shipped-values` after ANY edit to data/seed/*.json; the file',
  '# is a union and never forgets a digest. shippedValues.test.ts fails if you forget.',
].join('\n');

export function formatShippedValues(values: ShippedValues): string {
  const lines = values
    .entries()
    .map((e) => `${e.sha256}\t${e.programId}\t${e.path}\t${e.firstSeen}`);
  return `${HEADER}\n${lines.join('\n')}\n`;
}

export class ShippedValuesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShippedValuesError';
  }
}

export function parseShippedValues(text: string): ShippedValues {
  const values = new ShippedValues();
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '' || line.startsWith('#')) return;
    const parts = line.split('\t');
    if (parts.length !== 4) {
      throw new ShippedValuesError(
        `${SHIPPED_VALUES_FILE} line ${String(index + 1)}: expected 4 tab-separated fields, got ${String(parts.length)}.`,
      );
    }
    const [sha256, programId, path, firstSeen] = parts as [string, string, string, string];
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ShippedValuesError(
        `${SHIPPED_VALUES_FILE} line ${String(index + 1)}: "${sha256}" is not a sha256 digest.`,
      );
    }
    if (isRetiredPath(path)) return;
    if (!isWitnessedPath(path)) {
      throw new ShippedValuesError(
        `${SHIPPED_VALUES_FILE} line ${String(index + 1)}: "${path}" is not a witnessed path. ` +
          `A correction may only ever be proved for: ${WITNESSED_PATHS.join(', ')}, and ` +
          'constraints[<constraint id>].rawText.',
      );
    }
    values.add({ sha256, programId, path, firstSeen });
  });
  return values;
}

/**
 * Reads the ledger. A MISSING FILE IS AN EMPTY LEDGER, NOT AN ERROR — and an empty ledger can
 * prove nothing, so `corrections.ts` then rewrites nothing at all. That is the correct failure
 * direction: the mechanism's whole safety is the proof, so no proof must mean no writes, never
 * "write anyway".
 */
export function loadShippedValues(path: string = shippedValuesPath()): ShippedValues {
  if (!existsSync(path)) return new ShippedValues();
  return parseShippedValues(readFileSync(path, 'utf8'));
}

/** Every (path, value) a record carries today, for the generator and for the discipline test. */
export function witnessedValuesOf(program: Program): Array<{ path: WitnessedPath; value: string }> {
  const out: Array<{ path: WitnessedPath; value: string }> = [];
  for (const path of WITNESSED_PATHS) {
    const value = valueAt(program, path);
    if (value !== undefined) out.push({ path, value });
  }
  // One line per displayed sentence. Recorded even when it is empty: an empty `rawText` is this
  // product saying "no funder wrote this", and a correction that fills one in has to be able to
  // prove the emptiness it is replacing was ours.
  for (const constraint of program.constraints) {
    out.push({ path: constraintRawTextPath(constraint.id), value: constraint.rawText });
  }
  return out;
}
