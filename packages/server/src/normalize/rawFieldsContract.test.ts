import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TIER_D_RECORDS } from '../sources/manual-tier-d.js';

/**
 * THE WRITTEN-BUT-NEVER-READ INVARIANT.
 *
 * Three separate bugs in this codebase have had exactly one shape: a source module computes
 * something real, writes it, and nothing on the consuming side ever reads it. Every one was
 * invisible, because writing a value nothing consumes is SILENT BY CONSTRUCTION — no test fails,
 * no error is logged, the value simply evaporates inside `normalizeRaw`, which builds a `Program`
 * and drops `rawFields` wholesale.
 *
 *   1. `do_not_publish` — written by `buildTags`, read by nothing. 37 already-funded ARRL clubs,
 *      plus `ardc-award-tables` (424 rows on the real capture), `nsf-awards` (38) and
 *      `usaspending` (45), were all queued as publishable live opportunities, while four source
 *      modules carried comments promising they could not be.
 *   2. `rawFields.opensAt` / `closesAt` — a real application window, parsed and then discarded.
 *   3. `rawFields.adjacencyScore` — a weighted relevance score computed by five sources, and
 *      `confidenceFor`'s branch for it had never once executed.
 *
 * This test makes that shape LOUD. It scans every source module on disk for the `rawFields` keys
 * it writes, scans the consuming half of the codebase for the keys it reads, and fails on any key
 * that is written and read by nothing. A field that is legitimately write-only has to be listed
 * below with a reason, which turns "nothing reads this" from an accident into a statement somebody
 * signed.
 *
 * It follows the two invariants in this repo that already work this way: `sources/registry.test.ts`
 * imports every module on disk and asserts each appears in `listSourceIds()`, and the ARRL label
 * table asserts no label is a proper prefix of another. Both were proven by deliberately breaking
 * them; so was this one — see the note on `crawl/runner.ts`'s `adjacencyScores`.
 *
 * WHAT IT DELIBERATELY CANNOT SEE, because `rawFields` is an open `Record<string, string>`:
 *   - keys written through a computed subscript (`rawFields[key] = value` in
 *     `arrl-scholarship-descriptions.ts` and `util/singlePage.ts`, where the key comes from a
 *     pattern table). Those are unknowable statically and are simply not checked.
 *   - keys read through a computed subscript. There are none today; a reader added that way would
 *     make this test fail with a false positive, and the fix is to name the key in the allow-list
 *     or to read it by name.
 * A pragmatic scanner that catches the three real bugs beats a perfect one that catches none. The
 * self-check block at the bottom exists so that a scanner which silently stops seeing anything
 * fails rather than passing vacuously.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = path.resolve(SRC_ROOT, '../../core/src');

/**
 * The WRITING half: source modules and the `federal/` helpers they build `RawOpportunity`s with.
 * `ai/` is excluded on purpose — `ai/assist.ts` copies whatever keys a model returns, so its keys
 * are not knowable, and the JSON schema it declares contains a literal `rawFields: { type: ... }`
 * that is a schema, not a write.
 */
const WRITER_DIRS = ['sources', 'federal'] as const;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out.sort();
}

/**
 * Comments are stripped from BOTH halves. A key named in a doc comment is neither a write nor a
 * read — `normalize/deadline.ts` discusses `rawFields.status` at length in prose, and counting
 * that as a reader would have let the original `do_not_publish` bug hide behind its own comment.
 * Only whole-line `//` comments are removed, so that `https://` inside a URL survives.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** `rawFields: {`, `const rawFields: Record<string, string> = {`, `rawFields = {`. */
const RAW_FIELDS_LITERAL = /rawFields\s*(?::\s*[^={;]*)?(?::|=)\s*\{/g;

/** Walks from just past an opening brace to its match, skipping string and template contents. */
function matchingBrace(src: string, from: number): number {
  let i = from;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    }
    i++;
  }
  return i - 1;
}

/** Splits an object-literal body on top-level commas, ignoring commas inside nested/quoted parts. */
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      cur += c;
      i++;
      while (i < body.length && body[i] !== quote) {
        cur += body[i];
        if (body[i] === '\\') cur += body[++i] ?? '';
        i++;
      }
      cur += body[i] ?? '';
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function writtenKeysIn(src: string): Set<string> {
  const keys = new Set<string>();
  for (const m of src.matchAll(RAW_FIELDS_LITERAL)) {
    const start = m.index + m[0].length;
    const body = src.slice(start, matchingBrace(src, start));
    for (const part of topLevelParts(body)) {
      const t = part.trim();
      if (t === '' || t.startsWith('...')) continue; // a spread carries no new key name
      const key = /^\[?['"]?([A-Za-z_$][\w$ .-]*)['"]?\]?\s*(?::|,|$)/.exec(t);
      if (key) keys.add(key[1].trim());
    }
  }
  // `rawFields.opensAt = ...` and `rawFields['x'] = ...`, but never `rawFields[key] = ...`.
  for (const m of src.matchAll(/rawFields(?:\.([A-Za-z_$][\w$]*)|\[['"]([^'"]+)['"]\])\s*=(?!=)/g)) {
    keys.add(m[1] ?? m[2]);
  }
  return keys;
}

/** key -> the source files that write it. */
async function collectWrites(): Promise<Map<string, string[]>> {
  const written = new Map<string, string[]>();
  const add = (key: string, where: string): void => {
    const at = written.get(key) ?? [];
    if (!at.includes(where)) at.push(where);
    written.set(key, at);
  };
  for (const dir of WRITER_DIRS) {
    for (const file of await walk(path.join(SRC_ROOT, dir))) {
      const src = stripComments(await readFile(file, 'utf8'));
      for (const key of writtenKeysIn(src)) add(key, path.relative(SRC_ROOT, file));
    }
  }
  // `manual-tier-d.ts` is the one module that builds its rawFields as an argument to a helper
  // (`record(externalKey, name, sourceUrl, rawFields, rawText)`) rather than as a `rawFields: {}`
  // literal, so the static scan cannot see its keys. It exports its records, so they are read
  // straight off the real objects instead — exact, not inferred.
  for (const rec of TIER_D_RECORDS) {
    for (const key of Object.keys(rec.rawFields)) add(key, 'sources/manual-tier-d.ts');
  }
  return written;
}

/**
 * The CONSUMING half: everything downstream of a source module. `sources/` and `federal/` are
 * excluded because a source reading back a key it just wrote is not consumption — the question
 * this test asks is whether anything downstream ever acts on the value.
 */
async function collectReaderSources(): Promise<Array<[string, string]>> {
  const files = [
    ...(await walk(SRC_ROOT)).filter(
      (f) => !WRITER_DIRS.some((d) => f.startsWith(path.join(SRC_ROOT, d) + path.sep)),
    ),
    ...(await walk(CORE_SRC)),
  ];
  return Promise.all(
    files.map(async (f): Promise<[string, string]> => [
      path.relative(SRC_ROOT, f),
      stripComments(await readFile(f, 'utf8')),
    ]),
  );
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Three read shapes, all of which occur in this codebase:
 *   `raw.rawFields.recordType`            — direct property access
 *   `raw.rawFields['Field of Study']`     — quoted subscript, for keys with spaces
 *   `firstOf(raw.rawFields, ['pricing'])` — a key name quoted on the same line as `rawFields`
 * The third is deliberately line-scoped. Matching a bare quoted string anywhere in a reader file
 * produced three false "consumed" verdicts on the real tree (`'state'` matched a GeoScope literal
 * in `axes/geography.ts`, `'amount'`/`'status'` matched SQL column names in `db/ingestSchema.ts`),
 * and a false "consumed" is precisely the outcome this invariant exists to prevent.
 */
function readersOf(key: string, readerSources: Array<[string, string]>): string[] {
  const dot = new RegExp(`rawFields\\??\\.${escape(key)}(?![\\w$])`);
  const subscript = new RegExp(`rawFields\\s*\\[\\s*['"]${escape(key)}['"]`);
  const sameLine = new RegExp(`rawFields.*['"]${escape(key)}['"]`);
  return readerSources
    .filter(([, src]) => dot.test(src) || subscript.test(src) || src.split('\n').some((l) => sameLine.test(l)))
    .map(([file]) => file);
}

/**
 * Fields that are written and read by nothing ON PURPOSE. Each reason is the statement that makes
 * this deliberate rather than accidental; adding an entry here is the reviewed decision to let a
 * value evaporate.
 */
const WRITE_ONLY_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  // ---- Federal identifiers and provenance. Identity is `externalKey`, which reconciliation
  // joins on, and provenance is the `source:` tag `buildTags` stamps onto every Program.
  ['agency', 'Awarding agency name. Already inside the scored text and the record name; the funder is modelled as Program.funderId.'],
  ['agencyCode', "Grants.gov's agency code (DOC-NTIA). Same as `agency`: display metadata with no Program field."],
  ['opportunityNumber', "The human-facing number (NTIA-PWSCIF-26-01). Identity is the numeric externalKey, which is what existingIdFor joins on."],
  ['cfda', 'Assistance-listing number. Nothing in CONTRACT §3 models it and no eligibility axis reads it.'],
  ['docType', "Grants.gov's synopsis/forecast marker. Kept so a capture can be audited; the pipeline treats both alike."],
  ['federalSource', "'daily-extract' — which Grants.gov leg produced the row. Provenance already rides on the `source:` tag."],
  ['feedUrl', 'Which of the three NSF feeds an item came from. Asserted by this source’s own per-feed count tests; the pipeline does not distinguish them.'],
  ['slug', "WordPress slug from the ARDC REST API. The URL is already sourceUrl."],
  ['link', 'The item URL, already carried as sourceUrl and externalKey. For the signalOnly source arrl-news-rss, crawl/runner.ts copies the whole rawFields map into the ChangeEvent, so there a human reads it.'],
  ['description', 'arrl-news-rss is signalOnly: crawl/runner.ts copies the whole rawFields map into the ChangeEvent for a human to read. No code branches on it.'],

  // ---- Funder-reported timestamps. Freshness in this product is OUR observation
  // (trust.lastVerifiedAt and the age badge), deliberately not the funder's self-report:
  // arrl.org's sitemap <lastmod> is frozen at 2010, which is what taught us not to trust these.
  ['date', "The funder's own published/updated date on an ARDC post."],
  ['modified', "The ARDC REST API's last-modified timestamp."],
  ['postDate', 'When Grants.gov posted the row. Not a deadline — see closeDate in the defect list below.'],
  ['lastUpdatedDate', 'When Grants.gov last touched the record. Our own lastVerifiedAt is what the age badge reads.'],
  ['pubDate', 'RSS publication timestamp. A publication date, not a deadline, and only one of the three NSF feeds carries one at all; on the signalOnly arrl-news-rss it reaches the Inbox with the rest of the map.'],

  // ---- Evidence on records that are stored but never published. These carry
  // `recordType: past_award` or `crosscheck`, are tagged do_not_publish, and live in
  // change_events.after_json. A Program has no field for a recipient of money already given.
  ['awardee', 'Who received a past NSF/USAspending award. Evidence about the funder, on a record that can never publish.'],
  ['recipient', 'Which club received a past ARRL club grant. Same.'],
  ['grantee', 'Which organisation received a past ARDC grant. Same.'],
  ['granteeUrl', "The grantee's own site on an ARDC award row. Same."],
  ['project', 'What a past ARDC grant paid for. Same: evidence on a record that can never publish.'],
  ['program', 'The NSF funding program that made a past award. Same.'],
  ['state', 'The US state of a past ARRL club-grant recipient. Same; not the applicant geography axis, which reads rawFields.region.'],
  ['startDate', 'Performance-period start of a PAST award. Not a deadline; the record never publishes.'],
  ['endDate', 'Performance-period end of a PAST award. Same.'],

  // ---- Diagnostics and prose for the next maintainer.
  ['adjacencyHits', 'The human-readable explanation of adjacencyScore ("Public Wireless Supply Chain Innovation Fund, PWSCIF"). The SCORE is the signal and is consumed; the hits are what a person reads when auditing why a record scored what it did, and are asserted by each scoring source’s own tests.'],
  ['whyManual', 'Why a Tier D record is hand-curated rather than polled (yasme.org 403s non-browser clients, ClubExpress query-string-only URLs). Written for a maintainer, not for code.'],
  ['reason', 'Why a verified_negative record is a negative. The published warning text itself is rawText, which normalizeRaw keeps as rawOtherText.'],
  ['scope', "'named_scholarship' marker on tier-c-a records. Nothing branches on it."],
  ['formTitle', "The Yaesu application form's own heading, kept so a capture can be audited against the live page."],
  ['sustainment', "Yaesu's parsed 12-month on-air requirement. NOT lost: normalize/index.ts states this same obligation for yaesu-dr2x as a literal in OBLIGATIONS_BY_SOURCE, so the parsed copy is a duplicate of a fact the pipeline already carries."],
  ['windowSource', "Provenance for how yaesu-dr2x derived its opensAt/closesAt — see those two in the defect list below, which is where the actual problem is."],
]);

/**
 * Fields that are written and read by nothing and SHOULD NOT BE. These are not exemptions; they
 * are this invariant's first catch, recorded so that they are tracked rather than rediscovered.
 * Each names the consumer that ought to exist. They are listed separately from the by-design set
 * on purpose: an entry moving from here to a reader is progress, and an entry moving into here is
 * a decision somebody has to defend.
 *
 * None of them are fixed in this change because every one of them lands in `normalize/deadline.ts`
 * or in `normalize/index.ts`'s per-source tables, which are outside this change's blast radius —
 * and a deadline fix made blind, without re-reading the real captures each source was graded
 * against, is how a wrong deadline gets published, which is the single worst thing this product
 * can do.
 */
const WRITE_ONLY_KNOWN_DEFECTS: ReadonlyMap<string, string> = new Map([
  ['opensAt', 'DEFECT (bug #2 of this class). tier-c-b and yaesu-dr2x parse a real application window; inferDeadline (normalize/deadline.ts) reads only rawFields.deadlineKind and the per-source RECUR table, so a window a funder actually published never becomes a DeadlineSpec.'],
  ['closesAt', 'DEFECT (bug #2 of this class). The closing half of the same parsed window, dropped the same way.'],
  ['openDate', "DEFECT. Grants.gov publishes the opportunity's real open date on the detail leg. inferDeadline reads no date field at all."],
  ['closeDate', 'DEFECT. The real federal application deadline, on both the detail leg and the daily extract. Nothing reads it, so every federal candidate publishes with a deadline inferred from nothing.'],
  ['responseDate', 'DEFECT. Grants.gov’s response deadline in long form ("Sep 09, 2026 12:00:00 AM EDT"). Same gap.'],
  ['oppStatus', "DEFECT. Grants.gov's own posted/closed/forecasted status. inferStatus ALREADY has an override seam — an explicit rawFields.status beats inference — and nothing maps oppStatus onto it, so a federal record's status is guessed while the funder's own answer sits unread."],
  ['applicantTypes', 'DEFECT. The detail API’s real eligibility list. ENTITIES_BY_SOURCE (normalize/index.ts) has no entry for any federal source, so every federal candidate publishes with applicantEntities: [] while the answer is right here.'],
  ['excerpt', "DEFECT. The ARDC REST API's own summary. buildSummary's firstOf list is ['summary','audience','eligibility','__preamble'] and does not include it, so ardc-grants records fall back to a rawText dump."],
]);

const ALLOWED = new Set([...WRITE_ONLY_BY_DESIGN.keys(), ...WRITE_ONLY_KNOWN_DEFECTS.keys()]);

describe('rawFields: nothing a source writes may be silently consumed by nobody', () => {
  it('has no rawFields key that is written by a source and read by nothing', async () => {
    const written = await collectWrites();
    const readerSources = await collectReaderSources();

    const orphans: string[] = [];
    for (const [key, writers] of [...written].sort()) {
      if (ALLOWED.has(key)) continue;
      if (readersOf(key, readerSources).length > 0) continue;
      orphans.push(
        `rawFields.${key} is written by ${writers.join(', ')} and read by NOTHING. ` +
          'Either consume it, or add it to WRITE_ONLY_BY_DESIGN / WRITE_ONLY_KNOWN_DEFECTS ' +
          'in rawFieldsContract.test.ts with a reason.',
      );
    }
    expect(orphans).toEqual([]);
  });

  it('keeps the write-only lists honest: every listed field is still written by a source', async () => {
    const written = await collectWrites();
    // A list entry whose writer has been deleted is dead documentation, and dead documentation is
    // how the next reader learns to stop trusting the list.
    const stale = [...ALLOWED].filter((key) => !written.has(key)).sort();
    expect(stale).toEqual([]);
  });

  it('gives every listed field a non-empty reason', () => {
    for (const [key, reason] of [...WRITE_ONLY_BY_DESIGN, ...WRITE_ONLY_KNOWN_DEFECTS]) {
      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });

  it('lists the defects separately from the deliberate write-onlys, with no overlap', () => {
    const both = [...WRITE_ONLY_BY_DESIGN.keys()].filter((k) => WRITE_ONLY_KNOWN_DEFECTS.has(k));
    expect(both).toEqual([]);
  });
});

/**
 * SELF-CHECK. A scanner that silently stops finding writers, or stops finding readers, would make
 * the test above pass while checking nothing — the exact failure mode `sources/registry.test.ts`
 * was written to close ("a gate that checks nothing"). These pin both halves against keys whose
 * status is known from reading the code.
 */
describe('the rawFields scanner actually sees the tree', () => {
  it('finds the keys real sources really write, in all four write shapes', async () => {
    const written = await collectWrites();
    // `rawFields: { ... }` literal (nsf-awards), typed declaration + `= {` (federal/grantsGov),
    // `rawFields.x = ...` assignment (yaesu-dr2x), helper argument (manual-tier-d).
    expect([...written.keys()]).toEqual(expect.arrayContaining(['recordType', 'adjacencyScore']));
    expect(written.get('adjacencyScore')).toEqual(
      expect.arrayContaining([
        'sources/grants-gov-extract.ts',
        'sources/grants-gov-federal.ts',
        'sources/nsf-awards.ts',
        'sources/nsf-funding-rss.ts',
        'sources/usaspending.ts',
      ]),
    );
    expect(written.get('cfda')).toEqual(['federal/grantsGov.ts']);
    expect(written.get('opensAt')).toEqual(
      expect.arrayContaining(['sources/tier-c-b.ts', 'sources/yaesu-dr2x.ts']),
    );
    expect(written.get('whyManual')).toEqual(['sources/manual-tier-d.ts']);
    expect(written.size).toBeGreaterThan(30);
  });

  it('finds the readers real consumers really have, in all three read shapes', async () => {
    const readerSources = await collectReaderSources();
    expect(readerSources.length).toBeGreaterThan(20);
    // Property access, quoted subscript, and a name quoted on the same line as `rawFields`.
    expect(readersOf('recordType', readerSources)).toEqual(
      expect.arrayContaining(['normalize/index.ts', 'normalize/deadline.ts']),
    );
    expect(readersOf('Field of Study', readerSources).length).toBeGreaterThan(0);
    expect(readersOf('pricing', readerSources)).toEqual(['normalize/index.ts']);
    // The subject of this remediation: the score now reaches a consumer, and this names it.
    expect(readersOf('adjacencyScore', readerSources)).toEqual(['crawl/runner.ts']);
  });

  it('does not mistake a mention in a comment for a reader', async () => {
    // normalize/deadline.ts discusses `rawFields.status` at length in prose AND reads it in code.
    // The prose alone must not be what makes it look consumed, or a comment could keep a dead
    // field alive forever — which is close to how the do_not_publish bug survived review.
    const withOnlyAComment = [['fake/file.ts', stripComments('// raw.rawFields.ghostField\n')]] as Array<
      [string, string]
    >;
    expect(readersOf('ghostField', withOnlyAComment)).toEqual([]);
  });
});
