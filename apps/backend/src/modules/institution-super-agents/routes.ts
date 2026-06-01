// Routes mounted under /api/v1/institutions/:id/super-agents — admin-only
// link/unlink between an institution and a super-agent. Reads are open to
// any authenticated user so counsellors can see which agents are available
// for an institution.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CreateInstitutionSuperAgentRequest,
  UpdateInstitutionSuperAgentRequest,
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
      return next(BadRequest(`Invalid path parameter: ${name}`));
    }
    req.params[name] = parsed.data as string;
    next();
  };
}

const requireUuidId = param('id', Uuid);
const requireUuidLinkId = param('linkId', Uuid);

// `mergeParams: true` so :id is visible from the parent mount.
export const institutionSuperAgentsRouter: Router = Router({ mergeParams: true });

institutionSuperAgentsRouter.get('/', requireUuidId, ctl.listHandler);
institutionSuperAgentsRouter.post(
  '/',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateInstitutionSuperAgentRequest),
  ctl.createHandler,
);
institutionSuperAgentsRouter.patch(
  '/:linkId',
  requireUuidId,
  requireUuidLinkId,
  requireRole('ADMIN'),
  validate(UpdateInstitutionSuperAgentRequest),
  ctl.updateHandler,
);
institutionSuperAgentsRouter.delete(
  '/:linkId',
  requireUuidId,
  requireUuidLinkId,
  requireRole('ADMIN'),
  ctl.deleteHandler,
);
