import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary, rescueFields } from './ErrorBoundary.js';
import { auditA11y } from '../test/a11y.js';

/**
 * WHAT THIS FILE MEASURES, AND WHAT IT CANNOT.
 *
 * The claim the boundary makes is about WHERE the damage stops, so the tests are written as
 * before/after measurements of the page rather than as assertions about the fallback's words: a
 * field is typed into, a sibling is made to throw, and the field is looked for afterwards. That
 * is the only shape of test that can tell the three placements apart, because all three render a
 * perfectly reasonable-looking message and only one of them keeps the typing.
 *
 * jsdom renders no pixels, so nothing here proves the panel is legible or that it does not push
 * the page sideways. Those were measured in real Chromium and the numbers are in the commit
 * message; `styles/boundary.css` carries the rules `test/responsive.test.ts` checks statically.
 *
 * React logs every caught error to `console.error` itself, on top of the boundary's own report.
 * That is nine screenfuls of stack in the middle of a green run, so the console is silenced per
 * test and the boundary's OWN report is asserted through the `onError` seam instead — silencing
 * a channel and then testing that channel would prove nothing.
 */

function Boom({ when = true }: { when?: boolean }): JSX.Element {
  if (when) throw new Error('the callsign panel could not read that record');
  return <p>the panel is fine</p>;
}

/** A page shaped like the real one: a form the applicant is typing into, with a panel in it. */
function FormWithPanel({ panel }: { panel: JSX.Element }): JSX.Element {
  return (
    <form>
      <label htmlFor="lat">Latitude</label>
      <input id="lat" name="lat" defaultValue="" />
      <label htmlFor="field">Field of study</label>
      <input id="field" name="field" defaultValue="" />
      {panel}
    </form>
  );
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('the page a render throw leaves behind', () => {
  /**
   * THE MEASUREMENT THE WHOLE COMPONENT EXISTS FOR.
   *
   * This is the verifier's scenario reproduced: something inside the callsign panel throws while
   * the applicant has typed a latitude they have not saved. With a `panel` boundary around the
   * thing that throws, the input is not merely present — it still HOLDS what was typed.
   */
  it('keeps a sibling field, and what was typed into it, when the panel it sits beside throws', async () => {
    function Screen(): JSX.Element {
      const [broken, setBroken] = useState(false);
      return (
        <FormWithPanel
          panel={
            <>
              <button type="button" onClick={() => { setBroken(true); }}>
                Look up
              </button>
              <ErrorBoundary scope="panel" region="The callsign lookup">
                <Boom when={broken} />
              </ErrorBoundary>
            </>
          }
        />
      );
    }
    render(<Screen />);
    await userEvent.type(screen.getByLabelText('Latitude'), '41.8781');
    await userEvent.type(screen.getByLabelText('Field of study'), 'Electrical engineering');

    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));

    expect(screen.getByText(/The callsign lookup stopped working/)).toBeInTheDocument();
    expect(screen.getByLabelText('Latitude')).toHaveValue('41.8781');
    expect(screen.getByLabelText('Field of study')).toHaveValue('Electrical engineering');
    expect(screen.queryByText('the panel is fine')).not.toBeInTheDocument();
  });

  /**
   * THE HONEST OTHER HALF, asserted rather than glossed.
   *
   * With the boundary around the whole screen — which is where `App.tsx` can put one, because
   * `App.tsx` renders routes and not panels — the same throw takes the form with it. The typed
   * latitude is not recoverable and the input is not on the page at all. If this test ever goes
   * green while asserting the opposite, someone has moved a boundary and the copy on screen has
   * to move with it.
   */
  it('loses the whole form, typing included, when the boundary is around the screen instead', async () => {
    function Screen(): JSX.Element {
      const [broken, setBroken] = useState(false);
      return (
        <ErrorBoundary scope="screen" region="This screen">
          <FormWithPanel
            panel={
              <button type="button" onClick={() => { setBroken(true); }}>
                Look up
              </button>
            }
          />
          <Boom when={broken} />
        </ErrorBoundary>
      );
    }
    render(<Screen />);
    await userEvent.type(screen.getByLabelText('Latitude'), '41.8781');
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));

    expect(screen.queryByLabelText('Latitude')).not.toBeInTheDocument();
    expect(screen.getByText(/This screen stopped working/)).toBeInTheDocument();
    expect(
      screen.getByText(/no longer in the form, and no button here can put it back/),
    ).toBeInTheDocument();
  });

  /** The blank page is what this replaces, so the page must not be blank. */
  it('leaves a heading and words on the page rather than an empty body', () => {
    const { container } = render(
      <ErrorBoundary scope="screen" region="This screen">
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.textContent?.trim()).not.toBe('');
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
});

describe('what the fallback tells the person', () => {
  it('names what broke and what still works, rather than "something went wrong"', () => {
    render(
      <ErrorBoundary scope="panel" region="The callsign lookup">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/The callsign lookup stopped working/)).toBeInTheDocument();
    expect(screen.getByText(/Everything around it is still on screen/)).toBeInTheDocument();
    expect(screen.getByText(/still there and still unsaved/)).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('says what pressing the button will really do, including that it may fail the same way', () => {
    render(
      <ErrorBoundary scope="screen" region="This screen">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Draw this screen again' })).toBeInTheDocument();
    expect(screen.getByText(/it will break the same way again/)).toBeInTheDocument();
    expect(screen.getByText(/cannot restore your typing/)).toBeInTheDocument();
  });

  it('offers a reload and not a retry at the app scope, where there is nothing left to re-draw', () => {
    const reload = vi.fn();
    render(
      <ErrorBoundary scope="app" region="GrantSpotter" reload={reload}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole('button', { name: /draw this/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/nothing that was already saved has been changed by it/),
    ).toBeInTheDocument();
    screen.getByRole('button', { name: 'Reload GrantSpotter' }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  /**
   * The product does not have crash reporting, and the fallback is the only place a user could
   * form the belief that it does. Saying so is a product decision, so it is pinned like one.
   */
  it('says plainly that nothing was reported anywhere, and carries the stack for the operator', () => {
    render(
      <ErrorBoundary scope="screen" region="This screen">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Nothing about this failure was sent anywhere/)).toBeInTheDocument();
    expect(
      screen.getByText(/the callsign panel could not read that record/),
    ).toBeInTheDocument();
  });

  it('reports the error and the component stack to the console once', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary scope="screen" region="This screen" onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info] = onError.mock.calls[0] as [Error, { componentStack?: string | null }];
    expect(error.message).toBe('the callsign panel could not read that record');
    expect(info.componentStack ?? '').toContain('Boom');
  });
});

describe('the field rescue', () => {
  /**
   * The rescue is the only part of this component that reaches for React's commit order — it
   * reads the DOM in `getSnapshotBeforeUpdate`, which runs before React deletes the old nodes.
   * If that ever stops being true this test goes red rather than the fallback quietly printing
   * nothing, which is the whole reason it is asserted through a real render and not by calling
   * `rescueFields` on a fragment.
   */
  it('prints what was in the fields at the moment the screen went, so it can be copied', async () => {
    function Screen(): JSX.Element {
      const [broken, setBroken] = useState(false);
      return (
        <ErrorBoundary scope="screen" region="This screen">
          <FormWithPanel
            panel={
              <button type="button" onClick={() => { setBroken(true); }}>
                Look up
              </button>
            }
          />
          <Boom when={broken} />
        </ErrorBoundary>
      );
    }
    render(<Screen />);
    await userEvent.type(screen.getByLabelText('Latitude'), '41.8781');
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));

    expect(screen.getByText('What was in the fields when it failed')).toBeInTheDocument();
    expect(screen.getByText('Latitude')).toBeInTheDocument();
    expect(screen.getByText('41.8781')).toBeInTheDocument();
    // And it still does not pretend the form is coming back.
    expect(
      screen.getByText(/no longer in the form, and no button here can put it back/),
    ).toBeInTheDocument();
  });

  it('says nothing about a rescue when there was nothing in the fields to rescue', () => {
    render(
      <ErrorBoundary scope="screen" region="This screen">
        <input aria-label="Latitude" defaultValue="" />
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.queryByText('What was in the fields when it failed')).not.toBeInTheDocument();
    expect(screen.queryByText(/printed below/)).not.toBeInTheDocument();
  });

  /**
   * THE ONE EXCLUSION THAT IS A SECURITY DECISION. The sign-in and sign-up forms are inside the
   * app boundary, and a crash panel that prints the password back onto the screen — on a shared
   * lecture-hall projector, which is where this product is used — is worse than the crash.
   */
  it('never rescues a password, a hidden field or a checkbox', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <label for="p">Password</label><input id="p" type="password" value="hunter2">
      <input type="hidden" name="csrf" value="tok">
      <label for="c">Remember me</label><input id="c" type="checkbox" checked>
      <label for="e">Email</label><input id="e" type="email" value="member@example.com">
    `;
    document.body.appendChild(root);
    // `value` set through the attribute is what `innerHTML` gives us; the property is what a
    // person's typing sets, so both are exercised — the email below is read as a property.
    (root.querySelector('#p') as HTMLInputElement).value = 'hunter2';
    (root.querySelector('#e') as HTMLInputElement).value = 'member@example.com';

    expect(rescueFields(root)).toEqual([{ label: 'Email', value: 'member@example.com' }]);
    root.remove();
  });

  it('labels a value the way a screen reader would name its field', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <label for="a">Latitude</label><input id="a">
      <label>Longitude <input id="b"></label>
      <input id="c" aria-label="Field of study">
      <input id="d" placeholder="Callsign">
      <input id="e" name="orgName">
      <input id="f">
      <label for="g">Degree level</label>
      <select id="g"><option value="">—</option><option value="GRAD" selected>Graduate</option></select>
      <label for="h">Gender</label>
      <select id="h"><option value="" selected>Not stated</option><option value="F">Woman</option></select>
    `;
    document.body.appendChild(root);
    for (const [id, value] of [
      ['a', '41.8781'],
      ['b', '-87.6298'],
      ['c', 'Electrical engineering'],
      ['d', 'W9XYZ'],
      ['e', 'Hamfest Club'],
      ['f', 'no name at all'],
    ] as const) {
      (root.querySelector(`#${id}`) as HTMLInputElement).value = value;
    }

    expect(rescueFields(root)).toEqual([
      { label: 'Latitude', value: '41.8781' },
      { label: 'Longitude', value: '-87.6298' },
      { label: 'Field of study', value: 'Electrical engineering' },
      { label: 'Callsign', value: 'W9XYZ' },
      { label: 'orgName', value: 'Hamfest Club' },
      { label: 'Unnamed field', value: 'no name at all' },
      // The option's WORDS, not the contract literal `GRAD` the select carries as its value.
      { label: 'Degree level', value: 'Graduate' },
      /*
        AND NOTHING FOR `Gender`, which is the last entry in the fragment above and is deliberately
        absent from this list. Its placeholder option reads "Not stated" and carries `value=""`, so
        an emptiness test done on the option's WORDS rescues it — measured in Chromium against the
        real profile screen, that put nine unset selects into the panel as "Not stated" and buried
        the three lines the applicant had actually typed under them. A rescue that lists work
        nobody did is the same kind of untruth as a fallback that says "something went wrong".
      */
    ]);
    root.remove();
  });
});

describe('where App.tsx puts them', () => {
  /**
   * WHAT THIS GUARD IS FOR, AND WHY IT IS SOURCE TEXT RATHER THAN A RENDER.
   *
   * Every test above proves the COMPONENT. None of them proves it is mounted anywhere, and a
   * boundary that is not mounted is exactly the defect this task was given: `packages/web/src`
   * had none, the suite was green, and the blank page was only found by a person driving a
   * browser. `App.test.tsx` renders the composed app, but it cannot make a route throw without
   * editing that route, so it cannot see a deleted boundary either.
   *
   * So the placement is asserted as text, the way `AppShell.test.tsx` asserts that no route opens
   * a second `<main>`. It can be fooled by anyone determined to fool it, and it cannot check that
   * the boundary WORKS there — the browser run in the commit message did that. What it does catch
   * is the ordinary way this regresses: someone refactoring `App.tsx` drops a wrapper, and nothing
   * else in the suite changes colour.
   */
  const appSource = readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'App.tsx'), 'utf8')
    // Comments quote these very lines; a guard that fires on its own documentation gets deleted.
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');

  it('wraps the routes in a screen boundary, inside the shell so the rail survives', () => {
    expect(appSource).toMatch(
      /<ErrorBoundary scope="screen" region="This screen" resetKey=\{pathname\}>\s*<Routes>/,
    );
    // Inside `AppShell`, not around it: outside, a route crash would take the navigation with it
    // and the only way out would be the browser's Back button.
    expect(appSource.indexOf('<AppShell>')).toBeLessThan(
      appSource.indexOf('<ErrorBoundary scope="screen"'),
    );
  });

  it('wraps the router and the session provider in a last-line boundary', () => {
    expect(appSource).toMatch(/<ErrorBoundary scope="app" region="GrantSpotter">\s*<BrowserRouter>/);
    // The signed-out pages are returned INSTEAD of the shell, so this is the only boundary above
    // them; if it ever moves inside the router they lose their cover silently.
    expect(appSource.indexOf('<ErrorBoundary scope="app"')).toBeLessThan(
      appSource.indexOf('<BrowserRouter>'),
    );
  });
});

describe('the fallback is a screen like any other', () => {
  /**
   * A crash panel is the one screen nobody designs and everybody eventually reads, and it is drawn
   * at the exact moment the person is least able to work around a defect in it. `test/a11y.test.tsx`
   * audits nine routes and cannot audit this one — it only exists after a throw — so the same audit
   * is run here.
   *
   * The `h1`/`h2` split is the substantive part. `screen` and `app` replace a route that owned the
   * page's only `h1`, so they carry one; `panel` sits inside a route that still has its own and
   * takes `h2`, which is also why the rescue heading moves from `h2` to `h3` with it.
   */
  it.each([
    ['app', 1],
    ['screen', 1],
    ['panel', 0],
  ] as const)('%s scope: no a11y findings, and %i h1 of its own', (scope, h1Count) => {
    const { container } = render(
      <ErrorBoundary scope={scope} region="This screen" reload={() => undefined}>
        <input aria-label="Latitude" defaultValue="41.8781" />
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.querySelectorAll('h1')).toHaveLength(h1Count);
    // `auditA11y` reports "no <h1>" for a fragment, which the panel scope legitimately is: it is
    // audited as part of a page in `a11y.test.tsx`'s sense, not as a page.
    const findings = auditA11y(container).filter((f) => f !== 'no <h1>');
    expect(findings).toEqual([]);
  });
});

describe('getting out of the failure', () => {
  it('re-draws the children when the button is pressed and the cause has gone away', async () => {
    function Screen(): JSX.Element {
      const [broken, setBroken] = useState(true);
      return (
        <>
          <button type="button" onClick={() => { setBroken(false); }}>
            Fix it
          </button>
          <ErrorBoundary scope="panel" region="The callsign lookup">
            <Boom when={broken} />
          </ErrorBoundary>
        </>
      );
    }
    render(<Screen />);
    expect(screen.getByText(/The callsign lookup stopped working/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Fix it' }));
    await userEvent.click(screen.getByRole('button', { name: 'Draw this panel again' }));

    expect(screen.getByText('the panel is fine')).toBeInTheDocument();
    expect(screen.queryByText(/stopped working/)).not.toBeInTheDocument();
  });

  /**
   * WHY `resetKey` IS NOT OPTIONAL IN `App.tsx`.
   *
   * A boundary holds its error until something clears it. Without this, a crash on `/profile`
   * would leave the crash message on screen for the rest of the session: the rail is outside the
   * boundary and still clickable, so the URL would change, the route would change, and the same
   * message would stay — navigation that visibly does nothing. The pathname is the reset key, so
   * arriving at a different screen draws that screen.
   */
  it('clears itself when the resetKey changes, which is how the rail still works after a crash', () => {
    const { rerender } = render(
      <ErrorBoundary scope="screen" region="This screen" resetKey="/profile">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/This screen stopped working/)).toBeInTheDocument();

    rerender(
      <ErrorBoundary scope="screen" region="This screen" resetKey="/calendar">
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('the panel is fine')).toBeInTheDocument();
    expect(screen.queryByText(/stopped working/)).not.toBeInTheDocument();
  });

  /**
   * Focus, and the deliberate asymmetry in it. When the screen goes, the element the person was
   * in went with it and focus has fallen to `<body>`; moving it to the message is the only way a
   * keyboard or screen-reader user is told anything at all. When only a panel goes, the rest of
   * the form is alive and they may be typing in it — so the panel scope announces through
   * `role="alert"` and takes nothing.
   */
  it('takes focus when the screen goes, and refuses to take it when only a panel goes', async () => {
    function Screen({ scope }: { scope: 'screen' | 'panel' }): JSX.Element {
      const [broken, setBroken] = useState(false);
      return (
        <FormWithPanel
          panel={
            <>
              <button type="button" onClick={() => { setBroken(true); }}>
                Look up
              </button>
              <ErrorBoundary scope={scope} region="The callsign lookup">
                <Boom when={broken} />
              </ErrorBoundary>
            </>
          }
        />
      );
    }

    const panelView = render(<Screen scope="panel" />);
    const latitude = screen.getByLabelText('Latitude');
    latitude.focus();
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    // The click moved focus to the button, as a click does. What matters is that the boundary
    // did not then move it again, and that the message is announced without it.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Look up' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The callsign lookup stopped working');
    panelView.unmount();

    render(<Screen scope="screen" />);
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(document.activeElement).toHaveTextContent('The callsign lookup stopped working');
  });
});
