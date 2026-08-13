import { describe, expect, it } from 'vitest';
import { exportablePrograms } from './filter.js';
import { makeProgram, makeSuppressedProgram } from './testFixtures.js';

const ardc = makeProgram();
const arrl = makeProgram({
  id: 'arrl-club-grant',
  funderId: 'arrl-foundation',
  name: 'ARRL Club Grant Program',
  klass: 'ham_grant',
  applicantEntities: ['club_501c3'],
  tags: ['ham', 'club'],
  trust: { ...ardc.trust, status: 'unknown', sourceUrl: 'https://www.arrl.org/club-grant-program' },
});

/**
 * WHAT USED TO BE IN THIS FILE, and where it went.
 *
 * `applyExportFilter` and `parseExportFilter` were a second query vocabulary and a second
 * predicate set, private to the export routes and hand-translated from the browse screen's
 * filters. Three filters were never translated and three exports quietly ignored them; the
 * measurements are in `selection.ts`. The selection is the browse screen's own now, so its unit
 * tests are `selection.test.ts` and the equality it exists to hold is measured end to end, on both
 * endpoints, in `parityWithBrowse.test.ts`.
 *
 * The gate stayed here, because it was never a filter.
 */

/**
 * THE SUPPRESSION BOUNDARY, AT THE ONE PLACE IT LEAVES THE BUILDING.
 *
 * It has leaked four times in this repo — the detail route answered 200 for all ~553 hidden
 * records, the corpus profiler counted 742 instead of 197, the completeness meter scored against
 * 703 instead of 150, and the verify route leaked content AND triggered live refetches. Every one
 * had the same shape: a read path with its own filter instead of the shared predicate.
 *
 * An export is a read path, and it is the LEAST recoverable one. A spreadsheet mailed to a
 * colleague cannot be un-sent. So the gate here is not a filter option; it is unconditional, it
 * runs before any user-supplied filter, and there is no argument that turns it off.
 */
describe('exportablePrograms — the gate no export can opt out of', () => {
  const suppressed = makeSuppressedProgram();

  it('drops every do_not_publish record', () => {
    expect(exportablePrograms([ardc, suppressed, arrl]).map((p) => p.id)).toEqual([
      'ardc-grants',
      'arrl-club-grant',
    ]);
  });

  it('keeps a record that merely mentions a suppressed record type in its tags', () => {
    // `past_award` alone is not the gate; `isDoNotPublish` reads the tag, and only the tag.
    const tagged = makeProgram({ id: 'tagged', tags: ['ham', 'past_award'] });
    expect(exportablePrograms([tagged]).map((p) => p.id)).toEqual(['tagged']);
  });

  it('is idempotent, so a format that re-gates a gated list is free to do so', () => {
    const once = exportablePrograms([ardc, suppressed]);
    expect(exportablePrograms(once)).toEqual(once);
  });
});
