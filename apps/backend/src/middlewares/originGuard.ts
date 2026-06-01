// Origin allow-list middleware. Pairs with `sameSite: 'lax'` on the refresh
// cookie to prevent CSRF on cookie-bearing endpoints without requiring a CSRF
// token round-trip.
//
// Apply ONLY to cookie-bearing routes (auth login/refresh/logout). Applying
// globally would break legitimate non-browser clients (CLI, server-to-server)
// that omit the Origin/Referer headers entirely.
//
// SVT-CSRF-2026-05.

import type { RequestHandler } from 'express';
import { env } from '../config/env.js';

const allowed = new Set(env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean));

export const originGuard: RequestHandler = (req, res, next) => {
  // Safe methods can't be used for CSRF state-change. Skip outright so OPTIONS
  // pre-flights and the GET-jwks endpoints still work from any origin.
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  const origin = req.get('Origin') ?? req.get('Referer');
  // Non-browser clients (curl, server-side fetchers) routinely omit both
  // headers — they can't be CSRF'd because there's no implicit credential
  // attachment, so allow through. The cookie-only attack vector requires a
  // browser, which always sends Origin on cross-site POSTs.
  if (!origin) return next();

  try {
    const u = new URL(origin);
    const o = `${u.protocol}//${u.host}`;
    if (!allowed.has(o)) {
      res.status(403).type('application/problem+json').json({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Origin not allowed',
        instance: req.originalUrl,
        request_id: (req as { requestId?: string }).requestId,
      });
      return;
    }
  } catch {
    // Malformed Origin/Referer — let helmet/cors gate the rest. We don't
    // 403 here because some legitimate clients send odd values that the
    // CORS middleware handles separately.
  }
  next();
};
