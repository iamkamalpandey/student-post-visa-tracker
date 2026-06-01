// Shared helpers for the imports/exports/inbox pages.
// - Authed blob downloads (Bearer header from the api instance, withCredentials).
// - Idempotency-Key generator (uses crypto.randomUUID — no new deps).
// - sessionStorage-backed "recent jobs" cache so the list pages have something
//   to show when the backend doesn't yet expose a list endpoint.
// - Centralised TanStack Query keys for cache invalidation.

import { api, ApiError, getAccessToken } from '@/lib/api';

const baseURL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1';

/**
 * Fetch an authenticated route as a Blob and trigger a browser download.
 * Goes through fetch (not axios) because we want streaming response handling
 * and a Blob — but we still pull the access token from the shared api holder
 * so 401-refresh logic applies on the next axios call.
 */
export async function downloadAuthedBlob(path: string, filename: string): Promise<void> {
  const token = getAccessToken();
  // Build the absolute URL. Three cases:
  //   1. Fully-qualified URL (http*) — pass through.
  //   2. Path that already includes `/api/v1` (e.g. signed download URL from backend) —
  //      prefix with the API origin only.
  //   3. Relative path like `/imports/foo` — prefix with the full baseURL.
  let url: string;
  if (/^https?:\/\//i.test(path)) {
    url = path;
  } else if (path.startsWith('/api/v1')) {
    const origin = baseURL.replace(/\/api\/v1\/?$/, '');
    url = `${origin}${path}`;
  } else {
    url = `${baseURL}${path}`;
  }
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/octet-stream, application/json, text/csv, application/x-ndjson',
    },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { title?: string; detail?: string };
      detail = body.detail || body.title || detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError({
      type: 'about:blank',
      status: res.status,
      title: 'Download failed',
      detail,
    });
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }, 0);
}

/** Browser-side UUID v4 — used for Idempotency-Key headers. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older browsers — RFC 4122 v4-ish.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- recent-job tracking ---------------------------------------------------

const IMPORTS_KEY = 'spv:recent-imports';
const EXPORTS_KEY = 'spv:recent-exports';
const MAX_RECENT = 50;

function readList(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, ids: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(ids.slice(0, MAX_RECENT)));
  } catch {
    /* ignore quota */
  }
}

function rememberId(key: string, id: string): void {
  const list = readList(key).filter((existing) => existing !== id);
  list.unshift(id);
  writeList(key, list);
}

export const rememberImportId = (id: string): void => rememberId(IMPORTS_KEY, id);
export const rememberExportId = (id: string): void => rememberId(EXPORTS_KEY, id);
export const readRecentImportIds = (): string[] => readList(IMPORTS_KEY);
export const readRecentExportIds = (): string[] => readList(EXPORTS_KEY);

// --- query keys ------------------------------------------------------------

export const IMPORTS_QK = {
  all: ['imports'] as const,
  list: (ids: string[]) => ['imports', 'list', ids] as const,
  detail: (id: string) => ['imports', 'detail', id] as const,
  report: (id: string) => ['imports', 'report', id] as const,
};

export const EXPORTS_QK = {
  all: ['exports'] as const,
  list: (ids: string[]) => ['exports', 'list', ids] as const,
  detail: (id: string) => ['exports', 'detail', id] as const,
};

export const TEMPLATES_QK = {
  all: ['message-templates'] as const,
  list: () => ['message-templates', 'list'] as const,
};

export const DASHBOARD_QK = {
  summary: () => ['dashboard', 'summary'] as const,
  expiries: (within: number) => ['dashboard', 'expiries', within] as const,
};

// Used by the imports list to know when to keep polling.
export const ACTIVE_IMPORT_STATUSES = new Set([
  'UPLOADED',
  'PARSING',
  'VALIDATING',
  'APPLYING',
]);

export type ImportStatus =
  | 'UPLOADED'
  | 'PARSING'
  | 'VALIDATING'
  | 'DRY_RUN_READY'
  | 'APPLYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type ExportStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
