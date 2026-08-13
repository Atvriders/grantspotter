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
      {/*
        THE SENTENCE, AND THE THREE WAYS THE FILES USED TO BREAK IT.

        "Exports exactly what the filters above are showing" was measured false on the live site in
        every direction it could be false: the `.ics` ignored the query string outright (Ham grant:
        eight programmes on screen, a calendar covering a hundred and twenty-one), the CSV and XLSX
        had no spelling for the rolling/undated checkbox and so dropped rows the DEFAULT filter
        state was showing, and the award-amount and matcher-verdict filters reached the export
        links as nothing at all — bare URLs, the whole corpus, under a heading that said otherwise.

        The claim is kept rather than softened, because the alternative sentence — "exports the
        whole corpus, ignoring your filters" — describes a product nobody would use to decide where
        to spend an application fee, and because the fix that makes it true (`api/exports.ts` sends
        the browse query itself, `exports/selection.ts` answers it with the browse selection) is
        also the fix that stops the next filter from falling off. What the copy adds is the two
        things that are true and were unsaid: an export is every match rather than the page on
        screen, and a calendar cannot carry a programme that has no date.
      */}
      <p className="export-note">
        Exports exactly what the filters above are showing — every match, not just the page on
        screen — with the funder name, the next close date and each record&rsquo;s last-verified
        provenance. The XLSX carries a second Provenance sheet so the source URL travels with the
        file. A calendar can only carry what has a date, so a matching programme whose deadline is
        rolling or unpublished is in the CSV and the XLSX and in no <code>.ics</code>. Every date
        in the calendar file says which of the two kinds it is — a window the funder published, or
        one GrantSpotter projected from the recurrence that program has followed — so no projection
        leaves here looking like a date somebody promised you.
      </p>
      <p className="export-note">
        A matcher-verdict filter is honoured as well, which means the file is computed against your
        profile and is yours rather than the catalogue&rsquo;s: with no profile saved, filtering by
        verdict exports nothing, the same as it shows nothing here.
      </p>
    </div>
  );
}
