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
          programmes as soon as something was — measured on this corpus at 243 events, then 5, from
          the same unchanged URL. A subscriber who starred their first opportunity lost 238
          deadlines out of a calendar they had already installed, silently and remotely, and the
          only screen that could have warned them is this one. There are two URLs now, each with a
          meaning that holds, and this is where the user chooses between them.
        */}
        <p className="export-note">
          Two feed URLs, and each one always means the same thing. The plain URL carries every
          publishable deadline here, however long your watchlist gets. Add{' '}
          <code>{WATCHED_ONLY_QUERY}</code> and it carries only the programmes you star &mdash;
          nothing at all, while you star
          nothing. You choose the scope when you subscribe and it stays chosen: starring an
          opportunity fills the watchlist feed, and it never empties the plain one.
        </p>
        <p className="export-note">
          Only 4 of the 243 dated windows in this corpus are dates a funder has actually published;
          the rest are this pipeline&rsquo;s projection from a prior cycle. Every projected event in
          the file is marked four ways — an &ldquo;(estimated)&rdquo; title prefix, a tentative
          status, a custom property and a note in its description — so nothing here reads as a
          promise the funder made.
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
