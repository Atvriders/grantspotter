/**
 * The writing desk's HTTP surface.
 *
 * DTOs are RE-DECLARED here rather than imported from the server: the contract allows
 * `web → core` only, never `web → server`. That duplication is deliberate. Any drift is caught by
 * the e2e suite, which drives the real endpoints.
 *
 * Transport is Plan 3's `apiFetch` (`./client.js`), not a second copy of it. An earlier draft of
 * this module carried its own `request`, on the stated grounds that `apiSend` "covers only
 * POST/PUT/DELETE — the drafts API needs PATCH". It does not: `apiSend`'s method union has
 * included `'PATCH'` since Plan 3 Task 4, and re-deriving the envelope logic here would have
 * duplicated three rules and lost a fourth:
 *
 *   - the structured envelope `{ error: { code, message, details? }, requestId }` (R6), which read
 *     as a string renders "[object Object]" in the UI;
 *   - 204 with no body;
 *   - `requestId`, which is the only handle a user has on a server-side failure;
 *   - and the one it lost: a 2xx whose body is NOT JSON. GrantSpotter is served behind a tunnel,
 *     and a proxy or captive portal answering HTML under status 200 is a real case. `apiFetch`
 *     raises it; the hand-rolled `request` returned `undefined`, which walks through every
 *     `!== null` guard and blanks the screen with no message.
 */
import { ApiError, apiFetch } from './client.js';

/**
 * Plan 1's error type, under this module's name. Everything below throws exactly this, so
 * `err instanceof WritingApiError` holds for any failure raised here, and `code` / `status` /
 * `requestId` / `details` are the fields the UI reads.
 */
export { ApiError as WritingApiError } from './client.js';
export type { ApiErrorCode } from './client.js';

// ---- template library ------------------------------------------------------

export interface TemplateSourceDTO {
  label: string;
  url: string;
}

export interface TemplateSummaryDTO {
  id: string;
  title: string;
  layer: 'component' | 'funder';
  order: number;
  appliesTo: string[];
  lengthTarget?: string;
  requires: string[];
  programIds: string[];
  alwaysAvailable: boolean;
  sources: TemplateSourceDTO[];
  /** Derived server-side by scanning the body for `{{ … }}`. Frontmatter never lists slots. */
  slots: string[];
}

export interface TemplateDetailDTO extends TemplateSummaryDTO {
  body: string;
}

export interface TemplateListDTO {
  components: TemplateSummaryDTO[];
  overlays: TemplateSummaryDTO[];
  playbooks: TemplateSummaryDTO[];
}

export interface SlotDefDTO {
  path: string;
  label: string;
  /** Appears inside the `[TODO: …]` marker, so it tells the writer what to supply. */
  hint: string;
  source: 'profile' | 'program' | 'user';
}

export interface FilledTemplateDTO {
  templateId: string;
  title: string;
  markdown: string;
  unresolvedSlots: string[];
}

/**
 * NASA runs Space Grant through 52 independent consortia with no national application and no
 * national deadline, so this record is a ROUTING record and nothing more. `verified` is
 * hard-coded `false` by the server's loader regardless of what the file says — the UI owes these
 * the unverified treatment and a link to `directoryUrl`, and an unknown state code comes back
 * 404 rather than as the nearest match.
 */
export interface ConsortiumDTO {
  state: string;
  name: string;
  leadInstitution: string;
  verified: boolean;
  directoryUrl: string;
  note: string;
}

// ---- prose ------------------------------------------------------------------

export interface ParagraphReportDTO {
  index: number;
  text: string;
  styleWordHits: string[];
  properNounCount: number;
  figureCount: number;
  tricolonCount: number;
  trailingParticipialCount: number;
  stockTransitionHits: string[];
  verdict: 'specific' | 'thin' | 'generic';
}

export interface ProseReportDTO {
  paragraphs: ParagraphReportDTO[];
  sentenceLengthVariance: number;
  documentTricolonCount: number;
  stockOpenerHits: string[];
  stockCloserHits: string[];
  paragraphsWithNoProperNounOrFigure: number[];
}

export interface DensityDTO {
  index: number;
  words: number;
  styleDensity: number;
  referentDensity: number;
}

/** Who stated the value under a fact. `unattributed` is honest, never a guess. */
export type FactOriginDTO = 'profile' | 'program' | 'answer' | 'unattributed';

/**
 * One checklist item.
 *
 * `origin`, `slots`, `provenance`, `fingerprint` and `staleConfirmation` are NOT optional
 * extras — the server sends all five on every item and each carries a rule the UI has to honour:
 *
 *   - `origin` / `provenance` are what make the list reviewable rather than a wall of identical
 *     checkboxes. **Origin never means confirmed**: a `program`-origin value, read off the
 *     funder's own record, starts unconfirmed like everything else.
 *   - `fingerprint` is a hash of the kind and the text. `id` is `${kind}:${start}` — a POSITION —
 *     so editing `$1,450` to `$9,999` reuses it and a stored `confirmed: true` would land on a
 *     number no human read. A client that drops the fingerprint on the way back reinstates that.
 *   - `staleConfirmation` says a stored confirmation was discarded because the text under it
 *     changed. Rendering it as an ordinary unconfirmed item hides that something moved.
 *
 * A `[TODO: …]` marker is NOT one of these and never appears here: markers are blanked before
 * matching, so the `e.g. W8UM` / `e.g. 1909` examples inside the vocabulary hints never reach the
 * list. They are counted in `openTodos` and block export on their own. **Render gaps beside the
 * checklist, never in it.**
 */
export interface FactItemDTO {
  id: string;
  kind: string;
  text: string;
  start: number;
  end: number;
  context: string;
  confirmed: boolean;
  note: string;
  fingerprint: string;
  origin: FactOriginDTO;
  slots: string[];
  provenance: string;
  staleConfirmation: boolean;
}

/** What the UI stores back. `fingerprint` is optional on the wire and should always be sent. */
export interface FactConfirmationDTO {
  confirmed: boolean;
  note: string;
  fingerprint?: string;
}

export interface ExportReadinessDTO {
  ready: boolean;
  unconfirmed: number;
  openTodos: number;
  items: FactItemDTO[];
}

// ---- drafts -----------------------------------------------------------------

export interface ApplicationDTO {
  id: string;
  userId: string;
  programId?: string;
  title: string;
  bodyMarkdown: string;
  answers: Record<string, string>;
  factConfirmations: Record<string, FactConfirmationDTO>;
  includeDisclosure: boolean;
  factsConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- transport --------------------------------------------------------------

const qs = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') search.set(k, v);
  const s = search.toString();
  return s === '' ? '' : `?${s}`;
};

/**
 * Whether a failure means "there is no such thing", as opposed to "the thing is broken".
 *
 * THE DISTINCTION IS THE POINT. `getTemplate` loads the WHOLE library to answer for one id, so a
 * single malformed file on disk makes every VALID id answer 500 while an id nothing claims
 * answers 404. Task 17 narrowed that server-side — `TemplateNotFoundError` → 404, `TemplateError`
 * → 500 — precisely so that one bad file reports as broken instead of emptying the library behind
 * a plausible "not found". A caller that renders both statuses with one sentence throws it away
 * again, and the person who could fix the file is told they asked for something that does not
 * exist. Callers should branch on this and say two different things.
 */
export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'not_found' || err.status === 404);
}

// ---- templates ---------------------------------------------------------------

export const listTemplates = (q: {
  klass?: string;
  programId?: string;
  funderId?: string;
}): Promise<TemplateListDTO> => apiFetch<TemplateListDTO>(`/api/templates${qs(q)}`);

export const fetchTemplate = (id: string): Promise<TemplateDetailDTO> =>
  apiFetch<TemplateDetailDTO>(`/api/templates/${encodeURIComponent(id)}`);

export const fetchSlots = (): Promise<{ all: SlotDefDTO[]; userAnswerable: SlotDefDTO[] }> =>
  apiFetch('/api/templates/slots');

export const fetchConsortium = (state: string): Promise<{ consortium: ConsortiumDTO }> =>
  apiFetch(`/api/templates/consortium/${encodeURIComponent(state)}`);

export const fillTemplateRemote = (
  id: string,
  body: { profile?: unknown; program?: unknown; funder?: unknown; answers?: Record<string, string> },
): Promise<FilledTemplateDTO> =>
  apiFetch(`/api/templates/${encodeURIComponent(id)}/fill`, { method: 'POST', body });

// ---- prose --------------------------------------------------------------------

export const analyzeDraft = (
  text: string,
): Promise<{ report: ProseReportDTO; densities: DensityDTO[] }> =>
  apiFetch('/api/prose/analyze', { method: 'POST', body: { text } });

/**
 * Takes the whole attribution context, not just the text. Sending `{ text }` alone still returns
 * a full checklist — every item simply reports `unattributed`, with no error and no warning.
 */
export const extractFacts = (body: {
  text: string;
  profile?: unknown;
  program?: unknown;
  funder?: unknown;
  answers?: Record<string, string>;
}): Promise<{ items: FactItemDTO[] }> => apiFetch('/api/prose/facts', { method: 'POST', body });

// ---- prompts -------------------------------------------------------------------

export const composePromptRemote = (body: {
  program: unknown;
  profile?: unknown;
  templateId?: string;
  includeDisclosure: boolean;
}): Promise<{ prompt: string; label: string; subtitle: string }> =>
  apiFetch('/api/prompts/compose', { method: 'POST', body });

/**
 * `includeDisclosure: false` removes the SUGGESTED SENTENCE and nothing else. A funder whose
 * stance is `permitted_with_disclosure` still has its mandatory requirement and its quoted policy
 * printed — a UI that hid the policy when the toggle is off would help an applicant break a rule
 * the funder published.
 */
export const fetchDisclosure = (body: {
  stance: string;
  funderName: string;
  toolName?: string;
  authorName?: string;
  usage?: 'drafting' | 'editing' | 'both';
}): Promise<{ sentence: string; note: string; defaultOn: boolean }> =>
  apiFetch('/api/prompts/disclosure', { method: 'POST', body });

// ---- drafts ----------------------------------------------------------------------

export const listApplications = (): Promise<{ applications: ApplicationDTO[] }> =>
  apiFetch('/api/applications');

export const createApplication = (body: {
  title: string;
  programId?: string;
}): Promise<ApplicationDTO> => apiFetch('/api/applications', { method: 'POST', body });

export const fetchApplication = (id: string): Promise<ApplicationDTO> =>
  apiFetch(`/api/applications/${encodeURIComponent(id)}`);

export const patchApplication = (
  id: string,
  patch: {
    title?: string;
    bodyMarkdown?: string;
    answers?: Record<string, string>;
    includeDisclosure?: boolean;
    /** `null` detaches the draft from its opportunity; omitted leaves the link alone. */
    programId?: string | null;
  },
): Promise<ApplicationDTO> =>
  apiFetch(`/api/applications/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });

export const putFactConfirmations = (
  id: string,
  confirmations: Record<string, FactConfirmationDTO>,
): Promise<ExportReadinessDTO> =>
  apiFetch(`/api/applications/${encodeURIComponent(id)}/facts`, {
    method: 'PUT',
    body: { confirmations },
  });

export const fetchExportReadiness = (id: string): Promise<ExportReadinessDTO> =>
  apiFetch(`/api/applications/${encodeURIComponent(id)}/export-readiness`);

// ---- two reads from Plan 3's endpoints, for the deep link -------------------------
//
// `/applications?programId=…` needs the WHOLE Program to compose a grounded prompt, and the
// profile to fill slots. `GET /api/programs/:id` answers with more than these two members
// (cycles, provenance, verdict, watched, deadlineOwner); only these two are named here.

export const fetchProgramForDraft = (
  programId: string,
): Promise<{ program: unknown; funder: unknown }> =>
  apiFetch(`/api/programs/${encodeURIComponent(programId)}`);

/**
 * The profile to fill slots from. `GET /api/profiles` answers with both kinds and either may be
 * `null`; `undefined` — not `null` — is what `buildSlotContext` treats as "the applicant has
 * stated nothing", which leaves every slot as a visible `[TODO: …]` gap rather than as filler.
 */
export const fetchActiveProfile = async (): Promise<unknown> => {
  const body = await apiFetch<{ student: unknown | null; organization: unknown | null }>(
    '/api/profiles',
  );
  return body.student ?? body.organization ?? undefined;
};
