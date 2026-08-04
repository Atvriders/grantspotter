import fs from 'node:fs';
import path from 'node:path';
import { contentRoot } from '../templates/load.js';

/**
 * The rule fragments, as shipped markdown data under `content/prompts/`.
 *
 * They are data and not string literals for the same reason the templates are: the wording is the
 * product, it is reviewed as prose, and it changes without a rebuild. `composePrompt` includes
 * every id in this list, and `compose.test.ts` pins that — a fragment that stops being included is
 * a rule that silently left the brief.
 */
export const FRAGMENT_IDS = [
  'why-these-rules',
  'style-negative',
  'style-positive',
  'interview',
  'never-invent',
  'brevity',
] as const;

export type FragmentId = (typeof FRAGMENT_IDS)[number];

const cache = new Map<string, string>();

/**
 * A missing fragment THROWS. Returning `''` would compose a brief that reads complete and quietly
 * omits, say, the never-invent rule — the highest-consequence rule in the product — with nothing
 * on screen to say so.
 */
export function loadFragment(id: FragmentId | string): string {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const file = path.join(contentRoot(), 'prompts', `${id}.md`);
  if (!fs.existsSync(file)) throw new Error(`unknown prompt fragment "${id}"`);
  const body = fs.readFileSync(file, 'utf8').trim();
  cache.set(id, body);
  return body;
}
