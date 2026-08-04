import type { SlotDefDTO } from '../api/writing.js';

interface Props {
  slots: SlotDefDTO[];
  answers: Record<string, string>;
  onChange: (path: string, value: string) => void;
}

/**
 * Only user-answerable slots appear here; profile and program slots fill themselves from what the
 * applicant has already stated. Anything left blank becomes a visible `[TODO: …]` in the document
 * — the whole plan turns on never substituting a plausible value for one nobody supplied.
 *
 * The hint is shown beside the field and NOT only as a placeholder: a placeholder disappears the
 * moment the field has focus, which is exactly when the writer is reading it, and it is invisible
 * to a value-only screen reader pass.
 */
export function SlotForm({ slots, answers, onChange }: Props): JSX.Element {
  return (
    <section className="slot-form" aria-labelledby="slot-form-heading">
      <h3 id="slot-form-heading">Facts this draft needs</h3>
      <p className="muted">
        Anything left blank appears in the draft as an explicit [TODO: …] marker. Nothing is ever guessed for you.
      </p>
      {slots.length === 0 ? (
        <p className="muted">No template inserted here asks you for a fact yet.</p>
      ) : (
        <ul>
          {slots.map((slot) => (
            <li key={slot.path}>
              <label htmlFor={`slot-${slot.path}`}>{slot.label}</label>
              <input
                id={`slot-${slot.path}`}
                type="text"
                value={answers[slot.path] ?? ''}
                placeholder={slot.hint}
                onChange={(e) => onChange(slot.path, e.target.value)}
              />
              <p className="slot-hint">{slot.hint}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
