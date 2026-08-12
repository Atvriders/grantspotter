import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerifyButton } from './VerifyButton.js';

/**
 * WHAT THE VERIFY BUTTON SAYS, WHICH NOTHING ASSERTED UNTIL 2026-08-12.
 *
 * `components/VerifyButton.tsx` had no test file. `responsive.test.ts` named it — for the CSS class
 * around its diff table — and `Opportunity.test.tsx` mentioned it in a comment. Not one assertion
 * anywhere in the repository read a single word this component prints, and it prints eight
 * distinct sentences, five of them refusals.
 *
 * That is the hole this round is about, and it is worth saying plainly what it cost: the two
 * rate-limit sentences were BOTH FALSE, in opposite directions, for as long as the component has
 * existed. See the block comment in `run()` for the measurement. This file asserts the words.
 *
 * THE FAKE IS THE WIRE, NOT THE MODULE. `fetch` is stubbed rather than `apiSend`, so the envelope
 * this component reads is parsed by the real `api/client.ts` — the same parser that decides
 * whether `details` survives to `ApiError.details` at all. Stubbing `apiSend` would let a test
 * hand the component a shape the wire cannot produce, which is the mistake that let "the API could
 * not be reached" be printed about a 200 elsewhere in this suite.
 */

function stubJson(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          json: () => Promise.resolve(body),
        }) as unknown as Promise<Response>,
    ),
  );
}

function rateLimited(reason: 'program_cooldown' | 'hourly_cap', retryAfterSec: number): void {
  stubJson(429, {
    error: {
      code: 'rate_limited',
      message: 'You have verified this recently. Small nonprofits host these pages.',
      details: { reason, retryAfterSec },
    },
    requestId: 'req-verify',
  });
}

async function press(): Promise<void> {
  render(<VerifyButton programId="prog-1" onVerified={() => undefined} />);
  await userEvent.click(screen.getByRole('button', { name: /verify now/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the wait a refusal quotes', () => {
  /**
   * The cooldown expires one hour after the attempt that set it, so a member who checked this
   * programme 59 minutes ago is 60 seconds away. The screen said "Try again in about an hour" —
   * sixty times the real wait, and an hour of a deadline they may be working against.
   */
  it('says sixty seconds when the server says sixty seconds, not "about an hour"', async () => {
    rateLimited('program_cooldown', 60);
    await press();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/try again in 60 seconds\./i);
    expect(alert.textContent ?? '').not.toMatch(/about an hour|hour/i);
  });

  /**
   * The other direction, and the one that is round one's defect verbatim: the hourly cap frees
   * when the oldest of ten attempts ages out of the window, so a member who spent all ten two
   * minutes ago waits fifty-eight. The screen said "Try again shortly."
   */
  it('says fifty-eight minutes when the server says 3,480 seconds, not "shortly"', async () => {
    rateLimited('hourly_cap', 3480);
    await press();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/try again in 58 minutes\./i);
    expect(alert.textContent ?? '').not.toMatch(/shortly/i);
  });

  /** Rounded UP, so the advice is never early and never sends anybody into a second refusal. */
  it('rounds a part-minute up rather than down', async () => {
    rateLimited('hourly_cap', 61);
    await press();
    expect(await screen.findByRole('alert')).toHaveTextContent(/try again in 2 minutes\./i);
  });

  /**
   * `retryAfterSecOf`'s second rule, and the reason it returns `null` rather than a default: a
   * refusal with no usable number says NOTHING about time. "Try again in NaN seconds" and an
   * invented "shortly" are the same defect.
   */
  it('says nothing at all about time when the server sent no usable number', async () => {
    stubJson(429, {
      error: { code: 'rate_limited', message: 'Too many checks.', details: { reason: 'hourly_cap' } },
      requestId: 'req-verify',
    });
    await press();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/hourly allowance/i);
    expect(alert.textContent ?? '').not.toMatch(/try again in|shortly|about an hour|a moment/i);
  });

  /** The two reasons are different events and must not collapse into one sentence. */
  it('tells a per-programme cooldown apart from a spent allowance', async () => {
    rateLimited('program_cooldown', 600);
    await press();
    const cooldown = await screen.findByRole('alert');
    expect(cooldown).toHaveTextContent(/already verified this programme recently/i);
    // The reason the cooldown exists at all, said to the person paying for it.
    expect(cooldown).toHaveTextContent(/small nonprofits and we poll them politely/i);
    vi.unstubAllGlobals();

    rateLimited('hourly_cap', 600);
    const second = render(<VerifyButton programId="prog-2" onVerified={() => undefined} />);
    await userEvent.click(second.getAllByRole('button', { name: /verify now/i })[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent(/hourly allowance/i);
    });
  });
});

describe('what a failure is allowed to blame', () => {
  /**
   * A rejected `fetch` never left the browser. Blaming the funder's server for it names a party
   * that was never contacted — the defect this component's own comment already forbids, now
   * asserted.
   */
  it('does not call the funder unreachable when the request never left this browser', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await press();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/grantspotter could not be reached/i);
    expect(alert).toHaveTextContent(/nothing was verified/i);
    expect(alert.textContent ?? '').not.toMatch(/the source|the funder|callook/i);
  });

  /**
   * The arm above was unreachable until 2026-08-12 — `apiSend` propagates a rejected `fetch` as a
   * raw `TypeError`, never as an `ApiError` with `status: 0`, so the transport sentence was dead
   * code and a server fault answered for it. This asserts the branch is chosen by the state and
   * not by a status code no producer emits.
   */
  it('tells a transport failure apart from a server that answered', async () => {
    stubJson(500, {
      error: { code: 'internal', message: 'Something went wrong.' },
      requestId: 'req-verify',
    });
    await press();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/grantspotter answered 500/i);
    expect(alert.textContent ?? '').not.toMatch(/could not be reached/i);
  });

  /**
   * `api/verifyRouter.ts` charges the attempt, fetches the funder's page, and then writes change
   * events, provenance and the programme — every write after the fetch. A 500 from any of them is
   * a state in which the page WAS re-read and the allowance WAS spent, so "Nothing was re-checked"
   * (this arm's sentence until 2026-08-12) is false in the direction that costs the reader most.
   */
  it('does not claim nothing was re-checked when the server faulted after fetching', async () => {
    stubJson(500, {
      error: { code: 'internal', message: 'Something went wrong.' },
      requestId: 'req-verify',
    });
    await press();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').not.toMatch(/nothing was re-?checked/i);
    expect(alert).toHaveTextContent(/not claiming either way/i);
  });

  /**
   * A 200 carrying `ok: false` is the FETCHER's report, not GrantSpotter's, and the record is
   * exactly as stale as it was. The panel must quote the reason rather than replace it, and must
   * not claim a refetch happened.
   */
  it('quotes the fetcher and claims no refetch when the fetch was refused', async () => {
    const onVerified = vi.fn();
    stubJson(200, {
      programId: 'prog-1',
      attemptedAt: '2026-08-12T00:00:00.000Z',
      ok: false,
      error: 'blocked host: example.invalid',
      changed: false,
      diffs: [],
      lastVerifiedAt: '2026-07-01T00:00:00.000Z',
      changeEventIds: [],
    });
    render(<VerifyButton programId="prog-1" onVerified={onVerified} />);
    await userEvent.click(screen.getByRole('button', { name: /verify now/i }));

    const panel = await screen.findByRole('region', { name: /verification result/i });
    expect(panel).toHaveTextContent(/nothing was refetched/i);
    expect(panel).toHaveTextContent(/exactly as fresh as it was before/i);
    expect(panel).toHaveTextContent(/blocked host: example\.invalid/);
    // The record did not move, so nothing may repaint as though it had.
    expect(onVerified).not.toHaveBeenCalled();
  });

  /** A refusal with no reason at all still may not render an empty quotation. */
  it('says the fetcher gave no reason rather than printing nothing', async () => {
    stubJson(200, {
      programId: 'prog-1',
      attemptedAt: '2026-08-12T00:00:00.000Z',
      ok: false,
      changed: false,
      diffs: [],
      lastVerifiedAt: '2026-07-01T00:00:00.000Z',
      changeEventIds: [],
    });
    await press();
    expect(await screen.findByRole('region', { name: /verification result/i })).toHaveTextContent(
      /the fetcher gave no reason/i,
    );
  });
});

describe('what a success is allowed to claim', () => {
  it('says the source still says the same thing, and reloads the record', async () => {
    const onVerified = vi.fn();
    stubJson(200, {
      programId: 'prog-1',
      attemptedAt: '2026-08-12T09:30:00.000Z',
      ok: true,
      changed: false,
      diffs: [],
      lastVerifiedAt: '2026-08-12T09:30:00.000Z',
      changeEventIds: [],
    });
    render(<VerifyButton programId="prog-1" onVerified={onVerified} />);
    await userEvent.click(screen.getByRole('button', { name: /verify now/i }));

    const panel = await screen.findByRole('region', { name: /verification result/i });
    expect(panel).toHaveTextContent(/the source still says the same thing/i);
    // WHEN it was checked, beside the claim that nothing moved — the claim is only worth anything
    // attached to an instant, and the instant is the server's, not this browser's clock.
    expect(panel).toHaveTextContent(/checked at/i);
    expect(panel).toHaveTextContent('2026-08-12T09:30:00.000Z');
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  /**
   * A field the funder did not state before is "Not stated", never a blank cell and never the
   * word `null` — which is what `before: null` is, and what an unguarded `{d.before}` would print.
   */
  it('names an absent side of the diff rather than leaving a hole in the table', async () => {
    stubJson(200, {
      programId: 'prog-1',
      attemptedAt: '2026-08-12T09:30:00.000Z',
      ok: true,
      changed: true,
      diffs: [{ label: 'Deadline', before: null, after: '2027-02-01' }],
      lastVerifiedAt: '2026-08-12T09:30:00.000Z',
      changeEventIds: ['ce-1'],
    });
    await press();

    const table = await screen.findByRole('table', { name: /what changed/i });
    expect(table).toHaveTextContent(/not stated/i);
    expect(table).toHaveTextContent('2027-02-01');
  });
});
