import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  AdvanceStageRequest,
  CreateStudentRequest,
  StudentListQuery,
  UpdateStudentRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireRole, requireStudentOwnership } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './students.controller.js';

// Validates `req.params.<name>` against a Zod schema and rewrites the parsed value
// back. Express types are loose at runtime so we feed the raw string in.
function param(name: string, schema: z.ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return next(BadRequest(`Invalid path parameter: ${name}`, parsed.error.issues.map((i) => ({
        path: i.path.join('.') || name,
        message: i.message,
        code: i.code,
      }))));
    }
    req.params[name] = parsed.data as string;
    next();
  };
}

const requireUuidId = param('id', Uuid);

export const studentsRouter: Router = Router();

// authenticate + tenantContext are applied at the mount point in app.ts.
// All routes here therefore assume req.user and req.db are populated.

// Collection
studentsRouter.get('/', validate(StudentListQuery, 'query'), ctl.listHandler);
studentsRouter.post(
  '/',
  // Idempotency-Key handling lives in a future shared middleware; not required for v1.
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(CreateStudentRequest),
  ctl.createHandler,
);

// Item
// SVT-SEC-2026-05 — ownership-gate reads too. A COUNSELLOR could previously
// read every student's PII + lifecycle in the tenant by URL-bashing /:id.
// ADMIN bypasses via the middleware. Matches Salesforce/HubSpot baseline.
studentsRouter.get('/:id', requireUuidId, requireStudentOwnership('id'), ctl.getByIdHandler);
studentsRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: COUNSELLOR can only edit own-assigned students;
  // ADMIN bypasses. Closes cross-counsellor PII tamper gap.
  requireStudentOwnership('id'),
  validate(UpdateStudentRequest),
  ctl.updateHandler,
);
studentsRouter.delete('/:id', requireUuidId, requireRole('ADMIN'), ctl.softDeleteHandler);

// Sub-resources
// SVT-SEC-2026-05 — timeline + completeness exposed PII before the SEC burst.
studentsRouter.get(
  '/:id/timeline',
  requireUuidId,
  requireStudentOwnership('id'),
  ctl.timelineHandler,
);
studentsRouter.post(
  '/:id/transitions',
  requireUuidId,
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: stage advances are KPI-affecting; only the assigned
  // counsellor (or ADMIN) may advance.
  requireStudentOwnership('id'),
  validate(AdvanceStageRequest),
  ctl.advanceStageHandler,
);
studentsRouter.get(
  '/:id/completeness',
  requireUuidId,
  requireStudentOwnership('id'),
  ctl.completenessHandler,
);
