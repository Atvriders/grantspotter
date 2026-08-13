import { filtersToSearchParams, type UiFilters } from '../lib/filterState.js';
import { apiSend } from './client.js';

/**
 * PLAN-LOCAL. The binary export calls read blobs, not JSON, so they cannot go through
 * `apiSend`. This carries the server's own message — "3 unconfirmed factual assertion(s)…" —
 * into `error.message`, which is what the UI shows the user. It deliberately does not
 * subclass Plan 3's `ApiError`, whose constructor argument order is still settling between
 * Plan 1's canonical five-argument form and Plan 3's three-argument one.
 */
export class ExportError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * THE EXPORT ASKS THE QUESTION THE SCREEN ASKED, IN THE SAME WORDS.
 *
 * There is no translation here any more, and that is the point. This function used to restate the
 * browse filter one key at a time in a second vocabulary — `applicantEntities` for `entity`,
 * `closesAfter`/`closesBefore` for `deadlineFrom`/`deadlineTo` — and then dropped everything it
 * had no second spelling for, under the comment "the export endpoint would ignore them and a stray
 * key hides a real mismatch". Three filters were dropped that way and the panel beside them went
 * on promising "exports exactly what the filters above are showing". Measured on the live site:
 *
 *   - Award amount Min = 5000 → 17 programmes on screen, all three export links BARE, 143 rows in
 *     the CSV. `amountMin` had no export spelling, so nothing at all was carried.
 *   - Matcher verdict = Ineligible → the same, for the same reason.
 *   - From 2026-09-01 / To 2026-12-31 with "Keep rolling and undated programs" CHECKED, the
 *     DEFAULT → 139 on screen, 117 in the CSV. `includeRolling` had no export spelling, so the
 *     window arrived without the one flag that says what to do with a programme that has no date.
 *
 * `filtersToSearchParams` is what the browse screen puts in the address bar and sends to
 * `GET /api/programs`, so handing its output straight to the export endpoint makes the two
 * requests the same request. A filter added to `UiFilters` reaches the export the moment it
 * reaches the URL, with nothing here to update — which is the only version of this function that
 * cannot fall behind the screen again.
 *
 * `page` is the one key removed, and `exports.test.ts` fails if this list grows without a reason
 * beside it: an export is every match, so "page 1 of 3" would ship 50 of 139 rows to someone who
 * had not asked for a page at all. `sort` is KEPT and is honoured — the server selects through the
 * browse projection, which orders by it, so the rows arrive in the order they were read on screen.
 */
export function browseFiltersToExportQuery(filters: UiFilters): URLSearchParams {
  const query = filtersToSearchParams(filters);
  query.delete('page');
  return query;
}

export function exportHref(path: string, query?: URLSearchParams): string {
  const qs = query?.toString() ?? '';
  return qs === '' ? path : `${path}?${qs}`;
}

export interface IcsTokenStatus { hasToken: boolean }
export interface IcsTokenCreated { url: string; token: string }

/** 404 means "no feed yet", which is a state, not an error. */
export async function getIcsToken(): Promise<IcsTokenStatus | null> {
  const response = await fetch('/api/exports/ics-token', {
    method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await toExportError(response);
  return await response.json() as IcsTokenStatus;
}

export async function createIcsToken(): Promise<IcsTokenCreated> {
  return apiSend<IcsTokenCreated>('POST', '/api/exports/ics-token');
}

export async function revokeIcsToken(): Promise<void> {
  await apiSend<null>('DELETE', '/api/exports/ics-token');
}

export interface DraftExportBody {
  applicationId: string;
  programId: string;
  subtitle?: string;
  budgetLines?: unknown[];
}

const DRAFT_PATHS: Record<'docx' | 'md' | 'zip', string> = {
  docx: '/api/exports/draft.docx',
  md: '/api/exports/draft.md',
  zip: '/api/exports/packet.zip',
};

async function toExportError(response: Response): Promise<ExportError> {
  let code = 'internal';
  let message = 'request failed';
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    /* a non-JSON error body stays generic */
  }
  return new ExportError(message, code, response.status);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function filenameFrom(response: Response, fallback: string): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallback;
}

/**
 * The header `packages/server/src/api/exports.ts` states the record count on
 * (`EXPORT_ROWS_HEADER`). Retyped rather than imported because `web` never imports `server`;
 * `api/exports.test.ts` there pins the string, so a rename breaks on the side that owns it.
 */
const ROWS_HEADER = 'x-grantspotter-rows';

/** What an export actually did, in the terms the screen has to report. */
export interface ExportOutcome {
  /** The file that landed on disk, or `null` when nothing was saved. */
  filename: string | null;
  /** Records in the file, or `null` when this server did not say. */
  rows: number | null;
}

/**
 * PRESS THE CONTROL, INSPECT THE ANSWER, THEN DECIDE WHETHER A FILE IS WORTH WRITING.
 *
 * THE CONTROL SHAPE WAS THE DEFECT. `/exports` offered `<a download href="/api/exports/…">`, and
 * an anchor cannot look at a response — the browser saves whatever comes back, under the name in
 * the URL, and the page the user is looking at never learns that anything happened. Two things
 * followed from that, both measured on the built product:
 *
 *   1. A member with NO PROFILE pressed "Eligibility report (CSV)" and Chromium saved a file
 *      called `eligibility.csv` whose entire contents were
 *      `{"error":{"code":"conflict","message":"Set up a profile first; …"}}` — a 409 JSON body
 *      with no Content-Disposition, named as though it were the report, with nothing on screen
 *      changing to say otherwise.
 *   2. A verdict-filtered or watchlist-scoped export that legitimately matches nothing saved a
 *      file with a header row and no rows, equally silently. "It worked and matched nothing" and
 *      "it is broken" are different sentences, and an empty file in a downloads folder says
 *      neither.
 *
 * So the response is fetched, and only a response that IS the file gets written:
 *
 *   - not `ok` — nothing is saved, and the server's own sentence is thrown for the screen to
 *     print. `<a download>` had no way to do either.
 *   - `0` records — nothing is saved, and the caller is told the count so it can say WHY in the
 *     words of the control that was pressed. Deliberately not "saved an empty file and mentioned
 *     it": a file on disk is a thing the user will open later, out of this context, believing it
 *     to be an answer.
 *   - anything else — saved, under the filename the SERVER chose (`Content-Disposition`), which is
 *     the stamped one the file is meant to have rather than the last path segment of the URL.
 *
 * A server that does not send the count (an older build, a route with nothing to count) yields
 * `rows: null`, and a null count never suppresses a download: unknown is not zero.
 */
export async function downloadExport(
  path: string,
  query?: URLSearchParams,
  fallbackFilename = 'grantspotter-export',
): Promise<ExportOutcome> {
  const response = await fetch(exportHref(path, query), {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: '*/*' },
  });
  if (!response.ok) throw await toExportError(response);

  const header = response.headers.get(ROWS_HEADER);
  const parsed = header === null ? Number.NaN : Number.parseInt(header, 10);
  const rows = Number.isFinite(parsed) ? parsed : null;
  if (rows === 0) return { filename: null, rows: 0 };

  const filename = filenameFrom(response, fallbackFilename);
  saveBlob(await response.blob(), filename);
  return { filename, rows };
}

/** The server reads the draft from the applications row; this sends only the id. */
export async function downloadDraftExport(kind: 'docx' | 'md' | 'zip', body: DraftExportBody): Promise<void> {
  const response = await fetch(DRAFT_PATHS[kind], {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: '*/*' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toExportError(response);
  saveBlob(await response.blob(), filenameFrom(response, `grantspotter-draft.${kind}`));
}

/**
 * `FileReader`, not `File.prototype.text()`. jsdom 26 — the DOM every web test in this repo runs
 * against — does not implement `Blob.prototype.text` (`routes/Admin.tsx`'s `readFileText` hit the
 * same wall first: a `TypeError` there reads as "this backup could not be parsed", which blames
 * the operator's file for a missing browser API in the test harness). `FileReader` exists in every
 * browser this product supports and in jsdom, so this is the one path that works in both.
 */
function readFileText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

export async function restoreFromBackup(file: File): Promise<{ tablesRestored: string[]; rowsRestored: number }> {
  const parsed = JSON.parse(await readFileText(file)) as unknown;
  return apiSend<{ tablesRestored: string[]; rowsRestored: number }>('POST', '/api/admin/restore', parsed);
}
