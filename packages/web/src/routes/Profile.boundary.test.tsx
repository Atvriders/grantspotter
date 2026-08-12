import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * THE ONE BOUNDARY PLACEMENT THAT SAVES THE APPLICANT'S TYPING, MEASURED ON THE REAL FORM.
 *
 * `components/ErrorBoundary.test.tsx` proves the component on a page shaped like this one, and
 * `describe('where App.tsx puts them')` in that file asserts the two placements `App.tsx` makes —
 * as SOURCE TEXT, which that file is honest about: it "cannot check that the boundary WORKS
 * there". Both of those were true on 2026-08-12 and the profile form still lost everything the
 * applicant had typed the moment `CallsignLookup` threw, because the third placement — a `panel`
 * boundary around the lookup inside `routes/Profile.tsx` — was handed off as "left open" and
 * nobody took it. The gate was green. That is the whole reason this file is a RENDER of the real
 * route and not another source-text guard: a guard that checks a wrapper is declared cannot tell
 * the difference between a wrapper that is there and a wrapper that is there and works, and the
 * defect it needed to catch was neither.
 *
 * WHY A SEPARATE FILE FROM `Profile.test.tsx`. `vi.mock` is hoisted to the top of the module and
 * applies to every test in it. `Profile.test.tsx` drives the real `CallsignLookup` through most of
 * its length; a module-level mock there would quietly replace the panel under thirty other tests.
 *
 * WHY THE PANEL IS MADE TO THROW BY MOCKING IT rather than by feeding the real one bad data: the
 * claim being measured is about WHERE the damage stops, not about which record breaks the lookup.
 * A throw from the panel's own render is the general case, and it is the case the boundary exists
 * for — the specific records that could produce one are `CallsignLookup.test.tsx`'s subject.
 *
 * WHAT THIS CANNOT SEE: jsdom renders no pixels, so nothing here says the fallback is legible or
 * that it does not push the form sideways. `styles/boundary.css` is checked statically by
 * `test/responsive.test.ts`.
 */
vi.mock('../components/CallsignLookup.js', () => ({
  CallsignLookup: (): JSX.Element => {
    throw new Error('the callsign panel could not read that record');
  },
}));

const { Profile } = await import('./Profile.js');

interface ProfilesBody {
  student: Record<string, unknown> | null;
  organization: Record<string, unknown> | null;
  completenessFor: string | null;
  completeness: { total: number; unknownCount: number; score: number; fields: unknown[] };
}

const REPORT = { total: 5, unknownCount: 2, score: 60, fields: [] };

const PROFILES: ProfilesBody = {
  student: { kind: 'student', callsign: 'W8UM', licenseClass: 'GENERAL', state: 'MI' },
  organization: null,
  completenessFor: 'student',
  completeness: REPORT,
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs every caught error itself, on top of the boundary's own report: nine screenfuls of
  // stack in the middle of a green run. Silenced here, and NOT asserted through — the boundary's
  // own reporting channel is `ErrorBoundary.test.tsx`'s subject.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        const sent = JSON.parse(String(init?.body)) as { kind: string };
        return Promise.resolve(
          jsonResponse({ profile: sent, completenessFor: sent.kind, completeness: REPORT }),
        );
      }
      return Promise.resolve(jsonResponse(PROFILES));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

async function renderProfile(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/profile']}>
      <Profile />
    </MemoryRouter>,
  );
  await screen.findByRole('meter', { name: /profile completeness/i });
}

describe('the profile form when the callsign panel throws', () => {
  /**
   * THE MEASUREMENT. A latitude is a number somebody read off a map or a GPS and typed in by hand;
   * it is the single most expensive value on this form to lose, and `CallsignLookup` sits three
   * elements away from it. Before the boundary was placed, this render produced a document with
   * ZERO inputs in it — React unmounts the whole tree up to the nearest boundary, and the nearest
   * one is `App.tsx`'s `scope="screen"`, which is outside the entire route.
   */
  it('keeps the form, and everything typed into it, on the page', async () => {
    await renderProfile();

    const lat = screen.getByLabelText(/^latitude/i);
    await userEvent.clear(lat);
    await userEvent.type(lat, '42.2808');
    const lon = screen.getByLabelText(/^longitude/i);
    await userEvent.clear(lon);
    await userEvent.type(lon, '-83.7430');

    // The panel has already thrown by now — it throws on its first render, which happened above.
    // So this is the state of the page AFTER the throw, not before it.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    // Numbers, not strings: these two are `<input type="number">` on the real form, and
    // `toHaveValue` reports a number for those. Asserted as what the control actually holds.
    expect(screen.getByLabelText(/^latitude/i)).toHaveValue(42.2808);
    expect(screen.getByLabelText(/^longitude/i)).toHaveValue(-83.743);
    expect(screen.getByLabelText(/callsign/i)).toBeInTheDocument();
    // The form's own controls are still usable: a boundary that leaves a read-only corpse of the
    // page behind is not a rescue.
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  /**
   * The fallback has to name the thing that broke, because a profile form has several panels on it
   * and "something went wrong" tells the applicant to distrust all of them. `region` is what
   * carries that name, so this is an assertion about the prop being passed and not only about the
   * boundary existing.
   */
  it('names the callsign lookup as the part that went, and says the rest still works', async () => {
    await renderProfile();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/callsign lookup/i);
    expect(alert).toHaveTextContent(/only this part of the page was removed/i);
    expect(alert).not.toHaveTextContent(/something went wrong/i);
  });

  /**
   * The scope, proved by its consequence rather than by reading the prop. A `screen` or `app`
   * boundary renders an `h1` and takes focus; a `panel` boundary renders an `h2`, keeps `role`
   * `alert`, and deliberately does NOT steal focus, because the applicant may be mid-word in a
   * field three inches away. Those are the differences `ErrorBoundary.tsx` actually branches on,
   * so they are what pins the placement to `panel`.
   */
  it('is a panel boundary and not a screen one, so focus stays where the applicant left it', async () => {
    await renderProfile();

    const lat = screen.getByLabelText(/^latitude/i);
    lat.focus();
    await screen.findByRole('alert');

    expect(document.activeElement).toBe(lat);
    // The route's own h1 is still the only h1 on the page: the fallback did not replace the screen.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /draw this panel again/i })).toBeInTheDocument();
  });
});
