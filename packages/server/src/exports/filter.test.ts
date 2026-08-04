import { describe, expect, it } from 'vitest';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import { applyExportFilter, exportablePrograms, parseExportFilter } from './filter.js';
import { makeCycle, makeProgram, makeSuppressedProgram } from './testFixtures.js';

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
const scholarship = makeProgram({
  id: 'arrl-cat-example',
  name: 'Example Memorial Scholarship',
  klass: 'ham_scholarship',
  applicantEntities: ['individual'],
  tags: ['ham', 'scholarship'],
});

describe('applyExportFilter', () => {
  const all = [ardc, arrl, scholarship];
  const cycles = new Map([['ardc-grants', [makeCycle()]]]);

  it('returns everything for an empty filter', () => {
    expect(applyExportFilter(all, {}, cycles)).toHaveLength(3);
  });

  it('matches q case-insensitively across name, summary and tags', () => {
    expect(applyExportFilter(all, { q: 'CLUB' }, cycles).map((p) => p.id)).toEqual([
      'arrl-club-grant',
    ]);
  });

  it('filters by class', () => {
    expect(applyExportFilter(all, { klass: ['ham_scholarship'] }, cycles).map((p) => p.id)).toEqual([
      'arrl-cat-example',
    ]);
  });

  it('filters by status', () => {
    expect(applyExportFilter(all, { status: ['unknown'] }, cycles).map((p) => p.id)).toEqual([
      'arrl-club-grant',
    ]);
  });

  it('filters by applicant entity with OR semantics inside the axis', () => {
    expect(
      applyExportFilter(all, { applicantEntities: ['individual', 'club_501c3'] }, cycles).map(
        (p) => p.id,
      ),
    ).toEqual(['arrl-club-grant', 'arrl-cat-example']);
  });

  it('ANDs across axes', () => {
    expect(
      applyExportFilter(all, { klass: ['ham_grant'], status: ['unknown'] }, cycles).map((p) => p.id),
    ).toEqual(['arrl-club-grant']);
  });

  it('drops programs with no cycle in the requested date window', () => {
    const out = applyExportFilter(all, { closesBefore: '2027-03-01' }, cycles);
    expect(out.map((p) => p.id)).toEqual(['ardc-grants']);
  });
});

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

describe('applyExportFilter enforces the gate before the user filter', () => {
  const suppressed = makeSuppressedProgram();
  const all = [ardc, suppressed, arrl];
  const cycles = new Map([['ardc-grants', [makeCycle()]]]);

  it('drops the suppressed record for an empty filter', () => {
    expect(applyExportFilter(all, {}, cycles).map((p) => p.id)).toEqual([
      'ardc-grants',
      'arrl-club-grant',
    ]);
  });

  it('cannot be talked into returning it by a free-text search that matches only it', () => {
    expect(applyExportFilter(all, { q: 'ardc-2019-award-11225' }, cycles)).toEqual([]);
  });

  it('cannot be talked into returning it by asking for its suppression tag', () => {
    expect(applyExportFilter(all, { tags: [DO_NOT_PUBLISH_TAG] }, cycles)).toEqual([]);
    expect(applyExportFilter(all, { tags: ['past_award'] }, cycles)).toEqual([]);
  });
});

describe('parseExportFilter', () => {
  it('splits repeated comma-separated query params and ignores unknown keys', () => {
    const f = parseExportFilter({ q: 'ardc', klass: 'ham_grant,ham_scholarship', bogus: 'x' });
    expect(f).toEqual({ q: 'ardc', klass: ['ham_grant', 'ham_scholarship'] });
  });

  it('accepts array-valued params from express', () => {
    expect(parseExportFilter({ tags: ['ham', 'club'] })).toEqual({ tags: ['ham', 'club'] });
  });

  it('drops values that are not valid enum members', () => {
    expect(parseExportFilter({ klass: 'ham_grant,not_a_class' })).toEqual({ klass: ['ham_grant'] });
  });

  it('produces no key at all when every value on an axis is rejected', () => {
    expect(parseExportFilter({ status: 'nonsense', klass: '' })).toEqual({});
  });
});
