import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CreateEnrollmentRequest,
  EnrollmentListQuery,
  UpdateEnrollmentRequest,
  Uuid,
} from '@spv/zod-schemas';

import {
  requireRole,
  requireStudentOwnership,
  requireStudentOwnershipViaChild,
} from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './enrollments.controller.js';

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
const requireUuidStudentId = param('studentId', Uuid);

// ---------------------------------------------------------------------------
// Cross-student admin views — mounted at /api/v1/enrollments
// ---------------------------------------------------------------------------
export const enrollmentsRouter: Router = Router();

enrollmentsRouter.get('/', validate(EnrollmentListQuery, 'query'), ctl.listHandler);
// SVT-AUDIT-SEC-2026-05 — ownership gate on tenant-wide enrollment routes.
// Without this a COUNSELLOR could PATCH/read any other counsellor's enrollments
// (commission %, tuition totals, status). ADMIN bypasses the check.
enrollmentsRouter.get(
  '/:id',
  requireUuidId,
  requireStudentOwnershipViaChild('enrollment', 'id'),
  ctl.getByIdHandler,
);
enrollmentsRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('enrollment', 'id'),
  validate(UpdateEnrollmentRequest),
  ctl.updateHandler,
);
enrollmentsRouter.delete('/:id', requireUuidId, requireRole('ADMIN'), ctl.softDeleteHandler);

// ---------------------------------------------------------------------------
// Per-student endpoints — mounted at /api/v1/students/:studentId/enrollments
// ---------------------------------------------------------------------------
// mergeParams allows :studentId from the parent mount path to be visible here.
export const studentEnrollmentsRouter: Router = Router({ mergeParams: true });

studentEnrollmentsRouter.get(
  '/',
  requireUuidStudentId,
  ctl.listForStudentHandler,
);
studentEnrollmentsRouter.post(
  '/',
  requireUuidStudentId,
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateEnrollmentRequest),
  ctl.createForStudentHandler,
);
