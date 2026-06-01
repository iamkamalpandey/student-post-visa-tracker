// SVT-SEC-P2-FE4-2026-05 — in-process error reporter for Next.js error boundaries.
//
// Boundaries used to dump `error.stack` straight into the browser console,
// which (a) leaks file paths + minified-but-still-grep-able source line refs
// onto a shared workstation's devtools history and (b) gives any tooling that
// scrapes the console (browser extensions, RUM agents) a free copy of the
// internal call graph. In production we instead emit a sanitised envelope
// (name + Next.js digest + boundary label) to the backend report sink — the
// backend logs it via pino with the existing redaction pipeline.
//
// In dev we still console.error the rich object so debugging stays ergonomic.

export type BoundaryName = 'global' | 'root' | 'app' | 'auth' | 'legal';

const ENDPOINT = '/api/v1/security/error-report';

// Resolve once: in browser-relative paths Next will route through the API
// proxy where configured; an explicit NEXT_PUBLIC_API_BASE_URL takes precedence
// so deployments where the API lives on a different origin still reach it.
function resolveUrl(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (typeof base === 'string' && base.length > 0) {
    // base typically ends in /api/v1 — strip the duplicate segment if so.
    return base.replace(/\/+$/, '') + '/security/error-report';
  }
  return ENDPOINT;
}

export function reportBoundaryError(
  boundary: BoundaryName,
  error: Error & { digest?: string },
): void {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    // eslint-disable-next-line no-console
    console.error(`${boundary} route error`, {
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    });
    return;
  }

  // Production: send a sanitised envelope. No message, no stack — just the
  // category (constructor name) + Next.js error digest. The backend pairs the
  // digest with its own server-side log lines so on-call can still triangulate.
  try {
    const payload = JSON.stringify({
      name: error.name || 'Error',
      digest: error.digest ?? null,
      route: boundary,
    });
    // Use sendBeacon when available — survives page navigation away from the
    // failed view. Falls back to fetch keepalive otherwise.
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(resolveUrl(), blob);
      return;
    }
    void fetch(resolveUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {
      /* swallow — reporting must never throw inside a boundary */
    });
  } catch {
    /* swallow — reporting must never throw inside a boundary */
  }
}
