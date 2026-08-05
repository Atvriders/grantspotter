/**
 * THE NUMBER THE SERVER SENT, SAID OUT LOUD.
 *
 * `POST /api/auth/enroll` and `POST /api/auth/login` both attach `details.retryAfterSec` to a
 * `rate_limited` error, and until 2026-08-05 both screens parsed the envelope, kept the number, and
 * printed "Wait a minute and try again" regardless. A fifteen-minute pause and a one-second queue
 * read identically, and one of those sentences was simply false — the server had already answered
 * 900 and the screen said sixty.
 *
 * A refusal a person cannot plan around is a refusal they retry immediately, which is the one
 * behaviour every limiter on this route is trying to reduce. So: read the server's number, and if
 * it did not send one, say nothing about time at all rather than inventing a figure.
 *
 * It lives in `lib` and not in either screen because there are two of them and two copies of a rule
 * like this is how the second one goes stale — the same reason `passwordPolicy.ts` is here.
 */

/**
 * The server's `retryAfterSec`, or `null` for any body that did not carry a usable one.
 *
 * Deliberately strict: a non-finite, negative or absent value is `null` and the caller says nothing
 * about waiting, because "try again in NaN seconds" is worse than no advice.
 */
export function retryAfterSecOf(details: unknown): number | null {
  if (typeof details !== 'object' || details === null) return null;
  const raw = (details as { retryAfterSec?: unknown }).retryAfterSec;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.ceil(raw);
}

/**
 * `retryAfterSec` as a person would say it, rounded UP so the advice is never early.
 *
 * Rounding up matters more than precision here: a screen that says "try again in 14 minutes" for a
 * fourteen-and-a-half-minute wait sends somebody back to a second refusal, having told them the
 * truth. Under a minute is left in seconds because that is a wait people will actually sit through.
 */
export function humanRetryAfter(seconds: number): string {
  if (seconds <= 60) return seconds === 1 ? '1 second' : `${String(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? '1 hour' : `${String(hours)} hours`;
}
