import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createIcsToken, getIcsToken, revokeIcsToken, exportHref,
  type IcsTokenCreated,
} from '../api/exports.js';
import '../components/exports.css';

/**
 * The one opt-in spelling the calendar routes recognise, matching `?watched=1` on the one-off
 * downloads. Written once here so the URL this screen hands a user and the URL the server answers
 * cannot drift apart — that drift is what this whole surface is repairing.
 */
const WATCHED_ONLY_QUERY = '?watched=1';

export function ExportsRoute(): JSX.Element {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [created, setCreated] = useState<IcsTokenCreated | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getIcsToken()
      .then((status) => setHasToken(status !== null))
      .catch((err: Error) => setError(err.message));
  }, []);

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
        <div className="export-links">
          <a className="btn" download href={exportHref('/api/exports/opportunities.csv')}>Opportunities (CSV)</a>
          <a className="btn" download href={exportHref('/api/exports/opportunities.xlsx')}>Opportunities (XLSX)</a>
        </div>
      </section>

      <section className="panel card" aria-label="Eligibility report">
        <h2>Eligibility report</h2>
        <p className="export-note">
          &ldquo;Here is what I am eligible for, and the specific constraint that excludes me from
          the rest.&rdquo; It needs a profile — the report is computed against yours, so{' '}
          <Link to="/profile">set one up</Link> first if you have not.
        </p>
        <div className="export-links">
          <a className="btn" download href={exportHref('/api/exports/eligibility.csv')}>Eligibility report (CSV)</a>
          <a className="btn" target="_blank" rel="noopener noreferrer" href={exportHref('/api/exports/eligibility.html')}>
            Printable eligibility report
          </a>
        </div>
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
        <div className="export-links">
          <a className="btn" download href={exportHref('/api/exports/deadlines.ics')}>One-off .ics</a>
          <a className="btn" download href={exportHref('/api/exports/deadlines.ics', new URLSearchParams({ watched: '1' }))}>
            One-off .ics (watchlist only)
          </a>
        </div>

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
