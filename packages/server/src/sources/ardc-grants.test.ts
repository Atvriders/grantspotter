import Database from 'better-sqlite3';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { expandCycles } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { runSource } from '../crawl/runner.js';
import { ensureIngestionSchema } from '../db/ingestSchema.js';
import { migrate } from '../db/migrate.js';
import { listChangeEvents, listReviewItems } from '../db/repositories/ingestion.js';
import { programIdFor } from './util/ids.js';
import type { NormalizeContext } from '../normalize/index.js';
import { isDoNotPublish, normalizeRaw } from '../normalize/index.js';
import { RECURRENCE_BY_SOURCE } from '../normalize/deadline.js';
import {
  APPLY_URL,
  INSTRUCTIONS_URL,
  ardcGrants,
  buildApplyRecord,
  buildChildrenRequest,
  monthDayOf,
  parseApplyPage,
  parseInstructionsPage,
  pastAwardClassification,
  resolveGrantsParentId,
} from './ardc-grants.js';

const DISCOVERY_URL =
  'https://www.ardc.net/wp-json/wp/v2/pages?slug=grants&per_page=100&_fields=id,slug,link,parent,title,modified';
/** The real parent id, read off the live API on 2026-08-03 — never hardcoded in the module. */
const PARENT_ID = 1271;
const CHILDREN_URL_PART = `parent=${PARENT_ID}`;

const discovery = () => fixturePayload('ardc-grants', '00-discovery.json', DISCOVERY_URL);
const children = () =>
  fixturePayload(
    'ardc-grants',
    '01-children.json',
    `https://www.ardc.net/wp-json/wp/v2/pages?parent=${PARENT_ID}&per_page=100`,
  );
/** The two apply pages, captured live 2026-08-03, HTTP 200 both (scripts/capture-fixture.ts). */
const applyHtml = () => loadFixture('ardc-grants', '02-apply.html');
const instructionsHtml = () => loadFixture('ardc-grants', '03-apply-instructions.html');
const apply = () => fixturePayload('ardc-grants', '02-apply.html', APPLY_URL);
const instructions = () =>
  fixturePayload('ardc-grants', '03-apply-instructions.html', INSTRUCTIONS_URL);
const allPayloads = () => [discovery(), children(), apply(), instructions()];

describe('resolveGrantsParentId', () => {
  it('reads the real parent id off the captured discovery response', () => {
    expect(resolveGrantsParentId(loadFixture('ardc-grants', '00-discovery.json'))).toBe(PARENT_ID);
  });

  // The live response carries ONE page with this slug today, so the collision case cannot be
  // exercised from the capture. It is a hand-written input on purpose, and it is labelled as
  // one — ardc.net has carried a second /news/grants/ page under the same slug before.
  it('matches on the link path, not the slug, when two pages share the slug (synthetic input)', () => {
    const twoPages = JSON.stringify([
      { id: 9001, slug: 'grants', link: 'https://www.ardc.net/news/grants/', parent: 55 },
      { id: PARENT_ID, slug: 'grants', link: 'https://www.ardc.net/apply/grants/', parent: 1193 },
    ]);
    expect(resolveGrantsParentId(twoPages)).toBe(PARENT_ID);
  });

  it('returns undefined when nothing matches rather than guessing an id', () => {
    expect(resolveGrantsParentId('[]')).toBeUndefined();
    expect(resolveGrantsParentId('{"code":"rest_no_route"}')).toBeUndefined();
    expect(resolveGrantsParentId('not json')).toBeUndefined();
  });
});

describe('buildChildrenRequest', () => {
  it('asks for the child pages of the resolved parent with the fields we need', () => {
    const req = buildChildrenRequest(PARENT_ID);
    expect(req.method).toBe('GET');
    expect(req.accept).toBe('json');
    expect(req.url).toContain(CHILDREN_URL_PART);
    expect(req.url).toContain('per_page=100');
    expect(req.url).toContain('_fields=id,slug,link,title,date,modified,parent,excerpt');
    expect(req.url).not.toContain('modified_after');
  });

  it('adds modified_after for an incremental poll — the confirmed working lever', () => {
    const req = buildChildrenRequest(PARENT_ID, '2026-07-01T00:00:00.000Z');
    expect(req.url).toContain('modified_after=2026-07-01T00%3A00%3A00.000Z');
  });
});

describe('ardcGrants source module', () => {
  it('is Tier A and starts with the discovery request only', async () => {
    expect(ardcGrants.tier).toBe('A');
    const requests = Array.isArray(ardcGrants.requests) ? ardcGrants.requests : [];
    expect(requests.map((r) => r.url)).toEqual([DISCOVERY_URL]);
    expect(requests[0].url).toContain('slug=grants');
    expect(requests[0].url).not.toMatch(/parent=\d/);
  });

  it('never hardcodes a parent page id anywhere in its requests', async () => {
    const requests = Array.isArray(ardcGrants.requests) ? ardcGrants.requests : [];
    for (const req of requests) expect(req.url).not.toContain(String(PARENT_ID));
  });

  it('followUp resolves the parent at runtime, then asks for the two apply pages', () => {
    const requests = ardcGrants.followUp([discovery()]);
    expect(requests[0].url).toContain(CHILDREN_URL_PART);
    expect(requests.map((r) => r.url).slice(1)).toEqual([APPLY_URL, INSTRUCTIONS_URL]);
    expect(requests[1].accept).toBe('html');
    expect(requests[2].accept).toBe('html');
  });

  it('followUp passes sinceISO through as modified_after', () => {
    const [req] = ardcGrants.followUp([discovery()], { sinceISO: '2026-07-01T00:00:00.000Z' });
    expect(req.url).toContain('modified_after=');
  });

  /**
   * A failed WordPress call must not take the opportunity off the board with it. Before the apply
   * leg existed, `followUp` returned [] here and there was nothing else to lose; now the archives
   * are the only thing that drops out, and the pages carrying the deadlines are still fetched.
   */
  it('still fetches both apply pages when discovery failed, rather than throwing mid-crawl', () => {
    expect(ardcGrants.followUp([]).map((r) => r.url)).toEqual([APPLY_URL, INSTRUCTIONS_URL]);
    expect(ardcGrants.followUp([{ ...discovery(), body: 'not json' }]).map((r) => r.url)).toEqual([
      APPLY_URL,
      INSTRUCTIONS_URL,
    ]);
  });

  it('parses every child page the live API returns', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    expect(raws).toHaveLength(8);
    const y2025 = raws.find((r) => r.rawFields.slug === '2025-grants');
    expect(y2025?.externalKey).toBe('9431');
    expect(y2025?.name).toBe('2025 Grants');
    expect(y2025?.sourceUrl).toBe('https://www.ardc.net/apply/grants/2025-grants/');
    expect(y2025?.rawFields.modified).toBe('2026-02-24T12:52:44');
  });

  it('strips HTML out of the WordPress excerpt but keeps the text verbatim', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    for (const raw of raws) expect(raw.rawText).not.toContain('<p>');
    const y2025 = raws.find((r) => r.rawFields.slug === '2025-grants');
    expect(y2025?.rawFields.excerpt).toContain(
      'Information on 2025 Charitable Gifts can be found below.',
    );
  });

  it('returns no archive records when the children payload is missing', () => {
    expect(ardcGrants.parse([discovery()])).toEqual([]);
  });

  it('states in notes what this source actually returns, and where the opportunity IS', () => {
    expect(ardcGrants.notes).toMatch(/custom-post-type/i);
    expect(ardcGrants.notes).toMatch(/never\s+hardcoded/i);
    expect(ardcGrants.notes).toMatch(/past_award/);
    expect(ardcGrants.notes).toMatch(/February 1 April 1 July 1 September 1/);
    expect(ardcGrants.notes).toMatch(/20% for indirect costs/);
  });
});

/**
 * B8. "Grants awarded in 2025" was published as an OPEN, club-eligible grant with an apply
 * button and 13 projected application cycles running to Sep 2029, while `ardc-award-tables`
 * classified the contents of that same URL as past awards. Which one it is, the funder says
 * itself, in the metadata this source already fetches.
 */
describe('a page of grants already made is history, not an opportunity', () => {
  const ctx = (): NormalizeContext => ({
    sourceId: 'ardc-grants',
    funderId: 'ardc',
    klass: 'ham_grant',
    tier: 'A',
    nowISO: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'live_fetch',
    mintId: programIdFor,
  });

  it('classifies every one of the eight live children as a past award', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    expect(raws).toHaveLength(8);
    for (const raw of raws) {
      expect(raw.rawFields.recordType, `${raw.name} must be past_award`).toBe('past_award');
      expect(raw.rawFields.deadlineKind, `${raw.name} must be dormant`).toBe('dormant');
    }
  });

  it('suppresses them through the same predicate the review queue calls', () => {
    for (const raw of ardcGrants.parse([discovery(), children()])) {
      const program = normalizeRaw(raw, ctx());
      expect(isDoNotPublish(program), program.name).toBe(true);
      expect(program.trust.status).toBe('closed');
    }
  });

  it('projects no application cycle off a page of finished grants', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    const y2025 = raws.find((r) => r.rawFields.slug === '2025-grants');
    const program = normalizeRaw(y2025!, ctx());
    expect(program.deadline.kind).toBe('dormant');
    // The RECUR directive is what expandCycles projects from. A dormant record carries none.
    expect(program.deadline.note).not.toMatch(/RECUR/);
    expect(program.deadline.note).not.toMatch(/02-01,04-01,07-01,09-01/);
  });

  it('reads the funder’s own words, not our guess: three independent signals', () => {
    const page = { id: 1, slug: '2025-grants', link: 'https://www.ardc.net/apply/grants/2025-grants/' };
    expect(pastAwardClassification(page, '')).toBe('past_award');
    expect(pastAwardClassification({ ...page, slug: 'x' }, 'Grants awarded in 2025.')).toBe('past_award');
    expect(pastAwardClassification({ id: 1, slug: 'x', title: { rendered: '2026 Grants' } }, '')).toBe(
      'past_award',
    );
  });

  it('treats a per-project page as history too — the shape 376 award-table links use', () => {
    const page = {
      id: 2,
      slug: 'grant-hamsci-psws-expansion',
      link: 'https://www.ardc.net/apply/grants/2025-grants/grant-hamsci-psws-expansion/',
    };
    expect(pastAwardClassification(page, '$77,000 to expand the PSWS network.')).toBe('past_award');
  });

  // The other direction, and the reason this is a classifier rather than a blanket suppression:
  // an unrecognised child page still publishes. Suppressing a page nobody has described would
  // hide a real award, which is the more expensive mistake of the two.
  it('does NOT suppress a child page it cannot classify', () => {
    const page = {
      id: 3,
      slug: 'priority-areas-for-funding',
      link: 'https://www.ardc.net/apply/grants/priority-areas-for-funding/',
      title: { rendered: 'Priority Areas for Funding' },
    };
    expect(pastAwardClassification(page, 'What we look for in a proposal.')).toBeUndefined();
  });

  // The other half of that fix, and the reason this one exists: suppressing ARDC's history left
  // the largest funder in the corpus offering NOTHING. The apply leg is what puts an opportunity
  // back, and it must not put the archives back with it.
  it('leaves the eight archives suppressed while the apply record publishes', () => {
    const raws = ardcGrants.parse(allPayloads());
    expect(raws).toHaveLength(9);
    const suppressed = raws.filter((raw) => isDoNotPublish(normalizeRaw(raw, ctx())));
    expect(suppressed).toHaveLength(8);
    expect(suppressed.map((r) => r.name).sort()).toEqual([
      '2019 Grants',
      '2020 Grants',
      '2021 Grants',
      '2022 Grants',
      '2023 Grants',
      '2024 Grants',
      '2025 Grants',
      '2026 Grants',
    ]);
    const published = raws.filter((raw) => !isDoNotPublish(normalizeRaw(raw, ctx())));
    expect(published.map((r) => r.externalKey)).toEqual(['apply']);
  });
});

/* ============================================================================================ */

/**
 * THE RESTORED OPPORTUNITY, ASSERTED AGAINST THE BYTES.
 *
 * Every fact below is quoted twice: once as a substring of the COMMITTED CAPTURE itself
 * (`loadFixture`, i.e. the HTML that came back from ardc.net at HTTP 200 on 2026-08-03 through
 * scripts/capture-fixture.ts), and once as the value the parser produced from it. That pairing is
 * the whole point. The Yaesu "12-month on-air obligation" this codebase shipped and then removed
 * appears ZERO times in Yaesu's real page: it existed only in hand-written fixtures, and every
 * test that asserted it asserted it against text an implementer had typed. A test that greps the
 * capture cannot do that.
 */
describe('the three facts ARDC publishes, quoted from the capture', () => {
  const ctx = (): NormalizeContext => ({
    sourceId: 'ardc-grants',
    funderId: 'ardc',
    klass: 'ham_grant',
    tier: 'A',
    nowISO: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'live_fetch',
    mintId: programIdFor,
  });
  const applyRecord = () => {
    const raw = ardcGrants.parse(allPayloads()).find((r) => r.externalKey === 'apply');
    if (raw === undefined) throw new Error('the apply record is missing from the real capture');
    return raw;
  };

  describe('1. the four application deadlines', () => {
    it('is in the captured bytes of /apply/, verbatim', () => {
      const html = applyHtml();
      expect(html).toContain('The 2026 application deadlines are:');
      expect(html).toContain('<li>February 1</li>');
      expect(html).toContain('<li>April 1</li>');
      expect(html).toContain('<li>July 1</li>');
      expect(html).toContain('<li>September 1 + Scholarship Program Applications Due</li>');
      expect(html).toContain(
        'Applications received after September 1, 2026 will be reviewed February 1, 2027.',
      );
    });

    it('is read off that list, not off a table in our code', () => {
      const facts = parseApplyPage(applyHtml());
      expect(facts.deadlineDates).toEqual(['02-01', '04-01', '07-01', '09-01']);
      expect(facts.deadlineText).toBe(
        'The 2026 application deadlines are: February 1 April 1 July 1 ' +
          'September 1 + Scholarship Program Applications Due ' +
          'Applications received after September 1, 2026 will be reviewed February 1, 2027. ' +
          'Please note that applications generally take 60-120 days to evaluate.',
      );
      expect(applyRecord().rawFields.deadline).toBe(facts.deadlineText);
    });

    /**
     * THE RECUR DIRECTIVE, CHECKED AGAINST THE FUNDER'S PAGE RATHER THAN TRUSTED.
     *
     * `RECURRENCE_BY_SOURCE['ardc-grants']` is a table WE wrote, and `expandCycles` projects a
     * calendar out of it forever. This is the assertion that the four dates in that table are the
     * four dates ARDC printed. A RECUR rule is only legitimate when the funder states a recurring
     * rule: ARDC does ("Four times a year, we review applications", and its own rollover from
     * September 1, 2026 to February 1, 2027). Contrast ARISS, whose single observed window is
     * deliberately NOT projected forward, because projecting it would publish a 2027 deadline
     * ARISS never announced.
     */
    it('matches the RECUR directive the calendar is projected from', () => {
      const directive = RECURRENCE_BY_SOURCE['ardc-grants'];
      const dates = /dates=([\d,-]+)/.exec(directive)?.[1];
      expect(dates).toBe(parseApplyPage(applyHtml()).deadlineDates.join(','));
      expect(instructionsHtml()).toContain('Four times a year, we review applications.');
    });

    it('projects the four cycles a year onto the calendar, next one 2026-09-01', () => {
      const program = normalizeRaw(applyRecord(), ctx());
      const cycles = expandCycles(program, [program], '2026-08-02T00:00:00.000Z', '2027-08-02T00:00:00.000Z');
      expect(cycles).toHaveLength(4);
      // The LABEL is the local calendar day ARDC printed; `closesAt` is 23:59 America/Los_Angeles
      // rendered in UTC, which lands on the following morning (and shifts an hour across DST).
      expect(cycles.map((c) => c.label)).toEqual([
        'Sep 1, 2026 deadline',
        'Feb 1, 2027 deadline',
        'Apr 1, 2027 deadline',
        'Jul 1, 2027 deadline',
      ]);
      expect(cycles[0].closesAt).toBe('2026-09-02T06:59:00.000Z');
      expect(cycles[0].timezone).toBe('America/Los_Angeles');
    });

    it('never reads the rollover sentence as two more deadlines', () => {
      // "September 1, 2026" and "February 1, 2027" are in that sentence. Neither is a list item,
      // and the record carries exactly four dates.
      expect(monthDayOf('Applications received after September 1, 2026 will be reviewed')).toBeUndefined();
      expect(monthDayOf('February 1')).toBe('02-01');
      expect(monthDayOf('September 1 + Scholarship Program Applications Due')).toBe('09-01');
    });
  });

  describe('2. the open-access requirement', () => {
    it('is in the captured bytes of both pages, verbatim', () => {
      expect(applyHtml()).toContain(
        'Because ARDC works with and for the public, we require that the work of the projects we ' +
          'fund be freely available to everyone who can benefit and to everyone who can contribute. ' +
          'Thus, all technology, documentation, and other materials produced using ARDC funds must ' +
          'be made freely available to the public, ideally using one of the below open source licenses:',
      );
      expect(applyHtml()).toContain('<li>Software: GPL licenses (esp. AGPLv3), MIT, BSD, LGPL</li>');
      expect(applyHtml()).toContain('<li>Hardware: CERN Open Hardware License</li>');
      // The instructions page states it as an ELIGIBILITY rule. The <a> around the phrase is why
      // this half is asserted on the parsed text as well as on the raw markup.
      expect(instructionsHtml()).toContain('open source and open access');
      expect(parseInstructionsPage(instructionsHtml()).openAccessRule).toContain(
        'projects that are not open source and open access are not eligible.',
      );
    });

    it('reaches the published record', () => {
      const program = normalizeRaw(applyRecord(), ctx());
      expect(program.rawOtherText).toContain(
        'all technology, documentation, and other materials produced using ARDC funds must be ' +
          'made freely available to the public',
      );
      expect(program.rawOtherText).toContain(
        'projects that are not open source and open access are not eligible.',
      );
      expect(program.rawOtherText).toContain('Software: GPL licenses (esp. AGPLv3), MIT, BSD, LGPL');
      expect(program.rawOtherText).toContain('Hardware: CERN Open Hardware License');
    });
  });

  describe('3. the 20% indirect cost cap', () => {
    it('is in the captured bytes of the instructions page, verbatim', () => {
      expect(instructionsHtml()).toContain('You may include up to 20% for indirect costs');
      expect(instructionsHtml()).toContain(
        'If your organization’s indirect cost rate is more than 20%, we ask that you cost-share ' +
          'any indirect amount over 20% to allow us to maximize the funds we can distribute to others.',
      );
    });

    it('is parsed as the funder’s whole sentence and reaches the published record', () => {
      const cap = parseInstructionsPage(instructionsHtml()).indirectCost;
      expect(cap).toContain('Indirect costs/contingency. You may include up to 20% for indirect costs');
      expect(cap).toContain('we ask that you cost-share any indirect amount over 20%');
      expect(normalizeRaw(applyRecord(), ctx()).rawOtherText).toContain(cap!);
    });
  });

  describe('the record as a whole', () => {
    it('is an open opportunity with the funder’s own apply route', () => {
      const program = normalizeRaw(applyRecord(), ctx());
      expect(program.trust.status).toBe('open');
      expect(program.deadline.kind).toBe('n_fixed_dates');
      expect(program.applyUrl).toBe('https://grants.ardc.net');
      expect(program.trust.sourceUrl).toBe(APPLY_URL);
      expect(isDoNotPublish(program)).toBe(false);
      expect(program.applicantEntities).toContain('club_501c3');
      expect(program.applicantEntities).toContain('school_lea');
    });

    it('takes its apply URL from ARDC’s own link, and its name from ARDC’s own <h1>', () => {
      expect(applyHtml()).toContain('href="https://grants.ardc.net"');
      expect(applyHtml()).toContain('<h1 class="page-title">Apply for a Grant</h1>');
      const raw = applyRecord();
      expect(raw.name).toBe('Apply for a Grant');
      expect(raw.rawFields.applyUrl).toBe('https://grants.ardc.net');

      // ...and it really is read off the page. ardc.net's FIRST <h1> is the site logo image
      // (`<h1 class="image-logo">`, no text), which is how an earlier draft of this parser came to
      // fall back to a hardcoded name and pass its own test by asserting our literal back to us.
      expect(applyHtml()).toContain('<h1 class="image-logo">');
      expect(parseApplyPage(applyHtml()).name).toBe('Apply for a Grant');
      // Drop the real heading and ARDC's own <title> takes over — still their text, never ours.
      expect(parseApplyPage(applyHtml().replace(/<h1 class="page-title">[^<]*<\/h1>/, '')).name).toBe(
        'Apply for a Grant | ARDC',
      );
    });

    it('summarises the programme in ARDC’s own Overview sentence', () => {
      expect(normalizeRaw(applyRecord(), ctx()).summary).toBe(
        'ARDC makes grants to programs and organizations that aim to advance our mission and ' +
          'vision, with the strategic goals of getting more people learning, experimenting, and ' +
          'doing with amateur radio and digital communications technology.',
      );
    });

    /**
     * The number a reviewer is most likely to want in `amount`, and the one that would be most
     * wrong. "$3.8 million" is ARDC's ANNUAL GRANTMAKING BUDGET, not an award.
     */
    it('publishes no award amount, because ARDC states none', () => {
      expect(instructionsHtml()).toContain('in 2026 we aim to fund approximately $3.8 million');
      const raw = applyRecord();
      // The figure survives as EVIDENCE inside the funder's own sentence ("Our grantmaking budget
      // varies yearly; in 2026 we aim to fund approximately $3.8 million"), which is also the
      // sentence that states the four-times-a-year cadence. What it must never become is a field
      // `buildAmount` reads — those are 'Award Amount', 'amountRaw', 'amount' and 'pricing'.
      for (const key of ['Award Amount', 'amountRaw', 'amount', 'pricing']) {
        expect(raw.rawFields[key]).toBeUndefined();
      }
      const program = normalizeRaw(raw, ctx());
      expect(program.amount.amountRaw).toBe('');
      expect(program.amount.amountMax).toBeUndefined();
      expect(program.amount.amountMin).toBeUndefined();
    });
  });

  /**
   * WHAT HAPPENS WHEN THE PAGE IS NOT THERE. An honestly empty source beats a fabricated one:
   * this is the same rule that says a fixture is never hand-written, applied at runtime.
   */
  describe('nothing is synthesised from a page that did not come back', () => {
    it('emits no apply record at all when /apply/ failed to fetch', () => {
      const raws = ardcGrants.parse([discovery(), instructions(), children()]);
      expect(raws.map((r) => r.externalKey)).not.toContain('apply');
      expect(raws).toHaveLength(8);
      expect(buildApplyRecord(undefined, undefined)).toBeUndefined();
    });

    it('never mistakes the instructions page for the apply page (both live under /apply/)', () => {
      // A substring match on "https://www.ardc.net/apply/" matches BOTH urls. The instructions
      // page carries no deadline list, so a record built from it would be an opportunity with no
      // date — which is exactly what the exact-URL match in parse() prevents.
      expect(parseApplyPage(instructionsHtml()).deadlineDates).toEqual([]);
      expect(buildApplyRecord(instructions(), instructions())).toBeUndefined();
    });

    it('emits no record when a redesigned page no longer lists any deadline (synthetic input)', () => {
      // Hand-written INPUT, labelled as one, for a case the live page cannot exercise: the real
      // capture has the list. What is asserted is the refusal, not a fact about ARDC.
      const stripped = applyHtml().replace(/The 2026 application deadlines are:/, 'Deadlines vary.');
      expect(parseApplyPage(stripped).deadlineDates).toEqual([]);
      expect(
        buildApplyRecord({ ...apply(), body: stripped }, instructions()),
      ).toBeUndefined();
    });

    it('still produces the record when only the instructions page is missing', () => {
      const raw = buildApplyRecord(apply(), undefined);
      expect(raw?.externalKey).toBe('apply');
      // ...minus the fact that page carries, which is not asserted from anywhere else.
      expect(raw?.rawFields.rawOtherText).not.toContain('20% for indirect costs');
    });
  });
});

/**
 * THE REVIEW QUEUE, END TO END. `isDoNotPublish` is asserted above at the predicate; this runs the
 * real crawl seam over the real captures and counts what a human would actually be shown. Before
 * the apply leg existed this source parsed 8 records and queued 0 — the funder with the most money
 * in the corpus, offering nothing. The archives are not queued now either; they are stored.
 */
describe('what reaches the human queue', () => {
  const NOW = '2026-08-02T00:00:00.000Z';
  const fetcher = {
    async fetch(req: FetchRequest): Promise<FetchedPayload> {
      if (req.url === APPLY_URL) return { ...apply(), url: req.url };
      if (req.url === INSTRUCTIONS_URL) return { ...instructions(), url: req.url };
      if (req.url.includes('slug=grants')) return { ...discovery(), url: req.url };
      if (req.url.includes('parent=')) return { ...children(), url: req.url };
      return { url: req.url, status: 404, contentType: 'text/html', body: '', fetchedAt: NOW };
    },
  };

  it('parses nine records and queues exactly one: the application', async () => {
    const db = new Database(':memory:');
    migrate(db);
    ensureIngestionSchema(db);
    const result = await runSource({ db, fetcher, nowISO: () => NOW }, 'ardc-grants');

    expect(result.error).toBeUndefined();
    expect(result.parsedCount).toBe(9);
    expect(result.reviewItems).toBe(1);

    const queued = listReviewItems(db, 'pending');
    expect(queued.map((item) => item.candidate.name)).toEqual(['Apply for a Grant']);
    expect(queued[0].candidate.trust.status).toBe('open');
    expect(queued[0].candidate.applyUrl).toBe('https://grants.ardc.net');

    // ...and the eight archives are STORED, not lost: suppression costs no evidence.
    const stored = listChangeEvents(db, 500).filter((e) => e.sourceId === 'ardc-grants');
    expect(stored.length).toBeGreaterThanOrEqual(9);
    db.close();
  });
});
