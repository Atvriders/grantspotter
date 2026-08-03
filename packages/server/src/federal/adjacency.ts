export interface AdjacencyTerm {
  term: string;
  weight: number;
}

/**
 * A WEIGHTED VOCABULARY, not a keyword match.
 *
 * "amateur radio" returns 57 Grants.gov hits and "cubesat" returns exactly 1. The federal money
 * a collegiate ham club can actually win is ADJACENT: NSF geospace / ECCS / ATE / Noyce, NASA
 * Space Grant and MUREP, NTIA PWSCIF. Meanwhile a bare "radio" match fires on radiology,
 * radiotherapy and public broadcasting, and a bare "STEM education" match fires on thousands of
 * irrelevant awards. Hence multi-word phrases with weights, negative weights for the classic
 * false-positive families, and a threshold that generic language alone cannot clear.
 */
export const ADJACENCY_VOCABULARY: readonly AdjacencyTerm[] = Object.freeze([
  // Tier 1 (+5) — direct ham / radio-science signal
  { term: 'amateur radio', weight: 5 },
  { term: 'ham radio', weight: 5 },
  { term: 'shortwave', weight: 5 },
  { term: 'ionospheric', weight: 5 },
  { term: 'ionosphere', weight: 5 },
  { term: 'HF propagation', weight: 5 },
  { term: 'radio science', weight: 5 },
  { term: 'spectrum monitoring', weight: 5 },
  { term: 'software-defined radio', weight: 5 },
  { term: 'software defined radio', weight: 5 },
  { term: 'SDR', weight: 5 },
  { term: 'cubesat', weight: 5 },
  { term: 'ground station', weight: 5 },
  { term: 'radio astronomy', weight: 5 },
  { term: 'reverse beacon', weight: 5 },

  // Tier 2 (+3) — the named adjacent programs that are genuinely winnable
  { term: 'geospace', weight: 3 },
  { term: 'space weather', weight: 3 },
  { term: 'heliophysics', weight: 3 },
  { term: 'ECCS', weight: 3 },
  { term: 'Electrical, Communications and Cyber Systems', weight: 3 },
  { term: 'Advanced Technological Education', weight: 3 },
  { term: 'ATE', weight: 3 },
  { term: 'Noyce', weight: 3 },
  { term: 'MUREP', weight: 3 },
  { term: 'Space Grant', weight: 3 },
  { term: 'PWSCIF', weight: 3 },
  { term: 'Public Wireless Supply Chain Innovation Fund', weight: 3 },
  { term: 'spectrum sharing', weight: 3 },
  { term: 'wireless innovation', weight: 3 },
  { term: 'RF engineering', weight: 3 },
  { term: 'antenna', weight: 3 },
  { term: 'telemetry', weight: 3 },
  { term: 'radio frequency spectrum', weight: 3 },

  // Tier 3 (+2) — audience fit for a collegiate or K-12 club
  { term: 'undergraduate research', weight: 2 },
  { term: 'community college', weight: 2 },
  { term: 'minority serving institution', weight: 2 },
  { term: 'HBCU', weight: 2 },
  { term: 'Hispanic-Serving Institution', weight: 2 },
  { term: 'Tribal College', weight: 2 },
  { term: 'student organization', weight: 2 },
  { term: 'student branch', weight: 2 },
  { term: 'K-12 STEM', weight: 2 },
  { term: 'teacher professional development', weight: 2 },
  { term: 'informal science education', weight: 2 },
  { term: 'makerspace', weight: 2 },

  // Tier 4 (+1) — generic STEM context, never enough on its own
  { term: 'STEM education', weight: 1 },
  { term: 'workforce development', weight: 1 },
  { term: 'broadening participation', weight: 1 },
  { term: 'curriculum development', weight: 1 },
  { term: 'laboratory equipment', weight: 1 },
  { term: 'hands-on learning', weight: 1 },
  { term: 'experiential learning', weight: 1 },
  { term: 'outreach', weight: 1 },

  // Negative (-4) — the false-positive families a naive "radio" match hits
  { term: 'radiation oncology', weight: -4 },
  { term: 'radiotherapy', weight: -4 },
  { term: 'radiopharmaceutical', weight: -4 },
  { term: 'radiology', weight: -4 },
  { term: 'radiologist', weight: -4 },
  { term: 'radioactive', weight: -4 },
  { term: 'radiocarbon', weight: -4 },
  { term: 'radiofrequency ablation', weight: -4 },
  { term: 'public broadcasting', weight: -4 },
  { term: 'broadcast television', weight: -4 },
]);

/**
 * One Tier-1 term (5) plus any Tier-4 term (1) clears this; two Tier-2 terms (3+3) clear it;
 * one Tier-2 plus two Tier-3 (3+2+2) clear it. A lone "STEM education" or a lone "antenna"
 * does not.
 */
export const ADJACENCY_THRESHOLD = 6 as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Non-alphanumeric boundaries, so SDR does not match SDRAM and ATE does not match CANDIDATE.
const MATCHERS: ReadonlyArray<{ term: AdjacencyTerm; re: RegExp }> = ADJACENCY_VOCABULARY.map(
  (term) => ({
    term,
    re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term.term)}(?![A-Za-z0-9])`, 'i'),
  }),
);

/** CONTRACT §5. Distinct terms only: a term repeated ten times still counts once. */
export function scoreAdjacency(text: string): { score: number; hits: string[] } {
  if (text.trim() === '') return { score: 0, hits: [] };
  const matched: AdjacencyTerm[] = [];
  for (const { term, re } of MATCHERS) {
    if (re.test(text)) matched.push(term);
  }
  const score = Math.max(0, matched.reduce((sum, t) => sum + t.weight, 0));
  const hits = matched
    .slice()
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .map((t) => t.term);
  return { score, hits };
}

export function isAdjacent(text: string): boolean {
  return scoreAdjacency(text).score >= ADJACENCY_THRESHOLD;
}
