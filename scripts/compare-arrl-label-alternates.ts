/**
 * Diagnostic tool for arrl-scholarship-descriptions, not run by CI or any test.
 *
 * Compares the PRODUCTION label table (ARRL_SCHOLARSHIP_LABELS, every alternate colon-required)
 * against a synthetic "naive" table with the trailing colon stripped from every alternate — i.e.
 * the shape the table had before fix rounds 1-2 closed the bare-word sentence-opener exploit
 * ("Region-specific rules...", "Amount awarded may vary...", etc.) — field by field, across
 * every real entry on a captured ARRL scholarship-descriptions page. Any difference is either:
 *
 *   - a value the naive parser corrupts that the production parser gets right (expected, and the
 *     whole reason the colon requirement exists), or
 *   - a genuinely new label variant the production table doesn't yet recognise (the "Regional
 *     Preference:" case) — worth a look, since it means a real field is going unrecovered.
 *
 * This is the script version of the "one pass across all 111 live entries, old vs new parse per
 * field" comparison performed by hand during fix round 2-3 review. Re-run it whenever ARRL
 * changes the page, or after editing ARRL_SCHOLARSHIP_LABELS, to see the diff instead of having
 * to reconstruct it from scratch:
 *
 *   npx tsx scripts/compare-arrl-label-alternates.ts [path/to/page.html]
 *
 * Defaults to the committed live fixture. Never touches the network.
 */
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARRL_SCHOLARSHIP_LABELS,
  findAlternatePrefixCollisions,
} from '../packages/server/src/sources/arrl-scholarship-descriptions.js';
import { flattenHtml, splitByLabels } from '../packages/server/src/sources/util/text.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE = path.join(
  REPO_ROOT,
  'fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html',
);
const APPLICATION_LINK_PATTERN = /scholarship-application/i;

/** Strip the trailing colon fix rounds 1-2 added to every alternate, reproducing the pre-fix table. */
function naiveColonOptionalLabels(labels: Record<string, string[]>): Record<string, string[]> {
  const naive: Record<string, string[]> = {};
  for (const [key, alternates] of Object.entries(labels)) {
    naive[key] = alternates.map((a) => a.replace(/:$/, ''));
  }
  return naive;
}

function main(): void {
  const fixturePath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FIXTURE;
  console.log(`Comparing against: ${path.relative(REPO_ROOT, fixturePath)}\n`);

  const collisions = findAlternatePrefixCollisions(ARRL_SCHOLARSHIP_LABELS);
  if (collisions.length > 0) {
    console.log('PREFIX-COLLISION INVARIANT VIOLATED in the production table itself:');
    for (const c of collisions) console.log(`  "${c.shorter}" is a prefix of "${c.longer}"`);
    console.log('');
  } else {
    console.log('Prefix-collision invariant: OK (no alternate is a prefix of another).\n');
  }

  const naiveLabels = naiveColonOptionalLabels(ARRL_SCHOLARSHIP_LABELS);
  const html = readFileSync(fixturePath, 'utf8');
  const $ = cheerio.load(html);

  let compared = 0;
  let entriesWithDiff = 0;
  let fieldDiffs = 0;

  $('div.tabArea.f-widget.f-accordion').each((_, accordion) => {
    const $accordion = $(accordion);
    const heading = $accordion.find('h3.tab').first().text().trim();
    if (/explore\s*arrl/i.test(heading)) return;

    $accordion.find('ul.accordion > li').each((__, li) => {
      const $li = $(li);
      const name = $li.find('p.title').first().text().replace(/\s+/g, ' ').trim();
      const $content = $li.find('div.content').first();
      $content.find('a').each((___, a) => {
        const href = $(a).attr('href') ?? '';
        if (APPLICATION_LINK_PATTERN.test(href)) $(a).remove();
      });
      const rawText = flattenHtml($content.html() ?? '');
      if (rawText.trim() === '') return;
      compared += 1;

      const prod = splitByLabels(rawText, ARRL_SCHOLARSHIP_LABELS);
      const naive = splitByLabels(rawText, naiveLabels);
      const keys = new Set([...Object.keys(prod), ...Object.keys(naive)]);
      let printedName = false;

      for (const key of keys) {
        if (key === '__preamble') continue;
        if (prod[key] === naive[key]) continue;
        if (!printedName) {
          console.log(`--- ${name || '(untitled)'} ---`);
          printedName = true;
          entriesWithDiff += 1;
        }
        fieldDiffs += 1;
        console.log(`  ${key}:`);
        console.log(`    production (colon-required): ${JSON.stringify(prod[key])}`);
        console.log(`    naive (colon-optional):      ${JSON.stringify(naive[key])}`);
      }
    });
  });

  console.log(
    `\n${compared} entries compared, ${entriesWithDiff} with at least one field difference, ` +
      `${fieldDiffs} field differences total.`,
  );
}

main();
