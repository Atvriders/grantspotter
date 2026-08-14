/**
 * A REQUIREMENT PRINTED AS THE FUNDER'S SENTENCE MUST BE A SENTENCE THE FUNDER WROTE.
 *
 * `Opportunity.tsx` renders every constraint's `rawText` inside `<p className="verbatim">`, under a
 * heading that promises "ONE REQUIREMENT, AS THE FUNDER WROTE IT", beside a panel that says
 * "paraphrasing is where a requirement that was never written down gets invented". The only thing
 * standing between that box and an invented quotation is `hasFunderWording` — and its whole body is
 * `constraint.rawText.trim() !== ''` (matcher.ts). Non-empty is the entire test. Nothing in this
 * repository has ever compared a seeded `rawText` to the funder's page.
 *
 * THE ROUND THAT MADE THIS URGENT. A model was given 30 records' unparsed funder text and asked for
 * requirements, under a contract that every asserted fact carry the verbatim sentence it came from.
 * Seven of those sentences were seeded into `data/seed` in be07e0d. The controller checked each new
 * quote byte-for-byte against the text the model was shown — but that check lived in a scratch file
 * in `/tmp`, ran once, and covers only the eight sentences added that day. The other 684 constraints
 * a fresh install serves had never been checked by anything, and the invariant is not "today's
 * extraction was honest", it is "no constraint in the corpus quotes a sentence its funder did not
 * publish". This file is that invariant, over the whole corpus, on every run.
 *
 * WHAT IT MEASURES AGAINST. The repository already holds the funder's own pages: `fixtures/<source>`
 * carries the committed captures, and each seed record names the crawler identity that owns it in
 * `sourceKey: { sourceId, externalKey }`. Running the real source parser over the real capture
 * yields the `RawOpportunity` for that record, and `rawText` + `rawFields` on it is the funder text
 * this record was curated from. That is the "source text on the same record" every rule below is
 * checked against — not a paraphrase of it, not a second copy of the loading rules (the fixture
 * loader is imported from `scripts/profile-corpus.ts`, which is what `npm run profile-corpus` and
 * the two spec-vs-sentence guards already measure with).
 *
 * WHY THE COMPARISON IS OVER WORDS AND NOT BYTES. A curator legitimately drops a footnote asterisk
 * ("an accredited educational institution*"), closes a list item that the page left unpunctuated,
 * or ends a quotation early at a comma. None of those put a word in the funder's mouth. Inventing
 * one does. So the unit is the WORD SEQUENCE, and the property is:
 *
 *      every word of a constraint's rawText is a word the funder's captured page has,
 *      in the order they wrote it, in ONE contiguous run.
 *
 * `runsNeeded` returns 1 for a verbatim quotation, N for one spliced out of N separate passages,
 * and `null` when some word is nowhere on the page — which is the fabrication case and the only one
 * that can put a requirement in front of a student that nobody ever published. Punctuation,
 * capitalisation, curly quotes and footnote markers are invisible to it by construction; a single
 * substituted word is not.
 *
 * MEASURED WHEN THIS FILE WAS WRITTEN, at be07e0d, before the fixes in the same commit:
 *
 *      692 constraints in `data/seed`, of which 685 are checkable
 *      673  verbatim — one contiguous run of the funder's own captured words, on their own record
 *       10  one contiguous run of a SIBLING record of the same capture (YLRL, below)
 *        2  spliced from two passages of their own record's page (Austin ARC, ARISS)
 *        3  CONTAINING WORDS THE FUNDER'S CAPTURED PAGE DOES NOT HAVE  <- the defect
 *
 * THE THREE, NAMED, because they were live on grant.waterburp.com and each was printed to students
 * inside the `.verbatim` box as ARDC's or ARRL's own words:
 *
 *   `ardc-grants` / `ardc-entity`
 *      shipped:  "Applicants are generally US 501(c)(3) nonprofits or international equivalents;
 *                 government entities, schools and universities may apply directly. Clubs and
 *                 individuals must apply through a fiscal sponsor. For-profit entities are not
 *                 eligible."
 *      ARDC:     "To receive an ARDC grant, your organization must be one of the following:
 *                 U.S.-based 501(c)(3) public charity, government agency, school, or university.
 *                 International charity, nonprofit, school, or university. US & international
 *                 for-profit businesses are currently not eligible for ARDC grants."
 *      Four ARDC sentences compressed into three of ours. "generally" is a hedge ARDC never wrote
 *      beside a rule they state flatly.
 *
 *   `arrl-etp-grants` / `etp-k12`
 *      shipped:  "…The programme addresses K-12 classrooms and names no college or university
 *                 track."
 *      A claim about what the page does NOT say, presented as something the page says. An
 *      absence-claim can never be a quotation. It survives in the spec `note`, which the drawer
 *      prints as GrantSpotter's words, and the two ETP paragraphs it was derived from are now the
 *      quote.
 *
 *   `arrl-foundation-scholarships` / `arrl-schol-enrolled`
 *      shipped:  "…Individual catalogue entries name their own institution, accreditation and
 *                 enrolment requirements."
 *      A sentence about THIS PRODUCT'S CATALOGUE, in a box that claims to be quoting the ARRL
 *      Foundation. This is the exact family `funderVoice.test.ts` was written for after two rounds
 *      of it — and it went undetected because that guard's `FUNDER_VOICE_SURFACES` map does not
 *      include `constraints[].rawText`, and because it "HAS NO COPY OF THE FUNDER'S PAGE", as its
 *      own header says. It does now; this file is the copy.
 *
 * All three are replaced in the same commit with the funder's own contiguous sentences, verbatim,
 * for exactly the same specs. No `spec` changed, so no verdict moves: all three are `axis: 'other'`
 * or `institution`, and the matcher never reads `rawText`.
 *
 * WHAT THIS CANNOT DO, stated so nobody reads it as more than it is:
 *   · It cannot check a record whose source has no committed capture. `manual-tier-d` builds its
 *     records from a hand-written array inside the module, so its "source text" is GrantSpotter's
 *     own research brief; checking a quotation against it would be checking our prose against our
 *     prose and calling the pass evidence. Those constraints are counted as UNMEASURABLE below, by
 *     name, never as passing.
 *   · It cannot check a record that names no source at all (`austin-arc-greenwood`). Same: counted,
 *     not credited.
 *   · It cannot notice a quotation lifted from the WRONG PLACE on the right page — the ARISS one
 *     below is real and only visible because it needed two runs. One run from anywhere on the page
 *     passes.
 *   · It cannot judge whether the sentence supports the SPEC beside it. That is
 *     `spec-vs-sentence.test.ts` / `sentence-vs-spec.test.ts` — which, note, read
 *     `scripts/profile-corpus.ts`'s FIXTURE corpus and have never looked at `data/seed` at all.
 *   · The capture is a snapshot. If a funder rewrites their page, this file goes on checking
 *     against the day it was captured; that is `verify-sources` / the crawl's job, not this one.
 */
import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCorpus, loadRawOpportunities } from '../../../../scripts/profile-corpus.js';
import { programIdFor } from '../sources/util/ids.js';
import { loadSeedCorpus } from './load.js';

// ------------------------------------------------------------------ the rule

/**
 * The word sequence of a passage: lowercase, accent-folded, every non-alphanumeric run a boundary.
 *
 * Everything this discards is something a curator may honestly change — case at the start of a
 * quotation, a curly apostrophe the capture decoded differently, a footnote `*`, a bullet's missing
 * full stop, `(parentheses)` reset as a colon. Everything it keeps is a word somebody has to have
 * written.
 */
function words(passage: string): string[] {
  return passage
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/**
 * How many contiguous runs of `haystack`'s words `needle`'s words take, or `null` if some word of
 * `needle` is not in `haystack` at all.
 *
 * 1 = verbatim. 2+ = spliced from that many separate passages. `null` = a word nobody published.
 *
 * Greedy longest-run, found by binary search on the run length: at each position take the longest
 * prefix that still occurs contiguously, then start again after it. Greedy can in principle report
 * one run more than the true minimum, which is safe in the direction that matters — it can only
 * make a quotation look MORE assembled than it is, never more verbatim.
 */
export function runsNeeded(needle: readonly string[], haystack: readonly string[]): number | null {
  if (needle.length === 0) return 0;
  const joined = ` ${haystack.join(' ')} `;
  let at = 0;
  let runs = 0;
  while (at < needle.length) {
    let lo = at;
    let hi = needle.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (joined.includes(` ${needle.slice(at, mid).join(' ')} `)) lo = mid;
      else hi = mid - 1;
    }
    // Not even the single word at `at` occurs: the passage contains a word the page does not.
    if (lo === at) return null;
    at = lo;
    runs += 1;
  }
  return runs;
}

/** Everything the capture says about one record: the parsed page text and every parsed field. */
function sourceTextOf(raw: RawOpportunity): string {
  return [raw.rawText, ...Object.values(raw.rawFields)].join('\n');
}

// ------------------------------------------------------- the corpus, once

interface Checkable {
  programId: string;
  constraint: Constraint;
  /** Words of the funder capture for THIS record. */
  own: string[];
  /** Words of every record the same capture produced, this one included. */
  wholeCapture: string[];
  /** externalKey → words, for naming which sibling a quotation actually came from. */
  siblings: Map<string, string[]>;
}

interface SeedProvenance {
  checkable: Checkable[];
  /** Constraint count on records whose source ships no capture of the funder's page. */
  noCapture: Array<{ programId: string; sourceId: string; constraints: number }>;
  /** Constraint count on records that name no source at all. */
  noSourceKey: Array<{ programId: string; constraints: number }>;
  totalConstraints: number;
}

let seedCache: Promise<SeedProvenance> | undefined;
async function seedProvenance(): Promise<SeedProvenance> {
  seedCache ??= (async (): Promise<SeedProvenance> => {
    const { bySource } = await loadRawOpportunities();
    const corpus = loadSeedCorpus();
    const out: SeedProvenance = {
      checkable: [],
      noCapture: [],
      noSourceKey: [],
      totalConstraints: 0,
    };
    for (const program of corpus.programs) {
      out.totalConstraints += program.constraints.length;
      const key = corpus.sourceKeys.get(program.id);
      if (key === undefined) {
        if (program.constraints.length > 0) {
          out.noSourceKey.push({ programId: program.id, constraints: program.constraints.length });
        }
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
        if (program.constraints.length > 0) {
          out.noCapture.push({
            programId: program.id,
            sourceId: key.sourceId,
            constraints: program.constraints.length,
          });
        }
        continue;
      }
      const own = source.raws.find((r) => r.externalKey === key.externalKey);
      if (own === undefined) {
        throw new Error(
          `${program.id} names ${key.sourceId}/${key.externalKey}, which that source's parser did ` +
            `not produce from the committed capture. A seed record whose crawler identity no ` +
            `longer exists is duplicated on the next crawl (see SeedSourceKey).`,
        );
      }
      const ownWords = words(sourceTextOf(own));
      const wholeCapture = words(source.raws.map(sourceTextOf).join('\n'));
      const siblings = new Map(
        source.raws
          .filter((r) => r.externalKey !== key.externalKey)
          .map((r) => [r.externalKey, words(sourceTextOf(r))] as const),
      );
      for (const constraint of program.constraints) {
        out.checkable.push({
          programId: program.id,
          constraint,
          own: ownWords,
          wholeCapture,
          siblings,
        });
      }
    }
    return out;
  })();
  return seedCache;
}

/**
 * The fixture load is setup for the whole file and is not part of any rule's time budget — the same
 * reasoning, and the same generous hook timeout, as `spec-vs-sentence.test.ts`: re-parsing every
 * committed capture is seconds, and each rule below is milliseconds over the result.
 */
beforeAll(async () => {
  await seedProvenance();
  await loadCorpus();
}, 180_000);

// ------------------------------------------------------ the exception table

/**
 * THE QUOTATIONS THAT ARE NOT ONE VERBATIM RUN OF THEIR OWN RECORD'S PAGE — every one of them, with
 * what it actually is.
 *
 * This is a debt register, not a mute list. Each entry is itself asserted, in both directions:
 *
 *   · the weaker property it claims MUST hold (the words are on a named sibling record of the same
 *     capture; or they are on this record's page in exactly this many runs), so an entry here is
 *     still a byte-level check against the funder, not an exemption from one; and
 *   · the entry must still be NEEDED — a constraint listed here that has become one verbatim run
 *     fails the test and has to be deleted from the table. The register can only shrink.
 *
 * NOTHING IS LISTED HERE FOR THE THIRD CATEGORY. A quotation containing a word the funder's page
 * does not have has no weaker property worth asserting, so there is no way to grandfather one: the
 * three that existed were fixed in the same commit rather than written down here.
 */
interface SplicedQuote {
  runs: number;
  why: string;
}

/**
 * Quotations assembled from more than one passage of their OWN record's captured page.
 *
 * Both are real defects of a milder kind — a reader takes an assembled quotation for a continuous
 * one — and both are curation work (re-cut the quote, or split the constraint in two) rather than
 * anything a test can fix.
 */
const SPLICED_FROM_OWN_PAGE: Record<string, SplicedQuote> = {
  // ARISS's page puts "…into a well-developed education plan." in the intro and "potential audience
  // size (we are looking to engage an entire school or organization, NOT just a single classroom)"
  // much further down, inside the evaluation-criteria list — with the "must demonstrate
  // flexibility" requirement in between. The seeded quote reads as one continuous ARISS paragraph
  // and is two, with the parenthesis reset as a colon.
  'ariss-iss-contact::ariss-education-plan': {
    runs: 2,
    why: 'intro sentence + a bullet from the evaluation-criteria list further down the same page',
  },
  // "Students pursuing higher education or skilled trades — engineering, computer science, public
  // service, healthcare, and more." is verbatim; the sentence after it on the page is "Where you
  // live…", and the "Students are encouraged to apply to all scholarships for which they are
  // eligible" sentence comes from elsewhere in the same capture.
  'austin-arc-copeland::austin-copeland-audience': {
    runs: 2,
    why: 'the audience sentence + an encouragement sentence from another part of the same page',
  },
};

/**
 * Quotations that are verbatim, but on a SIBLING record of the same capture rather than on their own.
 *
 * All ten are YLRL. `ylrl.ts` parses the "Scholarship Requirements" block — which the page states
 * ONCE and applies to all three named scholarships — into a single `ylrl-scholarships` record, and
 * the three per-scholarship seed records quote it. The funder did publish every one of these
 * sentences about these scholarships, so this is an attribution shape, not an invention; it is
 * listed rather than waved through because "the sentence is somewhere on the site" is a materially
 * weaker claim than "the sentence is on this record's page", and the difference is exactly how a
 * requirement gets attached to a programme it was never written about.
 */
const VERBATIM_ON_SIBLING: Record<string, string> = {
  'ylrl-ethel-smith-k4lmb::ylrl-k4lmb-license': 'ylrl-scholarships',
  'ylrl-ethel-smith-k4lmb::ylrl-k4lmb-study': 'ylrl-scholarships',
  'ylrl-ethel-smith-k4lmb::ylrl-k4lmb-member': 'ylrl-scholarships',
  'ylrl-mary-lou-brown-nm7n::ylrl-nm7n-license': 'ylrl-scholarships',
  'ylrl-mary-lou-brown-nm7n::ylrl-nm7n-study': 'ylrl-scholarships',
  'ylrl-mary-lou-brown-nm7n::ylrl-nm7n-member': 'ylrl-scholarships',
  'ylrl-marte-wessel-k0epe::ylrl-k0epe-license': 'ylrl-scholarships',
  'ylrl-marte-wessel-k0epe::ylrl-k0epe-institution': 'ylrl-scholarships',
  'ylrl-marte-wessel-k0epe::ylrl-k0epe-study': 'ylrl-scholarships',
  'ylrl-marte-wessel-k0epe::ylrl-k0epe-member': 'ylrl-scholarships',
};

const keyOf = (c: Checkable): string => `${c.programId}::${c.constraint.id}`;

// --------------------------------------------------------------- the rules

describe('the rule itself, proven on passages whose answer is known', () => {
  const page = words(
    'Applicants must hold a General class licence. Preference will be given to YLRL members.',
  );

  it('answers 1 for a passage the page carries whole', () => {
    expect(runsNeeded(words('Preference will be given to YLRL members.'), page)).toBe(1);
  });

  it('ignores case, curly quotes, footnote markers and a supplied full stop', () => {
    expect(runsNeeded(words('preference will be given to YLRL members'), page)).toBe(1);
    expect(runsNeeded(words('“Applicants must hold a General class licence*”'), page)).toBe(1);
  });

  it('answers 2 for a passage spliced out of two separate places on the page', () => {
    // Both halves are verbatim; the ORDER is the curator's. A reader takes this for one paragraph.
    expect(
      runsNeeded(
        words('Preference will be given to YLRL members. Applicants must hold a General class licence.'),
        page,
      ),
    ).toBe(2);
  });

  it('answers null when one single word was never published — the fabrication case', () => {
    expect(runsNeeded(words('Applicants must hold an Extra class licence.'), page)).toBeNull();
    expect(runsNeeded(words('Preference will be given to ARRL members.'), page)).toBeNull();
  });
});

/**
 * THE SWEEP IS LIVE, PROVEN ON THE REAL CORPUS RATHER THAN ON A TOY PAGE.
 *
 * "offenders is empty" over a corpus is worth nothing until something shows the walk would report a
 * real offender — the standard `spec-vs-sentence.test.ts` sets, and the reason every rule there
 * carries its own mutation proof. These take a constraint that PASSES today, damage its `rawText`
 * in the three ways this file exists to catch, and require the same code path to report each one.
 */
describe('the corpus sweep would report a defect if the corpus had one', () => {
  async function aVerbatimConstraint(): Promise<Checkable> {
    const { checkable } = await seedProvenance();
    const found = checkable.find(
      (c) => runsNeeded(words(c.constraint.rawText), c.own) === 1 && words(c.constraint.rawText).length > 12,
    );
    if (found === undefined) throw new Error('no verbatim seed constraint to mutate — the sweep found nothing');
    return found;
  }

  it('reports one substituted word in an otherwise verbatim funder sentence', async () => {
    const c = await aVerbatimConstraint();
    const damaged = [...words(c.constraint.rawText)];
    damaged[Math.floor(damaged.length / 2)] = 'notarealwordonthispage';

    expect(runsNeeded(damaged, c.own)).toBeNull();
  });

  it('reports a whole clause of GrantSpotter’s own the way the three fixed today read', async () => {
    const c = await aVerbatimConstraint();
    const damaged = words(`${c.constraint.rawText} The programme names no college or university track.`);

    expect(runsNeeded(damaged, c.own)).toBeNull();
  });

  it('reports a quotation reassembled out of order, which reads as one passage and is two', async () => {
    const c = await aVerbatimConstraint();
    const w = words(c.constraint.rawText);
    const cut = Math.floor(w.length / 2);
    const spliced = [...w.slice(cut), ...w.slice(0, cut)];

    expect(runsNeeded(spliced, c.own)).toBeGreaterThan(1);
  });
});

describe('every constraint the seed corpus ships quotes text its own funder capture carries', () => {
  it('finds no constraint carrying a word the funder’s captured page does not have', async () => {
    const { checkable } = await seedProvenance();
    const fabricated = checkable
      .filter((c) => runsNeeded(words(c.constraint.rawText), c.wholeCapture) === null)
      .map((c) => `${keyOf(c)} — ${JSON.stringify(c.constraint.rawText.slice(0, 160))}`);

    // Not "the extraction was honest" — every constraint in the corpus, on every run. The `.verbatim`
    // box promises the funder wrote this; `hasFunderWording` only checks it is not empty.
    expect(fabricated).toEqual([]);
  });

  it('finds every constraint outside the register to be ONE verbatim run of its own record’s page', async () => {
    const { checkable } = await seedProvenance();
    const offenders = checkable
      .filter((c) => !(keyOf(c) in SPLICED_FROM_OWN_PAGE) && !(keyOf(c) in VERBATIM_ON_SIBLING))
      .map((c) => ({ key: keyOf(c), runs: runsNeeded(words(c.constraint.rawText), c.own) }))
      .filter((r) => r.runs !== 1);

    expect(offenders).toEqual([]);
  });

  it('has a register whose every entry is still needed — a fixed quotation must be deleted from it', async () => {
    const { checkable } = await seedProvenance();
    const byKey = new Map(checkable.map((c) => [keyOf(c), c]));

    const stale: string[] = [];
    for (const key of [...Object.keys(SPLICED_FROM_OWN_PAGE), ...Object.keys(VERBATIM_ON_SIBLING)]) {
      const found = byKey.get(key);
      if (found === undefined) {
        stale.push(`${key} — no such constraint in the seed corpus; delete the register entry`);
        continue;
      }
      if (runsNeeded(words(found.constraint.rawText), found.own) === 1) {
        stale.push(`${key} — is now one verbatim run of its own page; delete the register entry`);
      }
    }

    expect(stale).toEqual([]);
  });

  it('holds each spliced quotation to exactly the number of passages the register admits', async () => {
    const { checkable } = await seedProvenance();
    const byKey = new Map(checkable.map((c) => [keyOf(c), c]));

    const wrong: string[] = [];
    for (const [key, entry] of Object.entries(SPLICED_FROM_OWN_PAGE)) {
      const found = byKey.get(key);
      if (found === undefined) continue; // the register-is-current rule above owns this case
      const runs = runsNeeded(words(found.constraint.rawText), found.own);
      // A quote growing from two passages to three is a new defect wearing an old exemption.
      if (runs !== entry.runs) wrong.push(`${key} — register says ${entry.runs} passage(s), measured ${String(runs)}`);
    }

    expect(wrong).toEqual([]);
  });

  it('holds each sibling-attributed quotation to being verbatim on the sibling the register names', async () => {
    const { checkable } = await seedProvenance();
    const byKey = new Map(checkable.map((c) => [keyOf(c), c]));

    const wrong: string[] = [];
    for (const [key, siblingKey] of Object.entries(VERBATIM_ON_SIBLING)) {
      const found = byKey.get(key);
      if (found === undefined) continue;
      const sibling = found.siblings.get(siblingKey);
      if (sibling === undefined) {
        wrong.push(`${key} — register names sibling "${siblingKey}", which this capture does not produce`);
        continue;
      }
      // The weaker claim, still measured: the funder published this sentence, on that page.
      const runs = runsNeeded(words(found.constraint.rawText), sibling);
      if (runs !== 1) wrong.push(`${key} — not one verbatim run of ${siblingKey}: ${String(runs)}`);
    }

    expect(wrong).toEqual([]);
  });
});

describe('what the seed corpus puts beyond this check, named rather than counted as passing', () => {
  it('reaches every constraint except the ones on a record with no funder capture and no source', async () => {
    const { checkable, noCapture, noSourceKey, totalConstraints } = await seedProvenance();
    const unreachable =
      noCapture.reduce((n, r) => n + r.constraints, 0) +
      noSourceKey.reduce((n, r) => n + r.constraints, 0);

    // Every constraint is accounted for in exactly one bucket: if this ever fails, the walk above
    // is silently skipping records and the "0 fabricated" result is measuring less than it claims.
    expect(checkable.length + unreachable).toBe(totalConstraints);
    // Measured at be07e0d: 692 constraints, 685 of them checkable.
    expect(checkable.length).toBeGreaterThanOrEqual(685);
  });

  it('names the records whose source ships no capture of the funder’s own page', async () => {
    const { noCapture } = await seedProvenance();

    // `manual-tier-d` builds its RawOpportunities from an array in the module: its `rawText` is
    // GrantSpotter's research brief, so a quotation "matching" it is our prose agreeing with our
    // prose. These are unmeasurable, and the day one of these funders gets a real capture the
    // record moves into the checked set — which is why they are listed by name, not by count.
    expect(noCapture.map((r) => `${r.programId} (${r.sourceId}, ${r.constraints})`)).toEqual([
      'yasme-supporting-grants (manual-tier-d, 1)',
      'rca-scholarship-program (manual-tier-d, 2)',
      'nasa-space-grant (manual-tier-d, 1)',
      'dara-grantmaker-only-via-arrl (manual-tier-d, 1)',
    ]);
  });

  it('names the records that carry constraints but name no source to check them against', async () => {
    const { noSourceKey } = await seedProvenance();

    expect(noSourceKey.map((r) => `${r.programId} (${r.constraints})`)).toEqual([
      'austin-arc-greenwood (2)',
    ]);
  });
});

/**
 * THE OTHER CORPUS, AND THE ONE THIS ROUND'S NUMBERS WERE ALL MEASURED ON.
 *
 * `scripts/profile-corpus.ts` builds 150 publishable records by running the source parsers and
 * `normalize/axes/**` over the same captures. Those constraints are CUT from the page by the
 * extractors, so verbatim is what they are by construction — which makes 0 the only acceptable
 * answer here, with no register at all, and makes this the guard against an extractor that starts
 * composing text instead of quoting it. Measured at be07e0d: 150 records, 652 constraints, 0.
 */
describe('the fixture corpus, where a constraint is cut from the page rather than curated', () => {
  /**
   * The capture each publishable fixture record was cut from, keyed the way `normalizeRaw` keys the
   * record itself — `programIdFor(sourceId, externalKey)`, the product's own minting function, not
   * a name or URL match that would quietly resolve to the wrong sibling.
   */
  async function pageByProgramId(): Promise<Map<string, string[]>> {
    const { bySource } = await loadRawOpportunities();
    const out = new Map<string, string[]>();
    for (const source of bySource) {
      for (const raw of source.raws) {
        out.set(programIdFor(raw.sourceId, raw.externalKey), words(sourceTextOf(raw)));
      }
    }
    return out;
  }

  it('pairs every publishable fixture record back to the capture it was cut from', async () => {
    const pages = await pageByProgramId();
    const { programs } = await loadCorpus();

    // Without this the rule below is green when it resolves nothing at all.
    expect(programs.filter((p) => !pages.has(p.id)).map((p) => p.id)).toEqual([]);
    expect(programs.length).toBeGreaterThanOrEqual(150);
  });

  it('carries no constraint whose rawText is not a verbatim run of the record it was cut from', async () => {
    const pages = await pageByProgramId();
    const { programs } = await loadCorpus();

    const offenders: string[] = [];
    let checked = 0;
    for (const program of programs) {
      const page = pages.get(program.id);
      if (page === undefined) continue; // named by the pairing rule above
      for (const constraint of program.constraints) {
        checked += 1;
        if (runsNeeded(words(constraint.rawText), page) !== 1) {
          offenders.push(`${program.id}::${constraint.id} — ${JSON.stringify(constraint.rawText.slice(0, 160))}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(652);
  });
});
