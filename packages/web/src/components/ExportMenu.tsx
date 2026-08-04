import type { UiFilters } from '../lib/filterState.js';
import { browseFiltersToExportQuery, exportHref } from '../api/exports.js';
import './exports.css';

/** Sits above the browse table: the same rows the user is looking at, as a file. */
export function ExportMenu({ filters }: { filters: UiFilters }): JSX.Element {
  const query = browseFiltersToExportQuery(filters);
  return (
    <div className="export-menu no-print">
      <span className="eyebrow">Export this view</span>
      <div className="export-links">
        <a className="btn" download href={exportHref('/api/exports/opportunities.csv', query)}>CSV</a>
        <a className="btn" download href={exportHref('/api/exports/opportunities.xlsx', query)}>XLSX</a>
        <a className="btn" download href={exportHref('/api/exports/deadlines.ics', query)}>Deadlines (.ics)</a>
      </div>
      <p className="export-note">
        Exports exactly what the filters above are showing, with the funder name, the next close
        date and each record&rsquo;s last-verified provenance. The XLSX carries a second
        Provenance sheet so the source URL travels with the file. The calendar file marks every
        projected date as projected — only 4 of 243 cycles in this corpus are dates a funder has
        actually published.
      </p>
    </div>
  );
}
