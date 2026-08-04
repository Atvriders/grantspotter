import fs from 'node:fs';
import path from 'node:path';
import { contentRoot } from './load.js';

/**
 * One NASA Space Grant consortium, as a ROUTING record.
 *
 * NASA's National Space Grant College and Fellowship Program runs through 52 independent
 * consortia — one per state, plus DC and Puerto Rico — and there is no national application and
 * no national deadline. That is why this ships as a picker rather than as a feed, and it is also
 * why the record is this thin: a deadline, an award size or an eligibility rule recorded here
 * would be one consortium's rule shown to applicants in the other 51.
 */
export interface SpaceGrantConsortium {
  /** Two-letter USPS code, upper-cased. The picker's only key. */
  state: string;
  name: string;
  leadInstitution: string;
  /**
   * Always false in the shipped file, and hard-coded false by this loader regardless of what the
   * file says. The names and lead institutions were assembled offline and have not been confirmed
   * by a live fetch, so the UI renders them with the unverified treatment and a link to NASA's
   * directory. Only `verify-sources`, after a fetch it recorded, may ever promote a record.
   */
  verified: boolean;
  /** NASA's own consortium directors directory — shared by every record, never per-consortium. */
  directoryUrl: string;
  /** The shared caveat. Identical on all 52 records, so it can carry no per-consortium claim. */
  note: string;
}

interface ConsortiaFile {
  _meta: { directoryUrl?: unknown; warning?: unknown; assembledAt?: unknown };
  consortia: Array<{ state?: unknown; name?: unknown; leadInstitution?: unknown }>;
}

/** The number of consortia NASA runs. A file with any other count is corrupt, not partial. */
export const CONSORTIUM_COUNT = 52;

export class ConsortiaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConsortiaError';
  }
}

/** `data/reference/`, found relative to the same `content/` walk the template loader uses. */
export function referenceRoot(): string {
  return path.join(path.dirname(contentRoot()), 'data', 'reference');
}

let cache: readonly SpaceGrantConsortium[] | undefined;

function str(v: unknown, field: string, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ConsortiaError(`space-grant-consortia.json: ${where} is missing "${field}"`);
  }
  return v.trim();
}

/**
 * Reads the shipped reference file. The shape is rebuilt field by field rather than spread from
 * the JSON: a `verified: true`, a `deadline` or an `amount` smuggled into the data file must not
 * be able to reach a caller, because a caller has no way to tell a curated guess from a checked
 * fact once it is holding the object.
 */
export function loadConsortia(root: string = referenceRoot()): readonly SpaceGrantConsortium[] {
  const isShipped = root === referenceRoot();
  if (cache && isShipped) return cache;

  const file = path.join(root, 'space-grant-consortia.json');
  let parsed: ConsortiaFile;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ConsortiaFile;
  } catch (err) {
    throw new ConsortiaError(`space-grant-consortia.json could not be read at ${file}`, {
      cause: err,
    });
  }
  if (!Array.isArray(parsed?.consortia)) {
    throw new ConsortiaError('space-grant-consortia.json: "consortia" must be a list');
  }
  if (parsed.consortia.length !== CONSORTIUM_COUNT) {
    // A short file is a corrupted file. Serving it would turn 51 states into "we have no
    // consortium for you", which is indistinguishable from the user mistyping their state.
    throw new ConsortiaError(
      `space-grant-consortia.json holds ${parsed.consortia.length} records; NASA runs ${CONSORTIUM_COUNT}`,
    );
  }

  const directoryUrl = str(parsed._meta?.directoryUrl, 'directoryUrl', '_meta');
  const assembledAt = str(parsed._meta?.assembledAt, 'assembledAt', '_meta');
  const note =
    `Curated offline on ${assembledAt} and not live-verified: confirm the consortium name and ` +
    'find its website through NASA’s consortium directors directory before you rely on either. ' +
    'GrantSpotter records no deadline, award amount or eligibility rule for any consortium — ' +
    'there are 52 independent calendars, and only your consortium’s own site is authoritative.';

  const out: SpaceGrantConsortium[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.consortia) {
    const state = str(raw.state, 'state', 'a consortium record').toUpperCase();
    if (state.length !== 2) {
      throw new ConsortiaError(`space-grant-consortia.json: "${state}" is not a two-letter code`);
    }
    if (seen.has(state)) {
      throw new ConsortiaError(`space-grant-consortia.json: duplicate state "${state}"`);
    }
    seen.add(state);
    out.push(
      Object.freeze({
        state,
        name: str(raw.name, 'name', state),
        leadInstitution: str(raw.leadInstitution, 'leadInstitution', state),
        verified: false,
        directoryUrl,
        note,
      }),
    );
  }

  const frozen = Object.freeze(out) as readonly SpaceGrantConsortium[];
  if (isShipped) cache = frozen;
  return frozen;
}

/**
 * Resolves a two-letter state code to its consortium, or `undefined`.
 *
 * There is no fuzzy match on purpose. "Michigan", a zip code or a half-typed code returns
 * nothing rather than the nearest plausible consortium: routing an applicant to the wrong state's
 * programme is worse than telling them the picker did not recognise what they typed.
 */
export function pickConsortium(state: string, root?: string): SpaceGrantConsortium | undefined {
  const code = state.trim().toUpperCase();
  if (code.length !== 2) return undefined;
  return loadConsortia(root).find((c) => c.state === code);
}
