import type { ReactElement } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { constraintSpecSchema, type Constraint, type ConstraintAxis } from '@grantspotter/core';
import { IneligibilityDrawer, axisLabel, reasonHeading } from './IneligibilityDrawer.js';

const reasons: Constraint[] = [
  {
    id: 'c-license',
    hard: true,
    fallbackRank: 0,
    rawText: 'License Requirement: General class or higher, held for at least one year.',
    spec: { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 12 },
  },
  {
    id: 'c-geo',
    hard: true,
    fallbackRank: 0,
    rawText: 'Region: Applicant must reside within 250 miles of Seaford, Delaware.',
    spec: {
      axis: 'geography',
      geo: {
        type: 'radius',
        values: [],
        centerLat: 38.6,
        centerLon: -75.6,
        radiusMiles: 250,
        centerLabel: 'Seaford, Delaware',
      },
    },
  },
  {
    id: 'c-soft',
    hard: false,
    fallbackRank: 1,
    rawText: 'Preference will be given to applicants residing in Louisiana.',
    spec: { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
  },
];

function wrap(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

/**
 * Every axis core can emit, read off core's own discriminated union rather than retyped here.
 * A hand-written list is silent exactly where it is incomplete — the same reason
 * `profileFields.test.ts` derives its coverage from the zod mirrors in both directions.
 */
const ALL_AXES = constraintSpecSchema.options.map(
  (option) => option.shape.axis.value as ConstraintAxis,
);

describe('axisLabel', () => {
  it('gives every constraint axis a human label', () => {
    expect(axisLabel('license')).toBe('License');
    expect(axisLabel('arrl_membership')).toBe('ARRL membership');
    expect(axisLabel('ham_activity')).toBe('Demonstrated ham activity');
    expect(axisLabel('age_stage')).toBe('Age or stage');
  });

  it('labels every axis core declares — no axis can arrive here unlabelled', () => {
    expect(ALL_AXES.length).toBe(13);
    for (const axis of ALL_AXES) {
      expect(axisLabel(axis), `unlabelled axis: ${axis}`).not.toBe('');
      expect(axisLabel(axis), `unlabelled axis: ${axis}`).not.toBe(axis);
    }
  });
});

describe('IneligibilityDrawer', () => {
  it('lists every reason with the verbatim source text', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    expect(screen.getByText(/within 250 miles of Seaford, Delaware/)).toBeInTheDocument();
    expect(screen.getByText(/General class or higher/)).toBeInTheDocument();
    expect(screen.getByText(/applicants residing in Louisiana/)).toBeInTheDocument();
  });

  it('labels each reason with its axis', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).getByText('License')).toBeInTheDocument();
  });

  it('marks a hard requirement distinctly from a preference', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    expect(screen.getAllByText('Requirement')).toHaveLength(2);
    expect(screen.getByText('Preference')).toBeInTheDocument();
  });

  it('spells out a radius rule so the user can check it themselves', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    // The plain restatement sits UNDER the quote; the quote itself is never edited. Asserted as an
    // exact string because the brief's `/250 miles of Seaford, Delaware/` matches the raw text too
    // and `getByText` throws on two hits.
    expect(screen.getByText('Within 250 miles of Seaford, Delaware.')).toBeInTheDocument();
  });

  it('says a Section is not a state when it spells one out', () => {
    wrap(
      <IneligibilityDrawer
        programName="Section Award"
        reasons={[
          {
            id: 'c-sec',
            hard: true,
            fallbackRank: 0,
            rawText: 'Open to residents of the ARRL Western New York Section.',
            spec: { axis: 'geography', geo: { type: 'arrl_section', values: ['WNY'] } },
          },
        ]}
      />,
    );
    expect(screen.getByText(/not a state/i)).toBeInTheDocument();
  });

  it('names the program in its accessible label', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    expect(
      screen.getByRole('region', { name: /why you are ineligible for Test Award/i }),
    ).toBeInTheDocument();
  });

  it('says the wording is the funder’s own, so a quote is not read as our paraphrase', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    expect(screen.getByText(/funder’s own wording/i)).toBeInTheDocument();
  });

  it('presents an unmet requirement as the funder’s restriction, not a gap in the profile', () => {
    // 36 of the 150 exclusions a licensed EE undergraduate sees are geography, and every one of
    // them is CORRECT: those scholarships really are Division-, Section- and state-restricted.
    // Copy that invites the user to "fix" them would be inviting them to falsify a profile.
    const { container } = wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    expect(container.textContent).not.toMatch(
      /becomes an answer|will resolve|fill (this|these|it) in|waiting on/i,
    );
    expect(screen.getByText(/not a gap in your profile/i)).toBeInTheDocument();
  });

  it('says so plainly when the reason list is empty rather than rendering nothing', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={[]} />);
    expect(screen.getByText(/no constraint was recorded/i)).toBeInTheDocument();
  });
});

/**
 * THE ONE REASON IN THIS PRODUCT THAT NO FUNDER WROTE.
 *
 * `matchProgram` composes the applicant-entity constraint itself, out of a list GrantSpotter
 * researched per source. It used to arrive carrying a `rawText` — "This program accepts
 * applications from: ieee_student_branch_chapter." — which this component then rendered inside
 * `.explain-raw`, the monospaced quotation block whose whole meaning, in rule 1 of this file's
 * docblock, is that the reader is looking at the sentence the verdict was derived FROM and can
 * judge it. There was no such sentence: 125 rows of a collegiate club's report quoted an enum
 * identifier and 19 quoted "(none recorded)". The empty-list case is `unknown` now and never
 * reaches this drawer at all; the researched-list case reaches it in GrantSpotter's own voice.
 */
const authoredEntityReason: Constraint = {
  id: 'ieee-mtts:applicant-entity',
  hard: true,
  fallbackRank: 0,
  rawText: '',
  spec: {
    axis: 'other',
    note:
      'GrantSpotter, not the funder: this record lists who may apply as IEEE student branches ' +
      'and chapters, and your profile applies as a club that is its own 501(c)(3). That list is ' +
      "GrantSpotter's reading of the funder's page, not a sentence the funder wrote — read the " +
      'page before you rule yourself out.',
  },
};

describe('IneligibilityDrawer — a reason GrantSpotter wrote is never dressed as a quotation', () => {
  it('renders it outside the verbatim block, under a label naming its author', () => {
    const { container } = wrap(
      <IneligibilityDrawer programName="IEEE MTT-S" reasons={[authoredEntityReason]} />,
    );
    expect(container.querySelector('.explain-raw')).toBeNull();
    const authored = container.querySelector('.explain-authored');
    expect(authored).not.toBeNull();
    expect(authored!.textContent).toContain('read the page before you rule yourself out');
    expect(screen.getByText('GrantSpotter’s words, not the funder’s')).toBeInTheDocument();
  });

  it('drops the claim that the wording below is the funder’s', () => {
    wrap(<IneligibilityDrawer programName="IEEE MTT-S" reasons={[authoredEntityReason]} />);
    expect(
      screen.getByText(
        'Not a quotation. No funder sentence was recorded for this, so what follows is ' +
          'GrantSpotter’s own statement about the record — read the funder’s page ' +
          'before you take it as theirs.',
      ),
    ).toBeInTheDocument();
  });

  it('says which lines are which when a verdict mixes the two', () => {
    wrap(
      <IneligibilityDrawer
        programName="Mixed Award"
        reasons={[reasons[0]!, authoredEntityReason]}
      />,
    );
    expect(
      screen.getByText(
        'Quoted below in the funder’s own wording, except where a line is marked as ' +
          'GrantSpotter’s. A marked line is our statement about the record, not a sentence the ' +
          'funder wrote.',
      ),
    ).toBeInTheDocument();
    // The funder's half is still quoted verbatim, in the block that means verbatim.
    expect(screen.getByText(/General class or higher/)).toBeInTheDocument();
  });

  it('files it under "Who may apply" instead of the long-tail axis name', () => {
    wrap(<IneligibilityDrawer programName="IEEE MTT-S" reasons={[authoredEntityReason]} />);
    expect(reasonHeading(authoredEntityReason)).toBe('Who may apply');
    expect(reasonHeading(reasons[0]!)).toBe('License');
    expect(screen.getByText('Who may apply')).toBeInTheDocument();
    expect(screen.queryByText('Other')).toBeNull();
  });

  it('never shows the sentence it replaced, nor an enum identifier', () => {
    const { container } = wrap(
      <IneligibilityDrawer programName="IEEE MTT-S" reasons={[authoredEntityReason]} />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain('accepts applications from');
    expect(text).not.toContain('(none recorded)');
    expect(text).not.toContain('ieee_student_branch_chapter');
    expect(text).not.toMatch(/[a-z]+_[a-z]+_[a-z]/);
  });

  it('says so rather than showing a blank box when a reason carries no wording at all', () => {
    wrap(
      <IneligibilityDrawer
        programName="Silent Award"
        reasons={[
          { id: 'c-silent:applicant-entity', hard: true, fallbackRank: 0, rawText: '', spec: { axis: 'other', note: '' } },
        ]}
      />,
    );
    expect(
      screen.getByText(
        /No wording was recorded for this requirement\. Open the record and check the source\./,
      ),
    ).toBeInTheDocument();
  });
});
