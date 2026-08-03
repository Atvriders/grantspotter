import type { Constraint, ConstraintSpec } from '@grantspotter/core';

/**
 * Biased toward detecting a preference, not away from it: a false negative here converts a
 * stated preference into a hard bar on whichever axis the sentence describes (this is the
 * shared classifier every axis extractor calls), while a false positive merely softens a real
 * requirement. The asymmetry is deliberate — see the plural-audit report for the corpus-wide
 * hard/soft delta this produced.
 */
const PREFERENCE =
  /\b(?:preferences?|preferred|preferential(?:ly)?|prefers?|preferably|priority|favou?r(?:ed|s|ing)?|considered first|first consideration|is given to|encouraged)\b/i;
const CASCADE = /\bif no (?:other )?qualified applicant/i;

/** Nearly every axis appears in both requirement and preference form. Soft never excludes. */
export function isPreferenceText(text: string): boolean {
  return PREFERENCE.test(text);
}

/** 0 = primary preference; 1 = the explicit "if no qualified applicant is identified" fallback. */
export function cascadeRank(text: string): number {
  return CASCADE.test(text) ? 1 : 0;
}

/**
 * FNV-1a, 32-bit, hex. Deliberately NOT node:crypto — normalize/ is pure (spec §14) and a
 * constraint id is namespacing, not security: it only has to be stable across runs and
 * collision-resistant inside one program's short constraint list.
 */
export function stableSuffix(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function makeConstraint(
  axis: string,
  rawText: string,
  spec: ConstraintSpec,
  index: number,
): Constraint {
  const soft = isPreferenceText(rawText);
  return {
    id: `${axis}-${index}-${stableSuffix(`${axis}|${rawText}`)}`,
    hard: !soft,
    fallbackRank: soft ? cascadeRank(rawText) : 0,
    rawText,
    spec,
  };
}
