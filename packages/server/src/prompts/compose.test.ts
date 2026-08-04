import type { Profile, Program } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
// The real RECUR directives this corpus actually stores in `DeadlineSpec.note`. Imported rather
// than transcribed: the brief's fixture note was hand-written prose, and every real note in
// `normalize/deadline.ts` is a machine directive that must never reach the model verbatim.
import { RECURRENCE_BY_SOURCE } from '../normalize/deadline.js';
import { analyzeProse } from '../prose/index.js';
import { BANNED_TRANSITIONS, STOCK_CLOSERS, STOCK_OPENERS } from '../prose/lexicon.js';
import { composePrompt } from './compose.js';
import { DISCLOSURE_DEFAULT_ON, disclosureNote, disclosureSentence } from './disclosure.js';
import { FRAGMENT_IDS, loadFragment } from './fragments.js';

const ARDC = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Grants supporting amateur radio and digital communication.',
  applicantEntities: ['club_via_fiscal_sponsor', 'university', 'school_lea'],
  amount: { instrument: 'cash_range', amountRaw: '$1,285-$258,000', awardCountRaw: 'Multiple per year' },
  deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: 'February 1, April 1, July 1, September 1' },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.ardc.net/apply/',
  constraints: [
    {
      id: 'ardc-open-source',
      hard: true,
      fallbackRank: 0,
      rawText: 'All output must be open-source or open-access.',
      spec: { axis: 'other', note: 'open licence required' },
    },
  ],
  fundingRestrictions: ['For-profit companies are not eligible.'],
  obligations: {
    licenseObligation: 'All output must be published open-source or open-access (GPL, MIT, BSD, CERN-OHL, CC).',
    indirectCostCapPct: 20,
    costShareRequired: false,
    coFunderPreference: false,
  },
  aiPolicy: {
    stance: 'permitted',
    quote:
      "If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy. If the proposal is extremely long and hard to understand, we can't evaluate or support it.",
    url: 'https://www.ardc.net/apply/grant-application-instructions/',
  },
  trust: {
    status: 'open',
    sourceUrl: 'https://www.ardc.net/apply/',
    lastVerifiedAt: '2026-08-02',
    verificationMethod: 'live_fetch',
    contentHash: 'seed',
  },
  rawOtherText: 'Clubs and individuals apply through a fiscal sponsor.',
  tags: ['ardc'],
} as unknown as Program;

const UNADDRESSED = {
  ...ARDC,
  id: 'arrl-club-grant',
  name: 'ARRL Club Grant Program',
  aiPolicy: { stance: 'unaddressed' },
} as unknown as Program;

const MANDATORY = {
  ...ARDC,
  id: 'spencer-research-grant',
  name: 'Example Foundation Research Grant',
  aiPolicy: {
    stance: 'permitted_with_disclosure',
    quote: 'Applicants must disclose the use of generative AI in preparing the application.',
    url: 'https://example.org/ai-policy',
  },
} as unknown as Program;

/** The four fixed dates as the corpus really stores them: a RECUR directive plus human prose. */
const REAL_RECUR = {
  ...ARDC,
  deadline: {
    kind: 'n_fixed_dates',
    source: { kind: 'self' },
    note: RECURRENCE_BY_SOURCE['ardc-grants'] as string,
  },
} as unknown as Program;

const PROFILE: Profile = {
  kind: 'organization',
  entity: 'club_unincorporated',
  orgName: 'Example Collegiate Amateur Radio Club',
  callsign: 'W8UM',
  state: 'MI',
  memberCount: 34,
  institutionName: 'Example State University',
  arrlAffiliated: true,
};

/** Sentence split good enough to test polarity of a claim in shipped prose. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Any word that would turn a mention of detection into a promise about detection. */
const EVASION =
  /\b(defeat(?:s|ed|ing)?|evad(?:e|es|ed|ing)|evasion|bypass(?:es|ed|ing)?|fool(?:s|ed|ing)?|trick(?:s|ed|ing)?|dodg(?:e|es|ed|ing)?|circumvent(?:s|ed|ing|ion)?|launder(?:s|ed|ing)?|undetectable|beat(?:s|ing|en)? (?:the detector|detection)|slip(?:s|ped|ping)? past|sneak(?:s|ed|ing)? past|snuck past|get(?:s|ting)? around|got around|go(?:es|ing)? undetected|went undetected|avoid(?:s|ed|ing)? detection|pass(?:es|ed|ing)? as human|read(?:s|ing)? as human)\b/i;
const NEGATED =
  /\b(not|never|no|none|nothing|excluded|exclude|excludes|cannot|can't|won't|do not|does not|refuse|refuses|instead of|rather than)\b/i;

describe('prompt fragments', () => {
  it('loads every declared fragment with real content', () => {
    for (const id of FRAGMENT_IDS) {
      const body = loadFragment(id);
      expect(body.length, id).toBeGreaterThan(300);
    }
  });

  it('throws on an unknown fragment id instead of returning an empty brief', () => {
    expect(() => loadFragment('no-such-fragment')).toThrow(/unknown prompt fragment/);
  });

  it('states the Kobak grounding and why classifier-gaming is excluded', () => {
    const why = loadFragment('why-these-rules');
    expect(why).toContain('10.1126/sciadv.adt3813');
    expect(why).toMatch(/66% verbs/);
    expect(why).toMatch(/79% nouns/);
    expect(why).toMatch(/not a banned-word list|not a blacklist/i);
    expect(why).toMatch(/synonym/i);
    expect(why).toMatch(/typos/i);
    expect(why).toMatch(/invisible|homoglyph/i);
  });

  it('bans the four transitions and caps participials and tricolons', () => {
    const neg = loadFragment('style-negative');
    for (const t of ['Furthermore', 'Moreover', 'Additionally', 'It is important to note that']) {
      expect(neg).toContain(t);
    }
    expect(neg).toMatch(/at most one trailing participial/i);
    expect(neg).toMatch(/at most one three-item list|tricolon/i);
    expect(neg).toMatch(/vary sentence length/i);
  });

  /**
   * The offline analyzer and the prompt must name the SAME phrases. If `prose/lexicon.ts` flags a
   * stock opener the brief never banned, the product tells the applicant off for something it
   * never asked them to avoid — and the two halves of section 10 drift apart silently.
   */
  it('bans exactly the phrases the offline analyzer flags', () => {
    const neg = loadFragment('style-negative');
    for (const phrase of [...BANNED_TRANSITIONS, ...STOCK_OPENERS, ...STOCK_CLOSERS]) {
      expect(neg, phrase).toContain(phrase);
    }
  });

  it('requires named subjects, proper nouns, figures and the adjective-deletion test', () => {
    const pos = loadFragment('style-positive');
    expect(pos).toMatch(/named human or a named organization/i);
    expect(pos).toMatch(/W8UM|K5UTD/);
    expect(pos).toMatch(/IC-7300|IC-7610|DR-2X/);
    expect(pos).toMatch(/adjective-deletion/i);
  });

  /**
   * The worked example in the brief is checked by the product's own analyzer. A "write like this"
   * sample that the generic-prose check would not call specific is the product contradicting
   * itself in its two most visible surfaces.
   */
  it("has a worked example that analyzeProse itself calls specific", () => {
    const pos = loadFragment('style-positive');
    const good = /^Write: (.+)$/m.exec(pos)?.[1];
    const bad = /^Not: (.+)$/m.exec(pos)?.[1];
    expect(good, 'style-positive.md needs a "Write: …" example').toBeTruthy();
    expect(bad, 'style-positive.md needs a "Not: …" counter-example').toBeTruthy();
    expect(analyzeProse(good as string).paragraphs[0]?.verdict).toBe('specific');
    expect(analyzeProse(bad as string).paragraphs[0]?.verdict).not.toBe('specific');
  });

  it('makes the model interview before drafting and turn gaps into TODO markers', () => {
    const iv = loadFragment('interview');
    expect(iv).toMatch(/do not (produce|write) any .*prose until/i);
    expect(iv).toMatch(/\[TODO:/);
    expect(iv).toMatch(/line by line/i);
  });

  it('forbids inventing a citation, statistic or URL', () => {
    const ni = loadFragment('never-invent');
    expect(ni).toMatch(/citation/i);
    expect(ni).toMatch(/statistic|figure/i);
    expect(ni).toMatch(/URL/);
    expect(ni).toMatch(/Facts to verify/);
  });

  it('never instructs synonym swapping, typo injection or invisible characters', () => {
    for (const id of FRAGMENT_IDS) {
      for (const s of sentences(loadFragment(id))) {
        if (/\b(synonym|synonyms|typo|typos|homoglyph|invisible character)/i.test(s)) {
          expect(s, `${id}: "${s}"`).toMatch(NEGATED);
        }
      }
    }
  });

  it('never promises that any of this defeats an AI detector', () => {
    for (const id of FRAGMENT_IDS) {
      for (const s of sentences(loadFragment(id))) {
        if (EVASION.test(s)) expect(s, `${id}: "${s}"`).toMatch(NEGATED);
      }
    }
  });

  /**
   * The rule EVASION enforces is polarity, not vocabulary: these words are fine when the sentence
   * is negating them, forbidden only as a bare promise. A widened regex that turned into a
   * banned-word list would break the brief's own honesty sentence, which must be able to NAME
   * defeat, evasion, bypassing, fooling, tricking, dodging, circumventing, laundering,
   * undetectability, slipping/sneaking past, getting around, going undetected and avoiding
   * detection in order to disclaim every one of them.
   */
  it('still allows honest negated discussion using the whole widened vocabulary', () => {
    const honest =
      'This method does not defeat, evade, bypass, fool, trick, dodge, circumvent or launder any AI-detection classifier, is not undetectable, never slips past, sneaks past or gets around it, does not go undetected or avoid detection, and involves no evasion or circumvention of any kind.';
    for (const s of sentences(honest)) {
      expect(EVASION.test(s), s).toBe(true);
      if (EVASION.test(s)) expect(s, s).toMatch(NEGATED);
    }
  });
});

describe('disclosureSentence', () => {
  it('defaults to on', () => {
    expect(DISCLOSURE_DEFAULT_ON).toBe(true);
  });

  it('produces an editable one-sentence disclosure naming the tool and the responsible human', () => {
    const s = disclosureSentence({ stance: 'permitted', funderName: 'ARDC', toolName: 'Claude', authorName: 'Dana Ruiz' });
    expect(s).toMatch(/Claude/);
    expect(s).toMatch(/Dana Ruiz/);
    expect(s).toMatch(/reviewed|verified/);
    expect(s.split('. ').length).toBeLessThanOrEqual(2);
  });

  it('falls back to "the applicant" when no author is given', () => {
    expect(disclosureSentence({ stance: 'permitted', funderName: 'ARDC' })).toMatch(/the applicant/);
  });

  it('names the funder only where that funder has asked for the disclosure', () => {
    const mandatory = disclosureSentence({ stance: 'permitted_with_disclosure', funderName: 'Example Foundation' });
    expect(mandatory).toContain('Example Foundation');
    expect(mandatory.split('. ').length).toBeLessThanOrEqual(2);
    expect(disclosureSentence({ stance: 'permitted', funderName: 'Example Foundation' })).not.toContain(
      'Example Foundation',
    );
  });

  it('says only what the applicant did, per the usage they picked', () => {
    expect(disclosureSentence({ stance: 'permitted', funderName: 'ARDC', usage: 'editing' })).toMatch(
      /edited with the assistance of/,
    );
    expect(disclosureSentence({ stance: 'permitted', funderName: 'ARDC', usage: 'editing' })).not.toMatch(/drafted/);
    expect(disclosureSentence({ stance: 'permitted', funderName: 'ARDC', usage: 'drafting' })).not.toMatch(/edited/);
  });

  it('says disclosure is mandatory when the funder requires it', () => {
    expect(disclosureNote('permitted_with_disclosure')).toMatch(/mandatory|required/i);
  });

  it('says plainly that an unaddressed funder has published nothing, and does not guess', () => {
    const note = disclosureNote('unaddressed');
    expect(note).toMatch(/has not published/i);
    expect(note).toMatch(/does not guess|no position/i);
    expect(note).not.toMatch(/probably|likely|we assume/i);
  });
});

describe('composePrompt', () => {
  const prompt = composePrompt({ program: ARDC, profile: PROFILE, includeDisclosure: true });

  it("names the funder's real obligations, restrictions and constraint text", () => {
    expect(prompt).toContain('ARDC Grants Program');
    expect(prompt).toContain('All output must be published open-source or open-access');
    expect(prompt).toContain('20%');
    expect(prompt).toContain('For-profit companies are not eligible.');
    expect(prompt).toContain('All output must be open-source or open-access.');
    expect(prompt).toContain('Clubs and individuals apply through a fiscal sponsor.');
    expect(prompt).toContain('February 1, April 1, July 1, September 1');
  });

  it("quotes the funder's AI policy with its source URL", () => {
    expect(prompt).toContain('thoroughly edit for clarity, brevity, and accuracy');
    expect(prompt).toContain('https://www.ardc.net/apply/grant-application-instructions/');
  });

  it('carries the profile facts it actually has and invents none it does not', () => {
    expect(prompt).toContain('Example Collegiate Amateur Radio Club');
    expect(prompt).toContain('W8UM');
    expect(prompt).toContain('34');
    expect(prompt).not.toMatch(/\bEIN\b.*\d{2}-\d{7}/);
  });

  it('includes every rule fragment, whole', () => {
    for (const id of FRAGMENT_IDS) expect(prompt, id).toContain(loadFragment(id));
    expect(prompt).toContain('Furthermore');
    expect(prompt).toMatch(/named human or a named organization/i);
    expect(prompt).toMatch(/Interview me before you draft/i);
    expect(prompt).toMatch(/Brevity pass/i);
    expect(prompt).toMatch(/Never invent evidence/i);
    expect(prompt).toContain('10.1126/sciadv.adt3813');
  });

  it('includes the disclosure sentence when asked and omits it when not', () => {
    expect(prompt).toMatch(/AI-use disclosure/i);
    const without = composePrompt({ program: ARDC, profile: PROFILE, includeDisclosure: false });
    expect(without).not.toMatch(/AI-use disclosure/i);
  });

  it('reports an unaddressed AI policy honestly instead of guessing', () => {
    const p = composePrompt({ program: UNADDRESSED, includeDisclosure: true });
    expect(p).toMatch(/has not published .*polic/i);
    expect(p).not.toMatch(/permits|allows|encourages/i);
  });

  /**
   * Turning the disclosure sentence off is a choice about this document. It is not permission to
   * hide that the funder demands disclosure — that fact belongs to the funder, not to the toggle.
   */
  it("still states a mandatory-disclosure requirement when the sentence is switched off", () => {
    const p = composePrompt({ program: MANDATORY, profile: PROFILE, includeDisclosure: false });
    expect(p).toMatch(/mandatory|required/i);
    expect(p).toContain('Applicants must disclose the use of generative AI');
  });

  it('tells the applicant plainly when a funder prohibits AI drafting', () => {
    const banned = {
      ...ARDC,
      aiPolicy: { stance: 'prohibited', quote: 'Applications must be written by the applicant.', url: 'https://example.org/p' },
    } as unknown as Program;
    const p = composePrompt({ program: banned, profile: PROFILE, includeDisclosure: true });
    expect(p).toMatch(/prohibits AI assistance/i);
    expect(p).toMatch(/Do not use a model to draft or edit this application/i);
  });

  it('never tells the applicant to conceal the use of AI', () => {
    for (const p of [prompt, composePrompt({ program: MANDATORY, profile: PROFILE, includeDisclosure: false })]) {
      expect(p).not.toMatch(/\b(conceal|hide the use of|do not disclose|omit the disclosure|keep it to yourself)\b/i);
    }
  });

  it('never promises to defeat an AI detector anywhere in the whole prompt', () => {
    for (const s of sentences(prompt)) {
      if (EVASION.test(s)) expect(s, s).toMatch(NEGATED);
    }
    expect(prompt).toContain('Nothing in this brief will make an AI-detection classifier report "human"');
  });

  it('appends the chosen template body when a templateId is given', () => {
    const p = composePrompt({ program: ARDC, profile: PROFILE, templateId: 'need-statement', includeDisclosure: false });
    expect(p).toMatch(/Need statement/);
    expect(p).toMatch(/Common failure/);
  });

  /**
   * The skeleton is filled through the same `buildSlotContext` -> `fillTemplate` path the document
   * itself uses, so the model sees the applicant's real facts and an explicit hole everywhere else
   * — never a raw `{{club.city}}`, which a model would either echo or quietly invent a value for.
   */
  it('fills the skeleton from the profile and leaves visible gaps for the rest', () => {
    const p = composePrompt({ program: ARDC, profile: PROFILE, templateId: 'need-statement', includeDisclosure: false });
    expect(p).toContain('Example Collegiate Amateur Radio Club (W8UM) is an ARRL-affiliated club');
    expect(p).toMatch(/\[TODO: project\.problem/);
    expect(p).not.toMatch(/\{\{[a-z]/i);
    // The gaps are also listed as the questions to ask, by label.
    expect(p).toMatch(/Gaps in that skeleton/i);
    expect(p).toContain('project.problem');
  });

  it('leaves every slot as a gap when there is no profile at all', () => {
    const p = composePrompt({ program: ARDC, templateId: 'need-statement', includeDisclosure: false });
    expect(p).toMatch(/\[TODO: club\.callsign/);
    expect(p).toMatch(/\[TODO: club\.memberCount/);
    expect(p).not.toContain('W8UM,');
  });

  /**
   * `DeadlineSpec.note` really holds `RECUR n_fixed_dates tz=… dates=02-01,…`. Pasting that into
   * the model's brief hands it a machine directive to interpret, and `dates=02-01` is not a date a
   * grant writer can read. The directive is parsed, never printed.
   */
  it('renders a real RECUR deadline note as dates, and never as the directive', () => {
    const p = composePrompt({ program: REAL_RECUR, profile: PROFILE, includeDisclosure: false });
    expect(p).not.toContain('RECUR');
    expect(p).not.toContain('dates=02-01');
    expect(p).not.toContain('tz=America/Los_Angeles');
    expect(p).toContain('February 1');
    expect(p).toContain('September 1');
    expect(p).toContain('America/Los_Angeles');
    // The human prose after the `|` is the funder's own, and it survives.
    expect(p).toContain('ARDC evaluates for 60–120 days');
  });

  it('drops a malformed RECUR directive rather than printing it', () => {
    const broken = {
      ...ARDC,
      deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: 'RECUR n_fixed_dates dates=02-01 | Four cycles a year.' },
    } as unknown as Program;
    const p = composePrompt({ program: broken, includeDisclosure: false });
    expect(p).not.toContain('RECUR');
    expect(p).not.toContain('dates=02-01');
    expect(p).toContain('Four cycles a year.');
  });

  it('says an inherited deadline is inherited', () => {
    const inherited = {
      ...ARDC,
      deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'ardc-grants' }, note: '' },
    } as unknown as Program;
    expect(composePrompt({ program: inherited, includeDisclosure: false })).toMatch(
      /inherited from .*ardc-grants/,
    );
  });

  /** Internal enum values are for the database. A person and a model both read English. */
  it('never leaks a raw enum value into the brief', () => {
    for (const raw of [
      'ham_grant',
      'club_via_fiscal_sponsor',
      'school_lea',
      'external_spa_portal',
      'n_fixed_dates',
      'cash_range',
      'club_unincorporated',
    ]) {
      expect(prompt, raw).not.toContain(raw);
    }
  });

  /**
   * `Obligations.costShareRequired` is a TRI-state: `true` required, `false` the funder said it is
   * not, absent NOBODY SAID. 148 published records once asserted "no cost share required" off an
   * absent field. A prompt that reads it as a boolean would print that claim into the application.
   */
  it('reads the tri-state obligations as three states, not two', () => {
    const required = { ...ARDC, obligations: { costShareRequired: true, coFunderPreference: true } } as unknown as Program;
    const stated = { ...ARDC, obligations: { costShareRequired: false, coFunderPreference: false } } as unknown as Program;
    const silent = { ...ARDC, obligations: {} } as unknown as Program;

    expect(composePrompt({ program: required, includeDisclosure: false })).toMatch(/[Cc]ost share is required/);
    expect(composePrompt({ program: stated, includeDisclosure: false })).toMatch(
      /funder states that cost share is not required/i,
    );

    const s = composePrompt({ program: silent, includeDisclosure: false });
    expect(s).not.toMatch(/cost share is (not )?required\./i);
    expect(s).toMatch(/says nothing about cost sharing/i);
    expect(s).toMatch(/says nothing about co-funding/i);
  });

  it('carries a contested fact and its sources', () => {
    const disputed = {
      ...ARDC,
      trust: {
        ...(ARDC.trust as object),
        disputed: {
          note: 'Two live pages give different closing dates.',
          claims: [{ claim: 'Closes December 30', sourceUrl: 'https://example.org/a' }],
        },
      },
    } as unknown as Program;
    const p = composePrompt({ program: disputed, includeDisclosure: false });
    expect(p).toContain('Two live pages give different closing dates.');
    expect(p).toContain('https://example.org/a');
  });

  it('gives the contact route when the funder publishes no apply URL', () => {
    const byEmail = {
      ...ARDC,
      applyVia: 'email_pdf_packet',
      applyUrl: undefined,
      applyContact: 'grants@example.org',
    } as unknown as Program;
    const p = composePrompt({ program: byEmail, includeDisclosure: false });
    expect(p).toContain('grants@example.org');
    expect(p).not.toContain('email_pdf_packet');
  });

  /**
   * The end-to-end claim of section 10: the analyzer's complaints about a real generic passage are
   * all things this brief actually told the writer not to do.
   */
  it('names every tell the analyzer finds in a real generic passage', () => {
    const generic = [
      "In today's rapidly evolving landscape, our organization delves into the transformative",
      'potential of amateur radio to empower the next generation. Furthermore, this comprehensive',
      'initiative underscores our unwavering commitment to educate, empower, and inspire learners',
      'across a myriad of disciplines, ensuring that participants gain invaluable insights. Moreover,',
      'the implementation of a robust outreach framework will foster meaningful engagement, allowing',
      'us to leverage cutting-edge methodologies while enhancing community resilience, thereby',
      'ensuring long-term impact for years to come.',
    ].join(' ');
    const report = analyzeProse(generic);
    expect(report.paragraphs[0]?.verdict).toBe('generic');
    const hits = [
      ...(report.paragraphs[0]?.stockTransitionHits ?? []),
      ...report.stockOpenerHits,
      ...report.stockCloserHits,
    ];
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(prompt, hit).toContain(hit);
  });

  it('is deterministic', () => {
    expect(composePrompt({ program: ARDC, profile: PROFILE, includeDisclosure: true })).toBe(prompt);
  });
});
