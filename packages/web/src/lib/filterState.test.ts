import { describe, it, expect } from 'vitest';
import {
  EMPTY_FILTERS,
  filtersToSearchParams,
  searchParamsToFilters,
  type UiFilters,
} from './filterState.js';

describe('filter URL round-trip', () => {
  it('omits empty values so a clean browse has a clean URL', () => {
    expect(filtersToSearchParams(EMPTY_FILTERS).toString()).toBe('');
  });

  it('serializes multi-values as comma-separated', () => {
    const params = filtersToSearchParams({
      ...EMPTY_FILTERS,
      klass: ['ham_grant', 'ham_scholarship'],
      verdict: ['ineligible'],
    });
    expect(params.get('klass')).toBe('ham_grant,ham_scholarship');
    expect(params.get('verdict')).toBe('ineligible');
  });

  it('round-trips every field', () => {
    const filters: UiFilters = {
      klass: ['ham_grant'],
      entity: ['university'],
      instrument: ['cash_range'],
      status: ['open'],
      verdict: ['eligible'],
      deadlineFrom: '2026-09-01',
      deadlineTo: '2027-01-31',
      includeRolling: false,
      amountMin: 1000,
      amountMax: 25000,
      q: 'scholarship',
      sort: 'amount_desc',
      page: 3,
    };
    expect(searchParamsToFilters(filtersToSearchParams(filters))).toEqual(filters);
  });

  it('defaults includeRolling to true when the parameter is absent', () => {
    expect(searchParamsToFilters(new URLSearchParams('')).includeRolling).toBe(true);
  });

  it('ignores a non-numeric page rather than throwing', () => {
    expect(searchParamsToFilters(new URLSearchParams('page=banana')).page).toBe(1);
  });

  /**
   * `Number('')` is 0, not NaN. A brief-shaped `Number.isFinite` guard therefore reads an empty
   * `?page=` as page ZERO, which slices `rows.slice(-50, 0)` on the server and shows an empty
   * browse for a URL that says nothing. Same shape for `?amountMin=`: 0 is a real filter value and
   * would silently apply one nobody typed.
   */
  it('reads an empty page parameter as page 1, never page 0', () => {
    expect(searchParamsToFilters(new URLSearchParams('page=')).page).toBe(1);
  });

  it('reads an empty amount parameter as no amount filter, not as zero', () => {
    const filters = searchParamsToFilters(new URLSearchParams('amountMin=&amountMax='));
    expect(filters.amountMin).toBeUndefined();
    expect(filters.amountMax).toBeUndefined();
  });

  it('clamps a zero or negative page to 1', () => {
    expect(searchParamsToFilters(new URLSearchParams('page=0')).page).toBe(1);
    expect(searchParamsToFilters(new URLSearchParams('page=-4')).page).toBe(1);
  });

  it('truncates a fractional page rather than passing 2.5 to the API', () => {
    expect(searchParamsToFilters(new URLSearchParams('page=2.5')).page).toBe(2);
  });

  it('falls back to the default sort for an unknown sort key', () => {
    expect(searchParamsToFilters(new URLSearchParams('sort=cheapest')).sort).toBe('deadline');
  });

  /**
   * The server drops unknown facet values (`programsRouter.multi`), so a URL carrying one gets a
   * result set that silently disagrees with the checkboxes the user can see. Dropping it here too
   * keeps the URL, the panel and the request describing the same query.
   */
  it('drops a facet value that is not an offered option', () => {
    const filters = searchParamsToFilters(new URLSearchParams('klass=ham_grant,not_a_class'));
    expect(filters.klass).toEqual(['ham_grant']);
  });

  it('drops an unknown verdict rather than asking the API to filter on it', () => {
    expect(searchParamsToFilters(new URLSearchParams('verdict=maybe')).verdict).toEqual([]);
  });
});
