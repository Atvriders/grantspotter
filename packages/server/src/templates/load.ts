import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type OpportunityClass, opportunityClassSchema } from '@grantspotter/core';
import { FrontmatterError, type FrontmatterValue, parseFrontmatter } from './frontmatter.js';

/**
 * A template file on disk is malformed. Always names the file, and keeps the
 * underlying `FrontmatterError` (when there is one) as `cause`.
 *
 * This is deliberately a different type from `TemplateNotFoundError`: "you asked
 * for a template that does not exist" is a 404, while "a template in the shipped
 * library will not load" is a 500 that someone has to fix. A caller that collapses
 * both into a 404 tells the applicant the writing desk is empty when in fact it is
 * broken — the same silence this product exists to refuse.
 */
export class TemplateError extends Error {
  readonly path: string;
  constructor(templatePath: string, message: string, options?: { cause?: unknown }) {
    super(`${path.basename(templatePath)}: ${message}`, options);
    this.name = 'TemplateError';
    this.path = templatePath;
  }
}

/** No template carries the requested id. */
export class TemplateNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`unknown template "${id}"`);
    this.name = 'TemplateNotFoundError';
    this.id = id;
  }
}

export interface TemplateSource {
  label: string;
  url: string;
}

export interface TemplateDoc {
  id: string;
  title: string;
  layer: 'component' | 'funder';
  order: number;
  appliesTo: OpportunityClass[];
  lengthTarget?: string;
  funderId?: string;
  programIds: string[];
  requires: string[];
  alwaysAvailable: boolean;
  sources: TemplateSource[];
  /** Derived from the body. Frontmatter never lists slots — one source of truth. */
  slots: string[];
  body: string;
  path: string;
}

export interface TemplateQuery {
  klass?: OpportunityClass;
  programId?: string;
  funderId?: string;
}

export interface TemplateSelection {
  overlays: TemplateDoc[];
  components: TemplateDoc[];
  playbooks: TemplateDoc[];
  /**
   * EVERY overlay in the library, whatever was asked for — the answer to "what has been written",
   * where `overlays` answers "what applies to this funder". They are different questions and were
   * being answered by one array, so `/templates` with no funder in the query (the only link the
   * nav rail has) printed "No overlay has been written for this funder yet." on a page with no
   * funder in context, while eight overlays sat in the library the paragraph above it advertises.
   *
   * It is NOT the funder-bound list widened. `overlays[0]` is a claim about the applicant's own
   * funder (see `selectTemplates`), and this list must never reach that position: a screen that
   * inserts from it is inserting another funder's published criteria into this funder's
   * application.
   */
  libraryOverlays: TemplateDoc[];
}

/**
 * The complete frontmatter vocabulary. It is closed on purpose: an unrecognised key
 * is almost always a misspelling of a real one, and a misspelled `appliesTo` does not
 * fail — it leaves `appliesTo` absent, which `selectTemplates` would read as "applies
 * to every opportunity class". Extending this set is a deliberate act, not a typo.
 */
export const ALLOWED_FRONTMATTER_KEYS = new Set([
  'id',
  'title',
  'layer',
  'order',
  'appliesTo',
  'lengthTarget',
  'funderId',
  'programIds',
  'requires',
  'alwaysAvailable',
  'sources',
]);

const SLOT_SCAN = () => /\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\}\}/g;

/** Walks up from this module until it finds the repo's `content/` directory. */
export function contentRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'content');
    if (fs.existsSync(path.join(candidate, 'templates', 'components'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'content/ not found: expected a directory containing templates/components above ' +
      path.dirname(fileURLToPath(import.meta.url)),
  );
}

export function templatesRoot(): string {
  return path.join(contentRoot(), 'templates');
}

function str(v: FrontmatterValue | undefined, key: string, file: string): string {
  if (typeof v !== 'string') throw new TemplateError(file, `frontmatter "${key}" must be a string`);
  return v;
}

function optionalStr(
  v: FrontmatterValue | undefined,
  key: string,
  file: string,
): string | undefined {
  if (v === undefined) return undefined;
  return str(v, key, file);
}

/**
 * A list-of-strings key. An absent key is `[]`; a PRESENT key of any other shape
 * throws rather than degrading to `[]`.
 *
 * Silently returning `[]` here is the defect the plan's "Canonical program ids"
 * section describes from the other end: `programIds` that does not contain the
 * program produces no error, no warning and zero overlays, and the funder-specific
 * guidance simply disappears from the writing desk. A shape mistake must not be
 * able to reach that state quietly.
 */
function strArray(v: FrontmatterValue | undefined, key: string, file: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new TemplateError(file, `frontmatter "${key}" must be a list of strings`);
  }
  return v as string[];
}

function bool(v: FrontmatterValue | undefined, key: string, file: string): boolean {
  if (v === undefined) return false;
  if (typeof v !== 'boolean') {
    throw new TemplateError(file, `frontmatter "${key}" must be true or false`);
  }
  return v;
}

/**
 * `appliesTo` is REQUIRED, and every entry must be one of core's four opportunity
 * classes. Both rules exist because the absent and the misspelt case are invisible:
 * an empty `appliesTo` means "every class" to `selectTemplates`, so a forgotten key
 * silently widens a restricted component, and an unknown class silently narrows a
 * template to nothing. `[]` written on purpose still means every class.
 */
function classArray(v: FrontmatterValue | undefined, file: string): OpportunityClass[] {
  if (v === undefined) {
    throw new TemplateError(
      file,
      'frontmatter "appliesTo" is required — write "[]" to mean every opportunity class',
    );
  }
  const raw = strArray(v, 'appliesTo', file);
  for (const entry of raw) {
    if (!opportunityClassSchema.safeParse(entry).success) {
      throw new TemplateError(
        file,
        `frontmatter "appliesTo" has an unknown class "${entry}" — expected one of ${opportunityClassSchema.options.join(', ')}`,
      );
    }
  }
  return raw as OpportunityClass[];
}

function sourceArray(v: FrontmatterValue | undefined, file: string): TemplateSource[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new TemplateError(file, 'frontmatter "sources" must be a list');
  return (v as unknown[]).map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TemplateError(file, 'every "sources" entry needs a label and a url');
    }
    const rec = entry as Record<string, string>;
    if (!rec.label || !rec.url) {
      throw new TemplateError(file, 'every "sources" entry needs a label and a url');
    }
    return { label: rec.label, url: rec.url };
  });
}

export function deriveSlots(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(SLOT_SCAN())) {
    const p = m[1] as string;
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function loadTemplateFile(absPath: string): TemplateDoc {
  const raw = fs.readFileSync(absPath, 'utf8');
  let data: Record<string, FrontmatterValue>;
  let body: string;
  try {
    ({ data, body } = parseFrontmatter(raw));
  } catch (err) {
    if (err instanceof FrontmatterError) {
      throw new TemplateError(absPath, err.message, { cause: err });
    }
    throw err;
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      throw new TemplateError(
        absPath,
        `unknown frontmatter key "${key}" — allowed keys are ${[...ALLOWED_FRONTMATTER_KEYS].join(', ')}`,
      );
    }
  }

  const file = path.basename(absPath);
  const id = str(data.id, 'id', absPath);
  const base = file.replace(/\.md$/, '');
  if (id !== base) {
    throw new TemplateError(absPath, `frontmatter id "${id}" does not match filename "${base}"`);
  }
  const layer = str(data.layer, 'layer', absPath);
  if (layer !== 'component' && layer !== 'funder') {
    throw new TemplateError(absPath, 'frontmatter "layer" must be "component" or "funder"');
  }
  if (typeof data.order !== 'number') {
    throw new TemplateError(absPath, 'frontmatter "order" must be a number');
  }

  return {
    id,
    title: str(data.title, 'title', absPath),
    layer,
    order: data.order,
    appliesTo: classArray(data.appliesTo, absPath),
    lengthTarget: optionalStr(data.lengthTarget, 'lengthTarget', absPath),
    funderId: optionalStr(data.funderId, 'funderId', absPath),
    programIds: strArray(data.programIds, 'programIds', absPath),
    requires: strArray(data.requires, 'requires', absPath),
    alwaysAvailable: bool(data.alwaysAvailable, 'alwaysAvailable', absPath),
    sources: sourceArray(data.sources, absPath),
    slots: deriveSlots(body),
    body,
    path: absPath,
  };
}

export function loadTemplates(root: string = templatesRoot()): TemplateDoc[] {
  const docs: TemplateDoc[] = [];
  for (const sub of ['components', 'funders']) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      docs.push(loadTemplateFile(path.join(dir, entry)));
    }
  }
  const seen = new Set<string>();
  for (const d of docs) {
    if (seen.has(d.id)) throw new TemplateError(d.path, `duplicate template id "${d.id}"`);
    seen.add(d.id);
  }
  return docs;
}

export function getTemplate(id: string, root?: string): TemplateDoc {
  const found = loadTemplates(root).find((t) => t.id === id);
  if (!found) throw new TemplateNotFoundError(id);
  return found;
}

export function selectTemplates(all: TemplateDoc[], q: TemplateQuery): TemplateSelection {
  const byOrder = (a: TemplateDoc, b: TemplateDoc) => a.order - b.order || a.id.localeCompare(b.id);

  /** Empty `appliesTo` means every class, which is the rule components have always been held to. */
  const fitsClass = (t: TemplateDoc): boolean =>
    q.klass === undefined || t.appliesTo.length === 0 || t.appliesTo.includes(q.klass);

  /**
   * `overlays[0]` IS A CLAIM, NOT A LIST POSITION. The applications screen prints "This funder's
   * overlay, <title>, is selected" from it and offers a one-click insert of that overlay's
   * criteria into the draft, so whatever lands first is what an applicant is told their funder
   * asks for.
   *
   * A funder is not a programme. The ARRL Foundation runs grants, club grants and scholarships,
   * ships one overlay for each, and puts one `funderId` on all three — so a funder-level match
   * returns all three for every one of its records, and `order` alone then handed the Amateur
   * Radio Grants overlay to all 111 ARRL catalog SCHOLARSHIPS. Measured on a built server against
   * the shipped seed on 2026-08-10: 113 of the 119 programmes that get an overlay named the wrong
   * one. `klass` was passed in by both callers for exactly this and was read only by `components`.
   *
   * So the two matches are no longer one filter. Naming this programme in `programIds` is a
   * statement about THIS record and wins outright, whatever its `order`. Matching only the funder
   * is a statement about the organisation, and has nothing but `appliesTo` to say whether it is
   * about this kind of award — so it is held to it, and a sibling that does not fit is dropped
   * rather than ranked lower: it would otherwise stay clickable under a heading promising these
   * are written against the criteria of the thing being applied for.
   */
  const isForThisProgram = (t: TemplateDoc): boolean =>
    q.programId !== undefined && t.programIds.includes(q.programId);

  /** An overlay is funder-layer and NOT always-available; a playbook is the always-available half. */
  const isOverlay = (t: TemplateDoc): boolean => t.layer === 'funder' && !t.alwaysAvailable;

  const overlays = all
    .filter(isOverlay)
    .filter(
      (t) =>
        isForThisProgram(t) ||
        (q.funderId !== undefined && t.funderId === q.funderId && fitsClass(t)),
    )
    .sort((a, b) => Number(isForThisProgram(b)) - Number(isForThisProgram(a)) || byOrder(a, b));

  // The same predicate, unfiltered: what the library HOLDS, which no query narrows. Sorted by
  // title rather than by `order`, because `order` ranks overlays against one funder's application
  // and means nothing across funders — an index reads alphabetically.
  const libraryOverlays = all.filter(isOverlay).sort((a, b) => a.title.localeCompare(b.title));

  const playbooks = all.filter((t) => t.layer === 'funder' && t.alwaysAvailable).sort(byOrder);

  const components = all
    .filter((t) => t.layer === 'component')
    .filter(fitsClass)
    .sort(byOrder);

  return { overlays, components, playbooks, libraryOverlays };
}
