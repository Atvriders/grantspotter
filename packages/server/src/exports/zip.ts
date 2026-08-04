/**
 * THE APPLICATION PACKET — one ZIP a club officer can hand to a treasurer, an advisor and a
 * funder without explaining what any of it is.
 *
 * Six entries: the draft in two formats, a budget worksheet, a requirements checklist, a source
 * list, and a README that says what each one is and what GrantSpotter does NOT vouch for.
 *
 * Three rules run through every file below, and each one exists because breaking it produced a
 * real defect in this repo:
 *
 *   - A CONSTRAINT MARKED `hard: false` RANKS, IT NEVER EXCLUDES. Printed among the requirements,
 *     a preference turns an eligible applicant away, so the two are separated by heading and the
 *     soft heading says so in words.
 *   - AN UNSTATED OBLIGATION IS NOT A "NO". `costShareRequired` is unstated on 148 of the 150
 *     publishable programmes and `false` on ZERO; a worksheet that answered the matching-funds
 *     question with silence or with "no match required" would put a claim in the applicant's
 *     budget that no funder made. Read through `obligationState`, printed in all three states.
 *   - NO DATED DEADLINE IS QUOTED. Only 4 of the 243 cycles this corpus projects are dates a
 *     funder published. The checklist prints the funder's own deadline WORDS and says plainly
 *     that GrantSpotter projects the rest.
 *
 * And one that runs through the container: every string written here goes through
 * `redactBlockedLinks` first, so `farweb.org` — the Foundation for Amateur Radio's hijacked
 * domain, now redirecting to a gambling site and still linked from live ARRL and QCWA pages —
 * cannot reach a funder's inbox as an address, whether it arrived through a source URL, a
 * verbatim quote of the funder's own page, or a budget quote a user typed.
 */
import { zipSync, strToU8 } from 'fflate';
import type { Funder, Program } from '@grantspotter/core';
import { obligationState } from '@grantspotter/core';
import { redactBlockedLinks } from '../api/notify.js';
import { toCsv } from './csv.js';
import { draftToMarkdown } from './draft.js';
import { draftToDocx } from './docx.js';
import type { BudgetLine, PacketInput } from './packet.js';

export type { BudgetLine, PacketInput } from './packet.js';

const BUDGET_COLUMNS = [
  'item',
  'category',
  'quantity',
  'unitCost',
  'lineTotal',
  'justification',
  'quoteSource',
];

/**
 * Same fixed archive mtime as the DOCX writer, for the same reason: a diffable packet.
 *
 * A STRING, AND THAT IS THE ENTIRE POINT. This was `new Date(Date.UTC(1980, 0, 2))` — one INSTANT —
 * and fflate packs the DOS stamp with `getHours()`, `getDate()` and friends, every one of them
 * LOCAL. One instant is a different wall clock in every zone, so one input produced a different
 * packet on every machine: the stamp measured 0x220000 under UTC, 0x219800 in New York, 0x224800
 * in Tokyo, and 0x216000 under Etc/GMT+12 — where the DATE half had moved too, because midnight
 * UTC on the 2nd is noon on the 1st there. The packet was reproducible on one machine and not
 * between two, which meant every byte proof over it held only inside a single timezone. A
 * date-time string with no offset is parsed as LOCAL time, which pins those getters to the same
 * wall clock everywhere. Same fix, same reason, as `XLSX_ARCHIVE_MTIME` in `xlsx.ts`.
 */
const ARCHIVE_MTIME = '1980-01-02T00:00:00';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Every string this module writes passes through here. One door, so none of them can forget. */
function safe(text: string): string {
  return redactBlockedLinks(text);
}

/**
 * The matching-funds question, answered in all three states. `obligationState` is core's own
 * reader and its union is exhaustiveness-checked, so a fourth state cannot be added without this
 * failing to compile.
 */
function costShareSentence(program: Program, sourceUrl: string): string {
  switch (obligationState(program.obligations.costShareRequired)) {
    case 'yes':
      return 'Cost share is required by this funder. Budget the match, and name its source, before you apply.';
    case 'no':
      return `The funder states that cost share is not required. Confirm it against ${sourceUrl} anyway.`;
    case 'unstated':
      return (
        'Cost share: the funder has not said whether matching funds are expected — no page ' +
        `GrantSpotter read addressed it. Ask, or read ${sourceUrl}, before you build this budget.`
      );
  }
}

function coFunderSentence(program: Program): string {
  switch (obligationState(program.obligations.coFunderPreference)) {
    case 'yes':
      return 'This funder prefers not to be the sole funder. Name your other funding sources.';
    case 'no':
      return 'The funder states it does not mind being the sole funder.';
    case 'unstated':
      return 'Sole funding: the funder has not said whether it prefers to share the cost.';
  }
}

export function budgetWorksheetCsv(lines: readonly BudgetLine[], program: Program): string {
  const sourceUrl = program.trust.sourceUrl;
  const rows: Array<Record<string, string>> = lines.map((l) => ({
    item: safe(l.item),
    category: safe(l.category),
    quantity: String(l.quantity),
    unitCost: String(round2(l.unitCost)),
    lineTotal: String(round2(l.quantity * l.unitCost)),
    justification: safe(l.justification),
    quoteSource: safe(l.quoteSource),
  }));
  const total = round2(lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));
  rows.push({
    item: 'TOTAL',
    category: '',
    quantity: '',
    unitCost: '',
    lineTotal: String(total),
    justification: '',
    quoteSource: '',
  });

  const cap = program.obligations.indirectCostCapPct;
  if (cap !== undefined) {
    rows.push({
      item: `Indirect cost cap (${cap}%)`,
      category: 'Indirect',
      quantity: '',
      unitCost: '',
      lineTotal: String(round2((total * cap) / 100)),
      justification: safe(
        `${program.name} caps indirect costs at ${cap}% of direct costs. Anything above this line is not reimbursable.`,
      ),
      quoteSource: safe(sourceUrl),
    });
  }

  // The matching-funds row is always written, in whichever of the three states applies. Omitting
  // it when the funder said nothing is what turns silence into a budget the applicant cannot fund.
  rows.push({
    item: 'Cost share',
    category: 'Obligation',
    quantity: '',
    unitCost: '',
    lineTotal: '',
    justification: safe(costShareSentence(program, sourceUrl)),
    quoteSource: safe(sourceUrl),
  });

  return toCsv(rows, BUDGET_COLUMNS);
}

export function requirementsChecklistMarkdown(program: Program, funder: Funder | undefined): string {
  const hard = program.constraints.filter((c) => c.hard);
  const soft = [...program.constraints.filter((c) => !c.hard)].sort(
    (a, b) => a.fallbackRank - b.fallbackRank || a.id.localeCompare(b.id),
  );
  const sourceUrl = program.trust.sourceUrl;

  const out: string[] = [`# Requirements checklist — ${program.name}`, ''];
  if (funder !== undefined) out.push(`Funder: ${funder.name}`);
  out.push(
    `Status: ${program.trust.status}. Source: ${sourceUrl} ` +
      `(last verified ${program.trust.lastVerifiedAt}, ${program.trust.verificationMethod}).`,
    '',
    '## Requirements (must be true)',
    '',
  );
  out.push(
    ...(hard.length > 0
      ? hard.map((c) => `- [ ] ${c.rawText}`)
      : [
          '- [ ] No hard eligibility requirement was recorded for this program. Read the source page before applying.',
        ]),
  );

  out.push('', '## Preferences (these rank you, they never exclude you)', '');
  out.push(
    ...(soft.length > 0
      ? soft.map((c) => `- [ ] (rank ${c.fallbackRank}) ${c.rawText}`)
      : ['- No preferences recorded.']),
  );

  out.push('', '## Funding restrictions', '');
  out.push(
    ...(program.fundingRestrictions.length > 0
      ? program.fundingRestrictions.map((r) => `- [ ] ${r}`)
      : ['- None recorded.']),
  );

  out.push('', '## Obligations if funded', '');
  const ob = program.obligations;
  if (ob.licenseObligation !== undefined) out.push(`- [ ] ${ob.licenseObligation}`);
  if (ob.indirectCostCapPct !== undefined) {
    out.push(`- [ ] Indirect costs capped at ${ob.indirectCostCapPct}% of direct costs.`);
  }
  // Tri-state, always printed. A missing line reads as "not applicable"; it means "not answered".
  out.push(
    obligationState(ob.costShareRequired) === 'no'
      ? `- ${costShareSentence(program, sourceUrl)}`
      : `- [ ] ${costShareSentence(program, sourceUrl)}`,
  );
  out.push(
    obligationState(ob.coFunderPreference) === 'no'
      ? `- ${coFunderSentence(program)}`
      : `- [ ] ${coFunderSentence(program)}`,
  );
  if (ob.sustainmentObligation !== undefined) out.push(`- [ ] ${ob.sustainmentObligation}`);
  if (ob.reportingObligation !== undefined) out.push(`- [ ] ${ob.reportingObligation}`);

  out.push('', '## How to apply', '');
  out.push(`- Method: ${program.applyVia}`);
  if (program.applyUrl !== undefined) out.push(`- Apply at: ${program.applyUrl}`);
  if (program.applyContact !== undefined) out.push(`- Contact: ${program.applyContact}`);
  out.push(`- Deadline pattern: ${program.deadline.kind}. ${program.deadline.note}`);
  if (program.deadline.source.kind === 'inherited') {
    out.push(
      `- This programme does not set its own deadline: it inherits the one published for ` +
        `${program.deadline.source.fromProgramId}. Read that record's page, not this one, for the date.`,
    );
  }
  // No computed date is printed anywhere in this file, on purpose.
  out.push(
    '- No dated deadline is printed in this packet. GrantSpotter projects most cycle dates from a ' +
      'recurrence rule rather than reading them from the funder, and a projected date presented as ' +
      `the funder's own is the one mistake this product refuses to make. Read the date from ${sourceUrl}.`,
  );

  if (program.rawOtherText.trim() !== '') {
    out.push(
      '',
      '## Long-tail requirements, verbatim from the source',
      '',
      `> ${program.rawOtherText.replace(/\n/g, '\n> ')}`,
    );
  }
  out.push(
    '',
    `_GrantSpotter records facts, not promises. Confirm every line above against ${sourceUrl} before you submit._`,
    '',
  );
  return safe(out.join('\n'));
}

export function sourceLinksMarkdown(program: Program, funder: Funder | undefined): string {
  const out: string[] = [`# Sources — ${program.name}`, ''];
  if (funder !== undefined) out.push(`- Funder: [${funder.name}](${funder.homepage})`);
  out.push(`- Program source: ${program.trust.sourceUrl}`);
  if (program.applyUrl !== undefined) out.push(`- Application: ${program.applyUrl}`);
  if (program.aiPolicy.url !== undefined) out.push(`- AI policy: ${program.aiPolicy.url}`);
  out.push(
    `- Last verified: ${program.trust.lastVerifiedAt} (${program.trust.verificationMethod})`,
  );
  out.push(`- Content hash at verification: ${program.trust.contentHash || 'not computed'}`);

  if (program.aiPolicy.quote !== undefined) {
    out.push(
      '',
      '## Funder AI policy, verbatim',
      '',
      `> ${program.aiPolicy.quote}`,
      '',
      `Stance recorded as: ${program.aiPolicy.stance}.`,
    );
  }
  if (program.trust.staleMirrorWarning !== undefined) {
    out.push('', '## Stale-mirror warning', '', program.trust.staleMirrorWarning);
  }
  if (program.trust.disputed !== undefined) {
    out.push('', '## Disputed', '', program.trust.disputed.note, '');
    out.push(...program.trust.disputed.claims.map((c) => `- ${c.claim} — ${c.sourceUrl}`));
  }
  out.push('');
  return safe(out.join('\n'));
}

function readmeText(input: PacketInput): string {
  const { program, funder, generatedAtISO } = input;
  const lines: string[] = ['GrantSpotter application packet', '', `Program: ${program.name}`];
  if (funder !== undefined) lines.push(`Funder: ${funder.name}`);
  lines.push(
    `Generated: ${generatedAtISO}`,
    '',
    'Contents',
    '  draft.md                  the application draft in markdown',
    '  draft.docx                the same draft as a Word document',
    '  budget-worksheet.csv      line items, totals and any indirect-cost cap',
    '  requirements-checklist.md hard requirements, preferences, restrictions, obligations',
    '  source-links.md           every source URL, the AI policy and any disputed reading',
    '',
    'GrantSpotter did not write your application and does not vouch for any figure in it.',
    `Every fact in this packet traces back to ${program.trust.sourceUrl}, last verified ` +
      `${program.trust.lastVerifiedAt}.`,
    'Verify each one before you submit.',
    '',
    'Highlighted text in draft.docx is a GAP, not an answer: the words inside the brackets are the',
    'question and an example of the kind of answer wanted, never a fact about this applicant.',
    '',
    'The fact checklist inside the draft lists the specifics a funder can look up. It cannot list a',
    'claim made only in words — a superlative, a universal, a causal claim, or the role attached to',
    'a name. A ticked checklist is not a checked draft.',
    '',
  );
  return safe(lines.join('\n'));
}

export async function buildApplicationPacket(input: PacketInput): Promise<Uint8Array> {
  // The DOCX is told the generation instant, which is what makes the whole archive reproducible;
  // `docx@9.7.1` otherwise stamps `new Date()` into every package it writes. See docx.ts.
  const docx = await draftToDocx(input.draft, { generatedAtISO: input.generatedAtISO });
  const files: Record<string, Uint8Array> = {
    'README.txt': strToU8(readmeText(input)),
    'draft.md': strToU8(draftToMarkdown(input.draft)),
    'draft.docx': new Uint8Array(docx),
    'budget-worksheet.csv': strToU8(budgetWorksheetCsv(input.budgetLines, input.program)),
    'requirements-checklist.md': strToU8(requirementsChecklistMarkdown(input.program, input.funder)),
    'source-links.md': strToU8(sourceLinksMarkdown(input.program, input.funder)),
  };
  // A fixed archive mtime keeps the packet byte-stable for the same input, which makes it
  // diffable. `mtime: 0` — which the task brief specified — THROWS in fflate 0.8.3:
  // "date not in range 1980-2099", because the DOS timestamp ZIP stores starts at 1980.
  //
  // Why the 2nd and not the 1st, stated correctly on the second attempt. The original answer here
  // was "the 1st would fall back into 1979 anywhere behind UTC", and that is FALSE of this code:
  // it described the earlier `new Date(Date.UTC(1980, 0, 2))` form, where one instant is a
  // different wall clock in every zone. `ARCHIVE_MTIME` is now a zoneless string, which fflate
  // reads as the same local wall clock everywhere, so both the 1st and the 2nd are safe in every
  // zone — measured across all of them. The 2nd simply stays because it is what shipped, and
  // changing it would rewrite every archive's bytes to no purpose.
  return zipSync(files, { level: 6, mtime: ARCHIVE_MTIME });
}
