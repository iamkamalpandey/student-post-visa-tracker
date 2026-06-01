// Refresh-token cookie helpers. Centralising the cookie shape here ensures /login,
// /refresh, and /logout all agree on name, path, and security flags.
//
// Choices:
//   - HttpOnly: prevents JS access in case of XSS. The refresh token is the highest-value
//     credential we set; never expose it to the page.
//   - Secure (prod only): browsers refuse Set-Cookie; Secure on plain http://localhost.
//   - SameSite=Strict (SVT-SEC-REFRESH-CSRF-2026-05 / P1-9): the refresh path is hit
//     only via our own SPA's same-origin fetches. The previous `lax` value allowed
//     the cookie to ride along on top-level cross-site GET navigations — combined
//     with the body-fallback in /refresh (now removed) that gave a CSRF window: an
//     attacker site that triggered a cross-origin POST could force the browser to
//     send the refresh cookie. Strict blocks ALL cross-site requests including
//     top-level navigations, which is the correct posture for a credential cookie
//     that the SPA only ever sends from its own origin.
//   - Path=/api/v1/auth: scoped so the cookie is not sent on every API request, only on
//     the auth endpoints that actually use it. Reduces CSRF surface and request size.
//   - maxAge: caller passes the TTL the refresh token itself was minted for, so cookie
//     expiry tracks token expiry exactly.

import type { Request, Response } from 'express';
import { env } from '../config/env.js';

export const REFRESH_COOKIE_NAME = 'spv_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  path: string;
} {
  return {
    httpOnly: true,
    secure: env.isProd,
    // SVT-SEC-REFRESH-CSRF-2026-05 (P1-9) — Strict, not Lax. Combined with
    // dropping the JSON-body refresh-token fallback (see auth.controller),
    // this eliminates the CSRF surface where a forged cross-site POST
    // could force the browser to attach the refresh cookie.
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(res: Response, token: string, ttlSec?: number): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...baseOptions(),
    maxAge: (ttlSec ?? env.REFRESH_TOKEN_TTL_SECONDS) * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  // Browsers honour clearCookie only when path/domain/sameSite/secure match the original.
  res.clearCookie(REFRESH_COOKIE_NAME, baseOptions());
}

export function readRefreshCookie(req: Request): string | null {
  // cookie-parser middleware populates req.cookies; fall back to undefined-safe access in
  // case it isn't installed on a particular route.
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const value = cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
