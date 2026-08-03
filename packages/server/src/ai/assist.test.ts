import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Program } from '@grantspotter/core';
import {
  AI_ASSIST_MODEL,
  createAiAssist,
  parseAssistResponse,
  parsePreScoreResponse,
} from './assist.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const hint = {
  sourceId: 'qcwa',
  sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
  expectedFields: ['Award Amount', 'Number of Awards', 'License Requirement'],
};

// Typed via the `Program` return annotation (not `as const`) so `applicantEntities` etc. come
// out as the mutable array types `Program` declares, rather than readonly tuples.
const program = (): Program => ({
    id: 'p',
    funderId: 'qcwa',
    name: 'QCWA Memorial Scholarship',
    klass: 'ham_scholarship',
    summary: 's',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_fixed', amountRaw: '$3,000', awardCountRaw: '19' },
    deadline: { kind: 'rolling', source: { kind: 'self' }, note: '' },
    applyVia: 'page_form',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      verificationMethod: 'live_fetch',
      contentHash: 'h',
    },
    rawOtherText: '',
    tags: [],
  });

describe('no key means no calls at all', () => {
  it('is disabled, returns nothing, and never constructs a client', async () => {
    const client = { complete: vi.fn() };
    const assist = createAiAssist({ anthropicApiKey: undefined }, { client });
    expect(assist.isEnabled()).toBe(false);
    await expect(assist.parseAssist('<html></html>', hint)).resolves.toEqual([]);
    await expect(assist.preScore(program())).resolves.toBeUndefined();
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('treats an empty or whitespace key as absent', async () => {
    const client = { complete: vi.fn() };
    const assist = createAiAssist({ anthropicApiKey: '   ' }, { client });
    expect(assist.isEnabled()).toBe(false);
    await assist.parseAssist('<html></html>', hint);
    expect(client.complete).not.toHaveBeenCalled();
  });
});

describe('with a key', () => {
  const enabled = (complete: (s: string, u: string, schema: unknown) => Promise<string>) =>
    createAiAssist({ anthropicApiKey: 'sk-test' }, { client: { complete } });

  it('extracts fields into RawOpportunity records', async () => {
    const assist = enabled(async () =>
      JSON.stringify({
        records: [
          {
            externalKey: 'qcwa-memorial-scholarship',
            name: 'QCWA Memorial Scholarship',
            rawFields: { 'Award Amount': '$3,000', 'Number of Awards': '19' },
            rawText: 'Sponsored by an active QCWA member.',
          },
        ],
      }),
    );
    const raws = await assist.parseAssist('<html>messy</html>', hint);
    expect(raws).toHaveLength(1);
    expect(raws[0].sourceId).toBe('qcwa');
    expect(raws[0].rawFields['Award Amount']).toBe('$3,000');
    expect(raws[0].sourceUrl).toBe(hint.sourceUrl);
  });

  it('uses the pinned model id', async () => {
    let seenSystem = '';
    const assist = enabled(async (system) => {
      seenSystem = system;
      return '{"records":[]}';
    });
    await assist.parseAssist('<html></html>', hint);
    expect(AI_ASSIST_MODEL).toBe('claude-sonnet-5');
    expect(seenSystem).toContain('extract');
  });

  it('pins the reply to a JSON schema, so prose is not even representable', async () => {
    let seenSchema: unknown;
    const assist = enabled(async (_system, _user, schema) => {
      seenSchema = schema;
      return '{"records":[]}';
    });
    await assist.parseAssist('<html></html>', hint);
    const schema = seenSchema as { properties: { records: unknown }; additionalProperties: boolean };
    expect(schema.properties.records).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it('forbids drafting narrative prose in the system prompt', async () => {
    let seenSystem = '';
    const assist = enabled(async (system) => {
      seenSystem = system;
      return '{"records":[]}';
    });
    await assist.parseAssist('<html></html>', hint);
    expect(seenSystem).toMatch(/never (write|compose|draft)/i);
    expect(seenSystem).toMatch(/prose|narrative|essay/i);
  });

  it('returns a 0..1 confidence from preScore', async () => {
    const assist = enabled(async () => '{"confidence":0.42,"reason":"amount and deadline agree"}');
    await expect(assist.preScore(program())).resolves.toBeCloseTo(0.42, 5);
  });

  it('swallows a transport failure and degrades to deterministic-only', async () => {
    const assist = enabled(async () => {
      throw new Error('429 overloaded');
    });
    await expect(assist.parseAssist('<html></html>', hint)).resolves.toEqual([]);
    await expect(assist.preScore(program())).resolves.toBeUndefined();
  });
});

describe('response parsing is strict', () => {
  it('rejects anything that is not the JSON envelope', () => {
    expect(parseAssistResponse('I found three scholarships on this page!', 'qcwa', 'u')).toEqual([]);
    expect(parseAssistResponse('{"records":"nope"}', 'qcwa', 'u')).toEqual([]);
    expect(parseAssistResponse('', 'qcwa', 'u')).toEqual([]);
  });

  it('drops a record with no externalKey rather than minting one', () => {
    expect(
      parseAssistResponse('{"records":[{"name":"x","rawFields":{},"rawText":"y"}]}', 'qcwa', 'u'),
    ).toEqual([]);
  });

  it('clamps and validates the pre-score', () => {
    expect(parsePreScoreResponse('{"confidence":0.5}')).toBe(0.5);
    expect(parsePreScoreResponse('{"confidence":9}')).toBe(1);
    expect(parsePreScoreResponse('{"confidence":-4}')).toBe(0);
    expect(parsePreScoreResponse('{"confidence":"high"}')).toBeUndefined();
    expect(parsePreScoreResponse('not json')).toBeUndefined();
  });
});

describe('the assist never sends a blocklisted host to the model', () => {
  it('asserts the hint source URL is not on the blocklist, rather than assuming the fetcher already filtered it', async () => {
    const { BLOCKED_HOSTS } = await import('../fetcher/blocklist.js');
    const assist = createAiAssist(
      { anthropicApiKey: 'sk-test' },
      { client: { complete: vi.fn(async () => '{"records":[]}') } },
    );
    for (const host of BLOCKED_HOSTS) {
      await expect(
        assist.parseAssist('<html></html>', {
          sourceId: 'x',
          sourceUrl: `https://${host}/page`,
          expectedFields: [],
        }),
      ).rejects.toThrow();
    }
  });
});

describe('the assist is never on a read path', () => {
  it('is not imported anywhere under api/', async () => {
    const apiDir = path.join(SERVER_SRC, 'api');
    const files = await readdir(apiDir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const src = await readFile(path.join(apiDir, file), 'utf8');
      expect(src, `${file} must not import the AI assist`).not.toMatch(/ai\/assist/);
    }
  });

  it('is imported only by crawl/ and review/', async () => {
    const dirs = await readdir(SERVER_SRC, { recursive: true, withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      // Node 20.11.0's Dirent has no `.parentPath` (added in later 20.x); `.path` is the
      // documented fallback (see progress.md — Tasks 6 and 17 hit the same gap).
      const full = path.join((entry as { parentPath?: string; path?: string }).parentPath ?? entry.path ?? SERVER_SRC, entry.name);
      if (full.includes(`${path.sep}ai${path.sep}`)) continue;
      const src = await readFile(full, 'utf8');
      if (!/ai\/assist/.test(src)) continue;
      expect(
        full.includes(`${path.sep}crawl${path.sep}`) || full.includes(`${path.sep}review${path.sep}`),
        `${full} must not import the AI assist`,
      ).toBe(true);
    }
  });
});
