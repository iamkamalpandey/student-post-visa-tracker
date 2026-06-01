import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ProblemDetail, TokenResponse } from '@spv/api-types';

// ---------------------------------------------------------------------------
// Module-level access-token holder.
// We deliberately keep the access token in memory only — never localStorage —
// so that XSS cannot lift it. The refresh token is delivered by the backend
// as an httpOnly cookie (withCredentials: true).
// ---------------------------------------------------------------------------

let accessTokenHolder: string | null = null;

export function setAccessToken(token: string | null): void {
  accessTokenHolder = token;
}

export function getAccessToken(): string | null {
  return accessTokenHolder;
}

// ---------------------------------------------------------------------------
// Typed error class for RFC 7807 problem responses.
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  public readonly status: number;
  public readonly title: string;
  public readonly detail: string | undefined;
  // SVT-SEC-MFA-STEPUP-2026-05 — machine-readable short code (e.g.
  // 'mfa_required') so callers can branch without parsing detail.
  public readonly code: string | undefined;
  public readonly errors: { path: string; message: string; code?: string }[];
  public readonly type: string;
  public readonly instance: string | undefined;
  public readonly requestId: string | undefined;

  constructor(problem: ProblemDetail & { code?: string }) {
    super(problem.detail || problem.title || 'Request failed');
    this.name = 'ApiError';
    this.status = problem.status;
    this.title = problem.title;
    this.detail = problem.detail;
    this.code = problem.code;
    this.errors = problem.errors ?? [];
    this.type = problem.type;
    this.instance = problem.instance;
    this.requestId = problem.request_id;
  }

  /** Convenience: convert errors[] to a Map keyed by field path. */
  fieldErrors(): Map<string, string> {
    const map = new Map<string, string>();
    for (const e of this.errors) map.set(e.path, e.message);
    return map;
  }
}

// ---------------------------------------------------------------------------
// Auth-logout broadcast: api.ts is framework-agnostic so it speaks to the
// auth provider via a CustomEvent. The provider listens and clears state.
// ---------------------------------------------------------------------------

export const AUTH_LOGOUT_EVENT = 'auth:logout';

function broadcastLogout(reason: 'refresh-failed' | 'unauthorized' = 'unauthorized'): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_LOGOUT_EVENT, { detail: { reason } }));
  }
}

// ---------------------------------------------------------------------------
// Axios instance
// ---------------------------------------------------------------------------

const baseURL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export const api: AxiosInstance = axios.create({
  baseURL,
  withCredentials: true,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  timeout: 30_000,
});

// ---------------------------------------------------------------------------
// Request interceptor — attach Bearer access token.
// ---------------------------------------------------------------------------

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAccessToken();
  if (token) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>).Authorization = `Bearer ${token}`;
  }
  return config;
});

// ---------------------------------------------------------------------------
// Request interceptor — auto-inject Idempotency-Key on mutating verbs.
// GET / HEAD / OPTIONS are idempotent already so we skip them. We only set the
// header when the caller hasn't already provided one — explicit retries of the
// SAME logical mutation should reuse the original key, which the caller passes
// in via `headers: { 'Idempotency-Key': '<stable-key>' }`. Each fresh user
// click without a caller-supplied key gets a brand-new uuidv4 scope.
// We use the browser/Node 20 native crypto.randomUUID() so we don't pull in a
// new dependency.
// ---------------------------------------------------------------------------

const MUTATING_METHODS = new Set(['post', 'patch', 'delete', 'put']);

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // RFC4122-v4-shaped fallback for ancient runtimes; not cryptographically
  // strong but sufficient for an idempotency scope identifier.
  const rand = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rand()}${rand()}-${rand()}-4${rand().slice(1)}-${((Math.random() * 4) | 8).toString(16)}${rand().slice(1)}-${rand()}${rand()}${rand()}`;
}

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const method = (config.method ?? '').toLowerCase();
  if (!MUTATING_METHODS.has(method)) return config;
  config.headers = config.headers ?? {};
  const headers = config.headers as Record<string, string | undefined>;
  if (!headers['Idempotency-Key'] && !headers['idempotency-key']) {
    headers['Idempotency-Key'] = newIdempotencyKey();
  }
  return config;
});

// ---------------------------------------------------------------------------
// Response interceptor — single-flight refresh on 401, then retry once.
// ---------------------------------------------------------------------------

type RetriableConfig = AxiosRequestConfig & { _retry?: boolean };

// ---------------------------------------------------------------------------
// SVT-SEC-REFRESH-RACE-2026-06 — single-flight refresh shared by EVERY caller.
//
// The backend rotates refresh tokens single-use with reuse detection: present
// an already-rotated token and it revokes the whole token family as suspected
// theft. So two concurrent `/auth/refresh` calls with the same cookie are a
// session-killer — one wins, the other replays the now-revoked token and nukes
// the family, logging the user out at random.
//
// On a full page load TWO refresh paths fire near-simultaneously: the auth
// provider's bootstrap refresh AND this interceptor (pages that mount before
// bootstrap completes fire token-less requests that 401). Previously the
// bootstrap used its own raw-axios call, so the interceptor's single-flight
// guard didn't cover it — the two raced. We now funnel BOTH through
// `refreshSession()` so at most one refresh is ever in flight per tab.
//
// Resolves with the full TokenResponse (so the auth provider gets the user
// object too) or null on any non-2xx / network error. `validateStatus` keeps
// the expected "no cookie yet" 401 from logging as an error.
let refreshInflight: Promise<TokenResponse | null> | null = null;

export function refreshSession(): Promise<TokenResponse | null> {
  if (!refreshInflight) {
    refreshInflight = axios
      .post<TokenResponse>(
        `${baseURL}/auth/refresh`,
        {},
        {
          withCredentials: true,
          headers: { Accept: 'application/json' },
          validateStatus: () => true,
        },
      )
      .then((res) => {
        if (res.status >= 200 && res.status < 300 && res.data?.access_token) {
          setAccessToken(res.data.access_token);
          return res.data;
        }
        setAccessToken(null);
        return null;
      })
      .catch(() => {
        setAccessToken(null);
        return null;
      })
      .finally(() => {
        refreshInflight = null;
      });
  }
  return refreshInflight;
}

async function performRefresh(): Promise<string | null> {
  const data = await refreshSession();
  return data?.access_token ?? null;
}

function isAuthRoute(url: string | undefined): boolean {
  if (!url) return false;
  return /\/auth(\/|$)/.test(url);
}

function toApiError(err: AxiosError): ApiError {
  const data = err.response?.data as Partial<ProblemDetail> | undefined;
  if (data && typeof data === 'object' && 'title' in data && 'status' in data) {
    return new ApiError(data as ProblemDetail);
  }
  return new ApiError({
    type: 'about:blank',
    title: err.message || 'Network error',
    status: err.response?.status ?? 0,
    detail: err.message,
  } as ProblemDetail);
}

// SVT-SEC-MFA-STEPUP-2026-05 — these 401 sub-codes mean "the access token is
// valid; the request itself needs a step-up second factor". Do NOT trigger a
// silent refresh (would loop) or broadcast logout (the user is fine, the
// MUTATION needs an X-MFA-Code header). Callers handle them at the call site.
const MFA_STEP_UP_CODES = new Set(['mfa_required', 'mfa_invalid', 'mfa_replay']);

function isMfaStepUp401(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const code = (data as { code?: unknown }).code;
  return typeof code === 'string' && MFA_STEP_UP_CODES.has(code);
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as RetriableConfig | undefined;
    const status = error.response?.status;

    // Network error / no response.
    if (!original || status === undefined) {
      return Promise.reject(toApiError(error));
    }

    // SVT-SEC-MFA-STEPUP-2026-05 — short-circuit MFA step-up responses
    // BEFORE the refresh/logout branch. These are caller-handled.
    if (status === 401 && isMfaStepUp401(error.response?.data)) {
      return Promise.reject(toApiError(error));
    }

    // 401 handling — try a single silent refresh, then retry. performRefresh()
    // funnels through the shared single-flight (refreshSession), so concurrent
    // 401s and the bootstrap refresh all coalesce into ONE network call.
    if (status === 401 && !original._retry && !isAuthRoute(original.url)) {
      original._retry = true;
      try {
        const newToken = await performRefresh();
        if (newToken) {
          original.headers = original.headers ?? {};
          (original.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
          return api.request(original);
        }
        broadcastLogout('refresh-failed');
      } catch {
        broadcastLogout('refresh-failed');
      }
    } else if (status === 401 && (original._retry || isAuthRoute(original.url))) {
      // Already retried, or auth endpoint itself returned 401: surface and broadcast.
      if (!isAuthRoute(original.url)) broadcastLogout('unauthorized');
    }

    return Promise.reject(toApiError(error));
  },
);

export default api;
