import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * THE INVENTORY OF EVERY SENTENCE THIS SOFTWARE SAYS TO A PERSON.
 *
 * WHY IT EXISTS. Four rounds of adversarial review have now found the same defect wearing
 * different clothes, and it is always a SENTENCE THAT WAS FALSE IN THE STATE THAT PRODUCED IT: a
 * burst refusal promising a one-second wait for a fifteen-minute lockout; "from your network"
 * naming a whole Cloudflare tunnel; "No account has been created" printed while two hundred rows
 * existed; "FCC record for undefined"; "could not be reached" about a 200 that was mid-answer;
 * "the record either did not state it, or you changed what it said" about a record that stated it
 * to an applicant who changed nothing.
 *
 * In almost every one of those cases NO TEST ASSERTED THAT SENTENCE AT ALL. The component was
 * tested — its branching, its markup, its accessibility — and the words it printed were the one
 * part nobody looked at. That is the hole this module measures.
 *
 * WHAT IT IS. A parser, not a grep. Every product source file is parsed with the TypeScript
 * compiler that already builds this repo (no new dependency), and the strings a person can
 * actually read are pulled out of the syntax tree: JSX text nodes, prose-carrying JSX attributes,
 * prose-carrying object keys, and the messages of the two error classes that have a documented
 * path to a human — `AppError`, whose message becomes `error.message` in the HTTP envelope the
 * browser prints, and `ConfigError`, whose message is what a refused boot says to the operator.
 *
 * WHAT IT DELIBERATELY IS NOT. It is not a translation catalogue and it is not a snapshot. A
 * snapshot of copy fails when a sentence CHANGES, which trains everybody to re-bless it and is
 * how a guard becomes a formality; see `userFacingCopyContract.test.ts` for the two checks built
 * on this inventory and why each fails when a sentence is WRONG rather than merely different.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/**
 * The three trees that can produce a sentence a person reads, and nothing else.
 *
 * `scripts/` is excluded on purpose: it prints to the operator's terminal during a manual command,
 * never to an applicant, and `contactUrlEntryPointContract.test.ts` already governs what it may do.
 */
export const PRODUCT_TREES = [
  'packages/web/src',
  'packages/server/src',
  'packages/core/src',
] as const;

/** Where an assertion about a sentence may live. Every test the repo runs, plus the e2e tree. */
const TEST_TREES = [
  'packages/core/src',
  'packages/core/test',
  'packages/server/src',
  'packages/server/test',
  'packages/web/src',
  'e2e',
  'scripts',
] as const;

/**
 * Files under a product tree that are not the product.
 *
 * `exports/testFixtures.ts` ships inside `src/` but exists to be imported BY tests — its labels
 * are stage scenery ("Feb 2027 deadline"), not something a user is ever shown. Everything else
 * here is a test, a test helper, or the harness.
 */
function isTestSupportFile(rel: string): boolean {
  const base = path.basename(rel);
  return (
    /\.test\.tsx?$/.test(base) ||
    /\.spec\.tsx?$/.test(base) ||
    rel.startsWith('e2e/') ||
    rel.includes('/test/') ||
    base === 'testFixtures.ts' ||
    base === 'fixtures.ts' ||
    base === 'programRowFixtures.ts'
  );
}

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Directory-or-file is asked of the OS, never guessed from the name. A walk that decides by
    // looking for a dot skips `packages/server/src/v2.0/` entirely; that exact hole was found in
    // `contactUrlEntryPointContract.test.ts` and there is no reason to reopen it here.
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.tmp') continue;
      walk(full, out);
    } else if (/\.(tsx?|mts|cts|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- normalisation

const ENTITIES: Record<string, string> = {
  '&ldquo;': '"',
  '&rdquo;': '"',
  '&lsquo;': "'",
  '&rsquo;': "'",
  '&quot;': '"',
  '&apos;': "'",
  '&mdash;': '-',
  '&ndash;': '-',
  '&nbsp;': ' ',
  '&amp;': '&',
  '&hellip;': '...',
  '&lt;': '<',
  '&gt;': '>',
  '&#39;': "'",
  '&#8217;': "'",
};

/**
 * One spelling for one sentence.
 *
 * A test writes `"don't"`; the JSX writes `don&rsquo;t`; a designer pastes `don’t`. All three are
 * the same sentence and a comparison that says otherwise reports coverage this repo does not have.
 * Entities, curly quotes, dashes, ellipses, non-breaking spaces and case are all flattened.
 */
export function normalizeCopy(input: string): string {
  return input
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------- what counts as prose

/** JSX attributes whose value is read out loud, by a screen reader or by an eye. */
const PROSE_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'alt',
  'label',
  'placeholder',
  'summary',
  'title',
]);

/** Object keys whose string value is rendered or sent to a person. */
const PROSE_KEYS = new Set([
  'alt',
  'aria-label',
  'body',
  'caption',
  'description',
  'detail',
  'explanation',
  'heading',
  'help',
  'hint',
  'label',
  'message',
  'note',
  'placeholder',
  'reason',
  'summary',
  'text',
  'title',
  'warning',
  'why',
]);

/**
 * The error classes with a documented path to a person.
 *
 * `AppError`'s message is what `errorHandler` puts in `error.message`, which every screen in
 * `packages/web` prints. `ConfigError`'s message is what a refused boot tells the operator. A
 * plain `throw new Error` inside the server or core is NOT on this list: `errorHandler` replaces
 * it with "Something went wrong." and the original goes to the log, so its wording is a message to
 * a maintainer reading stderr and not a sentence this product says. In `packages/web` there is no
 * such boundary — a thrown `Error`'s `.message` is what `CopyPromptButton` prints and what the
 * error boundary shows — so every Error counts there.
 */
const HUMAN_ERROR_CLASSES = /(^|\.)(AppError|ConfigError)$/;

const CSS_SELECTOR = /(:not\(|\[[a-z-]+[\]=]|^\s*\(max-width|^\s*\(min-width|\{|\}|;\s*$)/i;

/** Calls whose string argument is a CSS selector handed to the DOM, never text a person reads. */
const DOM_QUERY = /(^|\.)(querySelector|querySelectorAll|closest|matches|getElementsBy\w+)$/;

function letterWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
}

/**
 * Whether a bare string literal is prose rather than machinery.
 *
 * Deliberately conservative in one direction only: the cost of a false positive is one line in a
 * per-file budget, and the cost of a false negative is a sentence nobody ever looks at, which is
 * the entire defect this module exists to measure.
 */
function looksLikeProse(text: string, minWords: number): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  if (letterWords(trimmed).length < minWords) return false;
  if (/^https?:\/\//.test(trimmed)) return false;
  if (/^[./#]/.test(trimmed)) return false;
  if (/\.(css|tsx?|jsx?|json|sql|svg|png|zip|docx|md|ics|csv)$/i.test(trimmed)) return false;
  if (CSS_SELECTOR.test(trimmed)) return false;
  if (/^[a-z][a-z0-9]*\/[a-z0-9.+-]+$/i.test(trimmed)) return false; // MIME types
  if (/^[A-Z0-9_]+(\s+[A-Z0-9_]+)*$/.test(trimmed)) return false; // SCREAMING constants
  // A hyphen-joined lower-case run with no sentence punctuation is a class list, not a sentence.
  if (/^[a-z0-9-]+(\s+[a-z0-9-]+)+$/.test(trimmed) && /-/.test(trimmed)) return false;
  return true;
}

// ---------------------------------------------------------------------------- extraction

export interface CopySite {
  /** Repo-relative path of the file that says it. */
  readonly file: string;
  /** 1-indexed line. */
  readonly line: number;
  /** The sentence as written, with `{}` where a value is interpolated. */
  readonly text: string;
  /** The literal runs of the sentence, normalised. Interpolated values are not among them. */
  readonly chunks: readonly string[];
  /** Why the extractor believes a person reads this. */
  readonly kind: string;
}

function literalChunks(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  }
  return [];
}

function isStringish(node: ts.Node): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  );
}

/** The nearest enclosing call/new expression's callee text, or null if a JSX boundary comes first. */
function enclosingCallee(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  for (let depth = 0; current !== undefined && depth < 4; depth += 1) {
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      return current.expression.getText();
    }
    if (ts.isJsxAttribute(current) || ts.isJsxElement(current)) return null;
    current = current.parent;
  }
  return null;
}

/** True when the literal sits inside a JSX attribute this module does not treat as prose. */
function insideNonProseAttribute(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  for (let depth = 0; current !== undefined && depth < 6; depth += 1) {
    if (ts.isJsxAttribute(current)) {
      return !PROSE_ATTRS.has(current.name.getText());
    }
    if (ts.isJsxElement(current) || ts.isJsxFragment(current)) return false;
    current = current.parent;
  }
  return false;
}

function extractFromFile(absolute: string, tree: 'web' | 'server' | 'core'): CopySite[] {
  const rel = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const sites: CopySite[] = [];
  const seen = new Set<string>();

  const record = (raw: string, chunks: string[], node: ts.Node, kind: string): void => {
    const normChunks = chunks.map(normalizeCopy).filter((c) => c.length > 0);
    if (normChunks.length === 0) return;
    if (!/[a-z]{2}/.test(normChunks.join(' '))) return;
    const key = `${normChunks.join(' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    sites.push({
      file: rel,
      line: line + 1,
      text: raw.replace(/\s+/g, ' ').trim(),
      chunks: normChunks,
      kind,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (/[A-Za-z]{2}/.test(node.text)) record(node.text, [node.text], node, 'jsx-text');
    } else if (isStringish(node)) {
      const chunks = literalChunks(node);
      const display = chunks.join('{}');
      const parent = node.parent;
      let kind: string | null = null;
      let minWords = 2;

      if (ts.isJsxAttribute(parent) && parent.initializer === node) {
        if (PROSE_ATTRS.has(parent.name.getText())) kind = `attr:${parent.name.getText()}`;
      } else if (
        ts.isJsxExpression(parent) &&
        parent.parent !== undefined &&
        ts.isJsxAttribute(parent.parent)
      ) {
        const attr = parent.parent.name.getText();
        if (PROSE_ATTRS.has(attr) && looksLikeProse(display, 2)) kind = `attr:${attr}`;
      } else if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
        const key = parent.name.getText().replace(/['"]/g, '');
        if (PROSE_KEYS.has(key)) {
          if (looksLikeProse(display, 2)) kind = `key:${key}`;
        } else if (tree === 'web' && looksLikeProse(display, 2)) {
          // A web-side lookup table keyed by an enum value — `{ cash_fixed: 'Fixed cash award' }`
          // — is a label map, and every one of those is rendered.
          kind = `key:${key}`;
        }
      } else {
        const callee = enclosingCallee(node);
        if (callee !== null && /Error$/.test(callee)) {
          const human = tree === 'web' || HUMAN_ERROR_CLASSES.test(callee);
          if (human && looksLikeProse(display, 3)) kind = `throw:${callee}`;
        } else if (callee !== null && DOM_QUERY.test(callee)) {
          // A CSS selector is not a sentence. `input, textarea, select` reads as prose to any
          // heuristic that looks only at the characters, so the CONTEXT decides it instead: this
          // string is being handed to the DOM to match against, and nobody will ever read it.
          kind = null;
        } else if (callee !== null && /^(console|logger|log)\b/.test(callee)) {
          kind = null;
        } else if (tree === 'web' && !insideNonProseAttribute(node)) {
          // Interpolated copy is assembled from short runs — `Needs ` + ` or higher.` — so a
          // template is judged on the whole sentence it renders, not on either half alone.
          minWords = ts.isTemplateExpression(node) ? 3 : 2;
          if (looksLikeProse(display, minWords)) kind = 'literal';
        }
      }

      if (kind !== null) record(display, chunks, node, kind);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return sites;
}

/** Every sentence the product can say, one entry per distinct wording per file. */
export function collectUserFacingCopy(): CopySite[] {
  const sites: CopySite[] = [];
  for (const tree of PRODUCT_TREES) {
    const label = tree.includes('/web/') ? 'web' : tree.includes('/server/') ? 'server' : 'core';
    for (const file of walk(path.join(REPO_ROOT, tree))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (isTestSupportFile(rel)) continue;
      sites.push(...extractFromFile(file, label));
    }
  }
  sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return sites;
}

// ---------------------------------------------------------------------------- the assertion corpus

/**
 * The shortest run of characters that counts as "a test named this sentence".
 *
 * Sixteen, measured rather than guessed: it is long enough that `not signed in` and `nothing was
 * saved` cannot both be satisfied by some unrelated fixture, and short enough that a test written
 * as `/could not be reached/i` — a real, common shape in this suite — still counts.
 */
const GRAM = 16;

export interface AssertionCorpus {
  readonly grams: ReadonlySet<string>;
  readonly text: string;
  readonly fileCount: number;
  readonly literalCount: number;
}

/**
 * Every string and regular-expression literal in every test, flattened.
 *
 * PARSED, NOT GREPPED, AND THAT IS THE WHOLE OF WHY. The first version of this function ran a
 * regular expression over the raw file text, which meant a sentence QUOTED IN A COMMENT counted
 * as an assertion about it. That is not a small hole here: this repository's tests are written
 * with enormous docblocks that quote, verbatim, the false sentence each test was written to
 * catch — so the more carefully somebody documented a defect, the more of the surrounding copy
 * the census reported as covered. A measurement of how much copy nobody looks at, inflated in
 * proportion to how much prose the author wrote. The AST has no such ambiguity: comments are
 * trivia, and only string, template and regular-expression literals reach the corpus.
 *
 * A character class inside a regex (`/[Ee]xpired/`) collapses to `.` so the surrounding run still
 * matches on the letters either side of it, and a template's `${...}` becomes a space for the
 * same reason.
 */
export function collectAssertionCorpus(): AssertionCorpus {
  const literals: string[] = [];
  let fileCount = 0;

  const take = (raw: string): void => {
    if (!/[A-Za-z]/.test(raw)) return;
    literals.push(
      raw
        .replace(/\[[^\]]*\]/g, '.')
        .replace(/\\(.)/g, '$1')
        .replace(/\$\{[^}]*\}/g, ' '),
    );
  };

  for (const tree of TEST_TREES) {
    for (const file of walk(path.join(REPO_ROOT, tree))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (!isTestSupportFile(rel)) continue;
      fileCount += 1;
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) take(node.text);
        else if (ts.isTemplateExpression(node)) {
          take(node.head.text);
          for (const span of node.templateSpans) take(span.literal.text);
        } else if (ts.isRegularExpressionLiteral(node)) {
          take(node.text.replace(/^\/|\/[gimsuy]*$/g, ''));
        } else if (ts.isJsxText(node)) {
          // A test that renders its own fixture markup asserts through it.
          take(node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  const text = literals.map(normalizeCopy).join('\n');
  const grams = new Set<string>();
  for (let i = 0; i + GRAM <= text.length; i += 1) grams.add(text.slice(i, i + GRAM));
  return { grams, text, fileCount, literalCount: literals.length };
}

function chunkIsNamed(chunk: string, corpus: AssertionCorpus): boolean {
  if (chunk.length < GRAM) return corpus.text.includes(chunk);
  for (let i = 0; i + GRAM <= chunk.length; i += 1) {
    if (corpus.grams.has(chunk.slice(i, i + GRAM))) return true;
  }
  return false;
}

/**
 * Whether some test names this sentence.
 *
 * For interpolated copy every substantial run must be named, not just one: `Deleted {}. Removed
 * with it: {}` is two claims and a test that quotes only "Deleted " has looked at neither. Runs
 * shorter than twelve characters are joinery ("Needs ", " of ") and carry no claim of their own,
 * so they are not required — but if EVERY run is joinery, the longest one must be named, which is
 * what stops a sentence made entirely of fragments from counting as covered for free.
 */
export function isAsserted(site: CopySite, corpus: AssertionCorpus): boolean {
  const substantial = site.chunks.filter((chunk) => chunk.length >= 12);
  if (substantial.length > 0) return substantial.every((chunk) => chunkIsNamed(chunk, corpus));
  const longest = [...site.chunks].sort((a, b) => b.length - a.length)[0];
  return longest === undefined ? true : chunkIsNamed(longest, corpus);
}
