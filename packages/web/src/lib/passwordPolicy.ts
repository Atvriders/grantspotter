/**
 * THE PASSWORD FLOOR, AS THE BROWSER STATES IT.
 *
 * Mirrors `MIN_PASSWORD_LENGTH` in `packages/server/src/auth/password.ts`, which is the source of
 * truth and the only thing that can actually refuse a password. Restated rather than imported
 * because the import direction is one-way — web may import from core, never from server — the same
 * reason `api/client.ts` restates the API error codes.
 *
 * It lives in one module because there are now two screens that create an account with a
 * password the user chooses: first-run setup and enrolment. Two copies of the number would be two
 * policies, and the second one is always the one that goes stale. The server-side test
 * `api/auth.test.ts` asserts the refusal message names this number, so a change there that the
 * browser missed shows up as a screen promising one rule and a server enforcing another.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Trimmed, because `assertPasswordPolicy` trims before it counts. Twelve spaces is not a password. */
export function meetsPasswordFloor(password: string): boolean {
  return password.trim().length >= MIN_PASSWORD_LENGTH;
}
