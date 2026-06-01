import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CreateStageRequest,
  CreateTransitionRequest,
  PreviewImpactRequest,
  ReorderStagesRequest,
  UpdateStageRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './stages.controller.js';

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

export const stagesRouter: Router = Router();

// authenticate + tenantContext are applied at the mount point in app.ts.

// IMPORTANT: more specific routes (/transitions, /reorder, /preview-impact) must be
// declared BEFORE the parameterised /:id route — otherwise Express matches them as
// an :id with literal value "transitions" etc.
stagesRouter.get('/transitions', ctl.listTransitionsHandler);
stagesRouter.post(
  '/transitions',
  requireRole('ADMIN'),
  validate(CreateTransitionRequest),
  ctl.createTransitionHandler,
);
stagesRouter.delete(
  '/transitions/:id',
  param('id', Uuid),
  requireRole('ADMIN'),
  ctl.deleteTransitionHandler,
);

stagesRouter.post(
  '/reorder',
  requireRole('ADMIN'),
  validate(ReorderStagesRequest),
  ctl.reorderHandler,
);

stagesRouter.post(
  '/preview-impact',
  requireRole('ADMIN'),
  validate(PreviewImpactRequest),
  ctl.previewImpactHandler,
);

// Generic stage CRUD
stagesRouter.get('/', ctl.listHandler);
stagesRouter.post('/', requireRole('ADMIN'), validate(CreateStageRequest), ctl.createHandler);
stagesRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateStageRequest),
  ctl.updateHandler,
);
stagesRouter.delete('/:id', requireUuidId, requireRole('ADMIN'), ctl.deleteHandler);
