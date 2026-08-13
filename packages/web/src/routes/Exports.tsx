import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createIcsToken, getIcsToken, revokeIcsToken, downloadExport, exportHref,
  type IcsTokenCreated,
} from '../api/exports.js';
import { apiGet } from '../api/client.js';
import '../components/exports.css';

/**
 * The one opt-in spelling the calendar routes recognise, matching `?watched=1` on the one-off
 * downloads. Written once here so the URL this screen hands a user and the URL the server answers
 * cannot drift apart — that drift is what this whole surface is repairing.
 */
const WATCHED_ONLY_QUERY = '?watched=1';

/** The three panels, so a message about a download lands beside the control that made it. */
type Panel = 'opportunities' | 'eligibility' | 'calendar';

interface PanelMessage {
  panel: Panel;
  /** `refused` is the server saying no; `empty` is a real answer with nothing in it. */
  kind: 'saved' | 'empty' | 'refused';
  text: string;
}

/**
 * WHAT A DOWNLOAD CONTROL IS, ON THIS SCREEN.
 *
 * `noun` and `nothing` exist because "0" is only meaningful in the words of the thing pressed: an
 * opportunities export with no rows means the corpus or the filters matched nothing, while a
 * watchlist calendar with no events means the user has not starred anything — same number, two
 * unrelated instructions to the reader. The sentence is therefore written per control rather than
 * assembled from a template, and none of them says "an error occurred".
 */
interface ExportControl {
  label: string;
  panel: Panel;
  path: string;
  query?: URLSearchParams;
  fallbackFilename: string;
  noun: string;
  nothing: string;
}

const CONTROLS: ExportControl[] = [
  {
    label: 'Opportunities (CSV)',
    panel: 'opportunities',
    path: '/api/exports/opportunities.csv',
    fallbackFilename: 'grantspotter-opportunities.csv',
    noun: 'programmes',
    nothing:
      'There is nothing to export: this GrantSpotter is publishing no programmes at all, ' +
      'so no file was written.',
  },
  {
    label: 'Opportunities (XLSX)',
    panel: 'opportunities',
    path: '/api/exports/opportunities.xlsx',
    fallbackFilename: 'grantspotter-opportunities.xlsx',
    noun: 'programmes',
    nothing:
      'There is nothing to export: this GrantSpotter is publishing no programmes at all, ' +
      'so no file was written.',
  },
  {
    label: 'Eligibility report (CSV)',
    panel: 'eligibility',
    path: '/api/exports/eligibility.csv',
    fallbackFilename: 'grantspotter-eligibility.csv',
    noun: 'programmes',
    nothing:
      'The report came back with no programmes in it at all, which is not the same as ' +
      '“you qualify for nothing” — an empty report would read that way, so no file was written.',
  },
  {
    label: 'One-off .ics',
    panel: 'calendar',
    path: '/api/exports/deadlines.ics',
    fallbackFilename: 'grantspotter-deadlines.ics',
    noun: 'dates',
    nothing:
      'That calendar would have contained no dates, so no file was written. Every publishable ' +
      'deadline here is either undated or outside the window this file covers.',
  },
  {
    label: 'One-off .ics (watchlist only)',
    panel: 'calendar',
    path: '/api/exports/deadlines.ics',
    query: new URLSearchParams({ watched: '1' }),
    fallbackFilename: 'grantspotter-deadlines.ics',
    noun: 'dates',
    nothing:
      'Your watchlist has no dated deadlines in it, so that calendar would have been empty and ' +
      'no file was written. Star an opportunity and it will appear here.',
  },
];

interface ProfilesResponse {
  student: unknown | null;
  organization: unknown | null;
}

export function ExportsRoute(): JSX.Element {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [created, setCreated] = useState<IcsTokenCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<PanelMessage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * `null` while unknown, and unknown is NOT "no": a probe that failed must never be the reason a
   * control refuses to run. The server is the authority on whether a report can be built — this
   * only lets the screen say so before the user presses anything, instead of after.
   */
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);

  useEffect(() => {
    getIcsToken()
      .then((status) => setHasToken(status !== null))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    apiGet<ProfilesResponse>('/api/profiles')
      .then((body) => setHasProfile(body.student !== null || body.organization !== null))
      // Deliberately silent, and deliberately not `false`. The eligibility controls stay live and
      // the server answers for itself; a failed probe is not news the user can act on.
      .catch(() => setHasProfile(null));
  }, []);

  /**
   * PRESS, THEN REPORT — the whole of the fix on this side.
   *
   * Every outcome ends in a sentence on this page: the file that landed and how much is in it, the
   * reason there is no file, or the server's own refusal. `downloadExport` writes nothing unless
   * the response is the file, so "the screen says nothing happened" and "nothing happened" cannot
   * come apart the way they did when these were `<a download>` anchors.
   */
  async function run(control: ExportControl): Promise<void> {
    setBusy(control.label);
    setMessage(null);
    try {
      const outcome = await downloadExport(control.path, control.query, control.fallbackFilename);
      if (outcome.rows === 0) {
        setMessage({ panel: control.panel, kind: 'empty', text: control.nothing });
        return;
      }
      const count = outcome.rows === null ? '' : ` — ${String(outcome.rows)} ${control.noun}`;
      setMessage({
        panel: control.panel,
        kind: 'saved',
        text: `Saved ${outcome.filename ?? control.fallbackFilename}${count}.`,
      });
    } catch (err) {
      setMessage({ panel: control.panel, kind: 'refused', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  /*
    ONE DOWNLOAD AT A TIME, because there is one message. Two exports in flight would leave the
    reader with one sentence about one of them and no way to tell which — and the whole point of
    this screen's rebuild is that what it says and what happened cannot come apart. The pressed
    control also renames itself while it works, so a slow corpus does not read as a dead button.
  */
  function controlsFor(panel: Panel): JSX.Element[] {
    return CONTROLS.filter((c) => c.panel === panel).map((control) => (
      <button
        key={control.label}
        type="button"
        className="btn"
        disabled={busy !== null || (control.panel === 'eligibility' && hasProfile === false)}
        onClick={() => { void run(control); }}
      >
        {busy === control.label ? `${control.label}…` : control.label}
      </button>
    ));
  }

  function messageFor(panel: Panel): JSX.Element | null {
    if (message === null || message.panel !== panel) return null;
    return (
      <p
        className={message.kind === 'saved' ? 'export-note' : 'row-warning'}
        role={message.kind === 'refused' ? 'alert' : 'status'}
      >
        {message.text}
      </p>
    );
  }

  async function create(): Promise<void> {
    setError(null);
    try {
      const result = await createIcsToken();
      setCreated(result);
      setHasToken(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(): Promise<void> {
    setError(null);
    try {
      await revokeIcsToken();
      setCreated(null);
      setHasToken(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="exports-stack">
      <div>
        <p className="eyebrow">Exports</p>
        <h1>Take it with you</h1>
      </div>

      {error !== null && <p role="alert" className="row-warning">{error}</p>}

      <section className="panel card" aria-label="Opportunities">
        <h2>Opportunities</h2>
        <p className="export-note">
          These download the whole corpus. To export a narrower slice, set the filters on{' '}
          <Link to="/">Browse</Link> and use the export row there.
        </p>
        <div className="export-links">{controlsFor('opportunities')}</div>
        {messageFor('opportunities')}
      </section>

      <section className="panel card" aria-label="Eligibility report">
        <h2>Eligibility report</h2>
        <p className="export-note">
          &ldquo;Here is what I am eligible for, and the specific constraint that excludes me from
          the rest.&rdquo; It needs a profile — the report is computed against yours, so{' '}
          <Link to="/profile">set one up</Link> first if you have not.
        </p>
        {/*
          THE STATE THIS SECTION USED TO PROMISE ITS WAY THROUGH. The paragraph above already said
          "it needs a profile — set one up first if you have not", and then both controls fired
          anyway: the CSV anchor saved a 409 JSON body to disk under the name `eligibility.csv`,
          and the printable link opened a tab of that same raw JSON where a report had been
          promised. Saying it and then doing the other thing is worse than not saying it. With no
          profile on file the controls are OFF and the reason is on the screen — and the server
          refuses both routes on its own account besides (`api/exports.ts`), because this state can
          also be reached by URL and from a second tab.
        */}
        {hasProfile === false && (
          <p className="row-warning" role="status">
            There is no profile on this account yet, so there is no report to make: every verdict
            in it is computed against yours. <Link to="/profile">Set one up</Link> and both
            controls here start working.
          </p>
        )}
        <div className="export-links">
          {controlsFor('eligibility')}
          {hasProfile === false ? (
            <button type="button" className="btn" disabled>Printable eligibility report</button>
          ) : (
            <a className="btn" target="_blank" rel="noopener noreferrer" href={exportHref('/api/exports/eligibility.html')}>
              Printable eligibility report
            </a>
          )}
        </div>
        {messageFor('eligibility')}
        {/*
          THE PRINTABLE REPORT STAYS AN ANCHOR, and that is a decision rather than an oversight.
          Its whole job is to open a page in a tab, which is what an anchor does with the click the
          user actually made; a button that fetched first and called `window.open` afterwards would
          be opening a window outside the gesture, which is the shape browsers block. What it does
          not do any more is open a tab of JSON: the route answers its refusal as a readable page.
        */}
        <p className="export-note">
          The printable report opens in a new tab with its own <strong>Print / Save as PDF</strong>{' '}
          button. There is no server-side PDF renderer and deliberately no headless browser in the
          image; your own browser makes a better-looking file.
        </p>
      </section>

      <section className="panel card" aria-label="Add to calendar">
        <h2>Add to calendar</h2>
        <p className="export-note">
          A one-off <code>.ics</code> is a snapshot: it stops being true the moment a funder moves a
          date. The subscribable feed is the one that keeps working — your phone re-reads it about
          every twelve hours.
        </p>
        {/*
          THE FEED'S SCOPE IS PART OF THE URL, and which URL does what is not something this screen
          may leave unsaid. It used to be inferred from the watchlist's SIZE: `/calendar/:token`
          served every publishable deadline while nothing was starred and only the starred
          programmes as soon as something was — measured over the FIXTURE corpus, on the fixed
          clock `api/exportsCorpus.test.ts` pins, at 243 VEVENTs and then 5 from the same unchanged
          URL. (Which corpus is named on purpose: "this corpus" stood here unqualified and meant
          whichever one the reader assumed, and `data/seed/` — the corpus a fresh install actually
          serves — is a different population on a moving clock.) A subscriber who starred their
          first opportunity lost 238 deadlines out of a calendar they had already installed,
          silently and remotely, and the only screen that could have warned them is this one. There
          are two URLs now, each with a meaning that holds, and this is where the user chooses
          between them.
        */}
        <p className="export-note">
          Two feed URLs, and each one always means the same thing. The plain URL carries every
          publishable deadline here, however long your watchlist gets. Add{' '}
          <code>{WATCHED_ONLY_QUERY}</code> and it carries only the programmes you star &mdash;
          nothing at all, while you star
          nothing. You choose the scope when you subscribe and it stays chosen: starring an
          opportunity fills the watchlist feed, and it never empties the plain one.
        </p>
        {/*
          NO COUNT IN THIS SENTENCE, DELIBERATELY — the same decision `components/ExportMenu.tsx`
          took for the same claim, so the product says one thing about it in both places.

          It read "Only 4 of the 243 dated windows in this corpus are dates a funder has actually
          published". 4-of-243 is a real measurement, but of the FIXTURE corpus on a fixed clock
          (`exports/corpus.test.ts`), and a user reading this screen is looking at whatever corpus
          is installed. On `data/seed/`, which is what a fresh install serves, the figure is not a
          constant to correct: through this calendar's own two-year window it is 252 cycles with 2
          funder-published on 2026-08-04, 250 with 1 on 2026-10-01 and 248 with 0 on 2027-02-01,
          because the three seed records that declare a funder-published window simply age out.
          Two other totals for the same claim — 243 and 244 — were committed in this tree at once,
          which is what an unsourceable number does.

          This component holds a token and an error string; it renders no cycles, so unlike
          `Calendar` and `Watchlist` it has nothing to derive an honest figure FROM. What survives
          is the part that is proved: the split itself, and the four marks `exports/ics.ts` writes
          onto every projected event (`(estimated)` prefix, STATUS:TENTATIVE, X-GRANTSPOTTER-
          ESTIMATED and the DESCRIPTION note), which `exports/ics.test.ts` asserts one by one.
          `test/cycleCountCopy.test.ts` fails if a literal count comes back to this file, and
          `Exports.test.tsx` fails if one is assembled at render time out of pieces.
        */}
        <p className="export-note">
          Every date in these files says which of the two kinds it is: a window the funder
          published, or one GrantSpotter projected from the recurrence that program has followed.
          A projected event is marked four ways — an &ldquo;(estimated)&rdquo; title prefix, a
          tentative status, a custom property and a note in its description — so nothing here reads
          as a promise the funder made.
        </p>
        <div className="export-links">{controlsFor('calendar')}</div>
        {messageFor('calendar')}

        {hasToken === null && <p className="eyebrow">Checking…</p>}

        {hasToken === false && (
          <p>
            <button type="button" className="btn btn-primary" onClick={() => { void create(); }}>
              Create a calendar feed
            </button>
          </p>
        )}

        {created !== null && (
          <>
            <p>
              <label htmlFor="ics-url" className="eyebrow">Subscribe URL &mdash; every deadline</label>
              <input id="ics-url" className="token-field" readOnly value={created.url} />
              <span className="export-note">
                Every publishable deadline in GrantSpotter, whatever you star later. Take this one
                if you are unsure: a calendar carrying more than you need is noise you can see, and
                one quietly carrying less is a deadline you never hear about.
              </span>
            </p>
            {/*
              Built here rather than returned by the server: `created.url` is the only place the
              plaintext token is ever readable — the server keeps a SHA-256 hash and nothing else —
              and that URL carries no query of its own, so appending one is safe.
            */}
            <p>
              <label htmlFor="ics-url-watched" className="eyebrow">
                Watchlist feed &mdash; only what you star
              </label>
              <input
                id="ics-url-watched"
                className="token-field"
                readOnly
                value={`${created.url}${WATCHED_ONLY_QUERY}`}
              />
              <span className="export-note">
                The same feed, narrowed on purpose. It carries nothing while you are starring
                nothing, and grows as you star.
              </span>
            </p>
            <p className="export-note">
              Both are shown once and only once: the server stores a SHA-256 hash of the token,
              never the token. Lost them? Rotate, and re-subscribe with the new pair.
            </p>
          </>
        )}

        {hasToken === true && created === null && (
          <p className="export-note">
            A calendar feed already exists for this account. Its URLs were shown once, at creation
            &mdash; the plain one, and the same URL with <code>{WATCHED_ONLY_QUERY}</code> on the
            end for the watchlist-only variant. If you no longer have them, rotate and re-subscribe.
          </p>
        )}

        {hasToken === true && (
          <div className="export-links">
            <button type="button" className="btn" onClick={() => { void create(); }}>Rotate the feed URL</button>
            <button type="button" className="btn" onClick={() => { void revoke(); }}>Revoke the feed</button>
          </div>
        )}
      </section>
    </div>
  );
}
