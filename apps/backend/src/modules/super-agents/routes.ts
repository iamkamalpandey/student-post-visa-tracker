// Routes for /api/v1/super-agents — admin-only CRUD with list/get reads
// available to any authenticated user (counsellors need the catalogue when
// picking an agent during enrollment, even though they can't mutate it).
//
// Also exposes nested /super-agents/:id/contacts and
// /super-agents/:id/commission-rules sub-routers, plus a metrics endpoint.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CreateSuperAgentRequest,
  SuperAgentListQuery,
  UpdateSuperAgentRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './controller.js';
import { contactsRouter } from './contacts.routes.js';
import { commissionRulesRouter } from './commission-rules.routes.js';

function param(name: string, schema: z.ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return next(BadRequest(`Invalid path parameter: ${name}`));
    }
    req.params[name] = parsed.data as string;
    next();
  };
}

const requireUuidId = param('id', Uuid);

export const superAgentsRouter: Router = Router();

// authenticate + tenantContext are applied at the mount point in app.ts.

superAgentsRouter.get('/', validate(SuperAgentListQuery, 'query'), ctl.listHandler);
superAgentsRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(CreateSuperAgentRequest),
  ctl.createHandler,
);
superAgentsRouter.get('/:id', requireUuidId, ctl.getHandler);
superAgentsRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateSuperAgentRequest),
  ctl.updateHandler,
);
superAgentsRouter.delete(
  '/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteHandler,
);
superAgentsRouter.get('/:id/metrics', requireUuidId, ctl.metricsHandler);
// FE preview of the resolved rate before an enrolment is saved. Reuses the
// commissions resolver so we cannot drift from the value the recalculator
// will persist on CommissionClaim.
superAgentsRouter.get(
  '/:id/resolve-commission',
  requireUuidId,
  ctl.resolveCommissionHandler,
);
// Inverse list to /institutions/:id/super-agents — used by the per-agent
// "Linked institutions" tab on the super-agent detail page.
superAgentsRouter.get(
  '/:id/institutions',
  requireUuidId,
  ctl.listLinkedInstitutionsHandler,
);

// Nested resources
superAgentsRouter.use('/:id/contacts', requireUuidId, contactsRouter);
superAgentsRouter.use('/:id/commission-rules', requireUuidId, commissionRulesRouter);
