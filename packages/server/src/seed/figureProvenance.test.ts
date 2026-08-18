/**
 * A NUMBER A RECORD PRINTS TO A STUDENT MUST BE A NUMBER ITS FUNDER PUBLISHED.
 *
 * Six rendered fields carry the record's own prose, and until this file nothing in the repository
 * read any of them:
 *
 *   `summary`                  the first paragraph of the record page and of every export
 *   `deadline.note`            the "When" panel (its prose half; the `RECUR` directive is ours)
 *   `amount.amountRaw`         the Award panel, under "Amount, verbatim"
 *   `amount.awardCountRaw`     the Award panel, under "Number of awards"
 *   `fundingRestrictions[]`    the "Funding restrictions" panel
 *   `obligations.*Obligation`  the "Obligations if you win" panel
 *
 * `funderVoice.test.ts` reads four of them and asks WHO IS SPEAKING — is this the funder's register
 * or GrantSpotter's? It says so itself: "IT HAS NO COPY OF THE FUNDER'S PAGE. It cannot confirm
 * that a sentence appears on it." `constraintProvenance.test.ts` does hold the funder's page, and
 * it reads `constraints[].rawText` and `rawOtherText` — the two fields the product labels verbatim.
 * These six are labelled nothing. They are the curator's own words, legitimately, which is exactly
 * why a verbatim rule is the wrong instrument for them and why they went unchecked for four rounds
 * of work on fabricated funder text.
 *
 * The sweep below covers those six and, on the same argument, every other rendered field where a
 * figure is the reader's business and no guard reads one: `constraints[].spec.note`,
 * `trust.disputed.note`, `trust.staleMirrorWarning`, `aiPolicy.quote`, and the four NUMERIC fields
 * the Award and Obligations panels render — `amount.amountMin`, `amount.amountMax`,
 * `amount.tiers[]`, `obligations.indirectCostCapPct`. `proseFields` below says why each is in, and
 * `NOT_A_FIGURE_SURFACE` says why every remaining field on the record is out. Leaving one out is
 * allowed; leaving one out silently is what the table exists to stop.
 *
 * THE DEFECT THAT NAMES THE INVARIANT. A record told applicants an ARRL scholarship pays $500 where
 * a reading of its page said $1,000, and that it required a Technician-class licence where the page
 * said any class. Two numbers. The curator's licence covers the WORDS around a figure — "one
 * application covers the whole catalogue", "a single annual window" — and it has never covered the
 * figure. A student reads `$500` and decides whether an application fee, transcript fees and three
 * recommendation letters are worth spending. So:
 *
 *      EVERY NUMBER, MONEY AMOUNT AND DATE A PROSE FIELD STATES MUST APPEAR IN THE CAPTURE OF
 *      THAT RECORD'S OWN FUNDER PAGE.
 *
 * Numbers are the checkable core of a field that is otherwise the curator's to write. They are
 * mechanically extractable, they are what the money and the deadline are made of, and they are
 * where paraphrase stops being paraphrase and starts being a different fact.
 *
 * MEASURED WHEN THIS FILE WAS WRITTEN, at 3462825, over the corpus a fresh install serves:
 *
 *      144 seed records · 907 fields that hold a rendered string or number
 *      850 of them on a record whose source ships a capture · 629 of those state a figure
 *      944 figure occurrences in all
 *       14 distinct (record, field, figure) triples are NOT on their own record's captured page —
 *          every one registered below, by hand, with the property that is true of it instead
 *
 * ...and over the 150 records `scripts/profile-corpus.ts` builds by running the extractors over the
 * same captures: 832 fields, 904 figures, ONE not on its own page (registered below too).
 *
 * WHY THE HAYSTACK IS THE PARSED CAPTURE AND NOT THE CAPTURE FILE, and why the register is written
 * by hand. The obvious cheap implementation is "grep the number out of `fixtures/<source>/*.html`".
 * Run it and `arrl-foundation-scholarships`'s summary claim that the ARRL descriptions page "lists
 * 111 entries" passes, because `111` is in that file — inside `Newington, CT, 06111-1400`, ARRL's
 * ZIP code, in the page footer. A haystack of raw markup contains every four-digit number a page
 * has ever laid out, and a guard measured against it is green by accident. So the sweep below runs
 * against `RawOpportunity.rawText` + `rawFields` — the funder text the parsers actually cut out,
 * the same haystack `constraintProvenance.test.ts` measures against — and the ten figures that do
 * not clear it are not waved through by a second automatic tier. Each is written down with a
 * property a machine can still check: a QUOTE that must appear on a named capture, a DERIVED value
 * that is recomputed from the capture on every run, or a TOKEN that is not a quantity at all.
 *
 * WHAT THIS CANNOT DO, so nobody reads it as more than it is:
 *   · It cannot check a claim with no number in it. "Preference is given to EE majors" is invisible
 *     here; 221 of the 850 fields it reaches state no figure at all and this file is silent about
 *     every one of them. `funderVoice.test.ts` is what reads them, and it reads them for voice only.
 *   · It cannot tell a right number in the wrong sentence from a right number in the right one.
 *     A record that says "$25,000 per award" where the page says "$25,000 across all awards" has
 *     every figure on its page and is still wrong.
 *   · It cannot see a figure the funder spelled out — a record writing "$1,000" against a page
 *     writing "one thousand dollars" is reported here as a violation, not passed. That direction is
 *     the safe one: it costs a maintainer a register entry, not a student an application fee.
 *   · It cannot check a record whose source ships no capture (`manual-tier-d`, whose "source text"
 *     is GrantSpotter's own research brief) or that names no source. Those are counted and named
 *     below, never credited as passing.
 *   · The capture is a snapshot. A funder who republishes with new figures is `verify-sources`'
 *     problem, not this file's.
 *
 * WHEN IT FAILS, GO AND READ THE FUNDER'S PAGE. Do not delete the digit, do not round it, and do
 * not invent a replacement — round four of this work "fixed" a correct $500 to an invented $1,000
 * on the strength of a quote that lived in a synthetic `pathological.html` parser fixture, which
 * would have told a Technician-class applicant they were barred from a scholarship open to them.
 * A figure nobody can source is a figure to remove from the sentence, not to replace.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Program, RawOpportunity } from '@grantspotter/core';
import { readDeadlineNote } from '@grantspotter/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCorpus, loadRawOpportunities, type SourceRaws } from '../../../../scripts/profile-corpus.js';
import { programIdFor } from '../sources/util/ids.js';
import { SEED_LAST_VERIFIED, loadSeedCorpus, seedDir } from './load.js';

// ------------------------------------------------------------------ the rule

/**
 * A number as written, matched so a thousands separator joins and a list comma does not.
 *
 * The naive pattern `\d[\d,]*` reads the directive `dates=02-01,04-01,07-01,09-01` as the figures
 * `02`, `01,04`, `01,07`, `01,09` — "one hundred and four" out of two month-days — and then
 * reports three fabrications that are punctuation. A comma is a separator here only between a
 * 1-to-3 digit group and a 3-digit group, which is the only shape a thousands separator takes.
 */
const FIGURE_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/**
 * `$1,285` and `1285` and `01285` are one figure; `12.50` and `12.5` are one figure.
 *
 * Everything this folds is something a page and a curator may spell differently without either of
 * them stating a different quantity. Nothing it folds changes the quantity.
 */
export function normaliseFigure(raw: string): string {
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : raw;
}

/**
 * THE ONE STRING REMOVED BEFORE COUNTING, AND WHY IT IS THE ONLY ONE.
 *
 * `2026-08-02` is `SEED_LAST_VERIFIED` — the date of the research pass every record in this corpus
 * is stamped with, which `validate.ts` requires and which no funder can possibly have printed. Two
 * records date their own reading in prose ("As of 2026-08-02 the scholarship-program page said…",
 * "'Copeland' comes from the 2026-08-02 research pass"), and that is the record being honest about
 * when it looked, not a claim about the funder.
 *
 * It is removed as an EXACT LITERAL, not as a date pattern: a rule that skipped anything shaped
 * like a date would skip every deadline in the corpus, which is most of what this file exists to
 * check. The unit test below pins that narrowness.
 */
export function stripVerificationStamp(text: string): string {
  return text.split(SEED_LAST_VERIFIED).join(' ');
}

/** Every figure a passage states, normalised, in order. */
export function figures(passage: string): string[] {
  return (stripVerificationStamp(passage).match(FIGURE_RE) ?? []).map(normaliseFigure);
}

// ------------------------------------------------------- the fields, and the pages

/** One prose field on one record: the path a maintainer would open, and what it says. */
interface ProseField {
  readonly path: string;
  readonly text: string;
}

/**
 * EVERY SURFACE THAT PUTS A FIGURE IN FRONT OF A STUDENT, AND THE HALF OF THE NOTE THEY READ.
 *
 * The six the brief names — `summary`, the three `obligations` sentences, `deadline.note`,
 * `amount.amountRaw`, `amount.awardCountRaw`, `fundingRestrictions[]` — plus every other rendered
 * field where a number is the reader's business and no other guard reads one:
 *
 *   `constraints[].spec.note`     the IneligibilityDrawer prints it as GrantSpotter's explanation
 *                                 beside the funder's quote. `constraintProvenance.test.ts` checks
 *                                 the QUOTE and says in its header that the note is not its
 *                                 business; the ETP absence-claim that file removed from a quote
 *                                 lives here now, digits and all.
 *   `trust.disputed.note`         the "Disputed" panel.
 *   `trust.staleMirrorWarning`    the stale-mirror banner.
 *   `aiPolicy.quote`              the AI-policy panel's `.verbatim` block.
 *   `obligations.indirectCostCapPct`, `amount.amountMin`, `amount.amountMax`, `amount.tiers[]`
 *                                 numbers, not prose — and rendered as "$500 to $1,000" and
 *                                 "indirect costs capped at 20%" in the two panels a student
 *                                 reads first. A cap or a ceiling the funder never published is
 *                                 the same defect as an invented sentence, so they are checked
 *                                 with the prose rather than left out for being typed as numbers.
 *
 * `deadline.note` really holds `RECUR annual_window tz=America/New_York window=10-30..12-30 | <the
 * prose>`. The directive before the pipe is emitted by `normalize/deadline.ts` and rendered by
 * nobody — `readDeadlineNote` is core's one splitter, and every surface that prints the field goes
 * through it. Checking `10-30` against the funder's page would be checking OUR encoding against
 * their prose. The half after the pipe is what the "When" panel and both spreadsheets print, and
 * that is the half checked here.
 */
function proseFields(program: Program): ProseField[] {
  const out: ProseField[] = [];
  const add = (path: string, text: string | undefined): void => {
    if (text !== undefined && text.trim() !== '') out.push({ path, text });
  };
  const addNumber = (path: string, value: number | undefined): void => {
    if (value !== undefined) out.push({ path, text: String(value) });
  };
  add('summary', program.summary);
  add('deadline.note', readDeadlineNote(program.deadline.note).prose);
  add('amount.amountRaw', program.amount.amountRaw);
  add('amount.awardCountRaw', program.amount.awardCountRaw);
  addNumber('amount.amountMin', program.amount.amountMin);
  addNumber('amount.amountMax', program.amount.amountMax);
  (program.amount.tiers ?? []).forEach((tier, i) => {
    addNumber(`amount.tiers[${String(i)}].count`, tier.count);
    addNumber(`amount.tiers[${String(i)}].amount`, tier.amount);
  });
  add('obligations.licenseObligation', program.obligations.licenseObligation);
  add('obligations.sustainmentObligation', program.obligations.sustainmentObligation);
  add('obligations.reportingObligation', program.obligations.reportingObligation);
  addNumber('obligations.indirectCostCapPct', program.obligations.indirectCostCapPct);
  program.fundingRestrictions.forEach((restriction, i) => {
    add(`fundingRestrictions[${String(i)}]`, restriction);
  });
  for (const constraint of program.constraints) {
    // `note` is on every spec variant that has one; `axis: 'other'` always carries it.
    const note = (constraint.spec as { note?: string }).note;
    add(`constraints[${constraint.id}].spec.note`, note);
  }
  add('trust.disputed.note', program.trust.disputed?.note);
  add('trust.staleMirrorWarning', program.trust.staleMirrorWarning);
  add('aiPolicy.quote', program.aiPolicy.quote);
  return out;
}

/**
 * EVERY FIELD ON A RECORD THAT HOLDS A STRING OR A NUMBER, AND WHY IT IS NOT CHECKED HERE.
 *
 * The named failure mode of `funderVoice.test.ts` is stated in its own header: "IT IS BLIND
 * OUTSIDE `FUNDER_VOICE_SURFACES`. A new funder-voice field added to the record and not to that map
 * is unpoliced." This table is how that does not happen twice. `proseFields` above is walked
 * against the real records, every remaining string- or number-valued path is required to be named
 * here, and a field added to `Program` that is neither checked nor declared fails the test — so the
 * decision to leave a surface unchecked has to be written down, by somebody, on the day.
 */
const NOT_A_FIGURE_SURFACE: Readonly<Record<string, string>> = {
  id: 'a minted identifier',
  funderId: 'a foreign key',
  name: 'the programme’s name as the funder titles it; `arrlCatalog.test.ts` owns it',
  klass: 'an enum',
  applyVia: 'an enum',
  applyUrl: 'a URL; `validate.ts` checks the shape and `verify-sources` checks it resolves',
  applyContact: 'an address or phone number the funder published; not a quantity',
  'tags[]': 'GrantSpotter’s own taxonomy, never rendered as a claim about the funder',
  'applicantEntities[]': 'an enum set the matcher reads; `matcherReading.test.ts` owns it',
  'amount.instrument': 'an enum',
  'deadline.kind': 'an enum',
  'deadline.source.kind': 'an enum',
  'deadline.source.fromProgramId': 'a foreign key',
  'constraints[].id': 'a minted identifier',
  'constraints[].rawText': 'the funder’s verbatim quote — `constraintProvenance.test.ts` checks it word for word',
  rawOtherText: 'the second verbatim panel — `constraintProvenance.test.ts` checks it word for word',
  'constraints[].spec.axis': 'the machine spec the matcher reads, not prose a reader is served',
  'constraints[].spec.allowed[]': 'ditto',
  'constraints[].spec.fields[]': 'ditto',
  'constraints[].spec.excludedFields[]': 'ditto',
  'constraints[].spec.degreeLevels[]': 'ditto',
  'constraints[].spec.stages[]': 'ditto',
  'constraints[].spec.activityKinds[]': 'ditto',
  'constraints[].spec.licenseMin': 'ditto',
  'constraints[].spec.recommenderType': 'ditto',
  'constraints[].spec.orUnrepresented': 'ditto',
  'constraints[].spec.anyOf[].axis': 'ditto, one level down',
  'constraints[].spec.anyOf[].licenseMin': 'ditto, one level down',
  'constraints[].spec.geo.type': 'ditto',
  'constraints[].spec.geo.values[]': 'ditto',
  'constraints[].spec.geo.centerLabel': 'ditto',
  'constraints[].fallbackRank': 'the matcher’s ordering hint; no reader ever sees it',
  // THE NUMBERS IN THE MACHINE SPEC, and why they are a different guard's job. `minYears`,
  // `ageMax`, `heldMonthsMin`, `cwProficiencyWpmMin`, `classRankTopPct`, `min` and the geo radius
  // are read by `matchAll` to DECIDE eligibility; they are not printed to a reader as a claim
  // about the funder, and the sentence they were derived from is `constraints[].rawText`, which
  // `constraintProvenance.test.ts` already checks against the page word for word. A figure rule
  // over them would duplicate that check on a paraphrase of it and disagree with it eventually.
  'constraints[].spec.min': 'a threshold the matcher applies; the sentence behind it is rawText',
  'constraints[].spec.count': 'ditto — how many recommendation letters the axis requires',
  'constraints[].spec.minYears': 'ditto',
  'constraints[].spec.ageMax': 'ditto',
  'constraints[].spec.heldMonthsMin': 'ditto',
  'constraints[].spec.cwProficiencyWpmMin': 'ditto',
  'constraints[].spec.classRankTopPct': 'ditto',
  'constraints[].spec.geo.radiusMiles': 'ditto',
  'constraints[].spec.geo.centerLat': 'a coordinate GrantSpotter geocoded; no funder publishes one',
  'constraints[].spec.geo.centerLon': 'ditto',
  // A DISPUTED CLAIM IS A CLAIM FROM SOMEWHERE ELSE, BY CONSTRUCTION. Each carries its own
  // `sourceUrl` — one of the three in this corpus points at a different ARRL page than the record
  // is keyed to, and says so in its own words ("probably a conflation with the separate ARRL
  // Amateur Radio Grants cycle"). Demanding its figures be on THIS record's capture would fail
  // every disputed claim that does its job. `trust.disputed.note`, the sentence GrantSpotter
  // writes ABOUT the dispute, is checked.
  'trust.disputed.claims[].claim': 'a conflicting claim from the page its own sourceUrl names',
  'trust.disputed.claims[].sourceUrl': 'a URL',
  'aiPolicy.stance': 'an enum',
  'aiPolicy.url': 'a URL',
  'trust.status': 'an enum',
  'trust.sourceUrl': 'a URL',
  'trust.lastVerifiedAt': 'the research-pass stamp `validate.ts` pins to SEED_LAST_VERIFIED',
  'trust.verificationMethod': 'an enum',
  'trust.contentHash': 'computed by `hashProgram` at load; never authored',
};

/**
 * Every path on a record that holds a string or a number, with array indices collapsed to `[]`.
 *
 * Numbers are walked as well as strings: a new numeric field — another cap, another ceiling — is
 * exactly the kind of thing that gets added to the Award panel and checked by nothing.
 */
export function figureBearingPaths(program: Program): Set<string> {
  const paths = new Set<string>();
  const walk = (value: unknown, prefix: string, depth: number): void => {
    if (typeof value === 'string' || typeof value === 'number') {
      paths.add(prefix);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, `${prefix}[]`, depth);
      return;
    }
    if (value !== null && typeof value === 'object' && depth < 4) {
      for (const [key, item] of Object.entries(value)) {
        walk(item, prefix === '' ? key : `${prefix}.${key}`, depth + 1);
      }
    }
  };
  walk(program, '', 0);
  return paths;
}

/** `constraints[etp-k12].spec.note` -> `constraints[].spec.note`, to compare with the walk above. */
function collapseIndices(path: string): string {
  return path.replace(/\[[^\]]*\]/g, '[]');
}

/** Everything the capture says about one record: the parsed page text and every parsed field. */
function sourceTextOf(raw: RawOpportunity): string {
  return [raw.rawText, ...Object.values(raw.rawFields)].join('\n');
}

/**
 * The visible text of a source's committed capture FILES, whitespace-collapsed.
 *
 * Used for ONE purpose: proving that a register entry's quote really is on the page it names. It is
 * deliberately not the haystack of the sweep — see the ZIP-code paragraph in the header — but a
 * register entry names an exact sentence, and an exact sentence on a page is not something a footer
 * address can supply by accident. It also reaches text the parsers drop, which is where two of the
 * ten registered figures live: `arrl-scholarship-descriptions`'s intro dates the cycle, and the
 * parser rejects that block as a stub before any record carries it.
 */
function captureText(sourceId: string): string {
  const dir = resolve(seedDir(), '..', '..', 'fixtures', sourceId);
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => /^\d\d-/.test(f))
    .sort()
    .map((f) => {
      const body = readFileSync(join(dir, f), 'utf8');
      return /\.(html?|xml)$/.test(f)
        ? body.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
        : body;
    })
    .join(' ')
    .replace(/\s+/g, ' ');
}

// ------------------------------------------------------- the corpus, once

interface Checked {
  readonly programId: string;
  readonly field: ProseField;
  /** Figures of the funder capture for THIS record. */
  readonly own: ReadonlySet<string>;
}

interface Sweep {
  readonly checked: Checked[];
  /** Prose fields on records whose source ships no capture of the funder's page. */
  readonly noCapture: Array<{ programId: string; sourceId: string; fields: number }>;
  /** Prose fields on records that name no source at all. */
  readonly noSourceKey: Array<{ programId: string; fields: number }>;
  readonly totalFields: number;
  readonly bySource: SourceRaws[];
}

let sweepCache: Promise<Sweep> | undefined;
async function sweep(): Promise<Sweep> {
  sweepCache ??= (async (): Promise<Sweep> => {
    const { bySource } = await loadRawOpportunities();
    const corpus = loadSeedCorpus();
    const checked: Checked[] = [];
    const noCapture: Sweep['noCapture'] = [];
    const noSourceKey: Sweep['noSourceKey'] = [];
    let totalFields = 0;

    for (const program of corpus.programs) {
      const fields = proseFields(program);
      totalFields += fields.length;
      const key = corpus.sourceKeys.get(program.id);
      if (key === undefined) {
        if (fields.length > 0) noSourceKey.push({ programId: program.id, fields: fields.length });
        continue;
      }
      const source = bySource.find((s) => s.sourceId === key.sourceId);
      if (source === undefined) {
        throw new Error(
          `${program.id} names sourceId "${key.sourceId}", which produced no records from the ` +
            `committed fixtures. Either the source was renamed and this record's sourceKey was ` +
            `not, or its fixture stopped parsing.`,
        );
      }
      if (!source.hasCapture) {
        if (fields.length > 0) {
          noCapture.push({ programId: program.id, sourceId: key.sourceId, fields: fields.length });
        }
        continue;
      }
      const own = source.raws.find((r) => r.externalKey === key.externalKey);
      if (own === undefined) {
        throw new Error(
          `${program.id} names ${key.sourceId}/${key.externalKey}, which that source's parser did ` +
            `not produce from the committed capture.`,
        );
      }
      const ownFigures = new Set(figures(sourceTextOf(own)));
      for (const field of fields) checked.push({ programId: program.id, field, own: ownFigures });
    }
    return { checked, noCapture, noSourceKey, totalFields, bySource };
  })();
  return sweepCache;
}

/** `programId::path::figure` — the identity of one unsourced figure. */
function offendersOf(checked: readonly Checked[]): string[] {
  const out: string[] = [];
  for (const c of checked) {
    for (const figure of new Set(figures(c.field.text))) {
      if (!c.own.has(figure)) out.push(`${c.programId}::${c.field.path}::${figure}`);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

beforeAll(async () => {
  await sweep();
  await loadCorpus();
}, 180_000);

// ------------------------------------------------------ the register

/**
 * THE TEN FIGURES IN THE SHIPPED CORPUS THAT ARE NOT ON THEIR OWN RECORD'S CAPTURED PAGE — every
 * one of them, with the property that IS true of it.
 *
 * A debt register, not a mute list, on the same terms as `constraintProvenance.test.ts`'s: each
 * entry asserts a weaker claim that must hold, and each entry must still be NEEDED — a figure that
 * becomes sourceable on its own page fails the test until its entry is deleted. The register can
 * only shrink, and nothing can be added to it automatically.
 *
 *   `quoted-from`     The figure is inside a sentence a NAMED other capture prints, given here in
 *                     full. Asserted both ways: the quote contains this figure, and the quote is on
 *                     that page. This is a provenance defect of the mild kind — the number is real
 *                     and the record is keyed to the wrong page for it — and a real one: nothing
 *                     re-checks a figure whose page this record does not name.
 *   `derived`         No page prints this figure; GrantSpotter counted it. Re-counted from the
 *                     committed captures on every run by `recompute`, so a derived number cannot
 *                     drift away from the corpus it was derived from and stay green.
 *   `not-a-quantity`  The digits are part of a name, not a stated quantity. The entry names the
 *                     exact token, which must still be in the field.
 *   `off-capture`     The figure comes from something no capture holds, and THE FIELD ITSELF SAYS
 *                     SO. The entry names the disclosure, which must still be in the text — so the
 *                     kind cannot be used to wave through a bare unattributed number.
 */
type Entry =
  | { kind: 'quoted-from'; sourceId: string; quote: string; why: string }
  | { kind: 'derived'; from: string; recompute: (bySource: readonly SourceRaws[]) => number; why: string }
  | { kind: 'not-a-quantity'; token: string; why: string }
  | { kind: 'off-capture'; attribution: string; why: string };

/** Rows of an ARDC award table for one year, as its parser cut them. */
function ardcYear(bySource: readonly SourceRaws[], year: string): RawOpportunity[] {
  const table = bySource.find((s) => s.sourceId === 'ardc-award-tables');
  return (table?.raws ?? []).filter((r) => r.rawFields.year === year);
}

const REGISTER: Record<string, Entry> = {
  // ---- ardc-grants: four figures read off ARDC's award tables, which are a DIFFERENT source.
  // The summary says so in words — "the widest figures in its own 2026 award table" — and the
  // record is keyed to `ardc-grants`, the programme pages. The tables are captured, so each figure
  // is checkable; it is just not checkable where this record points.
  'ardc-grants::summary::1285': {
    kind: 'quoted-from',
    sourceId: 'ardc-award-tables',
    quote: '$1,285',
    why: 'the smallest 2026 ARDC award; printed in the 2026 grants table, not on the apply pages',
  },
  'ardc-grants::summary::258000': {
    kind: 'quoted-from',
    sourceId: 'ardc-award-tables',
    quote: '$258,000',
    why: 'the largest 2026 ARDC award; same table, same reason',
  },
  'ardc-grants::summary::2000': {
    kind: 'quoted-from',
    sourceId: 'ardc-award-tables',
    quote: '$2,000',
    why: 'the low end of the collegiate awards the curator picked out of the tables',
  },
  'ardc-grants::summary::77000': {
    kind: 'quoted-from',
    sourceId: 'ardc-award-tables',
    quote: '$77,000',
    why: 'the high end of the same hand-picked collegiate set — WHICH awards are collegiate is the ' +
      'curator’s judgement and is not checkable here; that the figure is one ARDC printed is',
  },
  // ---- and one ARDC figure that no page prints at all, because it is a count of rows.
  'ardc-grants::amount.awardCountRaw::28': {
    kind: 'derived',
    from: 'ardc-award-tables',
    // "28 awards listed in the 2026 table" — the 2026 table has 41 rows, 13 of which carry no
    // dollar amount ("TBD"). 28 is the number that carry one. Re-counted here so the sentence in
    // the Award panel cannot outlive the table it describes.
    recompute: (bySource) =>
      ardcYear(bySource, '2026').filter((r) => String(r.rawFields.amountRaw ?? '').includes('$')).length,
    why: 'a count of the 2026 table’s rows that state a dollar amount, not a figure ARDC printed',
  },
  // ---- arrl-etp-grants: "US K-12 schools", "Aimed at K-12, not at colleges".
  // The ARRL ETP capture never writes "K-12". It writes "schools in the US", "classroom teachers",
  // "1st grade students". "K-12" is the curator naming a school-level range, not quoting a
  // quantity — but note the second sentence is an ABSENCE claim about colleges, which this file
  // cannot check and `constraintProvenance.test.ts`'s header records as already removed once from
  // the constraint quote for exactly that reason.
  'arrl-etp-grants::summary::12': {
    kind: 'not-a-quantity',
    token: 'K-12',
    why: 'the US school-level idiom, not a figure; the ETP page says "schools", "classroom", "1st grade"',
  },
  // ---- arrl-foundation-scholarships: a count GrantSpotter made, and a cycle two other pages date.
  'arrl-foundation-scholarships::summary::111': {
    kind: 'derived',
    from: 'arrl-scholarship-descriptions',
    // "its own scholarship-descriptions page says 'more than 150' and lists 111 entries" — 111 is
    // the number of scholarship entries that page carries, which is the point of the sentence: it
    // contradicts ARRL's own "more than 170" / "more than 150". Recomputed from the capture.
    // NOTE the trap: `111` IS in that capture file, in ARRL's ZIP code `06111-1400`. A raw-text
    // check would have passed this figure for the wrong reason. See the file header.
    recompute: (bySource) => bySource.find((s) => s.sourceId === 'arrl-scholarship-descriptions')?.raws.length ?? -1,
    why: 'a count of the entries on ARRL’s descriptions page, which prints no such number itself',
  },
  'arrl-foundation-scholarships::deadline.note::30': {
    kind: 'quoted-from',
    sourceId: 'arrl-scholarship-descriptions',
    quote: 'October 30, 2025 to December 30, 2025',
    why: 'the note quotes the descriptions page and says so; this record is keyed to the ' +
      'scholarship-PROGRAM page, whose capture dates nothing',
  },
  'arrl-foundation-scholarships::deadline.note::2025': {
    kind: 'quoted-from',
    sourceId: 'arrl-scholarship-descriptions',
    quote: 'October 30, 2025 to December 30, 2025',
    why: 'the year of that same quoted sentence — and it survives ONLY in the capture file: the ' +
      'descriptions parser rejects the intro block as a stub, so no RawOpportunity carries it',
  },
  'arrl-foundation-scholarships::deadline.note::31': {
    kind: 'quoted-from',
    sourceId: 'qcwa',
    quote: 'October 31',
    why: 'QCWA’s own instruction ("on or after October 31"), reproduced on the ARRL record because ' +
      'the QCWA award is applied for on the ARRL Foundation cycle',
  },
  // ---- the same two ARDC table figures again, on the STRUCTURED fields the Award panel renders
  // as a range. Same evidence, different surface — and worth their own entries, because deleting
  // the summary sentence would not make the rendered "$1,285 to $258,000" sourced.
  'ardc-grants::amount.amountMin::1285': {
    kind: 'quoted-from',
    sourceId: 'ardc-award-tables',
    quote: '$1,285',
    why: 'the Award panel’s floor, read off the 2026 table rather than off the page this record names',
  },
  'ardc-grants::amount.amountMax::258000': {
    kind: 'quoted-from',
    sourceId: 'ardc-award-tables',
    quote: '$258,000',
    why: 'the Award panel’s ceiling, same table, same reason',
  },
  // ---- the ETP idiom again, in the drawer note this time. `constraintProvenance.test.ts`'s header
  // records that this sentence was removed from the constraint QUOTE in a5dda09 for being an
  // absence-claim, and left in the spec note as GrantSpotter's own words. The digits came with it.
  'arrl-etp-grants::constraints[etp-k12].spec.note::12': {
    kind: 'not-a-quantity',
    token: 'K-12',
    why: 'the same school-level idiom as the summary, in the note the drawer prints beside the quote',
  },
  // ---- a figure GrantSpotter reports in order to CONTRADICT it.
  'austin-arc-copeland::trust.staleMirrorWarning::25': {
    kind: 'off-capture',
    attribution: 'Search-engine snippets',
    why: 'the March 25 2026 deadline that stale search snippets still show; the warning exists to ' +
      'say the live club page (May 1 to July 31) wins. A guard that demanded this be on the ' +
      'capture would be demanding the record stop warning about what is not on the capture',
  },
};

// --------------------------------------------------------------- the rule, proven

describe('the figure reader, on passages whose answer is known', () => {
  it('reads money, counts, percentages and dates, and folds the thousands separator', () => {
    expect(figures('up to $25,000 across 3 awards, capped at 20%')).toEqual(['25000', '3', '20']);
    expect(figures('$1,285')).toEqual(['1285']);
    expect(figures('1285')).toEqual(['1285']);
    expect(figures('approximately $3.8 million')).toEqual(['3.8']);
  });

  it('does not read a list comma as a thousands separator, which is how a directive becomes a figure', () => {
    // The naive `/\d[\d,]*/` answers ['2', '104', '107', '109'] here — three fabrications made of
    // punctuation, on the one field where the corpus keeps machine directives.
    expect(figures('dates=02-01,04-01,07-01,09-01')).toEqual(['2', '1', '4', '1', '7', '1', '9', '1']);
  });

  it('strips the research-pass stamp, and ONLY the exact stamp', () => {
    expect(figures(`As of ${SEED_LAST_VERIFIED} the page said`)).toEqual([]);
    // A different date on the same shape is a claim about the funder and is counted.
    expect(figures('As of 2026-08-03 the page said')).toEqual(['2026', '8', '3']);
    expect(stripVerificationStamp('2026-08-021')).toBe(' 1');
  });

  it('treats a figure the page states as sourced and one it does not as unsourced', () => {
    const page = new Set(figures('Awards range from $500 to $1,000. Deadline December 30.'));

    expect(figures('$500 award, closing December 30').every((f) => page.has(f))).toBe(true);
    // The defect this file is named for: the record says $1,500, the page says $500 and $1,000.
    expect(figures('$1,500 award').every((f) => page.has(f))).toBe(false);
  });
});

// --------------------------------------------------------------- the sweep, proven

/**
 * "offenders is empty" over a corpus is worth nothing until something shows the walk would report a
 * real offender. Four guards in this repository have been structurally blind and each passed on its
 * first run. These take a field that PASSES today, damage it the way a curator damages one, and
 * require the same code path to report it.
 */
describe('the corpus sweep would report a defect if the corpus had one', () => {
  async function aFieldWithFigures(): Promise<Checked> {
    const { checked } = await sweep();
    const found = checked.find((c) => {
      const f = figures(c.field.text);
      return f.length > 0 && f.every((x) => c.own.has(x));
    });
    if (found === undefined) throw new Error('no fully sourced prose field to mutate — the sweep found nothing');
    return found;
  }

  it('reports a money figure swapped for one the funder’s page does not carry', async () => {
    const c = await aFieldWithFigures();
    const damaged: Checked = { ...c, field: { ...c.field, text: `${c.field.text} Awards are $91,347.` } };

    expect(offendersOf([c])).toEqual([]);
    expect(offendersOf([damaged])).toEqual([`${c.programId}::${c.field.path}::91347`]);
  });

  it('reports a deadline moved to a day the funder never published', async () => {
    const c = await aFieldWithFigures();
    const damaged: Checked = {
      ...c,
      field: { ...c.field, text: `${c.field.text} Applications close on 27 February 2044.` },
    };

    expect(offendersOf([damaged])).toContain(`${c.programId}::${c.field.path}::2044`);
  });

  it('reports a digit changed inside a figure the page really does state', async () => {
    const { checked } = await sweep();
    const withMoney = checked.find((c) => {
      const f = figures(c.field.text);
      return f.some((x) => Number(x) >= 1000) && f.every((x) => c.own.has(x));
    });
    if (withMoney === undefined) throw new Error('no sourced four-figure amount in the corpus to damage');
    const original = figures(withMoney.field.text).find((x) => Number(x) >= 1000) ?? '';
    // 1,000 -> 4,000: one character, and the only thing that notices is a check on the digits.
    const bent = `${String(Number(original) + 3000)}`;
    const damaged: Checked = {
      ...withMoney,
      field: { ...withMoney.field, text: withMoney.field.text.replace(/\d[\d,]*/, bent) },
    };

    expect(offendersOf([damaged])).toContain(`${withMoney.programId}::${withMoney.field.path}::${bent}`);
  });

  it('does not report a figure the page states in a different notation', async () => {
    const c = await aFieldWithFigures();
    const sourced = figures(c.field.text)[0] ?? '';
    const withCommas = Number(sourced).toLocaleString('en-US');
    const restated: Checked = { ...c, field: { ...c.field, text: `The figure is ${withCommas}.` } };

    expect(offendersOf([restated])).toEqual([]);
  });
});

// --------------------------------------------------------------- the corpus

describe('every figure the seed corpus prints to a student is on that record’s own funder page', () => {
  it('finds no unregistered figure in any rendered prose field or rendered number', async () => {
    const { checked } = await sweep();

    const unregistered = offendersOf(checked).filter((key) => !(key in REGISTER));

    // Equality with the empty list, not a count: the message names the record, the field and the
    // number, which is everything a maintainer needs to open the funder's page.
    expect(unregistered).toEqual([]);
  });

  it('has a register whose every entry is still needed — a sourced figure must be deleted from it', async () => {
    const { checked } = await sweep();
    const live = new Set(offendersOf(checked));

    const stale = Object.keys(REGISTER)
      .filter((key) => !live.has(key))
      .map((key) => `${key} — is now on its own record’s captured page, or gone; delete the register entry`);

    expect(stale).toEqual([]);
  });

  it('holds every `quoted-from` entry to a sentence that really is on the capture it names', async () => {
    const wrong: string[] = [];
    for (const [key, entry] of Object.entries(REGISTER)) {
      if (entry.kind !== 'quoted-from') continue;
      const figure = key.split('::')[2] ?? '';
      // The quote has to be a quote OF THIS FIGURE, or the entry launders an unrelated sentence.
      if (!figures(entry.quote).includes(figure)) {
        wrong.push(`${key} — the registered quote ${JSON.stringify(entry.quote)} does not state ${figure}`);
        continue;
      }
      const page = captureText(entry.sourceId);
      if (page === '') {
        wrong.push(`${key} — names sourceId "${entry.sourceId}", which has no committed capture`);
        continue;
      }
      if (!page.includes(entry.quote)) {
        wrong.push(`${key} — ${JSON.stringify(entry.quote)} is not in fixtures/${entry.sourceId}/`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('recomputes every `derived` entry from the captures and requires the record’s number back', async () => {
    const { bySource } = await sweep();

    const wrong: string[] = [];
    for (const [key, entry] of Object.entries(REGISTER)) {
      if (entry.kind !== 'derived') continue;
      const figure = key.split('::')[2] ?? '';
      const measured = entry.recompute(bySource);
      // A number GrantSpotter counted is only defensible while the count still comes out that way.
      if (String(measured) !== figure) {
        wrong.push(`${key} — the record prints ${figure}; recounting ${entry.from} gives ${String(measured)}`);
      }
    }

    expect(wrong).toEqual([]);
    // Named so this rule cannot pass by having nothing to do.
    expect(Object.values(REGISTER).filter((e) => e.kind === 'derived')).toHaveLength(2);
    // ...and the register as a whole is the fourteen the corpus actually has, not a growing list.
    expect(Object.keys(REGISTER)).toHaveLength(14);
  });

  it('holds every `off-capture` entry to a field that discloses where the figure came from', async () => {
    const { checked } = await sweep();

    const wrong: string[] = [];
    for (const [key, entry] of Object.entries(REGISTER)) {
      if (entry.kind !== 'off-capture') continue;
      const [programId, path] = key.split('::');
      const field = checked.find((c) => c.programId === programId && c.field.path === path);
      if (field === undefined) {
        wrong.push(`${key} — no such field on that record any more; delete the register entry`);
        continue;
      }
      // The disclosure is the whole justification: an unattributed number is not off-capture, it
      // is unsourced.
      if (!field.field.text.includes(entry.attribution)) {
        wrong.push(`${key} — the field no longer discloses ${JSON.stringify(entry.attribution)}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('holds every `not-a-quantity` entry to the token it claims, still in the field', async () => {
    const { checked } = await sweep();

    const wrong: string[] = [];
    for (const [key, entry] of Object.entries(REGISTER)) {
      if (entry.kind !== 'not-a-quantity') continue;
      const [programId, path] = key.split('::');
      const field = checked.find((c) => c.programId === programId && c.field.path === path);
      if (field === undefined) {
        wrong.push(`${key} — no such field on that record any more; delete the register entry`);
        continue;
      }
      if (!field.field.text.includes(entry.token)) {
        wrong.push(`${key} — the field no longer contains ${JSON.stringify(entry.token)}`);
      }
    }

    expect(wrong).toEqual([]);
  });
});

describe('the check cannot go blind by a field being added to the record', () => {
  it('checks or explicitly declines every string- and number-valued field a real record carries', () => {
    const corpus = loadSeedCorpus();
    const checkedPaths = new Set<string>();
    const seenPaths = new Set<string>();
    for (const program of corpus.programs) {
      for (const field of proseFields(program)) checkedPaths.add(collapseIndices(field.path));
      for (const path of figureBearingPaths(program)) seenPaths.add(path);
    }

    // A field on `Program` that this file neither reads nor names is the exact way
    // `funderVoice.test.ts` says a guard of this shape goes blind. There is no third option.
    const undeclared = [...seenPaths]
      .filter((path) => !checkedPaths.has(path) && !(path in NOT_A_FIGURE_SURFACE))
      .sort((a, b) => a.localeCompare(b));
    expect(undeclared).toEqual([]);

    // ...and the table may not accumulate entries for fields the corpus no longer has, or the
    // next author reads it as a list of live decisions when some of it is archaeology.
    const stale = Object.keys(NOT_A_FIGURE_SURFACE)
      .filter((path) => !seenPaths.has(path))
      .sort((a, b) => a.localeCompare(b));
    expect(stale).toEqual([]);

    // A path cannot be both read and declined.
    expect([...checkedPaths].filter((path) => path in NOT_A_FIGURE_SURFACE)).toEqual([]);
  });
});

describe('what the seed corpus puts beyond this check, named rather than counted as passing', () => {
  it('reaches every prose field except the ones on a record with no funder capture and no source', async () => {
    const { checked, noCapture, noSourceKey, totalFields } = await sweep();
    const unreachable =
      noCapture.reduce((n, r) => n + r.fields, 0) + noSourceKey.reduce((n, r) => n + r.fields, 0);

    // If this ever fails the walk is silently skipping records, and "no unregistered figure" is
    // measuring less than it claims.
    expect(checked.length + unreachable).toBe(totalFields);
    // Measured at 3462825: 907 figure-bearing fields, 850 on a record with a capture.
    expect(checked.length).toBeGreaterThanOrEqual(850);
  });

  it('is not vacuous: most of the fields it reaches actually state a figure', async () => {
    const { checked } = await sweep();
    const stated = checked.filter((c) => figures(c.field.text).length > 0);
    const total = checked.reduce((n, c) => n + figures(c.field.text).length, 0);

    // Measured at 3462825: 629 of 850 fields state at least one figure, 944 figures in all. A
    // corpus that stopped printing figures would make this file green and useless; it fails first.
    expect(stated.length).toBeGreaterThanOrEqual(629);
    expect(total).toBeGreaterThanOrEqual(944);
  });

  it('names the records whose source ships no capture of the funder’s own page', async () => {
    const { noCapture } = await sweep();

    // `manual-tier-d` builds its RawOpportunities from an array in the module: its "page" is
    // GrantSpotter's research brief, so a figure "matching" it is our note agreeing with our note.
    expect(noCapture.map((r) => `${r.programId} (${r.sourceId}, ${String(r.fields)})`)).toEqual([
      'yasme-supporting-grants (manual-tier-d, 6)',
      'ncdxf-youth-grant (manual-tier-d, 2)',
      'rca-scholarship-program (manual-tier-d, 3)',
      'rca-youth-activities (manual-tier-d, 2)',
      'nasa-space-grant (manual-tier-d, 5)',
      'campus-sga-playbook (manual-tier-d, 7)',
      'arrl-cari-not-a-funding-program (manual-tier-d, 3)',
      'amsat-no-grants-program (manual-tier-d, 3)',
      'flexradio-no-education-tier (manual-tier-d, 3)',
      'vendor-equipment-relationship-playbook (manual-tier-d, 2)',
      'dara-grantmaker-only-via-arrl (manual-tier-d, 7)',
      'chicago-fm-club-scholarship-discontinued (manual-tier-d, 4)',
      'far-domain-compromised (manual-tier-d, 4)',
    ]);
  });

  it('names the records that print prose but name no source to check it against', async () => {
    const { noSourceKey } = await sweep();

    expect(noSourceKey.map((r) => `${r.programId} (${String(r.fields)})`)).toEqual([
      'austin-arc-greenwood (4)',
      'ieee-mtt-s-student-awards (2)',
    ]);
  });
});

/**
 * THE OTHER CORPUS: the 150 records the extractors build from the same captures.
 *
 * Here a prose field is COMPOSED BY CODE — `normalize/deadline.ts` writes the deadline note,
 * `normalize/axes/**` writes the restrictions — so a figure in one comes from a constant in a
 * module rather than from a curator's reading. That makes this the guard against an extractor that
 * hard-codes a number for a page which does not carry it, which is a defect that reproduces across
 * every record the source ever mints. Measured at 3462825: 535 prose fields, 623 figures, one
 * unsourced.
 */
describe('the fixture corpus, where a prose field is composed by an extractor', () => {
  /**
   * The one figure a module supplies that its own record's page does not carry.
   *
   * `RECURRENCE_BY_SOURCE['arrl-scholarship-program']` writes "Opens about Oct 30 and closes Dec
   * 30" onto every record that source mints, and the scholarship-PROGRAM capture prints no date at
   * all — the dates come from the descriptions page, which the module's own comment says. Registered
   * with the same evidence the seed entry above carries, because it is the same sentence.
   */
  const FIXTURE_REGISTER: Record<string, { sourceId: string; quote: string }> = {
    'arrl-scholarship-program--scholarship-program--7b29405e::deadline.note::30': {
      sourceId: 'arrl-scholarship-descriptions',
      quote: 'October 30, 2025 to December 30, 2025',
    },
  };

  async function fixtureChecked(): Promise<Checked[]> {
    const { bySource } = await sweep();
    const pages = new Map<string, Set<string>>();
    for (const source of bySource) {
      for (const raw of source.raws) {
        pages.set(programIdFor(raw.sourceId, raw.externalKey), new Set(figures(sourceTextOf(raw))));
      }
    }
    const { programs } = await loadCorpus();
    const out: Checked[] = [];
    for (const program of programs) {
      const own = pages.get(program.id);
      if (own === undefined) continue; // the pairing rule below owns this case
      for (const field of proseFields(program)) out.push({ programId: program.id, field, own });
    }
    return out;
  }

  it('pairs every publishable fixture record back to the capture it was cut from', async () => {
    const { bySource } = await sweep();
    const minted = new Set(
      bySource.flatMap((s) => s.raws.map((r) => programIdFor(r.sourceId, r.externalKey))),
    );
    const { programs } = await loadCorpus();

    // Without this the rule below is green when it resolves nothing at all.
    expect(programs.filter((p) => !minted.has(p.id)).map((p) => p.id)).toEqual([]);
    expect(programs.length).toBeGreaterThanOrEqual(150);
  });

  it('composes no prose figure its own record’s page does not carry, but the registered one', async () => {
    const checked = await fixtureChecked();

    expect(offendersOf(checked).filter((k) => !(k in FIXTURE_REGISTER))).toEqual([]);
    // Measured at 3462825: 832 fields, 606 of them stating a figure, 904 figures.
    expect(checked.length).toBeGreaterThanOrEqual(832);
    expect(checked.reduce((n, c) => n + figures(c.field.text).length, 0)).toBeGreaterThanOrEqual(904);
  });

  it('holds the fixture register to the same evidence, and to still being needed', async () => {
    const checked = await fixtureChecked();
    const live = new Set(offendersOf(checked));

    const wrong: string[] = [];
    for (const [key, entry] of Object.entries(FIXTURE_REGISTER)) {
      if (!live.has(key)) wrong.push(`${key} — no longer unsourced; delete the register entry`);
      const figure = key.split('::')[2] ?? '';
      if (!figures(entry.quote).includes(figure)) wrong.push(`${key} — the quote does not state ${figure}`);
      if (!captureText(entry.sourceId).includes(entry.quote)) {
        wrong.push(`${key} — ${JSON.stringify(entry.quote)} is not in fixtures/${entry.sourceId}/`);
      }
    }

    expect(wrong).toEqual([]);
  });
});
