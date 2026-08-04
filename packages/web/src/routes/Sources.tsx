import { useState } from 'react';
import { useApi } from '../store/useApi.js';
import { apiSend, ApiError } from '../api/client.js';
import { formatDate } from '../lib/trust.js';
import { BLOCKED_HOSTS } from '../lib/safety.js';
import '../components/sources.css';

/**
 * PLAN-LOCAL mirror of `SourceHealthState` in `packages/server/src/api/sourcesRouter.ts`.
 * Restated rather than imported: the import direction is one-way, `web → core` and never
 * `web → server`.
 */
type HealthState = 'healthy' | 'idle' | 'yield_dropped' | 'failing' | 'stale' | 'never_polled';

const WORDS: Record<HealthState, string> = {
  healthy: 'Healthy',
  idle: 'Idle',
  yield_dropped: 'Yield dropped',
  failing: 'Failing',
  stale: 'Stale',
  never_polled: 'Never polled',
};

/** PLAN-LOCAL mirror of `SourceView`. */
export interface SourceRow {
  id: string;
  label: string;
  tier: string;
  funderId: string;
  enabled: boolean;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastRecordCount: number | null;
  /**
   * What this source is KNOWN to have yielded on a good run (`sources.baseline_record_count`).
   *
   * It is `null` on every row today, and that is a fact about the database rather than about the
   * sources: the column is declared in `001-init.sql` and WRITTEN BY NOTHING. It rides this
   * interface because the health logic already reads it and will state it the moment a crawl
   * writer fills it in — but until then this page renders no historical figure at all. A dormant
   * column drawn as a live measurement is the exact shape of claim this product refuses to make.
   */
  baselineRecordCount: number | null;
  /** The configured floor. **0 means UNSET**, not "a threshold of nothing, which is met". */
  expectedMinRecords: number;
  health: { state: HealthState; detail: string };
}

interface SourcesResponse {
  rows: SourceRow[];
  summary: { total: number; healthy: number; unhealthy: number };
  canConfigure: boolean;
}

interface CrawlRunSummary {
  sourceId: string;
  parsedCount: number;
  events: number;
  reviewItems: number;
  error?: string;
}

interface CrawlResponse {
  startedAt: string;
  finishedAt: string;
  results: CrawlRunSummary[];
}

/**
 * Per-row edit buffer, keyed by source id. Absent means "not yet touched".
 *
 * `expectedMinRecords` is held as the RAW STRING the user typed, not as a number. `Number('')` is
 * `0`, so parsing on every keystroke turns an emptied box into a silent "no minimum" — switching
 * a source's only yield alarm off while the field merely looks blank. It is parsed once, on save,
 * and an unparseable value is refused out loud.
 */
type Draft = Record<string, { expectedMinRecords: string; enabled: boolean }>;

function draftFrom(row: SourceRow): Draft[string] {
  return { expectedMinRecords: String(row.expectedMinRecords), enabled: row.enabled };
}

/** Whole seconds a crawl took, or null when the server's instants cannot be read. */
export function crawlSeconds(startedAt: string, finishedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.max(1, Math.round((end - start) / 1000));
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * What a finished crawl DID, in one sentence.
 *
 * Every count is summed from the server's per-source results rather than restated, and a source
 * that failed is named with the fetcher's own reason: a crawl that visited 25 sites and got
 * nothing from three of them is not the same event as a quiet night, and rolling the three into
 * the totals is how it would come to look like one.
 */
export function crawlSentence(result: CrawlResponse): string {
  const seconds = crawlSeconds(result.startedAt, result.finishedAt);
  const total = (pick: (r: CrawlRunSummary) => number): number =>
    result.results.reduce((n, r) => n + pick(r), 0);
  const failed = result.results.filter((r) => r.error !== undefined);

  return (
    `Crawled ${plural(result.results.length, 'source', 'sources')}` +
    `${seconds === null ? '' : ` in ${String(seconds)} seconds`}: ` +
    `${plural(total((r) => r.parsedCount), 'record', 'records')}, ` +
    `${plural(total((r) => r.events), 'change', 'changes')} detected, ` +
    `${plural(total((r) => r.reviewItems), 'item', 'items')} queued for review.` +
    (failed.length === 0
      ? ''
      : ` Failed: ${failed.map((r) => `${r.sourceId} (${r.error ?? ''})`).join(', ')}.`)
  );
}

/**
 * Source health (spec §8) and, for an admin, the two things about a source that are configurable
 * at all (spec §12).
 *
 * WHY THIS PAGE EXISTS AT THE SIZE IT DOES. Six parsers once returned zero records from their own
 * live pages while the entire unit suite stayed green, and one of them owned the close date
 * inherited by 112 of the 152 programmes that crawl published — the ARRL catalog and QCWA, the
 * same population `normalize/deadline.ts` measured. (The rendered copy below no longer quotes a
 * figure. This comment may, because it names the crawl it measured; the sentence on screen said
 * "112 of 150" against a corpus that ships 143 records, which is the drift that
 * `test/cycleCountCopy.test.ts` now exists to catch.) Nothing in the application noticed, because "this source
 * returned nothing" and "this source has nothing right now" are the same row in the database and
 * were the same sentence on screen. The six health states, the yield column and the two notes
 * below exist to keep those two readings apart in front of a human.
 */
export function Sources(): JSX.Element {
  const { data, loading, error, reload } = useApi<SourcesResponse>('/api/sources/health');
  const [draft, setDraft] = useState<Draft>({});
  const [crawling, setCrawling] = useState(false);
  const [crawlResult, setCrawlResult] = useState<CrawlResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function draftFor(row: SourceRow): Draft[string] {
    return draft[row.id] ?? draftFrom(row);
  }

  function patchDraft(row: SourceRow, patch: Partial<Draft[string]>): void {
    // Read the CURRENT buffer inside the updater. Reading it from the render closure loses the
    // first of two changes made in one batch — type a digit and toggle the checkbox in the same
    // tick and the digit disappears.
    setDraft((current) => ({
      ...current,
      [row.id]: { ...(current[row.id] ?? draftFrom(row)), ...patch },
    }));
  }

  async function runCrawl(): Promise<void> {
    setCrawling(true);
    setActionError(null);
    setCrawlResult(null);
    try {
      // ONE request for the whole fleet. A crawl walks ~25 sites belonging to small volunteer-run
      // organisations; a press that fanned out per row would multiply that load by the size of
      // the fleet, which is how a single Verify click would once have pulled ~545 MB. The server
      // is single-flight and answers a second press with 409 — which is reported, never retried.
      setCrawlResult(await apiSend<CrawlResponse>('POST', '/api/sources/crawl', {}));
      reload();
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status !== 0
          ? err.message
          : 'The crawl could not be started: the GrantSpotter API could not be reached. Nothing was fetched.',
      );
    } finally {
      setCrawling(false);
    }
  }

  async function saveSource(row: SourceRow): Promise<void> {
    setActionError(null);
    const pending = draftFor(row);
    const raw = pending.expectedMinRecords.trim();
    const parsed = Number(raw);
    if (raw === '' || !Number.isInteger(parsed) || parsed < 0) {
      setActionError(
        `${row.label} was not saved. The expected minimum needs a whole number of 0 or more — ` +
          'and an empty box is not a zero, which is why it is refused here rather than sent as one.',
      );
      return;
    }
    try {
      // Exactly the two keys `PATCH /api/sources/:id` accepts. It 422s anything else, and there is
      // deliberately no URL or host field: the fetcher blocklist is not configurable, and
      // farweb.org is on it because the Foundation for Amateur Radio's domain now redirects to a
      // gambling site while club pages still say "apply at the FAR website".
      await apiSend('PATCH', `/api/sources/${row.id}`, {
        expectedMinRecords: parsed,
        enabled: pending.enabled,
      });
      setDraft((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
      reload();
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.status !== 0
          ? `${row.label} was not saved: ${err.message}`
          : `${row.label} was not saved: the GrantSpotter API could not be reached.`,
      );
    }
  }

  const canConfigure = data?.canConfigure === true;
  const rows = data?.rows ?? [];
  const unconfigured = rows.filter((row) => row.enabled && row.expectedMinRecords === 0).length;

  return (
    <>
      <p className="eyebrow">Ingestion</p>
      <h1 style={{ marginBottom: 'var(--s-4)' }}>Source health</h1>

      <p className="sources-lede">
        GrantSpotter is a curated database with a change-detection layer, not a spider. About
        twenty-five sources are polled nightly; a handful more are curated by hand because they
        deliberately block non-browser clients, and spoofing a browser to defeat a stated access
        policy is not something this project does.
      </p>

      {data !== null && !canConfigure && (
        <p className="readonly-note">
          Only an administrator can change source configuration or trigger a crawl. This page is
          readable by everyone so that a wrong-looking record can always be traced to its source.
        </p>
      )}

      {loading && <p className="eyebrow">Loading…</p>}
      {error !== null && (
        <p role="alert">
          Source health could not be loaded ({error.code}
          {error.status === 0 ? ', the API could not be reached' : ''}). The table below is missing,
          not empty — this page is not saying every source is fine.
        </p>
      )}
      {actionError !== null && <p role="alert">{actionError}</p>}

      {data !== null && (
        <>
          <section className="fleet-summary card" aria-label="Fleet summary">
            {/* The figure repeats the sentence beside it, so it is decoration to a screen reader. */}
            <span className="fleet-figure" aria-hidden="true">
              {data.summary.unhealthy}
            </span>
            <span>
              {data.summary.unhealthy} of {data.summary.total} sources need attention.
            </span>
            {canConfigure && (
              <>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={crawling}
                  onClick={() => {
                    void runCrawl();
                  }}
                >
                  {crawling ? 'Crawling…' : 'Run crawl now'}
                </button>
              </>
            )}
          </section>

          {canConfigure && (
            <>
              <p className="eyebrow" style={{ marginBottom: 'var(--s-4)' }}>
                A manual crawl visits every enabled source once, in one request. It is the same run
                the scheduler performs at 03:17, so anything it finds lands in the Inbox for review.
              </p>
              {/* Mounted always, so the result is an UPDATE to a live region assistive technology
                  is already watching rather than a new node it may never announce. */}
              <p role="status" className="crawl-result card">
                {crawlResult === null ? '' : crawlSentence(crawlResult)}
              </p>
            </>
          )}

          <section className="card sources-panel" aria-labelledby="drop-heading">
            <h2 id="drop-heading">How a silent drop is detected, and what it cannot see</h2>
            <p>
              {unconfigured === 0
                ? 'Every enabled source has a minimum configured, so a parser that starts returning nothing raises a yield alarm on the next crawl.'
                : `${String(unconfigured)} of ${String(data.summary.total)} sources ${
                    unconfigured === 1 ? 'has' : 'have'
                  } no minimum configured, so a parser that silently starts returning nothing cannot raise a yield alarm for ${
                    unconfigured === 1 ? 'it' : 'them'
                  } — it reads as idle instead, which is also what a genuinely closed window looks like.`}
            </p>
            <p>
              Nothing yet records what a source normally yields, so a drop can only be measured
              against the minimum configured here and never against the source&rsquo;s own history.
              Six parsers once returned zero records from their own live pages while every test
              stayed green, and one of them owned the close date that most of this corpus inherits.
            </p>
          </section>

          <div className="sources-table-wrap">
            <table className="grid-table" aria-label="Source health">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">
                    Records / minimum
                  </th>
                  <th scope="col" className="num">
                    Last poll
                  </th>
                  <th scope="col" className="num">
                    Last success
                  </th>
                  <th scope="col" className="num">
                    Failures
                  </th>
                  <th scope="col">Detail</th>
                  {canConfigure && <th scope="col">Configuration</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const pending = draftFor(row);
                  const zeroDraft = pending.expectedMinRecords.trim() === '0';
                  return (
                    <tr key={row.id} className={row.enabled ? undefined : 'source-paused'}>
                      <td>
                        <span className="row-name">
                          <strong>{row.label}</strong>
                          <span className="row-funder data">
                            {row.id} · tier {row.tier}
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className={`health-pill health-${row.health.state}`}>
                          {WORDS[row.health.state]}
                        </span>
                      </td>
                      <td className="num">
                        {/* An UNSET minimum is words, not the digit 0. "0 / 0" reads as a
                            threshold that has been met, on exactly the source nobody has
                            configured — which is the source most likely to be silently broken. */}
                        {row.expectedMinRecords > 0 ? (
                          <span>
                            {row.lastRecordCount ?? '—'} / {row.expectedMinRecords}
                          </span>
                        ) : (
                          <span>
                            {row.lastRecordCount ?? '—'}{' '}
                            <span className="yield-unset">/ no minimum set</span>
                          </span>
                        )}
                        {/* Rendered only once something writes it. Today nothing does. */}
                        {row.baselineRecordCount !== null && (
                          <span className="yield-unset">
                            {' '}
                            normally yields {row.baselineRecordCount}
                          </span>
                        )}
                      </td>
                      <td className="num">{formatDate(row.lastPolledAt)}</td>
                      <td className="num">{formatDate(row.lastSuccessAt)}</td>
                      <td className="num">{row.consecutiveFailures}</td>
                      <td>{row.health.detail}</td>
                      {canConfigure && (
                        <td>
                          <div className="source-config">
                            <label htmlFor={`baseline-${row.id}`} className="eyebrow">
                              Expected minimum records, the yield baseline for {row.label}
                            </label>
                            <input
                              id={`baseline-${row.id}`}
                              type="number"
                              min={0}
                              step={1}
                              value={pending.expectedMinRecords}
                              onChange={(e) => {
                                patchDraft(row, { expectedMinRecords: e.target.value });
                              }}
                            />
                            {zeroDraft && (
                              <span className="source-config-hint">
                                0 means no minimum: this source cannot raise a yield alarm.
                              </span>
                            )}

                            <label htmlFor={`enabled-${row.id}`}>
                              <input
                                id={`enabled-${row.id}`}
                                type="checkbox"
                                checked={pending.enabled}
                                onChange={(e) => {
                                  patchDraft(row, { enabled: e.target.checked });
                                }}
                              />{' '}
                              Poll {row.label} nightly
                            </label>

                            <button
                              type="button"
                              className="btn"
                              onClick={() => {
                                void saveSource(row);
                              }}
                            >
                              Save {row.label}
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/*
            The list comes from `lib/safety.ts` — the same module `SourceLink` and the Inbox use to
            decide what may become an anchor — rather than being typed out a fourth time. It is
            rendered as text and NEVER as a link: farweb.org is on this list for SAFETY, not
            licensing, because the Foundation for Amateur Radio's domain was taken over between
            2025-10-17 and 2026-02-10 and now redirects to an online-gambling site while ARRL, QCWA
            and club pages still tell applicants to "apply at the FAR website".
          */}
          <section className="card sources-panel" aria-labelledby="blocked-heading">
            <h2 id="blocked-heading">Hosts the fetcher refuses</h2>
            <p>
              This list is enforced in the fetcher and is not configurable — not here, not by an
              administrator, and not by a source&rsquo;s own record. Source configuration accepts
              an expected minimum and an enabled flag, and the API refuses any other field rather
              than ignoring it, so a request that tried to point a source at a new host would be
              turned down out loud.
            </p>
            <ul className="blocked-host-list">
              {BLOCKED_HOSTS.map((host) => (
                <li key={host}>{host}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}
