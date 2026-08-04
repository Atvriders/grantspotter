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
