// Centralised place for additional security headers we want beyond Helmet defaults.
// Today this is just a Permissions-Policy header that locks down browser-only features the
// API responses are never expected to use; helpful when the same domain serves both API and
// any rare HTML response (e.g. /api/docs in dev).

import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Permissions-Policy',
    [
      'accelerometer=()',
      'camera=()',
      'display-capture=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'payment=()',
      'usb=()',
      'interest-cohort=()',
    ].join(', '),
  );
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // SVT-HSTS-2026-05: HSTS is meaningful only over TLS — browsers silently
  // ignore it on plain HTTP. We previously let Helmet emit HSTS unconditionally
  // (180 days), which is harmless from localhost but risks an accidental host
  // pin if a dev box is ever proxied behind TLS at a custom domain. Gate it on
  // `req.secure` (set by Express when the connection is HTTPS or the proxy
  // hop chain says so) OR production. Helmet's own HSTS is disabled in app.ts.
  if (req.secure || env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}
