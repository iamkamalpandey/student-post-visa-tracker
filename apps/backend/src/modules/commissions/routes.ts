// Commissions router. Mounted at /api/v1/commissions in app.ts.
//
// authenticate + tenantContext are applied at the mount point in app.ts; the
// router only enforces requireRole('ADMIN') on the write paths.
//
// State-machine endpoints are POST (not PATCH) because they have side effects
// beyond a simple field update (audit log entry, idempotency key consumption,
// invoice number allocation).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CommissionListQuery,
  DisputeRequest,
  InvoiceRequest,
  MarkPaidRequest,
  ResolveDisputeRequest,
  UpdateCommissionRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { requireMfa } from '../../middlewares/requireMfa.js';
import { requireIdempotencyKey } from '../../shared/idempotencyHandler.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './controller.js';

function param(name: string, schema: z.ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return next(
        BadRequest(
          `Invalid path parameter: ${name}`,
          parsed.error.issues.map((i) => ({
            path: i.path.join('.') || name,
            message: i.message,
            code: i.code,
          })),
        ),
      );
    }
    req.params[name] = parsed.data as string;
    next();
  };
}

const requireUuidId = param('id', Uuid);
const adminOnly = requireRole('ADMIN');

export const commissionsRouter: Router = Router();

// Reads — any authenticated user (the global auth middleware already blocks
// VIEWER role from any non-GET method).
commissionsRouter.get('/', validate(CommissionListQuery, 'query'), ctl.listHandler);
commissionsRouter.get('/summary', ctl.summaryHandler);
commissionsRouter.get('/:id', requireUuidId, ctl.getByIdHandler);

// State-machine writes — admin only.
// SVT-QA-2026-08 — commission FSM transitions are money-movers (mark-paid
// recognises revenue; waive erases outstanding debt; dispute/resolve-dispute
// flip liability sums). Every neighbouring money-mover in the billing router
// carries requireMfa({enrollmentRequired: true}) + requireIdempotencyKey;
// commissions previously carried neither. Bringing them into line closes a
// SOC2-observable gap where a stolen ADMIN token could touch revenue with
// no fresh TOTP + double-fire on retry.
const moneyMoverGuards = [requireMfa({ enrollmentRequired: true }), requireIdempotencyKey];
commissionsRouter.post('/:id/claim', requireUuidId, adminOnly, ...moneyMoverGuards, ctl.claimHandler);
commissionsRouter.post(
  '/:id/invoice',
  requireUuidId,
  adminOnly,
  ...moneyMoverGuards,
  validate(InvoiceRequest),
  ctl.invoiceHandler,
);
commissionsRouter.post(
  '/:id/mark-paid',
  requireUuidId,
  adminOnly,
  ...moneyMoverGuards,
  validate(MarkPaidRequest),
  ctl.markPaidHandler,
);
commissionsRouter.post(
  '/:id/dispute',
  requireUuidId,
  adminOnly,
  ...moneyMoverGuards,
  validate(DisputeRequest),
  ctl.disputeHandler,
);
commissionsRouter.post(
  '/:id/resolve-dispute',
  requireUuidId,
  adminOnly,
  ...moneyMoverGuards,
  validate(ResolveDisputeRequest),
  ctl.resolveDisputeHandler,
);
commissionsRouter.post('/:id/waive', requireUuidId, adminOnly, ...moneyMoverGuards, ctl.waiveHandler);

// Admin manual edit (monetary correction + notes only).
// SVT-FIN-2026-08 — this writes amount_minor and commission_pct DIRECTLY, which
// makes it the single highest-blast-radius endpoint in the module, yet it was
// the only write here carrying neither MFA step-up nor an Idempotency-Key while
// every FSM transition beside it carried both. A stolen ADMIN token could
// rewrite recognised revenue with one un-stepped-up call. Same guards as its
// siblings now; the service additionally refuses money edits on PAID/WAIVED.
commissionsRouter.patch(
  '/:id',
  requireUuidId,
  adminOnly,
  ...moneyMoverGuards,
  validate(UpdateCommissionRequest),
  ctl.patchHandler,
);
