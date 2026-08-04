import { describe, expect, it } from 'vitest';
import { fillTemplate, todoFor } from './fill.js';
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
