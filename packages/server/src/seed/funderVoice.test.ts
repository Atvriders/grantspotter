/**
 * NOTHING THE PRODUCT PRESENTS AS THE FUNDER'S OWN WORDS MAY BE A NOTE ABOUT GRANTSPOTTER.
 *
 * The opportunity page reproduces `rawOtherText` under the heading "Unstructured requirements,
 * verbatim", in the same monospaced `.verbatim` box it uses for a funder's sentence, introduced
 * with a promise:
 *
 *   "Text from the source that no field on this page models. It is reproduced exactly, because
 *    paraphrasing is where a requirement that was never written down gets invented."
 *
 * On 2026-08-13 the shipped ARRL Club Grant record answered that promise with this project's own
 * development notes — a spec section number, the ingestion pipeline's override behaviour, a
 * `(sourceId, externalKey)` pair, "NOT ASSERTED HERE" — and a signed-in member on the live site
 * read them as ARRL's terms. It was not one record: twenty-nine of the thirty-two hand-curated
 * records carried the same shape, all twenty-nine in `rawOtherText`. The 111 generated ARRL
 * catalogue records carried none — their text is a function of the committed capture rather than
 * something a person typed — which is what makes this a defect of CURATION.
 *
 * WHY THIS TEST EXISTS RATHER THAN A CODE REVIEW. The fabricated-quotation fix earlier the same
 * week policed COMPOSED text: `hasFunderWording` refuses to render a quote block for a constraint
 * GrantSpotter wrote at match time, because "an empty `rawText` is the honest representation of
 * 'no funder said this'". That gate cannot see CURATED text. A sentence typed into `data/seed/` by
 * hand arrives already looking like something a funder published, passes zod, passes the seed
 * harness, and ships to every installation. This is the same rule pointed at the other input.
 *
 * WHAT IT CANNOT DO. It has no page text, so it cannot confirm that a sentence really appears on
 * the funder's page — only that the sentence is not visibly about this software. A record could
 * still misattribute a fluent invention, which is what `validate.ts`'s provenance rules and the
 * research pass are for.
 *
 * WHEN IT FAILS, MOVE THE SENTENCE, DO NOT REWORD IT. `data/seed/MAINTAINER-NOTES.md` is the home
 * for curation rationale; `summary`, `deadline.note`, `trust.disputed.note` and
 * `trust.staleMirrorWarning` are the record's own authored voice for anything a STUDENT needs to
 * know about how the record was made. Rewording until the detector goes quiet leaves the defect
 * and removes the alarm.
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

/**
 * THE TELLS. Each is a shape that a funder writing about their own grant has no reason to produce
 * and that this project's notes produce constantly.
 *
 * Kept deliberately literal. A cleverer detector — "does this sentence talk about the record?" —
 * would be a paraphrase of the rule rather than the rule, and the failure mode of a fuzzy guard is
 * that somebody tunes the data until it passes.
 */
const TELLS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
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
   * snake_cased machine tokens; every one of those in this corpus was a field name, an enum member
   * or a database column that leaked out of a note. `contest_style` words a funder might plausibly
   * write (`wp-content`, `e-mail`) are hyphenated, not underscored.
   */
  { name: 'quotes an identifier in backticks', re: /`[A-Za-z_][A-Za-z0-9_.]*`/ },
  { name: 'prints a snake_case machine token', re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/ },
];

function tellsIn(text: string): string[] {
  return TELLS.filter((t) => t.re.test(text)).map((t) => t.name);
}

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

/** Every funder-voice string in `data/seed/`, read from the JSON so the side-cars are visible too. */
function seedFields(): Field[] {
  const dir = seedDir();
  return readdirSync(dir)
    .filter((f) => f.startsWith('programs.') && f.endsWith('.json'))
    .sort()
    .flatMap((file) => {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { programs?: unknown[] };
      return (parsed.programs ?? []).flatMap((p) => fieldsOf(file, p as Record<string, unknown>));
    });
}

const FIELDS = seedFields();

describe('the seed corpus never puts a note about this software in the funder\'s mouth', () => {
  it('reads a corpus big enough for the check to mean anything', () => {
    // A detector that scans nothing passes. These two numbers move with the corpus; they exist so
    // that a loader change which silently returns [] fails here instead of reporting "clean".
    expect(new Set(FIELDS.map((f) => f.recordId)).size).toBeGreaterThanOrEqual(140);
    expect(FIELDS.length).toBeGreaterThanOrEqual(600);
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

  it('carries no sentence about GrantSpotter in any of them', () => {
    const violations = FIELDS.flatMap((field) => {
      const tells = tellsIn(field.text);
      if (tells.length === 0) return [];
      return [
        `${field.file} ${field.recordId} ${field.path}: ${tells.join(', ')}\n` +
          `    surface: ${FUNDER_VOICE_SURFACES[field.surface] ?? '(undeclared)'}\n` +
          `    text: ${field.text.slice(0, 220)}`,
      ];
    });
    expect(
      violations,
      `${String(violations.length)} field(s) the product prints as the funder's own words are notes about ` +
        'GrantSpotter. Move the sentence to data/seed/MAINTAINER-NOTES.md — a student reads these ' +
        'fields as the funder speaking, and rewording one until this test goes quiet keeps the ' +
        `defect and loses the alarm.\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * THE DETECTOR ITSELF, AGAINST THE BLOCK THAT SHIPPED AND AGAINST REAL FUNDER TEXT.
 *
 * A guard is only worth its green tick if it is red for the thing it was written for. The first
 * case is the exact string served from `/o/arrl-club-grant` on the live site on 2026-08-13, in the
 * "reproduced exactly" panel.
 */
describe('the detector', () => {
  const SHIPPED_ARRL_CLUB_GRANT_NOTE =
    "Spec §8's shipped example of the disputed surface, and the disputed block above is " +
    'byte-identical to the curated override the ingestion pipeline applies to the same (sourceId, ' +
    'externalKey) pair, so a re-crawl cannot produce a phantom difference. This programme is funded ' +
    'by ARDC — the page thanks Amateur Radio Digital Communications for providing the funding, which ' +
    'is the same one-leg-with-a-splint dependency that runs through the ARRL scholarships. If you ' +
    'want an ARRL organisation grant with a published, verifiable window right now, the ARRL Amateur ' +
    'Radio Grants programme is the one with dates on its page. NOT ASSERTED HERE: a co-funder ' +
    'preference. That sentence is on the Amateur Radio Grants page, not this one, and carrying it ' +
    'across would be cross-contamination between two records.';

  it('flags the block that shipped on the ARRL Club Grant page', () => {
    expect(tellsIn(SHIPPED_ARRL_CLUB_GRANT_NOTE)).toEqual(
      expect.arrayContaining([
        'cites the spec or the contract',
        'names the ingestion pipeline',
        'names a curated override',
        'names crawling machinery',
        '"NOT ASSERTED"',
        '"cross-contamination"',
      ]),
    );
  });

  it('flags a maintainer note planted in any funder-voice field, one tell at a time', () => {
    for (const planted of [
      'Recorded so a future maintainer does not research this twice.',
      'DELIBERATELY HAS NO sourceKey; the source module emits one page-level record.',
      'Status is `no_application` rather than `discontinued`.',
      'The klass stays equipment_in_kind to match the browse category.',
      'See Task 14 and data/seed for why this is unstated.',
      'Every fact in this record is quoted from fixtures/ylrl/00-ylrl-net-scholarships.html.',
      'GrantSpotter does not poll this site.',
    ]) {
      expect(tellsIn(planted), `not flagged: ${planted}`).not.toEqual([]);
    }
  });

  /**
   * The other direction, and the one that decides whether this guard survives contact with the
   * corpus. Every string below is real funder-published text shipped in `data/seed/`; a detector
   * that flags any of them would be trained away within a week.
   */
  it('is silent on the funder text the corpus actually ships', () => {
    for (const genuine of [
      'Award Amount: $3,000\nNumber of Awards: Three\nLicense Requirement: Any active amateur radio license (FCC-issued or foreign)\nRegion: Any\nField of Study: No preference.',
      'Applicant must be a U.S. citizen; open to graduation high school seniors, undergraduate students and U.S. military veterans.',
      'Demonstrated CW operating ability within the last 24 months by providing a copy of a certificate, listing in a magazine showing results or a letter from a person responsible for membership (Examples include but are not limited to: ARRL Code Proficiency certificate at 15 wpm or higher; participation in a CW contest where the results have been published)',
      'Preference is given to students performing at a high academic level.',
      'Full tuition at DX University or Contest University sessions held in North America. No dollar figure is published.',
      'Does not fund ongoing operating expenses.',
      '1) Preference will be given to applicants demonstrating a GPA of over 3.5 on a 4.0 scale. 2) Applicant must show proof of amateur radio activity during the previous year.',
    ]) {
      expect(tellsIn(genuine), `false positive: ${genuine.slice(0, 60)}`).toEqual([]);
    }
  });
});
