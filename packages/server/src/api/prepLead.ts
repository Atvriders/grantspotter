import type { Program } from '@grantspotter/core';

/**
 * PLAN-LOCAL to Plan 3. Spec §11.1: the calendar must show when to START, not
 * only when a thing is due.
 *
 * Two quantities, not one, because the research found two different numbers
 * pointing in opposite directions in time. `prepLeadDays` is work BEFORE the
 * close — assembling transcripts, references, a fiscal sponsor. The decision
 * lag is the wait AFTER it, and the only reason it is on the same object is
 * that a user planning a year asks both questions at once ("when do I start"
 * and "when will I know"). Collapsing them into one "lead time" would tell an
 * ARDC applicant to start 60-120 days early, which is not what ARDC said.
 */
export interface PrepLead {
  /** Days before the close date the applicant should start. */
  prepLeadDays: number;
  /** Days after close before a decision, when the funder publishes one. */
  decisionLagMinDays?: number;
  decisionLagMaxDays?: number;
  /** Human-readable justification, shown in the calendar overlay tooltip. */
  note: string;
}

/**
 * The answer when the funder has published nothing.
 *
 * The note says so in the note itself rather than leaving the caller to infer
 * it from the absence of a decision lag, because this figure is rendered next
 * to figures that ARE the funder's, on a surface whose whole discipline is
 * telling "they said so" from "we worked it out". Thirty days is a default, and
 * it says it is a default.
 */
const DEFAULT_LEAD: PrepLead = {
  prepLeadDays: 30,
  note:
    'This funder states no published lead time. Thirty days is GrantSpotter’s default, ' +
    'not the funder’s figure.',
};

/**
 * Lead times keyed by funder. Every number here traces to the 2026-08-02
 * research pass; nothing is invented.
 *
 * Keyed on `funderId`, which is also what makes an INHERITED deadline come out
 * right with no second mechanism: QCWA rides the ARRL Foundation's cycle, so
 * `expandCycles` supplies the ARRL date under QCWA's own id while this table
 * supplies QCWA's own lead against it. The date is inherited; the lead is not.
 */
const BY_FUNDER: Record<string, PrepLead> = {
  ardc: {
    prepLeadDays: 45,
    decisionLagMinDays: 60,
    decisionLagMaxDays: 120,
    note:
      'ARDC evaluates for 60 to 120 days after a cycle closes, and the application needs three ' +
      'references plus an open-source/open-access commitment. Start about 45 days out.',
  },
  'arrl-foundation': {
    prepLeadDays: 30,
    note:
      'The single ARRL Foundation application needs a transcript and references from people who ' +
      'are not you. Start about 30 days before the close.',
  },
  qcwa: {
    prepLeadDays: 30,
    note:
      'QCWA needs a sponsoring active QCWA member, and the packet must reach ARRL before the ' +
      'first week of January. Start about 30 days before the ARRL close, plus a transcript.',
  },
  ncdxf: {
    prepLeadDays: 60,
    note: 'NCDXF asks for roughly two months of lead before it can act on a request.',
  },
  'ariss-usa': {
    prepLeadDays: 45,
    note:
      'ARISS proposal windows are rewritten quarterly and require an education plan plus a ' +
      'technical mentor. Start about 45 days out.',
  },
  yaesu: {
    prepLeadDays: 21,
    note:
      'The Yaesu DR-2X window is ad-hoc and short, and carries a 12-month on-air obligation the ' +
      'club must agree to first.',
  },
};

/**
 * The prep lead for one program.
 *
 * Answers with a COPY. The calendar route calls this once per program and puts
 * the result straight into a response body, so handing back the module-level
 * row would let one mutation — by this process, a later task, or a test —
 * rewrite the published figure for every request that follows it.
 */
export function prepLeadFor(program: Program): PrepLead {
  return { ...(BY_FUNDER[program.funderId] ?? DEFAULT_LEAD) };
}

/**
 * The date the applicant should start, or null when there is no usable close
 * date.
 *
 * An unparseable close yields null rather than a start computed from `NaN`:
 * `new Date(NaN).toISOString()` throws, and the only alternative to throwing —
 * quietly falling back to "now" — would print a start date derived from a date
 * we could not read, on a surface whose entire job is to be trustworthy about
 * where a date came from.
 */
export function prepStartFor(closesAt: string | null, prepLeadDays: number): string | null {
  if (closesAt === null) return null;
  const closesMs = Date.parse(closesAt);
  if (Number.isNaN(closesMs)) return null;
  return new Date(closesMs - prepLeadDays * 86_400_000).toISOString();
}
