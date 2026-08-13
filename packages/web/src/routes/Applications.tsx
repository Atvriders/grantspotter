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
import { type CopiedPrompt, CopyPromptButton } from '../components/CopyPromptButton.js';
import { type DraftGap, DraftGaps, extractGaps } from '../components/DraftGaps.js';
import { FactChecklist } from '../components/FactChecklist.js';
import { ProseCheckPanel } from '../components/ProseCheckPanel.js';
import { SlotForm } from '../components/SlotForm.js';
import { TemplatePicker } from '../components/TemplatePicker.js';
import '../components/applications.css';

/** A draft with no programme can attribute nothing to the funder's own record, so attaching one
 * is a real editing action rather than a deep-link accident. `programId: null` detaches. */
type DraftPatch = Parameters<typeof patchApplication>[1];

/**
 * THE SAME FOUR-WAY BREAKDOWN `assertExportReady` throws as a 409, rendered BEFORE the click so
 * the refusal is never a surprise. Every clause is conditional on its own count: an applicant
 * blocked by a lone raw `{{slot}}` placeholder must not read "0 unconfirmed" first and go hunting
 * for a fact that was never the problem — a wrong explanation is worse than a bare failure.
 *
 * Stale gets its own clause rather than folding into the unconfirmed count for the same reason the
 * server splits them: the applicant DID confirm that item, then the text under it changed, and
 * calling that "unconfirmed" reads as though the earlier work was thrown away.
 */
function describeExportBlockers(readiness: ExportReadinessDTO): string {
  const stale = readiness.items.filter((item) => item.staleConfirmation).length;
  const neverConfirmed = readiness.unconfirmed - stale;

  const clauses: string[] = [];
  if (neverConfirmed > 0) {
    clauses.push(`${neverConfirmed} unconfirmed`);
  }
  if (readiness.openTodos > 0) {
    clauses.push(`${readiness.openTodos} open [TODO: …] marker(s)`);
  }
  if (readiness.rawSlots > 0) {
    const slots = readiness.rawSlotPaths.map((path) => `{{${path}}}`).join(', ');
    clauses.push(`${readiness.rawSlots} unfilled template placeholder(s) (${slots})`);
  }
  if (stale > 0) {
    clauses.push(`${stale} confirmation(s) gone stale — the value changed since you confirmed it`);
  }
  return clauses.join(', ');
}

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

  /**
   * The whole answer, not just the text. `included` / `omitted` are built by the composer at the
   * same `if` that writes each section, and the button prints them beside the character count —
   * so the reader is told what went into THIS brief rather than what the subtitle says usually
   * does. Returning `composed.prompt` alone is what left a member with no profile reading "your
   * profile facts" over a prompt that had none.
   */
  const getPrompt = useMemo(
    () => async (): Promise<CopiedPrompt> => {
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
      return { prompt: composed.prompt, included: composed.included, omitted: composed.omitted };
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
              {/*
                DISABLED UNTIL THERE IS A DRAFT TO INSERT INTO, because `insertTemplate` opens
                `if (!current) return;` and that early return USED TO BE INVISIBLE. The library
                loads on mount and does not wait for a draft, so every one of these buttons was
                live the instant the screen painted — including the whole time the "New draft"
                POST was still in flight. Pressing one then did nothing at all: no insert, no
                error, no banner, and a draft body that stayed empty with no explanation for why.
                Reproduced in a browser by delaying `POST /api/applications` by 1.5s, which is one
                slow connection: the "Need statement" press was swallowed and the textarea read
                "". The editor beside this rail already says "Start a new draft or open an
                existing one", so an off control is the honest state and needs no new sentence.
              */}
              <TemplatePicker
                heading="Insert a section"
                templates={library.components}
                onSelect={insertTemplate}
                disabled={!current}
                emptyMessage="No component templates apply here."
              />
              {/*
                THE SAME SENTENCE THE TEMPLATES SCREEN WAS PRINTING WITH NOTHING TO PRINT IT ABOUT.

                The rail links to `/applications` with no query string, so no funder is named, so
                `overlays` is empty — and this group said "No overlay has been written for this
                funder yet." about a funder nobody had mentioned. It is the funder-bound list and
                it stays the funder-bound list: an overlay quotes ONE funder's published criteria,
                and offering the whole library for one-click insertion here would put another
                funder's requirements into this application. What changes is that the empty
                sentence now says which of the two situations the reader is in.
              */}
              <TemplatePicker
                heading="Funder overlays"
                templates={library.overlays}
                selectedId={suggestedOverlay?.id}
                onSelect={insertTemplate}
                disabled={!current}
                emptyMessage={
                  funderId === undefined && programId === undefined
                    ? 'No funder yet: an overlay quotes one funder’s published criteria, so it is chosen by the opportunity. Open one from Browse and press “Start an application for this program”. The whole library is readable under Templates.'
                    : 'No overlay has been written for this funder yet.'
                }
              />
              <TemplatePicker
                heading="Always available"
                templates={library.playbooks}
                onSelect={insertTemplate}
                disabled={!current}
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
                {/*
                  ONE OWNER FOR THE ON/OFF SENTENCE, AND IT IS THE BUTTON.

                  This branch used to render `COPY_PROMPT_DISCLOSURE_OFF` in its else arm —
                  the identical paragraph `CopyPromptButton` already renders from the same
                  constant, so switching the toggle off printed it twice, verbatim, six lines
                  apart. Two copies of one sentence read as two facts, and the reader looks for
                  the difference between them. The button states what is and is not in the
                  prompt in both states; what is left here is the thing the button does NOT say —
                  the census of the corpus, which is about whether to include the sentence at all
                  and is just as true with it switched off. `Applications.test.tsx` counts the
                  renders of both strings in both states.

                  "and several ask to be told" until 2026-08-12, which was false: counted from
                  `data/seed`, ZERO of the 143 shipped records asks to be told, 142 have
                  published nothing about AI at all, and the one that has (ARDC) permits it. The
                  clause was pushing a student toward a disclosure with a requirement no funder
                  here has ever made. `Applications.test.tsx` recomputes the census on every run,
                  so this sentence goes red rather than stale if a batch adds a funder that does
                  require one.
                */}
                <p className="muted">
                  No funder in this corpus prohibits AI assistance and none asks to be told, so including the
                  sentence is your call rather than anyone’s rule. Where a funder has published a position, the
                  prompt carries their own words.
                </p>

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
                  Exports are blocked until every item in the fact checklist below is confirmed,
                  every <code>[TODO: …]</code> marker is resolved, and no raw{' '}
                  <code>{'{{slot}}'}</code> placeholder is left in the draft: {describeExportBlockers(readiness)}.
                  That rule is enforced on the server, not just here.
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
                  <FactChecklist
                    items={readiness.items}
                    openTodos={readiness.openTodos}
                    shippedFacts={readiness.shippedFacts}
                    shippedTemplates={readiness.shippedTemplates}
                    onChange={confirmFact}
                  />
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
