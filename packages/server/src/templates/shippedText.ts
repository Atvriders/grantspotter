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
 *   1. A LINE CARRYING A SLOT IS A LINE WITH A HOLE IN IT, and both halves are described. Excluding
 *      the whole line was the first answer here, on the reasoning that `{{club.callsign}}` becomes
 *      a VALUE — "W8UM", or a `[TODO: …]` marker — and a value is what the checklist is for. True
 *      of the value, false of the words around it, and the words around it are most of the line:
 *      `| Indirect at {{project.indirectPct}}% | | | | | |` came back as an assertion the applicant
 *      had to confirm — the word "Indirect", out of the product's own budget skeleton — and so did
 *      the row numbers of the timeline table, whose rows carry slots too. Worse, dropping those
 *      lines broke the RUN around them, so verbatim shipped lines with no slot in them at all
 *      (`- [ ] Antenna, feedline and duplexer priced in the same budget as the repeater`) were left
 *      stranded below the three-line threshold and demanded as well. So the line goes into
 *      `patterns` instead, split at each slot: the literal runs are the product's, the gaps are the
 *      applicant's, and only the gaps reach the checklist.
 *   2. MATCHING IS VERBATIM AND WHOLE-LINE, up to those holes. Edit a shipped sentence and the line
 *      stops matching, so its facts come back onto the checklist as the applicant's own words —
 *      which is what they have become. That is the property that keeps this from blinding the panel.
 *
 * It reads the library once per root and caches, because it is called on every readiness check and
 * `loadTemplates` walks the content directory and parses every file.
 */
import type { ShippedTemplateText } from '../prose/facts.js';
import { type TemplateDoc, loadTemplates } from './load.js';

/**
 * `templates/fill.ts`'s slot syntax, loosely: any `{{ … }}` at all makes the line a pattern rather
 * than a literal. A factory, not a shared constant — a `/g` regex carries `lastIndex` between
 * callers, and `String.prototype.split` is the only consumer that would not notice.
 */
const slotOnLine = (): RegExp => /\{\{[^}]*\}\}/g;

export function shippedTextOf(templates: readonly TemplateDoc[]): ShippedTemplateText[] {
  return templates.map((t) => {
    const body = t.body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    return {
      id: t.id,
      title: t.title,
      lines: body.filter((line) => !slotOnLine().test(line)),
      // `split` on a pattern with no capture group yields exactly the literal runs, `n + 1` of them
      // for `n` slots, empty where a slot opens or closes the line.
      patterns: body
        .filter((line) => slotOnLine().test(line))
        .map((line) => ({ literals: line.split(slotOnLine()) })),
    };
  });
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
