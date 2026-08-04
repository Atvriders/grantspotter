import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WritingApiError,
  extractFacts,
  fetchActiveProfile,
  fetchTemplate,
  isNotFound,
  listTemplates,
  patchApplication,
  putFactConfirmations,
} from './writing.js';

function stub(response: () => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => response());
  vi.stubGlobal('fetch', mock);
  return mock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Plan 1's single error envelope (R6). Reading `.error` as a string renders "[object Object]". */
function envelope(code: string, message: string, status: number): Response {
  return json({ error: { code, message }, requestId: 'req-1' }, status);
}

const lastCall = (mock: ReturnType<typeof vi.fn>): [string, RequestInit] =>
  mock.mock.calls[mock.mock.calls.length - 1] as unknown as [string, RequestInit];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listTemplates', () => {
  it('sends only the filters it was given', async () => {
    const mock = stub(() => json({ components: [], overlays: [], playbooks: [] }));
    await listTemplates({ programId: 'ardc-grants', klass: 'ham_grant' });
    const url = lastCall(mock)[0];
    expect(url).toContain('programId=ardc-grants');
    expect(url).toContain('klass=ham_grant');
    expect(url).not.toContain('funderId');
  });

  it('sends funderId, which is the other half of the overlay binding', async () => {
    const mock = stub(() => json({ components: [], overlays: [], playbooks: [] }));
    await listTemplates({ funderId: 'ardc' });
    expect(lastCall(mock)[0]).toBe('/api/templates?funderId=ardc');
  });

  it('asks for no query string at all when nothing is filtered', async () => {
    const mock = stub(() => json({ components: [], overlays: [], playbooks: [] }));
    await listTemplates({});
    expect(lastCall(mock)[0]).toBe('/api/templates');
  });
});

/**
 * A BROKEN TEMPLATE AND AN UNKNOWN ID ARE DIFFERENT FAILURES, AND THE CLIENT KEEPS THEM APART.
 *
 * Task 17 proved the server distinction: one malformed file on disk makes a VALID id answer 500,
 * while an id nothing on disk claims answers 404. A client that flattens both into "something
 * went wrong" restores the exact defect the server-side narrowing removed — the library
 * disappears and the message blames the caller.
 */
describe('fetchTemplate failure modes', () => {
  it('raises a 404 as not_found', async () => {
    stub(() => envelope('not_found', 'No template with id "nope".', 404));
    const err = await fetchTemplate('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WritingApiError);
    expect((err as WritingApiError).code).toBe('not_found');
    expect((err as WritingApiError).status).toBe(404);
    expect(isNotFound(err)).toBe(true);
  });

  it('raises a 500 as internal and never as not_found', async () => {
    stub(() => envelope('internal', 'Something went wrong on our end.', 500));
    const err = await fetchTemplate('need-statement').catch((e: unknown) => e);
    expect((err as WritingApiError).code).toBe('internal');
    expect((err as WritingApiError).status).toBe(500);
    expect(isNotFound(err)).toBe(false);
  });

  it('carries a readable message even when the failure body is not JSON at all', async () => {
    stub(() => new Response('<html>gateway</html>', { status: 500 }));
    const err = await fetchTemplate('need-statement').catch((e: unknown) => e);
    expect((err as WritingApiError).message).not.toBe('');
    expect(isNotFound(err)).toBe(false);
  });

  it('percent-encodes the id rather than splicing it into the path', async () => {
    const mock = stub(() => json({}));
    await fetchTemplate('a/b c');
    expect(lastCall(mock)[0]).toBe('/api/templates/a%2Fb%20c');
  });
});

/**
 * WITHOUT THE CONTEXT EVERY CHECKLIST ITEM READS `unattributed`.
 *
 * `POST /api/prose/facts` accepts profile / program / funder / answers and builds the checklist's
 * `sources` from them. A client that posts only `{ text }` still gets a full checklist back — it
 * just loses the origin distinction, silently, which is the property that makes the list
 * reviewable rather than a wall of identical checkboxes.
 */
describe('extractFacts', () => {
  it('posts the attribution context alongside the text', async () => {
    const mock = stub(() => json({ items: [] }));
    await extractFacts({
      text: 'W8UM has 42 members.',
      profile: { kind: 'organization' },
      program: { id: 'ardc-grants' },
      answers: { 'club.city': 'Ann Arbor' },
    });
    const body = JSON.parse(String(lastCall(mock)[1].body)) as Record<string, unknown>;
    expect(body.text).toBe('W8UM has 42 members.');
    expect(body.profile).toEqual({ kind: 'organization' });
    expect(body.program).toEqual({ id: 'ardc-grants' });
    expect(body.answers).toEqual({ 'club.city': 'Ann Arbor' });
  });
});

/**
 * A fact's id is `${kind}:${start}` — a POSITION — so editing `$1,450` to `$9,999` reuses it and
 * a stored `confirmed: true` lands on a number no human read. Task 14 fingerprints the value to
 * stop that and Task 16's zod schema accepts the field; a client that drops it on the way out
 * reinstates the defect with every test still green.
 */
describe('putFactConfirmations', () => {
  it('sends the fingerprint the item handed it', async () => {
    const mock = stub(() => json({ ready: false, unconfirmed: 1, openTodos: 0, items: [] }));
    await putFactConfirmations('app-1', {
      'amount:12': { confirmed: true, note: 'checked the award letter', fingerprint: 'abc123' },
    });
    const body = JSON.parse(String(lastCall(mock)[1].body)) as {
      confirmations: Record<string, { fingerprint?: string }>;
    };
    expect(body.confirmations['amount:12']?.fingerprint).toBe('abc123');
  });

  it('raises a 409 export gate as a conflict the caller can recognise', async () => {
    stub(() => envelope('conflict', 'This draft still has unconfirmed facts.', 409));
    const err = await putFactConfirmations('app-1', {}).catch((e: unknown) => e);
    expect((err as WritingApiError).code).toBe('conflict');
    expect((err as WritingApiError).status).toBe(409);
  });
});

describe('patchApplication', () => {
  it('uses PATCH, which is the only verb the drafts API accepts for an edit', async () => {
    const mock = stub(() => json({ id: 'app-1' }));
    await patchApplication('app-1', { title: 'Repeater project' });
    expect(lastCall(mock)[1].method).toBe('PATCH');
  });

  it('can detach a draft from its opportunity by sending programId: null', async () => {
    const mock = stub(() => json({ id: 'app-1' }));
    await patchApplication('app-1', { programId: null });
    expect(JSON.parse(String(lastCall(mock)[1].body))).toEqual({ programId: null });
  });
});

describe('fetchActiveProfile', () => {
  it('prefers the student profile, then the organization one', async () => {
    stub(() => json({ student: { kind: 'student' }, organization: { kind: 'organization' } }));
    expect(await fetchActiveProfile()).toEqual({ kind: 'student' });
  });

  it('returns undefined rather than null when the user has stated neither', async () => {
    stub(() => json({ student: null, organization: null }));
    expect(await fetchActiveProfile()).toBeUndefined();
  });
});
