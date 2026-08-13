// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPY_PROMPT_DISCLOSURE_OFF,
  COPY_PROMPT_DISCLOSURE_ON,
  COPY_PROMPT_HONESTY,
  COPY_PROMPT_LABEL,
  COPY_PROMPT_SUBTITLE,
  CopyPromptButton,
} from '../components/CopyPromptButton.js';
import { DraftGaps, extractGaps } from '../components/DraftGaps.js';
import { FactChecklist } from '../components/FactChecklist.js';
import { ProseCheckPanel } from '../components/ProseCheckPanel.js';
import { auditA11y } from '../test/a11y.js';
import type { DensityDTO, FactItemDTO, ProseReportDTO } from '../api/writing.js';
import { ApplicationsScreen } from './Applications.js';
import { AppShell } from '../components/AppShell.js';
import { SessionContext, makeSessionValue } from '../store/session.js';

const REPORT: ProseReportDTO = {
  paragraphs: [
    {
      index: 0,
      text: 'Furthermore, this comprehensive initiative underscores our unwavering commitment.',
      styleWordHits: ['comprehensive', 'underscores', 'unwavering', 'commitment'],
      properNounCount: 0,
      figureCount: 0,
      tricolonCount: 1,
      trailingParticipialCount: 2,
      stockTransitionHits: ['Furthermore'],
      verdict: 'generic',
    },
    {
      index: 1,
      text: 'Dana Ruiz KD9XYZ will teach four sessions in Room 214 on March 7, 2027.',
      styleWordHits: [],
      properNounCount: 7,
      figureCount: 5,
      tricolonCount: 0,
      trailingParticipialCount: 0,
      stockTransitionHits: [],
      verdict: 'specific',
    },
  ],
  sentenceLengthVariance: 12.5,
  documentTricolonCount: 1,
  stockOpenerHits: ["In today's rapidly evolving landscape"],
  stockCloserHits: ['for years to come'],
  paragraphsWithNoProperNounOrFigure: [0],
};

const DENSITIES: DensityDTO[] = [
  { index: 0, words: 10, styleDensity: 40, referentDensity: 0 },
  { index: 1, words: 14, styleDensity: 0, referentDensity: 85.7 },
];

/**
 * The brief's two fixtures, plus the five members Task 18's `FactItemDTO` requires — `fingerprint`,
 * `origin`, `slots`, `provenance` and `staleConfirmation`. The server sends all five on every item,
 * so a fixture without them describes a response that cannot occur.
 */
const ATTRIBUTION: Pick<FactItemDTO, 'fingerprint' | 'origin' | 'slots' | 'provenance' | 'staleConfirmation'> = {
  fingerprint: '',
  origin: 'unattributed',
  slots: [],
  provenance: '',
  staleConfirmation: false,
};

const FACTS: FactItemDTO[] = [
  { id: 'money:12', kind: 'money', text: '$1,099', start: 12, end: 18, context: 'we spent $1,099 on it', confirmed: false, note: '', ...ATTRIBUTION },
  { id: 'callsign:0', kind: 'callsign', text: 'W8UM', start: 0, end: 4, context: 'W8UM spent $1,099', confirmed: true, note: 'checked FCC ULS', ...ATTRIBUTION },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CopyPromptButton', () => {
  it('uses the exact required copy and enumerates what the prompt contains', () => {
    expect(COPY_PROMPT_LABEL).toBe('Copy AI Prompt — includes AI-detection avoidance');
    render(<CopyPromptButton getPrompt={async () => 'PROMPT'} />);
    expect(screen.getByRole('button', { name: COPY_PROMPT_LABEL })).toBeTruthy();
    expect(screen.getByText(COPY_PROMPT_SUBTITLE)).toBeTruthy();
    for (const phrase of ['AI policy', 'interview', 'brevity', 'never-invent']) {
      expect(COPY_PROMPT_SUBTITLE.toLowerCase()).toContain(phrase.toLowerCase());
    }
  });

  it('writes the composed prompt to the clipboard and confirms', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyPromptButton getPrompt={async () => 'THE PROMPT'} />);
    fireEvent.click(screen.getByRole('button', { name: COPY_PROMPT_LABEL }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('THE PROMPT'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/copied/i));
  });

  it('surfaces a failure rather than silently doing nothing', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    render(<CopyPromptButton getPrompt={async () => { throw new Error('boom'); }} />);
    fireEvent.click(screen.getByRole('button', { name: COPY_PROMPT_LABEL }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/boom/));
  });

  /**
   * THE SUBTITLE DESCRIBES WHAT THE BRIEF CAN CARRY; THIS DESCRIBES WHAT THIS ONE DID.
   *
   * Measured on the live site on 2026-08-13: a member with no profile copied 21,145 characters
   * under "Includes: … your profile facts …", and the prompt had no "## Facts about me that you
   * may use" section at all. The composer now hands back what it wrote and what it left out, and
   * the omission is printed as plainly as the inclusion — a reader one saved form away from a
   * brief that knows who they are must not be told it already does.
   */
  it('reports what the copied brief actually contained, omissions included', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(
      <CopyPromptButton
        getPrompt={async () => ({
          prompt: 'THE PROMPT',
          included: ['this funder’s published criteria', 'a brevity pass'],
          omitted: [{ clause: 'your profile facts', reason: 'you have no saved profile' }],
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: COPY_PROMPT_LABEL }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/copied/i));
    expect(screen.getByText(/In the brief you just copied/).textContent).toContain('a brevity pass');
    expect(screen.getByText(/Not in it: your profile facts/).textContent).toMatch(
      /no saved profile/i,
    );
  });

  it('claims nothing about the contents when the caller reports none', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyPromptButton getPrompt={async () => 'THE PROMPT'} />);
    fireEvent.click(screen.getByRole('button', { name: COPY_PROMPT_LABEL }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/copied/i));
    expect(screen.queryByText(/In the brief you just copied/)).toBeNull();
  });

  /**
   * The pre-click sentence is printed before anything is composed, so every clause in it has to
   * survive the worst case: no profile, and a funder that has published nothing about AI. Both
   * conditional clauses are stated AS conditions, and this is what says so.
   */
  it('states the two conditional clauses as conditions, not as promises', () => {
    expect(COPY_PROMPT_SUBTITLE).toMatch(/where they have published one/i);
    expect(COPY_PROMPT_SUBTITLE).toMatch(/if you have saved any/i);
    expect(COPY_PROMPT_SUBTITLE).not.toMatch(/·\s*your profile facts\s*·/);
  });
});

/**
 * THE HONESTY BOUNDARY THE LABEL SITS INSIDE.
 *
 * The label is fixed by spec §10.2 and says "AI-detection avoidance". Task 15 ships, inside the
 * prompt, the sentence that nothing in the brief will make a classifier report "human", and pins it
 * with two sentence-polarity tests. The button makes the same claim to the same person, so it is
 * held to the same rule: any sentence carrying an evasion or classifier-gaming word must also carry
 * a negation or an exclusion. `EVASION` and `NEGATED` come from
 * `packages/server/src/prompts/compose.test.ts` on purpose — one boundary, two surfaces — with the
 * inflections that copy defeated in a mutation run: the server's list matches "slip past" but not
 * "slips past", so "The result reliably slips past the common detectors." passed it unchallenged.
 * `evasion`, `goes undetected`, `avoids detection` and `sneaks past` are added for the same reason.
 * None of them can match the mandated label, which says "avoidance" and promises nothing.
 */
const EVASION =
  /\b(defeat|defeats|defeating|evade|evades|evading|evasion|bypass|bypasses|fool|fools|trick|tricks|undetectable|beats? the detector|slips? past|sneaks? past|goes? undetected|avoids? detection|pass(es)? as human|reads? as human)\b/i;
const GAMING =
  /\b(synonym|synonyms|typo|typos|homoglyph|homoglyphs|invisible character|invisible characters|zero-width)\b/i;
const NEGATED =
  /\b(not|never|no|none|nothing|excluded|exclude|excludes|cannot|can't|won't|do not|does not|refuse|refuses|instead of|rather than)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Every string a reader actually sees, one element's own text at a time. `textContent` on the root
 * would splice unrelated strings into one pseudo-sentence, which could hide a violation in a seam
 * or invent one that nobody can read on screen.
 */
function visibleTexts(container: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of container.querySelectorAll('*')) {
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    if (own.length > 0) out.push(own);
  }
  return out;
}

describe('the copy beside the button', () => {
  const SHIPPED = [
    COPY_PROMPT_LABEL,
    COPY_PROMPT_SUBTITLE,
    COPY_PROMPT_HONESTY,
    COPY_PROMPT_DISCLOSURE_ON,
    COPY_PROMPT_DISCLOSURE_OFF,
  ];

  it('never promises that any of this defeats, evades or bypasses a detector', () => {
    for (const copy of SHIPPED) {
      for (const s of sentences(copy)) {
        if (EVASION.test(s) || GAMING.test(s)) expect(s, s).toMatch(NEGATED);
      }
    }
  });

  it('says in shipped text that nothing here will make a classifier report human', () => {
    expect(COPY_PROMPT_HONESTY).toMatch(/nothing in this prompt will make an AI-detection classifier report/i);
    expect(COPY_PROMPT_HONESTY).toContain('It does not defeat, evade or bypass a detector.');
  });

  it('grounds the technique in the excess-vocabulary finding rather than in a trick', () => {
    expect(COPY_PROMPT_HONESTY).toMatch(/Kobak et al\./);
    expect(COPY_PROMPT_HONESTY).toMatch(/66% verbs/);
    expect(COPY_PROMPT_HONESTY).toMatch(/79% nouns/);
    expect(COPY_PROMPT_HONESTY).toMatch(/forcing specificity/i);
    expect(COPY_PROMPT_HONESTY).toMatch(/synonym/i);
    expect(COPY_PROMPT_HONESTY).toMatch(/typos/i);
    expect(COPY_PROMPT_HONESTY).toMatch(/invisible characters/i);
  });

  it('shows the honesty note beside the button, not folded away behind a widget', () => {
    const { container } = render(<CopyPromptButton getPrompt={async () => 'P'} />);
    expect(screen.getByText(COPY_PROMPT_HONESTY)).toBeTruthy();
    expect(container.querySelectorAll('details').length).toBe(0);
  });

  it('enumerates the disclosure sentence, and says the funder’s own rule survives switching it off', () => {
    render(<CopyPromptButton getPrompt={async () => 'P'} includeDisclosure />);
    expect(screen.getByText(COPY_PROMPT_DISCLOSURE_ON)).toBeTruthy();
    cleanup();
    render(<CopyPromptButton getPrompt={async () => 'P'} includeDisclosure={false} />);
    const off = screen.getByText(COPY_PROMPT_DISCLOSURE_OFF);
    expect(off.textContent).toMatch(/still in the prompt/i);
    expect(off.textContent).toMatch(/does not switch off their rule/i);
  });

  /**
   * `POST /api/prompts/compose` returns `{prompt, label, subtitle}` from its own constants. Web may
   * not import server code, so this reads that file as TEXT — the duplication is required by the
   * contract, and the only other thing that would notice the drift is an e2e suite that cannot run
   * until Plan 5 serves the SPA.
   */
  it('keeps the label and the subtitle byte-identical to the ones the API returns', () => {
    const server = readFileSync(path.resolve(import.meta.dirname, '../../../server/src/api/prompts.ts'), 'utf8');
    expect(server).toContain(`export const COPY_PROMPT_LABEL = '${COPY_PROMPT_LABEL}';`);
    expect(server).toContain(`'${COPY_PROMPT_SUBTITLE}';`);
  });
});

describe('ProseCheckPanel', () => {
  it('reports densities per paragraph and never shows a single score', () => {
    render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    expect(screen.getByText(/style words per 100/i)).toBeTruthy();
    expect(screen.getByText(/proper nouns \+ figures per 100/i)).toBeTruthy();
    /*
     * The brief wrote this as `queryByText(/score/i)`, which cannot pass while the panel does the
     * job the same test asserts: the fixture's own located style words include "underscores", so
     * ANY rendering of the hits this panel exists to locate matches that regex. Word-bounded, it
     * says what it meant — no score, no rating, no grade — and still fails a panel that emits one.
     */
    expect(screen.queryByText(/\bscores?\b|\brating\b|\bgrade\b|\bout of 100\b/i)).toBeNull();
    expect(screen.queryByText(/AI-written|AI-generated/i)).toBeNull();
  });

  it('locates stock transitions, openers and closers', () => {
    render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    expect(screen.getByText('Furthermore')).toBeTruthy();
    expect(screen.getByText("In today's rapidly evolving landscape")).toBeTruthy();
    expect(screen.getByText('for years to come')).toBeTruthy();
  });

  it('flags the paragraph with no proper noun and no figure', () => {
    render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    expect(screen.getByText(/paragraph 1 has no proper noun and no figure/i)).toBeTruthy();
  });

  it('shows the document-level tricolon count and sentence-length variance', () => {
    render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    expect(screen.getByText(/tricolons: 1/i)).toBeTruthy();
    expect(screen.getByText(/sentence-length variance: 12.5/i)).toBeTruthy();
  });

  /**
   * One header row, not a definition list per paragraph. Repeating "Style words per 100 words"
   * once per paragraph makes the metric unpointable — `getByText` above finds two nodes and the
   * test dies, which is the cheap version of the same problem a screen-reader rotor has.
   */
  it('names each density exactly once, so a number can be pointed at', () => {
    render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    expect(screen.getAllByText(/style words per 100 words/i)).toHaveLength(1);
    expect(screen.getAllByText(/proper nouns \+ figures per 100 words/i)).toHaveLength(1);
  });

  /**
   * THE VERDICT IS THE POINT OF THE PANEL, AND IT WAS THE COLUMN THAT WENT OFF SCREEN.
   *
   * Six `nowrap` heads make this table 1,053px wide; the editor column is 818px at a 1400px
   * window. With "Reads as" last, its cell was drawn at x=1509 — outside the window entirely —
   * so the one cell that says "style words, no counterweight" or "carries its own specifics" was
   * the single thing a reader could not see, while five measurements they had not asked for
   * were. Position is asserted rather than mere presence: `getByText` passed the whole time it
   * was invisible.
   */
  it('puts the verdict in the second column, before any measurement', () => {
    const { container } = render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    const heads = [...container.querySelectorAll('.prose-paragraphs thead th')].map(
      (th) => th.textContent ?? '',
    );
    expect(heads[0]).toMatch(/paragraph/i);
    expect(heads[1]).toMatch(/reads as/i);

    const firstRow = container.querySelector('.prose-paragraphs tbody tr');
    const cells = [...(firstRow?.children ?? [])].map((c) => c.textContent ?? '');
    expect(cells[1]).toBe('style words, no counterweight');
  });

  /**
   * And the numbers it pushed right scroll in a box of their own, reachable by keyboard. The
   * panel itself must NOT be that box: `.prose-check` is padded, so content scrolled to its end
   * sits flush against the card border and reads as a broken layout rather than as a scroll.
   */
  it('scrolls the table inside a labelled region rather than inside the padded card', () => {
    const { container } = render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    const wrap = container.querySelector('.prose-table-wrap');
    expect(wrap, 'the table has no scroll wrapper').not.toBeNull();
    expect(wrap?.getAttribute('role')).toBe('region');
    expect(wrap?.getAttribute('aria-label')).toMatch(/scrollable/i);
    expect(wrap?.getAttribute('tabindex')).toBe('0');
    expect(wrap?.querySelector('table.prose-paragraphs')).not.toBeNull();

    /*
     * The note above it is true whether or not the table overflows today's window — jsdom
     * computes no layout, and a browser at 1900px would fit the whole table. A sentence
     * announcing that something IS scrolling would be false in that state, which is the exact
     * defect class this pass exists to remove, so it is asserted as a conditional.
     */
    const note = screen.getByText(/box of their own/i).textContent ?? '';
    expect(note).toMatch(/where they do not fit/i);
    expect(note).not.toMatch(/\bis scrolling\b|\bscrolls sideways\b/i);
  });

  it('refuses to say a passage was machine-written', () => {
    const { container } = render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    for (const text of visibleTexts(container)) {
      expect(text).not.toMatch(/\b(is|was|looks|reads as) (AI|machine)[- ](written|generated)\b/i);
      expect(text).not.toMatch(/\bprobably (AI|a machine|a model)\b/i);
    }
    expect(screen.getByText(/it never claims anything was written by a machine/i)).toBeTruthy();
  });
});

describe('FactChecklist', () => {
  it('lists every assertion with its context and confirmation state', () => {
    render(<FactChecklist items={FACTS} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText('$1,099')).toBeTruthy();
    expect(screen.getByText('W8UM')).toBeTruthy();
    expect(screen.getByText(/we spent \$1,099 on it/)).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes[0]?.checked).toBe(false);
    expect(boxes[1]?.checked).toBe(true);
  });

  it('blocks export while an assertion is unconfirmed', () => {
    render(<FactChecklist items={FACTS} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText(/1 assertion still needs confirmation/i)).toBeTruthy();
  });

  it('blocks export while a TODO marker remains', () => {
    render(<FactChecklist items={[]} openTodos={2} onChange={() => undefined} />);
    expect(screen.getByText(/2 unresolved \[TODO:/i)).toBeTruthy();
  });

  it('says export is clear only when nothing is outstanding', () => {
    render(<FactChecklist items={[{ ...FACTS[1]! }]} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText(/ready to export/i)).toBeTruthy();
  });

  it('reports a confirmation change to its owner', () => {
    const onChange = vi.fn();
    render(<FactChecklist items={FACTS} openTodos={0} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(onChange).toHaveBeenCalledWith('money:12', { confirmed: true, note: '' });
  });

  /**
   * A SHORTER LIST HAS TO SAY WHY IT IS SHORTER.
   *
   * The server now keeps assertions quoted verbatim from a shipped template off `items` — 120 of
   * them for a draft that is nothing but the ARDC overlay. That is right, and it is exactly the
   * kind of silent subtraction this repository keeps finding: the panel has to name the count and
   * the template, and it has to say what brings them back.
   */
  it('says how many values it left off, and which shipped material they came from', () => {
    render(
      <FactChecklist
        items={FACTS}
        openTodos={0}
        shippedFacts={120}
        shippedTemplates={['ARDC Grants Program — funder overlay']}
        onChange={() => undefined}
      />,
    );
    const note = screen.getByText(/120 values in this draft/i);
    expect(note.textContent).toMatch(/the product’s wording rather than yours/i);
    expect(note.textContent).toContain('ARDC Grants Program — funder overlay');
    // The claim about sources is made about OVERLAYS, which all carry them — a component template
    // ships no `sources`, and a sentence promising a cited funder page for every piece of shipped
    // material would be false the moment somebody inserts "Need statement".
    expect(note.textContent).toMatch(/Every funder overlay carries the sources it was read from/i);
    expect(note.textContent).toMatch(/Edit any of that material/i);
    // THE TWO PARAGRAPHS HAVE TO PARTITION THE DRAFT BETWEEN THEM. This one said 173 values were
    // the product's while the list below it demanded nine that also were — the row numbers of a
    // shipped table and the words of a shipped budget skeleton. The server draws the line at the
    // template's blanks now, and the reader is told where it falls, because a student who typed a
    // figure into shipped scaffolding has to be able to predict which paragraph covers it.
    expect(note.textContent).toMatch(/filled into a blank in that material is yours/i);
  });

  /** One is not "1 values", and one row is not "they". */
  it('counts one quoted value in the singular', () => {
    render(
      <FactChecklist
        items={FACTS}
        openTodos={0}
        shippedFacts={1}
        shippedTemplates={['ARDC Grants Program — funder overlay']}
        onChange={() => undefined}
      />,
    );
    const note = screen.getByText(/One value in this draft is quoted/i);
    expect(note.textContent).toMatch(/so it is not listed below/i);
    expect(note.textContent).not.toMatch(/1 values|they are not listed/i);
  });

  it('says nothing about shipped material when none was recognised', () => {
    render(<FactChecklist items={FACTS} openTodos={0} shippedFacts={0} onChange={() => undefined} />);
    expect(screen.queryByText(/quoted, word for word/i)).toBeNull();
  });

  /** The lead sentence must not promise a list of every assertion when it is a list of theirs. */
  it('scopes its own opening sentence to what the list actually holds', () => {
    render(<FactChecklist items={FACTS} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText(/in your own words/i)).toBeTruthy();
  });
});

/**
 * Three properties of Task 14's checklist a UI can quietly undo: attributing a value it was never
 * told the source of, reading "the funder published this" as "a human checked this", and offering
 * a list of the specifics as if it were a list of the claims.
 */
const ATTRIBUTED: FactItemDTO[] = [
  {
    id: 'money:9',
    kind: 'money',
    text: '$1,450',
    start: 9,
    end: 15,
    context: 'a grant of $1,450 from the fund',
    confirmed: false,
    note: '',
    origin: 'program',
    slots: ['program.maxAward'],
    provenance:
      'This matches program.maxAward, read off the funder’s own record. Confirm it against the funder’s own published page before you sign.',
    fingerprint: 'fp-money',
    staleConfirmation: false,
  },
  {
    id: 'figure:40',
    kind: 'figure',
    text: '34',
    start: 40,
    end: 42,
    context: 'we have 34 members',
    confirmed: false,
    note: '',
    origin: 'unattributed',
    slots: [],
    provenance: 'Nothing you have stated matches this value, so nobody is recorded as its source.',
    fingerprint: 'fp-figure',
    staleConfirmation: false,
  },
];

describe('FactChecklist attribution and staleness', () => {
  it('shows where a value matched without ever treating that as a confirmation', () => {
    render(<FactChecklist items={ATTRIBUTED} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText(/matches the funder’s own record/i)).toBeTruthy();
    expect(screen.getByText(/Confirm it against the funder’s own published page/i)).toBeTruthy();
    expect(screen.getByText(/2 assertions still need confirmation/i)).toBeTruthy();
    expect(screen.queryByText(/ready to export/i)).toBeNull();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((b) => !b.checked)).toBe(true);
  });

  it('says "unattributed" rather than guessing a source', () => {
    render(<FactChecklist items={ATTRIBUTED} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText(/not attributed to any stated value/i)).toBeTruthy();
    expect(screen.getByText(/nobody is recorded as its source/i)).toBeTruthy();
  });

  it('says which confirmation went stale, keeps the note, and never re-ticks it', () => {
    const stale: FactItemDTO[] = [
      { ...ATTRIBUTED[0]!, text: '$9,999', confirmed: false, note: 'checked the award letter', staleConfirmation: true },
    ];
    render(<FactChecklist items={stale} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText(/You confirmed a different value at this spot/i)).toBeTruthy();
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Note for $9,999') as HTMLInputElement).value).toBe('checked the award letter');
  });

  it('does not present itself as a list of every claim in the draft', () => {
    const { container } = render(<FactChecklist items={FACTS} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText(/cannot list a claim made only in words/i)).toBeTruthy();
    expect(screen.getByText(/superlative/i)).toBeTruthy();
    expect(screen.getByText(/a ticked list here is not a checked draft/i)).toBeTruthy();
    for (const text of visibleTexts(container)) {
      expect(text).not.toMatch(/every claim (in|you)/i);
      expect(text).not.toMatch(/\bevery assertion in your draft\b/i);
    }
  });
});

describe('extractGaps', () => {
  const BODY =
    'Our club [TODO: club.callsign — the club’s callsign, e.g. W8UM] was founded in [TODO: club.foundedYear — the year the club was founded, e.g. 1909].';

  it('reads the slot path and the hint out of every marker', () => {
    const gaps = extractGaps(BODY);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.slot).toBe('club.callsign');
    expect(gaps[0]?.hint).toBe('the club’s callsign, e.g. W8UM');
    expect(gaps[1]?.slot).toBe('club.foundedYear');
  });

  it('counts exactly what the server counts as openTodos', () => {
    expect(extractGaps(BODY)).toHaveLength([...BODY.matchAll(/\[TODO:[^\]]*\]/g)].length);
    expect(extractGaps('No gaps here at all.')).toHaveLength(0);
  });

  it('offers nothing to confirm — a gap is written, not signed', () => {
    render(<DraftGaps gaps={extractGaps(BODY)} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText(/is an example of the SHAPE of the answer/)).toBeTruthy();
  });
});

/* --------------------------------- the whole screen ---------------------------------------- */

const DRAFT_BODY =
  'Dana Ruiz will spend $1,450 on March 7, 2027.\n\n[TODO: club.callsign — the club’s callsign, e.g. W8UM]';

const DRAFT = {
  id: 'app-1',
  userId: 'user-1',
  programId: 'ardc-grants',
  title: 'Untitled draft',
  bodyMarkdown: DRAFT_BODY,
  answers: {},
  factConfirmations: {},
  includeDisclosure: true,
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
};

const READINESS = {
  ready: false,
  unconfirmed: 2,
  openTodos: 1,
  rawSlots: 0,
  rawSlotPaths: [] as string[],
  items: [
    {
      id: 'money:21',
      kind: 'money',
      text: '$1,450',
      start: 21,
      end: 27,
      context: 'Dana Ruiz will spend $1,450 on March 7, 2027.',
      confirmed: false,
      note: '',
      origin: 'answer',
      slots: ['project.requestAmount'],
      provenance: 'This matches project.requestAmount, an answer you typed.',
      fingerprint: 'fp-money-1450',
      staleConfirmation: false,
    },
    {
      id: 'name:0',
      kind: 'name',
      text: 'Dana Ruiz',
      start: 0,
      end: 9,
      context: 'Dana Ruiz will spend $1,450 on March 7, 2027.',
      confirmed: false,
      note: '',
      origin: 'profile',
      slots: ['club.contactName'],
      provenance: 'This matches club.contactName, from your profile.',
      fingerprint: 'fp-name',
      staleConfirmation: false,
    },
  ],
};

const OVERLAY_LIBRARY = {
  components: [
    { id: 'need-statement', title: 'Need statement', layer: 'component', order: 10, appliesTo: ['ham_grant'], requires: [], programIds: [], alwaysAvailable: false, sources: [], slots: [] },
  ],
  overlays: [
    { id: 'funder-ardc', title: 'ARDC Grants Program — funder overlay', layer: 'funder', order: 10, appliesTo: ['ham_grant'], requires: [], programIds: ['ardc-grants'], alwaysAvailable: false, sources: [], slots: [] },
  ],
  playbooks: [],
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** One fetch stub for the whole screen, recording every call so a test can assert what was sent. */
function stubScreenFetch(
  options: { putStatus?: number; exportStatus?: number; readiness?: unknown; templates?: unknown } = {},
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const json = (payload: unknown, status = 200): Response =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

      if (url.startsWith('/api/templates/slots')) {
        return json({
          all: [],
          userAnswerable: [
            { path: 'project.requestAmount', label: 'Amount requested', hint: 'the total you are asking for', source: 'user' },
          ],
        });
      }
      if (url.startsWith('/api/templates')) return json(options.templates ?? OVERLAY_LIBRARY);
      if (url === '/api/applications') return json({ applications: [DRAFT] });
      if (url.endsWith('/facts') && method === 'PUT') {
        if (options.putStatus === 422) {
          return json(
            {
              error: {
                code: 'validation_failed',
                message: 'This draft has no fact at some of those ids — reload the checklist and confirm again.',
                details: { unknownFactIds: ['money:21'] },
              },
              requestId: 'req-1',
            },
            422,
          );
        }
        return json({
          ...READINESS,
          unconfirmed: 1,
          items: [{ ...READINESS.items[0]!, confirmed: true }, READINESS.items[1]!],
        });
      }
      if (url.endsWith('/export-readiness')) return json(options.readiness ?? READINESS);
      if (url.startsWith('/api/exports/draft.')) {
        if (options.exportStatus !== undefined && options.exportStatus !== 200) {
          return json(
            {
              error: {
                code: 'conflict',
                message:
                  'This draft is not ready to export: 2 unconfirmed factual assertion(s) and 1 ' +
                  'unresolved [TODO: …] marker(s) must be handled first.',
              },
              requestId: 'req-export',
            },
            options.exportStatus,
          );
        }
        return new Response(new Blob(['x']), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="draft.docx"',
          },
        });
      }
      if (url.startsWith('/api/applications/')) {
        // A PATCH answers with the patched draft, as the router does — a stub that echoed the
        // original would make every "the screen reflects the change" test pass for the wrong reason.
        const patch = method === 'PATCH' ? (JSON.parse(String(init?.body)) as Record<string, unknown>) : {};
        return json({ ...DRAFT, ...patch });
      }
      if (url.startsWith('/api/programs/')) {
        return json({ program: { id: 'ardc-grants', name: 'ARDC Grants Program' }, funder: { id: 'ardc' } });
      }
      if (url.startsWith('/api/profiles')) return json({ student: null, organization: { kind: 'organization' } });
      return json({});
    }),
  );
  return calls;
}

async function openTheDraft(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Untitled draft' }));
  await screen.findByRole('heading', { name: 'Fact checklist' });
}

function renderScreen(): void {
  render(
    <MemoryRouter initialEntries={['/applications?programId=ardc-grants&funderId=ardc&klass=ham_grant']}>
      <ApplicationsScreen />
    </MemoryRouter>,
  );
}

describe('gaps beside the checklist, never inside it', () => {
  it('lists a [TODO: …] marker under its own heading and not as an assertion', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();

    const gaps = screen.getByRole('region', { name: 'Gaps to fill' });
    const checklist = screen.getByRole('region', { name: 'Fact checklist' });

    expect(within(gaps).getByText(/\[TODO: club\.callsign/)).toBeTruthy();
    expect(within(gaps).getByText('the club’s callsign, e.g. W8UM')).toBeTruthy();

    /*
     * The hint's example is the exact contamination Task 14 found in its own brief: `W8UM` and
     * `1909` listed as facts awaiting confirmation, when nobody ever wrote them.
     */
    expect(within(checklist).queryByText(/W8UM/)).toBeNull();
    expect(within(checklist).queryByText(/\[TODO: club\.callsign/)).toBeNull();

    expect(gaps.contains(checklist)).toBe(false);
    expect(checklist.contains(gaps)).toBe(false);
  });

  it('keeps a gap unconfirmable and a fact confirmable', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();

    const gaps = screen.getByRole('region', { name: 'Gaps to fill' });
    const checklist = screen.getByRole('region', { name: 'Fact checklist' });
    expect(within(gaps).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(checklist).getAllByRole('checkbox')).toHaveLength(READINESS.items.length);
  });

  it('counts the gap as a blocker in the checklist and points at where it is listed', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();

    const checklist = screen.getByRole('region', { name: 'Fact checklist' });
    expect(within(checklist).getByText(/1 unresolved \[TODO: …\] marker remains/i).textContent).toMatch(
      /Gaps to fill/,
    );
  });
});

describe('confirming a fact', () => {
  it('echoes the fingerprint the checklist handed out, so the tick names the value it saw', async () => {
    const calls = stubScreenFetch();
    renderScreen();
    await openTheDraft();

    const checklist = screen.getByRole('region', { name: 'Fact checklist' });
    fireEvent.click(within(checklist).getAllByRole('checkbox')[0]!);

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      confirmations: { 'money:21': { confirmed: true, note: '', fingerprint: 'fp-money-1450' } },
    });
  });

  it('refetches the checklist instead of retrying when the server refuses a stale confirmation', async () => {
    const calls = stubScreenFetch({ putStatus: 422 });
    renderScreen();
    await openTheDraft();

    const before = calls.filter((c) => c.url.endsWith('/export-readiness')).length;
    fireEvent.click(within(screen.getByRole('region', { name: 'Fact checklist' })).getAllByRole('checkbox')[0]!);

    await waitFor(() => expect(screen.getByText(/that confirmation was refused/i)).toBeTruthy());
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/export-readiness')).length).toBeGreaterThan(before),
    );
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(screen.getByText(/read the values again and tick them/i)).toBeTruthy();
  });
});

/**
 * Task 9's three POST exports, reachable from the writing desk. `assertExportReady` refuses a
 * draft with an unconfirmed fact or an open [TODO: …] marker with HTTP 409 and its own sentence
 * naming which and how many — the point of these tests is that the sentence reaches the screen,
 * not a generic "that failed".
 */
describe('downloading the draft', () => {
  it('offers DOCX, Markdown and packet ZIP once a draft is open', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();

    expect(screen.getByRole('button', { name: 'Download DOCX' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download Markdown' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download application packet (ZIP)' })).toBeTruthy();
  });

  it('posts the applicationId to the DOCX endpoint, never the draft text', async () => {
    const calls = stubScreenFetch();
    renderScreen();
    await openTheDraft();

    fireEvent.click(screen.getByRole('button', { name: 'Download DOCX' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/exports/draft.docx')).toBe(true));
    const call = calls.find((c) => c.url === '/api/exports/draft.docx');
    expect(call?.body).toEqual({ applicationId: 'app-1', programId: 'ardc-grants' });
    expect(JSON.stringify(call?.body)).not.toContain('Dana Ruiz');
  });

  it('names which blocker is unmet, from the server, rather than failing silently', async () => {
    stubScreenFetch({ exportStatus: 409 });
    renderScreen();
    await openTheDraft();

    fireEvent.click(screen.getByRole('button', { name: 'Download Markdown' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/2 unconfirmed factual assertion/i);
    expect(alert.textContent).toMatch(/1 unresolved \[TODO: …\] marker/i);
  });

  it('says exports are blocked while the checklist below has unconfirmed items or open gaps', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();

    expect(screen.getByText(/exports are blocked until every item in the fact checklist below/i)).toBeTruthy();
    expect(screen.getByText(/2 unconfirmed/i)).toBeTruthy();
    expect(screen.getByText(/1 open/i)).toBeTruthy();
  });

  /**
   * THE GAP THIS CLOSES. Before `ExportReadinessDTO` carried `rawSlots` / `rawSlotPaths`, a draft
   * blocked only by a raw `{{club.callsign}}` placeholder rendered this same panel with no mention
   * of it — the static breakdown "knew about" only the two causes the server used to name. The
   * blocker must appear here, above the checklist, naming the slot path — not just a bare count —
   * so the applicant knows where to go fix it before the click, not after a 409.
   */
  it('names a raw {{slot}} placeholder in the static breakdown above the checklist, by path', async () => {
    stubScreenFetch({
      readiness: {
        ready: false,
        unconfirmed: 0,
        openTodos: 0,
        rawSlots: 1,
        rawSlotPaths: ['club.callsign'],
        items: [],
      },
    });
    renderScreen();
    await openTheDraft();

    const note = screen.getByText(/exports are blocked until every item in the fact checklist below/i);
    expect(note.textContent).toMatch(/1 unfilled template placeholder/i);
    expect(note.textContent).toContain('{{club.callsign}}');
    // Nothing else fired: no unconfirmed fact and no open TODO, so neither is named.
    expect(note.textContent).not.toMatch(/unconfirmed/i);
    expect(note.textContent).not.toMatch(/open \[TODO/i);
  });

  /**
   * A stale confirmation is not the same event as an item nobody ever confirmed, and the panel
   * above the checklist must say so distinctly rather than folding it into "unconfirmed" — the
   * applicant DID confirm this fact; the text under it changed after.
   */
  it('names a stale confirmation in the static breakdown, distinctly from "unconfirmed"', async () => {
    stubScreenFetch({
      readiness: {
        ready: false,
        unconfirmed: 1,
        openTodos: 0,
        rawSlots: 0,
        rawSlotPaths: [],
        items: [{ ...READINESS.items[0]!, confirmed: false, staleConfirmation: true }],
      },
    });
    renderScreen();
    await openTheDraft();

    const note = screen.getByText(/exports are blocked until every item in the fact checklist below/i);
    expect(note.textContent).toMatch(/1 confirmation\(s\) gone stale/i);
    expect(note.textContent).toMatch(/value changed since you confirmed it/i);
    expect(note.textContent).not.toMatch(/\d+ unconfirmed/i);
  });
});

describe('the whole screen', () => {
  it('promises nothing about evading detection, anywhere on the page', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();
    for (const text of visibleTexts(document.body)) {
      for (const s of sentences(text)) {
        if (EVASION.test(s) || GAMING.test(s)) expect(s, s).toMatch(NEGATED);
      }
    }
  });

  /**
   * `test/a11y.test.tsx` sweeps Plan 3's nine routes together; this screen is not in that file,
   * because it is a shared Plan 3 file with concurrent editors. The audit itself is a plain
   * function, so the sweep happens here instead of not happening.
   */
  it('passes the accessibility audit with a draft, a checklist and a gap list on screen', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();
    expect(auditA11y(document.body)).toEqual([]);
  });

  /**
   * THE SENTENCE THE TEMPLATES SCREEN WAS ALSO PRINTING, in the one other place it appears.
   *
   * The rail links to `/applications` with no query string, so nothing names a funder and
   * `overlays` is empty — and this group said "No overlay has been written for this funder yet."
   * about a funder the reader had not chosen. The list stays funder-bound here (inserting another
   * funder's criteria into this application would be a fabricated requirement); what changes is
   * that the sentence says which situation the reader is in and where the library is.
   */
  it('does not blame a missing overlay on a funder nobody has named', async () => {
    // The list the server really answers with when nothing names a funder: no overlay binds.
    stubScreenFetch({ templates: { ...OVERLAY_LIBRARY, overlays: [] } });
    render(
      <MemoryRouter initialEntries={['/applications']}>
        <ApplicationsScreen />
      </MemoryRouter>,
    );
    const group = await screen.findByRole('region', { name: 'Funder overlays' });
    expect(group.textContent).toMatch(/No funder yet/i);
    expect(group.textContent).toMatch(/Start an application for this program/);
    expect(group.textContent).not.toMatch(/No overlay has been written for this funder yet/i);
  });

  it('shows the copy-prompt button grounded in the funder arrived from', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();
    expect(screen.getByRole('button', { name: COPY_PROMPT_LABEL })).toBeTruthy();
    expect(screen.getByText(/Drafting for/).textContent).toMatch(/ARDC Grants Program/);
  });

  /**
   * ONCE. `toBeGreaterThan(0)` is what let this ship: the route rendered
   * `COPY_PROMPT_DISCLOSURE_OFF` in the else arm of its own toggle and `CopyPromptButton`
   * rendered the identical constant six lines below, so switching the sentence off printed the
   * same paragraph twice, verbatim — measured on the live site on 2026-08-13, two renders. Two
   * copies of one sentence read as two facts, and a reader hunts for the difference. The count is
   * the assertion now, in both states, for both strings.
   */
  it('says a disclosure switched off leaves the funder’s own requirement in place, exactly once', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();
    expect(screen.queryAllByText(COPY_PROMPT_DISCLOSURE_OFF)).toHaveLength(0);
    expect(screen.getAllByText(COPY_PROMPT_DISCLOSURE_ON)).toHaveLength(1);

    fireEvent.click(screen.getByLabelText(/Include an AI-use disclosure sentence/i));
    await waitFor(() => expect(screen.getAllByText(COPY_PROMPT_DISCLOSURE_OFF)).toHaveLength(1));
    expect(screen.queryAllByText(COPY_PROMPT_DISCLOSURE_ON)).toHaveLength(0);
    // And the corpus census — a different sentence, about whether to include one at all — survives
    // the switch rather than being replaced by a second copy of the off-state paragraph.
    expect(screen.getAllByText(/No funder in this corpus/i)).toHaveLength(1);
  });

  /**
   * THE SENTENCE UNDER THE DISCLOSURE CHECKBOX MAKES A CLAIM ABOUT THE CORPUS, AND NOTHING CHECKED IT.
   *
   * It read "No funder in this corpus prohibits AI assistance, and several ask to be told." The
   * first half is true. The second half was false, and it was the half that pushed a student toward
   * a disclosure: counted from `data/seed` on 2026-08-12, 142 of 143 shipped records have published
   * nothing at all about AI, one (ARDC) permits it, and the number that ask to be told is ZERO.
   * `packages/server/src/prompts/disclosure.ts` carried the identical clause and the same census
   * now guards it there.
   *
   * READ FROM THE DATA, NOT FROM A FIXTURE. A stub would let this test agree with the copy while
   * the shipped corpus disagreed with both — which is the shape of the defect, not a test of it.
   * `data/seed` is committed data rather than server code, so reading it here crosses no package
   * boundary; the file already reads `server/src/api/prompts.ts` as text for the same reason.
   */
  it('claims nothing about the corpus’s AI policies that data/seed does not support', async () => {
    const seedDir = path.resolve(import.meta.dirname, '../../../../data/seed');
    const stances = new Map<string, number>();
    for (const file of readdirSync(seedDir).filter((f) => f.startsWith('programs.'))) {
      const parsed = JSON.parse(readFileSync(path.join(seedDir, file), 'utf8')) as {
        programs?: Array<{ aiPolicy?: { stance?: string } }>;
      };
      for (const program of parsed.programs ?? []) {
        const stance = program.aiPolicy?.stance ?? 'unaddressed';
        stances.set(stance, (stances.get(stance) ?? 0) + 1);
      }
    }
    const count = (s: string): number => stances.get(s) ?? 0;
    expect(count('unaddressed') + count('permitted')).toBeGreaterThan(0); // the corpus really loaded

    stubScreenFetch();
    renderScreen();
    await openTheDraft();
    const note = await screen.findByText(/No funder in this corpus/i);
    const text = note.textContent ?? '';

    // Whatever the sentence says, each clause has to be backed by the census.
    if (/prohibits/i.test(text)) expect(count('prohibited')).toBe(0);
    if (/discourages/i.test(text)) expect(count('discouraged')).toBe(0);
    if (/\bask(s)? to be told\b/i.test(text)) {
      const asks = count('permitted_with_disclosure');
      if (/\bnone\b[^.]*ask|\bno funder\b[^.]*ask/i.test(text)) expect(asks).toBe(0);
      else expect(asks, `the screen says funders ask to be told; ${String(asks)} do`).toBeGreaterThanOrEqual(3);
    }
    // The exact retired clause, named, so a regression fails by the words that were wrong.
    expect(text).not.toMatch(/and several ask to be told/i);
  });
});

/**
 * THE PRESS THAT WENT NOWHERE, AND THE SIX THOUSAND UNIT TESTS THAT COULD NOT SEE IT.
 *
 * `e2e/writing.spec.ts:735` reads the draft body after pressing "Need statement" and went red on
 * 2026-08-13 with `Received string: ""` — an empty textarea. The fill was innocent: the filled
 * `need-statement` body is byte-identical before and after the three commits that touched the
 * writing path (`templates/renderedFill.test.ts` now pins it). The defect was here.
 *
 * `insertTemplate` opens `if (!current) return;`. The template library is fetched on mount and
 * does not wait for a draft, so every button in these three groups was LIVE from the moment the
 * screen painted — including the whole time the "New draft" POST was in flight, and including
 * before anyone had pressed "New draft" at all. A press in that window was discarded in silence:
 * no insert, no `role="alert"`, no console line, nothing for the student to read except a draft
 * body that stayed empty. Reproduced in a browser by delaying `POST /api/applications` by 1.5s,
 * which is one slow connection or one loaded server, and the e2e failure came back exactly.
 *
 * These tests hold the two halves of the fix: the control is OFF while the press would be
 * discarded, and it works the moment there is a draft to insert into. A `disabled` button is also
 * what makes the browser test deterministic rather than a race that passes on a fast laptop —
 * Playwright's actionability check waits for enabled, so the click can no longer arrive early.
 */
describe('a section cannot be inserted into a draft that does not exist yet', () => {
  /** The screen's fetches, with `POST /api/applications` held open until the test releases it. */
  function stubWithDeferredCreate(): {
    calls: Call[];
    releaseCreate: () => void;
  } {
    const calls: Call[] = [];
    let release = (): void => undefined;
    const created = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const json = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        if (url.startsWith('/api/templates/slots')) return json({ all: [], userAnswerable: [] });
        if (url.endsWith('/fill') && method === 'POST') {
          return json({
            templateId: 'need-statement',
            title: 'Need statement',
            markdown: '[TODO: club.callsign — the club’s callsign, e.g. W8UM]',
            unresolvedSlots: ['club.callsign'],
          });
        }
        if (url.startsWith('/api/templates')) return json(OVERLAY_LIBRARY);
        if (url === '/api/applications' && method === 'POST') {
          await created;
          return json({ ...DRAFT, id: 'app-new', bodyMarkdown: '' });
        }
        if (url === '/api/applications') return json({ applications: [] });
        if (url.endsWith('/export-readiness')) return json(READINESS);
        if (method === 'PATCH') return json({ ...DRAFT, id: 'app-new', bodyMarkdown: String((JSON.parse(String(init?.body)) as { bodyMarkdown?: string }).bodyMarkdown ?? '') });
        return json({});
      }),
    );
    return { calls, releaseCreate: () => { release(); } };
  }

  function renderPlain(): void {
    render(
      <MemoryRouter initialEntries={['/applications']}>
        <ApplicationsScreen />
      </MemoryRouter>,
    );
  }

  it('offers the section buttons switched off while no draft is open', async () => {
    stubWithDeferredCreate();
    renderPlain();
    const sections = await screen.findByRole('region', { name: 'Insert a section' });
    const button = within(sections).getByRole('button', { name: /Need statement/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // The screen still explains itself; the off control is not the only thing the reader gets.
    expect(screen.getByText('Start a new draft or open an existing one.')).toBeTruthy();
  });

  it('discards no press while the new draft is still being created', async () => {
    const { calls, releaseCreate } = stubWithDeferredCreate();
    renderPlain();
    const sections = await screen.findByRole('region', { name: 'Insert a section' });

    fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
    // The POST is in flight and `current` is still undefined — the exact window in which the
    // press used to be swallowed.
    const button = within(sections).getByRole('button', { name: /Need statement/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(calls.filter((c) => c.url.endsWith('/fill'))).toHaveLength(0);

    releaseCreate();
    await waitFor(() => {
      expect((within(sections).getByRole('button', { name: /Need statement/ }) as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(within(sections).getByRole('button', { name: /Need statement/ }));
    await waitFor(() => {
      expect(calls.filter((c) => c.url.endsWith('/fill'))).toHaveLength(1);
    });
    // And the fill reaches the draft: the PATCH carries the marker the browser test reads back
    // out of the textarea, so "the button works again" is asserted on the text, not on the call.
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect((patch?.body as { bodyMarkdown?: string } | undefined)?.bodyMarkdown).toContain(
        '[TODO: club.callsign — ',
      );
    });
  });
});

describe('ApplicationsScreen deep link', () => {
  function stubDeepLinkFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        const json = (payload: unknown): Response =>
          new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.startsWith('/api/templates/slots')) return json({ all: [], userAnswerable: [] });
        if (url.startsWith('/api/templates')) return json(OVERLAY_LIBRARY);
        if (url.startsWith('/api/applications')) return json({ applications: [] });
        if (url.startsWith('/api/programs/')) return json({ program: { id: 'ardc-grants' }, funder: { id: 'ardc' } });
        if (url.startsWith('/api/profiles')) return json({ student: null, organization: { kind: 'organization' } });
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
  }

  it('asks for the templates of the program named in the query string', async () => {
    stubDeepLinkFetch();
    render(
      <MemoryRouter initialEntries={['/applications?programId=ardc-grants&funderId=ardc&klass=ham_grant']}>
        <ApplicationsScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Drafting for/)).toBeTruthy());
    const called = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.startsWith('/api/templates?'));
    expect(called).toContain('programId=ardc-grants');
    expect(called).toContain('funderId=ardc');
  });

  it('pre-selects this funder’s overlay and offers to insert it', async () => {
    stubDeepLinkFetch();
    render(
      <MemoryRouter initialEntries={['/applications?programId=ardc-grants&funderId=ardc&klass=ham_grant']}>
        <ApplicationsScreen />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Insert ARDC Grants Program — funder overlay/ })).toBeTruthy(),
    );
    const selected = document.querySelector('.template-list li.selected');
    expect(selected?.textContent).toContain('ARDC Grants Program — funder overlay');
  });

  it('says so plainly when no overlay is bound to the program id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        const payload = url.startsWith('/api/templates/slots')
          ? { all: [], userAnswerable: [] }
          : url.startsWith('/api/templates')
            ? { ...OVERLAY_LIBRARY, overlays: [] }
            : url.startsWith('/api/applications')
              ? { applications: [] }
              : {};
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/applications?programId=typo-in-the-seed&klass=ham_grant']}>
        <ApplicationsScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/No funder overlay has been written/)).toBeTruthy());
  });
});

/**
 * The regression this file could not previously see, rendered the way the router draws it.
 *
 * Every other test above renders `ApplicationsScreen` bare, and that is why this screen shipped
 * with `<main className="draft-editor">` inside `AppShell`'s `<main id="main">` — two `main`
 * landmarks on the composed page, invalid HTML, an ambiguous skip-link target, and a
 * strict-mode violation for `page.getByRole('main')`. Both halves tested clean in isolation.
 *
 * `AppShell.test.tsx` carries the general guard (the shell is the only component in the package
 * that may render a `main`, so the NEXT route is covered too). This one is the specific case,
 * rendered rather than read: the shell wrapped around the real screen, counted in a real DOM.
 */
describe('ApplicationsScreen composed inside the shell', () => {
  it('adds no second main landmark to the page the router actually draws', async () => {
    stubScreenFetch();
    const { container } = render(
      <MemoryRouter initialEntries={['/applications?programId=ardc-grants&funderId=ardc&klass=ham_grant']}>
        <SessionContext.Provider
          value={makeSessionValue({
            user: { id: 'u-1', email: 'member@example.com', role: 'member' },
            unread: 0,
          })}
        >
          <AppShell>
            <ApplicationsScreen />
          </AppShell>
        </SessionContext.Provider>
      </MemoryRouter>,
    );

    // With the draft open, which is when the editor pane — the element that used to be a
    // `<main>` — is on screen at all. Counting before that would pass against the bug.
    await openTheDraft();

    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    // And the editor is still there, inside it — the fix must not have removed the pane.
    expect(within(screen.getByRole('main')).getByRole('heading', { name: 'Draft' })).toBeTruthy();
  });
});
