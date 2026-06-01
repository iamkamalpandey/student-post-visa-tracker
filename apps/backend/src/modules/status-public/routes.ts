// SVT-WAVE-STATUS-PUBLIC-2026-05 — public, unauthenticated status surface.
//
// Mounted in app.ts BEFORE any auth middleware. Same pattern as
// `publicDsarRouter` — heavy per-IP rate limit to keep the surface from
// becoming an enumeration / DoS vector. The handler itself is read-only and
// served from a 60s in-process cache (see service.ts), so the DB / Redis /
// AV pings happen at most once per minute regardless of traffic.
//
// Route:
//   GET /api/v1/public/status  → 200 always; never 5xx (degrades gracefully).

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';

import { publicStatusService } from './service.js';

// 60/min/IP matches heavyReadLimiter; the page auto-refreshes once a minute
// so a single tab consumes 1 req/min. 60 leaves headroom for a tab plus the
// occasional polling Slack/Statuscake-style integration without legitimising
// scraping.
const publicStatusLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Public status rate limit exceeded; try again later.',
  },
});

export const publicStatusRouter: Router = Router();

publicStatusRouter.get('/status', publicStatusLimiter, async (_req: Request, res: Response) => {
  // The service never throws — checkXxx() helpers swallow individual subsystem
  // failures and map them to `degraded`. Even so we belt-and-braces a catch
  // here so a public surface never paints a 5xx to a customer.
  try {
    const snapshot = await publicStatusService.get();
    res
      .status(200)
      // 60s cache header so any CDN / reverse-proxy in front of us also
      // dedupes traffic without per-tenant scoping.
      .set('Cache-Control', 'public, max-age=60')
      .json(snapshot);
  } catch {
    res.status(200).json({
      status: 'degraded',
      generated_at: new Date().toISOString(),
      subsystems: [],
      incidents: [],
    });
  }
});
