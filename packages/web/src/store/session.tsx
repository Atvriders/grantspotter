import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Profile } from '@grantspotter/core';
import { apiGet, apiSend, ApiError } from '../api/client.js';

/**
 * Derived from CONTRACT §3's `Profile` union rather than restated, so a third
 * profile variant is a compile error here instead of a silently-missing case.
 * Type-only, so nothing of `core` reaches the bundle.
 */
export type ProfileKind = Profile['kind'];

/** Mirrors `packages/server/src/api/completeness.ts`, which is plan-local to Plan 3. */
export interface CompletenessReport {
  total: number;
  unknownCount: number;
  score: number;
  fields: Array<{ field: string; resolves: number }>;
}

export interface SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
}

export interface SessionValue {
  user: SessionUser | null;
  hasStudentProfile: boolean;
  hasOrgProfile: boolean;
  /**
   * ONE report, even for a user who holds two profiles. Never render it without
   * `completenessFor` beside it.
   */
  completeness: CompletenessReport;
  /**
   * Which profile `completeness` was computed from, as the server reports it
   * (`GET /api/me` → `completenessFor`). `null` means no profile was evaluated —
   * either the user holds none, or the server did not say. It is NOT re-derived
   * here from `hasStudentProfile`/`hasOrgProfile`: the preference order that
   * picks the active profile has exactly one definition, in
   * `packages/server/src/api/profileStore.ts`, and a second copy in the browser
   * is how the browse page and the profile page end up disagreeing.
   */
  completenessFor: ProfileKind | null;
  /**
   * Profiles the user holds that `completeness` does NOT speak for. Non-empty
   * means the meter is silent about a profile that exists, and the UI must say
   * so — an unlabelled meter tells an organisation user their organisation
   * profile scored 60% when it was never evaluated.
   */
  unevaluatedProfiles: ProfileKind[];
  unread: number;
  loading: boolean;
  refresh: () => void;
  logout: () => Promise<void>;
}

export const EMPTY_COMPLETENESS: CompletenessReport = {
  total: 0,
  unknownCount: 0,
  score: 0,
  fields: [],
};

/**
 * The held profiles the completeness report does not speak for.
 *
 * Pure set subtraction over facts the server supplied — it never guesses which
 * profile "wins", so when the server names none, every held profile is reported
 * as unevaluated rather than one of them being quietly credited.
 */
export function unevaluatedProfileKinds(input: {
  hasStudentProfile: boolean;
  hasOrgProfile: boolean;
  completenessFor: ProfileKind | null;
}): ProfileKind[] {
  const held: ProfileKind[] = [];
  if (input.hasStudentProfile) held.push('student');
  if (input.hasOrgProfile) held.push('organization');
  return held.filter((kind) => kind !== input.completenessFor);
}

const ANONYMOUS: SessionValue = {
  user: null,
  hasStudentProfile: false,
  hasOrgProfile: false,
  completeness: EMPTY_COMPLETENESS,
  completenessFor: null,
  unevaluatedProfiles: [],
  unread: 0,
  loading: true,
  refresh: () => undefined,
  logout: async () => undefined,
};

export const SessionContext = createContext<SessionValue>(ANONYMOUS);

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

/**
 * Build a `SessionValue` for a test or a story without restating every field.
 *
 * It exists so that adding a field to `SessionValue` does not mean editing ten
 * `SessionContext.Provider value={{ … }}` literals, and so that
 * `unevaluatedProfiles` cannot contradict the fields it is derived from — pass
 * it explicitly only when it is the thing under test.
 */
export function makeSessionValue(overrides: Partial<SessionValue> = {}): SessionValue {
  const merged: SessionValue = { ...ANONYMOUS, loading: false, ...overrides };
  return {
    ...merged,
    unevaluatedProfiles: overrides.unevaluatedProfiles ?? unevaluatedProfileKinds(merged),
  };
}

/** `GET /api/me` (Task 6). `completenessFor` is optional so an older server degrades honestly. */
interface MeResponse {
  user: SessionUser;
  hasStudentProfile: boolean;
  hasOrgProfile: boolean;
  completenessFor?: ProfileKind | null;
  completeness: CompletenessReport;
}

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<MeResponse>('/api/me')
      .then(async (value) => {
        if (cancelled) return;
        setMe(value);
        // A notifications outage must not sign the user out. The badge is
        // omitted at zero, which is also what "we could not count" looks like;
        // the digest itself (Task 21) is where the outage becomes visible.
        const notifications = await apiGet<{ unread: number }>(
          '/api/notifications?unreadOnly=true',
        ).catch(() => ({ unread: 0 }));
        if (!cancelled) setUnread(notifications.unread);
      })
      .catch((err: unknown) => {
        if (!cancelled && err instanceof ApiError && err.status === 401) setMe(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const logout = useCallback(async () => {
    await apiSend('POST', '/api/auth/logout').catch(() => null);
    setMe(null);
    setUnread(0);
    refresh();
  }, [refresh]);

  const value = useMemo<SessionValue>(() => {
    const hasStudentProfile = me?.hasStudentProfile ?? false;
    const hasOrgProfile = me?.hasOrgProfile ?? false;
    const completenessFor = me?.completenessFor ?? null;
    return {
      user: me?.user ?? null,
      hasStudentProfile,
      hasOrgProfile,
      completeness: me?.completeness ?? EMPTY_COMPLETENESS,
      completenessFor,
      unevaluatedProfiles: unevaluatedProfileKinds({
        hasStudentProfile,
        hasOrgProfile,
        completenessFor,
      }),
      unread,
      loading,
      refresh,
      logout,
    };
  }, [me, unread, loading, refresh, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
