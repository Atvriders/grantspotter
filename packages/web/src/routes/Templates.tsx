import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  type TemplateDetailDTO,
  type TemplateListDTO,
  WritingApiError,
  fetchTemplate,
  isNotFound,
  listTemplates,
} from '../api/writing.js';
import { TemplatePicker } from '../components/TemplatePicker.js';
import '../components/writing.css';

interface Props {
  programId?: string;
  klass?: string;
  funderId?: string;
}

/** The request id, when the server sent one. It is the only handle a user has on a 500. */
function trailer(err: unknown): string {
  const requestId = err instanceof WritingApiError ? err.requestId : '';
  return requestId === '' ? '' : ` (request ${requestId})`;
}

const detail = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * WHY THIS SCREEN HAS TWO FAILURE SENTENCES AND NOT ONE.
 *
 * `getTemplate` loads the WHOLE library to answer for a single id. Task 17 proved the
 * consequence: while one template file on disk is malformed, a perfectly VALID id answers 500,
 * and an id nothing on disk claims answers 404. The obvious server-side `catch { 404 }` turned
 * the first case into the second — the library vanished and the message blamed the applicant's
 * request — and a client that renders both statuses with one sentence undoes the narrowing one
 * layer up. So: 404 says nothing claims that id; anything else says a shipped file will not load
 * and names it as GrantSpotter's fault to fix, which is what it is.
 */
function templateFailure(id: string, err: unknown): string {
  if (isNotFound(err)) {
    return `There is no template with that id (“${id}”). Nothing in the library claims it, so there is nothing to show. The rest of the library is unaffected.`;
  }
  return `The template “${id}” will not load. It is a file GrantSpotter ships, so this is a fault in the product rather than in anything you asked for, and it needs fixing at the source. The rest of the library is unaffected. Server said: ${detail(err)}${trailer(err)}`;
}

/**
 * A failure to LIST is never rendered as an empty library.
 *
 * "No templates apply to this opportunity class" and "the server could not answer" look identical
 * as a blank list and mean opposite things — the first is a fact about the corpus, the second is
 * a fault. Only the picker groups say the first, and they render only when a list actually
 * arrived.
 */
function libraryFailure(err: unknown): string {
  return `Could not load the template library. The server reported a failure, so this is not a library with nothing in it — something is broken and someone has to fix it. Server said: ${detail(err)}${trailer(err)}`;
}

export function TemplatesRoute({ programId, klass, funderId }: Props): JSX.Element {
  const [library, setLibrary] = useState<TemplateListDTO | undefined>();
  const [selected, setSelected] = useState<TemplateDetailDTO | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    listTemplates({ programId, klass, funderId })
      .then((data) => {
        if (cancelled) return;
        setLibrary(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The library is CLEARED, not left stale, and no group renders. See libraryFailure.
        setLibrary(undefined);
        setError(libraryFailure(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [programId, klass, funderId]);

  const select = useCallback((id: string): void => {
    fetchTemplate(id)
      .then((doc) => {
        setSelected(doc);
        setError(undefined);
      })
      .catch((err: unknown) => {
        // One template failing says nothing about the others, so the index stays exactly as it is.
        setSelected(undefined);
        setError(templateFailure(id, err));
      });
  }, []);

  return (
    <div className="templates-route">
      <h1>Templates</h1>
      <p className="muted">
        The sections a grant application is built from, the overlays written against a particular
        funder’s published criteria, and the playbooks that apply wherever you are. Every claim in
        an overlay carries the source it was read from — open it and check.
      </p>

      {error !== undefined && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}

      {loading && error === undefined && <p className="muted">Loading the template library…</p>}

      {library !== undefined && (
        <div className="templates-layout">
          <div className="templates-index">
            <TemplatePicker
              heading="Sections"
              templates={library.components}
              selectedId={selected?.id}
              onSelect={select}
              emptyMessage="No component templates apply to this opportunity class."
            />
            <TemplatePicker
              heading="Funder overlays"
              templates={library.overlays}
              selectedId={selected?.id}
              onSelect={select}
              emptyMessage="No overlay has been written for this funder yet."
            />
            {/*
              Bound to `playbooks` and to nothing else. These are the templates whose frontmatter
              says `alwaysAvailable: true` — the Campus SGA playbook is one, because a student
              government exists on every campus and none of them are in the corpus. A quoted
              `alwaysAvailable: "true"` once read as `false` and hid it entirely; gating this
              group on whether an overlay matched would hide it again, and just as quietly.
            */}
            <TemplatePicker
              heading="Always available"
              templates={library.playbooks}
              selectedId={selected?.id}
              onSelect={select}
              emptyMessage="No playbooks."
            />
          </div>

          <div className="template-preview">
            {selected !== undefined ? (
              <>
                <h2>{selected.title}</h2>
                {/*
                  The template's own words, unaltered and unsummarised. Nothing on this screen may
                  add a sentence that asserts something the template does not — every funder
                  requirement in an overlay is pinned to a quoted capture, and prose invented
                  around it would not be.
                */}
                <pre>{selected.body}</pre>
                {selected.slots.length > 0 && (
                  <section className="template-slots" aria-label="Slots">
                    <h3>Slots this template uses</h3>
                    <p className="muted">
                      Each <code>{'{{…}}'}</code> above is a value you supply. Filling the template
                      in a draft leaves an explicit <code>[TODO: …]</code> wherever you have not
                      stated one — a gap to fill, never a plausible-looking guess.
                    </p>
                    <ul className="slot-paths">
                      {selected.slots.map((slot) => (
                        <li key={slot}>
                          <code>{slot}</code>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            ) : (
              <p className="muted">Pick a template to read it.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The route-bound wrapper. `TemplatesRoute` stays prop-driven so component tests can render it
 * without a router; this reads the same values from the query string, which is what the
 * opportunity deep link and the rail link set.
 */
export function TemplatesScreen(): JSX.Element {
  const [params] = useSearchParams();
  return (
    <TemplatesRoute
      programId={params.get('programId') ?? undefined}
      klass={params.get('klass') ?? undefined}
      funderId={params.get('funderId') ?? undefined}
    />
  );
}
