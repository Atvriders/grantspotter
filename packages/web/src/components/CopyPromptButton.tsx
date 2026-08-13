import { useState } from 'react';

/**
 * THE ONE BUTTON THIS PLAN EXISTS TO PRODUCE — AND THE PLACE THE PRODUCT HAS TO TELL THE TRUTH.
 *
 * The label is fixed by spec §10.2 and is asserted byte-for-byte here, by
 * `packages/server/src/api/prompts.ts`, and by Task 20's e2e. It says "AI-detection avoidance",
 * which a reader could take as a promise that the prompt defeats a classifier. It does not, it
 * cannot, and nothing in this component may imply that it does — so the label ships with two
 * pieces of copy beside it that are as load-bearing as the button itself:
 *
 *   COPY_PROMPT_SUBTITLE  enumerates what is actually in the prompt (spec §10.2 requires the
 *                         enumeration), byte-identical to the server's own subtitle so the screen
 *                         and the API can never describe the same artefact differently.
 *   COPY_PROMPT_HONESTY   states what the label does NOT mean, and what the technique really is:
 *                         forcing specificity. Kobak et al., Science Advances 2025
 *                         (10.1126/sciadv.adt3813) measured 2024's excess vocabulary as 66% verbs
 *                         and 14% adjectives where the Covid-era shift was 79% nouns — a real
 *                         event changes the nouns; a language model changes the verbs and
 *                         adjectives. Synonym-swapping, injected typos and invisible characters
 *                         are deliberately excluded from the brief, and saying so here is the
 *                         same sentence `content/prompts/why-these-rules.md` ships to the model.
 *
 * `Applications.test.tsx` runs the sentence-polarity check from `prompts/compose.test.ts` over
 * every string this file exports and over the whole rendered screen: any sentence containing an
 * evasion or classifier-gaming word must also carry a negation or an exclusion.
 */

/** Contract copy. The em dash is U+2014 and the string is asserted by an e2e test. */
export const COPY_PROMPT_LABEL = 'Copy AI Prompt — includes AI-detection avoidance';

/**
 * Byte-identical to `COPY_PROMPT_SUBTITLE` in `packages/server/src/api/prompts.ts`, which
 * `POST /api/prompts/compose` returns beside the prompt. The web package may not import server
 * code, so the duplication is deliberate — and a test reads that file as text and compares, because
 * the only other thing that would notice the drift is an e2e suite this plan cannot run.
 *
 * IT IS PRINTED BEFORE ANYTHING IS COMPOSED, so every clause has to hold for every prompt the
 * endpoint can produce. Two did not until 2026-08-13: it recited "your profile facts" to readers
 * with no profile (measured live: a 21,145-character prompt with no "## Facts about me that you
 * may use" section under a sentence promising one) and "their AI policy, quoted, with the source
 * URL" for the 142 of 143 records that have published no AI policy at all. Both are conditions
 * now, and the composer reports what actually went in — see `CopiedPrompt` below.
 */
export const COPY_PROMPT_SUBTITLE =
  'Includes: this funder’s published criteria, restrictions and obligations · their AI policy, quoted with the source URL, where they have published one · the facts on your profile, if you have saved any · an interview-first rule so the model asks before it drafts · the specificity ruleset (named subjects, proper nouns, figures, dates) · banned stock transitions, openers and closers · a brevity pass · a never-invent-a-citation rule. Copying it reports exactly which of these went in.';

export const COPY_PROMPT_HONESTY =
  'What that label means: nothing in this prompt will make an AI-detection classifier report “human”, and nothing here tries to. It does not defeat, evade or bypass a detector. It works the other way round, by forcing specificity — named people, callsigns, model numbers, room numbers, dates and figures. Kobak et al. (Science Advances, 2025) measured 2024’s excess vocabulary as 66% verbs and 14% adjectives, where the Covid-era shift was 79% nouns: a real event changes the nouns, and a language model changes the verbs and adjectives. Synonym-swapping, injected typos and invisible characters are deliberately excluded — they degrade the writing, and a reviewer notices bad writing long before a classifier notices a machine.';

/** Shown when the disclosure sentence is on; the off-state copy is in `Applications.tsx`. */
export const COPY_PROMPT_DISCLOSURE_ON = 'Also included: an editable AI-use disclosure sentence.';
export const COPY_PROMPT_DISCLOSURE_OFF =
  'The AI-use disclosure sentence is switched off, so it is not included. This funder’s own AI policy, and any disclosure they require, are still in the prompt — switching the sentence off does not switch off their rule.';

/**
 * What the composer says it put in this particular brief, and what it left out.
 *
 * `getPrompt` used to resolve a bare string, which is why the only enumeration on this screen was
 * a constant that could not know. A caller may still hand back just the text — the report is then
 * the character count alone, and no claim is made about contents.
 */
export interface CopiedPrompt {
  prompt: string;
  included?: string[];
  omitted?: Array<{ clause: string; reason: string }>;
}

interface Props {
  getPrompt: () => Promise<CopiedPrompt | string>;
  disabled?: boolean;
  /** Defaults to on, as the disclosure sentence itself does. */
  includeDisclosure?: boolean;
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  // `execCommand` is absent in jsdom and deprecated in browsers, so this is a genuine fallback
  // path and a genuine failure when it is missing — never a silent no-op that looks like a copy.
  const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
  document.body.removeChild(area);
  if (!ok) throw new Error('the browser refused the copy request');
}

export function CopyPromptButton({ getPrompt, disabled, includeDisclosure = true }: Props): JSX.Element {
  const [status, setStatus] = useState<string | undefined>();
  const [copied, setCopied] = useState<CopiedPrompt | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const onClick = async (): Promise<void> => {
    setError(undefined);
    setStatus(undefined);
    setCopied(undefined);
    setBusy(true);
    try {
      const answer = await getPrompt();
      const result: CopiedPrompt = typeof answer === 'string' ? { prompt: answer } : answer;
      await copyToClipboard(result.prompt);
      setCopied(result);
      setStatus(
        `Copied ${result.prompt.length.toLocaleString()} characters. Paste it into your assistant.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="copy-prompt">
      <button
        type="button"
        className="btn btn-primary copy-prompt-button"
        onClick={() => void onClick()}
        disabled={disabled === true || busy}
      >
        {COPY_PROMPT_LABEL}
      </button>
      <p className="copy-prompt-subtitle">{COPY_PROMPT_SUBTITLE}</p>
      <p className="copy-prompt-subtitle">
        {includeDisclosure ? COPY_PROMPT_DISCLOSURE_ON : COPY_PROMPT_DISCLOSURE_OFF}
      </p>
      <p className="copy-prompt-honesty">{COPY_PROMPT_HONESTY}</p>
      {status ? <p role="status">{status}</p> : null}
      {/*
        THE ENUMERATION OF WHAT WAS ACTUALLY COPIED, which is the only one that can be checked
        against the thing on the clipboard. The subtitle above describes what the brief can carry;
        this describes what this one does. The omissions are printed as loudly as the inclusions:
        a reader with no profile is one saved form away from a brief that knows who they are, and
        the old copy told them their facts were already in it.
      */}
      {copied?.included !== undefined && copied.included.length > 0 ? (
        <div className="copy-prompt-contents">
          <p className="copy-prompt-included">In the brief you just copied: {copied.included.join(' · ')}.</p>
          {copied.omitted !== undefined && copied.omitted.length > 0 ? (
            <ul className="copy-prompt-omitted">
              {copied.omitted.map((o) => (
                <li key={o.clause}>
                  Not in it: {o.clause} — {o.reason}.
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert">Could not copy the prompt: {error}</p> : null}
    </div>
  );
}
