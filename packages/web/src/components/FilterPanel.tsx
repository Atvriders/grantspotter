import {
  EMPTY_FILTERS,
  FACETS,
  SORT_LABELS,
  type BrowseSort,
  type FacetKey,
  type UiFilters,
} from '../lib/filterState.js';
import './browse.css';

export interface FilterPanelProps {
  filters: UiFilters;
  /**
   * `replace` asks the caller to swap the current history entry instead of pushing one. Typing in
   * the search box fires per keystroke, and pushing there turns the browser Back button into a
   * character-by-character undo of a word the user typed on purpose.
   */
  onChange: (next: UiFilters, options?: { replace?: boolean }) => void;
}

/**
 * THE ONLY SEARCH BOX IN THE PRODUCT.
 *
 * The plan's prose also promises a "global search" in the topbar. There is not one, and there
 * should not be: two inputs writing the same `q` parameter is two places for the query to be, and
 * the URL is supposed to be the single source of truth for what the reader is looking at.
 */
export function FilterPanel({ filters, onChange }: FilterPanelProps): JSX.Element {
  /** Every structural change returns to page 1: page 3 of the previous query means nothing. */
  function apply(patch: Partial<UiFilters>, options?: { replace?: boolean }): void {
    onChange({ ...filters, ...patch, page: 1 }, options);
  }

  function toggle(key: FacetKey, value: string): void {
    const current: readonly string[] = filters[key];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    // The cast is confined to this one line. `value` came from the label map for THIS facet, so it
    // is a member of that facet's union by construction; the index signature is what erases it.
    apply({ [key]: next } as unknown as Partial<UiFilters>);
  }

  const blankToUndefined = (raw: string): string | undefined => (raw === '' ? undefined : raw);
  const blankToNoNumber = (raw: string): number | undefined =>
    raw === '' ? undefined : Number(raw);

  const dirty = filtersAreSet(filters);

  return (
    <section className="filter-panel card" aria-label="Filters">
      <div>
        <label htmlFor="filter-q" className="eyebrow">
          Search
        </label>
        <input
          id="filter-q"
          className="filter-field"
          type="search"
          value={filters.q ?? ''}
          placeholder="Name, funder, tag"
          onChange={(e) => apply({ q: blankToUndefined(e.target.value) }, { replace: true })}
        />
      </div>

      <div>
        <label htmlFor="filter-sort" className="eyebrow">
          Sort by
        </label>
        <select
          id="filter-sort"
          className="filter-field"
          value={filters.sort}
          onChange={(e) => apply({ sort: e.target.value as BrowseSort })}
        >
          {Object.entries(SORT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {FACETS.map((facet) => (
        <fieldset key={facet.key}>
          <legend>{facet.legend}</legend>
          {Object.entries(facet.labels).map(([value, label]) => (
            <label key={value} htmlFor={`f-${facet.key}-${value}`}>
              <input
                id={`f-${facet.key}-${value}`}
                type="checkbox"
                checked={(filters[facet.key] as readonly string[]).includes(value)}
                onChange={() => toggle(facet.key, value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
      ))}

      <fieldset>
        <legend>Deadline window</legend>
        <label htmlFor="f-deadline-from">
          From
          <input
            id="f-deadline-from"
            className="filter-field"
            type="date"
            value={filters.deadlineFrom ?? ''}
            onChange={(e) => apply({ deadlineFrom: blankToUndefined(e.target.value) })}
          />
        </label>
        <label htmlFor="f-deadline-to">
          To
          <input
            id="f-deadline-to"
            className="filter-field"
            type="date"
            value={filters.deadlineTo ?? ''}
            onChange={(e) => apply({ deadlineTo: blankToUndefined(e.target.value) })}
          />
        </label>
        <label htmlFor="f-include-rolling">
          <input
            id="f-include-rolling"
            type="checkbox"
            checked={filters.includeRolling}
            onChange={(e) => apply({ includeRolling: e.target.checked })}
          />
          Keep rolling and undated programs
        </label>
      </fieldset>

      <fieldset>
        <legend>Award amount</legend>
        <label htmlFor="f-amount-min">
          Min
          <input
            id="f-amount-min"
            className="filter-field"
            type="number"
            min={0}
            value={filters.amountMin ?? ''}
            onChange={(e) => apply({ amountMin: blankToNoNumber(e.target.value) })}
          />
        </label>
        <label htmlFor="f-amount-max">
          Max
          <input
            id="f-amount-max"
            className="filter-field"
            type="number"
            min={0}
            value={filters.amountMax ?? ''}
            onChange={(e) => apply({ amountMax: blankToNoNumber(e.target.value) })}
          />
        </label>
      </fieldset>

      {dirty && (
        <button type="button" className="btn filter-reset" onClick={() => onChange(EMPTY_FILTERS)}>
          Clear all filters
        </button>
      )}
    </section>
  );
}

/** True when anything but the defaults is set, so the reset control appears only when it does something. */
function filtersAreSet(f: UiFilters): boolean {
  return (
    FACETS.some((facet) => f[facet.key].length > 0) ||
    f.deadlineFrom !== undefined ||
    f.deadlineTo !== undefined ||
    !f.includeRolling ||
    f.amountMin !== undefined ||
    f.amountMax !== undefined ||
    (f.q !== undefined && f.q !== '') ||
    f.sort !== EMPTY_FILTERS.sort
  );
}
