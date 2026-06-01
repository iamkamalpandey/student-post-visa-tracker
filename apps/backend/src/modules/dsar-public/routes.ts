// SVT-WAVE-DSAR-PUBLIC-2026-05 — public DSAR intake router.
//
// Mounted in app.ts BEFORE any auth middleware so the request never sees
// `authenticate`. Heavy rate-limiting (heavyReadLimiter at 60/min/IP) keeps
// this unauthenticated surface from becoming a spam vector.
//
// Routes:
//   POST /api/v1/public/dsar  — 200 always, generic body, anti-enumeration.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { PublicDSARRequest } from '@spv/zod-schemas';

import { validate } from '../../middlewares/validate.js';
import { requireIdempotencyKey } from '../../shared/idempotencyHandler.js';
import { publicDsarService, PUBLIC_DSAR_RESPONSE_MESSAGE } from './service.js';

// Dedicated limiter — stricter than the generic heavyReadLimiter because this
// endpoint is fully unauthenticated and writes a row. 20/min/IP is plenty for
// any legitimate subject filling out the form.
const publicDsarLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Public DSAR rate limit exceeded; try again later.',
  },
});

export const publicDsarRouter: Router = Router();

// P1-WB7 (2026-05) — Idempotency-Key REQUIRED so a flaky-network retry
// from the public form (or a double-click) never mints a duplicate DSAR
// row. The frontend in `apps/frontend/app/(public)/legal/dsar/Client.tsx`
// generates a fresh UUID per submission; CLI / curl callers must do the
// same. The route does NOT route through the DB-backed idempotency cache
// (no req.db on the unauthenticated path) — the header is enforced as a
// client-side discipline; the service-layer dedup (subject_email + recent
// window) is the authoritative guard against duplicates.
publicDsarRouter.post(
  '/dsar',
  publicDsarLimiter,
  requireIdempotencyKey,
  validate(PublicDSARRequest),
  async (req, res, next) => {
    try {
      // Fire-and-forget side effects live inside the service; the response is
      // constant regardless of subject match.
      await publicDsarService.submit(req, req.body);
      res.status(200).json({ message: PUBLIC_DSAR_RESPONSE_MESSAGE });
    } catch (e) {
      next(e);
    }
  },
);
