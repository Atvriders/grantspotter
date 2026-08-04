import { describe, expect, it } from 'vitest';
import { fillTemplate, stripTodoMarkers, todoFor } from './fill.js';
import { loadTemplates } from './load.js';
import { buildSlotContext, isKnownSlot } from './slots.js';

const all = loadTemplates();
const components = all.filter((t) => t.layer === 'component');

/**
 * The shipped guidance may not violate the rules it teaches. These are the four
 * transitions the style ruleset bans outright and the stock openers/closers it
 * bans; if one appears in a template body, the template is the bug.
 */
const BANNED_IN_TEMPLATES = [
  /\bFurthermore\b/,
  /\bMoreover\b/,
  /\bAdditionally\b/,
  /\bIt is important to note that\b/i,
  /In today's rapidly evolving landscape/i,
  /for years to come/i,
];

describe('template corpus invariants', () => {
  it('loads without a parse error and every id is unique', () => {
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  });

  it('uses only slots that exist in the vocabulary', () => {
    const offenders: string[] = [];
    for (const t of all) {
      for (const slot of t.slots) if (!isKnownSlot(slot)) offenders.push(`${t.id}:${slot}`);
    }
    expect(offenders).toEqual([]);
  });

  it('never contains a banned transition, opener or closer', () => {
    const offenders: string[] = [];
    for (const t of all) {
      for (const re of BANNED_IN_TEMPLATES) if (re.test(t.body)) offenders.push(`${t.id} matched ${re}`);
    }
    expect(offenders).toEqual([]);
  });

  it('gives every template a title, a positive order and a non-trivial body', () => {
    for (const t of all) {
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.order).toBeGreaterThan(0);
      expect(t.body.trim().length).toBeGreaterThan(400);
    }
  });
});

describe('component layer', () => {
  it('ships the first four spine components with a length target', () => {
    const ids = components.map((t) => t.id);
    for (const id of ['need-statement', 'project-description', 'measurable-outcomes', 'activities-timeline']) {
      expect(ids).toContain(id);
    }
    for (const t of components) expect(t.lengthTarget).toBeTruthy();
  });

  it('gives the need statement the club identity slots and a stated failure mode', () => {
    const need = components.find((t) => t.id === 'need-statement');
    expect(need?.slots).toContain('club.name');
    expect(need?.slots).toContain('club.callsign');
    expect(need?.body).toMatch(/Common failure/);
  });

  it('requires a named human or organization as the subject in activities', () => {
    const act = components.find((t) => t.id === 'activities-timeline');
    expect(act?.body).toMatch(/named (human|person)/i);
    expect(act?.slots).toContain('team.leadName');
  });

  it('makes every outcome countable and dated', () => {
    const out = components.find((t) => t.id === 'measurable-outcomes');
    expect(out?.body).toMatch(/count/i);
    expect(out?.body).toMatch(/by when/i);
  });
});

/**
 * The corpus is data, and the loader is strict on purpose, so "it parses" is a real
 * assertion about every file rather than a tautology: a missing `appliesTo`, a quoted
 * boolean or a scalar `programIds` all throw by name (Task 1), and a slot outside the
 * vocabulary can never be filled by the context builder (Task 2).
 */
describe('every shipped template survives an applicant who has told us nothing', () => {
  const emptyProfile = buildSlotContext({});

  it('has an empty context to render against — no profile means no facts', () => {
    expect(emptyProfile).toEqual({});
  });

  it('turns every declared slot into a visible gap, and leaves no slot syntax behind', () => {
    for (const t of all) {
      const filled = fillTemplate(t.body, emptyProfile);
      // Every slot the body declares comes back as unresolved, in body order: with nothing
      // stated, there is nothing that could legitimately have been substituted.
      expect(filled.unresolvedSlots, t.id).toEqual(t.slots);
      expect(filled.markdown, t.id).not.toMatch(/\{\{/);
    }
  });

  it('names the missing fact and tells the writer what to supply, for every gap', () => {
    for (const t of all) {
      const { markdown } = fillTemplate(t.body, emptyProfile);
      for (const slot of t.slots) {
        // `todoFor` is the single definition of a gap's text, so asserting against it pins
        // "the marker names its slot and carries the vocabulary hint" without re-stating
        // 66 hints here — slots.test.ts already pins the hint wording itself.
        expect(markdown, `${t.id}:${slot}`).toContain(todoFor(slot));
      }
    }
  });

  /**
   * The failure this whole product is built against: a plausible value nobody checked.
   * A club officer who fills nothing in must still be able to see, at a glance, that the
   * document is unfinished — so no component may render as a document with zero holes.
   */
  it('never renders a component as a finished document when nothing has been supplied', () => {
    for (const t of components) {
      const filled = fillTemplate(t.body, emptyProfile);
      expect(filled.unresolvedSlots.length, t.id).toBeGreaterThan(0);
    }
  });
});

describe('component layer — budget, sustainability, evaluation, capacity', () => {
  const byId = (id: string) => all.find((t) => t.id === id);
  const IDS = [
    'budget-justification',
    'sustainability',
    'evaluation-plan',
    'organizational-capacity',
  ] as const;

  it('ships all four', () => {
    for (const id of IDS) {
      expect(byId(id)).toBeDefined();
    }
  });

  it('makes the budget a line-item table with unit prices and a justification column', () => {
    const b = byId('budget-justification');
    expect(b?.body).toMatch(/unit (price|cost)/i);
    expect(b?.body).toMatch(/\| *Why this line \|/);
    expect(b?.slots).toContain('project.requestAmount');
    expect(b?.slots).toContain('project.budgetTotal');
    expect(b?.slots).toContain('project.indirectPct');
  });

  it('asks sustainability who pays and who maintains after the grant', () => {
    const s = byId('sustainability');
    expect(s?.body).toMatch(/who (pays|maintains)/i);
    expect(s?.body).toMatch(/after the grant/i);
  });

  it('separates the evaluation plan from the outcomes table', () => {
    const e = byId('evaluation-plan');
    expect(e?.body).toMatch(/measurable-outcomes/);
  });

  it('makes organizational capacity cite evidence the club has done this before', () => {
    const c = byId('organizational-capacity');
    expect(c?.slots).toContain('club.foundedYear');
    expect(c?.body).toMatch(/evidence/i);
  });

  // ----------------------------------------------------------------------------------------
  // These four carry the highest factual risk in the set. Budget, sustainability, evaluation
  // and capacity are where an applicant is most tempted to write a plausible-sounding number,
  // and where a funder is most likely to check. The rules below are what stops a template
  // putting a figure in the applicant's mouth.
  // ----------------------------------------------------------------------------------------

  /** The three shapes a fabricated fact takes here: an amount, a rate, a period. */
  const FIGURE_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
    ['a currency amount', /\$\s*\d/],
    ['a percentage', /\d+\s*(?:%|percent\b)/i],
    ['a duration', /\b\d+\s*(?:day|week|month|year)s?\b/i],
  ];

  it('never ships a dollar amount, a match percentage or a timescale', () => {
    const offenders: string[] = [];
    for (const id of IDS) {
      const body = byId(id)?.body;
      // A negative assertion over a body that does not exist passes for the wrong reason, and
      // this is the one assertion in the file it would be most expensive to lose quietly.
      expect(body, id).toBeTypeOf('string');
      for (const [label, re] of FIGURE_SHAPES) {
        const hit = re.exec(body ?? '');
        if (hit) offenders.push(`${id} ships ${label}: ${JSON.stringify(hit[0])}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The hybrid example, found by Task 4 in the plan's own prose: an example sentence that welds an
   * invented specific to a LIVE slot. Filled, it renders as a complete, true-looking sentence in
   * which the club's real details are real and the invented number is fabricated — and it carries
   * no `[TODO: …]`, so Task 14's export gate counts zero open todos and releases it. A fabrication
   * shaped to pass the exact check built to stop it.
   *
   * The rule: an example is either fully self-contained (no live slot, so nothing renders) or
   * fully slotted (no invented specific). Never both. This is mechanically checkable — on any line
   * carrying a slot, an "e.g." or a quantity outside the slot braces is the weld.
   *
   * The quantity has to be caught SPELLED as well as in digits. Task 4's actual case —
   * "Three of our members — {{team.leadName}} and two licensed volunteers — will teach a
   * four-session class in {{project.venue}}" — carries no digit and no "e.g.", so a digits-only
   * detector reports it clean. Verified against that exact line while writing this.
   */
  const SPELLED_QUANTITY =
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|hundred|thousand)\b/i;

  it('never welds an invented example to a live slot on the same line', () => {
    const offenders: string[] = [];
    for (const id of IDS) {
      for (const raw of (byId(id)?.body ?? '').split('\n')) {
        if (!raw.includes('{{')) continue;
        // An ordered-list marker is the writer's numbering, not a claim about the applicant.
        const line = raw.replace(/^\s*\d+\.\s/, '').replace(/\{\{[^}]*\}\}/g, '');
        if (/\be\.g\.\s/i.test(line)) offenders.push(`${id} — "e.g." beside a live slot: ${raw.trim()}`);
        if (/\d/.test(line)) offenders.push(`${id} — a figure beside a live slot: ${raw.trim()}`);
        const spelled = SPELLED_QUANTITY.exec(line);
        if (spelled) offenders.push(`${id} — "${spelled[0]}" beside a live slot: ${raw.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('catches the weld in both of the shapes it has actually taken', () => {
    // A detector for a defect nobody can reproduce is a comment. These two lines are the real
    // ones: the plan's own budget row, and the hybrid Task 4 found in `activities-timeline`.
    const weld = (raw: string): boolean => {
      const line = raw.replace(/^\s*\d+\.\s/, '').replace(/\{\{[^}]*\}\}/g, '');
      return /\be\.g\.\s/i.test(line) || /\d/.test(line) || SPELLED_QUANTITY.test(line);
    };
    expect(weld('| > e.g. Icom IC-7300 | > e.g. $1,099 | 1 | {{project.budgetTotal}} |')).toBe(true);
    expect(
      weld(
        'Three of our members — {{team.leadName}} and two licensed volunteers — will teach a ' +
          'four-session licensing class in {{project.venue}} on {{project.schedule}}.',
      ),
    ).toBe(true);
    // And it does not fire on a fully-slotted sentence, which is the permitted form.
    expect(weld('{{club.name}} ({{club.callsign}}) has {{club.memberCount}} members.')).toBe(false);
  });

  it('renders a budget of gaps, never a budget of numbers', () => {
    const b = byId('budget-justification');
    const filled = fillTemplate(b?.body ?? '', {});
    // The hints inside a marker are instructions to the writer, not this club's figures, so
    // they are stripped before the check — `stripTodoMarkers` exists for exactly this reader,
    // and Task 3's brief carried the same defect from not scoping a check this way.
    const prose = stripTodoMarkers(filled.markdown);
    for (const [label, re] of FIGURE_SHAPES) {
      expect(`${label}: ${re.exec(prose)?.[0] ?? 'none'}`).toBe(`${label}: none`);
    }
    // Every figure a funder would check is a hole the applicant has to fill by hand.
    for (const slot of [
      'project.requestAmount',
      'project.budgetTotal',
      'project.indirectPct',
      'project.coFunderAmount',
    ]) {
      expect(filled.markdown).toContain(`[TODO: ${slot}`);
    }
  });

  it('puts cost share in three states, never two', () => {
    const b = byId('budget-justification');
    // 148 records once asserted "no cost share required" when no funder had ever said so, and
    // `costShareRequired` reads unstated on 148 of 150. A template that lets an applicant infer
    // either answer from a silent page reproduces that failure in the applicant's own voice.
    expect(b?.body).toMatch(/three states, never two/i);
    expect(b?.body).toMatch(/silent|silence/i);
  });

  it('leaves the ARDC-specific terms to the ARDC overlay', () => {
    // The 20% indirect cap and the free-public-availability term are ARDC's, not the sector's.
    // A generic component naming them tells every other funder's applicant something untrue.
    for (const id of IDS) {
      expect(byId(id)?.body, id).not.toMatch(/\bARDC\b/);
    }
  });

  it('never states a sustainment obligation the funder did not publish', () => {
    const s = byId('sustainability');
    // The removed Yaesu "repeater must remain on the air for 12 months" obligation appears zero
    // times in that funder's real page. This template may ask for the obligation and demand a
    // citation for it; it may not supply one, and it may not supply the period.
    expect(s?.body).toMatch(/quote that obligation from the funder's own published page/i);
    expect(s?.body).not.toMatch(/must (remain|stay) (on the air|in service) for \d/i);
  });

  it('gives each of the four a length target and a stated failure mode', () => {
    for (const id of IDS) {
      const t = byId(id);
      expect(t?.layer, id).toBe('component');
      expect(t?.lengthTarget, id).toBeTruthy();
      expect(t?.appliesTo.length, id).toBeGreaterThan(0);
      expect(t?.body, id).toMatch(/## Common failure/);
    }
  });
});

/**
 * These five leave the applicant's desk and land on a named human's: a programme officer, a
 * professor, a club president, the person who decides whether to fund you again. A fabricated
 * detail in a need statement is a weak draft. A fabricated detail here is a false statement to a
 * third party, made over the applicant's signature.
 *
 * So the bar is higher than "no banned transitions": the template may state STRUCTURE, never
 * FACTS. Every name, date, amount, outcome and relationship has to be a slot the applicant fills
 * from a record they can produce. The assertions below are the ones that catch the opposite —
 * a pre-filled salutation, a hard-coded year or dollar figure, a claim about what a recommender
 * saw, a report that congratulates itself before anything was counted.
 */
describe('component layer — correspondence and reporting', () => {
  const byId = (id: string) => all.find((t) => t.id === id);

  const CORRESPONDENCE = [
    'letter-of-inquiry',
    'scholarship-personal-essay',
    'recommendation-request-email',
    'thank-you-letter',
    'interim-final-report',
  ];

  it('completes the component layer at exactly 13 templates', () => {
    expect(components.length).toBe(13);
  });

  it('ships the five correspondence and reporting components', () => {
    for (const id of CORRESPONDENCE) {
      expect(byId(id), id).toBeDefined();
    }
  });

  it('addresses the scholarship essay to the individual applicant, not a club', () => {
    const essay = byId('scholarship-personal-essay');
    expect(essay?.appliesTo).toEqual(['ham_scholarship']);
    expect(essay?.slots.some((s) => s.startsWith('student.'))).toBe(true);
    expect(essay?.slots.some((s) => s.startsWith('club.'))).toBe(false);
  });

  it('tells the recommendation request to supply the recommender with facts and a deadline', () => {
    const rec = byId('recommendation-request-email');
    expect(rec?.slots).toContain('recommender.name');
    expect(rec?.slots).toContain('recommender.deadline');
    expect(rec?.body).toMatch(/sponsor|reference|letter/i);
  });

  it('makes the report compare promised numbers against actual numbers', () => {
    const rep = byId('interim-final-report');
    expect(rep?.slots).toContain('report.spendToDate');
    expect(rep?.slots).toContain('report.outcomeSummary');
    expect(rep?.body).toMatch(/promised/i);
    expect(rep?.appliesTo).toEqual([
      'ham_grant',
      'ham_scholarship',
      'adjacent_stem',
      'equipment_in_kind',
    ]);
  });

  it('never pre-fills the person it is addressed to', () => {
    // A salutation is the first fact in a letter and the easiest one to invent. Every `Dear` in
    // this set must be followed immediately by a slot, so an unfilled draft says
    // `Dear [TODO: donor.contactName — …]` and cannot be sent by accident.
    for (const id of CORRESPONDENCE) {
      const body = byId(id)?.body ?? '';
      for (const m of body.matchAll(/Dear\s+(\S+)/g)) {
        expect(m[1], `${id} salutation "${m[0]}"`).toMatch(/^\{\{/);
      }
    }
  });

  it('states no date, year or dollar figure of its own', () => {
    // Guidance text is exempt from nothing: a template that writes a plausible year or amount
    // into a letter to a funder has asserted it, and the applicant is the one who signs.
    for (const id of CORRESPONDENCE) {
      const outsideSlots = (byId(id)?.body ?? '').replace(/\{\{[^}]*\}\}/g, '');
      expect(outsideSlots, `${id} carries a calendar date`).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(outsideSlots, `${id} carries a year`).not.toMatch(/\b(?:19|20)\d{2}\b/);
      expect(outsideSlots, `${id} carries a dollar figure`).not.toMatch(/\$\s?[\d,]/);
    }
  });

  it('renders every fact as a visible gap for an applicant who has stated nothing', () => {
    const empty = buildSlotContext({});
    for (const id of CORRESPONDENCE) {
      const t = byId(id);
      const filled = fillTemplate(t?.body ?? '', empty);
      expect(filled.unresolvedSlots, id).toEqual(t?.slots);
      expect(filled.unresolvedSlots.length, id).toBeGreaterThan(0);
      // Outside the gap markers there must be nothing that reads as a supplied fact. The markers
      // themselves are stripped first on purpose: a hint's "e.g. 2029" is an instruction to the
      // writer, not a year this applicant claimed.
      const outsideGaps = stripTodoMarkers(filled.markdown);
      expect(outsideGaps, `${id} rendered a date`).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(outsideGaps, `${id} rendered a dollar figure`).not.toMatch(/\$\s?[\d,]/);
    }
  });

  it('never welds an invented figure to a live slot', () => {
    // Task 4's finding, and it lands hardest here. A model sentence that mixes real slots with
    // invented specifics — "Three of our members will run a four-session class at
    // {{project.venue}}" — renders as a complete, TRUE-LOOKING sentence carrying no `[TODO: …]`
    // at all. Task 14's export gate counts zero open todos and releases it: a fabrication shaped
    // to pass the exact check built to stop it, in a letter addressed to a named human.
    //
    // The rule: a sentence is either fully self-contained (no slots, so nothing of the
    // applicant's renders beside it) or fully slotted (no invented specifics). Never a hybrid.
    // Spelled quantities matter more than digits here. Task 4's real offending line —
    // "Three of our members will run a four-session class" — spells every number as a word and
    // sails straight past a `\d` scan, so the alternation is the load-bearing half of this test
    // and the digit check is the cheap half. "twenty-four" is caught by `\btwenty\b` because a
    // hyphen is a word boundary.
    const COUNT_WORD =
      /\b(?:a handful of|a couple of|couple|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|dozens?|several)\b/i;
    for (const id of CORRESPONDENCE) {
      for (const line of (byId(id)?.body ?? '').split('\n')) {
        if (!line.includes('{{')) continue;
        // A markdown list marker and a leading `**bold label**` are the template's own
        // scaffolding — the shape of the guidance, not a claim inside it. Everything after them
        // is text the applicant may paste, and it may carry no figure this template invented.
        const prose = line
          .replace(/^\s*(?:[-*>]\s+|\d+\.\s+)+/, '')
          .replace(/^\*\*[^*]*\*\*/, '');
        expect(prose, `${id}: ${line.trim()}`).not.toMatch(/\d/);
        expect(prose, `${id}: ${line.trim()}`).not.toMatch(COUNT_WORD);
      }
    }
  });

  it("leaves the recommender's own claims to the recommender", () => {
    const body = byId('recommendation-request-email')?.body ?? '';
    // The specific failure: a template that writes "you supervised my capstone" has drafted the
    // letter. The applicant then asks a near-stranger to sign a claim the applicant invented, and
    // the recommender is the one whose name is on it. This template may tell the applicant what to
    // SUPPLY — dates, the course, the project, the counts — and may not assert what was observed.
    expect(body).not.toMatch(/\byou (?:supervised|taught|mentored|advised|observed|watched) (?:me|my)\b/i);
    expect(body).not.toMatch(/\b(?:as you (?:know|will recall|saw)|you have (?:seen|watched))\b/i);
    expect(body).toMatch(/never draft their opinion for them/i);
    expect(body).toMatch(/let them decide what they are willing to say/i);
  });

  it('never asserts an outcome the report has not measured', () => {
    const body = byId('interim-final-report')?.body ?? '';
    expect(body).not.toMatch(/\b(?:met|exceeded|achieved|delivered) (?:its|our|all|the) (?:objectives|goals|targets|outcomes)\b/i);
    expect(body).not.toMatch(/\bthe project was a success\b/i);
    // The awarded figure is not the requested figure, and a report that prints one for the other
    // has told a funder they gave money they may not have given.
    expect(body).toMatch(/Copy the figure from the award letter/);
  });

  it('makes the applicant quote an obligation instead of letting the template infer one', () => {
    const body = byId('interim-final-report')?.body ?? '';
    // The Yaesu "12-month on-air" obligation appears ZERO times in that funder's real page. A
    // report template that lists plausible obligations as though they applied reproduces that
    // fabrication in the applicant's own reporting, addressed to the one reader who would know.
    // An earlier draft of this very template did it — "an on-air period still running" — so the
    // block now demands a quotation and a source, and says what to write when there is none.
    expect(body).toMatch(/Quote anything still owed from the funder's own published page/);
    expect(body).toMatch(/An obligation nobody published is not an obligation/);
    // Same rule for a numeric threshold: it is the funder's to set, and ours to label as ours.
    expect(body).toMatch(/Where the funder publishes a variance threshold, use theirs/);
    expect(body).toMatch(/say that the threshold is your own/);
  });

  it('leaves every funder-specific requirement to the overlays', () => {
    // Funder facts belong in the funder layer, where a `sources` block backs them. A component
    // asserting "this program requires three references" is the Yaesu 12-month obligation again:
    // a rule in the applicant's hands that the funder's own page never states.
    for (const id of CORRESPONDENCE) {
      const body = byId(id)?.body ?? '';
      expect(body, id).not.toMatch(/\b(?:ARDC|QCWA|YASME|ARRL|Yaesu|ARISS|IEEE|NASA)\b/);
      expect(body, id).not.toMatch(/requires (?:three|two|four) (?:references|letters)/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Tasks 10 and 11 — the two funders that are not in the index.
//
// Campus student government and NASA State Space Grant are, per this project's own research,
// where a typical collegiate club's money actually comes from, and neither is aggregatable:
// roughly 4,000 campuses on four different form platforms, and 52 independent consortium
// calendars. They ship as guided workflows, which means the honesty bar moves. An overlay for a
// funder in the index can quote that funder's page. These two cannot — there is no single page to
// quote — so everything they say has to be either sourced to the one representative campus it
// came from, or written as an instruction to go and read the applicant's own rule.
//
// `selectTemplates` imported here on purpose: `alwaysAvailable` is the only thing standing
// between the SGA playbook and invisibility, and Task 1 found that a QUOTED `"true"` in the
// frontmatter reads as `false` and hides the template with no error anywhere. Asserting the flag
// is not enough; the assertion has to run the selection the app runs.
// ---------------------------------------------------------------------------------------------
import { loadConsortia } from './consortia.js';
import { selectTemplates } from './load.js';

/** The spelled-quantity half of the weld detector. Task 4's line carried no digit at all. */
const WELD_COUNT_WORD =
  /\b(?:a handful of|a couple of|couple|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|dozens?|several)\b/i;

function weldOffenders(id: string, body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    if (!raw.includes('{{')) continue;
    const prose = raw
      .replace(/^\s*(?:[-*>]\s+|\d+\.\s+)+/, '')
      .replace(/^\s*-\s*\[[ x]\]\s*/, '')
      .replace(/^\*\*[^*]*\*\*/, '')
      .replace(/\{\{[^}]*\}\}/g, '');
    if (/\d/.test(prose)) out.push(`${id} — figure beside a live slot: ${raw.trim()}`);
    const spelled = WELD_COUNT_WORD.exec(prose);
    if (spelled) out.push(`${id} — "${spelled[0]}" beside a live slot: ${raw.trim()}`);
  }
  return out;
}

describe('funder layer — campus SGA playbook', () => {
  const sga = all.find((t) => t.id === 'funder-campus-sga');

  it('is always available and bound to no program id', () => {
    expect(sga).toBeDefined();
    expect(sga?.alwaysAvailable).toBe(true);
    expect(sga?.programIds).toEqual([]);
  });

  it('leads with the capital-equipment trap and the reframe', () => {
    expect(sga?.body).toMatch(/capital equipment/i);
    expect(sga?.body).toMatch(/barred|prohibited|not fundable/i);
    expect(sga?.body).toMatch(/programming/i);
    expect(sga?.body).toMatch(/funded externally|fund the capital/i);
  });

  it('gives at least four concrete reframes a club can copy', () => {
    const reframes = (sga?.body.match(/^\| /gm) ?? []).length;
    expect(reframes).toBeGreaterThanOrEqual(6);
    expect(sga?.body).toMatch(/licensing class/i);
    expect(sga?.body).toMatch(/Field Day/);
    expect(sga?.body).toMatch(/travel/i);
  });

  it('labels the FSU figures as one representative campus, never as universal', () => {
    expect(sga?.body).toMatch(/Florida State|FSU/);
    expect(sga?.body).toMatch(/representative|one campus|your campus will differ/i);
    expect(sga?.body).toMatch(/\$3,000/);
    expect(sga?.body).toMatch(/six weeks/i);
  });

  it('names the external routes for capital', () => {
    expect(sga?.body).toMatch(/department|dean|alumni/i);
    expect(sga?.slots).toContain('sga.fundingBody');
    expect(sga?.slots).toContain('sga.attendanceEstimate');
  });

  // -------------------------------------------------------------------------------------------
  // The reason this playbook is dangerous, and the reason it is worth shipping, are the same
  // fact: activity-fee rules are per-institution. "Your student government bars capital
  // equipment" is a claim about a document this app has never read, on one of roughly 4,000
  // campuses. Stated as fact it is the farweb.org failure in miniature — a plausible sentence
  // nobody checked — and an applicant who believes it will not ask for the radio their own rules
  // would in fact have funded.
  //
  // So the playbook teaches a METHOD: find your own allocation manual, find its unallowable-
  // expense list, and quote it back in your own request. The assertions below are what keep it a
  // method instead of an assertion.
  // -------------------------------------------------------------------------------------------

  it('is genuinely reachable — the selection the app runs actually returns it', () => {
    // Not `expect(alwaysAvailable).toBe(true)` again: a quoted `"true"` in frontmatter once read
    // as `false` and removed this template from the app with no error raised anywhere. The only
    // assertion that catches that is the one that runs `selectTemplates`.
    const noQuery = selectTemplates(all, {});
    expect(noQuery.playbooks.map((t) => t.id)).toContain('funder-campus-sga');
    // A club looking at one specific funder still sees it — it is not an alternative to the
    // overlays, it is the money that arrives while the grant application is being written.
    const withProgram = selectTemplates(all, { programId: 'nasa-space-grant', klass: 'ham_grant' });
    expect(withProgram.playbooks.map((t) => t.id)).toContain('funder-campus-sga');
    // And it is never mistaken for a funder overlay, which would bind it to a program it has none.
    expect(noQuery.overlays.map((t) => t.id)).not.toContain('funder-campus-sga');
  });

  it('teaches the applicant to quote their own campus rule rather than asserting one', () => {
    const body = sga?.body ?? '';
    expect(body).toMatch(/unallowable/i);
    expect(body).toMatch(/allocation manual|funding manual|policy/i);
    // Quoting is the whole method. The applicant's own rule, in their own request, in the rule's
    // own words — because the committee reading it recognises its own document.
    expect(body).toMatch(/quote/i);
    expect(body).toMatch(/word for word/i);
  });

  it('never states one campus rule as though it were the applicant’s', () => {
    // A negative assertion over a body that does not exist passes for the wrong reason, and this
    // is the one in the block it would be most expensive to lose quietly.
    expect(sga?.body, 'funder-campus-sga').toBeTypeOf('string');
    const body = sga?.body ?? '';
    expect(body).not.toMatch(
      /\byour (?:SGA|student government|campus|university)[^.\n]{0,60}\b(?:bars|prohibits|forbids|does not fund|will not fund|cannot fund)\b/i,
    );
    expect(body).not.toMatch(/\b(?:all|every) (?:campuses|student governments|universities|SGAs)\b/i);

    // Every line that names a category rule has to carry the hedge or the instruction with it.
    // A hedge in the paragraph above does not travel: a club officer copies the line.
    const RULE_WORD = /\b(?:barred|bars|prohibit\w*|unallowable|not fundable|excluded?|ineligible)\b/i;
    const HEDGE =
      /\b(?:frequently|often|usually|commonly|typically|most|many|may|might|whether|if|your campus|your own|check|quote|read|find|list|ask|representative)\b/i;
    const offenders: string[] = [];
    for (const line of body.split('\n')) {
      if (RULE_WORD.test(line) && !HEDGE.test(line)) offenders.push(line.trim());
    }
    expect(offenders).toEqual([]);
  });

  it('confines every FSU figure to the section that labels them as FSU’s', () => {
    // The figures are real and useful for calibration, and they belong to ONE campus. A dollar
    // amount or a lead time loose in the general advice reads as the rule everywhere.
    const RULE_FIGURE =
      /\$\s?[\d,]+|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)[- ](?:day|week|month|year)s?\b/i;
    const sections = (sga?.body ?? '').split(/\n(?=## )/);
    const carrying = sections
      .filter((s) => RULE_FIGURE.test(s))
      .map((s) => (s.split('\n')[0] ?? '').trim());
    expect(carrying).toEqual(['## One representative campus, for calibration']);
    // And that section says whose figures they are, on the same screen as the numbers.
    const representative = sections.find((s) => RULE_FIGURE.test(s)) ?? '';
    expect(representative).toMatch(/Florida State|FSU/);
    expect(representative).toMatch(/your campus will differ/i);
  });

  it('welds no invented quantity to a live slot', () => {
    expect(sga?.body, 'funder-campus-sga').toBeTypeOf('string');
    expect(weldOffenders('funder-campus-sga', sga?.body ?? '')).toEqual([]);
  });

  it('renders the request skeleton as gaps, and fills them when the applicant answers', () => {
    const empty = fillTemplate(sga?.body ?? '', buildSlotContext({}));
    expect(empty.unresolvedSlots).toEqual(sga?.slots);
    for (const slot of ['sga.fundingBody', 'sga.eventDate', 'sga.attendanceEstimate']) {
      expect(empty.markdown).toContain(`[TODO: ${slot}`);
    }
    // The skeleton is the part an applicant pastes into a form, so no figure of ours may render
    // inside it — including FSU's, which belong upstairs beside the campus they came from. The
    // markers are stripped first: a hint's example is an instruction to the writer, not a figure
    // this club supplied.
    const skeleton = (stripTodoMarkers(empty.markdown).split(/\n(?=## )/).find((s) =>
      s.startsWith('## Draft skeleton'),
    ) ?? '');
    expect(skeleton.length).toBeGreaterThan(200);
    expect(skeleton).not.toMatch(/\$\s?[\d,]+/);

    const answered = fillTemplate(sga?.body ?? '', {
      'sga.fundingBody': 'the RSO Allocation Committee',
      'sga.eventDate': 'the first Saturday of the spring term',
      'sga.attendanceEstimate': 'about the capacity of the room we booked',
    });
    expect(answered.markdown).toContain('the RSO Allocation Committee');
    expect(answered.unresolvedSlots).not.toContain('sga.fundingBody');
    expect(answered.markdown).not.toMatch(/\{\{/);
  });

  it('cites the campus whose figures it quotes', () => {
    expect(sga?.sources.length).toBeGreaterThan(0);
    expect(sga?.sources.some((s) => /fsu\.edu/.test(s.url))).toBe(true);
    // The source label has to say the page is one campus's, because the figures beside it are.
    expect(sga?.sources.some((s) => /representative/i.test(s.label))).toBe(true);
  });
});

describe('funder layer — NASA State Space Grant', () => {
  const sg = all.find((t) => t.id === 'funder-nasa-space-grant');

  it('exists and binds to the space grant program', () => {
    expect(sg).toBeDefined();
    expect(sg?.programIds).toEqual(['nasa-space-grant']);
  });

  it('states that there is no national deadline and 52 independent calendars', () => {
    expect(sg?.body).toMatch(/52/);
    expect(sg?.body).toMatch(/no national deadline/i);
    expect(sg?.slots).toContain('consortium.name');
    expect(sg?.slots).toContain('consortium.url');
  });

  it('warns that the shipped consortium list is unverified', () => {
    expect(sg?.body).toMatch(/unverified|not been (live-)?verified/i);
    expect(sg?.sources.some((s) => /nasa\.gov/.test(s.url))).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // 52 consortia, 52 calendars, 52 sets of award types. Any rule this overlay states as
  // "Space Grant's" belongs to at most one of them, and is shown to the applicants of the other
  // 51 as though it were theirs. The overlay's job is to ROUTE — to get the applicant to their own
  // consortium's page and tell them what to look for when they arrive.
  // -------------------------------------------------------------------------------------------

  it('names no consortium of its own — the picker does the routing', () => {
    const body = sg?.body ?? '';
    for (const c of loadConsortia()) {
      expect(body, `names ${c.name} in prose`).not.toContain(c.name);
      expect(body, `names ${c.leadInstitution} in prose`).not.toContain(c.leadInstitution);
    }
    // The applicant's own consortium arrives through the slot, so an unanswered draft says so.
    expect(body).toContain('{{consortium.name}}');
  });

  it('asserts no deadline, no award amount and no eligibility rule as a consortium’s', () => {
    expect(sg?.body, 'funder-nasa-space-grant').toBeTypeOf('string');
    const body = sg?.body ?? '';
    expect(body).not.toMatch(
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/,
    );
    expect(body).not.toMatch(/\bdeadline (?:is|falls|of)\b/i);
    // A dollar figure may appear only where it is labelled as an order of magnitude that no
    // consortium published — the research's own $1k–$10k reading, not anybody's award table.
    for (const line of body.split('\n')) {
      if (!/\$/.test(line)) continue;
      expect(line, `unlabelled figure: ${line.trim()}`).toMatch(
        /indication of scale|no consortium published|not a published figure/i,
      );
    }
  });

  it('turns the matching requirement into a question instead of a rule', () => {
    const body = sg?.body ?? '';
    expect(body).toMatch(/match/i);
    // "Space Grant is a matching program" is the Yaesu twelve-month obligation again: a plausible
    // requirement in the applicant's hands that no page in front of us states.
    expect(body).not.toMatch(/\bSpace Grant is a matching (?:program|programme)\b/i);
    expect(body).not.toMatch(/\b(?:1:1|one-to-one|dollar-for-dollar) match\b/i);
    const offenders: string[] = [];
    for (const line of body.split('\n')) {
      if (!/\bmatch(?:ing)?\b/i.test(line)) continue;
      if (!/\b(?:ask|confirm|whether|check|find out|before)\b/i.test(line)) offenders.push(line.trim());
    }
    expect(offenders).toEqual([]);
  });

  it('sends the applicant to NASA’s own directory rather than to a curated link', () => {
    const body = sg?.body ?? '';
    expect(body).toMatch(/director/i);
    expect(body).toMatch(/nasa\.gov/);
    // The consortium's own website is the applicant's to paste: 52 offline-curated URLs would be
    // 52 chances to send somebody to an address that is no longer the consortium.
    expect(sg?.slots).toContain('consortium.url');
  });

  it('welds no invented quantity to a live slot', () => {
    expect(sg?.body, 'funder-nasa-space-grant').toBeTypeOf('string');
    expect(weldOffenders('funder-nasa-space-grant', sg?.body ?? '')).toEqual([]);
  });

  it('renders as gaps for an applicant who has stated nothing', () => {
    const filled = fillTemplate(sg?.body ?? '', buildSlotContext({}));
    expect(filled.unresolvedSlots).toEqual(sg?.slots);
    expect(filled.markdown).toContain('[TODO: consortium.name');
    expect(stripTodoMarkers(filled.markdown)).not.toMatch(/\{\{/);
  });

  it('applies to the classes a Space Grant project actually falls in', () => {
    expect(sg?.appliesTo).toEqual(['ham_grant', 'adjacent_stem']);
    expect(sg?.funderId).toBe('nasa-space-grant');
  });
});

/**
 * ------------------------------------------------------------------------------------------
 * FUNDER LAYER (Task 9) — ARISS, IEEE MTT-S Chapter Support, Yaesu DR-2X.
 *
 * Three programmes that are not cash grants, and the one place in this repository where the
 * product's founding failure actually happened. A Yaesu "the repeater must remain on the air for
 * 12 months" obligation was published as established fact for days. It came from a hand-written
 * fixture, never from Yaesu: `twelve`, `12 month`, `on the air`, `on-air`, `obligat` and `remain`
 * each appear ZERO times in the 145,639-byte capture of the funder's own page, and the test
 * below re-derives that from the committed bytes rather than trusting this comment.
 *
 * So each overlay here states funder facts only where a captured page carries the words, and the
 * pins below check both sides of every claim: the funder said it, and the overlay says it the
 * same way. Where the capture is silent the overlay says so out loud — the two prices whose
 * difference the page never explains, the application PDF this crawler never downloads, the
 * scholarship figures the IEEE page does not print — because a declared gap is the only honest
 * alternative to a plausible sentence.
 * ------------------------------------------------------------------------------------------
 */
describe('funder layer — ARISS, IEEE MTT-S and Yaesu DR-2X', () => {
  const byId = (id: string) => all.find((t) => t.id === id);
  const OVERLAYS = ['funder-ariss', 'funder-ieee-mtts', 'funder-yaesu-dr2x'];

  const YAESU_CAPTURE = '00-systemfusion-yaesu-com.html';

  /**
   * Markup out, entities and typographic characters folded to ASCII, whitespace collapsed —
   * lossy in one direction only, so it never adds a word. A phrase that survives this on both
   * sides really is the funder's own wording.
   */
  const fold = (raw: string): string =>
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#8217;|&rsquo;|’/g, "'")
      .replace(/&#8216;|&lsquo;|‘/g, "'")
      .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|“|”/g, '"')
      .replace(/&quot;/g, '"')
      .replace(/&#8211;|&ndash;|–/g, '-')
      .replace(/&#8212;|&mdash;|—/g, '--')
      .replace(/\s+/g, ' ');

  const capture = async (dir: string, file: string): Promise<string> => {
    const { loadFixture } = await import('../../test/fixtures.js');
    return fold(loadFixture(dir, file));
  };

  it('loads all three through the strict loader, bound to the canonical program ids', () => {
    for (const id of OVERLAYS) {
      const t = byId(id);
      expect(t, id).toBeDefined();
      expect(t?.layer, id).toBe('funder');
      // An overlay that were `alwaysAvailable` would be a playbook and would show for every
      // opportunity, funder facts and all.
      expect(t?.alwaysAvailable, id).toBe(false);
      expect(t?.sources.length, `${id} states funder facts with no sources`).toBeGreaterThan(0);
      for (const slot of t?.slots ?? []) expect(isKnownSlot(slot), `${id}: ${slot}`).toBe(true);
      const componentIds = new Set(components.map((c) => c.id));
      for (const req of t?.requires ?? []) expect(componentIds.has(req), `${id} → ${req}`).toBe(true);
    }
    // A one-character difference here produces no error, no warning and zero overlays.
    expect(byId('funder-ariss')?.programIds).toEqual(['ariss-iss-contact']);
    expect(byId('funder-ieee-mtts')?.programIds).toEqual(['ieee-mtts-chapter-support']);
    expect(byId('funder-yaesu-dr2x')?.programIds).toEqual(['yaesu-dr2x-repeater']);
    expect(byId('funder-ariss')?.funderId).toBe('ariss-usa');
    expect(byId('funder-ieee-mtts')?.funderId).toBe('ieee-mtts');
    expect(byId('funder-yaesu-dr2x')?.funderId).toBe('yaesu-usa');
  });

  it('tells ARISS applicants the award is a contact and mentoring, not cash', () => {
    const a = byId('funder-ariss');
    expect(a?.body).toMatch(/no cash/i);
    expect(a?.body).toMatch(/education plan/i);
    // The page's audience sentence names schools and educational organizations. Reading a
    // university INTO it is the same move as reading an obligation into a page that has none.
    expect(a?.body).toMatch(/not explicitly named/i);
    expect(a?.slots).toContain('project.beneficiaryCount');
    expect(a?.slots).toContain('team.instructorName');
  });

  it('states nothing about ARISS money, because the page publishes no figure at all', async () => {
    const page = await capture('ariss', '00-ariss-usa-org-proposal-overview.html');
    // The claim "no cash" is checkable in exactly one way: no dollar figure anywhere in the
    // capture. If ARISS ever publishes one, this fails and the overlay has to be rewritten.
    expect(page).not.toMatch(/\$\s?\d/);
    const body = byId('funder-ariss')?.body ?? '';
    expect(body).not.toMatch(/\$\d/);
    expect(body).toMatch(/publishes no dollar figure/i);
  });

  it('quotes ARISS in the funders own words', async () => {
    const page = await capture('ariss', '00-ariss-usa-org-proposal-overview.html');
    const body = fold(byId('funder-ariss')?.body ?? '');
    for (const quote of [
      'A scheduled ARISS contact is a voice-only communication via Amateur Radio between the ' +
        'International Space Station (ISS) crew and classrooms and communities.',
      'approximately 10 minutes in length',
      'paired with an ARISS Technical Mentor',
      'US schools and educational organizations may download the ARISS Proposal Form',
      'These scheduled contact opportunities are offered to formal and informal education ' +
        'institutions and organizations, individually or working together.',
      'the ability to integrate space and communication concepts into multiple areas of the ' +
        'curriculum for 4-6 months leading up to the contact',
      'potential audience size (we are looking to engage an entire school or organization, NOT ' +
        'just a single classroom)',
      'community connections (ham radio groups or other community members who could be of ' +
        'assistance)',
      'organizations must demonstrate flexibility to accommodate changes in contact dates and times',
      'Proposals are not accepted outside of the scheduled proposal windows.',
      'Proposal window opened July 1 and closes on September 30 for contacts to be held from ' +
        'January to June 2027.',
      '4 to 6 weeks after the close of the proposal window',
    ]) {
      expect(page, `not in the ARISS capture: ${quote}`).toContain(quote);
      expect(body, `not in funder-ariss: ${quote}`).toContain(quote);
    }
  });

  it('states the IEEE MTT-S preconditions with BOTH member minimums, not just the lower one', () => {
    const i = byId('funder-ieee-mtts');
    // "at least 5 members" was carried in this repository as the MTT-S rule. The page says ten,
    // with five as the Student Branch Chapter exception — quoting only the exception tells a
    // joint or section chapter it qualifies when the funder says it does not.
    expect(i?.body).toMatch(/Minimum of ten \(10\) members; five \(5\) members for Student Branch Chapters/);
    expect(i?.body).toMatch(/vTools/);
    expect(i?.body).toMatch(/Minimum of two \(2\) reported technical meetings/);
    expect(i?.body).toMatch(/October 1/);
    expect(i?.body).toMatch(/\$1,000/);
    expect(i?.body).toMatch(/\$500/);
    expect(i?.slots).toContain('chapter.memberCount');
    expect(i?.slots).toContain('chapter.meetingCount');
    expect(i?.slots).toContain('chapter.officerRosterUrl');
  });

  it('models the IEEE date as a deadline and says why', () => {
    const body = byId('funder-ieee-mtts')?.body ?? '';
    expect(body).toMatch(/deadline, not a window/i);
    // A single date modelled as a one-day window reads `closed` on 364 days a year, and needs an
    // opening date IEEE never printed.
    expect(body).toMatch(/one-day window/);
    expect(body).toMatch(/inventing an opening date/i);
    // The page's own hedge is part of the fact. "may be asked" is not "will be rejected".
    expect(body).toMatch(/discretion/i);
  });

  it('quotes IEEE MTT-S in the funders own words', async () => {
    const page = await capture('ieee-mtts', '00-mtt-org-chapter-support.html');
    const body = fold(byId('funder-ieee-mtts')?.body ?? '');
    for (const quote of [
      "must have fulfilled all the following requirements for an 'active' status to be eligible " +
        'for any one of the below funding programs',
      'Minimum of ten (10) members; five (5) members for Student Branch Chapters',
      'Complete up-to-date Chapter Officer roster reported via',
      'Minimum of two (2) reported technical meetings via',
      'in the previous year, Chapters less than one-year-old are exempt from this requirement',
      'Before a chapter applies for MTT-S financial support they should apply for support from ' +
        'the IEEE Section to which that chapter reports',
      '$1,000 per year for single-society MTT-S Chapters or $500 per year for Joint Chapters ' +
        'which are associated with MTT-S',
      'The fund provides $500 seed money per chapter',
      'The event must be at least four (4) hours in length',
      'An IEEE MTT-S membership booth must be present at the event',
      'The MTT-S Regional Coordinator must endorse the proposed event',
      'up to $2,250 per year to send a Chapter Officer',
      'A sponsorship request usually requires a detailed description and mandatory post-event ' +
        'reporting',
      'All requests for MTT chapter funding must be received by October 1 or the chapter may be ' +
        'asked to make its application in the following year.',
    ]) {
      expect(page, `not in the IEEE capture: ${quote}`).toContain(quote);
      expect(body, `not in funder-ieee-mtts: ${quote}`).toContain(quote);
    }
    // The Jotform the funding request is actually made through, checked against the raw href.
    const { loadFixture } = await import('../../test/fixtures.js');
    expect(loadFixture('ieee-mtts', '00-mtt-org-chapter-support.html')).toContain(
      'form.jotform.com/243523980737161',
    );
    expect(byId('funder-ieee-mtts')?.body).toContain('form.jotform.com/243523980737161');
  });

  it('prints no MTT-S scholarship or fellowship amount, because that page prints none', async () => {
    const page = await capture('ieee-mtts', '00-mtt-org-chapter-support.html');
    // Figures for MTT-S undergraduate scholarships and graduate fellowships were asked of this
    // overlay. Neither appears on the page the overlay cites, so neither is stated.
    for (const absent of ['$1,500', '$6,000']) {
      expect(page, `unexpectedly present in the IEEE capture: ${absent}`).not.toContain(absent);
      expect(byId('funder-ieee-mtts')?.body, absent).not.toContain(absent);
    }
    expect(byId('funder-ieee-mtts')?.body).toMatch(/does \*\*not\*\* publish is any scholarship or fellowship amount/);
  });

  it('states plainly that Yaesu is a price the club pays, not an award it receives', async () => {
    const page = await capture('yaesu-dr2x', YAESU_CAPTURE);
    const y = byId('funder-yaesu-dr2x');
    expect(y?.body).toMatch(/discounted purchase/i);
    expect(y?.body).toMatch(/not a grant/i);
    for (const quote of [
      // The capture writes the price inside a <span>, so the closing period lands one space away
      // once the markup is folded out. The pin stops at the last figure rather than at a period
      // that only exists on one side of the comparison.
      'The new program price is either $1,450.00 or $1,860.00',
      'Yaesu USA is please to offer this DR-2X Program offering to our loyal customers once ' +
        'again through August 31st, 2026.',
      'LIMITED TIME PROGRAM',
    ]) {
      expect(page, `not in the Yaesu capture: ${quote}`).toContain(quote);
      expect(fold(y?.body ?? ''), `not in funder-yaesu-dr2x: ${quote}`).toContain(quote);
    }
    // The form filename is the only other place a date lives, and it is month-granular.
    const { loadFixture } = await import('../../test/fixtures.js');
    expect(loadFixture('yaesu-dr2x', YAESU_CAPTURE)).toContain('DR-2X_Jun-thru-Aug_2026-FILLABLE.pdf');
    expect(y?.body).toContain('DR-2X_Jun-thru-Aug_2026-FILLABLE.pdf');
    expect(y?.slots).toContain('repeater.site');
    expect(y?.slots).toContain('repeater.coordinator');
  });

  /**
   * THE CAUTIONARY TEST. Every string below is something this repository, its briefs, or its
   * hand-written fixtures have asserted about the Yaesu programme, and every one of them is
   * absent from the funder's real captured page. The first half re-derives that from the bytes;
   * the second half pins that the overlay repeats none of them.
   */
  it('carries no Yaesu obligation, accessory or eligibility claim the capture never makes', async () => {
    const { loadFixture } = await import('../../test/fixtures.js');
    const raw = loadFixture('yaesu-dr2x', YAESU_CAPTURE).toLowerCase();
    expect(raw.length).toBeGreaterThan(100_000);
    for (const absent of [
      '12 month',
      '12-month',
      'twelve',
      'on the air',
      'on-air',
      'obligat',
      'remain',
      'lan-01a',
      'network module',
      'north america',
      'discount',
      'grant',
      'retail',
      'june 3',
    ]) {
      expect(raw, `unexpectedly present in the Yaesu capture: ${absent}`).not.toContain(absent);
    }
    const body = byId('funder-yaesu-dr2x')?.body ?? '';
    expect(body).not.toMatch(/12 months|twelve months|on the air|on-air/i);
    expect(body).not.toMatch(/LAN-01A|network module/i);
    expect(body).not.toMatch(/must (?:remain|stay) (?:on the air|in service)/i);
    expect(body).not.toMatch(/June 3/);
    expect(body).not.toMatch(/North America/i);
    // Silence is not enough: the overlay has to tell the applicant the terms are unread.
    expect(body).toMatch(/states no ongoing obligation of any kind/);
    expect(body).toMatch(/An obligation nobody published is not an obligation/);
    expect(body).toMatch(/never downloads that PDF/);
    // And it owns its own vocabulary rather than putting words in Yaesu's mouth.
    expect(body).toMatch(/uses neither the word grant nor the word discount/);
    expect(body).toMatch(/does not say what distinguishes them/);
  });

  it('renders every slot as a visible gap when the applicant profile is empty', () => {
    for (const id of OVERLAYS) {
      const t = byId(id);
      // A loop over a template that does not exist passes every assertion inside it by
      // iterating nothing — the failure mode this whole file exists to refuse.
      expect(t, id).toBeDefined();
      const filled = fillTemplate(t?.body ?? '', {});
      expect([...filled.unresolvedSlots].sort(), id).toEqual([...(t?.slots ?? [])].sort());
      for (const slot of t?.slots ?? []) {
        expect(filled.markdown, `${id}: ${slot}`).toContain(todoFor(slot));
      }
      expect(filled.markdown, id).not.toMatch(/\{\{/);
      // Outside the markers, nothing may have appeared that looks like this applicant's own
      // details. A hint inside a marker is an instruction to the writer, not an assertion.
      const prose = stripTodoMarkers(filled.markdown);
      expect(prose, `${id} renders a callsign nobody supplied`).not.toMatch(/\b[A-Z]{1,2}\d[A-Z]{1,3}\b/);
    }
  });

  /**
   * The hybrid weld, in the layer where it does the most damage: a line mixing live slots with
   * invented specifics renders complete and true-looking, carries no `[TODO: …]`, and so passes
   * the export gate. A funder figure belongs in prose beside its quotation, never inside a model
   * sentence the applicant will paste. Spelled quantities count — "Three of our members … a
   * four-session class" carries no digit at all.
   */
  it('never welds a figure or a spelled quantity to a live slot', () => {
    const COUNT_WORD =
      /\b(?:a handful of|a couple of|couple|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|dozens?|several)\b/i;
    const offenders: string[] = [];
    for (const id of OVERLAYS) {
      expect(byId(id), id).toBeDefined();
      for (const raw of (byId(id)?.body ?? '').split('\n')) {
        if (!raw.includes('{{')) continue;
        const prose = raw
          .replace(/^\s*(?:[-*>]\s+|\d+\.\s+)+/, '')
          .replace(/^\s*-\s*\[[ x]\]\s*/, '')
          .replace(/^\*\*[^*]*\*\*/, '')
          .replace(/\{\{[^}]*\}\}/g, '');
        if (/\be\.g\.\s/i.test(prose)) offenders.push(`${id} — "e.g." beside a live slot: ${raw.trim()}`);
        if (/\d/.test(prose)) offenders.push(`${id} — a figure beside a live slot: ${raw.trim()}`);
        const spelled = COUNT_WORD.exec(prose);
        if (spelled) offenders.push(`${id} — "${spelled[0]}" beside a live slot: ${raw.trim()}`);
      }
      const body = byId(id)?.body ?? '';
      // Slot misattribution: the right slot carrying the wrong fact.
      expect(body, id).not.toMatch(/award(?:ed)?[^.\n]{0,40}\{\{project\.requestAmount\}\}/i);
      expect(body, id).not.toMatch(/(?:deadline|due|submit[^.\n]{0,20})\{\{project\.endDate\}\}/i);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the IEEE member and meeting hints truthful where they render, inside a marker', async () => {
    const { slotDef } = await import('./slots.js');
    // These two hints are rendered verbatim inside `[TODO: <path> — <hint>]` in this overlay's
    // own output, which makes them funder statements in the applicant's document. The member
    // hint said "at least 5 chapter members" — the page says ten, with five for Student Branch
    // Chapters — and the meeting hint said "this year" where the page says the previous year.
    expect(slotDef('chapter.memberCount')?.hint).toBe(
      'IEEE MTT-S requires at least 10 chapter members, or 5 for a Student Branch Chapter',
    );
    expect(slotDef('chapter.meetingCount')?.hint).toBe(
      'technical meetings reported in vTools in the previous year; at least 2 are required',
    );
    for (const path of ['chapter.memberCount', 'chapter.meetingCount']) {
      expect(todoFor(path), path).toContain(slotDef(path)?.hint ?? '');
    }
  });
});

/**
 * These two overlays are the only ones in the corpus with no capture behind them, and the reason
 * is structural rather than an omission: `funderCaptures.test.ts` pins every other overlay's
 * requirements against committed bytes of the funder's own page, and there is no single page to
 * capture for either of these. Student activity fee rules live on roughly 4,000 campus sites, and
 * Space Grant's rules live on 52 consortium sites. One captured page would be one campus's or one
 * consortium's, and quoting it as the programme's rule is the fabrication shape this repo has
 * removed over and over.
 *
 * So the bar for these two is different: they may teach a method, quote a labelled example, or
 * tell the applicant what to go and read — and they may not speak in the voice a funder uses to
 * state its own requirements, because no funder said any of it to us.
 */
describe('funder layer — the two workflows that no capture can back', () => {
  const GUIDED = ['funder-campus-sga', 'funder-nasa-space-grant'];

  it('ships both as funder-layer overlays with a source the reader can open', () => {
    for (const id of GUIDED) {
      const t = all.find((x) => x.id === id);
      expect(t, id).toBeDefined();
      expect(t?.layer, id).toBe('funder');
      expect(t?.sources.length, id).toBeGreaterThan(0);
      for (const s of t?.sources ?? []) expect(s.url, `${id}: ${s.label}`).toMatch(/^https:\/\//);
    }
  });

  it('states no requirement in a funder’s own imperative voice', () => {
    const offenders: string[] = [];
    const IMPERATIVE = [
      /\b(?:you|applicants?|your club|the applicant|the club) must\b/i,
      /\bthe funder requires\b/i,
      /\bapplicants? (?:are|is) required to\b/i,
      /\beligibility requires\b/i,
    ];
    for (const id of GUIDED) {
      const body = all.find((x) => x.id === id)?.body ?? '';
      expect(body, id).toBeTypeOf('string');
      expect(body.length, id).toBeGreaterThan(400);
      for (const line of body.split('\n')) {
        for (const re of IMPERATIVE) if (re.test(line)) offenders.push(`${id}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sends the applicant to a document of their own to read', () => {
    // The one instruction both share, and the only honest one available: the rule that governs
    // this applicant is written down somewhere they can reach, and neither of these pages is it.
    for (const id of GUIDED) {
      const body = all.find((x) => x.id === id)?.body ?? '';
      expect(body, id).toMatch(/\b(?:your own|your campus|your consortium|your state)\b/i);
      expect(body, id).toMatch(/\b(?:read|open|find|quote|confirm)\b/i);
    }
  });
});

/**
 * ------------------------------------------------------------------------------------------
 * FUNDER LAYER (Tasks 7 and 8) — ARDC, ARRL Amateur Radio Grants, ARRL Club Grant, ARRL
 * Foundation Scholarships.
 *
 * A component states STRUCTURE. An overlay states THIS FUNDER'S ACTUAL REQUIREMENTS — which
 * makes it the one place in the corpus where a fabricated fact would read as researched. The
 * three published-and-removed failures this product is built against were all of exactly this
 * shape: a Yaesu "repeater must remain on the air for 12 months" obligation appearing ZERO
 * times in that funder's real page, 148 records asserting "no cost share required" when no
 * funder had said so, and 345 awards linking a recipient's Facebook page as where to apply.
 *
 * So every requirement an overlay states must be QUOTABLE FROM A CAPTURED PAGE, and the
 * overlay must carry that page in `sources`. The quotes themselves are pinned against the
 * committed capture bytes in `funderCaptures.test.ts`; the assertions here pin that the
 * overlay says the thing at all, and — just as important — that it does NOT say the things
 * the captures never said.
 * ------------------------------------------------------------------------------------------
 */
describe('funder layer — invariants', () => {
  const overlays = all.filter((t) => t.layer === 'funder');

  it('cites at least one live https source for every overlay', () => {
    expect(overlays.length).toBeGreaterThan(0);
    for (const t of overlays) {
      expect(t.sources.length, `${t.id} has no sources`).toBeGreaterThan(0);
      for (const s of t.sources) {
        expect(s.url, `${t.id} source "${s.label}"`).toMatch(/^https?:\/\//);
        expect(s.label.length).toBeGreaterThan(3);
      }
    }
  });

  it('never links to the compromised farweb.org domain', () => {
    for (const t of all) {
      expect(t.body, `${t.id}`).not.toMatch(/farweb\.org/i);
      for (const s of t.sources) expect(s.url).not.toMatch(/farweb\.org/i);
    }
  });

  it('binds each overlay to a program id unless it is an always-available playbook', () => {
    for (const t of overlays) {
      if (t.alwaysAvailable) expect(t.programIds).toEqual([]);
      else expect(t.programIds.length, `${t.id}`).toBeGreaterThan(0);
    }
  });

  it('lists the components each overlay expects', () => {
    const componentIds = new Set(components.map((c) => c.id));
    for (const t of overlays) {
      for (const req of t.requires) expect(componentIds.has(req), `${t.id} requires ${req}`).toBe(true);
    }
  });
});

describe('funder layer — ARDC and ARRL Amateur Radio Grants', () => {
  const byId = (id: string) => all.find((t) => t.id === id);

  it('surfaces ARDC open-source obligation and the 20 percent indirect cap', () => {
    const ardc = byId('funder-ardc');
    expect(ardc).toBeDefined();
    expect(ardc?.body).toMatch(/open[- ]source/i);
    expect(ardc?.body).toMatch(/open[- ]access/i);
    expect(ardc?.body).toMatch(/CERN-OHL/);
    expect(ardc?.body).toMatch(/20%/);
    expect(ardc?.slots).toContain('project.openLicense');
    expect(ardc?.slots).toContain('project.indirectPct');
  });

  it('surfaces the ARDC brevity mandate and the four fixed cycles', () => {
    const ardc = byId('funder-ardc');
    expect(ardc?.body).toMatch(/brief|brevity/i);
    expect(ardc?.body).toMatch(/February 1.*April 1.*July 1.*September 1/s);
    expect(ardc?.body).toMatch(/fiscal sponsor/i);
    expect(ardc?.programIds).toEqual(['ardc-grants']);
  });

  /**
   * The brief for this task described the over-20% case as "either the institution accepts the
   * capped rate in writing, or the project is restructured". ARDC's instructions page says
   * neither: it asks the applicant to COST-SHARE the excess. An overlay that invents the remedy
   * sends a university to a negotiation its funder never asked for, so the published remedy is
   * pinned here by its own words.
   */
  it('states ARDCs published remedy for an institutional rate above the cap, not an invented one', () => {
    const ardc = byId('funder-ardc');
    expect(ardc?.body).toMatch(/cost-share any indirect amount over 20%/);
    expect(ardc?.body).not.toMatch(/in writing/i);
  });

  it('surfaces the three ARRL exclusions, the co-funding preference and the amount ceiling', () => {
    const arrl = byId('funder-arrl-amateur-radio-grants');
    expect(arrl?.body).toMatch(/emergency communication|emcomm/i);
    expect(arrl?.body).toMatch(/ongoing operating expenses/i);
    expect(arrl?.body).toMatch(/organizations only|never to individuals/i);
    expect(arrl?.body).toMatch(/\$3,000/);
    expect(arrl?.body).toMatch(/\$5,000/);
    expect(arrl?.body).toMatch(/Year of the Club/);
    expect(arrl?.body).toMatch(/February 1.{0,4}28|Jun(e)? 1.{0,4}30|October 1.{0,4}31/);
    expect(arrl?.programIds).toEqual(['arrl-amateur-radio-grants']);
  });

  /**
   * The page restricts the PROGRAM's location ("Only programs and initiatives conducted within
   * the United States are eligible") and, separately, the RECIPIENT's type ("Grants are awarded
   * only to organizations, not individuals"). Collapsing those into "US organizations only" —
   * as the brief did — invents a nationality test for the applicant that the page never states,
   * and would hide the program from an applicant it may be for.
   */
  it('keeps the US restriction on the programme, not on the applicants nationality', () => {
    const arrl = byId('funder-arrl-amateur-radio-grants');
    expect(arrl?.body).toMatch(/programs and initiatives conducted within the United States/);
    expect(arrl?.body).not.toMatch(/US organizations only/i);
  });
});

describe('funder layer — ARRL Club Grant and ARRL Foundation Scholarship', () => {
  const byId = (id: string) => all.find((t) => t.id === id);

  it('states the Club Grant cycle as disputed rather than printing a date', () => {
    const cg = byId('funder-arrl-club-grant');
    expect(cg).toBeDefined();
    expect(cg?.body).toMatch(/disputed/i);
    expect(cg?.body).toMatch(/three different/i);
    expect(cg?.body).toMatch(/news RSS|news feed/i);
    // It must not present a single confident deadline sentence.
    expect(cg?.body).not.toMatch(/The deadline is [A-Z][a-z]+ \d/);
  });

  it('gives the Club Grant range and the 2024 outcome numbers', () => {
    const cg = byId('funder-arrl-club-grant');
    expect(cg?.body).toMatch(/\$1,000/);
    expect(cg?.body).toMatch(/\$25,000/);
    expect(cg?.body).toMatch(/\$500,502/);
    expect(cg?.body).toMatch(/37 of 110/);
    expect(cg?.body).toMatch(/ARRL-affiliated/i);
    expect(cg?.programIds).toEqual(['arrl-club-grant']);
  });

  /**
   * `sources/arrl-pages.ts` records that the live 2026-08-02 capture of the Club Grant page
   * "contains no occurrence of 'affiliat' or 'eligib' anywhere in its raw HTML, in any form",
   * and therefore ships the record with `eligibility` undefined rather than inventing wording.
   * An overlay that then tells the applicant "applicants must be an ARRL-affiliated club"
   * re-asserts, in the applicant's own hands, the exact requirement the ingestion layer refused
   * to assert — and over-restricts, hiding a grant from a club it may be for.
   */
  it('reports the Club Grant affiliation question as unresolved instead of asserting it', () => {
    const cg = byId('funder-arrl-club-grant');
    expect(cg?.body).not.toMatch(/must be an ARRL-affiliated club/i);
    expect(cg?.body).not.toMatch(/in good standing/i);
    expect(cg?.body).toMatch(/no occurrence of "affiliat"/);
  });

  it('tells scholarship applicants what the catalog is and when the cycle ran', () => {
    const sch = byId('funder-arrl-foundation-scholarships');
    expect(sch?.body).toMatch(/one application|single application/i);
    expect(sch?.body).toMatch(/111/);
    expect(sch?.body).toMatch(/October 30/);
    expect(sch?.body).toMatch(/December 30/);
    expect(sch?.appliesTo).toEqual(['ham_scholarship']);
    expect(sch?.requires).toContain('scholarship-personal-essay');
  });

  /**
   * Three claims the brief for this task asked for, and the captures do not carry:
   *
   *  - a close time of "12:00 PM Eastern" — present ONLY in the synthetic `pathological.html`
   *    fixture written to exercise the parser, never in a capture of a live ARRL page;
   *  - "the close date moved from January 31" — the string "January 31" appears in no capture
   *    in the repository, so the overlay states no previous date and no movement;
   *  - "135 awards totalling more than $715,000 in 2024" — no captured page carries either
   *    figure.
   *
   * A time-of-day on a deadline is the highest-consequence detail in this whole overlay: an
   * applicant who believes they have until midnight when the form shuts at noon loses the year.
   * It is exactly the kind of specific that reads as researched. So it is not stated, and this
   * test keeps it out.
   */
  it('states no scholarship deadline detail that no captured page carries', () => {
    const sch = byId('funder-arrl-foundation-scholarships');
    // Case-sensitive on purpose for the abbreviation: `/EST\b/i` also matches the tail of
    // "request", "largest" and "best", which would fail this on prose that says nothing at all
    // about a time zone.
    expect(sch?.body).not.toMatch(/12:00|[Nn]oon|Eastern|\bEST\b/);
    expect(sch?.body).not.toMatch(/January 31/);
    expect(sch?.body).not.toMatch(/\$715|135 awards/);
    // And the gap is declared to the reader rather than left as silence.
    expect(sch?.body).toMatch(/publishes no closing TIME/);
  });

  it('reports the two ARRL pages that disagree about the size of the catalog', () => {
    const sch = byId('funder-arrl-foundation-scholarships');
    // "more than 170" (scholarship-program) vs "more than 150" (scholarship-descriptions), both
    // captured on the same day. Picking one and printing it would be a coin toss presented as
    // a fact; both are ARRL's own words and both are shown.
    expect(sch?.body).toMatch(/more than 170/);
    expect(sch?.body).toMatch(/more than 150/);
    expect(sch?.body).toMatch(/2026 Scholarship Cycle is now closed/);
  });
});

describe('funder layer — an overlay may not weld an invented figure to a live slot', () => {
  const OVERLAY_IDS = [
    'funder-ardc',
    'funder-arrl-amateur-radio-grants',
    'funder-arrl-club-grant',
    'funder-arrl-foundation-scholarships',
  ];

  /**
   * Task 4's finding, carried into the funder layer where it is worse. A line that welds live
   * slots to invented specifics renders as a complete, TRUE-LOOKING sentence in which the club's
   * real details are real and the number beside them is fabricated — and it carries no
   * `[TODO: …]`, so Task 14's export gate counts zero open todos and releases it.
   *
   * A digits-only detector does not catch the real cases: Task 4's actual line was "Three of our
   * members … will teach a four-session class", which spells every quantity as a word.
   *
   * The rule: a line is either fully self-contained (no live slot) or fully slotted (no invented
   * specific). A funder figure — the 20% cap, the $3,000 ceiling — belongs in the surrounding
   * prose beside its quotation, never inside a model sentence the applicant will paste.
   */
  const COUNT_WORD =
    /\b(?:a handful of|a couple of|couple|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|dozens?|several)\b/i;

  it('keeps every slotted line free of figures and spelled quantities', () => {
    const offenders: string[] = [];
    for (const id of OVERLAY_IDS) {
      const t = all.find((x) => x.id === id);
      expect(t, id).toBeDefined();
      for (const raw of (t?.body ?? '').split('\n')) {
        if (!raw.includes('{{')) continue;
        const prose = raw
          .replace(/^\s*(?:[-*>]\s+|\d+\.\s+)+/, '')
          .replace(/^\s*-\s*\[[ x]\]\s*/, '')
          .replace(/^\*\*[^*]*\*\*/, '')
          .replace(/\{\{[^}]*\}\}/g, '');
        if (/\d/.test(prose)) offenders.push(`${id} — figure beside a live slot: ${raw.trim()}`);
        const spelled = COUNT_WORD.exec(prose);
        if (spelled) offenders.push(`${id} — "${spelled[0]}" beside a live slot: ${raw.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Slot misattribution: the right slot carrying the wrong fact. Task 6 found
   * `{{project.requestAmount}}` printed as the AWARDED amount, `{{project.endDate}}` used as a
   * SUBMISSION date, and `{{recommender.role}}` under the APPLICANT's signature. Each renders
   * perfectly and states something false, and no marker is left behind to notice.
   */
  it('never prints a requested amount as an awarded one, or an end date as a deadline', () => {
    for (const id of OVERLAY_IDS) {
      const body = all.find((x) => x.id === id)?.body ?? '';
      expect(body, id).not.toMatch(/award(?:ed)?[^.\n]{0,40}\{\{project\.requestAmount\}\}/i);
      expect(body, id).not.toMatch(/\{\{project\.requestAmount\}\}[^.\n]{0,20}\bawarded\b/i);
      expect(body, id).not.toMatch(/(?:deadline|due|submit[^.\n]{0,20})\{\{project\.endDate\}\}/i);
    }
  });
});

/**
 * ------------------------------------------------------------------------------------------
 * FUNDER LAYER (Task 9) — ARISS, IEEE MTT-S Chapter Support, Yaesu DR-2X.
 *
 * Three programmes that are not cash grants, and the one place in this repository where the
 * product's founding failure actually happened. A Yaesu "the repeater must remain on the air for
 * 12 months" obligation was published as established fact for days. It came from a hand-written
 * fixture, never from Yaesu: `twelve`, `12 month`, `on the air`, `on-air`, `obligat` and `remain`
 * each appear ZERO times in the 145,639-byte capture of the funder's own page, and the test
 * below re-derives that from the committed bytes rather than trusting this comment.
 *
 * So each overlay here states funder facts only where a captured page carries the words, and the
 * pins below check both sides of every claim: the funder said it, and the overlay says it the
 * same way. Where the capture is silent the overlay says so out loud — the two prices whose
 * difference the page never explains, the application PDF this crawler never downloads, the
 * scholarship figures the IEEE page does not print — because a declared gap is the only honest
 * alternative to a plausible sentence.
 * ------------------------------------------------------------------------------------------
 */
describe('funder layer — ARISS, IEEE MTT-S and Yaesu DR-2X', () => {
  const byId = (id: string) => all.find((t) => t.id === id);
  const OVERLAYS = ['funder-ariss', 'funder-ieee-mtts', 'funder-yaesu-dr2x'];

  const YAESU_CAPTURE = '00-systemfusion-yaesu-com.html';

  /**
   * Markup out, entities and typographic characters folded to ASCII, whitespace collapsed —
   * lossy in one direction only, so it never adds a word. A phrase that survives this on both
   * sides really is the funder's own wording.
   */
  const fold = (raw: string): string =>
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#8217;|&rsquo;|’/g, "'")
      .replace(/&#8216;|&lsquo;|‘/g, "'")
      .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|“|”/g, '"')
      .replace(/&quot;/g, '"')
      .replace(/&#8211;|&ndash;|–/g, '-')
      .replace(/&#8212;|&mdash;|—/g, '--')
      .replace(/\s+/g, ' ');

  const capture = async (dir: string, file: string): Promise<string> => {
    const { loadFixture } = await import('../../test/fixtures.js');
    return fold(loadFixture(dir, file));
  };

  it('loads all three through the strict loader, bound to the canonical program ids', () => {
    for (const id of OVERLAYS) {
      const t = byId(id);
      expect(t, id).toBeDefined();
      expect(t?.layer, id).toBe('funder');
      // An overlay that were `alwaysAvailable` would be a playbook and would show for every
      // opportunity, funder facts and all.
      expect(t?.alwaysAvailable, id).toBe(false);
      expect(t?.sources.length, `${id} states funder facts with no sources`).toBeGreaterThan(0);
      for (const slot of t?.slots ?? []) expect(isKnownSlot(slot), `${id}: ${slot}`).toBe(true);
      const componentIds = new Set(components.map((c) => c.id));
      for (const req of t?.requires ?? []) expect(componentIds.has(req), `${id} → ${req}`).toBe(true);
    }
    // A one-character difference here produces no error, no warning and zero overlays.
    expect(byId('funder-ariss')?.programIds).toEqual(['ariss-iss-contact']);
    expect(byId('funder-ieee-mtts')?.programIds).toEqual(['ieee-mtts-chapter-support']);
    expect(byId('funder-yaesu-dr2x')?.programIds).toEqual(['yaesu-dr2x-repeater']);
    expect(byId('funder-ariss')?.funderId).toBe('ariss-usa');
    expect(byId('funder-ieee-mtts')?.funderId).toBe('ieee-mtts');
    expect(byId('funder-yaesu-dr2x')?.funderId).toBe('yaesu-usa');
  });

  it('tells ARISS applicants the award is a contact and mentoring, not cash', () => {
    const a = byId('funder-ariss');
    expect(a?.body).toMatch(/no cash/i);
    expect(a?.body).toMatch(/education plan/i);
    // The page's audience sentence names schools and educational organizations. Reading a
    // university INTO it is the same move as reading an obligation into a page that has none.
    expect(a?.body).toMatch(/not explicitly named/i);
    expect(a?.slots).toContain('project.beneficiaryCount');
    expect(a?.slots).toContain('team.instructorName');
  });

  it('states nothing about ARISS money, because the page publishes no figure at all', async () => {
    const page = await capture('ariss', '00-ariss-usa-org-proposal-overview.html');
    // The claim "no cash" is checkable in exactly one way: no dollar figure anywhere in the
    // capture. If ARISS ever publishes one, this fails and the overlay has to be rewritten.
    expect(page).not.toMatch(/\$\s?\d/);
    const body = byId('funder-ariss')?.body ?? '';
    expect(body).not.toMatch(/\$\d/);
    expect(body).toMatch(/publishes no dollar figure/i);
  });

  it('quotes ARISS in the funders own words', async () => {
    const page = await capture('ariss', '00-ariss-usa-org-proposal-overview.html');
    const body = fold(byId('funder-ariss')?.body ?? '');
    for (const quote of [
      'A scheduled ARISS contact is a voice-only communication via Amateur Radio between the ' +
        'International Space Station (ISS) crew and classrooms and communities.',
      'approximately 10 minutes in length',
      'paired with an ARISS Technical Mentor',
      'US schools and educational organizations may download the ARISS Proposal Form',
      'These scheduled contact opportunities are offered to formal and informal education ' +
        'institutions and organizations, individually or working together.',
      'the ability to integrate space and communication concepts into multiple areas of the ' +
        'curriculum for 4-6 months leading up to the contact',
      'potential audience size (we are looking to engage an entire school or organization, NOT ' +
        'just a single classroom)',
      'community connections (ham radio groups or other community members who could be of ' +
        'assistance)',
      'organizations must demonstrate flexibility to accommodate changes in contact dates and times',
      'Proposals are not accepted outside of the scheduled proposal windows.',
      'Proposal window opened July 1 and closes on September 30 for contacts to be held from ' +
        'January to June 2027.',
      '4 to 6 weeks after the close of the proposal window',
    ]) {
      expect(page, `not in the ARISS capture: ${quote}`).toContain(quote);
      expect(body, `not in funder-ariss: ${quote}`).toContain(quote);
    }
  });

  it('states the IEEE MTT-S preconditions with BOTH member minimums, not just the lower one', () => {
    const i = byId('funder-ieee-mtts');
    // "at least 5 members" was carried in this repository as the MTT-S rule. The page says ten,
    // with five as the Student Branch Chapter exception — quoting only the exception tells a
    // joint or section chapter it qualifies when the funder says it does not.
    expect(i?.body).toMatch(/Minimum of ten \(10\) members; five \(5\) members for Student Branch Chapters/);
    expect(i?.body).toMatch(/vTools/);
    expect(i?.body).toMatch(/Minimum of two \(2\) reported technical meetings/);
    expect(i?.body).toMatch(/October 1/);
    expect(i?.body).toMatch(/\$1,000/);
    expect(i?.body).toMatch(/\$500/);
    expect(i?.slots).toContain('chapter.memberCount');
    expect(i?.slots).toContain('chapter.meetingCount');
    expect(i?.slots).toContain('chapter.officerRosterUrl');
  });

  it('models the IEEE date as a deadline and says why', () => {
    const body = byId('funder-ieee-mtts')?.body ?? '';
    expect(body).toMatch(/deadline, not a window/i);
    // A single date modelled as a one-day window reads `closed` on 364 days a year, and needs an
    // opening date IEEE never printed.
    expect(body).toMatch(/one-day window/);
    expect(body).toMatch(/inventing an opening date/i);
    // The page's own hedge is part of the fact. "may be asked" is not "will be rejected".
    expect(body).toMatch(/discretion/i);
  });

  it('quotes IEEE MTT-S in the funders own words', async () => {
    const page = await capture('ieee-mtts', '00-mtt-org-chapter-support.html');
    const body = fold(byId('funder-ieee-mtts')?.body ?? '');
    for (const quote of [
      "must have fulfilled all the following requirements for an 'active' status to be eligible " +
        'for any one of the below funding programs',
      'Minimum of ten (10) members; five (5) members for Student Branch Chapters',
      'Complete up-to-date Chapter Officer roster reported via',
      'Minimum of two (2) reported technical meetings via',
      'in the previous year, Chapters less than one-year-old are exempt from this requirement',
      'Before a chapter applies for MTT-S financial support they should apply for support from ' +
        'the IEEE Section to which that chapter reports',
      '$1,000 per year for single-society MTT-S Chapters or $500 per year for Joint Chapters ' +
        'which are associated with MTT-S',
      'The fund provides $500 seed money per chapter',
      'The event must be at least four (4) hours in length',
      'An IEEE MTT-S membership booth must be present at the event',
      'The MTT-S Regional Coordinator must endorse the proposed event',
      'up to $2,250 per year to send a Chapter Officer',
      'A sponsorship request usually requires a detailed description and mandatory post-event ' +
        'reporting',
      'All requests for MTT chapter funding must be received by October 1 or the chapter may be ' +
        'asked to make its application in the following year.',
    ]) {
      expect(page, `not in the IEEE capture: ${quote}`).toContain(quote);
      expect(body, `not in funder-ieee-mtts: ${quote}`).toContain(quote);
    }
    // The Jotform the funding request is actually made through, checked against the raw href.
    const { loadFixture } = await import('../../test/fixtures.js');
    expect(loadFixture('ieee-mtts', '00-mtt-org-chapter-support.html')).toContain(
      'form.jotform.com/243523980737161',
    );
    expect(byId('funder-ieee-mtts')?.body).toContain('form.jotform.com/243523980737161');
  });

  it('prints no MTT-S scholarship or fellowship amount, because that page prints none', async () => {
    const page = await capture('ieee-mtts', '00-mtt-org-chapter-support.html');
    // Figures for MTT-S undergraduate scholarships and graduate fellowships were asked of this
    // overlay. Neither appears on the page the overlay cites, so neither is stated.
    for (const absent of ['$1,500', '$6,000']) {
      expect(page, `unexpectedly present in the IEEE capture: ${absent}`).not.toContain(absent);
      expect(byId('funder-ieee-mtts')?.body, absent).not.toContain(absent);
    }
    expect(byId('funder-ieee-mtts')?.body).toMatch(/does \*\*not\*\* publish is any scholarship or fellowship amount/);
  });

  it('states plainly that Yaesu is a price the club pays, not an award it receives', async () => {
    const page = await capture('yaesu-dr2x', YAESU_CAPTURE);
    const y = byId('funder-yaesu-dr2x');
    expect(y?.body).toMatch(/discounted purchase/i);
    expect(y?.body).toMatch(/not a grant/i);
    for (const quote of [
      // The capture writes the price inside a <span>, so the closing period lands one space away
      // once the markup is folded out. The pin stops at the last figure rather than at a period
      // that only exists on one side of the comparison.
      'The new program price is either $1,450.00 or $1,860.00',
      'Yaesu USA is please to offer this DR-2X Program offering to our loyal customers once ' +
        'again through August 31st, 2026.',
      'LIMITED TIME PROGRAM',
    ]) {
      expect(page, `not in the Yaesu capture: ${quote}`).toContain(quote);
      expect(fold(y?.body ?? ''), `not in funder-yaesu-dr2x: ${quote}`).toContain(quote);
    }
    // The form filename is the only other place a date lives, and it is month-granular.
    const { loadFixture } = await import('../../test/fixtures.js');
    expect(loadFixture('yaesu-dr2x', YAESU_CAPTURE)).toContain('DR-2X_Jun-thru-Aug_2026-FILLABLE.pdf');
    expect(y?.body).toContain('DR-2X_Jun-thru-Aug_2026-FILLABLE.pdf');
    expect(y?.slots).toContain('repeater.site');
    expect(y?.slots).toContain('repeater.coordinator');
  });

  /**
   * THE CAUTIONARY TEST. Every string below is something this repository, its briefs, or its
   * hand-written fixtures have asserted about the Yaesu programme, and every one of them is
   * absent from the funder's real captured page. The first half re-derives that from the bytes;
   * the second half pins that the overlay repeats none of them.
   */
  it('carries no Yaesu obligation, accessory or eligibility claim the capture never makes', async () => {
    const { loadFixture } = await import('../../test/fixtures.js');
    const raw = loadFixture('yaesu-dr2x', YAESU_CAPTURE).toLowerCase();
    expect(raw.length).toBeGreaterThan(100_000);
    for (const absent of [
      '12 month',
      '12-month',
      'twelve',
      'on the air',
      'on-air',
      'obligat',
      'remain',
      'lan-01a',
      'network module',
      'north america',
      'discount',
      'grant',
      'retail',
      'june 3',
    ]) {
      expect(raw, `unexpectedly present in the Yaesu capture: ${absent}`).not.toContain(absent);
    }
    const body = byId('funder-yaesu-dr2x')?.body ?? '';
    expect(body).not.toMatch(/12 months|twelve months|on the air|on-air/i);
    expect(body).not.toMatch(/LAN-01A|network module/i);
    expect(body).not.toMatch(/must (?:remain|stay) (?:on the air|in service)/i);
    expect(body).not.toMatch(/June 3/);
    expect(body).not.toMatch(/North America/i);
    // Silence is not enough: the overlay has to tell the applicant the terms are unread.
    expect(body).toMatch(/states no ongoing obligation of any kind/);
    expect(body).toMatch(/An obligation nobody published is not an obligation/);
    expect(body).toMatch(/never downloads that PDF/);
    // And it owns its own vocabulary rather than putting words in Yaesu's mouth.
    expect(body).toMatch(/uses neither the word grant nor the word discount/);
    expect(body).toMatch(/does not say what distinguishes them/);
  });

  it('renders every slot as a visible gap when the applicant profile is empty', () => {
    for (const id of OVERLAYS) {
      const t = byId(id);
      // A loop over a template that does not exist passes every assertion inside it by
      // iterating nothing — the failure mode this whole file exists to refuse.
      expect(t, id).toBeDefined();
      const filled = fillTemplate(t?.body ?? '', {});
      expect([...filled.unresolvedSlots].sort(), id).toEqual([...(t?.slots ?? [])].sort());
      for (const slot of t?.slots ?? []) {
        expect(filled.markdown, `${id}: ${slot}`).toContain(todoFor(slot));
      }
      expect(filled.markdown, id).not.toMatch(/\{\{/);
      // Outside the markers, nothing may have appeared that looks like this applicant's own
      // details. A hint inside a marker is an instruction to the writer, not an assertion.
      const prose = stripTodoMarkers(filled.markdown);
      expect(prose, `${id} renders a callsign nobody supplied`).not.toMatch(/\b[A-Z]{1,2}\d[A-Z]{1,3}\b/);
    }
  });

  /**
   * The hybrid weld, in the layer where it does the most damage: a line mixing live slots with
   * invented specifics renders complete and true-looking, carries no `[TODO: …]`, and so passes
   * the export gate. A funder figure belongs in prose beside its quotation, never inside a model
   * sentence the applicant will paste. Spelled quantities count — "Three of our members … a
   * four-session class" carries no digit at all.
   */
  it('never welds a figure or a spelled quantity to a live slot', () => {
    const COUNT_WORD =
      /\b(?:a handful of|a couple of|couple|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|dozens?|several)\b/i;
    const offenders: string[] = [];
    for (const id of OVERLAYS) {
      expect(byId(id), id).toBeDefined();
      for (const raw of (byId(id)?.body ?? '').split('\n')) {
        if (!raw.includes('{{')) continue;
        const prose = raw
          .replace(/^\s*(?:[-*>]\s+|\d+\.\s+)+/, '')
          .replace(/^\s*-\s*\[[ x]\]\s*/, '')
          .replace(/^\*\*[^*]*\*\*/, '')
          .replace(/\{\{[^}]*\}\}/g, '');
        if (/\be\.g\.\s/i.test(prose)) offenders.push(`${id} — "e.g." beside a live slot: ${raw.trim()}`);
        if (/\d/.test(prose)) offenders.push(`${id} — a figure beside a live slot: ${raw.trim()}`);
        const spelled = COUNT_WORD.exec(prose);
        if (spelled) offenders.push(`${id} — "${spelled[0]}" beside a live slot: ${raw.trim()}`);
      }
      const body = byId(id)?.body ?? '';
      // Slot misattribution: the right slot carrying the wrong fact.
      expect(body, id).not.toMatch(/award(?:ed)?[^.\n]{0,40}\{\{project\.requestAmount\}\}/i);
      expect(body, id).not.toMatch(/(?:deadline|due|submit[^.\n]{0,20})\{\{project\.endDate\}\}/i);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the IEEE member and meeting hints truthful where they render, inside a marker', async () => {
    const { slotDef } = await import('./slots.js');
    // These two hints are rendered verbatim inside `[TODO: <path> — <hint>]` in this overlay's
    // own output, which makes them funder statements in the applicant's document. The member
    // hint said "at least 5 chapter members" — the page says ten, with five for Student Branch
    // Chapters — and the meeting hint said "this year" where the page says the previous year.
    expect(slotDef('chapter.memberCount')?.hint).toBe(
      'IEEE MTT-S requires at least 10 chapter members, or 5 for a Student Branch Chapter',
    );
    expect(slotDef('chapter.meetingCount')?.hint).toBe(
      'technical meetings reported in vTools in the previous year; at least 2 are required',
    );
    for (const path of ['chapter.memberCount', 'chapter.meetingCount']) {
      expect(todoFor(path), path).toContain(slotDef(path)?.hint ?? '');
    }
  });
});
