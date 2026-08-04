import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ProfileFieldKind } from '../lib/profileFields.js';
import { UnknownFields } from './UnknownFields.js';

function wrap(fields: Array<{ field: string; count: number }>, kind?: ProfileFieldKind) {
  return render(
    <MemoryRouter>
      <UnknownFields fields={fields} kind={kind} />
    </MemoryRouter>,
  );
}

describe('UnknownFields', () => {
  it('links each waiting field to the profile input that sets it', () => {
    wrap([{ field: 'gpa', count: 7 }]);
    const link = screen.getByRole('link', { name: /GPA/ });
    expect(link).toHaveAttribute('href', '/profile?kind=student&focus=gpa#field-gpa');
  });

  it('sends an organization to the organization tab for a field both profiles have', () => {
    // `state`, `lat`, `lon` and `callsign` exist on BOTH profiles. Without the kind, a club whose
    // geography verdict is unknown is sent to the student editor, where setting the field does
    // nothing for the verdict that sent them there.
    wrap([{ field: 'state', count: 4 }], 'organization');
    expect(screen.getByRole('link', { name: /State/ })).toHaveAttribute(
      'href',
      '/profile?kind=organization&focus=state#field-state',
    );
  });

  it('says how many unknown verdicts are waiting on each field', () => {
    wrap([{ field: 'gpa', count: 7 }]);
    expect(screen.getByText(/7 unknown verdicts are waiting on this/i)).toBeInTheDocument();
  });

  it('uses the singular for one', () => {
    wrap([{ field: 'cwWpm', count: 1 }]);
    expect(screen.getByText(/^1 unknown verdict is waiting on this$/i)).toBeInTheDocument();
  });

  it('never promises that filling a field produces a verdict', () => {
    // The matcher short-circuits per axis: filling `degreeLevel` moves QCWA's verdict from one
    // unknown to a DIFFERENT unknown (`accredited`). `completeness.resolves` is an upper bound,
    // not a promise, and `completeness.test.ts` pins that. Saying "resolves 7 unknown verdicts"
    // here would reintroduce in the UI exactly the over-assertion the data layer was corrected for.
    const { container } = wrap([{ field: 'gpa', count: 7 }, { field: 'stage', count: 2 }]);
    expect(container.textContent).not.toMatch(
      /becomes? an answer|will resolve|resolves \d|guarantee/i,
    );
  });

  it('warns that answering one may only reveal the next question', () => {
    wrap([{ field: 'gpa', count: 7 }]);
    expect(screen.getByText(/next question/i)).toBeInTheDocument();
  });

  it('says an unanswered field is a question, never a rejection', () => {
    // An unset profile field yields `unknown`, never `ineligible` — confirmed across six hard-bar
    // axes. The ladder must not read as a list of things holding a "no" in place.
    wrap([{ field: 'gpa', count: 7 }]);
    expect(screen.getByText(/not a “no”|not a "no"/i)).toBeInTheDocument();
  });

  it('shows the help text so the user knows what the field means', () => {
    wrap([{ field: 'state', count: 3 }]);
    expect(screen.getByText(/ARRL Section/)).toBeInTheDocument();
  });

  it('still lists a field the registry does not know, rather than dropping it silently', () => {
    wrap([{ field: 'somethingNew', count: 2 }]);
    expect(screen.getByRole('link', { name: /somethingNew/ })).toHaveAttribute('href', '/profile');
  });

  it('renders nothing when there is nothing missing', () => {
    const { container } = wrap([]);
    expect(container).toBeEmptyDOMElement();
  });
});
