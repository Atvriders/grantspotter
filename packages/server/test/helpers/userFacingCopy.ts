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
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * A COUNTER THAT SILENTLY OMITS IS WORSE THAN NO COUNTER, BECAUSE THE NUMBER GETS QUOTED.
 *
 * The first version of this module dropped an entire class of sentence on the floor and reported a
 * healthy total while doing it. `record` was handed `chunks.join('{}')` as the text to judge, and
 * the prose predicate of the day refused anything containing a brace, because a brace is how a CSS
 * rule body is spelled. So THE PLACEHOLDER THIS MODULE INVENTED made every interpolated sentence look like a
 * stylesheet to this module's own heuristic, and every one of them was discarded without a word.
 * Measured before the fix, against abffd25: 0 of 1,323 recorded sites contained `{}` — the marker
 * the type's own docblock said would be there. Repairing it added 209 sites and lost none, of
 * which 189 carry a substitution; 84 of the 209, across 38 files, were sentences no test had ever
 * named, among them `CallsignLookup.tsx`'s "FCC record for {}", which is round two's defect
 * verbatim and the exact thing the census was built to find.
 *
 * An interpolated sentence is not a lesser case. It is the case MOST likely to be wrong, because
 * the literal half was written for one value and the runtime supplies another; "FCC record for
 * undefined" is precisely that failure. The classifier is therefore never shown a placeholder at
 * all: it judges `proseCandidate(chunks)`, the literal runs joined by a space, and the `{}` form
 * survives only as `CopySite.text`, which is for a person to read in a failure message.
 *
 * THE GENERAL LESSON, WHICH IS THE REST OF THIS FILE'S DESIGN. That bug was not a typo; it was a
 * structural property of a scanner that could exclude things without saying so. So this module no
 * longer excludes anything silently. Every string-ish node in the three product trees is accounted
 * for exactly once:
 *
 *   `Census.sites`    — counted as a sentence.
 *   `Census.drops`    — sat in a position this census READS, and was refused, with a named reason
 *                       from the closed `DROP_REASONS` set. `unclassified` is the default, and
 *                       `userFacingCopyContract.test.ts` requires it to be empty: a string that
 *                       reaches the end of the cascade without a decision FAILS THE SUITE rather
 *                       than vanishing.
 *   `Census.unread`   — sat in a position this census DOES NOT read (an import specifier, a
 *                       `className`, a SQL string, a bare literal in the server) AND NEVERTHELESS
 *                       READS AS ENGLISH PROSE. This is the honest name for the census's blind
 *                       spot. Its SHAPE is pinned — every entry must carry a position from
 *                       `UNREAD_POSITIONS`, so a new kind of exclusion fails the suite until
 *                       somebody names it — while its volume is published rather than ratcheted,
 *                       because a number that moves whenever anybody writes a SQL statement is a
 *                       number that gets bumped without being read.
 *
 * `sites.length + drops.length === considered` is asserted as an identity. A future branch that
 * `return`s early without recording is caught by arithmetic rather than by somebody noticing that
 * a number looks low.
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

/**
 * JSX attributes whose value is read out loud, by a screen reader or by an eye — REGARDLESS of
 * what the characters look like.
 *
 * Membership here means "count it without asking the heuristic". Outside the browser tree, and for
 * attributes not on this list, a JSX attribute is judged on its characters like any other web
 * string — see `unreadPosition`'s caller. That widening is not cosmetic: the blind-spot ledger
 * caught fourteen sentences hiding behind prop names nobody would think to enumerate —
 * `MonthGrid`'s `note`, `Applications`' and `Templates`' `emptyMessage`, and the seven runs of
 * `Profile`'s `clubNotice`, which is a paragraph about club licences that no test had ever read.
 * A list of blessed attribute names could not have found those, because the point of the list is
 * that somebody wrote it before those props existed.
 *
 * `TOKEN_ATTRS` above is the deny-list that replaces it, and THE POLARITY IS THE WHOLE POINT.
 * Every name on it holds a reference or a token by definition — a class, an id, a URL, an HTML
 * enum — so `rel="noopener noreferrer"` and `className="panel card"` are refused on what they ARE
 * rather than on how they read, which is why the character heuristic could not do it (two
 * lower-case words, no hyphen, no punctuation: indistinguishable from "No playbooks."). An
 * attribute on NEITHER list is read. So a prop nobody anticipated defaults to being counted, and
 * the only way to lose a sentence is for somebody to add its prop name to a list called
 * `TOKEN_ATTRS` — which is a thing you have to mean.
 */
const TOKEN_ATTRS = new Set([
  'accept',
  'aria-controls',
  'aria-describedby',
  'aria-hidden',
  'aria-labelledby',
  'as',
  'autoCapitalize',
  'autoComplete',
  'className',
  'dir',
  'encType',
  'form',
  'href',
  'htmlFor',
  'id',
  'inputMode',
  'key',
  'lang',
  'method',
  'name',
  'path',
  'pattern',
  'rel',
  'role',
  'scope',
  'src',
  'style',
  'target',
  'to',
  'type',
  'value',
]);

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

/**
 * Calls whose string argument is SQL handed to SQLite.
 *
 * Named for the same reason `DOM_QUERY` is: `SELECT user_id, notify_changes FROM watches WHERE
 * program_id = ?` has four English function words in it and reads as prose to anything that looks
 * only at the characters. Before this existed, several hundred statements sat in the blind-spot
 * ledger next to the sentences that actually are copy, which makes the ledger a number nobody
 * reads — the same failure as not keeping the ledger at all.
 */
const SQL_CALL = /(^|\.)(prepare|exec)$/;
/**
 * Upper case and a two-word opener, both load-bearing. The first draft of this was
 * case-insensitive and matched a bare `create`, which swallowed "Create my account",
 * "Create administrator" and "create a new feed when you need one again" — three buttons and a
 * sentence, counted yesterday and silently gone today. That is the same bug as the placeholder,
 * committed by the fix for it, which is why `LOST 0` is measured on every change to this file.
 */
const SQL_KEYWORD =
  /^\s*(SELECT\s|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(TABLE|INDEX|VIEW|TRIGGER|UNIQUE)\b|DROP\s+(TABLE|INDEX|VIEW)\b|ALTER\s+TABLE\b|WITH\s+\w+\s+AS\b|PRAGMA\s|VACUUM\b|BEGIN\s+(TRANSACTION|IMMEDIATE|DEFERRED)\b)/;

function letterWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
}

/**
 * Which of the machinery tests refuses this string, or `null` when it reads as prose.
 *
 * NAMED RULES RATHER THAN A BOOLEAN, because a `false` here used to mean "this module decided you
 * are not a sentence" and said nothing about why — which is how `{}`, a placeholder this module
 * invented itself, was able to route every interpolated sentence into the CSS-selector rule for
 * months. The rule that refused a string is now carried on the drop and printed by the contract
 * test, so the same class of mistake is one `npm test` away from being visible.
 *
 * Deliberately conservative in one direction only: the cost of a false positive is one line in a
 * per-file budget, and the cost of a false negative is a sentence nobody ever looks at, which is
 * the entire defect this module exists to measure.
 */
export function machineryRule(text: string, minWords: number): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 4) return 'shorter-than-four-characters';
  if (letterWords(trimmed).length < minWords) return `fewer-than-${String(minWords)}-words`;
  if (/^https?:\/\//.test(trimmed)) return 'url';
  if (/^[./#]/.test(trimmed)) return 'path-or-selector-prefix';
  if (/\.(css|tsx?|jsx?|json|sql|svg|png|zip|docx|md|ics|csv)$/i.test(trimmed)) return 'filename';
  if (CSS_SELECTOR.test(trimmed)) return 'css-selector';
  if (/^[a-z][a-z0-9]*\/[a-z0-9.+-]+$/i.test(trimmed)) return 'mime-type';
  if (/^[A-Z0-9_]+(\s+[A-Z0-9_]+)*$/.test(trimmed)) return 'screaming-constant';
  // A hyphen-joined lower-case run with no sentence punctuation is a class list, not a sentence.
  if (/^[a-z0-9-]+(\s+[a-z0-9-]+)+$/.test(trimmed) && /-/.test(trimmed)) return 'class-list';
  return null;
}

/**
 * THE STRING THE CLASSIFIER JUDGES — the literal runs, joined by a space, and nothing else.
 *
 * This exists because the thing it replaced did not. `chunks.join('{}')` was handed to
 * `looksLikeProse` — the boolean predecessor of `machineryRule` — whose CSS-selector rule refuses
 * `{` and `}`, so a sentence was disqualified by a placeholder this module had written into it one
 * line earlier. Interpolated copy — the
 * copy most likely to be false, because the words were chosen for a value the runtime does not
 * have to supply — was therefore the copy this census could not see.
 *
 * A space, specifically, and the choice is on the merits rather than on being merely safer. It
 * introduces no character that any machinery rule tests for — which is the whole failure being
 * repaired, so the separator must be inert by construction and not by luck. And unlike the empty
 * string it is a word boundary, which is what a substitution is: joining `pre` and `fix` with
 * nothing invents the word "prefix", and `letterWords` would then count a word that no reader of
 * the rendered sentence will ever see.
 *
 * If a future rule ever needs to test for a space, this function must change with it. The contract
 * test's `the census can see an interpolated sentence` is the tripwire: it fails the moment the
 * census stops recording sites that carry a substitution.
 */
export function proseCandidate(chunks: readonly string[]): string {
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------- extraction

export interface CopySite {
  /** Repo-relative path of the file that says it. */
  readonly file: string;
  /** 1-indexed line. */
  readonly line: number;
  /**
   * The sentence as written, with `{}` where a value is interpolated.
   *
   * FOR DISPLAY ONLY. This string is what a failure message shows a person; it is not what any
   * predicate in this repository may be run against, because the `{}` is punctuation this module
   * added and no reader will ever see. Judge `chunks`, or `proseCandidate(chunks)`. The whole of
   * the defect this round repaired was one call site forgetting that distinction.
   */
  readonly text: string;
  /** The literal runs of the sentence, normalised. Interpolated values are not among them. */
  readonly chunks: readonly string[];
  /** Why the extractor believes a person reads this. */
  readonly kind: string;
}

/**
 * Why a string in a position this census READS was nevertheless not counted.
 *
 * A closed set, and `unclassified` is in it on purpose: it is what the cascade falls through to,
 * and `userFacingCopyContract.test.ts` requires the `unclassified` bucket to be empty. A scanner
 * that meets something it does not understand must say so and fail, not shrug and subtract one
 * from a total that somebody is going to quote.
 */
/**
 * THE COMPLETE LIST OF PLACES THIS CENSUS DOES NOT LOOK.
 *
 * Enumerated, not counted, and the contract test asserts that every entry in `Census.unread`
 * carries a name from this list. That is deliberately a different shape of guard from the per-file
 * budget: the counts here move with ordinary server work — a new SQL statement, a new analyst note
 * in `sources/` — and a number that has to be bumped on ordinary work is a number that gets bumped
 * without reading. The NAMES do not move. A new kind of silent exclusion fails the suite until
 * somebody writes it down here and says why a person cannot read it.
 *
 * `jsx-attribute:` is a prefix: outside the browser tree the attribute's own name is appended, so
 * a server-rendered prop shows up as `jsx-attribute:href` rather than as an anonymous omission.
 */
export const UNREAD_POSITIONS = [
  /** An import, export or `import()` module path. */
  'module-specifier',
  /** A string in type position — a union member, an `as const` literal type. */
  'type-literal',
  /** The KEY of an object property, not its value. */
  'object-key-name',
  /** The template of a tagged template — this repo uses them to build regular expressions. */
  'tagged-template',
  /**
   * A JSX attribute outside the browser tree, named after the attribute itself. Inside
   * `packages/web` there is no such exclusion any more: every attribute is judged on its
   * characters, which is what surfaced `clubNotice`, `emptyMessage` and `note`.
   */
  'jsx-attribute',
  /** Handed to `querySelector` and friends. `input, textarea, select` is not a sentence. */
  'dom-selector',
  /** Handed to `console` / a logger. Read by whoever runs the server, never by an applicant. */
  'log-line',
  /** Handed to `db.prepare` / `db.exec`, or opening with a SQL keyword in the repo's SQL casing. */
  'sql-statement',
  /**
   * `new Error(...)` in the server or core. `errorHandler` replaces the message with "Something
   * went wrong." before it reaches a browser, so the wording is addressed to stderr.
   */
  'thrown-to-a-maintainer',
  /** An object value under a key not on `PROSE_KEYS`, outside the browser tree. */
  'object-value-outside-the-browser',
  /**
   * THE LARGEST ONE, AND THE ONE THAT MATTERS. A bare string literal in the server or core.
   *
   * Most of these are machinery. Some are not: `api/auth.ts` — the file that wrote the one-number
   * rule down — keeps its refusals as module constants and ternary arms, so
   * `ACCOUNT_DISABLED` ("That account has been switched off by an administrator…") and "Too many
   * failed sign-ins for this email address from this connection." are sentences a person reads
   * that this census has never counted. Widening the rule to take every prose-shaped server
   * literal would sweep in several hundred SQL fragments and seed-corpus provenance notes, so the
   * omission is named and left standing rather than papered over — and the one-number rule is run
   * over this bucket as well as over the sites, so the dangerous half of it is governed by CONTENT
   * even where it is not governed by count.
   */
  'bare-literal-outside-the-browser',
] as const;

export function isKnownUnreadPosition(reason: string): boolean {
  return (UNREAD_POSITIONS as readonly string[]).includes(reason.split(':')[0] ?? reason);
}

export const DROP_REASONS = [
  /** Nothing a person could read survived normalisation — punctuation, a lone digit, whitespace. */
  'no-letters',
  /** This exact wording was already counted for this file. One entry per sentence per file. */
  'same-wording-already-counted',
  /** `machineryRule` refused it; `detail` names the rule that did. */
  'reads-as-machinery',
  /** The cascade reached its end without deciding. Must never occur; the contract test asserts it. */
  'unclassified',
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export interface DroppedString {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** For `drops`, a `DropReason`. For `unread`, the name of the position that is not read. */
  readonly reason: string;
  /** The machinery rule that refused it, the attribute name, the callee — whatever narrows it. */
  readonly detail: string | null;
}

export interface Census {
  /** Every sentence the product can say, one entry per distinct wording per file. */
  readonly sites: readonly CopySite[];
  /** Candidates in a read position that were refused, each with a reason from `DROP_REASONS`. */
  readonly drops: readonly DroppedString[];
  /**
   * THE BLIND SPOT, NAMED AND COUNTED.
   *
   * Strings sitting where this census does not look — an import specifier, a `className`, a SQL
   * statement, a bare literal in the server or core — that nonetheless read as English prose by
   * this module's own `machineryRule`. Every entry is either genuinely not copy (a SQL statement
   * with four English function words in it) or a sentence this census cannot see. The contract
   * test asserts that each one carries a position from `UNREAD_POSITIONS` and runs the one-number
   * rule across the whole bucket, so the half of the blind spot that can actually harm a reader is
   * governed by CONTENT even where its volume is not governed by count. That widening found five
   * live invented waits in `callsign/callook.ts` on its first run.
   */
  readonly unread: readonly DroppedString[];
  /** Candidates in a read position. `sites.length + drops.length` must equal this exactly. */
  readonly considered: number;
  /** Every string-ish node and prose-bearing JSX text node the walk reached, read or not. */
  readonly stringishNodes: number;
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

/**
 * The JSX attribute a literal is buried inside, or `null` when it is not inside one this module
 * refuses to read.
 *
 * Both loop bounds here fail OPEN — toward reading the string — which is the right direction for a
 * census of what nobody has looked at. A nesting deeper than six returns `null`, so the string is
 * judged on its characters rather than excluded on a position this function gave up on finding.
 */
function insideNonProseAttribute(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  for (let depth = 0; current !== undefined && depth < 6; depth += 1) {
    if (ts.isJsxAttribute(current)) {
      const name = current.name.getText();
      return PROSE_ATTRS.has(name) ? null : name;
    }
    if (ts.isJsxElement(current) || ts.isJsxFragment(current)) return null;
    current = current.parent;
  }
  return null;
}

/**
 * The positions this census does not read, recognised by shape rather than by characters.
 *
 * A name returned here routes the string to `Census.unread` instead of through the prose
 * heuristic. Before this existed, the 898 import specifiers in this repository and the sentences
 * the census genuinely cannot see were in the same undifferentiated silence — so "the heuristic
 * refused it" could not be told from "nobody ever offered it to the heuristic", and neither could
 * be counted.
 */
function unreadPosition(node: ts.Node, parent: ts.Node): string | null {
  if (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isImportTypeNode(parent) ||
    ts.isExternalModuleReference(parent) ||
    (ts.isCallExpression(parent) &&
      parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
      parent.arguments[0] === node)
  ) {
    return 'module-specifier';
  }
  if (ts.isLiteralTypeNode(parent)) return 'type-literal';
  if (ts.isPropertyAssignment(parent) && parent.name === node) return 'object-key-name';
  if (ts.isComputedPropertyName(parent)) return 'object-key-name';
  if (ts.isTaggedTemplateExpression(parent)) return 'tagged-template';
  return null;
}

interface FileCensus {
  readonly sites: CopySite[];
  readonly drops: DroppedString[];
  readonly unread: DroppedString[];
  considered: number;
  stringishNodes: number;
}

function extractFromFile(absolute: string, tree: 'web' | 'server' | 'core'): FileCensus {
  const rel = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const out: FileCensus = { sites: [], drops: [], unread: [], considered: 0, stringishNodes: 0 };
  const seen = new Set<string>();

  const where = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const oneLine = (raw: string): string => raw.replace(/\s+/g, ' ').trim();

  /**
   * A candidate in a position this census READS, resolved one way or the other.
   *
   * There is no third way out of this function: it pushes a site or it pushes a drop. That is what
   * makes `sites.length + drops.length === considered` an identity a test can assert, rather than
   * an aspiration that a future early `return` quietly breaks.
   */
  const record = (
    display: string,
    chunks: readonly string[],
    node: ts.Node,
    kind: string | null,
    machinery: string | null,
  ): void => {
    out.considered += 1;
    const drop = (reason: DropReason, detail: string | null): void => {
      out.drops.push({ file: rel, line: where(node), text: oneLine(display), reason, detail });
    };
    if (kind === null) {
      drop('reads-as-machinery', machinery ?? 'unclassified');
      return;
    }
    const normChunks = chunks.map(normalizeCopy).filter((c) => c.length > 0);
    if (normChunks.length === 0 || !/[a-z]{2}/.test(normChunks.join(' '))) {
      drop('no-letters', kind);
      return;
    }
    const key = normChunks.join(' ');
    if (seen.has(key)) {
      drop('same-wording-already-counted', kind);
      return;
    }
    seen.add(key);
    out.sites.push({ file: rel, line: where(node), text: oneLine(display), chunks: normChunks, kind });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (/[A-Za-z]{2}/.test(node.text)) {
        out.stringishNodes += 1;
        record(node.text, [node.text], node, 'jsx-text', null);
      }
    } else if (isStringish(node)) {
      out.stringishNodes += 1;
      const chunks = literalChunks(node);
      // THE PLACEHOLDER IS FOR THE READER, NOT FOR THE CLASSIFIER. `display` carries `{}` so that a
      // failure message shows the shape of the sentence. `candidate` is what every predicate sees.
      // Handing `display` to the heuristic is the defect this round repaired: `{` and `}` are in
      // the CSS-selector rule, so every interpolated sentence was refused as a stylesheet and
      // dropped without a word. Measured before the fix: 0 of 1,323 sites contained a `{}`.
      const display = chunks.join('{}');
      const candidate = proseCandidate(chunks);
      const parent = node.parent;

      const notReadHere = unreadPosition(node, parent);
      let kind: string | null = null;
      let machinery: string | null = null;
      let unreadAs: string | null = notReadHere;

      if (notReadHere === null) {
        const judge = (minWords: number, asKind: string): void => {
          machinery = machineryRule(candidate, minWords);
          if (machinery === null) kind = asKind;
        };

        // A JSX ATTRIBUTE IN THE BROWSER TREE IS JUDGED ON ITS CHARACTERS unless its name is on
        // `PROSE_ATTRS`, in which case it is counted outright. The old rule — count the listed
        // names, discard every other attribute unseen — is the same mistake as the placeholder,
        // one level up: a list written in advance cannot contain the prop somebody adds next
        // Tuesday, and `className`, `to`, `role` and `type` are already refused by
        // `machineryRule` on their characters alone, so the list was buying nothing it needed.
        if (ts.isJsxAttribute(parent) && parent.initializer === node) {
          const name = parent.name.getText();
          if (PROSE_ATTRS.has(name)) kind = `attr:${name}`;
          else if (TOKEN_ATTRS.has(name) || tree !== 'web') unreadAs = `jsx-attribute:${name}`;
          else judge(ts.isTemplateExpression(node) ? 3 : 2, `attr:${name}`);
        } else if (
          ts.isJsxExpression(parent) &&
          parent.parent !== undefined &&
          ts.isJsxAttribute(parent.parent)
        ) {
          const attr = parent.parent.name.getText();
          if (PROSE_ATTRS.has(attr)) judge(2, `attr:${attr}`);
          else if (TOKEN_ATTRS.has(attr) || tree !== 'web') unreadAs = `jsx-attribute:${attr}`;
          else judge(2, `attr:${attr}`);
        } else if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
          const key = parent.name.getText().replace(/['"]/g, '');
          // A web-side lookup table keyed by an enum value — `{ cash_fixed: 'Fixed cash award' }`
          // — is a label map, and every one of those is rendered.
          if (PROSE_KEYS.has(key) || tree === 'web') judge(2, `key:${key}`);
          else unreadAs = 'object-value-outside-the-browser';
        } else {
          const callee = enclosingCallee(node);
          if (callee !== null && /Error$/.test(callee)) {
            if (tree === 'web' || HUMAN_ERROR_CLASSES.test(callee)) judge(3, `throw:${callee}`);
            else unreadAs = 'thrown-to-a-maintainer';
          } else if (callee !== null && DOM_QUERY.test(callee)) {
            // A CSS selector is not a sentence. `input, textarea, select` reads as prose to any
            // heuristic that looks only at the characters, so the CONTEXT decides it instead: this
            // string is being handed to the DOM to match against, and nobody will ever read it.
            unreadAs = 'dom-selector';
          } else if (callee !== null && /^(console|logger|log)\b/.test(callee)) {
            unreadAs = 'log-line';
          } else if (
            (callee !== null && SQL_CALL.test(callee)) ||
            SQL_KEYWORD.test(chunks[0] ?? '')
          ) {
            unreadAs = 'sql-statement';
          } else {
            const attr = insideNonProseAttribute(node);
            // Interpolated copy is assembled from short runs — `Needs ` + ` or higher.` — so a
            // template is judged on the whole sentence it renders, not on either half alone.
            if (attr !== null && TOKEN_ATTRS.has(attr)) unreadAs = `jsx-attribute:${attr}`;
            else if (tree === 'web') {
              judge(ts.isTemplateExpression(node) ? 3 : 2, attr === null ? 'literal' : `attr:${attr}`);
            } else if (attr !== null) unreadAs = `jsx-attribute:${attr}`;
            else unreadAs = 'bare-literal-outside-the-browser';
          }
        }
      }

      if (kind === null && unreadAs !== null) {
        // A position this census does not read. Silence here is what made the blind spot
        // unmeasurable, so anything that reads as English by this module's own rules is kept and
        // counted — see `Census.unread`, which the contract test pins and prints.
        if (machineryRule(candidate, 3) === null) {
          out.unread.push({
            file: rel,
            line: where(node),
            text: oneLine(display),
            reason: unreadAs,
            detail: null,
          });
        }
      } else {
        record(display, chunks, node, kind, machinery);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return out;
}

/**
 * Every sentence the product can say, and — equally — everything this walk decided was not one.
 *
 * Memoised: it parses all three product trees, and the contract test asks four separate questions
 * of the same answer.
 */
let memo: Census | null = null;

export function censusUserFacingCopy(): Census {
  if (memo !== null) return memo;
  const sites: CopySite[] = [];
  const drops: DroppedString[] = [];
  const unread: DroppedString[] = [];
  let considered = 0;
  let stringishNodes = 0;
  for (const tree of PRODUCT_TREES) {
    const label = tree.includes('/web/') ? 'web' : tree.includes('/server/') ? 'server' : 'core';
    for (const file of walk(path.join(REPO_ROOT, tree))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (isTestSupportFile(rel)) continue;
      const one = extractFromFile(file, label);
      sites.push(...one.sites);
      drops.push(...one.drops);
      unread.push(...one.unread);
      considered += one.considered;
      stringishNodes += one.stringishNodes;
    }
  }
  const byPlace = (a: { file: string; line: number }, b: { file: string; line: number }): number =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file);
  sites.sort(byPlace);
  drops.sort(byPlace);
  unread.sort(byPlace);
  memo = { sites, drops, unread, considered, stringishNodes };
  return memo;
}

/** Every sentence the product can say, one entry per distinct wording per file. */
export function collectUserFacingCopy(): CopySite[] {
  return [...censusUserFacingCopy().sites];
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
