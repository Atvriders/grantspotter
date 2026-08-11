import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE SIGNED-OUT PANEL'S SPACING AND MEASURE, HELD IN THE ONE PLACE THEY CAN BE.
 *
 * WHAT THIS FILE CAN PROVE, AND WHAT IT CANNOT. jsdom implements no layout — every
 * `getBoundingClientRect()` in it returns zeros — so nothing here measures a pixel, exactly as
 * `test/responsive.test.ts` says of itself. The pixels are measured in `e2e/signedOut.spec.ts`,
 * in Chromium, at nine widths in both themes and with a coarse pointer, and that file states what
 * it found. What THIS file reads is DECLARATIONS: it can say what the stylesheet asks for, which
 * is worth saying because until this stylesheet existed all of it lived in 31 inline `style`
 * attributes across three `.tsx` files, where a media query could not reach it and a test could
 * not read it.
 *
 * A DECLARATION CAN BE PRESENT AND INERT, and for one commit this file could not tell the two
 * apart. `gap` does nothing on a block container. Delete `display: grid` from `.signed-out-field`
 * and the sheet still says `gap: var(--s-2)`, the two assertions below still read 8px and 24px and
 * still find 24 ÷ 8 ≥ 2 — and Chromium renders the hint flush against the bottom of the input it
 * explains, at 0px, which is the fault the owner reported in the first place. That sabotage was
 * performed, and this file passed 21 of 21 against it.
 *
 * So every value asserted here is now paired with the property that makes it take effect: a `gap`
 * has to have a grid to sit in, a `justify-self` has to have a grid to be an item of, and the
 * `max-width` the narrow-screen rules promise not to un-centre has to have an `auto` margin
 * beside it. The rule for anything added later is the same one: assert the subject, not only the
 * number, or the number is a decoration on a sheet that does something else.
 *
 * AND PRESENT IS NOT THE SAME AS WINNING, which is the half that fix still got wrong. Both of the
 * checks it added asked whether a declaration EXISTED somewhere in the sheet and stopped at the
 * first one they found. Two sabotages. Each was measured in Chromium and each left this file
 * green — 26 of 26 — while the screen was wrong:
 *
 *   1. `@media (max-width: 480px) { .signed-out-field { display: block } }`. The unconditional
 *      `display: grid` is still there, so the pairing check above was satisfied. `e2e/signedOut
 *      .spec.ts` reported 60 hint/input pairs at 0px — every hint on every signed-out screen, at
 *      320, 360, 390 and 480, in both themes. That is the owner's original complaint restored, at
 *      the widths they are most likely to be holding, by a rule the check was written not to look
 *      at: it read only the rules with NO conditions.
 *   2. A second `min-height` later in base.css's coarse block, at the same specificity as the
 *      floor: `input:not([type="checkbox"]):not([type="radio"]) { min-height: 20px }`. `hasFloor`
 *      found the EARLIER rule declaring `min-height: var(--tap-min)`, answered yes and never asked
 *      what came after it. Chromium takes the later one, and with the floor gone the fields fall
 *      back to their content height: 48 controls under 44px across the signed-out sweep alone,
 *      40.5px for a body-size field and 37.5px for the two `--fs-200` code fields.
 *
 * These are ONE defect, so they have one fix: `winner()` below resolves the actual cascade — higher
 * specificity, then source order, with `!important` above both — and every claim about a
 * declaration is now a claim about the declaration that WINS, evaluated in every combination of
 * the sheet's own media conditions rather than only in the unconditional one. A check that reads a
 * stylesheet cannot evaluate `max-width: 480px`, so it enumerates instead: a promise that has to
 * hold on a phone and on a desktop has to hold in all of them.
 *
 * IT ALSO READS base.css. The 44px touch floor for these fields is not written in this component's
 * stylesheet any more — it is one app-wide rule in base.css's `pointer: coarse` block — and an
 * assertion that follows the decision is worth more than one that stays where the decision used to
 * be. That claim is checked by asking jsdom whether the selectors actually MATCH a text input,
 * rather than by looking for a string.
 *
 * The three faults being locked out are the ones the owner reported and the two the fix uncovered:
 *
 *   1. A HINT AGAINST ITS INPUT. `HINT.marginTop` was `calc(-1 * var(--s-3))`, which put every
 *      explanation 4px INSIDE the bottom edge of the control it explains (measured, Chromium at
 *      390px, before: -4px; after: +8px). The rule is not "8px" but the RELATIONSHIP: whatever the
 *      numbers become, a field's interior has to be visibly tighter than the space between fields,
 *      and it can never be zero or less.
 *   2. A PANEL THAT CANNOT RESPOND. `maxWidth: 380` was an inline style on the `main` element, and
 *      no media query can reach an inline style; the setup form rendered at 380px on a 1920px
 *      desktop with its help text at 43 characters a line.
 *   3. A `var()` NAMING NOTHING. `color: var(--ink-2)` is invalid at computed-value time — there is
 *      no such token — so every hint inherited full-strength body ink instead of the muted grey it
 *      was asking for, silently, for as long as the file existed.
 */

const HERE = import.meta.dirname;
const CSS_PATH = path.join(HERE, 'signedOut.css');
const ROUTES = path.join(HERE, '..', 'routes');

/** Comments stripped: a `var(--ink-2)` quoted in a comment is prose, not a declaration. */
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const tokens = readFileSync(path.join(HERE, '..', 'styles', 'tokens.css'), 'utf8');

/** Read for one claim only: the touch floor these fields now inherit instead of restating. */
const baseCss = readFileSync(path.join(HERE, '..', 'styles', 'base.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

interface Rule {
  selector: string;
  body: string;
  /** The `@media` preludes enclosing this rule, outermost first. */
  conditions: string[];
}

/**
 * Every rule in the sheet, with the conditions it sits under. A selector may appear more than once
 * — `.signed-out-form` states its place in the panel in one rule and its interior in another — so
 * this returns a list and the helpers below fold over all matches rather than taking the first.
 */
function parse(source: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (text: string, conditions: string[]): void => {
    let i = 0;
    let prelude = '';
    while (i < text.length) {
      if (text[i] !== '{') {
        prelude += text[i];
        i += 1;
        continue;
      }
      const start = i + 1;
      let depth = 1;
      i = start;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        i += 1;
      }
      const body = text.slice(start, i - 1);
      const selector = prelude.trim().replace(/\s+/g, ' ');
      prelude = '';
      if (selector.startsWith('@')) walk(body, [...conditions, selector]);
      else rules.push({ selector, body, conditions });
    }
  };
  walk(source, []);
  return rules;
}

const RULES = parse(css);
const BASE_RULES = parse(baseCss);

function selectorsOf(rule: Rule): string[] {
  return rule.selector.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
}

/** Every value this one rule declares for `prop`. */
function declaredIn(rule: Rule, prop: string): string[] {
  return rule.body
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.slice(0, chunk.indexOf(':')).trim() === prop)
    .map((chunk) => chunk.slice(chunk.indexOf(':') + 1).trim());
}

/** Every declared value of `prop` for an exact selector, innermost conditions included. */
function valuesOf(selector: string, prop: string): string[] {
  return RULES.filter((rule) => selectorsOf(rule).includes(selector)).flatMap((rule) =>
    declaredIn(rule, prop),
  );
}

function valueOf(selector: string, prop: string): string | undefined {
  const found = valuesOf(selector, prop);
  return found[found.length - 1];
}

/** `var(--s-5)` → 24, from tokens.css, so a retuned scale moves these assertions with it. */
function spacingPx(value: string): number {
  const name = /^var\((--[\w-]+)\)$/.exec(value.trim())?.[1];
  expect(name, `${value} is not a spacing token, and a hand-typed pixel here is a second scale`).toBeDefined();
  const declared = new RegExp(`${name ?? ''}\\s*:\\s*([0-9.]+)px`).exec(tokens)?.[1];
  expect(declared, `${String(name)} is not declared in tokens.css`).toBeDefined();
  return Number(declared);
}

/**
 * A margin that opens a gap by cancelling one, which is what the hint's `calc(-1 * var(--s-3))`
 * was. Token names carry digits after hyphens (`--s-3`), so the references have to come out before
 * anything can look for a minus sign in front of a number.
 */
function isNegativeMargin(declaration: string): boolean {
  const withoutTokens = declaration.replace(/var\(\s*--[\w-]+\s*(?:,[^)]*)?\)/g, 'V');
  return /^margin/.test(declaration.trim()) && /(^|[\s:(*])-\s*\.?\d/.test(withoutTokens);
}

/** The inline-axis half of a `margin` shorthand: `12vh auto` → `auto`. */
function inlineMargin(shorthand: string): string {
  const parts = shorthand.trim().split(/\s+/);
  return (parts.length === 1 ? parts[0] : parts[1]) ?? '';
}

/**
 * CSS specificity as one sortable number: an id counts 10,000, a class / attribute / pseudo-class
 * counts 100, a type or pseudo-element counts 1, and the universal selector and the combinators
 * count nothing. `:where()` contributes nothing at all; `:not()`, `:is()` and `:has()` contribute
 * the specificity of their MOST specific argument and nothing for themselves (Selectors 4 §17).
 *
 * Needed because "which rule wins" is the whole question below, and `input` and
 * `input:not([type="checkbox"])` are one clause apart and two very different weights — the first
 * cannot override base.css's floor and the second can.
 */
function specificity(selector: string): number {
  let rest = selector.trim();
  let fromFunctions = 0;
  // Innermost first: `[^()]*` cannot span a nested pair, so `:not(:is(.a))` resolves `:is(.a)`
  // before the `:not()` around it, and each pass removes the one it has already counted.
  for (;;) {
    const fn = /:(not|is|has|where)\(([^()]*)\)/i.exec(rest);
    if (fn === null) break;
    const name = (fn[1] ?? '').toLowerCase();
    const args = (fn[2] ?? '').split(',');
    fromFunctions += name === 'where' ? 0 : Math.max(0, ...args.map((arg) => specificity(arg)));
    rest = `${rest.slice(0, fn.index)} ${rest.slice(fn.index + fn[0].length)}`;
  }
  const take = (pattern: RegExp): number => {
    const found = rest.match(pattern) ?? [];
    rest = rest.replace(pattern, ' ');
    return found.length;
  };
  // The order is the point: `::before` has to be taken before anything counts `:before` as a
  // pseudo-class, and `[type="checkbox"]` before anything counts `checkbox` as a type.
  const pseudoElements = take(/::[-\w]+/g);
  const ids = take(/#[-\w]+/g);
  const attributes = take(/\[[^\]]*\]/g);
  const classes = take(/\.[-\w]+/g);
  const pseudoClasses = take(/:[-\w]+/g);
  const types = take(/[a-z][-\w]*/gi);
  return (
    fromFunctions +
    ids * 10_000 +
    (attributes + classes + pseudoClasses) * 100 +
    types +
    pseudoElements
  );
}

/** A declaration that won, with the rule it came from, so a failure can name what beat what. */
interface Winner {
  readonly value: string;
  readonly rule: Rule;
}

/** `!important` is a separate origin that outranks every normal declaration, whatever its weight. */
const IMPORTANT = 1_000_000;

/**
 * The declaration of `prop` that WINS for the selectors `matches` admits, in a context where a
 * rule's conditions are active exactly when `active` says they are.
 *
 * This is the cascade as far as a stylesheet can be read for it: higher specificity wins, equal
 * specificity is settled by source order, `!important` beats both. Rules that do not declare
 * `prop` are skipped BEFORE `matches` sees them — partly because it is pointless work, and partly
 * because `matches` is jsdom, which is entitled to refuse a selector like `*::before` that no
 * element can ever match.
 *
 * What it cannot model: the other stylesheets. Every sheet in this app is imported into one
 * bundle, so a rule in another file could out-specify one here. Each caller below therefore reads
 * the one file the decision it is checking is written in, and says which file that is.
 */
function winner(
  rules: readonly Rule[],
  matches: (selector: string) => boolean,
  prop: string,
  active: (conditions: readonly string[]) => boolean,
): Winner | undefined {
  let best: { won: Winner; weight: number; order: number } | undefined;
  rules.forEach((rule, order) => {
    const declarations = declaredIn(rule, prop);
    if (declarations.length === 0) return;
    if (!active(rule.conditions)) return;
    const selected = selectorsOf(rule).filter(matches);
    if (selected.length === 0) return;
    // A rule's weight for THIS element is the weight of the selector in its list that selects it.
    const base = Math.max(...selected.map(specificity));
    for (const declared of declarations) {
      const important = /!\s*important$/i.test(declared);
      const weight = important ? base + IMPORTANT : base;
      // `>=` on the order so that the LAST of two declarations of one property inside a single
      // rule is the one kept, which is what a browser does with them.
      if (
        best === undefined ||
        weight > best.weight ||
        (weight === best.weight && order >= best.order)
      ) {
        best = {
          won: { value: declared.replace(/\s*!\s*important$/i, '').trim(), rule },
          weight,
          order,
        };
      }
    }
  });
  return best?.won;
}

/**
 * Every combination of a sheet's `@media` conditions, as the set to treat as ACTIVE.
 *
 * A file that reads CSS cannot evaluate a media query, so it enumerates them instead. This is the
 * half the previous version of these checks was missing: it looked only at the rules with no
 * conditions at all, so a `display: block` written inside `max-width: 480px` was invisible to it
 * while being exactly what a phone renders.
 */
function conditionContexts(rules: readonly Rule[]): string[][] {
  const all = [...new Set(rules.flatMap((rule) => rule.conditions))];
  expect(
    all.length,
    'this enumeration is 2^n — a sheet with that many conditions needs a different model, not a ' +
      'longer loop',
  ).toBeLessThanOrEqual(8);
  const out: string[][] = [];
  for (let mask = 0; mask < 1 << all.length; mask += 1) {
    out.push(all.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return out;
}

/** A rule is live in a context when every condition it sits under is one that context turns on. */
const activeIn =
  (on: readonly string[]) =>
  (conditions: readonly string[]): boolean =>
    conditions.every((condition) => on.includes(condition));

const describeContext = (on: readonly string[]): string =>
  on.length === 0 ? 'with no media query active' : `under ${on.join(' and ')}`;

/**
 * The `display` that wins for an exact selector in this sheet, in one condition context.
 *
 * Matched by selector STRING, and that is the limit of this one: a rule written as
 * `.signed-out .signed-out-field` also selects the box and is not seen here. The floor check below
 * has an element and so uses jsdom instead; this one has only a name out of the sheet. Every rule
 * in `signedOut.css` today names these boxes by the same single class, and the assertion that
 * nothing anywhere reaches them by another route is the one this file does not make.
 */
function displayFor(selector: string, on: readonly string[]): Winner | undefined {
  return winner(RULES, (candidate) => candidate === selector, 'display', activeIn(on));
}

/** The displays under which `gap`, `justify-self` and their neighbours mean anything at all. */
const LAYS_OUT_ITS_CHILDREN = /^(inline-)?(grid|flex)$/;

describe('the reader found the stylesheet it is supposed to be reading', () => {
  it('parsed rules out of it, including a conditional one', () => {
    // Every assertion below would be vacuously true against an empty parse.
    expect(RULES.length).toBeGreaterThan(15);
    expect(RULES.some((rule) => rule.conditions.length > 0)).toBe(true);
    expect(RULES.some((rule) => selectorsOf(rule).includes('.signed-out'))).toBe(true);
  });
});

describe('spacing states the relationship between a field and its parts', () => {
  // Read inside the tests, never at describe scope: an `expect` that runs during collection turns
  // a failure into "no tests" for the whole file, which is a worse report than the one it replaces.
  const withinField = (): number => spacingPx(valueOf('.signed-out-field', 'gap') ?? '');
  const betweenFields = (): number => spacingPx(valueOf('.signed-out-form', 'gap') ?? '');

  /** Why a box that carries a `gap` is not laying its children out, in one context, or ''. */
  const notLayingOut = (selector: string, on: readonly string[]): string => {
    const display = displayFor(selector, on);
    if (display === undefined) return `nothing gives it a display ${describeContext(on)}`;
    if (!LAYS_OUT_ITS_CHILDREN.test(display.value)) {
      return `\`${display.rule.selector} { display: ${display.value} }\` wins ${describeContext(on)}`;
    }
    return '';
  };

  it('writes those gaps on boxes that can have one, at every combination of media conditions', () => {
    /*
      `gap` DOES NOTHING on a block container, and says nothing when it is ignored. This is the
      assertion the file was missing: with `display: grid` deleted from `.signed-out-field` the two
      tests below still read 8 and 24 out of the sheet, still found 24 ÷ 8 ≥ 2, and Chromium
      measured 0px from the input to the hint explaining it — the owner's original complaint,
      passing 21 of 21.

      AND THE FIRST VERSION OF THIS CHECK ONLY LOOKED AT THE UNCONDITIONAL RULES, which is the same
      hole one storey up. `@media (max-width: 480px) { .signed-out-field { display: block } }`
      leaves the unconditional `display: grid` in place, so the check was satisfied — and
      `e2e/signedOut.spec.ts` measured 60 hint/input pairs at 0px, every hint on every signed-out
      screen at 320, 360, 390 and 480 in both themes. The reported fault, at the widths most likely
      to meet it. So the question is not "is a grid declared" but "which display WINS", and it is
      asked once per combination of the media conditions this sheet actually contains.

      Written over every gap in the sheet rather than over the two that are known about, because
      the next one will be written by somebody who has not read this comment.
    */
    const written = RULES.flatMap((rule) =>
      ['gap', 'row-gap', 'column-gap'].flatMap((prop) =>
        declaredIn(rule, prop).flatMap(() => selectorsOf(rule).map((selector) => ({ selector, prop }))),
      ),
    );
    // Otherwise vacuous: no gaps at all satisfies every check below, and would also mean the two
    // spacing tests are reading `undefined`.
    expect(written.length).toBeGreaterThanOrEqual(2);
    const contexts = conditionContexts(RULES);
    expect(contexts.length, 'the context enumeration produced nothing to check under').toBeGreaterThan(1);
    const inert: string[] = [];
    for (const on of contexts) {
      for (const { selector, prop } of written) {
        const why = notLayingOut(selector, on);
        if (why !== '') inert.push(`${selector} { ${prop} } — ${why}`);
      }
    }
    expect([...new Set(inert)]).toEqual([]);
  });

  it('states a grid-item property only where there is a grid to be an item of', () => {
    // The same shape one level down. `.signed-out-form > .btn { justify-self: start }` is what
    // keeps the button from stretching the width of the panel, and it is dropped in silence the
    // moment its parent stops laying its children out — including at one viewport only.
    const items = RULES.flatMap((rule) =>
      ['justify-self', 'align-self'].flatMap((prop) =>
        declaredIn(rule, prop).flatMap(() => selectorsOf(rule).map((selector) => ({ selector, prop }))),
      ),
    );
    expect(items.length).toBeGreaterThan(0);
    const orphans: string[] = [];
    for (const on of conditionContexts(RULES)) {
      for (const { selector, prop } of items) {
        // A direct-child selector names the box that has to do the laying out. A descendant
        // selector does not say whose child the item is, so this cannot check it and refuses it.
        const parts = selector.split('>').map((part) => part.trim());
        if (parts.length !== 2) {
          orphans.push(`${selector} { ${prop} } — no grid parent named`);
          continue;
        }
        const why = notLayingOut(parts[0] ?? '', on);
        if (why !== '') orphans.push(`${selector} { ${prop} } — its parent ${why}`);
      }
    }
    expect([...new Set(orphans)]).toEqual([]);
  });

  it('puts real space between a control and its own explanation', () => {
    // The reported fault, stated as the rule that forbids it: an explanation may never touch, or
    // overlap, the box it explains.
    expect(withinField()).toBeGreaterThan(0);
  });

  it('separates two fields by more than it separates a field from its own hint', () => {
    // Proximity is the only thing telling a reader which explanation belongs to which control.
    // A ratio, not a difference, so the check survives a retuned spacing scale.
    expect(betweenFields() / withinField()).toBeGreaterThanOrEqual(2);
  });

  it('never reaches a gap by cancelling one margin with another', () => {
    // `calc(-1 * var(--s-3))` on the hint is what this file exists to prevent coming back, and a
    // negative margin anywhere in this sheet is the shape of it.
    const negatives = RULES.flatMap((rule) =>
      rule.body
        .split(';')
        .map((chunk) => chunk.trim())
        .filter(isNegativeMargin)
        .map((chunk) => `${rule.selector} { ${chunk} }`),
    );
    expect(negatives).toEqual([]);
  });

  it('would catch the declaration that caused the fault, so the check is not vacuous', () => {
    // The exact line out of the old `HINT`, and the two other ways of writing it.
    expect(isNegativeMargin('margin-top: calc(-1 * var(--s-3))')).toBe(true);
    expect(isNegativeMargin('margin-top: calc(var(--s-3) * -1)')).toBe(true);
    expect(isNegativeMargin('margin-bottom: -4px')).toBe(true);
    // …and none of the positive declarations this sheet actually writes, several of which contain
    // a hyphen followed by a digit inside a token name.
    expect(isNegativeMargin('margin: 0 0 var(--s-2)')).toBe(false);
    expect(isNegativeMargin('margin-block: var(--s-5)')).toBe(false);
    expect(isNegativeMargin('margin: 12vh auto')).toBe(false);
  });

  it('spaces the head of the panel by the same two distances, not by a third', () => {
    // The eyebrow belongs to the title; the title and its lede are one block; the form is the next
    // object and takes the between-fields distance.
    expect(spacingPx(valueOf('.signed-out > .eyebrow', 'margin')?.split(' ')[2] ?? '')).toBe(
      withinField(),
    );
    expect(spacingPx(valueOf('.signed-out-form', 'margin-top') ?? '')).toBe(betweenFields());
  });
});

describe('the panel has a measure, and it differs by what the screen holds', () => {
  it('states both widths as ceilings, never as fixed widths', () => {
    // A ceiling cannot force a horizontal scrollbar; a `width` can, at every viewport below it.
    // This is `test/responsive.test.ts` rule 3, restated where the decision is made.
    for (const variant of ['.signed-out-compact', '.signed-out-prose']) {
      expect(valueOf(variant, 'max-width')).toBeDefined();
      expect(valuesOf(variant, 'width')).toEqual([]);
      expect(valuesOf(variant, 'min-width')).toEqual([]);
    }
  });

  it('gives the form full of prose a wider ceiling than the two-field sign-in box', () => {
    const rem = (selector: string): number =>
      Number(/min\((\d+(?:\.\d+)?)rem/.exec(valueOf(selector, 'max-width') ?? '')?.[1]);
    expect(rem('.signed-out-prose')).toBeGreaterThan(rem('.signed-out-compact'));
  });

  it('centres the panel it puts those ceilings on', () => {
    // A `max-width` on its own leaves the card against the left edge of a 1920px window; the
    // `auto` in `margin: 12vh auto` is the whole of the centring. The narrow-screen rule below
    // promises to KEEP it — a promise about a declaration nothing in this file had ever read.
    expect(inlineMargin(valueOf('.signed-out', 'margin') ?? '')).toBe('auto');
  });

  it('keeps a gutter at every width, so the card never becomes the page', () => {
    // The `100% - 2 * --s-2` half of each `min()`. Without it the panel is exactly the viewport on
    // a phone and its border sits on the screen edge.
    for (const variant of ['.signed-out-compact', '.signed-out-prose']) {
      expect(valueOf(variant, 'max-width')).toMatch(/100%\s*-\s*2\s*\*\s*var\(--s-2\)/);
    }
  });

  it('caps the help text in characters, which is what a measure is', () => {
    // `ch` and not `px`: the constraint is how many characters a line holds, and a pixel cap says
    // something different at every font size.
    expect(valueOf('.signed-out-hint', 'max-width')).toMatch(/^\d+ch$/);
  });

  it('leaves the panel room for that cap rather than clipping it', () => {
    // 66ch of --fs-200 is 475px measured; the prose panel has to be able to hold it plus its own
    // padding, or the cap never binds and the width is doing the measuring after all.
    const ch = Number(/^(\d+)ch$/.exec(valueOf('.signed-out-hint', 'max-width') ?? '')?.[1]);
    const panelPx = Number(/min\((\d+(?:\.\d+)?)rem/.exec(valueOf('.signed-out-prose', 'max-width') ?? '')?.[1]) * 16;
    const padding = spacingPx(valueOf('.signed-out', 'padding') ?? '');
    // 7.2px per `0` at 13px, measured in Chromium; see the header of `e2e/signedOut.spec.ts`.
    expect(panelPx - 2 * padding).toBeGreaterThanOrEqual(ch * 7.2);
  });
});

describe('the responsive rules', () => {
  const narrow = RULES.filter((rule) => rule.conditions.some((c) => /max-width/.test(c)));

  /** The app-wide floor in base.css, which is where this component's copy of it went. */
  const floorRules = BASE_RULES.filter(
    (rule) =>
      rule.conditions.some((c) => /pointer\s*:\s*coarse/.test(c)) &&
      declaredIn(rule, 'min-height').includes('var(--tap-min)'),
  );

  /** The contexts in base.css in which a thumb is driving the product. */
  const coarseContexts = (): string[][] =>
    conditionContexts(BASE_RULES).filter((on) => on.some((c) => /pointer\s*:\s*coarse/.test(c)));

  /** `var(--tap-min)` → 44, `44px` → 44. Anything else is not a length this file can compare. */
  const asPx = (value: string): number | undefined => {
    if (/^var\(\s*--tap-min\s*\)$/.test(value)) return spacingPx('var(--tap-min)');
    const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
    return px === null ? undefined : Number(px[1]);
  };

  /**
   * The `min-height` that WINS for this control under a coarse pointer, or undefined if no rule
   * gives it one at all.
   *
   * NOT "is there a rule that sets the floor". The version this replaces stopped at the first
   * coarse rule declaring `min-height: var(--tap-min)` and answered yes. Add a second rule of the
   * same specificity later in the same block —
   * `input:not([type="checkbox"]):not([type="radio"]) { min-height: 20px }` — and Chromium takes
   * the later one: measured, 48 controls under 44px across the signed-out sweep, at 40.5px and
   * 37.5px, with that check still green. A declaration being present is not a declaration taking
   * effect, which is the same thing the gap check above had wrong; both now ask the cascade.
   *
   * jsdom decides what a rule SELECTS, not a regex: `input:not([type="checkbox"])` and `input` are
   * the same string to a search and different rules to a browser, and which controls are covered
   * is the entire question here.
   */
  const winningFloor = (html: string, on: readonly string[]): Winner | undefined => {
    const host = document.createElement('div');
    host.innerHTML = html;
    const element = host.firstElementChild;
    expect(element, `${html} did not parse into an element`).not.toBeNull();
    return winner(
      BASE_RULES,
      (selector) => element?.matches(selector) === true,
      'min-height',
      activeIn(on),
    );
  };

  /** Every control a thumb has to be able to hit, and the two that are handled another way. */
  const CONTROLS = [
    '<input type="text" />',
    '<input type="email" />',
    '<input type="password" />',
    '<input type="search" />',
    '<input type="number" />',
    '<input type="date" />',
    '<input type="url" />',
    '<input type="file" />',
    '<select></select>',
    '<textarea></textarea>',
    '<button></button>',
    '<a class="btn"></a>',
    '<summary></summary>',
    '<div role="tab"></div>',
    '<label><input type="checkbox" /></label>',
  ];

  it('re-spaces on a narrow screen without hiding anything', () => {
    // `test/responsive.test.ts` states this repo-wide: a breakpoint may re-flow, re-space and
    // re-order, but it may never delete. Restated here because this is a new breakpoint.
    expect(narrow.length).toBeGreaterThan(0);
    for (const rule of narrow) expect(rule.body).not.toMatch(/display\s*:\s*none/);
  });

  it('keeps the centring when it changes the margins on a phone', () => {
    // `margin: 24px 8px` would left-align the sign-in box in any window wider than 384px. The
    // block axis is the only one this rule has any business touching.
    for (const rule of narrow) {
      expect(rule.body).not.toMatch(/(^|[\s;])margin\s*:/);
      expect(rule.body).not.toMatch(/margin-inline/);
    }
  });

  it('gives every field in the product the touch floor, and lets no later rule take it back', () => {
    /*
      base.css's coarse block covered `.btn`, `button`, `summary`, `[role="tab"]` and the box of a
      checkbox, and no field of any kind; this stylesheet answered that for its own three screens
      and left the rest of the product where it was. MEASURED, Chromium at 320/360/390 with a
      coarse pointer over every route that carries a form: /applications' 47 text inputs at 35px,
      /profile's eleven at 40.5px, its eight `<select>`s at 37px and its three date fields at
      42.5px. The owner asked whether mobile worked, not whether setup did.

      What is asserted is the WINNING `min-height`, not the presence of one, and it is asserted as
      a number against the token rather than as the string `var(--tap-min)`: a rule that overrode
      the floor with `min-height: 20px` would be a floor written twice and honoured once, and the
      old check — which stopped at the first rule naming the token — reported that as covered.
    */
    expect(floorRules.length).toBeGreaterThan(0);
    const contexts = coarseContexts();
    expect(contexts.length, 'no context in base.css turns a coarse pointer on').toBeGreaterThan(0);
    const short: string[] = [];
    for (const on of contexts) {
      for (const html of CONTROLS) {
        const won = winningFloor(html, on);
        if (won === undefined) {
          short.push(`${html} — no rule gives it a min-height ${describeContext(on)}`);
          continue;
        }
        const px = asPx(won.value);
        if (px === undefined || px < spacingPx('var(--tap-min)')) {
          short.push(
            `${html} — \`${won.rule.selector} { min-height: ${won.value} }\` wins ` +
              `${describeContext(on)}`,
          );
        }
      }
    }
    expect(short).toEqual([]);
  });

  it('leaves the tick boxes to the rule written for them', () => {
    // The negative half, and the reason the selector is written the awkward way it is. A checkbox
    // is the one control that must not be stretched to 44: base.css grows the BOX to 20px and puts
    // the floor on the label around it, so what a thumb aims at is the whole row.
    for (const on of coarseContexts()) {
      expect(winningFloor('<input type="checkbox" />', on)).toBeUndefined();
      expect(winningFloor('<input type="radio" />', on)).toBeUndefined();
    }
  });

  it('reads the cascade the way a browser does, so the two checks above are not guesses', () => {
    // The weights the two checks turn on, stated directly. `input` cannot override base.css's
    // floor and `input:not([type="checkbox"]):not([type="radio"])` can, and a check that got that
    // backwards would either miss a real override or invent one.
    expect(specificity('input')).toBe(1);
    expect(specificity('.signed-out-field')).toBe(100);
    expect(specificity('input:not([type="checkbox"]):not([type="radio"])')).toBe(201);
    expect(specificity('label:has(> input[type="checkbox"])')).toBe(102);
    expect(specificity('#id .cls tag')).toBe(10_101);
    expect(specificity('[role="tab"]')).toBe(100);
    expect(specificity('a::before')).toBe(2);
    // `:where()` is the one functional pseudo-class that adds nothing, including for its argument.
    expect(specificity(':where(#id) p')).toBe(1);
    expect(specificity('*')).toBe(0);

    // Source order settles a tie, and `!important` settles it regardless of order.
    const sheet = parse(
      '@media (pointer: coarse) { .a { min-height: 44px } .a { min-height: 20px } }',
    );
    expect(winner(sheet, (s) => s === '.a', 'min-height', () => true)?.value).toBe('20px');
    const shouted = parse(
      '@media (pointer: coarse) { .a { min-height: 44px !important } .a { min-height: 20px } }',
    );
    expect(winner(shouted, (s) => s === '.a', 'min-height', () => true)?.value).toBe('44px');
    // ...and specificity beats source order.
    const weighted = parse('div.a { min-height: 44px } .a { min-height: 20px }');
    expect(winner(weighted, () => true, 'min-height', () => true)?.value).toBe('44px');
    // A rule whose conditions the context does not turn on is not in the running at all.
    expect(winner(sheet, (s) => s === '.a', 'min-height', (c) => c.length === 0)).toBeUndefined();
  });

  it('does not restate that floor here, where only three screens would get it', () => {
    // The duplicate IS the defect. Four component stylesheets — admin, browse, sources, watchlist
    // — each write a 44px floor of their own, and this sheet was briefly the fifth; the two that
    // never got round to it are why a thumb still met 35px fields on /applications.
    expect(css).not.toMatch(/--tap-min/);
  });

  it('keys the touch floor on the pointer and the spacing on the width', () => {
    // 44px is a fact about a fingertip and does not change with the window; how much room the card
    // has is a fact about the window and does not change with the pointer. Swapping the two
    // conditions is the mistake base.css's own comment warns about. Both sides are asserted
    // non-empty because `every` over an empty list is true — a deleted floor would have passed
    // this test in the version of it that only counted rules in this sheet.
    expect(floorRules.every((rule) => rule.conditions.every((c) => !/max-width/.test(c)))).toBe(true);
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow.every((rule) => rule.conditions.every((c) => !/pointer/.test(c)))).toBe(true);
  });
});

describe('nothing in this stylesheet names a token that does not exist', () => {
  /**
   * The `--ink-2` defect, as a rule. `var(--nope)` with no fallback makes the whole declaration
   * invalid at computed-value time, and the property falls back to its inherited or initial value
   * with no warning anywhere: the hints asked to be muted for as long as that line existed and
   * were rendered in full-strength body ink the whole time.
   */
  const declared = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  it('resolves every var() in signedOut.css against tokens.css', () => {
    const unknown = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)]
      .map((m) => m[1] ?? '')
      .filter((name) => !declared.has(name));
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('resolves every var() the three signed-out routes still write, too', () => {
    // `var(--mono, monospace)` lived in two of them. Its fallback hid it: the token and code fields
    // rendered in the browser's generic monospace rather than in `--font-data`, which is a
    // DIFFERENT font from the one the rest of this app's data is set in.
    const unknown = ['Login.tsx', 'FirstRun.tsx', 'Enroll.tsx'].flatMap((file) =>
      [...readFileSync(path.join(ROUTES, file), 'utf8').matchAll(/var\(\s*(--[a-z0-9-]+)/g)]
        .map((m) => `${file}: ${m[1] ?? ''}`)
        .filter((entry) => !declared.has(entry.split(': ')[1] ?? '')),
    );
    expect(unknown).toEqual([]);
  });
});

describe('the three routes use the stylesheet rather than inline styles', () => {
  const sources = ['Login.tsx', 'FirstRun.tsx', 'Enroll.tsx'].map((file) => ({
    file,
    text: readFileSync(path.join(ROUTES, file), 'utf8'),
  }));

  it('has no `style` attribute left in any of them', () => {
    // The three screens carried 31 between them. One more is one a media query cannot reach.
    const inline = sources.filter((source) => /\sstyle=\{/.test(source.text)).map((s) => s.file);
    expect(inline).toEqual([]);
  });

  it('imports the stylesheet in every file that writes its class names', () => {
    // A shared control whose styles live in one caller's file renders unstyled in the other; the
    // same is true of a shared stylesheet that only one of three routes imports.
    for (const source of sources) {
      expect(source.text, `${source.file} writes signed-out-* classes`).toMatch(/signed-out-/);
      expect(source.text, `${source.file} does not import signedOut.css`).toMatch(
        /import '\.\.\/components\/signedOut\.css'/,
      );
    }
  });

  it('puts every hint in a field, and gives every field-carrying screen the prose measure', () => {
    for (const source of sources) {
      const hints = source.text.match(/className="signed-out-hint"/g)?.length ?? 0;
      const fields = source.text.match(/className="signed-out-field"/g)?.length ?? 0;
      expect(hints).toBeLessThanOrEqual(fields);
      // A screen with explanations on it is a screen whose width is set by the explanations.
      if (hints > 0) expect(source.text).toMatch(/measure="prose"/);
    }
  });

  it('leaves the sign-in box on the compact measure', () => {
    // The default, and the one screen that keeps it: two fields and no prose to measure.
    const login = sources.find((s) => s.file === 'Login.tsx')?.text ?? '';
    expect(login).not.toMatch(/measure="prose"/);
    expect(login).toMatch(/measure = 'compact'/);
  });
});
