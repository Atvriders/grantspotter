/**
 * THE SEED VALIDATION HARNESS — its rejection proofs.
 *
 * `seed.test.ts` proves the corpus we shipped is well formed. This file proves the harness
 * REFUSES the corpus we must never ship. Those are different claims, and only the second one
 * protects the batches Tasks 12-16 add after this task is finished.
 *
 * Every case below is a defect this codebase has already had to remove from live data:
 *
 *   - a two-state obligation      148 records asserting "no cost share required" where no funder
 *                                 said so in words (`obligation-evidence`)
 *   - a projected date badged as  3 of the 143 records in `data/seed/` declare a window their
 *     funder-published            funder published; the rest are projections, and a projection
 *                                 presented as a published date is the confident-wrong-date
 *                                 failure (`dates-basis-consistency`)
 *   - a deadline with no zone     a deadline is a 23:59 LOCAL wall time; without an IANA zone the
 *                                 UTC instant is off by hours and can be off by a day
 *                                 (`dates-basis-consistency`, via parseRecurrence)
 *   - an invented status          `unknown | open | contact_only | no_application | closed |
 *                                 discontinued | dormant` is the whole vocabulary (`schema`)
 *   - `open` over a closed portal 116 programmes badged open against a page that said twice
 *                                 "The 2026 Scholarship Cycle is now closed." (`status-contradiction`)
 *   - a link to a hijacked domain 345 awards advertised the wrong "apply here"; farweb.org now
 *                                 301s to a gambling site (`blocked-host`, `blocked-host-in-prose`)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Program } from '@grantspotter/core';
import { makeFunder, makeProgram } from '../exports/testFixtures.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
// `seedDir` resolves the real `data/seed/`, which is the corpus the harness's rarity figure is a
// statement about. Recounting it here is the only thing that keeps that figure honest.
import { seedDir } from './load.js';
import {
  SAFETY_WARNING_TAG,
  SEED_FUNDER_PUBLISHED_RECORDS,
  SEED_RECORD_COUNT,
  publishableSeedPrograms,
  validateSeedFile,
  type SeedRuleId,
} from './validate.js';

/** One program record, as it appears inside a `data/seed/*.json` file. */
function record(program: Program, sideCar: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(program as unknown as Record<string, unknown>), dates: { basis: 'unpublished' }, ...sideCar };
}

function rulesFor(programs: Array<Record<string, unknown>>): SeedRuleId[] {
  return validateSeedFile('probe.json', { programs }).violations.map((v) => v.rule);
}

function messagesFor(programs: Array<Record<string, unknown>>): string {
  return validateSeedFile('probe.json', { programs })
    .violations.map((v) => `${v.rule}: ${v.message}`)
    .join('\n');
}

const PROJECTED_ARDC = {
  deadline: {
    kind: 'n_fixed_dates' as const,
    source: { kind: 'self' as const },
    note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | Four dates a year.',
  },
};

describe('a well-formed record passes', () => {
  it('accepts unstated obligations and an undeclared-date record', () => {
    expect(rulesFor([record(makeProgram())])).toEqual([]);
  });

  it('accepts a projected deadline that declares itself projected', () => {
    const ok = record(makeProgram(PROJECTED_ARDC), { dates: { basis: 'projected' } });
    expect(rulesFor([ok])).toEqual([]);
  });

  it('accepts a funder-published window that carries the observed marker', () => {
    const ok = record(
      makeProgram({
        deadline: {
          kind: 'annual_window',
          source: { kind: 'self' },
          note: 'A single annual window. Application window published by the funder: opens 2025-10-01, closes 2025-10-31.',
        },
        trust: { ...makeProgram().trust, status: 'closed' },
      }),
      { dates: { basis: 'funder_published' } },
    );
    expect(rulesFor([ok])).toEqual([]);
  });

  it('returns the parsed programs and funders when everything is clean', () => {
    const result = validateSeedFile('probe.json', {
      funders: [makeFunder()],
      programs: [record(makeProgram())],
    });
    expect(result.violations).toEqual([]);
    expect(result.funders).toHaveLength(1);
    expect(result.programs).toHaveLength(1);
    expect(result.sideCars.get('ardc-grants')?.dates.basis).toBe('unpublished');
  });
});

describe('three-state obligations', () => {
  it('REJECTS costShareRequired: false with no evidence — absence is unstated, false is a claim', () => {
    const bad = record(makeProgram({ obligations: { costShareRequired: false } }));
    expect(rulesFor([bad])).toEqual(['obligation-evidence']);
    expect(messagesFor([bad])).toContain('absent means UNSTATED');
  });

  it('REJECTS the two-key boilerplate that shipped on 148 records', () => {
    const bad = record(
      makeProgram({ obligations: { costShareRequired: false, coFunderPreference: false } }),
    );
    expect(rulesFor([bad])).toEqual(['obligation-evidence', 'obligation-evidence']);
  });

  it('REJECTS an unevidenced true just as firmly as an unevidenced false', () => {
    expect(rulesFor([record(makeProgram({ obligations: { costShareRequired: true } }))])).toEqual([
      'obligation-evidence',
    ]);
  });

  it('ACCEPTS a stated false when the funder is quoted — a real answer worth publishing', () => {
    const ok = record(makeProgram({ obligations: { costShareRequired: false } }), {
      evidence: {
        obligations: {
          costShareRequired: {
            quote: 'No matching funds or cost sharing of any kind is required of applicants.',
            sourceUrl: 'https://www.example.org/apply',
          },
        },
      },
    });
    expect(rulesFor([ok])).toEqual([]);
  });

  it('REJECTS evidence whose quote is empty or whose URL is on a blocked host', () => {
    const blank = record(makeProgram({ obligations: { indirectCostCapPct: 20 } }), {
      evidence: { obligations: { indirectCostCapPct: { quote: '   ', sourceUrl: 'https://www.example.org/a' } } },
    });
    expect(rulesFor([blank])).toEqual(['obligation-evidence']);

    const blocked = record(makeProgram({ obligations: { indirectCostCapPct: 20 } }), {
      evidence: { obligations: { indirectCostCapPct: { quote: 'up to 20% for indirect costs', sourceUrl: 'https://grantwatch.com/x' } } },
    });
    expect(rulesFor([blocked])).toEqual(['blocked-host']);
  });

  it('REJECTS evidence for an obligation the record does not state', () => {
    const bad = record(makeProgram(), {
      evidence: { obligations: { costShareRequired: { quote: 'q', sourceUrl: 'https://www.example.org/a' } } },
    });
    expect(rulesFor([bad])).toEqual(['obligation-evidence']);
  });
});

describe('projected versus funder-published dates', () => {
  it('REJECTS a projection that claims to be funder-published', () => {
    const bad = record(makeProgram(PROJECTED_ARDC), { dates: { basis: 'funder_published' } });
    expect(rulesFor([bad])).toEqual(['dates-basis-consistency']);
    expect(messagesFor([bad])).toContain('not a date the funder printed');
  });

  it('REJECTS a funder-published claim with no window in the note at all', () => {
    const bad = record(
      makeProgram({
        deadline: { kind: 'annual_window', source: { kind: 'self' }, note: 'An annual window.' },
      }),
      { dates: { basis: 'funder_published' } },
    );
    expect(rulesFor([bad])).toEqual(['dates-basis-consistency']);
    expect(messagesFor([bad])).toContain('no window this funder published');
  });

  it('REJECTS a funder-published window that declares itself projected', () => {
    const bad = record(
      makeProgram({
        deadline: {
          kind: 'annual_window',
          source: { kind: 'self' },
          note: 'Window published by the funder: opens 2025-10-01, closes 2025-10-31.',
        },
      }),
      { dates: { basis: 'projected' } },
    );
    expect(rulesFor([bad])).toEqual(['dates-basis-consistency']);
  });

  it('REJECTS a record that declares no basis at all', () => {
    const bad = { ...(makeProgram() as unknown as Record<string, unknown>) };
    expect(rulesFor([bad])).toEqual(['dates-basis']);
  });

  it('REJECTS a basis nobody defined', () => {
    const bad = record(makeProgram(), { dates: { basis: 'estimated' } });
    expect(rulesFor([bad])).toEqual(['dates-basis']);
  });

  it('REJECTS a concrete date printed by a record that declares none', () => {
    const bad = record(
      makeProgram({
        deadline: { kind: 'unpublished', source: { kind: 'self' }, note: 'Applications close March 1, 2027.' },
      }),
    );
    expect(rulesFor([bad])).toEqual(['undeclared-date']);
  });

  it('REJECTS a RECUR directive whose kind disagrees with the DeadlineKind', () => {
    // `noteFor` in normalize/deadline.ts drops a mismatched directive and `expandCycles`
    // projects nothing, so the calendar empties in silence.
    const bad = record(
      makeProgram({
        deadline: {
          kind: 'annual_window',
          source: { kind: 'self' },
          note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01 | Mismatched.',
        },
      }),
      { dates: { basis: 'projected' } },
    );
    expect(rulesFor([bad])).toEqual(['dates-basis-consistency']);
    expect(messagesFor([bad])).toContain('projects nothing');
  });

  it('REJECTS an inherited deadline that also declares its own basis as projected', () => {
    const bad = record(
      makeProgram({
        deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'x' }, note: '' },
      }),
      { dates: { basis: 'projected' } },
    );
    expect(rulesFor([bad])).toEqual(['dates-basis-consistency']);
  });
});

describe('timezone', () => {
  it('REJECTS a projected deadline with no IANA zone', () => {
    const bad = record(
      makeProgram({
        deadline: {
          kind: 'n_fixed_dates',
          source: { kind: 'self' },
          note: 'RECUR n_fixed_dates dates=02-01,04-01 | Four dates a year.',
        },
      }),
      { dates: { basis: 'projected' } },
    );
    expect(rulesFor([bad])).toEqual(['dates-basis-consistency']);
    expect(messagesFor([bad])).toContain('tz=<IANA zone>');
  });

  it('REJECTS a zone that is not an IANA zone', () => {
    const bad = record(
      makeProgram({
        deadline: {
          kind: 'n_fixed_dates',
          source: { kind: 'self' },
          note: 'RECUR n_fixed_dates tz=EST dates=02-01 | Four dates a year.',
        },
      }),
      { dates: { basis: 'projected' } },
    );
    expect(rulesFor([bad])).toEqual(['dates-basis-consistency']);
  });

  it('REJECTS a UTC instant written into deadline prose', () => {
    // 2027-03-01T04:59Z IS the funder's 28 February in America/New_York. A record that prints
    // the instant has already lost the day.
    const bad = record(
      makeProgram({
        deadline: { kind: 'unpublished', source: { kind: 'self' }, note: 'Closes 2027-03-01T04:59Z.' },
      }),
    );
    expect(rulesFor([bad])).toContain('utc-instant-in-prose');
  });
});

describe('status is a seven-value vocabulary, not a binary', () => {
  it('REJECTS an invented status at the schema boundary, naming the field path', () => {
    const bad = record(makeProgram());
    (bad.trust as Record<string, unknown>).status = 'accepting';
    const { violations } = validateSeedFile('probe.json', { programs: [bad] });
    expect(violations.map((v) => v.rule)).toEqual(['schema']);
    expect(violations[0].message).toContain('trust.status');
  });

  it.each(['unknown', 'open', 'contact_only', 'no_application', 'closed', 'discontinued', 'dormant'])(
    'accepts the real status %s',
    (status) => {
      const program = makeProgram({
        trust: { ...makeProgram().trust, status: status as Program['trust']['status'] },
        applyVia: 'none',
        applyUrl: undefined,
      });
      expect(rulesFor([record({ ...program, applyUrl: undefined })])).toEqual([]);
    },
  );

  it('REJECTS open badged over a page that says the cycle is closed', () => {
    const bad = record(
      makeProgram({
        rawOtherText: 'The page states: The 2026 Scholarship Cycle is now closed.',
      }),
    );
    expect(rulesFor([bad])).toEqual(['status-contradiction']);
  });

  it('REJECTS open on a deadline kind that asserts there is no cycle', () => {
    const bad = record(
      makeProgram({
        deadline: { kind: 'no_application_exists', source: { kind: 'self' }, note: 'Recipients are selected internally.' },
      }),
    );
    expect(rulesFor([bad])).toEqual(['status-contradiction']);
  });

  it('REJECTS a discontinued record that still offers somewhere to apply', () => {
    const bad = record(
      makeProgram({
        trust: { ...makeProgram().trust, status: 'discontinued' },
        applyVia: 'page_form',
        applyUrl: 'https://www.example.org/apply',
      }),
    );
    expect(rulesFor([bad])).toEqual(['terminal-has-application']);
  });
});

describe('suppression has exactly one spelling', () => {
  it('accepts the canonical tag and keeps the record out of the publishable set', () => {
    const suppressed = makeProgram({ id: 'past-award', tags: ['ham', DO_NOT_PUBLISH_TAG] });
    expect(rulesFor([record(suppressed)])).toEqual([]);
    expect(publishableSeedPrograms([makeProgram(), suppressed]).map((p) => p.id)).toEqual([
      'ardc-grants',
    ]);
  });

  it.each(['dnp', 'hidden', 'suppressed', 'internal', 'do-not-publish', 'donotpublish', 'private'])(
    'REJECTS the look-alike suppression tag %s',
    (tag) => {
      expect(rulesFor([record(makeProgram({ tags: ['ham', tag] }))])).toEqual(['suppression-tag']);
    },
  );
});

describe('a record that warns rather than offers', () => {
  const warning = (over: Partial<Program> = {}): Program =>
    makeProgram({
      id: 'far-domain-compromised',
      name: 'Foundation for Amateur Radio (FAR) — domain compromised',
      summary: 'farweb.org now redirects to an Indonesian gambling site. Do not apply there.',
      amount: { instrument: 'unknown', amountRaw: 'Not applicable.', awardCountRaw: 'Not applicable.' },
      applyVia: 'none',
      applyUrl: undefined,
      trust: { ...makeProgram().trust, status: 'discontinued' },
      tags: ['ham', SAFETY_WARNING_TAG],
      ...over,
    });

  it('accepts a warning record that names the hijacked domain in prose only', () => {
    expect(rulesFor([record(warning())])).toEqual([]);
  });

  it('REJECTS a blocked host named in prose by a record that is not a warning', () => {
    expect(rulesFor([record(warning({ tags: ['ham'] }))])).toEqual(['blocked-host-in-prose']);
  });

  it('REJECTS a blocked host in any URL field, warning record or not', () => {
    const bad = record(warning({ applyVia: 'page_form', applyUrl: 'https://farweb.org/scholarships' }));
    expect(rulesFor([bad])).toEqual([
      'terminal-has-application',
      'blocked-host',
      'safety-warning-shape',
    ]);
  });

  it('REJECTS a warning record that reads as an opportunity', () => {
    const bad = record(
      warning({
        amount: { instrument: 'cash_fixed', amountMin: 5000, amountMax: 5000, amountRaw: '$5,000', awardCountRaw: '1' },
      }),
    );
    expect(rulesFor([bad])).toEqual(['safety-warning-shape']);
  });

  it('REJECTS a warning record that is still badged open', () => {
    const bad = record(warning({ trust: { ...makeProgram().trust, status: 'open' } }));
    expect(rulesFor([bad])).toEqual(['safety-warning-shape']);
  });
});

describe('the rules that catch a record nobody typed on purpose', () => {
  it('REJECTS a top-level key zod would silently strip', () => {
    const bad = record(makeProgram(), { costSharedRequired: false });
    expect(rulesFor([bad])).toEqual(['unknown-key']);
    expect(messagesFor([bad])).toContain('costSharedRequired');
  });

  it('REJECTS an unknown key inside the file itself', () => {
    const { violations } = validateSeedFile('probe.json', { programmes: [] });
    expect(violations.map((v) => v.rule)).toEqual(['schema']);
  });

  it('REJECTS a precomputed content hash', () => {
    const bad = record(makeProgram({ trust: { ...makeProgram().trust, contentHash: 'a'.repeat(64) } }));
    expect(rulesFor([bad])).toEqual(['content-hash-placeholder']);
  });

  it('REJECTS a verification stamp that is not this research pass', () => {
    const wrongDate = record(makeProgram({ trust: { ...makeProgram().trust, lastVerifiedAt: '2026-01-01' } }));
    expect(rulesFor([wrongDate])).toEqual(['verification-stamp']);
    const wrongMethod = record(
      makeProgram({ trust: { ...makeProgram().trust, verificationMethod: 'live_fetch' } }),
    );
    expect(rulesFor([wrongMethod])).toEqual(['verification-stamp']);
  });

  it('REJECTS a page dump in place of a summary', () => {
    expect(rulesFor([record(makeProgram({ summary: 'x'.repeat(601) }))])).toEqual(['summary-excerpt']);
    expect(rulesFor([record(makeProgram({ summary: '' }))])).toEqual(['summary-excerpt']);
  });

  it('REJECTS a constraint with no quoted source text', () => {
    const bad = record(
      makeProgram({
        constraints: [{ id: 'c', hard: true, fallbackRank: 0, rawText: '  ', spec: { axis: 'other', note: 'n' } }],
      }),
    );
    expect(rulesFor([bad])).toEqual(['constraint-shape']);
  });

  it.each([
    // These fixtures must keep the SHAPE the patterns match — a 192.168 address, a real
    // /home/<name>/ path — while naming no machine and no account that exists. They are the
    // inputs to the rule that keeps host detail out of a public repository, and this file
    // ships in that same public repository: a fixture quoting a real LAN address or a real
    // home directory would be the exact leak the rule exists to stop, committed by the test
    // that proves the rule works.
    ['a private LAN address', 'The club runs a server at 192.168.0.1.'],
    ['a loopback address', 'Reachable on 127.0.0.1 only.'],
    ['a carrier-grade private range', 'Behind 172.16.4.9.'],
    ['a host filesystem path', 'Captured to /home/operator/grantspotter/fixtures.'],
  ])('REJECTS %s', (_label, text) => {
    expect(rulesFor([record(makeProgram({ rawOtherText: text }))])).toEqual(['private-host-detail']);
  });
});

describe('funder records', () => {
  it('REJECTS a funder homepage that is not an absolute http(s) URL', () => {
    const { violations } = validateSeedFile('probe.json', {
      funders: [makeFunder({ homepage: 'javascript:alert(1)' })],
    });
    expect(violations.map((v) => v.rule)).toEqual(['funder-homepage']);
  });

  it('REJECTS a funder homepage on a blocked host', () => {
    const { violations } = validateSeedFile('probe.json', {
      funders: [makeFunder({ id: 'far', homepage: 'http://www.farweb.org/' })],
    });
    expect(violations.map((v) => v.rule)).toEqual(['blocked-host']);
  });

  it('REJECTS an unknown key on a funder', () => {
    const { violations } = validateSeedFile('probe.json', {
      funders: [{ ...makeFunder(), website: 'https://www.example.org/' }],
    });
    expect(violations.map((v) => v.rule)).toEqual(['unknown-key']);
  });
});

/**
 * THE FIGURE IN THE MESSAGE IS RECOUNTED FROM THE CORPUS IT DESCRIBES.
 *
 * Two of this validator's messages quote how rare `funder_published` is, because a seed author
 * about to badge a projection as a published window is exactly the reader who needs to know it is
 * a claim almost nothing in the corpus makes. They used to quote "4 of 244 cycles". That was
 * never a fact about `data/seed/` — it came from the fixture corpus — and it was committed
 * alongside a "4 of 243" that contradicted it, in seven other places, with nothing anywhere able
 * to notice. Nine sites, three totals, no test.
 *
 * So the number lives in one constant and this recomputes it from the files. If a batch lands, or
 * a record changes basis, this fails and NAMES the new figures rather than leaving the harness
 * quietly telling authors something untrue. A cycle count could not be pinned this way at all:
 * it depends on the day it is taken, which is the deeper reason no user-facing string quotes one.
 */
describe('the rarity figure the harness quotes', () => {
  function declaredBases(): string[] {
    const dir = seedDir();
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const programs = (parsed as { programs?: Array<{ dates?: { basis?: string } }> }).programs;
        return (programs ?? []).map((p) => p.dates?.basis ?? '(none)');
      });
  }

  it('matches what data/seed actually declares, and says so when it stops matching', () => {
    const bases = declaredBases();
    const published = bases.filter((b) => b === 'funder_published').length;
    expect(
      { records: bases.length, funderPublished: published },
      'data/seed changed: update SEED_RECORD_COUNT / SEED_FUNDER_PUBLISHED_RECORDS in validate.ts ' +
        'to these values, so the two harness messages keep telling seed authors the truth',
    ).toEqual({ records: SEED_RECORD_COUNT, funderPublished: SEED_FUNDER_PUBLISHED_RECORDS });
  });

  it('prints those figures in both messages an author can actually hit', () => {
    const phrase = `${String(SEED_FUNDER_PUBLISHED_RECORDS)} of the ${String(SEED_RECORD_COUNT)} records in data/seed/`;

    // A projection badged funder_published.
    const badged = record(makeProgram(PROJECTED_ARDC), { dates: { basis: 'funder_published' } });
    expect(messagesFor([badged])).toContain(phrase);

    // A record with no basis declared at all.
    const undeclared = { ...(makeProgram() as unknown as Record<string, unknown>) };
    expect(messagesFor([undeclared])).toContain(phrase);
  });

  it('quotes RECORDS, never cycles — a cycle count is a fact about the day it was taken', () => {
    const badged = record(makeProgram(PROJECTED_ARDC), { dates: { basis: 'funder_published' } });
    const undeclared = { ...(makeProgram() as unknown as Record<string, unknown>) };
    const text = `${messagesFor([badged])}\n${messagesFor([undeclared])}`;
    expect(text).not.toMatch(/\d+\s+(?:of\s+[^.]{0,40}?)?cycles/i);
  });
});
