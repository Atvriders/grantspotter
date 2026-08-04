import type { AiStance } from '@grantspotter/core';

/**
 * A one-sentence AI-use disclosure is ON by default.
 *
 * The evidence for that default is the corpus itself: not one funder reviewed prohibits applicants
 * from using AI, several publish a policy that asks for or welcomes disclosure, and none penalises
 * it. So the sentence costs nothing where it is optional and is required where it is not — and the
 * applicant can delete it in one keystroke. The default runs toward saying what happened, never
 * toward hiding it.
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
        'originality. Nothing in the corpus GrantSpotter reviewed penalises a disclosure sentence, ' +
        'and several funders ask for one, so including it costs nothing.'
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
        'This funder has not published any policy on applicants using AI. GrantSpotter does not guess a position it has ' +
        'no evidence for, so no stance is shown and no permission should be read into the silence. Every funder in this ' +
        'corpus that has published a position welcomes disclosure and none penalises it, which is why the disclosure ' +
        'sentence is offered here by default. Including it is your call.'
      );
  }
}
