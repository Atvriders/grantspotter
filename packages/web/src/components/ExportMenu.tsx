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
      {/*
        NO COUNT IN THIS SENTENCE, DELIBERATELY.

        It used to end "only 4 of 243 cycles in this corpus are dates a funder has actually
        published". Three different totals for that one claim were live in the tree at once (243,
        244, and 252 on the corpus that actually ships), and none of them can be kept true here,
        because the figure moves with the WALL CLOCK rather than with an edit: measured over
        `data/seed/` through this calendar's own two-year window, 2026-08-04 gives 252 cycles with
        2 funder-published, 2026-10-01 gives 250 with 1, and 2027-02-01 gives 248 with 0 — the
        three seed records that declare a funder-published window simply age out.

        This component is handed `filters` and nothing else, so there is no honest number to derive
        in place of the wrong one either. What IS verifiable, and is what the sentence now claims,
        is the per-event labelling: `exports/ics.ts` marks every projected event four ways and
        `Calendar` prints the funder-published/projected split it counted from the rows it holds.
        `test/cycleCountCopy.test.ts` fails if a literal count comes back to this file.
      */}
      <p className="export-note">
        Exports exactly what the filters above are showing, with the funder name, the next close
        date and each record&rsquo;s last-verified provenance. The XLSX carries a second
        Provenance sheet so the source URL travels with the file. Every date in the calendar file
        says which of the two kinds it is — a window the funder published, or one GrantSpotter
        projected from the recurrence that program has followed — so no projection leaves here
        looking like a date somebody promised you.
      </p>
    </div>
  );
}
