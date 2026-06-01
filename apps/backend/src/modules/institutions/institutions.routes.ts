import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CreateCampusRequest,
  CreateDepartmentRequest,
  CreateInstitutionAccreditationRequest,
  CreateInstitutionContactRequest,
  CreateInstitutionIdentifierRequest,
  CreateInstitutionRequest,
  CreateSchoolRequest,
  InstitutionListQuery,
  UpdateCampusRequest,
  UpdateDepartmentRequest,
  UpdateInstitutionRequest,
  UpdateSchoolRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './institutions.controller.js';

// Validates `req.params.<name>` against a Zod schema and rewrites the parsed value
// back. Express types are loose at runtime so we feed the raw string in.
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

export const institutionsRouter: Router = Router();

// NOTE: authenticate + tenantContext are applied in app.ts before this router is mounted.

// ---------------------------------------------------------------------------
// Collection / item
// ---------------------------------------------------------------------------
institutionsRouter.get('/', validate(InstitutionListQuery, 'query'), ctl.listHandler);
institutionsRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(CreateInstitutionRequest),
  ctl.createHandler,
);
institutionsRouter.get('/:id', requireUuidId, ctl.getByIdHandler);
institutionsRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateInstitutionRequest),
  ctl.updateHandler,
);
institutionsRouter.delete('/:id', requireUuidId, requireRole('ADMIN'), ctl.softDeleteHandler);

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------
institutionsRouter.get('/:id/identifiers', requireUuidId, ctl.listIdentifiersHandler);
institutionsRouter.post(
  '/:id/identifiers',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateInstitutionIdentifierRequest),
  ctl.createIdentifierHandler,
);
institutionsRouter.delete(
  '/identifiers/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteIdentifierHandler,
);

// ---------------------------------------------------------------------------
// Accreditations
// ---------------------------------------------------------------------------
institutionsRouter.get('/:id/accreditations', requireUuidId, ctl.listAccreditationsHandler);
institutionsRouter.post(
  '/:id/accreditations',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateInstitutionAccreditationRequest),
  ctl.createAccreditationHandler,
);
institutionsRouter.delete(
  '/accreditations/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteAccreditationHandler,
);

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
institutionsRouter.get('/:id/contacts', requireUuidId, ctl.listContactsHandler);
institutionsRouter.post(
  '/:id/contacts',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateInstitutionContactRequest),
  ctl.createContactHandler,
);
institutionsRouter.delete(
  '/contacts/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteContactHandler,
);

// ---------------------------------------------------------------------------
// Campuses
// ---------------------------------------------------------------------------
institutionsRouter.get('/:id/campuses', requireUuidId, ctl.listCampusesHandler);
institutionsRouter.post(
  '/:id/campuses',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateCampusRequest),
  ctl.createCampusHandler,
);
institutionsRouter.patch(
  '/campuses/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateCampusRequest),
  ctl.updateCampusHandler,
);
institutionsRouter.delete(
  '/campuses/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteCampusHandler,
);

// ---------------------------------------------------------------------------
// Schools / Departments
// ---------------------------------------------------------------------------
institutionsRouter.get('/:id/schools', requireUuidId, ctl.listSchoolsHandler);
institutionsRouter.post(
  '/:id/schools',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateSchoolRequest),
  ctl.createSchoolHandler,
);
institutionsRouter.patch(
  '/schools/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateSchoolRequest),
  ctl.updateSchoolHandler,
);
institutionsRouter.delete(
  '/schools/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteSchoolHandler,
);

institutionsRouter.post(
  '/schools/:id/departments',
  requireUuidId,
  requireRole('ADMIN'),
  validate(CreateDepartmentRequest),
  ctl.createDepartmentHandler,
);
institutionsRouter.patch(
  '/departments/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateDepartmentRequest),
  ctl.updateDepartmentHandler,
);
institutionsRouter.delete(
  '/departments/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteDepartmentHandler,
);
