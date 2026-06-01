// SVT-SEC-2026-05 — Next.js Edge middleware: per-request security headers.
//
// Globally applies:
//   * Content-Security-Policy with a per-request nonce (script + style limited
//     to self + nonce + ws/wss for HMR in dev).
//   * Strict-Transport-Security (HSTS) — 2y + includeSubDomains + preload.
//     Only emitted on HTTPS responses (proxy is expected to terminate TLS).
//   * X-Frame-Options DENY + frame-ancestors 'none' as belt-and-braces.
//   * Referrer-Policy: strict-origin-when-cross-origin.
//   * X-Content-Type-Options: nosniff.
//   * Permissions-Policy: deny common dangerous features by default.
//
// The CSP nonce is exposed via the `x-csp-nonce` response header so the app
// shell / RootLayout can read it (via `next/headers`) and propagate to
// AppRouterCacheProvider's emotionCache + inline <Script nonce={...}>.
//
// MUI/Emotion: the per-request nonce is now plumbed into emotion's cache via
// components/EmotionRegistry.tsx, so every <style> emotion injects (SSR + CSR)
// carries the nonce attribute. That lets us tighten style-src to nonce-only
// and drop `'unsafe-inline'` entirely — XSS via injected <style> is no longer
// possible.

import { NextRequest, NextResponse } from 'next/server';

function generateNonce(): string {
  // Edge-runtime-safe nonce. crypto.getRandomValues is globally available.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  // Base64 (no padding) — short, URL-safe-ish, matches CSP nonce format.
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '');
}

export function middleware(req: NextRequest) {
  const nonce = generateNonce();
  const apiBase = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? '';
  // Derive the connect-src host from the API base URL so reverse-proxy
  // configurations work out of the box. Falls back to 'self' when unset.
  let connectExtra = "";
  // The CSP violation sink lives on the BACKEND (`<apiBase>/csp/report`), not
  // the frontend. A relative `report-uri` resolves against the frontend origin
  // and 404s on every violation (the frontend has no such route). Derive the
  // absolute backend URL from the API base so reports actually reach the pino
  // sink. Falls back to the relative path only when the API base is unset.
  let reportUri = '/api/v1/csp/report';
  try {
    if (apiBase) {
      const u = new URL(apiBase);
      connectExtra = ` ${u.protocol}//${u.host}`;
      reportUri = `${apiBase.replace(/\/$/, '')}/csp/report`;
    }
  } catch {
    /* malformed env var — ignore, will rely on 'self' + relative report-uri */
  }

  // SVT-SEC-P2-FE5-2026-05 — `ws:` / `wss:` were previously allowed in every
  // environment to support Next.js HMR. In production no HMR runs and any
  // websocket from the browser would be either (a) something we don't own or
  // (b) an exfil channel. Gate the dev-only schemes on NODE_ENV !== 'production'.
  const isProd = process.env['NODE_ENV'] === 'production';
  const wsExtra = isProd ? '' : ' ws: wss:';

  // SVT-SEC-CSP-NONCE-NEGATION-2026-06 — CSP3 rule: when a directive lists a
  // nonce-source, the browser IGNORES `'unsafe-inline'` in that same directive.
  // The previous code emitted `'nonce-X' 'unsafe-inline'` together in dev,
  // which silently degraded to nonce-only — so Next.js HMR's un-nonced
  // <style>/<script> (webpack runtime + React Refresh eval) were BLOCKED, and
  // every page fired style-src-elem/style-src-attr violations.
  //
  // Strategy that actually works in both environments:
  //   * Production — nonce-gate script/style ELEMENTS (strong anti-XSS). Next
  //     stamps the nonce on its inline scripts and EmotionRegistry stamps it on
  //     MUI's <style> tags, so both validate.
  //   * Development — DROP the nonce from the directive and rely on
  //     'unsafe-inline' (+ 'unsafe-eval' for React Refresh) so HMR works. The
  //     nonce is still generated and stamped on our tags; it's simply not the
  //     gate in dev, which is fine — dev is not a hostile origin.
  const scriptSrc = isProd
    ? `script-src 'self' 'nonce-${nonce}'`
    : "script-src 'self' 'unsafe-eval' 'unsafe-inline'";
  const styleSrc = isProd
    ? `style-src 'self' 'nonce-${nonce}'`
    : "style-src 'self' 'unsafe-inline'";

  const cspDirectives = [
    "default-src 'self'",
    scriptSrc,
    // SVT-SEC-P1-FE2-2026-05 — nonce-gated style ELEMENTS. EmotionRegistry.tsx
    // feeds the same per-request nonce into @emotion/cache, so every <style>
    // MUI injects (SSR + runtime) is stamped and accepted; injected un-nonced
    // <style> (the XSS sink) is still blocked.
    styleSrc,
    // SVT-SEC-CSP-STYLE-ATTR-2026-06 — inline style ATTRIBUTES (style="...")
    // cannot carry a nonce, yet MUI transitions (Backdrop/Drawer/Modal set
    // opacity/visibility/transform inline) and Next's route-announcer
    // (position:absolute) emit them. Without this, production nonce-only
    // style-src blocks those attributes → stuck-visible overlays, broken
    // drawer/modal animations, and a visible a11y announcer. Allow attr-level
    // inline styles only; <style>/<link> ELEMENTS stay nonce-gated above.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${connectExtra}${wsExtra}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    // SVT-SEC-P2-FE3-2026-05 — auto-rewrite any accidental http:// asset
    // reference to https:// before fetch. Harmless on plain-HTTP dev. Pairs
    // with HSTS for transport hardening.
    'upgrade-insecure-requests',
    // SVT-SEC-P2-FE3-2026-05 — CSP violation reports stream into the backend
    // pino log. report-uri is the broadly-supported sibling of report-to.
    `report-uri ${reportUri}`,
  ].join('; ');

  const res = NextResponse.next({ request: { headers: req.headers } });

  // Expose the nonce so server components / layouts can read it via headers().
  res.headers.set('x-csp-nonce', nonce);
  res.headers.set('Content-Security-Policy', cspDirectives);
  res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  );

  return res;
}

// Apply globally. Skip Next internals + static assets so they don't carry
// every header (and so /_next/static/*.js stays cacheable by intermediaries).
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|public).*)'],
};
