/**
 * The standalone, printable eligibility report.
 *
 * SERVER-RENDERED AND SELF-CONTAINED: it inlines {@link PRINT_CSS}, references no SPA route and
 * loads nothing. That is what makes "save as PDF" work with no headless browser in the image — the
 * reader presses Cmd/Ctrl-P against a designed `@media print` stylesheet.
 *
 * The copy in this file is load-bearing and was written against three rules this project has paid
 * for elsewhere:
 *
 *   1. An `unknown` verdict is WAITING ON a field. It does not "become an answer" when that field
 *      is filled: the matcher stops at the first axis it cannot decide, so answering one commonly
 *      moves the verdict from one unknown to a DIFFERENT unknown. `UnknownFields.tsx` and
 *      `VerdictBadge.tsx` hold this line on screen, with tests forbidding the stronger wording; a
 *      printed page a student carries to a funder must not undo it.
 *   2. A geography exclusion is NOT a gap in the reader's profile. 36 of the 74 exclusions a
 *      licensed EE undergraduate gets are geographic, and every one of them is correct — this
 *      catalogue really is full of ARRL-Division, Section and state-restricted awards. Presenting a
 *      correct exclusion as something the reader could fix would be the report lying in their
 *      favour.
 *   3. Silence is not a denial. An obligation the funder never addressed prints as `unstated`.
 */
import { BLOCKED_HOSTS, normalizeHost } from '../fetcher/blocklist.js';
import type { EligibilityRow, EligibilityReport } from './eligibility.js';
import { PRINT_CSS } from './printCss.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function stale(lastVerifiedAt: string, nowISO: string): boolean {
  const then = Date.parse(lastVerifiedAt);
  const now = Date.parse(nowISO);
  if (Number.isNaN(then) || Number.isNaN(now)) return false;
  return now - then > NINETY_DAYS_MS;
}

/**
 * Why this address must not become an anchor, or `null` if it may.
 *
 * FAILS CLOSED, and it is not decorative. `farweb.org` — the Foundation for Amateur Radio — was
 * taken over and now 301s to a gambling site, while ARRL, QCWA and club pages still tell
 * applicants to "apply at the FAR website"; the corpus carries a Tier-D record whose whole job is
 * to INTERCEPT that instruction, so printing its apply URL as a live link would defeat it. The
 * scheme check is an ALLOWLIST for the reason `packages/web/src/lib/safety.ts` documents:
 * `new URL('javascript:alert(1)')` parses cleanly with an empty hostname, so a host-only check
 * answers "not blocked" about it.
 *
 * `BLOCKED_HOSTS` is imported from the fetcher rather than restated, so this page and the crawler
 * cannot disagree about which domains are unsafe.
 */
function linkRefusal(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'this address cannot be read';
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return `an unsupported "${scheme}:" address`;
  const host = normalizeHost(url);
  const blocked = BLOCKED_HOSTS.find((b) => host === b || host.endsWith(`.${b}`));
  return blocked === null || blocked === undefined ? null : `${blocked} is not safe to visit`;
}

function link(url: string): string {
  if (url === '') return '';
  const refusal = linkRefusal(url);
  if (refusal !== null) {
    return `<span class="no-link">${escapeHtml(url)} — do not visit: ${escapeHtml(refusal)}</span>`;
  }
  return `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
}

/**
 * Each reason, tagged with the axis it was read as. Both halves matter: the axis is what the
 * product decided, the text is the evidence, and a reader who disagrees with the first can check
 * it against the second.
 *
 * A REASON GRANTSPOTTER WROTE IS NOT SET IN THE SAME TYPE AS ONE A FUNDER WROTE. The column is
 * headed with the funder's words, and 144 of a collegiate club's 145 ineligible rows used to fill
 * it with sentences this software composed — 125 of them reproducing enum identifiers. So an
 * authored line carries a `GrantSpotter, not the funder` tag and the `.authored` class, and
 * `.rawtext` — the class the reader has learned means "verbatim" — is reserved for text a funder
 * published.
 *
 * Reads `row.reasonDetails`, not the flat strings: the old code split `reasons` on ` | ` and
 * paired it by index with a DEDUPED axis list, which mislabels as soon as one program is barred by
 * three constraints across two axes.
 */
function reasonCell(row: EligibilityRow): string {
  return row.reasonDetails
    .map((detail) => {
      const tag =
        detail.axis === '' ? '' : `<span class="axis">${escapeHtml(detail.axis)}</span>`;
      // The OTHER routes the funder named for this same rule. It sits OUTSIDE `.rawtext` — the
      // class a reader of this report has learned means "verbatim" — and carries its own
      // attribution in the words, because a printed page has no hover and no link back to a legend.
      const alt =
        detail.alsoAccepts.length === 0
          ? ''
          : `<span class="alt-route">GrantSpotter also treats this as satisfied by ${escapeHtml(
              detail.alsoAccepts.join('; or '),
            )} — the funder named more than one route.</span>`;
      if (detail.quoted !== '') {
        return `${tag}<span class="rawtext">${escapeHtml(detail.quoted)}</span>${alt}`;
      }
      return (
        `${tag}<span class="authored-by">GrantSpotter, not the funder</span>` +
        `<span class="authored">${escapeHtml(detail.authored)}</span>${alt}`
      );
    })
    .join('<br>');
}

/**
 * The "Waiting on" column: the fields an `unknown` is waiting on, AND — where the record names one
 * — the route this schema cannot check.
 *
 * The two are stacked in one column rather than given a seventh, because they are the same
 * question ("why is this not an answer yet?") and a printed table has a finite width. They are
 * visually distinct and the second says whose statement it is, so neither can be read as the other.
 */
function waitingCell(row: EligibilityRow): string {
  const fields = row.missingFields === '' ? '' : escapeHtml(row.missingFields);
  if (row.uncheckableRoutes === '') return fields;
  const routes = `<span class="alt-route">${escapeHtml(row.uncheckableRoutes)}</span>`;
  return fields === '' ? routes : `${fields}<br>${routes}`;
}

function deadlineCell(row: EligibilityRow): string {
  if (row.nextCloses === '') return '';
  const projected = /^projected/.test(row.deadlineBasis)
    ? `<br><span class="projected">${escapeHtml(row.deadlineBasis)}</span>`
    : '';
  return `${escapeHtml(row.nextCloses)}${projected}`;
}

export function renderEligibilityReportHtml(report: EligibilityReport): string {
  const rows = report.rows
    .map((r) => {
      const verified = stale(r.lastVerifiedAt, report.generatedAt)
        ? `<span class="stale">${escapeHtml(r.lastVerifiedAt)} — unverified</span>`
        : escapeHtml(r.lastVerifiedAt);
      const rank = r.rank === '' ? '' : ` (rank ${escapeHtml(r.rank)})`;
      return `      <tr>
        <td class="verdict verdict-${escapeHtml(r.verdict)}">${escapeHtml(r.verdict.replace('_', ' '))}${rank}</td>
        <td>${escapeHtml(r.programName)}<br><span class="subtitle">${escapeHtml(r.funderName)}</span></td>
        <td>${escapeHtml(r.amountRaw)}<br><span class="subtitle">cost share: ${escapeHtml(r.costShare)}</span></td>
        <td>${deadlineCell(r)}</td>
        <td class="reason">${reasonCell(r)}</td>
        <td class="missing">${waitingCell(r)}</td>
        <td>${link(r.applyUrl === '' ? r.sourceUrl : r.applyUrl)}<br><span class="subtitle">${verified}</span></td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GrantSpotter eligibility report</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<header class="report-head">
  <h1>Eligibility report</h1>
  <p class="subtitle">Matched against your ${escapeHtml(report.profileKind)} profile.</p>
  <p class="provenance">Generated ${escapeHtml(report.generatedAt)} by GrantSpotter. Every verdict below is computed from the constraint text quoted with it; nothing here is an assurance from the funder.</p>
</header>
<p class="no-print"><button class="print-button" type="button" onclick="window.print()">Print / Save as PDF</button></p>
<ul class="counts">
  <li><span class="n">${report.counts.eligible}</span><span class="k">Eligible</span></li>
  <li><span class="n">${report.counts.eligible_preferred}</span><span class="k">Eligible, preferred</span></li>
  <li><span class="n">${report.counts.unknown}</span><span class="k">Waiting on your profile</span></li>
  <li><span class="n">${report.counts.ineligible}</span><span class="k">Ineligible</span></li>
</ul>
<table>
  <thead>
    <tr><th>Verdict</th><th>Program</th><th>Award</th><th>Next close</th><th>Why not &mdash; the funder&#39;s words where the record holds them</th><th>Waiting on</th><th>Where / last verified</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
<footer class="report-foot">
  <p>An <em>unknown</em> verdict is not a rejection. One thing the funder&#39;s rule depends on is not in your profile yet, so the verdict is <strong>waiting on</strong> it. Each program stops at the first thing it cannot work out about you, so answering one field may simply reveal the next question rather than a final verdict.</p>
  <p>A <em>preferred</em> verdict means a soft preference matched. Soft preferences rank applicants; they never exclude them.</p>
  <p>An <em>ineligible</em> verdict quotes the funder&#39;s own sentence wherever the record holds one. Many of these are geographic, and a geographic exclusion <strong>is not a gap in your profile</strong>: a large part of this catalogue is genuinely restricted by ARRL Division, ARRL Section or state of residence, and no answer you can give changes one.</p>
  <p>A line beginning <em>GrantSpotter also treats this as satisfied by&hellip;</em> means the funder named <strong>more than one route</strong> to the same requirement &mdash; a county <em>or</em> a whole state, a licence class <em>or</em> a higher one &mdash; and this software applied all of them. It is written out because the structured reading beside it can only hold the first route the funder named, and on its own it states a narrower rule than the one that was actually used.</p>
  <p>A line beginning <em>GrantSpotter cannot check a route this funder named&hellip;</em> is the opposite case: the funder described a way of qualifying that nothing in this software&#39;s schema can describe, let alone test &mdash; &ldquo;and to previous awardees&rdquo;, or a whole subject domain that no word-matching can adjudicate. Where that happens the verdict stops at <em>unknown</em> instead of ruling you out. It is not a gap in the funder&#39;s page and not a gap in your profile; read their own sentence in the record and judge the fit yourself.</p>
  <p>A line marked <span class="authored-by">GrantSpotter, not the funder</span> is <strong>not a quotation</strong>. No funder sentence was recorded for it; what you are reading is this software&#39;s own statement about what the record does and does not say. Read the funder&#39;s page before you act on one.</p>
  <p>Where a cost share or co-funder obligation reads <code>unstated</code>, no page this pipeline read addressed the question. That is silence from the funder, never a funder&#39;s denial &mdash; ask them.</p>
  <p>A deadline marked as projected was computed from a recurrence rule, not published by the funder. Almost every date in this catalogue is of that kind.</p>
  <p>GrantSpotter is a curated database with a change-detection layer, not a live feed from these funders. Confirm every deadline against the source URL before you rely on it.</p>
</footer>
</body>
</html>
`;
}
