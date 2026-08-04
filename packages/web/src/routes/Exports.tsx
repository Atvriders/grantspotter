import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createIcsToken, getIcsToken, revokeIcsToken, exportHref,
  type IcsTokenCreated,
} from '../api/exports.js';
import '../components/exports.css';

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
          The feed's SCOPE follows the watchlist, and saying so is not optional. `/calendar/:token`
          serves every publishable deadline while the watchlist is empty and only the watched
          programmes as soon as it is not — measured on a fresh install: 252 events with nothing
          starred, 2 with one programme starred, 252 again after un-starring it. The URL never
          changes, so a subscriber who stars their first programme sees their calendar collapse
          overnight with nothing on screen to explain it. The one-off downloads let the user pick
          between the two; the feed decides for them, so the feed has to say what it decided.
        */}
        <p className="export-note">
          The feed follows your watchlist. While you are watching nothing it carries every deadline
          here; star one programme and it narrows to what you star. The URL does not change when it
          switches, so a calendar you subscribed to earlier will simply start showing fewer events.
          Use the one-off downloads below to take a copy of either.
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
          <p>
            <label htmlFor="ics-url" className="eyebrow">Subscribe URL</label>
            <input id="ics-url" className="token-field" readOnly value={created.url} />
            <span className="export-note">
              This is shown once and only once: the server stores a SHA-256 hash of the token, never
              the token. Lost it? Rotate, and re-subscribe with the new URL.
            </span>
          </p>
        )}

        {hasToken === true && created === null && (
          <p className="export-note">A calendar feed already exists for this account. Its URL was shown once, at creation.</p>
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
