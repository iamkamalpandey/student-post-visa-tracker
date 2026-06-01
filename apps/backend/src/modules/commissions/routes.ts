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
commissionsRouter.post('/:id/claim', requireUuidId, adminOnly, ctl.claimHandler);
commissionsRouter.post(
  '/:id/invoice',
  requireUuidId,
  adminOnly,
  validate(InvoiceRequest),
  ctl.invoiceHandler,
);
commissionsRouter.post(
  '/:id/mark-paid',
  requireUuidId,
  adminOnly,
  validate(MarkPaidRequest),
  ctl.markPaidHandler,
);
commissionsRouter.post(
  '/:id/dispute',
  requireUuidId,
  adminOnly,
  validate(DisputeRequest),
  ctl.disputeHandler,
);
commissionsRouter.post(
  '/:id/resolve-dispute',
  requireUuidId,
  adminOnly,
  validate(ResolveDisputeRequest),
  ctl.resolveDisputeHandler,
);
commissionsRouter.post('/:id/waive', requireUuidId, adminOnly, ctl.waiveHandler);

// Admin manual edit (monetary correction + notes only).
commissionsRouter.patch(
  '/:id',
  requireUuidId,
  adminOnly,
  validate(UpdateCommissionRequest),
  ctl.patchHandler,
);
