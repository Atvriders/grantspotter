import type { ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Constraint } from '@grantspotter/core';
import { VerdictBadge, unrepresentedRoutesOf } from './VerdictBadge.js';
import { makeProgram } from '../test/programRowFixtures.js';

const licenseConstraint: Constraint = {
  id: 'c1',
  hard: true,
  fallbackRank: 0,
  rawText: 'License Requirement: General class or higher.',
  spec: { axis: 'license', licenseMin: 'GENERAL' },
};

function wrap(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('VerdictBadge', () => {
  it('renders eligible with an accessible label', () => {
    wrap(<VerdictBadge verdict={{ kind: 'eligible' }} />);
    expect(screen.getByLabelText('Eligible')).toBeInTheDocument();
  });

  it('renders the preference rank, because a preference is not a guarantee', () => {
    wrap(<VerdictBadge verdict={{ kind: 'eligible_preferred', rank: 1, met: ['c1'] }} />);
    expect(screen.getByLabelText('Preferred, rank 1')).toHaveTextContent('Preferred · 1');
  });

  it('says in words that a preference is not a guarantee', () => {
    wrap(<VerdictBadge verdict={{ kind: 'eligible_preferred', rank: 2, met: ['c1'] }} />);
    expect(screen.getByLabelText('Preferred, rank 2').getAttribute('title')).toMatch(
      /not a guarantee/i,
    );
  });

  it('renders the ineligible count and exposes the reasons on click', async () => {
    const onExplain = vi.fn();
    wrap(
      <VerdictBadge
        verdict={{ kind: 'ineligible', reasons: [licenseConstraint] }}
        onExplain={onExplain}
      />,
    );
    const button = screen.getByRole('button', { name: /ineligible, 1 constraint/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    expect(onExplain).toHaveBeenCalledTimes(1);
  });

  it('reflects the open drawer in aria-expanded', () => {
    wrap(
      <VerdictBadge
        verdict={{ kind: 'ineligible', reasons: [licenseConstraint] }}
        onExplain={() => undefined}
        expanded
      />,
    );
    expect(screen.getByRole('button', { name: /ineligible/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('is a plain label, not a dead button, when nothing can be explained', () => {
    wrap(<VerdictBadge verdict={{ kind: 'ineligible', reasons: [licenseConstraint] }} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ineligible, 1 constraint not met')).toBeInTheDocument();
  });

  it('pluralises the constraint count', () => {
    // `onExplain` is what makes the badge a button — the brief's version of this test queried
    // `getByRole('button')` while passing no handler, which its own component could never satisfy.
    wrap(
      <VerdictBadge
        verdict={{ kind: 'ineligible', reasons: [licenseConstraint, { ...licenseConstraint, id: 'c2' }] }}
        onExplain={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: /ineligible, 2 constraints/i })).toBeInTheDocument();
  });

  it('renders unknown as a real state naming the missing field', () => {
    wrap(<VerdictBadge verdict={{ kind: 'unknown', missingProfileFields: ['gpa'] }} />);
    expect(screen.getByLabelText('Unknown, needs GPA')).toBeInTheDocument();
  });

  it('names the other missing fields instead of silently showing one of three', () => {
    wrap(
      <VerdictBadge
        verdict={{ kind: 'unknown', missingProfileFields: ['gpa', 'stage', 'birthDate'] }}
      />,
    );
    const badge = screen.getByLabelText('Unknown, needs GPA and 2 more');
    expect(badge).toHaveTextContent('+2');
    expect(badge.getAttribute('title')).toContain('Stage');
    expect(badge.getAttribute('title')).toContain('Date of birth');
  });

  /**
   * `unknown` is a common state, not a rare one, and it got commoner: 8 of 150 for a fully
   * specified EE undergraduate until 2026-08-12 and 27 of 150 after it, when `matcher.ts` stopped
   * reading a record that named no audience as a refusal. Twenty of those 27 are waiting on
   * GrantSpotter's own data rather than on the reader (`e2e/api.spec.ts` names all twenty). It is
   * an honest state — a question this product has not been told the answer to — and it must never
   * read as a soft "no".
   *
   * The figure is quoted here because the neighbouring test below turns on how common it is; it is
   * ASSERTED in `e2e/api.spec.ts` and `exports/eligibilityCorpus.test.ts`, which are the copies
   * that fail when it moves. This one went stale for as long as those two took to be updated.
   */
  it('never reads unknown as a refusal', () => {
    wrap(<VerdictBadge verdict={{ kind: 'unknown', missingProfileFields: ['gpa'] }} />);
    const badge = screen.getByLabelText('Unknown, needs GPA');
    const spoken = `${badge.getAttribute('aria-label') ?? ''} ${badge.textContent ?? ''}`;
    expect(spoken).not.toMatch(/ineligible|not eligible|does not qualify|rejected/i);
    expect(badge.getAttribute('title')).toMatch(/waiting on/i);
  });

  it('does not promise that filling the field produces an answer', () => {
    // The matcher short-circuits per axis: filling `degreeLevel` moves a verdict from one
    // `unknown` to a DIFFERENT unknown. "Waiting on", never "becomes an answer".
    wrap(<VerdictBadge verdict={{ kind: 'unknown', missingProfileFields: ['degreeLevel'] }} />);
    const title = screen.getByLabelText('Unknown, needs Degree level').getAttribute('title') ?? '';
    expect(title).not.toMatch(/becomes an answer|will resolve|resolves this/i);
    expect(title).toMatch(/next question|another question/i);
  });

  it('falls back to the raw field name rather than a blank when the key is unregistered', () => {
    wrap(<VerdictBadge verdict={{ kind: 'unknown', missingProfileFields: ['somethingNew'] }} />);
    expect(screen.getByLabelText('Unknown, needs somethingNew')).toBeInTheDocument();
  });

  it('renders unknown with no named field as a state, not an empty badge', () => {
    wrap(<VerdictBadge verdict={{ kind: 'unknown', missingProfileFields: [] }} />);
    expect(screen.getByLabelText('Unknown')).toHaveTextContent('Unknown');
  });

  /**
   * AN UNKNOWN THAT ASKS FOR NOTHING IS A HOLE IN GRANTSPOTTER'S RECORD, AND MUST SAY SO.
   *
   * 20 of the 150 publishable records reach a licensed EE undergraduate in this state: one radius
   * rule whose `centerLabel` never resolved to a coordinate, and 19 whose applicant-entity list is
   * empty because nobody ever recorded who may apply (all 19 were a hard `ineligible` for every
   * possible user until 2026-08-12). The old wording — "Something this program asks for could not
   * be evaluated from your profile" — sent every one of those readers to the profile editor to
   * close a gap in OUR data, which is the same misattribution as calling it a refusal.
   */
  it('says an unanswerable unknown is a gap in the record, not in the reader', () => {
    wrap(<VerdictBadge verdict={{ kind: 'unknown', missingProfileFields: [] }} />);
    expect(screen.getByLabelText('Unknown')).toHaveAttribute(
      'title',
      'Not an answer yet. This program’s record is missing something GrantSpotter needs to ' +
        'decide it, and there is no field you could fill in that would change that. It is not a "no".',
    );
  });

  it('renders a "no profile" state rather than an empty cell when the verdict is null', () => {
    wrap(<VerdictBadge verdict={null} />);
    expect(screen.getByLabelText('No profile set')).toBeInTheDocument();
  });

  it('distinguishes "no profile" from a computed unknown', () => {
    const { unmount } = wrap(<VerdictBadge verdict={null} />);
    expect(screen.getByLabelText('No profile set')).toHaveClass('verdict-none');
    unmount();
    wrap(<VerdictBadge verdict={{ kind: 'unknown', missingProfileFields: ['gpa'] }} />);
    expect(screen.getByLabelText('Unknown, needs GPA')).toHaveClass('verdict-unknown');
  });

  it('exposes its label to assistive technology, not just to the DOM', () => {
    // `aria-label` on a bare <span> (role generic) is ignored by AT. `role="img"` is the role
    // that both accepts an author-supplied name and replaces its children with it.
    wrap(<VerdictBadge verdict={{ kind: 'eligible' }} />);
    expect(screen.getByRole('img', { name: 'Eligible' })).toBeInTheDocument();
  });
});

/**
 * THE THIRD CAUSE OF AN UNKNOWN WITH NOTHING TO FILL IN, AND THE ONE THE BADGE USED TO MISNAME.
 *
 * `ConstraintAlternatives.orUnrepresented` holds a route the funder named that this schema cannot
 * describe — "The scholarship is open to graduating high school seniors, AND TO PREVIOUS
 * AWARDEES", or a whole subject domain no word-matching can adjudicate. The axis declines to
 * decide rather than refuse, which is right, and the badge then said "This program's record is
 * missing something GrantSpotter needs to decide it, and there is no field you could fill in that
 * would change that."
 *
 * Both halves are wrong here. The record is complete and the funder's sentence is on file; and on
 * the 49 field-of-study cases the applicant's own `fieldOfStudy` is exactly the thing nobody can
 * adjudicate, so "no field you could fill in" is worse than vague. Measured over the shipped
 * corpus with `scripts/profile-corpus.ts`: 51 constraints across 51 of the 150 publishable
 * programmes carry `orUnrepresented` (49 field_of_study, 1 age_stage, 1 ham_activity), and for the
 * graduate music student 20 of the unknowns with nothing to fill in are of this kind.
 */
describe('VerdictBadge — a route this schema cannot check', () => {
  it('names the obstacle instead of blaming the record for a hole in our own schema', () => {
    wrap(
      <VerdictBadge
        verdict={{ kind: 'unknown', missingProfileFields: [] }}
        unrepresentedRoutes={['previous awardees']}
      />,
    );
    const title = screen.getByLabelText('Unknown').getAttribute('title') ?? '';
    expect(title).toContain('previous awardees');
    expect(title).toMatch(/cannot check/i);
    expect(title).toMatch(/not a "no"/);
    expect(title).not.toMatch(/record is missing something/i);
    expect(title).not.toMatch(/no field you could fill in/i);
  });

  /**
   * THE OTHER HALF OF THE SAME RULE. The 19 records whose applicant list nobody ever filled in and
   * the one radius rule whose centre never resolved ARE gaps in GrantSpotter's record, and that
   * sentence is exactly right for them. A route the schema cannot check is a different thing, and
   * neither may borrow the other's words.
   */
  it('keeps the record-gap wording for the records that really are missing something', () => {
    wrap(
      <VerdictBadge verdict={{ kind: 'unknown', missingProfileFields: [] }} unrepresentedRoutes={[]} />,
    );
    expect(screen.getByLabelText('Unknown').getAttribute('title') ?? '').toMatch(
      /record is missing something/i,
    );
  });

  /**
   * A ROUTE THE SCHEMA CANNOT CHECK NEVER OUTRANKS A FIELD THE READER CAN ANSWER. `orUnrepresented`
   * is consulted only once every representable route has FAILED, so where a field is still unset
   * the honest instruction is still "answer this one".
   */
  it('still points at the profile when there is something on it to answer', () => {
    wrap(
      <VerdictBadge
        verdict={{ kind: 'unknown', missingProfileFields: ['gpa'] }}
        unrepresentedRoutes={['previous awardees']}
      />,
    );
    const title = screen.getByLabelText('Unknown, needs GPA').getAttribute('title') ?? '';
    expect(title).toMatch(/waiting on: GPA/);
    expect(title).not.toMatch(/previous awardees/);
  });

  it('reads the routes off the record, in order, and ignores the constraints that name none', () => {
    const program = makeProgram({
      constraints: [
        { ...licenseConstraint, id: 'c-plain' },
        {
          id: 'c-stage',
          hard: true,
          fallbackRank: 0,
          rawText: 'The scholarship is open to graduating high school seniors, and to previous awardees.',
          spec: { axis: 'age_stage', stages: ['HS_SENIOR'], orUnrepresented: 'previous awardees' },
        },
        {
          id: 'c-field',
          hard: true,
          fallbackRank: 0,
          rawText: 'Mathematics or data science',
          spec: {
            axis: 'field_of_study',
            fields: ['Mathematics', 'data science'],
            excludedFields: [],
            orUnrepresented: 'Mathematics',
          },
        },
      ],
    });
    expect(unrepresentedRoutesOf(program)).toEqual(['previous awardees', 'Mathematics']);
    expect(unrepresentedRoutesOf(makeProgram())).toEqual([]);
  });
});
