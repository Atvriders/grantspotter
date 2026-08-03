import { sha256Hex } from "./sha256.js";
import type { Constraint, Program } from "./types.js";

/**
 * Collapse the whitespace noise that arrl.org's markup produces: non-breaking
 * spaces, hard line wraps inside sentences, and leading/trailing padding. Two
 * renderings of the same sentence must hash identically or the Inbox fills
 * with phantom changes.
 */
function normalizeText(value: string): string {
  return value.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(normalizeText(value));
  if (Array.isArray(value)) {
    // Order is not content for arrays of strings anywhere in the tree, not
    // just at the top level: GeoSpec.values, field_of_study's fields and
    // excludedFields, institution's degreeLevels, citizenship's and
    // gender's allowed, age_stage's stages, ham_activity's activityKinds.
    // A parser that legitimately emits one of these in a different order
    // must not fire a phantom eligibility_changed. Arrays of non-strings
    // (Constraint[], AwardTier[]) are left as-is here; hashProgram sorts
    // the ones among those where order is likewise not content.
    const items = value.every((v) => typeof v === "string") ? [...value].sort() : value;
    return `[${items.map(canonical).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function byId(a: Constraint, b: Constraint): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * SHA-256 over the substantive fields of a Program, EXCLUDING TrustFields.
 * Excluding trust is load-bearing: lastVerifiedAt is rewritten by every crawl,
 * and hashing it would mark every record changed every night.
 *
 * Array order is not content: parsers legitimately emit constraints and tags in
 * different orders between runs, so they are sorted before hashing.
 */
export function hashProgram(p: Program): string {
  const { trust: _trust, ...rest } = p;
  void _trust;
  const stable = {
    ...rest,
    applicantEntities: [...p.applicantEntities].sort(),
    fundingRestrictions: [...p.fundingRestrictions].sort(),
    tags: [...p.tags].sort(),
    constraints: [...p.constraints].sort(byId),
  };
  return sha256Hex(canonical(stable));
}
