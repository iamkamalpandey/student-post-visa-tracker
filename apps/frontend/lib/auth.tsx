'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import type { AuthUserResponse, TokenResponse } from '@spv/api-types';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, AUTH_LOGOUT_EVENT, api, setAccessToken, refreshSession } from './api';

const SESSION_USER_KEY = 'spv:auth:user';

export type AuthContextValue = {
  user: AuthUserResponse | null;
  accessToken: string | null;
  isLoading: boolean;
  /**
   * Performs a credential login. Throws an ApiError on failure so the caller
   * can surface field-level errors (e.g. "MFA required"). Pass either an
   * authenticator-app TOTP code (`mfaCode`) OR a single-use recovery code
   * (`recoveryCode`) when the backend signals an MFA challenge — never both.
   */
  login: (
    email: string,
    password: string,
    opts?: { mfaCode?: string; recoveryCode?: string },
  ) => Promise<AuthUserResponse>;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readSessionUser(): AuthUserResponse | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUserResponse) : null;
  } catch {
    return null;
  }
}

function writeSessionUser(user: AuthUserResponse | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (user) window.sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
    else window.sessionStorage.removeItem(SESSION_USER_KEY);
  } catch {
    /* swallow quota errors */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<AuthUserResponse | null>(null);
  const [accessToken, setAccessTokenState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const bootstrapped = useRef(false);

  // When the access token transitions from null → string (bootstrap or login)
  // we invalidate every cached query. Pages that mounted before bootstrap
  // completed sent unauthenticated requests, got 401-errored, and cached the
  // failure under their query key. Without this invalidation they would only
  // recover after a filter toggle (which creates a new key). One-line fix.
  const previousToken = useRef<string | null>(null);
  useEffect(() => {
    if (!previousToken.current && accessToken) {
      qc.invalidateQueries();
    }
    previousToken.current = accessToken;
  }, [accessToken, qc]);

  const applyToken = useCallback((token: string | null) => {
    setAccessToken(token);
    setAccessTokenState(token);
  }, []);

  const applyUser = useCallback((next: AuthUserResponse | null) => {
    setUser(next);
    writeSessionUser(next);
  }, []);

  // SVT-SEC-REFRESH-RACE-2026-06 — go through the shared single-flight in
  // api.ts so a manual refresh can never race the bootstrap / interceptor
  // refresh (concurrent refreshes trip the backend's reuse detection and
  // revoke the whole token family).
  const refresh = useCallback(async (): Promise<boolean> => {
    const data = await refreshSession();
    if (data?.access_token) {
      applyToken(data.access_token);
      applyUser(data.user);
      return true;
    }
    applyToken(null);
    applyUser(null);
    return false;
  }, [applyToken, applyUser]);

  const login = useCallback(
    async (
      email: string,
      password: string,
      opts?: { mfaCode?: string; recoveryCode?: string },
    ): Promise<AuthUserResponse> => {
      const res = await api.post<TokenResponse>('/auth/login', {
        email,
        password,
        // SVT-SEC-MFA-RECOVERY-2026-05 — only one second factor at a time.
        // Recovery code wins if both are accidentally provided (recovery is
        // the explicit user-driven fallback; TOTP submission is the default).
        ...(opts?.recoveryCode
          ? { recovery_code: opts.recoveryCode }
          : opts?.mfaCode
            ? { mfa_code: opts.mfaCode }
            : {}),
      });
      applyToken(res.data.access_token);
      applyUser(res.data.user);
      return res.data.user;
    },
    [applyToken, applyUser],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.post('/auth/logout', {});
    } catch {
      /* even if the server call fails, drop local state */
    } finally {
      applyToken(null);
      applyUser(null);
      // SVT-SEC-2026-05 — purge TanStack Query cache so a different user
      // (shared workstation / device handoff) cannot see cached PII via
      // devtools or a fast re-login race before invalidation lands.
      try {
        qc.cancelQueries();
        qc.removeQueries();
        qc.clear();
      } catch { /* TanStack quirks should never block logout */ }
    }
  }, [applyToken, applyUser, qc]);

  // Bootstrap on mount: read user from sessionStorage, then attempt a SILENT
  // refresh via the shared single-flight (api.ts). It resolves any non-2xx
  // without throwing — a missing/invalid refresh cookie is the expected
  // first-load case and should not surface as a console error.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    const cached = readSessionUser();
    if (cached) setUser(cached);

    void (async () => {
      try {
        // SVT-SEC-REFRESH-RACE-2026-06 — shared single-flight (see api.ts).
        // Using the same in-flight promise as the response interceptor means a
        // token-less request that 401s during bootstrap reuses THIS refresh
        // instead of firing a second, racing one.
        const data = await refreshSession();
        if (data?.access_token) {
          applyToken(data.access_token);
          applyUser(data.user);
        } else {
          applyToken(null);
          applyUser(null);
        }
      } finally {
        setIsLoading(false);
      }
    })();
  }, [applyToken, applyUser]);

  // Listen for forced-logout events broadcast from api.ts.
  useEffect(() => {
    const handler = () => {
      applyToken(null);
      applyUser(null);
    };
    window.addEventListener(AUTH_LOGOUT_EVENT, handler);
    return () => window.removeEventListener(AUTH_LOGOUT_EVENT, handler);
  }, [applyToken, applyUser]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, accessToken, isLoading, login, logout, refresh }),
    [user, accessToken, isLoading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Redirects to /login if no user is present once auth has bootstrapped.
 * Returns the current auth context for convenience.
 */
export function useRequireAuth(): AuthContextValue {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!auth.isLoading && !auth.user) {
      router.replace('/login');
    }
  }, [auth.isLoading, auth.user, router]);
  return auth;
}

// Re-export the typed error class so callers don't need to know about lib/api.
export { ApiError };
