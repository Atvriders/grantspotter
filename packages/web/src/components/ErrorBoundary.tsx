import { Component, createRef } from 'react';
import type { ErrorInfo, ReactNode, RefObject } from 'react';
import '../styles/boundary.css';

/**
 * THE ONE THING A RENDER THROW MUST NOT DO ANY MORE: TAKE THE WHOLE DOCUMENT WITH IT.
 *
 * Measured before this file existed, in Chromium, with one component made to throw inside the
 * profile screen's callsign panel: `document.body.innerText` came back as the empty string, the
 * page held ZERO inputs, and the applicant's typed-but-unsaved Latitude, Longitude and Field of
 * study were gone — not blanked, gone, because the elements holding them no longer existed. React
 * does that by design: an error that reaches the root unmounts the entire tree, and this app has
 * no boundary anywhere in `packages/web/src` to stop it short of the root.
 *
 * WHAT A BOUNDARY CAN AND CANNOT DELIVER, stated first so nothing below over-claims.
 *
 * React hands a boundary two things: the subtree it owns, and the error. It does NOT hand back the
 * user's form state. Anything held in React state inside the failing subtree is destroyed with it,
 * and no fallback can reconstruct it. So the amount of a person's work a boundary saves is decided
 * ENTIRELY by where it is placed, and by nothing else:
 *
 *   panel   the failure is contained to one region. Everything around it — including every field
 *           the person has typed into and not saved — is untouched, because React only unmounts
 *           the boundary's own children. This is the placement that actually preserves work.
 *   screen  the route is gone, so the route's form is gone with it. What survives is the shell:
 *           the navigation still works, and the person is looking at a sentence instead of a
 *           white rectangle. Real, and much less than the panel case.
 *   app     the last line. Nothing survives but the message and a reload.
 *
 * Measured in Chromium at 1280x900, driving the REAL `App` and the real profile form with a
 * latitude, a longitude and a field of study typed into it and the callsign panel then forced to
 * throw. The same three placements, same throw, same typing (the numbers are in the commit
 * message; the fallback was re-measured at 320px for the sideways-scroll rule and does not move
 * the page):
 *   · no boundary          body.innerText '' · 0 inputs on the page · no Latitude element
 *   · screen boundary      fallback + rail · 0 inputs · no Latitude element · values printed
 *   · panel boundary       fallback inside the panel · 21 inputs · Latitude still reads 41.8781
 * That third line is the whole argument for pushing boundaries down to the panels, and it is why
 * this component is exported with a `panel` scope rather than being an App-only detail.
 *
 * THE PLACEMENT THAT IS NOT MADE YET, written down because a measured difference this large should
 * not live only in a report. `routes/Profile.tsx` renders `<CallsignLookup …/>` inside the profile
 * form; wrapping that ONE element in
 *
 *     <ErrorBoundary scope="panel" region="The callsign lookup"> … </ErrorBoundary>
 *
 * is what turns the second line of the table above into the third for the screen where this
 * product's applicants do their typing. The same argument applies to any other panel that renders
 * a server payload beside a form. `App.tsx` cannot do it: it composes routes, not the insides of
 * them.
 *
 * WHAT THIS FILE ADDS ON TOP OF THE THREE PLACEMENTS: THE FIELD RESCUE.
 *
 * When the screen goes, the typed values are unrecoverable from React — but for one moment they
 * are still in the DOM. React's commit phase deletes the old nodes AFTER `getSnapshotBeforeUpdate`
 * runs, and that lifecycle exists for exactly this: reading the DOM that is about to be replaced.
 * So on the render that swaps children for fallback, this boundary walks its own subtree and
 * copies out every non-empty field value with the label that named it, and prints them in the
 * fallback. That does not restore the form and this component never says it does — the words on
 * screen are "no button here can put it back" — but it turns "your last ten minutes are gone" into
 * ten minutes of text a person can copy before they reload. If the rescue comes back empty the
 * fallback simply does not mention it; it never claims a rescue it did not make.
 *
 * Passwords are excluded by type, and so is every input that holds no typing (checkbox, radio,
 * file, hidden, button). A crash message that prints someone's password back at them on a shared
 * lecture-hall projector is a worse bug than the crash.
 *
 * WHY THERE IS NO CRASH REPORTER, argued rather than assumed.
 *
 * FOR: the operator of a self-hosted instance currently learns NOTHING about a client-side crash.
 * A `POST /api/client-errors` would let them see it. AGAINST, and decisive: (1) it is a new
 * unauthenticated write surface on a product that is careful about those, and this deployment sits
 * behind a Cloudflare Tunnel, so every caller shares one `req.ip` — a per-IP rate limit on such an
 * endpoint either throttles a whole lecture hall at once or throttles nobody, and neither is a
 * usable defence for an endpoint that accepts arbitrary attacker-chosen strings; (2) the payload is
 * a stack trace off a page the user was typing into, which is the one class of data most likely to
 * carry their own words; (3) a client-only half of the feature — a `fetch` to a route the server
 * does not serve — is worse than nothing, because it looks like reporting and 404s.
 *
 * So the report goes where the operator can actually reach it without a new surface: `console.error`
 * with the component stack (the bundle ships source maps, `vite.config.ts`), and a `<details>` in
 * the fallback holding the same text, which the person on the phone to the operator can read out or
 * paste. The fallback says plainly that nothing was sent anywhere, so nobody waits for a report
 * that is not coming.
 */

export type BoundaryScope = 'app' | 'screen' | 'panel';

/** One field's worth of typing, taken out of the DOM in the instant before React deleted it. */
export interface RescuedField {
  label: string;
  value: string;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  scope: BoundaryScope;
  /**
   * What this boundary owns, in the words the person on the screen would use: "This screen",
   * "The callsign lookup". It is read straight into the heading, so it starts the sentence
   * "<region> stopped working" and must be capitalised for that position.
   */
  region: string;
  /**
   * Change this to clear a caught error. `App.tsx` passes the pathname, which is what makes the
   * screen boundary worth having: without it a caught error is permanent for the life of the
   * page, the rail would still be on screen and clicking it would change the URL and nothing
   * else — a navigation bar that visibly does nothing is a worse screen than the blank one.
   */
  resetKey?: string;
  /** Test seam. Defaults to `console.error`; see the reporter argument above. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Test seam for the `app` scope's reload, which jsdom does not implement. */
  reload?: () => void;
}

interface BoundaryState {
  error: Error | null;
  componentStack: string;
  rescued: RescuedField[];
}

/**
 * The `type` values worth rescuing: the ones a person TYPES into. `password` is excluded on
 * purpose and is the one exclusion that is a security decision rather than a tidiness one.
 * A missing `type` attribute is a text input, hence the empty string.
 */
const TYPED_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'url',
  'email',
  'tel',
  'number',
  'date',
  'month',
  'week',
  'time',
  'datetime-local',
]);

/** Long enough for a paragraph of a draft answer, short enough that the message stays readable. */
const MAX_VALUE_CHARS = 600;
const MAX_LABEL_CHARS = 80;
/** A crash message is not a form dump. Beyond this the page stops being a message. */
const MAX_RESCUED_FIELDS = 40;

function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The name a person would recognise this field by, resolved the way a screen reader resolves it:
 * `<label for>`, then a wrapping `<label>`, then `aria-label`/`aria-labelledby`, then the
 * placeholder, then the `name` attribute. A value printed under "Field" is nearly useless, so this
 * tries every naming route the codebase actually uses before it falls back to that.
 */
function fieldLabel(el: Element): string {
  const doc = el.ownerDocument;
  const id = el.getAttribute('id');
  if (id !== null && id !== '') {
    for (const label of doc.querySelectorAll('label[for]')) {
      // Attribute comparison, never a `label[for="${id}"]` selector: an id carrying a quote or a
      // bracket turns that template into a SyntaxError, and this code runs while the page is
      // already broken. `test/a11y.ts` avoids the same trap for the same reason.
      if (label.getAttribute('for') === id) return collapse(label.textContent ?? '', MAX_LABEL_CHARS);
    }
  }
  const wrapping = el.closest('label');
  if (wrapping !== null) return collapse(wrapping.textContent ?? '', MAX_LABEL_CHARS);
  const aria = el.getAttribute('aria-label');
  if (aria !== null && aria.trim() !== '') return collapse(aria, MAX_LABEL_CHARS);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy !== null && labelledBy.trim() !== '') {
    const named = labelledBy
      .split(/\s+/)
      .map((ref) => doc.getElementById(ref)?.textContent ?? '')
      .join(' ');
    if (named.trim() !== '') return collapse(named, MAX_LABEL_CHARS);
  }
  const placeholder = el.getAttribute('placeholder');
  if (placeholder !== null && placeholder.trim() !== '') return collapse(placeholder, MAX_LABEL_CHARS);
  const name = el.getAttribute('name');
  if (name !== null && name.trim() !== '') return collapse(name, MAX_LABEL_CHARS);
  return 'Unnamed field';
}

/**
 * Every non-empty field value inside `root`, with the label that named it.
 *
 * Exported so its rules can be tested directly on a DOM fragment — the alternative is proving the
 * password exclusion only through a rendered crash, and an exclusion that matters this much
 * deserves a test that names it.
 */
export function rescueFields(root: HTMLElement | null): RescuedField[] {
  if (root === null) return [];
  const out: RescuedField[] = [];
  for (const el of root.querySelectorAll('input, textarea, select')) {
    if (out.length >= MAX_RESCUED_FIELDS) break;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (!TYPED_INPUT_TYPES.has(type)) continue;
    }
    let value = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value ?? '';
    /*
      A SELECT IS EMPTY WHEN ITS VALUE IS EMPTY, WHATEVER ITS FIRST OPTION SAYS.

      Measured in Chromium against the real profile form: every unset select on that screen
      rendered into the rescue as "License class — Not stated", "Gender — Not stated", nine of
      them, because the placeholder option carries `value=""` and the WORDS "Not stated". A
      rescue that lists nine fields nobody filled in is claiming to have saved work that was
      never done, and it buries the three lines that were. So the emptiness test is on the value,
      and the words are only substituted once something is actually selected — because a profile
      select's value is a contract literal (`GRAD`), and printing that at a person who is already
      having a bad minute is printing a machine name at them.
    */
    if (value.trim() === '') continue;
    if (tag === 'select') {
      const selected = (el as HTMLSelectElement).selectedOptions;
      const first = selected.length > 0 ? selected[0] : undefined;
      const text = first?.textContent ?? '';
      if (text.trim() !== '') value = text;
    }
    out.push({ label: fieldLabel(el), value: collapse(value, MAX_VALUE_CHARS) });
  }
  return out;
}

function reportToConsole(error: Error, info: ErrorInfo): void {
  // eslint-disable-next-line no-console
  console.error('GrantSpotter: a component threw while rendering.', error, info.componentStack);
}

/** What happened, in one sentence, differing only in how much of the page it took. */
function whatHappened(scope: BoundaryScope): string {
  if (scope === 'panel') {
    return 'Only this part of the page was removed. Everything around it is still on screen and still works.';
  }
  if (scope === 'screen') {
    return 'This screen could not be drawn, so React removed the whole of it. Nothing outside it was touched: the navigation is still there and every other screen still works.';
  }
  return 'GrantSpotter could not draw the page at all. This failed in your browser, not on the server, so nothing that was already saved has been changed by it.';
}

/**
 * What it cost the person, said plainly.
 *
 * "Something went wrong" is the industry's way of saying nothing, and its real damage is that it
 * leaves the reader to guess whether their typing survived. These sentences answer that, and they
 * answer it differently for each placement because the true answer IS different for each one.
 */
function whatWasLost(scope: BoundaryScope, rescuedCount: number): string {
  const rescued =
    rescuedCount > 0
      ? ' The fields were still readable at the moment it failed, so what was in them is printed below — copy anything you need before you leave this page.'
      : '';
  if (scope === 'panel') {
    return `Anything you have typed elsewhere on this page is still there and still unsaved — React only removes the part of the page the failure happened inside. What this panel itself was holding is gone.${rescued}`;
  }
  if (scope === 'screen') {
    return `Anything you had typed on this screen and not saved is no longer in the form, and no button here can put it back.${rescued}`;
  }
  return `Everything that was on screen is gone, including anything you had typed and not saved. Reloading starts the app again; it cannot bring the typing back.${rescued}`;
}

/** What the button will really do — never "try again" with an implied "and it will work". */
function whatTheButtonDoes(scope: BoundaryScope): string {
  if (scope === 'panel') {
    return 'Re-drawing this panel leaves the rest of the page, and your typing in it, alone. If the same thing breaks it again, the cause is in the data behind the panel and pressing this will not get past it.';
  }
  if (scope === 'screen') {
    return 'Re-drawing this screen starts it from nothing. If what broke it is in the data behind the screen it will break the same way again, and either way it cannot restore your typing. Opening another screen from the navigation also clears this message.';
  }
  return 'If it fails the same way immediately after the reload, the cause is still there and the operator of this instance needs the detail below.';
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  BoundaryState,
  RescuedField[] | null
> {
  /** The wrapper around the children, so the rescue has a subtree to read. */
  private readonly host: RefObject<HTMLDivElement> = createRef();

  /** The fallback panel, so focus can be moved to it when the page it was on is destroyed. */
  private readonly fallback: RefObject<HTMLElement> = createRef();

  public override state: BoundaryState = { error: null, componentStack: '', rescued: [] };

  public static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    (this.props.onError ?? reportToConsole)(error, info);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  /**
   * THE RESCUE, TAKEN AT THE ONLY MOMENT IT EXISTS.
   *
   * React's commit phase runs `getSnapshotBeforeUpdate` BEFORE it mutates the DOM, which is why
   * this and not `componentDidCatch`: by the time `componentDidCatch` runs the children have
   * already been deleted and `this.host.current` holds a detached, empty node. Here the old
   * subtree is still in the document with every value the person typed.
   */
  public override getSnapshotBeforeUpdate(
    _prevProps: ErrorBoundaryProps,
    prevState: BoundaryState,
  ): RescuedField[] | null {
    if (prevState.error === null && this.state.error !== null) return rescueFields(this.host.current);
    return null;
  }

  public override componentDidUpdate(
    prevProps: ErrorBoundaryProps,
    prevState: BoundaryState,
    snapshot: RescuedField[] | null,
  ): void {
    if (snapshot !== null && snapshot.length > 0 && this.state.rescued.length === 0) {
      this.setState({ rescued: snapshot });
    }
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.reset();
      return;
    }
    /*
      FOCUS, BUT ONLY WHERE THE FOCUS WAS DESTROYED ANYWAY.

      For `app` and `screen` the element the person was in is gone, so focus has fallen to
      `<body>` and a keyboard or screen-reader user is nowhere; moving them to the message is the
      only courteous thing to do. For `panel` it would be HOSTILE — the rest of the form is alive
      and they may be typing in it right now — so the panel fallback carries `role="alert"`
      instead and announces without stealing anything.
    */
    if (prevState.error === null && this.state.error !== null && this.props.scope !== 'panel') {
      this.fallback.current?.focus();
    }
  }

  private readonly reset = (): void => {
    this.setState({ error: null, componentStack: '', rescued: [] });
  };

  private readonly onReload = (): void => {
    (this.props.reload ?? (() => {
      window.location.reload();
    }))();
  };

  public override render(): JSX.Element {
    const { children, scope, region } = this.props;
    const { error, componentStack, rescued } = this.state;

    if (error === null) {
      /*
        `display: contents` in boundary.css, so this wrapper generates no box and the routes
        inside it lay out exactly as they did when they were `main`'s direct children. It exists
        for one reason: `getSnapshotBeforeUpdate` needs a handle on the subtree that is about to
        be deleted, and a boundary with no element of its own has nowhere to hold one.
      */
      return (
        <div className="boundary-host" ref={this.host}>
          {children}
        </div>
      );
    }

    // The screen and the whole app both lose the page's `<h1>` when their subtree goes, and a
    // page with no `h1` reads as a fragment (`test/a11y.ts` says so in as many words). A panel
    // sits inside a screen that still has one, so it takes `h2`.
    const Title = scope === 'panel' ? 'h2' : 'h1';
    const RescueTitle = scope === 'panel' ? 'h3' : 'h2';

    return (
      <section
        className={`boundary boundary-${scope}`}
        ref={this.fallback}
        tabIndex={-1}
        {...(scope === 'panel' ? { role: 'alert' } : {})}
      >
        <Title className="boundary-title">{region} stopped working</Title>
        <p className="boundary-what">{whatHappened(scope)}</p>
        <p className="boundary-loss">{whatWasLost(scope, rescued.length)}</p>

        {rescued.length > 0 && (
          <div className="boundary-rescue">
            <RescueTitle className="boundary-rescue-title">
              What was in the fields when it failed
            </RescueTitle>
            <dl className="boundary-fields">
              {rescued.map((field) => (
                <div className="boundary-field" key={`${field.label}:${field.value}`}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div className="boundary-actions">
          {scope === 'app' ? (
            <button type="button" className="btn btn-primary" onClick={this.onReload}>
              Reload GrantSpotter
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={this.reset}>
              {scope === 'panel' ? 'Draw this panel again' : 'Draw this screen again'}
            </button>
          )}
          <p className="boundary-note">{whatTheButtonDoes(scope)}</p>
        </div>

        <details className="boundary-detail">
          <summary>Technical detail, for whoever runs this instance</summary>
          <pre className="boundary-stack">
            {`${error.name}: ${error.message}${componentStack}`}
          </pre>
          <p className="boundary-note">
            Nothing about this failure was sent anywhere. GrantSpotter has no crash reporting, so
            this text and the browser console are the only record of it — copy it into your report
            if you are telling someone about this.
          </p>
        </details>
      </section>
    );
  }
}
