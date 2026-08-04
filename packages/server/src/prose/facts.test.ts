import type { Funder, OrgProfile, Program } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { TODO_MARKER_SCAN, fillTemplate, renderSlotValue } from '../templates/fill.js';
import { buildSlotContext, describeSlotKnowledge } from '../templates/slots.js';
import { buildDocIndex, isFigureToken, tokenize } from './features.js';
import {
  type FactChecklistItem,
  type FactConfirmation,
  type FactSource,
  buildFactChecklist,
  exportReadiness,
  extractFactAssertions,
  factSourcesFromKnowledge,
  unconfirmedCount,
} from './facts.js';

const DRAFT = [
  'Dana Ruiz will teach four sessions starting March 7, 2027 at a cost of $1,450.',
  'Attendance rose 32% after W8UM ran the same class in 2026.',
  'See Kobak et al., 2025 and https://www.ardc.net/apply/ for the criteria.',
  'The DOI is doi:10.1126/sciadv.adt3813.',
].join(' ');

describe('extractFactAssertions', () => {
  const facts = extractFactAssertions(DRAFT);
  const kinds = (k: string): string[] => facts.filter((f) => f.kind === k).map((f) => f.text);

  it('finds money, percentages, dates, callsigns, names, urls and citations', () => {
    expect(kinds('money')).toContain('$1,450');
    expect(kinds('percent')).toContain('32%');
    expect(kinds('date').some((t) => t.includes('March 7, 2027'))).toBe(true);
    expect(kinds('callsign')).toContain('W8UM');
    expect(kinds('name')).toContain('Dana Ruiz');
    expect(kinds('url')).toContain('https://www.ardc.net/apply/');
    expect(kinds('citation').some((t) => t.includes('Kobak et al., 2025'))).toBe(true);
    expect(kinds('citation').some((t) => t.includes('10.1126/sciadv.adt3813'))).toBe(true);
  });

  it('classifies a DOI as a citation rather than as a url or a figure', () => {
    const doi = facts.find((f) => f.text.includes('10.1126'));
    expect(doi?.kind).toBe('citation');
    expect(facts.filter((f) => f.text === '10.1126')).toEqual([]);
  });

  it('does not double-count a number that is already inside money, a percentage or a date', () => {
    expect(facts.filter((f) => f.kind === 'figure').map((f) => f.text)).not.toContain('1,450');
    expect(facts.filter((f) => f.kind === 'figure').map((f) => f.text)).not.toContain('32');
  });

  it('returns non-overlapping spans sorted by position, each with context', () => {
    for (let i = 1; i < facts.length; i++) {
      expect(facts[i]!.start).toBeGreaterThanOrEqual(facts[i - 1]!.end);
    }
    for (const f of facts) {
      expect(DRAFT.slice(f.start, f.end)).toBe(f.text);
      expect(f.context).toContain(f.text);
      expect(f.context).not.toContain('\n');
      expect(f.id).toMatch(/^[a-z]+:\d+$/);
    }
  });

  it('finds nothing in a passage with no assertions', () => {
    expect(extractFactAssertions('We would like to improve the station.')).toEqual([]);
  });
});

describe('buildFactChecklist and exportReadiness', () => {
  it('starts every item unconfirmed', () => {
    const items = buildFactChecklist(DRAFT);
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((i) => i.confirmed === false)).toBe(true);
    expect(items.every((i) => i.note === '')).toBe(true);
    expect(unconfirmedCount(items)).toBe(items.length);
  });

  it('applies stored confirmations by stable id', () => {
    const first = buildFactChecklist(DRAFT)[0]!;
    const items = buildFactChecklist(DRAFT, {
      [first.id]: { confirmed: true, note: 'checked the invoice' },
    });
    expect(items[0]?.confirmed).toBe(true);
    expect(items[0]?.note).toBe('checked the invoice');
    expect(unconfirmedCount(items)).toBe(items.length - 1);
  });

  it('blocks export until every assertion is confirmed', () => {
    const before = exportReadiness(DRAFT);
    expect(before.ready).toBe(false);
    expect(before.unconfirmed).toBe(before.items.length);

    const all: Record<string, { confirmed: boolean; note: string }> = {};
    for (const item of before.items) all[item.id] = { confirmed: true, note: '' };
    const after = exportReadiness(DRAFT, all);
    expect(after.ready).toBe(true);
    expect(after.unconfirmed).toBe(0);
  });

  it('treats a draft with no assertions as ready', () => {
    expect(exportReadiness('We would like to improve the station.').ready).toBe(true);
  });

  it('flags any remaining TODO marker as blocking', () => {
    const readiness = exportReadiness(
      'The club [TODO: club.callsign — your club’s FCC callsign, e.g. W8UM] applies.',
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.openTodos).toBe(1);
  });
});

/**
 * A GAP IS NOT A FACT.
 *
 * `todoFor` writes the vocabulary hint into the marker, and eight of those hints carry a
 * fact-shaped example — `e.g. W8UM`, `e.g. KD9XYZ`, `e.g. 1909`, `e.g. MI`, `e.g. 2027-01-15`.
 * A checklist that reads the whole document with regexes lists those examples as assertions
 * awaiting confirmation, and a checklist that asks "did you check W8UM?" about a hole where the
 * callsign is still missing is the same tool that published a 12-month on-air obligation nobody
 * ever wrote: a plausible value, surfaced as established, that no source asserts.
 *
 * `fill.ts` anticipated this and says so in `stripTodoMarkers`'s doc comment. This module cannot
 * import it (prose/ is import-sealed), so the two are pinned against each other below.
 */
describe('a [TODO: …] gap is a hole, never an assertion', () => {
  const WITH_GAP =
    'The club [TODO: club.callsign — your club’s FCC callsign, e.g. W8UM] was founded in ' +
    '[TODO: club.foundedYear — the year the club was founded, e.g. 1909] and asks for $250.';

  it('lists no assertion drawn from inside a marker', () => {
    const texts = extractFactAssertions(WITH_GAP).map((f) => f.text);
    expect(texts).not.toContain('W8UM');
    expect(texts).not.toContain('1909');
    expect(texts).not.toContain('club.callsign');
    expect(texts).toContain('$250');
  });

  it('still blocks export on the gaps themselves, counted once each', () => {
    const readiness = exportReadiness(WITH_GAP);
    expect(readiness.openTodos).toBe(2);
    expect(readiness.ready).toBe(false);
  });

  it('confirming every listed fact does not release a draft that still has a hole', () => {
    const confirmations: Record<string, { confirmed: boolean; note: string }> = {};
    for (const item of buildFactChecklist(WITH_GAP)) {
      confirmations[item.id] = { confirmed: true, note: '' };
    }
    const readiness = exportReadiness(WITH_GAP, confirmations);
    expect(readiness.unconfirmed).toBe(0);
    expect(readiness.ready).toBe(false);
  });

  it('agrees with fill.ts about the shape of a marker', () => {
    // If Task 3 ever changes the marker, the gate that counts it must move in the same commit.
    const marker = '[TODO: club.callsign — your club’s FCC callsign, e.g. W8UM]';
    expect([...marker.matchAll(TODO_MARKER_SCAN())].length).toBe(1);
    expect(exportReadiness(marker).openTodos).toBe(1);
  });
});

/**
 * Classes of assertion a money/percent/date/callsign/name/url/citation regex set does not reach.
 * Each one below is a specific a funder can check, and each was missing until it was asked for.
 */
describe('the specifics a reviewer can check', () => {
  it('lists a model number and a manufacturer, not the bare digits inside them', () => {
    const facts = extractFactAssertions('The grant buys one Icom IC-7300 and a Comet GP-3 antenna.');
    const texts = facts.map((f) => f.text);
    expect(texts).toContain('IC-7300');
    expect(texts).toContain('Icom');
    expect(texts).toContain('GP-3');
    expect(texts).toContain('Comet');
    expect(texts).not.toContain('7300');
  });

  /**
   * The hyphenated compound is listed WHOLE — `ARRL-affiliated`, not `ARRL`. That is the claim a
   * reviewer would check ("is this club actually an ARRL-affiliated club?"), and clipping the span
   * at the hyphen to recover the bare acronym would lose `IC-7300` and `GP-3` with it.
   */
  it('lists an acronym that names an organization', () => {
    const texts = extractFactAssertions('The club is ARRL-affiliated and ARDC funds the program.').map(
      (f) => f.text,
    );
    expect(texts).toContain('ARRL-affiliated');
    expect(texts).toContain('ARDC');
  });

  it('lists where to apply when the route is an address rather than a URL', () => {
    const facts = extractFactAssertions(
      'Email the packet to grants@example.org or call (555) 010-4477 before the deadline.',
    );
    const contacts = facts.filter((f) => f.kind === 'contact').map((f) => f.text);
    expect(contacts).toContain('grants@example.org');
    expect(contacts).toContain('(555) 010-4477');
  });

  it('quotes a citation with balanced brackets, in both of the shapes people write', () => {
    const parenthesised = extractFactAssertions('The finding is real (Kobak et al., 2025).');
    expect(parenthesised.map((f) => f.text)).toContain('Kobak et al., 2025');
    const authorYear = extractFactAssertions('See Kobak et al. (2025) for the vocabulary result.');
    expect(authorYear.map((f) => f.text)).toContain('Kobak et al. (2025)');
  });

  it('lists a count written as a word, because a claim of scale is a claim', () => {
    const texts = extractFactAssertions('Three of our members will teach four Saturday classes.').map(
      (f) => f.text,
    );
    expect(texts).toContain('Three');
    expect(texts).toContain('four');
  });

  it('leaves the vague quantifier "one" alone in the two idioms that carry no scale', () => {
    const texts = extractFactAssertions('No one is left behind, and one of the goals is licensing.').map(
      (f) => f.text,
    );
    expect(texts).not.toContain('one');
  });

  it('lists a clock time as one fact rather than as four bare numbers', () => {
    const texts = extractFactAssertions('Members meet Saturdays 10:00-12:00 in Room 214.').map(
      (f) => f.text,
    );
    expect(texts).toContain('10:00');
    expect(texts).toContain('12:00');
    expect(texts).not.toContain('00');
    expect(texts).toContain('214');
  });

  it('lists an EIN as one fact rather than as two numbers', () => {
    const texts = extractFactAssertions('The club EIN is 38-1234567.').map((f) => f.text);
    expect(texts).toContain('38-1234567');
    expect(texts).not.toContain('38');
  });

  it('does not mistake an ordinary sentence-opening capital for a named thing', () => {
    expect(extractFactAssertions('Members meet weekly. Students are welcome.')).toEqual([]);
  });

  /**
   * The classes this module cannot enumerate, pinned as behaviour so that nobody reads the
   * checklist as a completeness guarantee. Each of these sentences carries a real assertion a
   * funder could check, and none of them has a token to match. The module header says so; this
   * says so in a way that turns red if someone quietly adds a keyword list and calls it done.
   */
  it('lists nothing at all for a claim made entirely in words', () => {
    expect(extractFactAssertions('We are the only collegiate club in the state.')).toEqual([]);
    expect(extractFactAssertions('Every member is licensed and all of them teach.')).toEqual([]);
    expect(extractFactAssertions('Attendance rose after we bought the radio.')).toEqual([]);
  });
});

describe('spans stay honest across line breaks', () => {
  const MULTILINE = [
    '# Station Rebuild',
    '',
    'Elena Ruiz will teach on 2027-01-15 in',
    'Room 214, Engineering Building.',
    '',
    'The club asks for $1,450 of a $2,900 total.',
  ].join('\n');

  it('never emits a span that straddles a newline, and every context is one line', () => {
    const facts = extractFactAssertions(MULTILINE);
    expect(facts.length).toBeGreaterThan(4);
    for (const f of facts) {
      expect(MULTILINE.slice(f.start, f.end)).toBe(f.text);
      expect(f.text).not.toContain('\n');
      expect(f.context).not.toContain('\n');
      expect(f.context).toContain(f.text);
    }
    expect(facts.map((f) => f.text)).toContain('Elena Ruiz');
    expect(facts.map((f) => f.text)).toContain('Engineering Building');
  });
});

// ---------------------------------------------------------------------------
// A real filled draft: template -> slot context -> fillTemplate -> checklist.
// ---------------------------------------------------------------------------

const ORG: OrgProfile = {
  kind: 'organization',
  entity: 'club_unincorporated',
  orgName: 'Example Collegiate Amateur Radio Club',
  callsign: 'W8UM',
  state: 'MI',
  memberCount: 34,
  institutionName: 'Example State University',
  arrlAffiliated: true,
};

const PROGRAM = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Grants for amateur radio and digital communication.',
  applicantEntities: ['club_via_fiscal_sponsor', 'university'],
  amount: { instrument: 'cash_range', amountRaw: '$1,285-$258,000', awardCountRaw: 'Multiple per year' },
  deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: 'Feb 1, Apr 1, Jul 1, Sep 1' },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.ardc.net/apply/',
  constraints: [],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'permitted' },
  trust: {
    status: 'open',
    sourceUrl: 'https://www.ardc.net/apply/',
    lastVerifiedAt: '2026-08-02',
    verificationMethod: 'live_fetch',
    contentHash: 'abc',
  },
  rawOtherText: '',
  tags: [],
} as unknown as Program;

const FUNDER: Funder = {
  id: 'ardc',
  name: 'Amateur Radio Digital Communications',
  homepage: 'https://www.ardc.net/',
};

const ANSWERS: Record<string, string> = {
  'project.title': 'Saturday Licence Class and Station Rebuild',
  'project.requestAmount': '$1,450',
  'project.venue': 'Room 214, Engineering Building',
  'project.startDate': '2027-01-15',
  'team.instructorName': 'Elena Ruiz, faculty advisor',
};

const TEMPLATE = [
  '# {{project.title}}',
  '',
  '{{club.name}} ({{club.callsign}}) at {{club.institution}} requests {{project.requestAmount}}',
  'from the {{funder.programName}}. The club has {{club.memberCount}} members and was founded in',
  '{{club.foundedYear}}.',
  '',
  '{{team.instructorName}} will teach four sessions in {{project.venue}}, beginning',
  '{{project.startDate}}. The grant buys one Icom IC-7300 and a Comet GP-3 antenna.',
  '',
  'Attendance rose 32% after the 2026 pilot, which reached 41 students (Kobak et al., 2025).',
  'Apply at {{funder.applyUrl}}, or write to grants@example.org.',
].join('\n');

const KNOWLEDGE = describeSlotKnowledge({
  profile: ORG,
  program: PROGRAM,
  funder: FUNDER,
  answers: ANSWERS,
});
const FILLED = fillTemplate(TEMPLATE, buildSlotContext({
  profile: ORG,
  program: PROGRAM,
  funder: FUNDER,
  answers: ANSWERS,
})).markdown;
const SOURCES: FactSource[] = factSourcesFromKnowledge(KNOWLEDGE, renderSlotValue);

/**
 * THE PROPERTY THAT MATTERS: every factual claim in a filled draft reaches the checklist.
 *
 * Enumerated twice on purpose — once by hand, from reading the draft, and once mechanically by
 * Task 12's tokenizer, which is a different mechanism from this module's matchers. An assertion
 * that reaches neither list is the failure this whole task exists to prevent.
 */
describe('every claim in a filled draft reaches the checklist', () => {
  const items = buildFactChecklist(FILLED, {}, SOURCES);
  const texts = items.map((i) => i.text);

  it('was filled from the real slot pipeline and still shows its gap', () => {
    expect(FILLED).toContain('Example Collegiate Amateur Radio Club');
    expect(FILLED).toContain('[TODO: club.foundedYear');
  });

  it.each([
    ['Example Collegiate Amateur Radio Club', 'name'],
    ['W8UM', 'callsign'],
    ['Example State University', 'name'],
    ['$1,450', 'money'],
    ['ARDC', 'entity'],
    ['34', 'figure'],
    ['Elena Ruiz', 'name'],
    ['four', 'figure'],
    ['Room', 'entity'],
    ['214', 'figure'],
    ['Engineering Building', 'name'],
    ['2027-01-15', 'date'],
    ['Icom', 'entity'],
    ['IC-7300', 'entity'],
    ['Comet', 'entity'],
    ['GP-3', 'entity'],
    ['32%', 'percent'],
    ['2026', 'date'],
    ['41', 'figure'],
    ['https://www.ardc.net/apply/', 'url'],
    ['grants@example.org', 'contact'],
  ])('lists %s as a %s', (claim, kind) => {
    const item = items.find((i) => i.text === claim);
    expect(item, `${claim} never reached the checklist`).toBeDefined();
    expect(item?.kind).toBe(kind);
  });

  it('lists the citation', () => {
    expect(texts.some((t) => t.includes('Kobak et al., 2025'))).toBe(true);
  });

  it('lists nothing that the hint inside the unfilled gap put there', () => {
    expect(texts).not.toContain('1909');
    expect(items.every((i) => !i.text.includes('TODO'))).toBe(true);
  });

  /**
   * The independent enumeration. Every token Task 12 would count as a figure or as a proper noun
   * — outside the gaps — has to be covered by some checklist item. It reads the draft with a
   * tokenizer rather than with this module's regexes, so a class of assertion the matchers cannot
   * see shows up here as an uncovered token instead of as silence.
   */
  it('covers every figure and every proper noun the tokenizer finds', () => {
    const prose = FILLED.replace(TODO_MARKER_SCAN(), ' ');
    const doc = buildDocIndex(prose);
    const required = tokenize(prose).filter(
      (t) => isFigureToken(t) || doc.midSentenceCapitalized.has(t),
    );
    expect(required.length).toBeGreaterThan(10);

    const uncovered = [...new Set(required)].filter(
      (token) => !texts.some((text) => text.includes(token)),
    );
    expect(uncovered, `assertions no checklist item covers: ${uncovered.join(', ')}`).toEqual([]);
  });
});

/**
 * WHO SAID SO. A value the applicant typed, a value read off their saved profile and a value read
 * off a funder's published page are in three different epistemic positions, and a checklist that
 * flattens them into one wall of checkboxes cannot be reviewed. `describeSlotKnowledge` already
 * carries `origin` on every `known` entry; this is that origin, per item.
 */
describe('origin, per item', () => {
  const items = buildFactChecklist(FILLED, {}, SOURCES);
  const find = (text: string): FactChecklistItem => {
    const item = items.find((i) => i.text === text);
    if (item === undefined) throw new Error(`no checklist item for ${text}`);
    return item;
  };

  it('says the applicant typed it', () => {
    const money = find('$1,450');
    expect(money.origin).toBe('answer');
    expect(money.slots).toEqual(['project.requestAmount']);
    expect(money.provenance).toContain('project.requestAmount');
    expect(money.provenance.toLowerCase()).toContain('typed');
  });

  it('says it came off the saved profile', () => {
    const callsign = find('W8UM');
    expect(callsign.origin).toBe('profile');
    expect(callsign.slots).toEqual(['club.callsign']);
    expect(callsign.provenance.toLowerCase()).toContain('profile');
  });

  it('says the funder published it, and still asks the applicant to check it', () => {
    const url = find('https://www.ardc.net/apply/');
    expect(url.origin).toBe('program');
    expect(url.slots).toEqual(['funder.applyUrl']);
    expect(url.provenance.toLowerCase()).toContain('funder');
    expect(url.confirmed).toBe(false);
  });

  it('says plainly when nothing accounts for a claim', () => {
    const model = find('IC-7300');
    expect(model.origin).toBe('unattributed');
    expect(model.slots).toEqual([]);
    expect(model.provenance.toLowerCase()).toContain('confirm');
  });

  it('refuses to guess when two slots from different sources hold the same value', () => {
    const knowledge = describeSlotKnowledge({
      profile: ORG,
      answers: { 'student.state': 'MI' },
    });
    const sources = factSourcesFromKnowledge(knowledge, renderSlotValue);
    const items2 = buildFactChecklist('The club is in MI.', {}, sources);
    const state = items2.find((i) => i.text === 'MI');
    expect(state?.origin).toBe('unattributed');
    expect(state?.slots).toEqual(['club.state', 'student.state']);
    expect(state?.provenance).toContain('more than one');
  });

  it('never confirms anything on the applicant’s behalf, whatever the origin', () => {
    expect(items.every((i) => i.confirmed === false)).toBe(true);
    expect(items.some((i) => i.origin === 'program')).toBe(true);
    const readiness = exportReadiness(FILLED, {}, SOURCES);
    expect(readiness.ready).toBe(false);
    expect(readiness.unconfirmed).toBe(readiness.items.length);
    expect(readiness.openTodos).toBeGreaterThan(0);
  });

  it('reads the same three origins slots.ts writes', () => {
    const stated = new Set(
      Object.values(KNOWLEDGE)
        .filter((k): k is { state: 'known'; value: unknown; origin: 'profile' | 'program' | 'answer' } =>
          k.state === 'known',
        )
        .map((k) => k.origin),
    );
    expect([...stated].sort()).toEqual(['answer', 'profile', 'program']);
    for (const source of SOURCES) expect(stated.has(source.origin)).toBe(true);
  });

  it('carries only slots somebody actually stated a value for', () => {
    const slots = SOURCES.map((s) => s.slot);
    expect(slots).toContain('club.callsign');
    expect(slots).toContain('funder.applyUrl');
    expect(slots).not.toContain('club.foundedYear'); // unknown: it is the gap in the draft
    expect(slots).not.toContain('student.gpa'); // not_applicable to an organization
    for (const source of SOURCES) expect(source.value.trim()).not.toBe('');
  });
});

/**
 * A CONFIRMATION IS ABOUT A FACT, NOT ABOUT AN OFFSET.
 *
 * `id` is `${kind}:${start}`, so an edit that swaps one number for another of the same width
 * leaves the id untouched and the stored `confirmed: true` lands on a value no human ever read.
 * That is the failure this task exists to prevent, arriving through the back door. Storing the
 * fingerprint alongside the confirmation closes it; a confirmation without one still applies, so
 * the caller that has not been taught yet is unaffected.
 */
describe('a stored confirmation does not survive an edit to the fact it confirmed', () => {
  const BEFORE = 'We ask for $1,450 this year.';
  const AFTER = 'We ask for $9,999 this year.';

  it('keeps the confirmation when the text at that offset is unchanged', () => {
    const item = buildFactChecklist(BEFORE).find((i) => i.text === '$1,450')!;
    const again = buildFactChecklist(BEFORE, {
      [item.id]: { confirmed: true, note: 'checked the invoice', fingerprint: item.fingerprint },
    });
    const same = again.find((i) => i.text === '$1,450');
    expect(same?.confirmed).toBe(true);
    expect(same?.staleConfirmation).toBe(false);
  });

  it('drops it when the amount changed under the same id, and says why', () => {
    const item = buildFactChecklist(BEFORE).find((i) => i.text === '$1,450')!;
    const edited = buildFactChecklist(AFTER, {
      [item.id]: { confirmed: true, note: 'checked the invoice', fingerprint: item.fingerprint },
    });
    const changed = edited.find((i) => i.text === '$9,999');
    expect(changed?.id).toBe(item.id); // same kind, same offset — the whole hazard
    expect(changed?.confirmed).toBe(false);
    expect(changed?.staleConfirmation).toBe(true);
    expect(changed?.note).toBe('checked the invoice'); // the human's words are not thrown away
    expect(exportReadiness(AFTER, {
      [item.id]: { confirmed: true, note: '', fingerprint: item.fingerprint },
    }).ready).toBe(false);
  });

  it('hands back an item the storage layer can persist as a confirmation', () => {
    // Task 16 stores `Record<string, FactConfirmation>`; a live item must still fit that shape,
    // fingerprint included, or the round trip drops the field that makes staleness detectable.
    const stored: FactConfirmation = buildFactChecklist(BEFORE)[0]!;
    expect(stored.confirmed).toBe(false);
    expect(typeof stored.fingerprint).toBe('string');
  });

  it('is stable for identical text and different for a different value', () => {
    const a = buildFactChecklist(BEFORE).find((i) => i.text === '$1,450')!;
    const b = buildFactChecklist(`Twice: ${BEFORE}`).find((i) => i.text === '$1,450')!;
    const c = buildFactChecklist(AFTER).find((i) => i.text === '$9,999')!;
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.id).not.toBe(a.id);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });
});
