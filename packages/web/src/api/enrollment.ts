import type { EnrollmentCode } from '@grantspotter/core';
import type { SessionUser } from '../store/session.js';
import { apiGet, apiSend } from './client.js';

/**
 * ENROLMENT, FROM THE BROWSER.
 *
 * The third way an account comes into existence. The first is `POST /api/auth/bootstrap` — one
 * administrator, one token, printed in the server log. The second is `POST /api/admin/users` — an
 * admin creates the account and reads the generated password out to its owner. This is the third:
 * somebody holding a code an admin issued creates their own account with it.
 *
 * `EnrollmentCode` is imported from core rather than restated here. The rule this repository
 * follows is that a type is restated in the browser ONLY when importing it would be illegal —
 * `AdminUserRow` in `routes/Admin.tsx` and the API error codes in `client.ts` live in
 * `packages/server`, and web may never import from server. Core is shared, `web → core` is the
 * allowed direction, and a second declaration of a type that already has a home is how the
 * browser's idea of a record drifts from the server's.
 */

/** One string, so the reader (`useApi`) and the writers below cannot disagree about the route. */
export const ENROLLMENT_CODES_PATH = '/api/admin/enrollment-codes';

export interface EnrollmentCodeListResponse {
  codes: EnrollmentCode[];
}

export interface CreatedEnrollmentCode {
  code: EnrollmentCode;
  /**
   * The code itself, in the clear, for the only moment it exists outside a hash — the same
   * contract `POST /api/admin/users` has for `generatedPassword`. Nothing may store it, log it,
   * or put it in a URL: the admin copies it out of the screen or it is gone.
   *
   * For a CHOSEN code this is the administrator's own string, echoed back exactly as they typed
   * it, so the banner can show them what to read out.
   */
  plaintext: string;
  /**
   * What the server actually hashed — `plaintext` with capitals, dashes, spaces and `U` removed
   * and the confusable letters folded onto digits.
   *
   * IT IS THE SERVER'S ANSWER AND NOT THE BROWSER'S. The form previews the same value while the
   * admin types, by calling core's `normalizeEnrollmentCode`, but a preview is a promise and this
   * is the record: the code that was committed to is whatever the process that wrote the digest
   * says it is.
   */
  normalized: string;
}

export interface CreateEnrollmentCodeBody {
  label: string;
  /**
   * The code to use, or `null` to have the server generate one.
   *
   * `null` rather than an omitted key, for the reason the two below give: the console always knows
   * which it means, and a field that can be left off is a field whose meaning drifts.
   */
  code: string | null;
  /** `null` is "no limit" — an explicit answer, not an omission the server has to guess at. */
  maxUses: number | null;
  expiresInDays: number | null;
}

/**
 * Whether self-enrolment is possible at all right now, as the server sees it.
 *
 * `null` means the server ANSWERED but did not say — an older build with no such route behind a
 * proxy that turns 404 into 200, or a tunnel's own page. It is deliberately not folded into
 * `false`: the caller treats "no" and "did not say" differently, because hiding the way in from
 * somebody holding a valid code is a dead end, and offering it to somebody without one costs a
 * link they ignore.
 */
export async function getEnrollmentOpen(signal?: AbortSignal): Promise<boolean | null> {
  const body = await apiGet<unknown>('/api/auth/enrollment-open', signal);
  if (typeof body !== 'object' || body === null) return null;
  const open = (body as { open?: unknown }).open;
  return typeof open === 'boolean' ? open : null;
}

export async function createEnrollmentCode(
  body: CreateEnrollmentCodeBody,
): Promise<CreatedEnrollmentCode> {
  return apiSend<CreatedEnrollmentCode>('POST', ENROLLMENT_CODES_PATH, body);
}

/**
 * `encodeURIComponent`, because the id is data. Ids are generated server-side today, but a path
 * built by concatenation is the kind of thing that stays correct only until the generator changes.
 */
export async function revokeEnrollmentCode(id: string): Promise<{ code: EnrollmentCode }> {
  return apiSend<{ code: EnrollmentCode }>(
    'POST',
    `${ENROLLMENT_CODES_PATH}/${encodeURIComponent(id)}/revoke`,
  );
}

export interface EnrollBody {
  code: string;
  email: string;
  password: string;
  displayName?: string;
}

/**
 * Redeem a code and become a member. The server sets the session cookie on success, exactly as
 * login does, so the caller's job afterwards is to refresh the session — not to read the user out
 * of this response. The role is not a parameter: enrolment creates members, and there is no field
 * here that could ask for anything else.
 */
export async function postEnroll(body: EnrollBody): Promise<{ user: SessionUser }> {
  return apiSend<{ user: SessionUser }>('POST', '/api/auth/enroll', body);
}
