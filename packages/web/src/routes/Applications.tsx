import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  type ApplicationDTO,
  type DensityDTO,
  type ExportReadinessDTO,
  type FactConfirmationDTO,
  type ProseReportDTO,
  type SlotDefDTO,
  type TemplateListDTO,
  WritingApiError,
  analyzeDraft,
  composePromptRemote,
  createApplication,
  fetchActiveProfile,
  fetchApplication,
  fetchExportReadiness,
  fetchProgramForDraft,
  fetchSlots,
  fillTemplateRemote,
  listApplications,
  listTemplates,
  patchApplication,
  putFactConfirmations,
} from '../api/writing.js';
import { downloadDraftExport } from '../api/exports.js';
import { COPY_PROMPT_DISCLOSURE_OFF, CopyPromptButton } from '../components/CopyPromptButton.js';
import { type DraftGap, DraftGaps, extractGaps } from '../components/DraftGaps.js';
import { FactChecklist } from '../components/FactChecklist.js';
import { ProseCheckPanel } from '../components/ProseCheckPanel.js';
import { SlotForm } from '../components/SlotForm.js';
import { TemplatePicker } from '../components/TemplatePicker.js';
import '../components/applications.css';

/** A draft with no programme can attribute nothing to the funder's own record, so attaching one
 * is a real editing action rather than a deep-link accident. `programId: null` detaches. */
type DraftPatch = Parameters<typeof patchApplication>[1];

/** Only the fields this screen reads off a Program; the whole record goes to the prompt composer. */
interface ProgramLike {
  id?: string;
  name?: string;
}

interface Props {
  /** Supplied by the opportunity screen when a draft is started from a program. */
  program?: unknown;
  profile?: unknown;
  programId?: string;
  funderId?: string;
  klass?: string;
}

export function ApplicationsRoute({ program, profile, programId, funderId, klass }: Props): JSX.Element {
  const [applications, setApplications] = useState<ApplicationDTO[]>([]);
  const [current, setCurrent] = useState<ApplicationDTO | undefined>();
  const [library, setLibrary] = useState<TemplateListDTO | undefined>();
  const [slots, setSlots] = useState<SlotDefDTO[]>([]);
  const [report, setReport] = useState<ProseReportDTO | undefined>();
  const [densities, setDensities] = useState<DensityDTO[]>([]);
  const [readiness, setReadiness] = useState<ExportReadinessDTO | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const fail = useCallback((err: unknown) => setError((err as Error).message), []);

  useEffect(() => {
    listApplications()
      .then((d) => setApplications(d.applications))
      .catch(fail);
    listTemplates({ programId, funderId, klass }).then(setLibrary).catch(fail);
    fetchSlots()
      .then((d) => setSlots(d.userAnswerable))
      .catch(fail);
  }, [programId, funderId, klass, fail]);

  /**
   * The overlay this program binds to, pre-selected when the user arrived from "Start an
   * application for this program". `selectTemplates` already filtered on programIds, so the first
   * overlay is this funder's; an empty list means no overlay has been written for it (or a seed id
   * drifted from the canonical list — see "Canonical program ids"), which is said in words rather
   * than shown as an empty group.
   */
  const suggestedOverlay = library?.overlays[0];
  const programName = (program as ProgramLike | undefined)?.name ?? programId;

  const refreshReadiness = useCallback(
    (id: string) => {
      fetchExportReadiness(id).then(setReadiness).catch(fail);
    },
    [fail],
  );

  const open = (id: string): void => {
    fetchApplication(id)
      .then((app) => {
        setCurrent(app);
        setReport(undefined);
        setNotice(undefined);
        refreshReadiness(app.id);
      })
      .catch(fail);
  };

  const start = (): void => {
    createApplication({ title: 'Untitled draft', programId })
      .then((app) => {
        setApplications((prev) => [app, ...prev]);
        setCurrent(app);
        setReadiness(undefined);
        setReport(undefined);
      })
      .catch(fail);
  };

  const save = (patch: DraftPatch): void => {
    if (!current) return;
    patchApplication(current.id, patch)
      .then((app) => {
        setCurrent(app);
        setApplications((prev) => prev.map((a) => (a.id === app.id ? app : a)));
        refreshReadiness(app.id);
      })
      .catch(fail);
  };

  const insertTemplate = (templateId: string): void => {
    if (!current) return;
    fillTemplateRemote(templateId, { profile, program, answers: current.answers })
      .then((filled) => {
        const next = `${current.bodyMarkdown}${current.bodyMarkdown ? '\n\n' : ''}${filled.markdown}`;
        save({ bodyMarkdown: next });
      })
      .catch(fail);
  };

  const runProseCheck = (): void => {
    if (!current?.bodyMarkdown.trim()) return;
    analyzeDraft(current.bodyMarkdown)
      .then((d) => {
        setReport(d.report);
        setDensities(d.densities);
      })
      .catch(fail);
  };

  /**
   * The fingerprint of the item AS SHOWN is echoed back, so the server stores a confirmation of
   * the words the applicant actually read. If the draft moved underneath this panel the server
   * answers 422 — the checklist on screen is describing text that no longer exists, and a retry
   * would 422 again. Refetch, say which item went stale, and let the person tick it again; never
   * re-tick it for them.
   */
  const confirmFact = (id: string, next: { confirmed: boolean; note: string }): void => {
    if (!current) return;
    const item = readiness?.items.find((i) => i.id === id);
    const payload: Record<string, FactConfirmationDTO> = {
      [id]: { confirmed: next.confirmed, note: next.note, fingerprint: item?.fingerprint },
    };
    putFactConfirmations(current.id, payload)
      .then((updated) => {
        setReadiness(updated);
        setNotice(undefined);
      })
      .catch((err: unknown) => {
        if (err instanceof WritingApiError && err.code === 'validation_failed') {
          setNotice(
            'This draft changed since the checklist was drawn, so that confirmation was refused. The checklist below has been reloaded — read the values again and tick them.',
          );
          refreshReadiness(current.id);
          return;
        }
        fail(err);
      });
  };

  const getPrompt = useMemo(
    () => async (): Promise<string> => {
      if (!program) {
        throw new Error(
          'open this draft from an opportunity so the funder’s criteria and AI policy can be included',
        );
      }
      const composed = await composePromptRemote({
        program,
        profile,
        templateId: suggestedOverlay?.id,
        includeDisclosure: current?.includeDisclosure ?? true,
      });
      return composed.prompt;
    },
    [program, profile, suggestedOverlay?.id, current?.includeDisclosure],
  );

  const gaps: DraftGap[] = current ? extractGaps(current.bodyMarkdown) : [];
  const attachable = programId !== undefined && current !== undefined && current.programId !== programId;

  return (
    <div className="applications-route">
      <h1>Applications</h1>
      {error ? <p role="alert">{error}</p> : null}

      {programId ? (
        <p className="deep-link-context">
          Drafting for <strong>{programName}</strong>.{' '}
          {suggestedOverlay ? (
            <>
              This funder’s overlay, <strong>{suggestedOverlay.title}</strong>, is selected.{' '}
              <button type="button" className="btn" onClick={() => insertTemplate(suggestedOverlay.id)} disabled={!current}>
                Insert {suggestedOverlay.title}
              </button>
            </>
          ) : (
            'No funder overlay has been written for this program yet, so only the component sections apply.'
          )}
          {attachable ? (
            <button type="button" className="btn" onClick={() => save({ programId })}>
              Attach this draft to {programName}
            </button>
          ) : null}
        </p>
      ) : null}

      <div className="applications-layout">
        <aside>
          <h2>Drafts</h2>
          <button type="button" className="btn" onClick={start}>
            New draft
          </button>
          <ul className="draft-list">
            {applications.map((a) => (
              <li key={a.id} className={a.id === current?.id ? 'selected' : undefined}>
                <button type="button" onClick={() => open(a.id)}>
                  {a.title}
                </button>
              </li>
            ))}
          </ul>
          {library ? (
            <>
              <TemplatePicker
                heading="Insert a section"
                templates={library.components}
                onSelect={insertTemplate}
                emptyMessage="No component templates apply here."
              />
              <TemplatePicker
                heading="Funder overlays"
                templates={library.overlays}
                selectedId={suggestedOverlay?.id}
                onSelect={insertTemplate}
                emptyMessage="No overlay has been written for this funder yet."
              />
              <TemplatePicker
                heading="Always available"
                templates={library.playbooks}
                onSelect={insertTemplate}
                emptyMessage="No playbooks."
              />
            </>
          ) : null}
        </aside>

        {/*
          A `div`, NOT a `main`. `AppShell` already renders `<main id="main">` around every route
          and the skip link points at it; a second `main` nested inside one is invalid HTML and
          leaves "Skip to main content" and landmark navigation pointing at two different things.
          No component test could see it — `Applications.test.tsx` renders this route without the
          shell — and `e2e/writing.spec.ts` caught it in a browser the first time one ran.
        */}
        <div className="draft-editor">
          {current ? (
            <>
              <h2>Draft</h2>
              <label htmlFor="draft-title">Title</label>
              <input
                id="draft-title"
                type="text"
                value={current.title}
                onChange={(e) => setCurrent({ ...current, title: e.target.value })}
                onBlur={() => save({ title: current.title })}
              />

              <label htmlFor="draft-body">Draft</label>
              <textarea
                id="draft-body"
                rows={24}
                value={current.bodyMarkdown}
                onChange={(e) => setCurrent({ ...current, bodyMarkdown: e.target.value })}
                onBlur={() => save({ bodyMarkdown: current.bodyMarkdown })}
              />

              <div className="prompt-block">
                <label className="disclosure-toggle">
                  <input
                    type="checkbox"
                    checked={current.includeDisclosure}
                    onChange={(e) => save({ includeDisclosure: e.target.checked })}
                  />
                  Include an AI-use disclosure sentence
                </label>
                {current.includeDisclosure ? (
                  <p className="muted">
                    The sentence is yours to edit before you send it. No funder in this corpus prohibits AI
                    assistance, and several ask to be told.
                  </p>
                ) : (
                  <p className="muted">{COPY_PROMPT_DISCLOSURE_OFF}</p>
                )}

                <CopyPromptButton getPrompt={getPrompt} includeDisclosure={current.includeDisclosure} />
              </div>

              <button type="button" className="btn" onClick={runProseCheck}>
                Run prose check
              </button>

              {/*
                The three POST exports (Task 9 / spec §11.3). A 409 here means `assertExportReady`
                refused the draft — an unconfirmed fact or an open [TODO: …] marker — and its own
                sentence names WHICH one and how many, so `fail` routes it straight to the same
                `role="alert"` banner every other failure on this screen uses rather than a silent
                no-op download.
              */}
              <div className="export-links">
                <button
                  type="button"
                  onClick={() => {
                    void downloadDraftExport('docx', { applicationId: current.id, programId: current.programId ?? '' })
                      .catch(fail);
                  }}
                >
                  Download DOCX
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void downloadDraftExport('md', { applicationId: current.id, programId: current.programId ?? '' })
                      .catch(fail);
                  }}
                >
                  Download Markdown
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void downloadDraftExport('zip', { applicationId: current.id, programId: current.programId ?? '' })
                      .catch(fail);
                  }}
                >
                  Download application packet (ZIP)
                </button>
              </div>
              {readiness && !readiness.ready && (
                <p className="export-note">
                  Exports are blocked until every item in the fact checklist below is confirmed and
                  every <code>[TODO: …]</code> marker is resolved: {readiness.unconfirmed} unconfirmed,{' '}
                  {readiness.openTodos} open. That rule is enforced on the server, not just here.
                </p>
              )}

              <SlotForm
                slots={slots}
                answers={current.answers}
                onChange={(path, value) => setCurrent({ ...current, answers: { ...current.answers, [path]: value } })}
              />
              <button type="button" className="btn" onClick={() => save({ answers: current.answers })}>
                Save facts
              </button>

              {report ? <ProseCheckPanel report={report} densities={densities} /> : null}

              {notice ? (
                <p className="stale-notice" role="status">
                  {notice}
                </p>
              ) : null}

              {/*
                Two panels, side by side and never merged: gaps are things to write, checklist
                items are things to sign. `openTodos` is counted by the server from the same regex
                `extractGaps` scans with, so the number in the checklist's blocker line and the
                length of the list beside it describe the same markers.
              */}
              <div className="before-export">
                <DraftGaps gaps={gaps} />
                {readiness ? (
                  <FactChecklist items={readiness.items} openTodos={readiness.openTodos} onChange={confirmFact} />
                ) : (
                  <p className="muted">The fact checklist loads with the draft.</p>
                )}
              </div>
            </>
          ) : (
            <p className="muted">Start a new draft or open an existing one.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The route-bound wrapper, and the other half of the deep link. The rail link lands here with no
 * query string and everything is simply unfiltered; the opportunity link lands here with
 * ?programId&funderId&klass, so this fetches the Program (the prompt cannot be grounded without
 * it) and the caller's profile (slots cannot fill without it) before handing both to the editor.
 *
 * A failed profile or program read is swallowed on purpose: neither is required to open the
 * editor, and `CopyPromptButton` surfaces the missing programme in words when the button is
 * pressed. Every EDITOR failure still reaches the `role="alert"` banner through `fail`.
 */
export function ApplicationsScreen(): JSX.Element {
  const [params] = useSearchParams();
  const programId = params.get('programId') ?? undefined;
  const funderId = params.get('funderId') ?? undefined;
  const klass = params.get('klass') ?? undefined;

  const [program, setProgram] = useState<unknown>();
  const [profile, setProfile] = useState<unknown>();

  useEffect(() => {
    let cancelled = false;
    fetchActiveProfile()
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => undefined);
    if (programId === undefined) {
      setProgram(undefined);
      return () => {
        cancelled = true;
      };
    }
    fetchProgramForDraft(programId)
      .then((d) => {
        if (!cancelled) setProgram(d.program);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [programId]);

  return (
    <ApplicationsRoute program={program} profile={profile} programId={programId} funderId={funderId} klass={klass} />
  );
}
