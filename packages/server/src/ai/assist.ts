import Anthropic from '@anthropic-ai/sdk';
import type { Program, RawOpportunity } from '@grantspotter/core';
import type { AppConfig } from '../config.js';
import { assertNotBlocked } from '../fetcher/blocklist.js';

/**
 * Spec §9's OPTIONAL server-side assist. Everything about this module is defensive:
 *
 *  - No ANTHROPIC_API_KEY => isEnabled() is false, no client is constructed, and NO NETWORK CALL
 *    IS EVER MADE. Not "degrades gracefully" — it does not call.
 *  - Never on a read path. Only crawl/ and review/ import this; api/ never does, and a test in
 *    assist.test.ts enforces that. A page view must never wait on a model.
 *  - Never required. parseAssist is a SALVAGE path, invoked only when the deterministic parser
 *    already returned zero records for a source that expects some. preScore only ever refines a
 *    confidence number that has a deterministic value already.
 *  - Never drafts prose. This extracts fields from pages. Spec §9 is explicit that the product
 *    does not write the applicant's essay, and the system prompt says so.
 *  - Never sends a blocklisted host to the model. The fetcher already refuses those hosts (see
 *    ../fetcher/blocklist.ts), so in practice this never fires — but this module does not TRUST
 *    that invariant, it ASSERTS it, on both the parse path (hint.sourceUrl) and the pre-score
 *    path (candidate.trust.sourceUrl). A blocklist violation is a programming bug, not a
 *    transport failure, so it throws loudly rather than being swallowed into an empty result.
 *
 * Model: claude-sonnet-5. Cheap, fast and strong at structured extraction, which is the whole
 * job. Pinned as a constant rather than configured, so a deployment cannot silently swap in a
 * model whose extraction behaviour nobody has tested here.
 */
export const AI_ASSIST_MODEL = 'claude-sonnet-5';
const MAX_HTML_CHARS = 60_000;
const MAX_TOKENS = 4_096;

/**
 * On claude-sonnet-5 an OMITTED `thinking` field runs adaptive thinking, and max_tokens caps
 * thinking + response text together — a 4k budget would truncate the envelope mid-object.
 * Extraction needs the whole envelope, not reasoning depth, so thinking is disabled explicitly
 * and effort is `low`. (Disabling thinking is accepted on Sonnet 5 at any effort.)
 */
const THINKING = { type: 'disabled' } as const;
const EFFORT = 'low' as const;

export interface ParseHint {
  sourceId: string;
  sourceUrl: string;
  expectedFields: string[];
}

export interface AiClient {
  /** `schema` is a JSON Schema passed as output_config.format — the reply cannot be prose. */
  complete(system: string, user: string, schema: unknown): Promise<string>;
}

export interface AiAssist {
  isEnabled(): boolean;
  parseAssist(html: string, hint: ParseHint): Promise<RawOpportunity[]>;
  preScore(candidate: Program): Promise<number | undefined>;
}

const PARSE_SYSTEM = [
  'You extract published grant and scholarship facts from a web page into strict JSON.',
  'You NEVER write, compose or draft prose, narrative, summaries in your own voice, or essay',
  'text of any kind. You copy what the page says, verbatim, into fields.',
  'If a field is not on the page, omit it. Never infer a deadline, an amount or an eligibility',
  'rule that the page does not state.',
].join(' ');

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          externalKey: { type: 'string' },
          name: { type: 'string' },
          rawFields: { type: 'object', additionalProperties: { type: 'string' } },
          rawText: { type: 'string' },
        },
        required: ['externalKey', 'name', 'rawFields', 'rawText'],
        additionalProperties: false,
      },
    },
  },
  required: ['records'],
  additionalProperties: false,
} as const;

const SCORE_SYSTEM = [
  'You judge how likely a scraped grant record is to be correct, given its own fields.',
  'You NEVER write prose for a user and NEVER invent facts.',
  'confidence is a number from 0 to 1.',
].join(' ');

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['confidence', 'reason'],
  additionalProperties: false,
} as const;

/** Strict: junk, prose, or a wrong shape all yield []. Never throws. */
export function parseAssistResponse(
  text: string,
  sourceId: string,
  sourceUrl: string,
): RawOpportunity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) return [];
  const out: RawOpportunity[] = [];
  for (const entry of records) {
    const row = entry as Record<string, unknown>;
    const externalKey = typeof row.externalKey === 'string' ? row.externalKey.trim() : '';
    if (externalKey === '') continue; // never mint an identity the model made up
    const rawFields: Record<string, string> = {};
    for (const [key, value] of Object.entries((row.rawFields ?? {}) as Record<string, unknown>)) {
      if (typeof value === 'string') rawFields[key] = value;
    }
    rawFields.aiAssisted = 'true';
    out.push({
      sourceId,
      externalKey,
      name: typeof row.name === 'string' ? row.name : externalKey,
      rawFields,
      sourceUrl,
      rawText: typeof row.rawText === 'string' ? row.rawText : '',
    });
  }
  return out;
}

export function parsePreScoreResponse(text: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const value = (parsed as { confidence?: unknown }).confidence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function realClient(apiKey: string): AiClient {
  const anthropic = new Anthropic({ apiKey });
  return {
    async complete(system, user, schema) {
      const message = await anthropic.messages.create({
        model: AI_ASSIST_MODEL,
        max_tokens: MAX_TOKENS,
        thinking: THINKING,
        output_config: {
          effort: EFFORT,
          format: { type: 'json_schema', schema: schema as Record<string, unknown> },
        },
        system,
        messages: [{ role: 'user', content: user }],
      });
      // content is a discriminated union — narrow on .type before reading .text.
      return message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();
    },
  };
}

export function createAiAssist(
  config: Pick<AppConfig, 'anthropicApiKey'>,
  deps: { client?: AiClient } = {},
): AiAssist {
  const key = (config.anthropicApiKey ?? '').trim();
  const enabled = key !== '';
  // Constructed lazily and ONLY when enabled: no key means no client and no call.
  let client: AiClient | undefined;
  const getClient = (): AiClient => {
    client ??= deps.client ?? realClient(key);
    return client;
  };

  return {
    isEnabled: () => enabled,

    async parseAssist(html, hint) {
      if (!enabled) return [];
      // Defense in depth: the fetcher already refuses these hosts, but this module asserts
      // that invariant rather than trusting it. A violation is a programming bug and throws.
      assertNotBlocked(hint.sourceUrl);
      const user = [
        `Source id: ${hint.sourceId}`,
        `Source URL: ${hint.sourceUrl}`,
        `Fields this source usually publishes: ${hint.expectedFields.join(', ')}`,
        'Page HTML follows. Extract every distinct grant or scholarship it publishes.',
        html.slice(0, MAX_HTML_CHARS),
      ].join('\n\n');
      try {
        const text = await getClient().complete(PARSE_SYSTEM, user, PARSE_SCHEMA);
        return parseAssistResponse(text, hint.sourceId, hint.sourceUrl);
      } catch {
        return []; // a rate limit or an outage degrades to deterministic-only, silently
      }
    },

    async preScore(candidate) {
      if (!enabled) return undefined;
      assertNotBlocked(candidate.trust.sourceUrl);
      const user = JSON.stringify({
        name: candidate.name,
        amount: candidate.amount,
        deadline: candidate.deadline,
        constraints: candidate.constraints.map((c) => c.rawText),
        rawOtherText: candidate.rawOtherText.slice(0, 4_000),
        sourceUrl: candidate.trust.sourceUrl,
      });
      try {
        return parsePreScoreResponse(await getClient().complete(SCORE_SYSTEM, user, SCORE_SCHEMA));
      } catch {
        return undefined;
      }
    },
  };
}
