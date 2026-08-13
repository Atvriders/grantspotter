/**
 * THE PRODUCT'S OWN WORDS, IN THE SHAPE `prose/facts.ts` CAN RECOGNISE THEM.
 *
 * The fact checklist exists to stop an applicant signing a figure nobody checked. Pressing
 * GrantSpotter's own one-click "Insert ARDC Grants Program — funder overlay" then produced a draft
 * containing nothing but GrantSpotter's shipped, source-cited overlay and a checklist demanding
 * 120 confirmations, every row labelled "not attributed to any stated value — this is prose you or
 * a model wrote". The product was accusing its own cited material of being unsourced, and the
 * applicant's own assertions — the ones the panel is for — had nowhere to be seen among them.
 *
 * `prose/` is import-sealed (`features.test.ts` walks the directory and fails on any import that
 * is not `./…`), so it cannot read the template library itself. This module is the seam: it turns
 * the shipped templates into the line-lists `buildFactChecklist` matches against, and lives here,
 * beside the loader whose output it describes.
 *
 * TWO RULES DECIDE WHAT GOES IN A LINE LIST.
 *
 *   1. LINES CARRYING A SLOT ARE EXCLUDED. `{{club.callsign}}` is replaced by a VALUE on its way
 *      into the document — "W8UM", or a `[TODO: …]` marker — and a value is exactly what the
 *      checklist is for. Excluding the line means the filled line is matched by nothing, so
 *      everything in it stays on the list and is attributed by the slot machinery as before.
 *   2. MATCHING IS VERBATIM AND WHOLE-LINE. Edit a shipped sentence and the line stops matching,
 *      so its facts come back onto the checklist as the applicant's own words — which is what they
 *      have become. That is the property that keeps this from blinding the panel.
 *
 * It reads the library once per root and caches, because it is called on every readiness check and
 * `loadTemplates` walks the content directory and parses every file.
 */
import type { ShippedTemplateText } from '../prose/facts.js';
import { type TemplateDoc, loadTemplates } from './load.js';

/** `templates/fill.ts`'s slot syntax, loosely: any `{{ … }}` at all disqualifies the line. */
const SLOT_ON_LINE = /\{\{[^}]*\}\}/;

export function shippedTextOf(templates: readonly TemplateDoc[]): ShippedTemplateText[] {
  return templates.map((t) => ({
    id: t.id,
    title: t.title,
    lines: t.body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !SLOT_ON_LINE.test(line)),
  }));
}

const cache = new Map<string, ShippedTemplateText[]>();

/**
 * Every shipped template, as text. Cached per root — the library is read off disk and does not
 * change while the process runs; `shippedTextOf` is exported so a test can build the same thing
 * from templates it loaded itself.
 */
export function shippedTemplateText(root?: string): ShippedTemplateText[] {
  const key = root ?? '';
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const built = shippedTextOf(loadTemplates(root));
  cache.set(key, built);
  return built;
}
