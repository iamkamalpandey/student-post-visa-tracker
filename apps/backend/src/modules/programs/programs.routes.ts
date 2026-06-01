import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CreateProgramFeeRequest,
  CreateProgramIntakeRequest,
  CreateProgramModuleRequest,
  CreateProgramRequest,
  CreateProgramRequirementRequest,
  ProgramListQuery,
  UpdateProgramFeeRequest,
  UpdateProgramIntakeRequest,
  UpdateProgramModuleRequest,
  UpdateProgramRequest,
  UpdateProgramRequirementRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './programs.controller.js';

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
const requireUuidIntakeId = param('intakeId', Uuid);

export const programsRouter: Router = Router();

// NOTE: authenticate + tenantContext are applied in app.ts before this router.

// Programs
programsRouter.get('/', validate(ProgramListQuery, 'query'), ctl.listHandler);
programsRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(CreateProgramRequest),
  ctl.createHandler,
);
programsRouter.get('/:id', requireUuidId, ctl.getByIdHandler);
programsRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateProgramRequest),
  ctl.updateHandler,
);
programsRouter.delete('/:id', requireUuidId, requireRole('ADMIN'), ctl.softDeleteHandler);

// Intakes (nested under :id)
programsRouter.get('/:id/intakes', requireUuidId, ctl.listIntakesHandler);
programsRouter.post(
  '/:id/intakes',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateProgramIntakeRequest),
  ctl.createIntakeHandler,
);
programsRouter.patch(
  '/intakes/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateProgramIntakeRequest),
  ctl.updateIntakeHandler,
);
programsRouter.delete(
  '/intakes/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteIntakeHandler,
);

// Fees (nested under intakes/:intakeId)
programsRouter.get(
  '/intakes/:intakeId/fees',
  requireUuidIntakeId,
  ctl.listFeesHandler,
);
programsRouter.post(
  '/intakes/:intakeId/fees',
  requireUuidIntakeId,
  requireRole('ADMIN'),
  validate(CreateProgramFeeRequest),
  ctl.createFeeHandler,
);
programsRouter.patch(
  '/fees/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateProgramFeeRequest),
  ctl.updateFeeHandler,
);
programsRouter.delete('/fees/:id', requireUuidId, requireRole('ADMIN'), ctl.deleteFeeHandler);

// Requirements
programsRouter.get('/:id/requirements', requireUuidId, ctl.listRequirementsHandler);
programsRouter.post(
  '/:id/requirements',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateProgramRequirementRequest),
  ctl.createRequirementHandler,
);
programsRouter.patch(
  '/requirements/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateProgramRequirementRequest),
  ctl.updateRequirementHandler,
);
programsRouter.delete(
  '/requirements/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteRequirementHandler,
);

// Modules
programsRouter.get('/:id/modules', requireUuidId, ctl.listModulesHandler);
programsRouter.post(
  '/:id/modules',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateProgramModuleRequest),
  ctl.createModuleHandler,
);
programsRouter.patch(
  '/modules/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateProgramModuleRequest),
  ctl.updateModuleHandler,
);
programsRouter.delete(
  '/modules/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteModuleHandler,
);
