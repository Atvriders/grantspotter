import type { Program } from '@grantspotter/core';
// THE SHARED PREDICATE, NEVER A LOCAL COPY. `isDoNotPublish` is the only reader of
// `DO_NOT_PUBLISH_TAG`, so `grep isDoNotPublish` enumerates every place suppression is honoured.
// The four times this boundary leaked in this repo, the leaking read path had written its own.
import { isDoNotPublish } from '../normalize/index.js';

/**
 * THE GATE. Not a filter option — there is no argument that turns it off.
 *
 * ~553 of the 703 records this product stores are EVIDENCE, not opportunities: past ARDC, NSF and
 * USAspending awards, the 37 ARRL clubs already funded, the cross-check rows from a stale summary
 * page. They are kept on purpose (a funder's grant history is the best evidence of who that funder
 * funds) and shown to nobody. 150 are publishable.
 *
 * That boundary has leaked FOUR times here, and every time the leaking read path had written its
 * own filter instead of calling `isDoNotPublish`: the detail route answered 200 for all of them,
 * the corpus profiler measured 742 instead of 197, the completeness meter scored 58 of 703 instead
 * of 58 of 150, and the verify route both leaked content and triggered live refetches.
 *
 * AN EXPORT IS A READ PATH, AND IT IS THE ONE THAT LEAVES THE BUILDING. A CSV mailed to a
 * colleague or opened in a spreadsheet is the least recoverable place a suppressed record could
 * appear. So every export path in this package runs through here — `selectExportPrograms` calls it
 * on what it read back out of the browse projection, and `buildExportRows` calls it again, which
 * is free because it is idempotent and means a format that skips the selection still cannot render
 * one.
 *
 * THIS FILE USED TO HOLD A SECOND FILTER ENGINE as well — `ExportFilter`, `parseExportFilter` and
 * `applyExportFilter`, a private query vocabulary that the browse screen's filters had to be
 * hand-translated into. Three filters in a row were never translated and the exports quietly
 * ignored them; `exports/selection.ts` records the measurements and why the replacement is the
 * browse selection itself rather than a longer version of the predicate list that was here.
 */
export function exportablePrograms(programs: readonly Program[]): Program[] {
  return programs.filter((p) => !isDoNotPublish(p));
}
