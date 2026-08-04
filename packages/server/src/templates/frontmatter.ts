/**
 * A deliberately small frontmatter parser.
 *
 * It accepts exactly the four shapes our templates use:
 *   key: scalar                      (string, number, boolean, quoted string)
 *   key: [a, b, c]                   (flow array of scalars)
 *   key:\n  - a\n  - b               (block array of scalars)
 *   key:\n  - label: x\n    url: y   (block array of single-level maps)
 *
 * Anything else throws. A malformed template must fail at load time, not render
 * as a blank section in somebody's grant application. That includes the quiet
 * malformations — a duplicate key where the last one silently wins, a key whose
 * value the author forgot, an empty element in a flow list — because each of
 * those parses into a value nobody wrote, and a value nobody wrote is the exact
 * thing this product promises never to assert.
 *
 * Known restriction: a scalar list item may not contain a colon followed by a
 * space, because that is how a map item is recognised. No template needs one.
 */

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

export type FrontmatterValue =
  | string
  | number
  | boolean
  | string[]
  | Array<Record<string, string>>;

export interface ParsedFrontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
}

const DELIM = '---';
const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

function parseScalar(raw: string): string | number | boolean {
  const t = raw.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/**
 * Index of the newline that begins the closing delimiter LINE, or -1.
 *
 * Searching for the first `\n---` anywhere is not the same thing: it also matches
 * `\n----`, `\n---8<---` and a body's own horizontal rule, which would end the
 * block early and silently relocate real frontmatter into the body — a template
 * that looks fine and has lost half its metadata.
 */
function findClosingDelimiter(text: string): number {
  for (
    let at = text.indexOf('\n' + DELIM, DELIM.length);
    at !== -1;
    at = text.indexOf('\n' + DELIM, at + 1)
  ) {
    const after = text[at + 1 + DELIM.length];
    if (after === undefined || after === '\n') return at;
  }
  return -1;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith(DELIM + '\n')) {
    throw new FrontmatterError('template must begin with a "---" frontmatter block');
  }
  const end = findClosingDelimiter(text);
  if (end === -1) throw new FrontmatterError('unterminated frontmatter block');

  const head = text.slice(DELIM.length + 1, end);
  const rest = text.slice(end + 1 + DELIM.length);
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;

  const data: Record<string, FrontmatterValue> = {};
  const lines = head.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) {
      throw new FrontmatterError(`unexpected indentation at frontmatter line ${i + 1}`);
    }
    const colon = line.indexOf(':');
    if (colon === -1) throw new FrontmatterError(`missing ":" at frontmatter line ${i + 1}`);

    const key = line.slice(0, colon).trim();
    if (!KEY_RE.test(key)) throw new FrontmatterError(`invalid frontmatter key "${key}"`);
    // Object.prototype keys are not special-cased anywhere downstream, so a
    // duplicate is always an editing mistake. Last-one-wins would hide it.
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      throw new FrontmatterError(`duplicate frontmatter key "${key}"`);
    }

    const inline = line.slice(colon + 1).trim();

    if (inline.startsWith('[') && inline.endsWith(']')) {
      const inner = inline.slice(1, -1).trim();
      if (inner === '') {
        data[key] = [];
      } else {
        data[key] = inner.split(',').map((s) => {
          if (s.trim() === '') {
            throw new FrontmatterError(`list "${key}" has an empty element`);
          }
          return String(parseScalar(s));
        });
      }
      i++;
      continue;
    }
    if (inline !== '') {
      data[key] = parseScalar(inline);
      i++;
      continue;
    }

    // No inline value: the only remaining legal shape is an indented block list.
    const blockStart = i + 1;
    i++;
    const items: string[] = [];
    const maps: Array<Record<string, string>> = [];
    while (i < lines.length && /^\s+\S/.test(lines[i] ?? '')) {
      const item = lines[i] ?? '';
      const dash = /^\s+-\s+(.*)$/.exec(item);
      if (dash) {
        const value = dash[1] ?? '';
        const inner = /^([A-Za-z][A-Za-z0-9_.-]*):\s+(.*)$/.exec(value);
        if (inner) maps.push({ [inner[1] as string]: String(parseScalar(inner[2] as string)) });
        else items.push(String(parseScalar(value)));
      } else {
        const cont = /^\s+([A-Za-z][A-Za-z0-9_.-]*):\s+(.*)$/.exec(item);
        if (!cont || maps.length === 0) {
          throw new FrontmatterError(`unparsable list item at frontmatter line ${i + 1}`);
        }
        (maps[maps.length - 1] as Record<string, string>)[cont[1] as string] = String(
          parseScalar(cont[2] as string),
        );
      }
      i++;
    }
    if (maps.length > 0 && items.length > 0) {
      throw new FrontmatterError(`list "${key}" mixes scalars and maps`);
    }
    if (maps.length === 0 && items.length === 0) {
      // `appliesTo:` with nothing after it would otherwise parse as `[]`, which
      // selectTemplates reads as "applies to every opportunity class". An author
      // who forgot a value gets a louder outcome than one who wrote `[]` on purpose.
      throw new FrontmatterError(
        `frontmatter key "${key}" has no value at line ${blockStart} — write a scalar, "[]", or an indented list`,
      );
    }
    data[key] = maps.length > 0 ? maps : items;
  }

  return { data, body };
}
