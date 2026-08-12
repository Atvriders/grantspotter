import type { AiStance } from '@grantspotter/core';

/**
 * A one-sentence AI-use disclosure is ON by default.
 *
 * The evidence for that default is the corpus itself, COUNTED rather than remembered — this
 * paragraph read "several publish a policy that asks for or welcomes disclosure" until 2026-08-12
 * and that was the sentence the two false user-facing ones below were written from. The census
 * (`compose.test.ts`, "makes no claim about the corpus that the corpus does not support", which
 * recomputes it on every run): of 143 shipped records, 142 have published nothing about AI, one
 * (ARDC) permits it, and NONE prohibits it, discourages it, or asks to be told. So the sentence
 * breaks no rule anybody here has published, and the applicant can delete it in one keystroke.
 * The default runs toward saying what happened, never toward hiding it.
 */
export const DISCLOSURE_DEFAULT_ON = true;

export interface DisclosureInput {
  stance: AiStance;
  /** Named in the sentence ONLY when this funder is the one asking for the disclosure. */
  funderName: string;
  toolName?: string;
  authorName?: string;
  usage?: 'drafting' | 'editing' | 'both';
}

/**
 * The editable disclosure sentence. It says three things and nothing else: what assisted, who
 * checked, and who is accountable. It claims no more than the applicant can confirm — which is why
 * `usage` narrows the verb instead of always claiming both, and why the funder is named only under
 * `permitted_with_disclosure`, where the funder has actually asked to be told.
 */
export function disclosureSentence(input: DisclosureInput): string {
  const tool = input.toolName?.trim() || 'a generative AI assistant';
  const author = input.authorName?.trim() || 'the applicant';
  const verb =
    input.usage === 'editing'
      ? 'edited with the assistance of'
      : input.usage === 'drafting'
        ? 'drafted with the assistance of'
        : 'drafted and edited with the assistance of';

  const sentence =
    `Portions of this application were ${verb} ${tool}; ` +
    `${author} reviewed and verified every factual statement, figure, date and citation in it, ` +
    `and takes full responsibility for its content.`;

  if (input.stance === 'permitted_with_disclosure') {
    const funder = input.funderName.trim() || 'the funder';
    return `${sentence} This disclosure is made in response to ${funder}'s published requirement to disclose the use of AI.`;
  }
  return sentence;
}

/**
 * What a stance means for the applicant, in the applicant's terms. It describes the STANCE only —
 * the funder's own words and source URL are printed next to it by `composePrompt`, and nothing
 * here may put a requirement into a funder's mouth. That is the failure this repository keeps
 * finding: a Yaesu "12-month on-air obligation" that appears nowhere on the funder's page.
 */
export function disclosureNote(stance: AiStance): string {
  switch (stance) {
    case 'permitted_with_disclosure':
      return (
        'This funder requires disclosure. It is mandatory, not optional, and it usually must state ' +
        'the extent of the use — what was drafted, what was edited, and by what tool. Write it as ' +
        'plainly as the rest of the application.'
      );
    case 'permitted':
      return (
        'This funder permits AI assistance and holds the applicant responsible for accuracy and ' +
        'originality. Nothing in the corpus GrantSpotter reviewed penalises a disclosure ' +
        'sentence, so including it costs nothing — and no funder here requires one, so leaving ' +
        'it out breaks no rule either.'
      );
    case 'discouraged':
      return (
        'This funder discourages AI assistance. Disclose it, keep the use to editing rather than ' +
        'drafting, and expect the originality of the ideas to be scrutinised.'
      );
    case 'prohibited':
      return (
        'This funder prohibits AI assistance for applicants. Do not use a model to draft or edit ' +
        'this application. Use this brief only to read what the funder requires; the prose has to ' +
        'be yours.'
      );
    case 'unaddressed':
    default:
      return (
        /*
          THE CENSUS CLAUSE IS GONE, AND ITS REMOVAL IS THE FIX RATHER THAN A REWORDING.

          It read "Every funder in this corpus that has published a position welcomes disclosure
          and none penalises it". Counted on 2026-08-12, exactly ONE of the 143 shipped records has
          published a position at all (ARDC, `permitted`) and its quote says nothing whatever about
          disclosure — so "welcomes disclosure" described no funder in the corpus. Restating it
          about what that one funder DID say puts the words "permits AI" into a paragraph whose
          entire job is to say this funder has stated nothing, which `compose.test.ts` refuses by
          name ("reports an unaddressed AI policy honestly instead of guessing") and is right to.
          The default does not need a census to justify it; what is left is the one negative claim
          the corpus does support.
        */
        'This funder has not published any policy on applicants using AI. GrantSpotter does not guess a position it has ' +
        'no evidence for, so no stance is shown and no permission should be read into the silence. Nothing in this ' +
        'corpus penalises a disclosure sentence and no funder in it requires one, which is why the sentence is offered ' +
        'here by default rather than added for you. Including it is your call.'
      );
  }
}
