// Stub for Task 16. Task 17 replaces this body with the real per-axis constraint extraction
// (spec §4.5 / §7). Kept pure: no node: import, no I/O, only the frozen RawOpportunity shape in.
import type { Constraint, RawOpportunity } from '@grantspotter/core';

export function extractConstraints(_raw: RawOpportunity): Constraint[] {
  return [];
}
