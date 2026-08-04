import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDocIndex,
  countFigures,
  countProperNouns,
  isFigureToken,
  splitParagraphs,
  splitSentences,
  styleWordHits,
  tokenize,
  variance,
} from './features.js';
import {
  STYLE_ADJECTIVES,
  STYLE_ADVERBS,
  STYLE_NOUNS,
  STYLE_VERBS,
  STYLE_WORDS,
} from './lexicon.js';

describe('splitParagraphs', () => {
  it('splits on blank lines and drops empties', () => {
    expect(splitParagraphs('one\n\ntwo\n\n\n  \n\nthree')).toEqual(['one', 'two', 'three']);
  });
});

describe('splitSentences', () => {
  it('splits on terminal punctuation followed by whitespace', () => {
    expect(splitSentences('We met. They left! Did they? Yes.')).toEqual([
      'We met.',
      'They left!',
      'Did they?',
      'Yes.',
    ]);
  });

  it('does not split on a decimal point', () => {
    expect(splitSentences('Our GPA floor is 3.5 for that award.')).toHaveLength(1);
  });

  it('does not split on a known abbreviation or an initial', () => {
    expect(splitSentences('Dr. Ruiz teaches it. She is a General.')).toEqual([
      'Dr. Ruiz teaches it.',
      'She is a General.',
    ]);
    expect(splitSentences('J. Hall signed the form.')).toHaveLength(1);
  });

  /**
   * `Ph.D.` is the abbreviation this repo's naive splitters have broken on repeatedly, and it is
   * NOT reachable from an abbreviation list: the word immediately before the final period is
   * "Ph.D", never "D", so a list of whole words cannot hold it. It needs the structural
   * single-capital-initial rule that `normalize/axes/clauses.ts` derived from the corpus.
   */
  it('does not split inside a dotted title such as Ph.D.', () => {
    expect(splitSentences('She is a Ph.D. student in physics.')).toHaveLength(1);
    expect(splitSentences('Dana Ruiz, Ph.D., teaches it.')).toHaveLength(1);
    expect(splitSentences('The U.S. Army Signal Corps ran it.')).toHaveLength(1);
  });

  /**
   * The other half of that rule: a word that merely ENDS in a capital is not an initial, so a
   * sentence closing on a callsign or a model number still ends. Getting this wrong would glue
   * every ham-radio sentence to the next one and destroy the sentence-length variance figure.
   */
  it('still ends a sentence that closes on a callsign or a model number', () => {
    expect(splitSentences('The club callsign is W8UM. Members meet weekly.')).toHaveLength(2);
    expect(splitSentences('The repeater is a DR-2X. It covers the county.')).toHaveLength(2);
  });
});

describe('tokenize', () => {
  it('keeps model numbers, callsigns and money together and strips trailing punctuation', () => {
    expect(tokenize('We bought an IC-7300, a GP-3, and paid $1,450. W8UM logged it.')).toEqual([
      'We', 'bought', 'an', 'IC-7300', 'a', 'GP-3', 'and', 'paid', '$1,450', 'W8UM', 'logged', 'it',
    ]);
  });
});

describe('isFigureToken', () => {
  it('accepts bare numbers, money, percentages and number words', () => {
    for (const t of ['24', '2027', '3.5', '$1,450', '20%', 'three', 'Twelve']) {
      expect(isFigureToken(t), t).toBe(true);
    }
  });

  it('rejects callsigns and model numbers', () => {
    for (const t of ['W8UM', 'IC-7300', 'GP-3', 'KD9XYZ']) expect(isFigureToken(t), t).toBe(false);
  });
});

describe('styleWordHits', () => {
  it('matches inflected forms without banning ordinary words outright', () => {
    const hits = styleWordHits(tokenize('This delves into the transformative potential of showcasing insights.'));
    expect(hits).toContain('delves');
    expect(hits).toContain('transformative');
    expect(hits).toContain('potential');
    expect(hits).toContain('showcasing');
    expect(hits).toContain('insights');
  });

  it('finds nothing in a concrete sentence', () => {
    expect(styleWordHits(tokenize('Dana Ruiz will teach four sessions in Room 214 on March 7.'))).toEqual([]);
  });
});

describe('countProperNouns', () => {
  const doc = (text: string) => buildDocIndex(text);

  it('counts mid-sentence capitals, all-caps tokens, callsigns and model numbers', () => {
    const text = 'The club bought an Icom IC-7300 for W8UM at Example State University.';
    expect(countProperNouns(text, doc(text))).toBe(6); // Icom, IC-7300, W8UM, Example, State, University
  });

  it('does not count an ordinary sentence-initial word', () => {
    const text = 'Members who want to operate often leave without a contact.';
    expect(countProperNouns(text, doc(text))).toBe(0);
  });

  it('counts a sentence-initial word that appears capitalized mid-sentence elsewhere', () => {
    const text = 'The class was taught by Dana Ruiz. Dana teaches every spring.';
    expect(countProperNouns(text, doc(text))).toBe(3); // Dana, Ruiz, Dana
  });

  /**
   * A first-person contraction is capitalized mid-sentence and is not a named actor. Counting
   * "I've" as a proper noun would silence the zero-proper-noun flag on exactly the prose most
   * likely to need it — a personal statement written entirely in generalities.
   */
  it('does not count a first-person pronoun or its contractions', () => {
    const text = "Since last spring I've served as trustee, and I'm the operator who runs the net.";
    expect(countProperNouns(text, doc(text))).toBe(0);
  });
});

describe('countFigures and variance', () => {
  it('counts every figure token in a paragraph', () => {
    expect(countFigures(tokenize('24 students met on March 7, 2027 and paid $15 each.'))).toBe(4);
  });

  /**
   * The vague-quantifier "one" is the one word that can hand a paragraph containing nothing a
   * figureCount of 1, and so silence the zero-referent flag on the prose it exists to catch.
   */
  it('does not count "one" used as a vague quantifier', () => {
    expect(countFigures(tokenize('This is one of the most exciting opportunities available.'))).toBe(0);
    expect(countFigures(tokenize('No one is left behind by our initiative.'))).toBe(0);
  });

  it('still counts "one" when it states a scale, and never suppresses another number word', () => {
    expect(countFigures(tokenize('The club will buy one Icom IC-7300 this spring.'))).toBe(1);
    // The spec's own example of a GOOD sentence. Generalising the rule to "<number> of" would
    // delete its figure and flag the sentence the whole style ruleset is written to produce.
    expect(countFigures(tokenize('Three of our members will teach a Saturday class.'))).toBe(1);
    expect(countFigures(tokenize('Two of the 12 sessions are on air.'))).toBe(2);
  });

  it('computes population variance', () => {
    expect(variance([])).toBe(0);
    expect(variance([10, 10, 10])).toBe(0);
    expect(variance([5, 15])).toBe(25);
  });
});

/**
 * THE TWO PASSAGES.
 *
 * The failure mode this module has to avoid is the one this codebase keeps producing: a number
 * that looks plausible and is wrong. For a generic-prose flag that means either firing on good
 * writing or staying silent on empty writing, so the primitives are measured here against one
 * passage of each kind. Task 13 turns these counts into a verdict; this task only has to make the
 * counts trustworthy.
 *
 * Neither passage is a straw man. GENERIC is well-formed, grammatical, on-topic English of the
 * kind a language model actually produces, and it would pass a spell-check and a read-aloud.
 * SPECIFIC uses the same subject matter and roughly the same length. What separates them is
 * exactly what Kobak et al. measured: GENERIC carries style words and no referents, SPECIFIC
 * carries referents and no style words.
 */
const GENERIC = [
  "In today's rapidly evolving landscape, amateur radio offers a transformative opportunity to",
  'foster meaningful engagement among students. Our comprehensive initiative will leverage',
  'cutting-edge technology to empower learners and cultivate a vibrant community of operators. By',
  'harnessing the potential of digital communication, we aim to showcase the profound impact of',
  'hands-on learning while ensuring a robust framework for sustainable growth.',
].join(' ');

const SPECIFIC = [
  'W8UM, the campus radio club, will run 12 licensing sessions in Room 214 between September 8,',
  '2027 and April 20, 2028. Dana Ruiz, KD9XYZ, teaches the Technician syllabus; the club will buy',
  'one Icom IC-7300 and two GP-3 antennas for $2,150.',
].join(' ');

describe('the primitives on known-generic and known-specific prose', () => {
  it('finds a busy style with nothing referential in the generic passage', () => {
    const hits = styleWordHits(tokenize(GENERIC));
    expect(hits.length).toBeGreaterThanOrEqual(20);
    expect(countProperNouns(GENERIC, buildDocIndex(GENERIC))).toBe(0);
    expect(countFigures(tokenize(GENERIC))).toBe(0);
  });

  it('stays completely silent on the specific passage', () => {
    // The claim that matters most: zero false positives on prose a reviewer would call good.
    expect(styleWordHits(tokenize(SPECIFIC))).toEqual([]);
  });

  it('finds dense referents in the specific passage', () => {
    // W8UM, Room, September, April | Ruiz, KD9XYZ, Technician, Icom, IC-7300, GP-3.
    // "Dana" is deliberately NOT among them: it is sentence-initial and appears capitalized
    // nowhere else, which is the conservative half of the sentence-initial rule doing its job.
    expect(countProperNouns(SPECIFIC, buildDocIndex(SPECIFIC))).toBe(10);
    // 12, 214, 8, 2027, 20, 2028 | one, two, $2,150.
    expect(countFigures(tokenize(SPECIFIC))).toBe(9);
  });

  it('separates the two passages on every axis at once, which is the whole signal', () => {
    const generic = {
      style: styleWordHits(tokenize(GENERIC)).length,
      referents: countProperNouns(GENERIC, buildDocIndex(GENERIC)) + countFigures(tokenize(GENERIC)),
    };
    const specific = {
      style: styleWordHits(tokenize(SPECIFIC)).length,
      referents:
        countProperNouns(SPECIFIC, buildDocIndex(SPECIFIC)) + countFigures(tokenize(SPECIFIC)),
    };
    expect(generic.style).toBeGreaterThan(specific.style);
    expect(specific.referents).toBeGreaterThan(generic.referents);
    expect(generic.referents).toBe(0);
  });
});

/**
 * THE ANTI-DRIFT INVARIANT.
 *
 * The cargo-cult version of Kobak et al. is a list of "words that sound AI-ish", which grows
 * without bound, is mostly nouns, and makes the tool worse while sounding cleverer. The finding
 * is grammatical, not lexical: 2024's excess vocabulary was 66% verbs and 14% adjectives, against
 * 79% NOUNS in the Covid-era baseline. These tests pin that shape so a later edit that tips the
 * lexicon noun-heavy — or that starts listing referents, which is the counterweight the analyzer
 * measures AGAINST — turns red rather than quietly changing what the tool is measuring.
 */
describe('STYLE_WORDS is scoped by grammar, not by vibe', () => {
  it('stays majority verb and adjective, the shape the 2024 finding actually had', () => {
    const style = STYLE_VERBS.length + STYLE_ADJECTIVES.length + STYLE_ADVERBS.length;
    const total = style + STYLE_NOUNS.length;
    expect(style / total).toBeGreaterThan(0.6);
    expect(STYLE_NOUNS.length).toBeLessThan(STYLE_VERBS.length + STYLE_ADJECTIVES.length);
  });

  it('assigns each word to exactly one grammatical class', () => {
    const all = [...STYLE_VERBS, ...STYLE_ADJECTIVES, ...STYLE_NOUNS, ...STYLE_ADVERBS];
    expect(all.length).toBe(new Set(all).size);
    expect(STYLE_WORDS.size).toBe(all.length);
  });

  it('lists lowercase base forms only, so features.ts derives the inflections', () => {
    for (const word of STYLE_WORDS) {
      expect(word, word).toBe(word.toLowerCase());
      expect(/^[a-z]+(?:-[a-z]+)*$/.test(word), word).toBe(true);
    }
  });

  it('holds no referent — the thing it is measured against is never the thing it measures', () => {
    for (const referent of [
      'w8um', 'kd9xyz', 'icom', 'ic-7300', 'gp-3', 'dr-2x', 'arrl', 'ardc',
      'antenna', 'repeater', 'callsign', 'license', 'transceiver',
      'student', 'university', 'club', 'saturday', 'march', 'semester', 'dollar',
      'three', 'twelve', 'hundred',
    ]) {
      expect(STYLE_WORDS.has(referent), referent).toBe(false);
    }
  });
});

/**
 * The Global Constraint that `packages/server/src/prose/` is PURE — zero I/O, zero network, no
 * API key, no `node:` imports — is otherwise enforced by nobody. It is the kind of property that
 * is true on the day it is written and quietly false three tasks later, so it is asserted against
 * the files on disk rather than trusted. The walk covers every non-test `.ts` in the directory,
 * so the modules Task 13 and Task 14 add are checked the moment they exist.
 */
describe('prose/ stays a pure module', () => {
  it('imports nothing outside itself and reaches nothing at runtime', async () => {
    const dir = import.meta.dirname;
    const sources = (await readdir(dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources.length, 'the purity walk sees no source at all').toBeGreaterThan(0);

    for (const file of sources) {
      const src = await readFile(path.join(dir, file), 'utf8');
      const specifiers = [
        ...[...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
        ...[...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ];
      for (const specifier of specifiers) {
        expect(specifier.startsWith('./'), `${file} imports "${specifier}" from outside prose/`).toBe(
          true,
        );
      }
      expect(/\brequire\s*\(/.test(src), `${file} calls require()`).toBe(false);
      expect(/\bimport\s*\(/.test(src), `${file} uses a dynamic import()`).toBe(false);
      expect(/\bfetch\s*\(/.test(src), `${file} calls fetch()`).toBe(false);
      expect(/\bprocess\.env\b/.test(src), `${file} reads process.env`).toBe(false);
    }
  });
});
