import type { TemplateSummaryDTO } from '../api/writing.js';
import { linkRefusal } from '../lib/safety.js';
import './writing.css';

interface Props {
  heading: string;
  templates: TemplateSummaryDTO[];
  selectedId?: string;
  onSelect: (id: string) => void;
  /** What an empty group MEANS. A blank space would imply the group does not exist. */
  emptyMessage: string;
  /**
   * What the group IS, when the heading alone would be read as a claim about the reader's own
   * application. "Funder overlays" on `/templates` lists every overlay in the library; the same
   * heading in the writing desk lists the ones written for the funder being applied to. Rendered
   * whether or not the group has anything in it, because the sentence is about the group.
   */
  note?: string;
  /**
   * Turns every button in the group off. The writing desk sets this while no draft is open,
   * because `insertTemplate` cannot insert into a draft that does not exist yet and used to
   * DROP the press — `if (!current) return;`, no error, no banner, nothing on screen. A student
   * whose "New draft" POST had not landed yet pressed "Need statement" and got silence, and the
   * only visible consequence was a draft body that stayed empty. A disabled control says the same
   * thing honestly, next to the editor's own "Start a new draft or open an existing one."
   */
  disabled?: boolean;
}

/**
 * One group of templates, as a list of buttons plus each template's cited sources.
 *
 * The sources are not decoration. Every funder requirement in an overlay is pinned to a quoted
 * capture by `funderCaptures.test.ts`, and this is where an applicant checks it against the
 * funder's own page. They are rendered through `linkRefusal` for the same reason every other
 * render site in this SPA is: a `javascript:` scheme parses with an empty hostname and a
 * protocol-relative `//www.farweb.org/…` throws, so both read as "not blocked" to anything that
 * only asks about hosts.
 */
export function TemplatePicker({
  heading,
  templates,
  selectedId,
  onSelect,
  emptyMessage,
  note,
  disabled = false,
}: Props): JSX.Element {
  return (
    <section className="template-group" aria-label={heading}>
      <h2>{heading}</h2>
      {note === undefined ? null : <p className="muted template-group-note">{note}</p>}
      {templates.length === 0 ? (
        <p className="muted">{emptyMessage}</p>
      ) : (
        <ul className="template-list">
          {templates.map((t) => (
            <li key={t.id} className={t.id === selectedId ? 'selected' : undefined}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onSelect(t.id);
                }}
                aria-current={t.id === selectedId ? 'true' : undefined}
              >
                {t.title}
                {t.lengthTarget !== undefined && t.lengthTarget !== '' ? (
                  <span className="length-target"> · {t.lengthTarget}</span>
                ) : null}
              </button>
              {t.sources.length > 0 ? (
                <ul className="template-sources">
                  {t.sources.map((s) => {
                    const refusal = linkRefusal(s.url);
                    return (
                      <li key={s.url}>
                        {refusal === null ? (
                          <a href={s.url} target="_blank" rel="noopener noreferrer">
                            {s.label}
                          </a>
                        ) : (
                          // Shown, never linked. The address is still information — and it is the
                          // only part of this line with no space in it, so it carries
                          // `source-url` and breaks rather than flooring the list's width.
                          <span className="muted">
                            {s.label} — <span className="source-url">{s.url}</span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
