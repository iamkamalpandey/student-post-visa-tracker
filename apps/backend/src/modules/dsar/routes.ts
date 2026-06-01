import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { dsarLimiter, heavyReadLimiter } from '../../middlewares/rateLimit.js';
import { requireIdempotencyKey } from '../../shared/idempotencyHandler.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import { CreateDSARRequest, UpdateDSARRequest, DSARListQuery } from '@spv/zod-schemas';
import { dsarController as c } from './controller.js';

export const dsarRouter: Router = Router();
dsarRouter.use(authenticate, tenantContext);
// POST: ADMIN or COUNSELLOR (intake on behalf of subjects).
// SVT-WAVE-RATE-LIMIT-DSAR-2026-05 — 20/min cap on intake + update so a
// runaway script can't flood the regulator-clock pipeline.
// SVT-WAVE-IDEM-MONEY-MOVERS-2026-05 — DSAR intake mints a regulator-
// timed record; Idempotency-Key is REQUIRED so a retry on a flaky network
// never creates a duplicate.
dsarRouter.post(
  '/',
  dsarLimiter,
  requireRole('ADMIN', 'COUNSELLOR'),
  requireIdempotencyKey,
  validate(CreateDSARRequest),
  c.create,
);
// GET list: admin only.
dsarRouter.get('/', requireRole('ADMIN'), validate(DSARListQuery, 'query'), c.list);
// SVT-WAVE37-DSAR-DASH-2026-05 — admin dashboard widget counts. Declared
// before the :id route so the literal segment wins UUID matching.
// SVT-WAVE-MED-2026-05 — heavyReadLimiter prevents polling abuse.
dsarRouter.get('/dashboard-summary', requireRole('ADMIN'), heavyReadLimiter, c.dashboardSummary);
// GET single: admin only (subjects can request their own via separate route in future).
dsarRouter.get('/:id', uuidParam('id'), requireRole('ADMIN'), c.get);
// PATCH: COUNSELLOR+ can drive forward transitions (PENDING -> IN_PROGRESS,
// IN_PROGRESS -> COMPLETED). Reverse / terminal-altering transitions are
// gated to ADMIN inside the service via the FSM table — which IS the
// regulator-clock guard (notes required, ADMIN role required to reopen
// terminal states). Audit recommendation to tighten the route to ADMIN-only
// was over-reach: counsellors legitimately need to start work on requests.
dsarRouter.patch(
  '/:id',
  dsarLimiter,
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(UpdateDSARRequest),
  c.update,
);

// SVT-WAVE-PRIV-C1-2026-05 — ACCESS / PORTABILITY download bundle endpoints.
// `/:id/export` mints a fresh single-use 24h token; the actual stream
// lives at `/:id/export/download?token=<nonce>` so the FE can pass the URL
// to the browser without an Authorization-header juggle. Both gated to ADMIN.
dsarRouter.get('/:id/export', uuidParam('id'), requireRole('ADMIN'), c.exportLink);
dsarRouter.get('/:id/export/download', uuidParam('id'), requireRole('ADMIN'), c.exportDownload);
