/**
 * A small, honest accessibility audit.
 *
 * It checks the things this SPA can actually get wrong and that a unit test can decide with
 * CERTAINTY from the rendered DOM. It is not a substitute for a manual keyboard pass, it cannot
 * measure contrast (`lib/contrast.test.ts` derives that from the token grammar instead, because
 * jsdom computes no colours), and it does not pretend to be an audit of WCAG. What it is, is a
 * gate: nine routes now render through it in CI, so a control that loses its label or a heading
 * that loses its level turns the suite red instead of shipping.
 *
 * Every check below is one this repository could plausibly regress, and every one of them returns
 * a sentence naming the offending element rather than a boolean — a failing audit has to tell the
 * next person WHAT to fix, or it becomes a wall people delete.
 *
 * DELIBERATELY NOT CHECKED, because a unit test cannot decide them and a guess would be worse
 * than silence: whether an `alt` string is a good description, whether a heading names its
 * section, whether focus order is sensible, whether a live region is announced by any particular
 * screen reader, and whether the words are true. The last one is the product's whole subject and
 * is pinned by ordinary tests in `a11y.test.tsx`, not by this function.
 */

/** IDREF attributes whose target must exist, or the name/description silently evaporates. */
const IDREF_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'] as const;

const FOCUSABLE =
  'a[href], button, input, select, textarea, iframe, [tabindex], [contenteditable="true"]';

/** Inputs that take their accessible name from their own `value`, not from a label. */
const SELF_LABELLING_INPUTS = new Set(['submit', 'button', 'reset', 'image', 'hidden']);

function accessibleName(el: Element): string {
  const text = (el.textContent ?? '').trim();
  return (
    text ||
    (el.getAttribute('aria-label') ?? '').trim() ||
    (el.getAttribute('aria-labelledby') ?? '').trim() ||
    (el.getAttribute('title') ?? '').trim()
  );
}

export function auditA11y(container: HTMLElement): string[] {
  const findings: string[] = [];

  // ---- document structure -------------------------------------------------

  const h1s = container.querySelectorAll('h1');
  if (h1s.length > 1) findings.push('more than one <h1>');
  if (h1s.length === 0) findings.push('no <h1>');

  /**
   * A skipped level is a lie about the shape of the page: a screen reader's heading list is how
   * most users navigate a long record, and an h1 followed by an h3 says a section was omitted.
   */
  let previousLevel = 0;
  for (const heading of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const level = Number(heading.tagName.slice(1));
    if (previousLevel !== 0 && level > previousLevel + 1) {
      findings.push(`heading level jumps from h${String(previousLevel)} to h${String(level)}`);
    }
    previousLevel = level;
  }

  // ---- identity -----------------------------------------------------------

  const seen = new Set<string>();
  for (const el of container.querySelectorAll('[id]')) {
    const id = el.getAttribute('id') ?? '';
    if (id === '') continue;
    if (seen.has(id)) findings.push(`duplicate id: ${id}`);
    seen.add(id);
  }

  /**
   * A dangling IDREF is the quietest accessibility bug there is. `aria-labelledby="gone"` does not
   * fall back to the element's text — the element simply has no name — and the tabs pattern is
   * where it happens, because only the selected panel is usually in the DOM.
   */
  for (const attr of IDREF_ATTRS) {
    for (const el of container.querySelectorAll(`[${attr}]`)) {
      for (const ref of (el.getAttribute(attr) ?? '').split(/\s+/).filter((r) => r !== '')) {
        if (!seen.has(ref)) findings.push(`${attr} points at a missing id: ${ref}`);
      }
    }
  }

  for (const label of container.querySelectorAll<HTMLLabelElement>('label[for]')) {
    const target = label.getAttribute('for') ?? '';
    if (target !== '' && !seen.has(target)) {
      findings.push(`label[for] points at a missing id: ${target}`);
    }
  }

  // ---- naming -------------------------------------------------------------

  for (const control of container.querySelectorAll<HTMLElement>('input, select, textarea')) {
    const type = (control.getAttribute('type') ?? '').toLowerCase();
    if (SELF_LABELLING_INPUTS.has(type)) continue;
    const id = control.getAttribute('id');
    const labelled =
      (id !== null && id !== '' && hasLabelFor(container, id)) ||
      control.getAttribute('aria-label') !== null ||
      control.getAttribute('aria-labelledby') !== null ||
      control.getAttribute('title') !== null ||
      control.closest('label') !== null;
    if (!labelled) findings.push(`unlabelled form control: ${control.tagName.toLowerCase()}`);
  }

  for (const button of container.querySelectorAll<HTMLElement>('button')) {
    if (accessibleName(button) === '') findings.push('button with no accessible name');
  }

  // An `<a>` with no `href` is not a link and is not in the tab order; only real links are named.
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (accessibleName(anchor) === '') findings.push('link with no accessible name');
  }

  for (const img of container.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) findings.push('img with no alt attribute');
  }

  /**
   * `aria-label` on a bare `<span>` or `<div>` is DISCARDED. Both map to the `generic` role, and
   * `generic` does not support naming from the author — so the label is not "extra information a
   * screen reader might read", it is text that reaches nobody while looking in the source exactly
   * like a fix. The badge kit already learned this once (`role="img"` on every verdict and trust
   * badge, for precisely this reason); the rule is enforced here so the next one cannot regress.
   */
  for (const el of container.querySelectorAll<HTMLElement>('span[aria-label], div[aria-label]')) {
    if (el.getAttribute('role') !== null) continue;
    if (el.closest('[aria-hidden="true"]') !== null) continue;
    findings.push(
      `aria-label on a generic <${el.tagName.toLowerCase()}>, which assistive technology ignores`,
    );
  }

  /**
   * A `<th>` with no `scope` is a header cell with no column. Screen readers guess, and the guess
   * is wrong on exactly the tables this product cares about — the ones with a row-name column.
   */
  for (const th of container.querySelectorAll<HTMLElement>('th')) {
    if (th.getAttribute('scope') === null && th.getAttribute('role') === null) {
      findings.push(`th with no scope: ${(th.textContent ?? '').trim()}`);
    }
  }

  // ---- keyboard and exposure ---------------------------------------------

  for (const el of container.querySelectorAll<HTMLElement>('[tabindex]')) {
    if (Number(el.getAttribute('tabindex')) > 0) {
      findings.push(`positive tabindex on: ${el.tagName.toLowerCase()}`);
    }
  }

  /**
   * `aria-hidden` removes a subtree from the accessibility tree but NOT from the tab order, so a
   * focusable descendant becomes a control a keyboard user lands on and a screen reader cannot
   * name. Decoration must contain nothing reachable.
   */
  for (const hidden of container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')) {
    for (const focusable of hidden.querySelectorAll<HTMLElement>(FOCUSABLE)) {
      if (focusable.hasAttribute('disabled')) continue;
      if (focusable.getAttribute('tabindex') === '-1') continue;
      findings.push(`focusable element inside aria-hidden: ${focusable.tagName.toLowerCase()}`);
    }
  }

  for (const anchor of container.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')) {
    const rel = anchor.getAttribute('rel') ?? '';
    if (!rel.includes('noopener')) findings.push('target=_blank without rel=noopener');
  }

  /**
   * `grid` and `treegrid` are COMPOSITE WIDGET roles, not fancier synonyms for `table`. They
   * oblige the author to ship two-dimensional arrow-key navigation over a roving tabindex, and
   * they change how assistive technology presents the thing: a widget the user is expected to
   * enter and drive, rather than a table to read.
   *
   * This check exists because the calendar month view carried `role="grid"` with no such
   * navigation — a promise of a keyboard contract that did not exist. It now renders as a plain
   * table, which is what it is, and this rule keeps the decision from silently reverting.
   */
  for (const grid of container.querySelectorAll<HTMLElement>('[role="grid"], [role="treegrid"]')) {
    if (grid.querySelector('[tabindex]') === null) {
      findings.push(`role="${grid.getAttribute('role') ?? ''}" with no focusable cell`);
    }
  }

  return findings;
}

/**
 * Whether any `<label for>` in the subtree names this id.
 *
 * Not `querySelector(`label[for="${id}"]`)`: an id is author data, and one carrying a quote,
 * a bracket or a colon turns that template into a `SyntaxError` that takes the whole audit down.
 * Comparing attribute values needs no selector at all.
 */
function hasLabelFor(container: HTMLElement, id: string): boolean {
  for (const label of container.querySelectorAll<HTMLLabelElement>('label[for]')) {
    if (label.getAttribute('for') === id) return true;
  }
  return false;
}
