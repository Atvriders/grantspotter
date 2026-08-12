/**
 * Print stylesheet for server-rendered standalone reports (eligibility report,
 * opportunity brief). The SPA has its own copy at packages/web/src/styles/print.css;
 * the two are deliberately separate files because a TS module cannot be imported
 * by Vite's CSS pipeline.
 *
 * This is what "print to PDF" means in this product. There is no headless Chromium in the image
 * (Global Constraints): bundling one costs ~400 MB and its arm64 build is a recurring QEMU
 * failure, while a print stylesheet costs 200 lines, needs no process, and produces a better
 * page. The reader presses Cmd/Ctrl-P.
 */
export const PRINT_CSS = `
:root { --ink: #16191d; --muted: #5b636e; --rule: #d8dce2; --accent: #1d4ed8; --warn: #b45309; --bad: #b00020; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.5rem 4rem; color: var(--ink); background: #fff;
  font: 15px/1.55 "Iowan Old Style", "Charter", Georgia, "Times New Roman", serif; }
header.report-head { border-bottom: 2px solid var(--ink); padding-bottom: .75rem; margin-bottom: 1.25rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
.subtitle, .provenance { color: var(--muted); font-size: .85rem; margin: 0; }
.counts { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0 1.5rem; padding: 0; list-style: none; }
.counts li { border: 1px solid var(--rule); border-radius: 6px; padding: .5rem .75rem; min-width: 7.5rem; }
.counts .n { display: block; font-size: 1.4rem; font-weight: 700; }
.counts .k { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; }
table { width: 100%; border-collapse: collapse; font-size: .82rem; }
th, td { text-align: left; vertical-align: top; padding: .4rem .5rem; border-bottom: 1px solid var(--rule); }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
td.reason { color: var(--bad); }
td.missing { color: var(--warn); }
.axis { display: inline-block; font-size: .68rem; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); border: 1px solid var(--rule); border-radius: 4px; padding: 0 .3rem; margin-right: .35rem; }
.rawtext { color: var(--ink); }
/* Text this software composed, never a funder's. Visually unlike .rawtext on purpose: the reader
   is being told, in the same cell, that one line is a quotation and the other is not. */
.authored-by { display: inline-block; font-size: .68rem; text-transform: uppercase; letter-spacing: .06em;
  color: var(--warn); border: 1px dashed var(--warn); border-radius: 4px; padding: 0 .3rem; margin-right: .35rem; }
.authored { color: var(--muted); font-style: italic; }
.verdict { font-weight: 700; white-space: nowrap; }
.verdict-eligible { color: #15803d; }
.verdict-eligible_preferred { color: var(--accent); }
.verdict-unknown { color: var(--warn); }
.verdict-ineligible { color: var(--bad); }
.stale { color: var(--warn); font-weight: 700; }
.projected { color: var(--warn); }
.no-link { color: var(--bad); word-break: break-all; }
button.print-button { font: inherit; padding: .5rem .9rem; border: 1px solid var(--ink); border-radius: 6px;
  background: var(--ink); color: #fff; cursor: pointer; }
footer.report-foot { margin-top: 2rem; padding-top: .75rem; border-top: 1px solid var(--rule);
  color: var(--muted); font-size: .78rem; }
@media print {
  @page { size: letter; margin: 14mm 12mm 16mm; }
  body { padding: 0; font-size: 10.5pt; }
  .no-print { display: none !important; }
  thead { display: table-header-group; }
  tr, .avoid-break { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 8.5pt; color: #333; word-break: break-all; }
  .counts li { border-color: #999; }
}
`;
