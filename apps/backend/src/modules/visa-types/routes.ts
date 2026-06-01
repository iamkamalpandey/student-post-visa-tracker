// Routes for /api/v1/visa-types — admin-only CRUD with list reads available
// to any authenticated user (counsellors need to know the catalogue when
// editing students, even though they can't mutate the catalogue itself).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CreateVisaTypeRequest,
  UpdateVisaTypeRequest,
  Uuid,
  VisaTypeListQuery,
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

export const visaTypesRouter: Router = Router();

// authenticate + tenantContext are applied at the mount point in app.ts.

visaTypesRouter.get('/', validate(VisaTypeListQuery, 'query'), ctl.listHandler);
visaTypesRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(CreateVisaTypeRequest),
  ctl.createHandler,
);
visaTypesRouter.get('/:id', requireUuidId, ctl.getHandler);
visaTypesRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateVisaTypeRequest),
  ctl.updateHandler,
);
visaTypesRouter.delete('/:id', requireUuidId, requireRole('ADMIN'), ctl.deleteHandler);
