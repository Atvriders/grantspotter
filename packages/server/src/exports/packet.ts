import type { Funder, Program } from '@grantspotter/core';
import type { DraftDocument } from './draft.js';

/**
 * PLAN-LOCAL. The CONTRACT defines no budget shape.
 *
 * `quoteSource` is not decoration: a budget line without a quote is a number the applicant cannot
 * defend, and it is the field a reviewer asks about first. It is also USER-SUPPLIED text, which is
 * why the worksheet writer redacts it against the fetcher blocklist like everything else.
 */
export interface BudgetLine {
  item: string;
  category: string;
  quantity: number;
  unitCost: number;
  justification: string;
  quoteSource: string;
}

/** PLAN-LOCAL. */
export interface PacketInput {
  program: Program;
  funder?: Funder;
  draft: DraftDocument;
  budgetLines: BudgetLine[];
  /**
   * The generation instant. It appears in the README, and it is threaded into the DOCX so the
   * whole packet is byte-stable for the same input — a packet a reviewer can diff against the one
   * they were sent last week.
   */
  generatedAtISO: string;
}
