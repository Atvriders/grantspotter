import type { UiFilters } from '../lib/filterState.js';
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
 * Browse and export use different query vocabularies on purpose: Plan 3 owns the browse
 * filter, Task 1 owns ExportFilter. This is the only translation between them.
 * Browse-only keys (verdict, sort, page, includeRolling, amountMin/Max) are dropped —
 * the export endpoint would ignore them and a stray key hides a real mismatch.
 */
export function browseFiltersToExportQuery(filters: UiFilters): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.q) query.set('q', filters.q);
  if (filters.klass.length > 0) query.set('klass', filters.klass.join(','));
  if (filters.status.length > 0) query.set('status', filters.status.join(','));
  if (filters.instrument.length > 0) query.set('instrument', filters.instrument.join(','));
  if (filters.entity.length > 0) query.set('applicantEntities', filters.entity.join(','));
  if (filters.deadlineFrom) query.set('closesAfter', filters.deadlineFrom);
  if (filters.deadlineTo) query.set('closesBefore', filters.deadlineTo);
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
