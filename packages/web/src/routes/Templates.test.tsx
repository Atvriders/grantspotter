// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditA11y } from '../test/a11y.js';
import { TemplatesRoute, TemplatesScreen } from './Templates.js';

const LIST = {
  components: [
    { id: 'need-statement', title: 'Need statement', layer: 'component', order: 10, appliesTo: ['ham_grant'], lengthTarget: '200-300 words', requires: [], programIds: [], alwaysAvailable: false, sources: [], slots: ['club.name'] },
    { id: 'budget-justification', title: 'Budget and justification', layer: 'component', order: 50, appliesTo: ['ham_grant'], lengthTarget: '200-400 words', requires: [], programIds: [], alwaysAvailable: false, sources: [], slots: [] },
  ],
  overlays: [
    { id: 'funder-ardc', title: 'ARDC Grants Program — funder overlay', layer: 'funder', order: 10, appliesTo: ['ham_grant'], requires: ['need-statement'], programIds: ['ardc-grants'], alwaysAvailable: false, sources: [{ label: 'ARDC apply page', url: 'https://www.ardc.net/apply/' }], slots: [] },
  ],
  playbooks: [
    { id: 'funder-campus-sga', title: 'Campus student government playbook', layer: 'funder', order: 80, appliesTo: [], requires: [], programIds: [], alwaysAvailable: true, sources: [{ label: 'FSU SGA', url: 'https://sga.fsu.edu/accounting/funding-your-rso' }], slots: [] },
  ],
};

const DETAIL = { ...LIST.components[0], body: '## What this section has to do\n\n{{club.name}} needs it.' };

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    const payload = url.includes('/api/templates/need-statement') ? DETAIL : LIST;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

/** Plan 1's error envelope, which is the only thing the server ever sends on a failure (R6). */
function envelope(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message }, requestId: 'req-test' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TemplatesRoute', () => {
  it('renders components, funder overlays and always-available playbooks in separate groups', async () => {
    stubFetch();
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    await waitFor(() => expect(screen.getByText('Need statement')).toBeTruthy());
    expect(screen.getByText('ARDC Grants Program — funder overlay')).toBeTruthy();
    expect(screen.getByText('Campus student government playbook')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /funder overlays/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /always available/i })).toBeTruthy();
  });

  it('shows the cited source link for every funder overlay', async () => {
    stubFetch();
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    const link = await screen.findByRole('link', { name: 'ARDC apply page' });
    expect(link.getAttribute('href')).toBe('https://www.ardc.net/apply/');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('loads a template body when one is selected', async () => {
    stubFetch();
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    const button = await screen.findByRole('button', { name: /Need statement/ });
    button.click();
    await waitFor(() => expect(screen.getByText(/What this section has to do/)).toBeTruthy());
  });

  it('reports a failure instead of rendering an empty library', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not load/i));
  });

  /**
   * THE 404/500 DISTINCTION THE ROUTER WAS BUILT TO PRESERVE, CARRIED THROUGH TO WORDS.
   *
   * `getTemplate` loads the WHOLE library to answer for one id, so `catch { 404 }` made a single
   * malformed file on disk report as "no such template" for every id in the corpus. Task 17
   * narrowed it server-side; a client that renders both statuses with one sentence throws the
   * distinction away again one layer up, and the person who could fix the broken file is told
   * they asked for something that does not exist.
   */
  it('says a template is BROKEN when the server 500s, and does not blame the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      return url.includes('/api/templates/need-statement')
        ? envelope('internal', 'Something went wrong.', 500)
        : new Response(JSON.stringify(LIST), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    (await screen.findByRole('button', { name: /Need statement/ })).click();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/will not load/i);
    expect(alert.textContent).not.toMatch(/no template with that id|does not exist/i);
  });

  it('says a template is UNKNOWN when the server 404s, and does not call it broken', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      return url.includes('/api/templates/need-statement')
        ? envelope('not_found', 'No template with id "need-statement".', 404)
        : new Response(JSON.stringify(LIST), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    (await screen.findByRole('button', { name: /Need statement/ })).click();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/no template with that id/i);
    expect(alert.textContent).not.toMatch(/will not load|broken/i);
  });

  it('keeps the rest of the library on screen when one template fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      return url.includes('/api/templates/need-statement')
        ? envelope('internal', 'Something went wrong.', 500)
        : new Response(JSON.stringify(LIST), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    (await screen.findByRole('button', { name: /Need statement/ })).click();
    await screen.findByRole('alert');
    expect(screen.getByText('Budget and justification')).toBeTruthy();
    expect(screen.getByText('Campus student government playbook')).toBeTruthy();
  });

  /**
   * A quoted `alwaysAvailable: "true"` once read as `false` and hid this playbook entirely. The
   * loader now throws on it, but the screen is where the loss would have been visible, so it is
   * also where it is pinned: the playbook group is bound to `playbooks`, never to whether the
   * chosen programme matched an overlay.
   */
  it('reaches the always-available playbook even when no overlay matches the programme', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ...LIST, overlays: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));
    render(<TemplatesRoute programId="no-such-program" klass="ham_grant" />);
    await waitFor(() => expect(screen.getByText('Campus student government playbook')).toBeTruthy());
    // Empty is stated, never implied by a blank space.
    expect(screen.getByText(/No overlay has been written for this funder yet/i)).toBeTruthy();
  });

  /** The screen must not assert anything about a funder. Only the template's own text may. */
  it('renders the template body verbatim and adds no prose of its own around it', async () => {
    stubFetch();
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    (await screen.findByRole('button', { name: /Need statement/ })).click();
    const body = await screen.findByText(/What this section has to do/);
    expect(body.textContent).toBe(DETAIL.body);
  });

  it('passes the accessibility audit the other nine routes run through', async () => {
    stubFetch();
    const { container } = render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    await screen.findByRole('button', { name: /Need statement/ });
    expect(auditA11y(container)).toEqual([]);
  });
});

describe('TemplatesScreen', () => {
  it('carries programId and klass from the query string into the request', async () => {
    stubFetch();
    render(
      <MemoryRouter initialEntries={['/templates?programId=ardc-grants&klass=ham_grant']}>
        <TemplatesScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Need statement')).toBeTruthy());
    const called = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.startsWith('/api/templates?'));
    expect(called).toContain('programId=ardc-grants');
    expect(called).toContain('klass=ham_grant');
  });

  it('carries funderId too, which is what pre-selects this funder’s overlay', async () => {
    stubFetch();
    render(
      <MemoryRouter initialEntries={['/templates?programId=ardc-grants&funderId=ardc&klass=ham_grant']}>
        <TemplatesScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Need statement')).toBeTruthy());
    const called = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.startsWith('/api/templates?'));
    expect(called).toContain('funderId=ardc');
  });
});

/**
 * THE RAIL AND THE ROUTER, CHECKED AGAINST EACH OTHER FROM SOURCE.
 *
 * The brief's own reason for Step 6 is that a route nothing links to is dead. The inverse is
 * just as dead and quieter: a rail entry whose path has no `<Route>` renders GrantSpotter's
 * "No GrantSpotter screen answers to that address" — a working link to a wrong-address page,
 * which no component test of either file can see, because neither file is wrong on its own.
 *
 * `/applications` was in PENDING because Task 19 creates `routes/Applications.tsx`; App.tsx could
 * not import it before it existed. PENDING is self-cleaning: a path that IS routed fails the
 * second assertion, so when Task 19 added the route this test said so and the entry was removed.
 * The list is empty and should stay that way — an exemption is a debt, not a category.
 */
const PENDING_ROUTES: readonly string[] = [];

describe('every rail entry has a route', () => {
  /**
   * Block comments are stripped before matching, and that is not tidiness. App.tsx documents the
   * line Task 19 has to add by printing it inside a JSX comment, and a scanner that reads
   * commented-out code as shipped code reports the exact opposite of the truth: it called
   * `/applications` routed while the rail link led to NotFound. It did, on the first run.
   */
  const src = (rel: string): string =>
    readFileSync(path.resolve(import.meta.dirname, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  const navPaths = (): string[] =>
    [...src('../components/AppShell.tsx').matchAll(/\{\s*to:\s*'([^']+)'/g)].map((m) => m[1] as string);

  const routedPaths = (): string[] =>
    [...src('../App.tsx').matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1] as string);

  it('routes every path the rail links to', () => {
    const routed = new Set(routedPaths());
    const missing = navPaths().filter((p) => !routed.has(p) && !PENDING_ROUTES.includes(p));
    expect(missing).toEqual([]);
  });

  it('holds nothing stale in PENDING_ROUTES', () => {
    const routed = new Set(routedPaths());
    const nowRouted = PENDING_ROUTES.filter((p) => routed.has(p));
    // Remove it from PENDING_ROUTES above; the first assertion covers it from here on.
    expect(nowRouted).toEqual([]);
  });

  it('still links to the Templates screen this task added', () => {
    expect(navPaths()).toContain('/templates');
    expect(routedPaths()).toContain('/templates');
  });
});
