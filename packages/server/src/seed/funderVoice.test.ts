/**
 * NOTHING THE PRODUCT PRESENTS AS THE FUNDER'S OWN WORDS MAY BE GRANTSPOTTER TALKING.
 *
 * The opportunity page reproduces `rawOtherText` under the heading "Unstructured requirements,
 * verbatim", in the same monospaced `.verbatim` box it uses for a funder's sentence, introduced
 * with a promise:
 *
 *   "Text from the source that no field on this page models. It is reproduced exactly, because
 *    paraphrasing is where a requirement that was never written down gets invented."
 *
 * TWO ROUNDS OF THIS DEFECT, AND THE SECOND IS WHY THIS FILE LOOKS THE WAY IT DOES.
 *
 *   ROUND ONE (2026-08-13, fixed in f466f8e). The shipped ARRL Club Grant record answered that
 *   promise with this project's development notes — a spec section number, the ingestion
 *   pipeline's override behaviour, a `(sourceId, externalKey)` pair, "NOT ASSERTED HERE". Twenty-
 *   nine of the thirty-two hand-curated records carried the same shape. The guard written that day
 *   listed the MACHINE TELLS below: backticks, `snake_case`, `§`, the literal word GrantSpotter.
 *
 *   ROUND TWO (2026-08-13, this file). The same record was rewritten until that guard went quiet,
 *   and the panel still was not verbatim. What it printed instead was:
 *
 *     "This programme is funded by ARDC: the page thanks Amateur Radio Digital Communications for
 *      providing the funding … If you want an ARRL organisation grant with a published, verifiable
 *      window right now, the ARRL Amateur Radio Grants programme is the one with dates on its
 *      page."
 *
 *   Sentence one is a description OF the page, not text FROM it. Sentence two is GrantSpotter
 *   recommending a different programme, inside a panel that claims to be quoting the funder.
 *   Not one machine token in either. THE WORDS MOVED; THE VOICE DID NOT.
 *
 * SO THIS FILE CHECKS VOICE, NOT VOCABULARY. A forbidden-token list catches the author who writes
 * `snake_case` and misses the author who writes well, and the second author is the one who ships.
 * What is actually detectable, and what the four families below are:
 *
 *   META      The sentence takes the source as its OBJECT — "the page states", "the captured
 *             page", "appears zero times", "document-level on the YLRL page". A funder writes
 *             about their grant; only a reader of their page writes about their page.
 *   ADVICE    Second person or an imperative addressed to the APPLICANT ABOUT USING THIS RECORD —
 *             "do not infer one", "confirm before you budget", "your campus will differ". Funders
 *             write "you" constantly, so bare second person is not a tell; second person aimed at
 *             the reader's own institution or at the act of trusting the record is.
 *   PIPELINE  Hedges about how the record was MADE — "the 2026-08-02 research pass", "could not be
 *             resolved", "robots.txt", "not from a live read".
 *   CROSSREF  A recommendation cue plus the NAME OF ANOTHER PROGRAMME OR FUNDER IN THIS CORPUS.
 *             This one is computed against the corpus rather than pattern-matched, which is what
 *             makes it a voice check: no funder's page recommends a competitor by name, and the
 *             set of names is exactly the set this product knows about.
 *
 * WHAT THIS CHECK CANNOT DO. Stated plainly, because a guard that overstates its reach is how the
 * last one shipped:
 *
 *   · IT HAS NO COPY OF THE FUNDER'S PAGE. It cannot confirm that a sentence appears on it. A
 *     fluent invention written in a funder's register — "Applicants must hold a General class
 *     licence" on a page that says no such thing — passes every rule here. `validate.ts`'s
 *     provenance rules, the side-car `evidence` quotes and the research pass are what cover that.
 *   · IT CANNOT SEE A PARAPHRASE. Real page content reworded into smoother prose is still a
 *     fabricated quotation and still passes.
 *   · IT CANNOT SEE CROSS-CONTAMINATION between records unless the borrowed text happens to name
 *     another programme in the corpus. A requirement lifted from the wrong ARRL page reads clean.
 *   · IT IS BLIND OUTSIDE `FUNDER_VOICE_SURFACES`. A new funder-voice field added to the record
 *     and not to that map is unpoliced; the second test below is the only thing that notices.
 *   · IT CAN BE WRONG IN THE OTHER DIRECTION. A funder who genuinely writes "this page is updated
 *     each August" trips META. THE REMEDY IS TO MOVE THE SENTENCE OR TO NAME IT HERE AS A KNOWN
 *     EXCEPTION — never to relax a family until the corpus passes, which converts a defect into a
 *     green tick and is exactly the failure mode this file exists to make expensive.
 *
 * WHEN IT FAILS, MOVE THE SENTENCE, DO NOT REWORD IT. `summary`, `deadline.note`,
 * `trust.disputed.note` and `trust.staleMirrorWarning` are the record's own authored voice, for
 * anything a STUDENT needs; the writing-desk overlays in `content/templates/funders/` are the
 * attributed home for advice; `data/seed/MAINTAINER-NOTES.md` is for curation rationale nobody but
 * a maintainer needs. Rewording until the detector goes quiet is round two, and it happened.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedDir } from './load.js';

/**
 * A field the product renders as the funder's own words, and where it renders it.
 *
 * `summary`, `deadline.note`, `trust.disputed.note` and `trust.staleMirrorWarning` are absent on
 * purpose — the page presents those as GrantSpotter's own voice, and a record that says "the cycle
 * could not be resolved and this record does not guess" is being honest with a student there, not
 * misattributing.
 */
const FUNDER_VOICE_SURFACES: Readonly<Record<string, string>> = {
  rawOtherText: 'Opportunity.tsx renders it under "Unstructured requirements, verbatim".',
  'constraints[].rawText': 'RequirementQuote and IneligibilityDrawer render it in a .verbatim quote block.',
  'aiPolicy.quote': 'The "This funder\'s AI policy" panel renders it in a .verbatim block.',
  'amount.amountRaw': 'The Award panel renders it under "Amount, verbatim".',
  'amount.awardCountRaw': 'The Award panel renders it under "Number of awards".',
  'fundingRestrictions[]': 'The "Funding restrictions" panel lists it as the funder\'s restriction.',
  'obligations.licenseObligation': 'The "Obligations if you win" panel prints the funder\'s own words.',
  'obligations.sustainmentObligation': 'The "Obligations if you win" panel prints the funder\'s own words.',
  'obligations.reportingObligation': 'The "Obligations if you win" panel prints the funder\'s own words.',
  'evidence.obligations[].quote': 'The side-car quote that vouches for an obligation, shown as provenance.',
};

/** One string on one record, with the path a maintainer would open. */
interface Field {
  readonly file: string;
  readonly recordId: string;
  /** Key into FUNDER_VOICE_SURFACES. */
  readonly surface: string;
  /** The concrete path, with the index filled in. */
  readonly path: string;
  readonly text: string;
}

interface Tell {
  readonly family: 'MACHINE' | 'META' | 'ADVICE' | 'PIPELINE';
  readonly name: string;
  readonly re: RegExp;
}

/**
 * FAMILY 1 — MACHINE. The round-one tells, kept whole. Each is a shape a funder writing about
 * their own grant has no reason to produce and that this project's notes produce constantly.
 * Cheap, literal, and still the fastest way to catch a note pasted straight out of a plan.
 */
const MACHINE_TELLS: readonly Tell[] = (
  [
    { name: 'names GrantSpotter', re: /grantspotter/i },
    { name: 'cites the spec or the contract', re: /\b(?:spec|contract|resolutions?)\s*§|§\s*\d/i },
    { name: 'cites a task or plan number', re: /\b(?:task|plan)\s+\d+\b/i },
    { name: '"NOT ASSERTED"', re: /\bnot asserted\b/i },
    {
      name: 'talks about the record or the corpus rather than the programme',
      re: /\bthis (?:record|entry|corpus|pipeline|repository|repo|codebase|project|installation|batch|module|parser|crawler|tool|file)\b/i,
    },
    { name: 'names the ingestion pipeline', re: /\bingestion pipeline\b|\bthe pipeline\b/i },
    { name: 'names a curated override', re: /\bcurated override\b/i },
    { name: '"cross-contamination"', re: /\bcross-contamination\b/i },
    {
      name: 'names crawling machinery',
      re: /\bre-crawl\b|\bcrawler\b|\bcrawled\b|\bnightly crawl\b|\bchange detector\b|\bsource module\b|\bthe matcher\b|\bpolling target\b/i,
    },
    { name: 'names a fixture or a source file', re: /\bfixtures?\/[\w./-]+|\b[\w-]+\.test\.ts\b|\bdata\/seed\b/i },
    { name: 'names the seed corpus', re: /\bseed (?:record|corpus|import)\b/i },
    { name: 'addresses a maintainer', re: /\bmaintainer\b/i },
    { name: 'cites a test as the reason', re: /\bthere is a test\b|\bthe test that proves\b/i },
    /*
     * The two structural tells. A funder's page does not print backticked identifiers or
     * snake_cased machine tokens; every one of those in this corpus was a field name, an enum
     * member or a database column that leaked out of a note. `contest_style` words a funder might
     * plausibly write (`wp-content`, `e-mail`) are hyphenated, not underscored.
     */
    { name: 'quotes an identifier in backticks', re: /`[A-Za-z_][A-Za-z0-9_.]*`/ },
    { name: 'prints a snake_case machine token', re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/ },
  ] as const
).map((t) => ({ family: 'MACHINE' as const, ...t }));

/**
 * The reporting verbs that turn a noun into a sentence ABOUT that noun. "The page STATES", "the
 * entry LISTS", "its guidelines page CARRIES". Kept in one place because all three META patterns
 * that need it need the same list.
 */
const REPORTS =
  '(?:states?|stated|publishes?|published|says?|said|carr(?:ies|y|ied)|lists?|listed|shows?|showed|contains?|names?|named|mentions?|reads?|is|was|does not|doesn\'t|offers?|returns?|issues?|links?|describes?|spells?|stops?|begins?|appears?|thanks?|thanked|credits?|acknowledges?|prints?|printed|had|has|have|only)';

/**
 * FAMILY 2 — META. The sentence takes the SOURCE as its object rather than the programme as its
 * subject. This is the family that caught the round-two rewrite: "the page thanks Amateur Radio
 * Digital Communications" is a fact about a web page, and a funder does not write it.
 */
const META_TELLS: readonly Tell[] = (
  [
    {
      name: 'makes the source page or the record the object of the sentence',
      re: new RegExp(
        `\\b(?:the|this|its|whose|that)\\s+(?:[a-z'’-]+\\s+){0,3}(?:page|pages|site|website|record|entry|listing|capture|portal)\\b[^.]{0,45}?\\b${REPORTS}\\b`,
        'i',
      ),
    },
    { name: 'names the page in its captured, crawled or mirrored form', re: /\bthe (?:captured|shipped|fetched|crawled|committed|mirrored|read)\s+[a-z]+/i },
    { name: 'counts how often a word occurs on the page', re: /\bappears? (?:zero times|nowhere)\b|\bappears? on no\b|\bzero mentions?\b|\bnot a single\b/i },
    { name: 'calls its own text verbatim, or quotes the page as a page', re: /\bverbatim\b|\bin the page(?:'|’)s own\b|\bits own words\b|\bown words on\b/i },
    {
      name: 'describes where text sits on the page rather than what it says',
      re: /\b(?:document-level|page-level|on (?:that|the captured|the same) page|elsewhere on the page|the page(?:'|’)s own|in the page(?:'|’)s|at the top of the page|appears anywhere on)\b/i,
    },
    /*
     * "Not published." in a field reserved for what the funder DID publish is the softest member
     * of this family and the most common: 24 award fields carried it. The product already has the
     * right representation — an EMPTY string, which `orNotStated` renders as the app's own "Not
     * stated" — and the generated ARRL catalogue already keeps that convention ("an entry whose
     * page states no count keeps the empty string rather than a sentence we wrote").
     */
    {
      name: 'reports the source\'s silence instead of leaving the field empty',
      re: /\bnot published\b|\bno(?:ne)? (?:is |are |amount |cash |dollar )?[a-z ]{0,20}published\b|\bnot stated\b|\bpublishes no\b|\bstates no\b|\bno page states\b/i,
    },
  ] as const
).map((t) => ({ family: 'META' as const, ...t }));

/**
 * FAMILY 3 — ADVICE. Second person or an imperative aimed at the applicant's own situation, or at
 * the act of trusting this record.
 *
 * BARE SECOND PERSON IS DELIBERATELY NOT A TELL, and this is the calibration that decides whether
 * the family survives contact with the corpus. Funders write "you" constantly — ARDC's AI policy
 * opens "If you choose to use AI when writing your proposal", NCDXF's age rule opens "If you are a
 * licensed amateur radio operator 25 years of age or younger", IEEE MTT-S writes "your chapter's
 * past year's activities". All three are real funder text shipped in `data/seed/` and all three
 * must pass. What does not appear in any of them is the reader's OWN CAMPUS, OWN STATE or OWN
 * ADVISOR, or an instruction about what to infer from the record.
 */
const ADVICE_TELLS: readonly Tell[] = (
  [
    { name: 'tells the applicant what not to infer, trust or do with the record', re: /\b(?:do not|don't|don’t|never)\s+(?:\w+\s+){0,2}(?:infer|assume|guess|visit|rely|trust|transcribe|budget|send|ask|use)\b/i },
    { name: 'tells the applicant to check something before applying', re: /\bbefore (?:you (?:apply|spend|rely|budget|quote|decide)|applying|you )|\b(?:verify|confirm|re-?check|double-check)\b[^.]{0,70}\bbefore\b/i },
    { name: 'opens a conditional addressed to the reader', re: /\bif you (?:want|are looking for|need|find)\b/i },
    { name: 'addresses the reader\'s own institution or circumstances', re: /\byour (?:campus|state|state(?:'|’)s|faculty|advisor|counsell?or|section manager|callsign)\b|\byours may differ\b|\bwill differ\b/i },
    {
      name: 'opens a sentence with an imperative of advice',
      re: /(?:^|[.;)—]\s+|\n)\s*(?:Do not|Don't|Don’t|Never|Budget for|Confirm|Verify|Look up|Frame|Track your|Go to|Approach|Bring your|Offer what|Respect|Start from|Search the|Get the|Ask your|Read their|Check whether)\b/,
    },
  ] as const
).map((t) => ({ family: 'ADVICE' as const, ...t }));

/**
 * FAMILY 4 — PIPELINE. Hedges about how the record was made: when it was read, what could not be
 * read, and what the fetcher hit on the way.
 */
const PIPELINE_TELLS: readonly Tell[] = (
  [
    { name: 'dates the claim to a research pass', re: /\bresearch pass\b|\bstatus as of\b|\bas of (?:the )?\d{4}-\d{2}-\d{2}\b|\b\d{4}-\d{2}-\d{2} (?:pass|research)\b|\bverified in the\b/i },
    { name: 'says a fact could not be established', re: /\bcould not be (?:verified|checked|resolved|determined|read|established)\b|\bwere? not verified\b|\bnothing (?:was )?found\b|\bcannot be determined\b|\bnot verified\b/i },
    {
      name: 'names fetching machinery',
      re: /\brobots\.txt\b|\bsitemap\.xml\b|\bnon-browser\b|\buser agent\b|\bsearch snippets?\b|\blive read\b|\bmachine-readable\b|\bserver-side text\b|\bsingle-page app\b|\bexposes no (?:API|RSS)\b|\bHTTP \d{3}\b|\b\d{3}s (?:to|non-browser)\b|\bquery-string URLs?\b/i,
    },
    /*
     * NOT a bare "we": the funder's own "we" is everywhere in this corpus and is correct there —
     * NCDXF's restriction reads "we do not consider commercially available transportation costs",
     * ARDC's licence obligation reads "we require that the work … be freely available". Only the
     * research team's "we" is a tell, and it is identifiable by what it is doing.
     */
    { name: 'speaks as the people who made the record', re: /\bthis pipeline\b|\b(?:two|three|four) researchers\b|\bthe research (?:pass|found|recorded)\b|\bwe do not spoof\b|\bnot from a live read\b/i },
  ] as const
).map((t) => ({ family: 'PIPELINE' as const, ...t }));

const TELLS: readonly Tell[] = [...MACHINE_TELLS, ...META_TELLS, ...ADVICE_TELLS, ...PIPELINE_TELLS];

function tellsIn(text: string): string[] {
  return TELLS.filter((t) => t.re.test(text)).map((t) => `${t.family}: ${t.name}`);
}

function familiesIn(text: string): string[] {
  return [...new Set(TELLS.filter((t) => t.re.test(text)).map((t) => t.family))].sort();
}

/**
 * FAMILY 5 — CROSSREF, and the only one that cannot be written as a regexp.
 *
 * A funder's page does not name a competitor and send the reader there. GrantSpotter does it
 * constantly and it is one of the most useful things it says — which is why it belongs in
 * `summary`, where the reader knows whose judgement it is. The check needs the corpus: it is the
 * NAMES OF THE OTHER RECORDS that make a sentence a recommendation rather than a fact.
 */
const RECOMMENDATION_CUES =
  /\bif you want\b|\bif you are looking for\b|\bthe (?:real |verified |one |only )?routes? (?:are|is)\b|\bis the one\b|\bthe one verified route\b|\bare the\b|\bsearch the\b|\bapply through\b|\binstead\b|\bthe authoritative statement\b|\bfund the\b|\brather than\b/i;

/* ------------------------------------------------------------------------------ the corpus --- */

function fieldsOf(file: string, raw: Record<string, unknown>): Field[] {
  const id = typeof raw.id === 'string' ? raw.id : '(no id)';
  const out: Field[] = [];
  const push = (surface: string, path: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') out.push({ file, recordId: id, surface, path, text: value });
  };

  push('rawOtherText', 'rawOtherText', raw.rawOtherText);

  const amount = raw.amount as Record<string, unknown> | undefined;
  push('amount.amountRaw', 'amount.amountRaw', amount?.amountRaw);
  push('amount.awardCountRaw', 'amount.awardCountRaw', amount?.awardCountRaw);

  const aiPolicy = raw.aiPolicy as Record<string, unknown> | undefined;
  push('aiPolicy.quote', 'aiPolicy.quote', aiPolicy?.quote);

  const obligations = (raw.obligations ?? {}) as Record<string, unknown>;
  for (const key of ['licenseObligation', 'sustainmentObligation', 'reportingObligation'] as const) {
    push(`obligations.${key}`, `obligations.${key}`, obligations[key]);
  }

  const restrictions = Array.isArray(raw.fundingRestrictions) ? raw.fundingRestrictions : [];
  restrictions.forEach((value, i) => {
    push('fundingRestrictions[]', `fundingRestrictions[${String(i)}]`, value);
  });

  const constraints = Array.isArray(raw.constraints) ? raw.constraints : [];
  constraints.forEach((constraint, i) => {
    const c = constraint as Record<string, unknown>;
    const label = typeof c.id === 'string' ? c.id : String(i);
    push('constraints[].rawText', `constraints[${label}].rawText`, c.rawText);
  });

  const evidence = ((raw.evidence as Record<string, unknown> | undefined)?.obligations ?? {}) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(evidence)) {
    push('evidence.obligations[].quote', `evidence.obligations.${key}.quote`, (value as Record<string, unknown>)?.quote);
  }

  return out;
}

interface SeedRecord {
  readonly file: string;
  readonly id: string;
  readonly funderId: string;
  readonly name: string;
  readonly fields: readonly Field[];
}

function seedRecords(): SeedRecord[] {
  const dir = seedDir();
  return readdirSync(dir)
    .filter((f) => f.startsWith('programs.') && f.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { programs?: unknown[] };
      return (parsed.programs ?? []).map((p) => {
        const raw = p as Record<string, unknown>;
        return {
          file,
          id: typeof raw.id === 'string' ? raw.id : '(no id)',
          funderId: typeof raw.funderId === 'string' ? raw.funderId : '',
          name: typeof raw.name === 'string' ? raw.name : '',
          fields: fieldsOf(file, raw),
        };
      });
    });
}

function seedFunders(): Array<{ id: string; name: string }> {
  const parsed = JSON.parse(readFileSync(join(seedDir(), 'funders.json'), 'utf8')) as {
    funders?: Array<Record<string, unknown>>;
  };
  return (parsed.funders ?? []).map((f) => ({
    id: typeof f.id === 'string' ? f.id : '',
    name: typeof f.name === 'string' ? f.name : '',
  }));
}

const RECORDS = seedRecords();
const FUNDERS = seedFunders();
const FIELDS = RECORDS.flatMap((r) => r.fields);

/** Other programmes and other funders this text names, by the name the corpus knows them by. */
function crossReferencedIn(record: SeedRecord, text: string): string[] {
  const haystack = text.toLowerCase();
  const named = new Set<string>();
  for (const other of RECORDS) {
    if (other.id === record.id || other.name === '') continue;
    if (haystack.includes(other.name.toLowerCase())) named.add(other.name);
  }
  for (const funder of FUNDERS) {
    // Short funder names ("ARRL", "SARA") appear inside a funder's own prose about itself far too
    // often to be evidence of anything. A full organisation name is the signal.
    if (funder.id === record.funderId || funder.name.length <= 6) continue;
    if (haystack.includes(funder.name.toLowerCase())) named.add(funder.name);
  }
  return [...named].sort();
}

/* ---------------------------------------------------------------------------------- the check - */

describe('the seed corpus never speaks as GrantSpotter in a field the page attributes to the funder', () => {
  it('reads a corpus big enough for the check to mean anything', () => {
    // A detector that scans nothing passes. These figures move with the corpus; they exist so that
    // a loader change which silently returns [] fails here instead of reporting "clean". The
    // record floor counts records PARSED, not records with a funder-voice field: four records
    // legitimately have none now, and a floor over those would fall every time one is emptied.
    expect(RECORDS.length).toBeGreaterThanOrEqual(140);
    expect(FIELDS.length).toBeGreaterThanOrEqual(900);
    expect(FUNDERS.length).toBeGreaterThanOrEqual(20);
  });

  it('covers every surface the opportunity page presents as the funder speaking', () => {
    // Each key must be a surface this test actually enumerates, and each enumerated surface must be
    // declared with where it is rendered. A new funder-voice field added to the record and not to
    // this map is the way this guard would go blind.
    expect(new Set(FIELDS.map((f) => f.surface))).toEqual(
      new Set(Object.keys(FUNDER_VOICE_SURFACES).filter((s) => FIELDS.some((f) => f.surface === s))),
    );
    for (const field of FIELDS) expect(FUNDER_VOICE_SURFACES[field.surface]).toBeDefined();
  });

  it('carries no sentence in GrantSpotter\'s voice in any of them', () => {
    const violations = FIELDS.flatMap((field) => {
      const tells = tellsIn(field.text);
      if (tells.length === 0) return [];
      return [
        `${field.file} ${field.recordId} ${field.path}\n` +
          `    ${tells.join('\n    ')}\n` +
          `    surface: ${FUNDER_VOICE_SURFACES[field.surface] ?? '(undeclared)'}\n` +
          `    text: ${field.text.slice(0, 220)}`,
      ];
    });
    expect(
      violations,
      `${String(violations.length)} field(s) the product prints as the funder's own words are ` +
        'GrantSpotter talking. Move the sentence — summary / deadline.note / trust.* for anything a ' +
        'student needs, content/templates/funders/ for advice, data/seed/MAINTAINER-NOTES.md for ' +
        'curation rationale. Rewording one until this test goes quiet is what produced the second ' +
        `round of this defect.\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('never points the reader at another programme in this corpus', () => {
    const violations = RECORDS.flatMap((record) =>
      record.fields.flatMap((field) => {
        if (!RECOMMENDATION_CUES.test(field.text)) return [];
        const named = crossReferencedIn(record, field.text);
        if (named.length === 0) return [];
        return [
          `${field.file} ${record.id} ${field.path}\n` +
            `    CROSSREF: recommends ${named.join('; ')}\n` +
            `    text: ${field.text.slice(0, 220)}`,
        ];
      }),
    );
    expect(
      violations,
      `${String(violations.length)} field(s) recommend a different programme from inside a panel ` +
        "that says it is quoting the funder. No funder's page names a competitor and sends the " +
        'reader there; GrantSpotter does, and that judgement belongs in `summary`, where the reader ' +
        `knows whose it is.\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * THE DETECTOR ITSELF, AGAINST BOTH BLOCKS THAT SHIPPED AND AGAINST REAL FUNDER TEXT.
 *
 * A guard is only worth its green tick if it is red for the thing it was written for. The first
 * two cases are the exact strings served from `/o/arrl-club-grant` on the live site, one from each
 * round; the third plants one example of every family; the fourth is the negative control that
 * decides whether any of this survives contact with the corpus.
 */
describe('the detector', () => {
  const ROUND_ONE_NOTE =
    "Spec §8's shipped example of the disputed surface, and the disputed block above is " +
    'byte-identical to the curated override the ingestion pipeline applies to the same (sourceId, ' +
    'externalKey) pair, so a re-crawl cannot produce a phantom difference. NOT ASSERTED HERE: a ' +
    'co-funder preference. That sentence is on the Amateur Radio Grants page, not this one, and ' +
    'carrying it across would be cross-contamination between two records.';

  /** The rewrite. Not one machine token in it, and the round-one guard passed it clean. */
  const ROUND_TWO_NOTE =
    'This programme is funded by ARDC: the page thanks Amateur Radio Digital Communications for ' +
    'providing the funding, the same single-donor dependency that runs through the ARRL ' +
    'scholarships. If you want an ARRL organisation grant with a published, verifiable window ' +
    'right now, the ARRL Amateur Radio Grants programme is the one with dates on its page.';

  it('flags the block that shipped in round one, on machine tells', () => {
    expect(tellsIn(ROUND_ONE_NOTE)).toEqual(
      expect.arrayContaining([
        'MACHINE: cites the spec or the contract',
        'MACHINE: names the ingestion pipeline',
        'MACHINE: names a curated override',
        'MACHINE: names crawling machinery',
        'MACHINE: "NOT ASSERTED"',
        'MACHINE: "cross-contamination"',
      ]),
    );
  });

  it('flags the round-two rewrite, which carries no machine tell at all', () => {
    expect(MACHINE_TELLS.filter((t) => t.re.test(ROUND_TWO_NOTE)).map((t) => t.name)).toEqual([]);
    expect(tellsIn(ROUND_TWO_NOTE)).toEqual(
      expect.arrayContaining([
        'META: makes the source page or the record the object of the sentence',
        'ADVICE: opens a conditional addressed to the reader',
      ]),
    );
    // And the corpus-aware half: it names another programme, in a recommendation frame.
    const clubGrant = RECORDS.find((r) => r.id === 'arrl-club-grant');
    expect(clubGrant, 'the record this note shipped on must still be in the corpus').toBeDefined();
    expect(RECOMMENDATION_CUES.test(ROUND_TWO_NOTE)).toBe(true);
    expect(crossReferencedIn(clubGrant!, ROUND_TWO_NOTE)).toContain('ARRL Amateur Radio Grants');
  });

  it('flags one planted example of every family, and the family it names is the right one', () => {
    const planted: ReadonlyArray<readonly [string, string]> = [
      ['MACHINE', 'Status is `no_application` rather than `discontinued`; see Task 14 and data/seed for why.'],
      ['META', 'The guidelines page states no amount, and the word "treasurer" appears zero times on it.'],
      ['ADVICE', 'Your campus will differ, sometimes by an order of magnitude, so confirm the caps before you budget.'],
      ['PIPELINE', 'Figures from the 2026-08-02 research pass; mga.ieee.org returns HTTP 418 to non-browser clients.'],
    ];
    for (const [family, text] of planted) {
      expect(familiesIn(text), `not flagged as ${family}: ${text}`).toContain(family);
    }
  });

  it('flags a cross-reference only when it recommends, and only against this corpus', () => {
    const amsat = RECORDS.find((r) => r.id === 'amsat-no-grants-program');
    expect(amsat).toBeDefined();
    const recommending =
      'AMSAT is not a grantmaker. If your project is satellite-adjacent, the real routes are ' +
      'ARISS-USA ISS Contact Proposals for a scheduled contact and the NASA CubeSat Launch Initiative (CSLI) for launch services.';
    expect(RECOMMENDATION_CUES.test(recommending)).toBe(true);
    expect(crossReferencedIn(amsat!, recommending).length).toBeGreaterThan(0);

    // A programme naming an organisation the corpus does not carry is not a cross-reference, and
    // naming one with no recommendation frame is not either. Both must stay silent, or every
    // record that mentions a co-funder fails.
    expect(crossReferencedIn(amsat!, 'Instead of a grant, look at the Podunk Radio Club Fund.')).toEqual([]);
    const factual = 'Applications are administered by the ARRL Foundation on a single annual cycle.';
    expect(RECOMMENDATION_CUES.test(factual)).toBe(false);
  });

  /**
   * The other direction, and the one that decides whether this guard survives contact with the
   * corpus. Every string below is real funder-published text shipped in `data/seed/`; a detector
   * that flags any of them would be trained away within a week.
   *
   * The second person in three of them is the point: this is the calibration that keeps ADVICE
   * from being a `\byou\b` match.
   */
  it('is silent on the funder text the corpus actually ships', () => {
    for (const genuine of [
      'Award Amount: $3,000\nNumber of Awards: Three\nLicense Requirement: Any active amateur radio license (FCC-issued or foreign)\nRegion: Any\nField of Study: No preference.',
      'Applicant must be a U.S. citizen; open to graduation high school seniors, undergraduate students and U.S. military veterans.',
      'Demonstrated CW operating ability within the last 24 months by providing a copy of a certificate, listing in a magazine showing results or a letter from a person responsible for membership (Examples include but are not limited to: ARRL Code Proficiency certificate at 15 wpm or higher; participation in a CW contest where the results have been published)',
      'Preference is given to students performing at a high academic level.',
      'Full tuition at DX University or Contest University sessions held in North America.',
      'Does not fund ongoing operating expenses.',
      '1) Preference will be given to applicants demonstrating a GPA of over 3.5 on a 4.0 scale. 2) Applicant must show proof of amateur radio activity during the previous year.',
      // Second person, written by the funder, on three different pages.
      'If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy. If the proposal is extremely long and hard to understand, we can\'t evaluate or support it.',
      'If you are a licensed amateur radio operator 25 years of age or younger, you can apply for a free tuition scholarship by contacting the appropriate University directly.',
      'Before a chapter applies for MTT-S financial support they should apply for support from the IEEE Section to which that chapter reports. Sections receive a rebate for your chapter\'s past year\'s activities and the Section should support your current activities.',
      // The funder's own "we", which PIPELINE must not read as the research team's.
      'With the exception of excess baggage charges, we do not consider commercially available transportation costs when we are working on a grant request approval.',
      'Because ARDC works with and for the public, we require that the work of the projects we fund be freely available to everyone who can benefit and to everyone who can contribute.',
      // An imperative from the funder about the APPLICATION, which ADVICE must not read as advice
      // about the record.
      'Submit your Branch\'s Annual Plan through vTools Student Branch Reporting. Submitting an Annual Plan is required to qualify for a Student Branch Rebate.',
      'Applications must be made by completing (1) a Budget Worksheet and (2) an Application Form, and submitting both to NCDXF. Please include all the information requested on the worksheet and form. This will speed the review of your application.',
    ]) {
      expect(tellsIn(genuine), `false positive: ${genuine.slice(0, 70)}`).toEqual([]);
    }
  });
});
