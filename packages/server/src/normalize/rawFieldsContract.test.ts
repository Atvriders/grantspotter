import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchedPayload, RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ROOT } from '../../test/fixtures.js';
import { TIER_D_RECORDS } from '../sources/manual-tier-d.js';
import { SOURCES } from '../sources/registry.js';
import { hasFollowUp, resolveRequests } from '../sources/types.js';

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
 * THE STATIC SCANNER'S BLIND SPOT, AND WHAT REPLACED IT (Plan 2 close-out review, 2026-08-03).
 * The write side used to be a static text scan only, and the reviewer walked three write shapes
 * past it with the full suite green: a SPREAD into the `rawFields` literal, a helper writing via
 * `Object.assign`, and — the expensive one — a COMPUTED SUBSCRIPT, `rawFields[key] = value` from a
 * pattern table in `util/singlePage.ts` and `arrl-scholarship-descriptions.ts`. That last shape
 * alone hid roughly 40 keys, 26 of them read by nothing, including `applyUrl`, `jotformId`,
 * `window`, `restrictions` and `residency` — and one of those was a live user-facing defect: QCWA's
 * page states its application URL, `tier-c-a.ts` parses it correctly into `rawFields.applyUrl`,
 * its own test asserts the parse, and nothing downstream read it, so the published record pointed
 * at the wrong page (close-out review B2, since fixed in `applyUrlFor`). This invariant existed
 * precisely to make that impossible, and could not see it.
 *
 * So the write side is now collected TWICE and unioned:
 *   1. statically, as before — it names the exact file a key is written in, which is what makes a
 *      failure actionable; and
 *   2. AT RUNTIME, by parsing every source over its committed fixtures and reading
 *      `Object.keys(raw.rawFields)` off the real records — exactly the way `TIER_D_RECORDS` was
 *      already handled. A key that reaches a real record cannot hide behind the syntax that wrote
 *      it, whatever that syntax is.
 * The runtime half is the authority on WHETHER a key exists; the static half is the authority on
 * WHERE it came from. Neither alone is enough: a key written only on a code path the fixtures do
 * not exercise is invisible to (2), and a key written by a subscript is invisible to (1).
 *
 * WHAT IT STILL CANNOT SEE: keys read through a computed subscript. There are none today; a
 * reader added that way would make this test fail with a false positive, and the fix is to name
 * the key in the allow-list or to read it by name.
 *
 * The self-check block at the bottom exists so that a scanner which silently stops seeing anything
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

const CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/rss+xml; charset=utf-8',
  '.b64': 'application/zip',
};

/**
 * Parse every source over its committed real captures and hand back the records themselves.
 *
 * This is the write side's ground truth (see the header). It is the same payload assembly
 * `scripts/profile-corpus.ts` uses — `NN-` files in order, first phase matched to `requests`, the
 * remainder to `followUp` — so a key that reaches a real record here is a key a real crawl writes.
 * Nothing is caught and swallowed: a parser that throws fails this test, because a write side that
 * silently stops seeing a source is the failure mode this whole file exists to break.
 */
async function parseAllFixtures(): Promise<{ byId: Map<string, RawOpportunity[]>; noCapture: string[] }> {
  const byId = new Map<string, RawOpportunity[]>();
  const noCapture: string[] = [];
  for (const source of SOURCES) {
    const dir = path.join(FIXTURE_ROOT, source.id);
    const captured = (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => /^\d\d-/.test(f))
      .sort();
    if (captured.length === 0) {
      noCapture.push(source.id);
      continue;
    }
    const requests = await resolveRequests(source);
    const payload = async (file: string, url: string): Promise<FetchedPayload> => ({
      url,
      status: 200,
      contentType: CONTENT_TYPE[path.extname(file)] ?? 'text/plain',
      body: await readFile(path.join(dir, file), 'utf8'),
      fetchedAt: '2026-08-02T00:00:00.000Z',
    });

    const payloads: FetchedPayload[] = [];
    const firstPhase = captured.slice(0, requests.length);
    for (const [i, file] of firstPhase.entries()) {
      payloads.push(await payload(file, requests[i]?.url ?? `file:///${file}`));
    }
    const rest = captured.slice(firstPhase.length);
    if (rest.length > 0 && hasFollowUp(source)) {
      const followUps = source.followUp(payloads);
      for (const [i, file] of rest.entries()) {
        payloads.push(await payload(file, followUps[i]?.url ?? `file:///${file}`));
      }
    }
    byId.set(source.id, source.parse(payloads));
  }
  return { byId, noCapture };
}

/**
 * key -> where it is written: a source file for a statically visible write, `parse:<sourceId>` for
 * a key observed on a real parsed record. Both halves are unioned — see the header for why one
 * without the other is not enough. Memoised because every `it` below needs it and parsing the
 * whole fixture tree three times is pure cost.
 */
let writesOnce: Promise<Map<string, string[]>> | undefined;

async function collectWrites(): Promise<Map<string, string[]>> {
  writesOnce ??= (async (): Promise<Map<string, string[]>> => {
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
    // ...and every other source gets the same treatment, from its real captures: spreads,
    // `Object.assign` and `rawFields[key] = …` all become plain keys on a real record.
    const { byId } = await parseAllFixtures();
    for (const [sourceId, raws] of byId) {
      for (const raw of raws) for (const key of Object.keys(raw.rawFields)) add(key, `parse:${sourceId}`);
    }
    return written;
  })();
  return writesOnce;
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
  ['windowSource', "Provenance for how yaesu-dr2x derived its opensAt/closesAt: 'pdf_title' or 'page_body'. The DATES are consumed (normalize/deadline.ts's observedWindow); which of the two channels produced them is for a reviewer auditing the capture, and no code branches on it."],

  // ---- Keys the runtime scan added on 2026-08-03 (see the header). Every one of these was
  // already being written by a live source through a computed subscript and was invisible until
  // the write side started reading real records. These are the ones that are genuinely write-only;
  // the rest went into WRITE_ONLY_KNOWN_DEFECTS below, which is where the honest majority landed.
  ['history', "QCWA's cumulative giving to date (\"As of 2024, 15 scholarships totaling $57,000 were awarded\"). A funder's track record, not this cycle's award: reading it as an amount is the exact $-decoy the amount parser is built to reject, and no Program field models lifetime giving."],
  ['pageUpdated', "NCDXF's own footer stamp (\"This page was updated January 3, 2014\"). Same rule as `date`/`modified`/`lastUpdatedDate`: freshness in this product is OUR observation (trust.lastVerifiedAt), never the funder's self-report — arrl.org's <lastmod> frozen at 2010 is what taught us that."],
  ['table', "The scholarship-requirements comparison table as captured, which on the real page is site chrome (\"ARRL Website Search Category Clubs Contests …\"). Its record is tagged `crosscheck` and can never publish; it exists so the ARRL catalogue can be diffed against ARRL's own summary by a human."],
  ['stake', "NCDXF's stated funding philosophy (\"expedition participants themselves should have a significant financial stake\"). An expectation of the applicant, not a rule any axis can evaluate: there is no profile field for how much of your own money you are putting in, and it is already inside rawText."],
  ['retiredPredecessor', "A note that NCDXF's earlier ARRL-administered scholarship is \"No Longer Active\". It describes a programme we deliberately do not publish; kept so the capture can be audited against the live page rather than acted on."],
  ['leadTime', "NCDXF's \"two months lead time for action\" — advice about when to ask, not a date. No DeadlineSpec kind models \"submit this long before you need the money\", and minting a deadline from it would publish a date the funder never stated, which is the failure mode inferDeadline is built to avoid."],
  ['workshopFund', "IEEE MTT-S's $500-per-chapter workshop seed fund. The programme bundles several distinct benefits and `Program.amount` models ONE award; folding a sibling benefit into it would overstate what a chapter actually receives. Kept as evidence beside the published amount."],
  ['travelSupport', "IEEE MTT-S's up-to-$2,250 Chapter-Chair travel support. Same as workshopFund: a sibling benefit of the same programme, deliberately not folded into the single published amount."],
]);

/**
 * Fields that are written and read by nothing and SHOULD NOT BE. These are not exemptions; they
 * are this invariant's first catch, recorded so that they are tracked rather than rediscovered.
 * Each names the consumer that ought to exist. They are listed separately from the by-design set
 * on purpose: an entry moving from here to a reader is progress, and an entry moving into here is
 * a decision somebody has to defend.
 *
 * SIX OF THE ORIGINAL EIGHT ARE NOW FIXED, and have been deleted from this list rather than
 * annotated — an entry here means "written and read by nothing", so once a reader exists the
 * entry is a lie, and the orphan check above is what keeps the key honest from then on:
 *
 *   opensAt, closesAt, openDate, closeDate, responseDate — `normalize/deadline.ts`'s
 *     `observedWindow` reads all five BY NAME (a computed subscript would be invisible to this
 *     scanner, which is why it does not use one). `inferDeadline` publishes the funder's own
 *     window in the DeadlineSpec note and promotes a kind that asserted no deadline exists;
 *     `inferStatus` computes `closed` from a close date the funder published and that has passed.
 *   applicantTypes — `normalize/index.ts`'s `entitiesFromApplicantTypes` maps Grants.gov's
 *     eligibility vocabulary onto ApplicantEntity, per record, ahead of ENTITIES_BY_SOURCE.
 *   excerpt, applyUrl — deleted on 2026-08-03, the day they were added: `buildSummary`'s firstOf
 *     list now includes `excerpt`, and `applyUrlFor` reads `rawFields.applyUrl` ahead of
 *     `formUrl`/`detailUrl`/`sourceUrl`, which is close-out review B2 closed. The "no listed field
 *     has since gained a reader" guard below is what forced both deletions rather than leaving two
 *     entries asserting a defect that no longer exists.
 *
 * The rest are untouched for the same reason the six were originally deferred: a fix made blind,
 * without re-reading the real capture the source was graded against, is how a wrong fact gets
 * published. What is NOT deferred any more is knowing they are there.
 */
const WRITE_ONLY_KNOWN_DEFECTS: ReadonlyMap<string, string> = new Map([
  ['oppStatus', "DEFECT. Grants.gov's own posted/closed/forecasted status. inferStatus ALREADY has an override seam — an explicit rawFields.status beats inference — and nothing maps oppStatus onto it, so a federal record's status is inferred from its dates while the funder's own answer sits unread. (The dates are now read; this is the remaining half.)"],

  // ---- THE SUBSCRIPT-WRITTEN BACKLOG, made visible on 2026-08-03 by collecting written keys off
  // real parsed records (see the header). None of these is a new write: every one has been written
  // by a live source, on the real capture, all along. They are listed here rather than in the
  // by-design map because in each case the funder stated something an applicant acts on and the
  // pipeline reads a fixed handful of key names instead — which is one defect with 18 faces, not
  // 18 defects. Consuming any of them deletes its entry (the guard below fails while a listed key
  // has a reader, so an entry cannot outlive the defect it describes).
  ['jotformId', "DEFECT (B2). The ARRL ETP application form id (252714368960161) parsed off \"Complete the 2025 ETP Grant Application on Jotform here\". Nothing builds an apply URL from it, so the record points at the catalogue page instead of the form the funder names."],
  ['window', "DEFECT (B1). The funder's own stated application window, in prose: ETP's \"OCTOBER 1ST AND OCTOBER 31ST of 2025.\", the ARRL scholarship page's \"Scholarship Cycle is now closed.\", Austin ARC's \"Applications open May 1 and close July 31 each year.\", ARISS's \"window opened July 1 and closes on September 30\". deadline.ts's observedWindow reads opensAt/closesAt/openDate/closeDate/responseDate BY NAME and not this, so records whose page states a closed or elapsed window still publish `open`."],
  ['windows', "DEFECT (B1). ARRL Amateur Radio Grants' three annual windows (\"February 1 - February 28 June 1 - June 30 October 1 - October 31\") — an n_fixed_windows RECUR deadline sitting parsed and unread, on a record that today falls outside all three of them and still publishes `open`."],
  ['deadline', "DEFECT (close-out review I2). Funder-published deadlines in prose: IEEE MTT-S's \"must be received by October 1\" and the IEEE Student Branch Rebate's \"Annual Plans are due 15 March.\" Both records assert no deadline is known while the date they need is in this key."],
  ['requestWindow', "DEFECT (B1/I2). QCWA's \"on or after October 31 of each year from the ARRL Foundation Committee\" — when the award may be requested, unread, on a record that publishes `open` year-round."],
  ['deadlineNote', "DEFECT (I2). QCWA's \"before the first week in January each year\" — the funder's own cutoff, parsed and unread, on a record whose deadline is asserted to be unknown."],
  ['applicationCycle', "DEFECT (I2). NASA CSLI's \"Announcements of Partnership Opportunity is typically released each August with proposals due in November\" — an annual cadence and a due month, unread."],
  ['cadence', "DEFECT (I2). ARISS's \"four proposal windows each year – one each quarter\", which is exactly the n_fixed_windows recurrence the DeadlineSpec RECUR kinds exist to carry, unread."],
  ['residency', "DEFECT (close-out review I5, the widening direction). YLRL's \"There are no residency restrictions. Non-U.S. Amateurs are eligible.\" — a funder statement that the geography and citizenship axes never receive by name, so an explicit widening cannot reach the matcher as one."],
  ['studyPreference', "DEFECT (B5). YLRL's \"Preference will be given to students studying communications, radio, electronics, or Amateur Radio related arts and sciences.\" — a PREFERENCE, which the preference axis is built to soften, delivered under a key the axis is never handed."],
  ['membershipPreference', "DEFECT (B5). YLRL's \"Preference will be given to YLRL members.\" Same shape: the one axis that exists to turn this into `eligible_preferred` rather than a bar never sees the field."],
  ['restrictions', "DEFECT. Funder-stated exclusions: ARRL Amateur Radio Grants' \"requests for emergency communications equipment … will not be considered\" / \"ongoing operations or expenses will not be considered\", and NCDXF's exclusion of commercial transportation costs. These are what an applicant needs to read before writing a proposal, and nothing consumes them."],
  ['applicant', "DEFECT. Hard applicant rules in the funder's words: ARRL Amateur Radio Grants' \"Grants are awarded only to organizations, not individuals\" and ETP's \"applicants must be a current ARRL member\". The entity and ARRL-membership axes are fed other keys, so both facts reach the matcher only if they happen to survive in rawText."],
  ['requirements', "DEFECT. IEEE MTT-S's \"Minimum of ten (10) members; five (5) members for Student Branch Chapters\" — a real org-side eligibility threshold with a profile field to compare against (OrgProfile.memberCount), unread."],
  ['teachers', "DEFECT. SARA's \"UPDATE: Teachers are now eligible to apply for grants to bring radio astronomy to the classroom.\" — a funder-published widening of who may apply, unread, on a record whose applicantEntities come from a per-source table instead."],
  ['benefit', "DEFECT, same shape as `excerpt` above. The funder's own description of what the award provides (NCDXF's full-tuition DX/Contest University scholarships; NASA CSLI's launch opportunity). buildSummary's firstOf list is ['summary','audience','eligibility','__preamble'], so these records fall back to a rawText dump while the funder's own sentence sits here."],
  ['amountNote', "DEFECT. ARRL Amateur Radio Grants' \"In support of ARRL's Year of the Club, award amounts may be up to $5,000 in 2026.\" — a qualifier on the published amount, with a year on it, that no consumer reads and no Program field carries."],
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

  /**
   * ...AND NO LISTED FIELD MAY HAVE QUIETLY GAINED A READER.
   *
   * This is the other half of staleness, and the review found the trap it closes: an allow-list
   * entry saying "nothing reads this, and that is a known defect" was simultaneously being cited
   * elsewhere as evidence that the same field was fine. An entry here is a claim about the code —
   * "this key reaches no consumer" — so the moment it stops being true the entry has to go, or the
   * list becomes a place where fixed things go to look broken and broken things go to look signed.
   *
   * Deleting the entry IS the fix, and it is one line. A red here is the good outcome: it means
   * somebody consumed the field.
   */
  it('keeps the write-only lists honest: no listed field has since gained a reader', async () => {
    const readerSources = await collectReaderSources();
    const consumed = [...ALLOWED]
      .map((key) => ({ key, readers: readersOf(key, readerSources) }))
      .filter((e) => e.readers.length > 0)
      .map((e) => `rawFields.${e.key} is now read by ${e.readers.join(', ')}`);
    expect(
      consumed,
      'these keys are listed as written-and-read-by-nothing but now have a consumer — delete ' +
        'their entries from WRITE_ONLY_BY_DESIGN / WRITE_ONLY_KNOWN_DEFECTS in ' +
        'rawFieldsContract.test.ts so the orphan check above starts guarding them again',
    ).toEqual([]);
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
    expect(written.get('cfda')).toEqual(expect.arrayContaining(['federal/grantsGov.ts']));
    expect(written.get('opensAt')).toEqual(
      expect.arrayContaining(['sources/tier-c-b.ts', 'sources/yaesu-dr2x.ts']),
    );
    expect(written.get('whyManual')).toEqual(expect.arrayContaining(['sources/manual-tier-d.ts']));
    expect(written.size).toBeGreaterThan(30);
  });

  /**
   * THE RUNTIME HALF, pinned against the three write shapes the static scan cannot see. Each of
   * these keys is written ONLY through a computed subscript on a real record, so if the fixture
   * parse ever stops running — or starts being swallowed — these assertions fail instead of the
   * write side silently shrinking back to what a text grep can find. That shrinkage is what let
   * ~40 keys, and B2 with them, hide for a whole plan.
   */
  it('finds the keys only a real parse reveals — spread, Object.assign and rawFields[key]', async () => {
    const written = await collectWrites();
    for (const [key, sourceId] of [
      ['applyUrl', 'qcwa'], // the B2 key — invisible to the static scan for as long as it was broken
      ['jotformId', 'arrl-etp-grants'],
      ['window', 'arrl-etp-grants'],
      ['residency', 'ylrl'],
      ['requirements', 'ieee-mtts'],
    ] as const) {
      expect(written.get(key), `${key} must be seen on a real ${sourceId} record`).toEqual(
        expect.arrayContaining([`parse:${sourceId}`]),
      );
    }
    // Static-only keys must NOT disappear when the runtime half is added, and vice versa: the two
    // halves are a union, not a replacement.
    expect(written.get('whyManual')).toEqual(['sources/manual-tier-d.ts']);
    expect([...written.values()].filter((w) => w.some((s) => s.startsWith('parse:'))).length)
      .toBeGreaterThan(30);
  });

  it('parses every source that has a real capture, and swallows nothing', async () => {
    const { byId, noCapture } = await parseAllFixtures();
    // manual-tier-d is hand-curated with `requests: []` and has no capture BY DESIGN — it is
    // covered through TIER_D_RECORDS instead. Any other source landing here means the write side
    // has gone blind to a whole module, which is exactly how this defect class starts.
    expect(noCapture).toEqual(['manual-tier-d']);
    expect(byId.size).toBeGreaterThan(20);
    const totalRecords = [...byId.values()].reduce((n, raws) => n + raws.length, 0);
    expect(totalRecords).toBeGreaterThan(500);
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
    // The subject of the previous remediation: the score now reaches a consumer, and this names it.
    expect(readersOf('adjacencyScore', readerSources)).toEqual(['crawl/runner.ts']);
    // The subject of THIS one. Named readers, not "somewhere downstream": if a later refactor
    // moves these back behind a computed subscript the scanner goes blind again, and the whole
    // defect class comes back silently. That is the failure this pins.
    for (const key of ['opensAt', 'closesAt', 'openDate', 'closeDate', 'responseDate']) {
      expect(readersOf(key, readerSources), `${key} must be read by name`).toEqual([
        'normalize/deadline.ts',
      ]);
    }
    expect(readersOf('applicantTypes', readerSources)).toEqual(['normalize/index.ts']);
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
