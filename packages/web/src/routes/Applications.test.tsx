// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
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
function stubScreenFetch(options: { putStatus?: number; exportStatus?: number } = {}): Call[] {
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
      if (url.startsWith('/api/templates')) return json(OVERLAY_LIBRARY);
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
      if (url.endsWith('/export-readiness')) return json(READINESS);
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

  it('shows the copy-prompt button grounded in the funder arrived from', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();
    expect(screen.getByRole('button', { name: COPY_PROMPT_LABEL })).toBeTruthy();
    expect(screen.getByText(/Drafting for/).textContent).toMatch(/ARDC Grants Program/);
  });

  it('says a disclosure switched off leaves the funder’s own requirement in place', async () => {
    stubScreenFetch();
    renderScreen();
    await openTheDraft();
    fireEvent.click(screen.getByLabelText(/Include an AI-use disclosure sentence/i));
    await waitFor(() => expect(screen.getAllByText(COPY_PROMPT_DISCLOSURE_OFF).length).toBeGreaterThan(0));
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
