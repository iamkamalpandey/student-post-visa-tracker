import { Router } from 'express';
import {
  authenticate,
  requireRole,
  requireStudentOwnership,
  requireStudentOwnershipViaChild,
} from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import {
  CreateEmploymentRequest,
  UpdateEmploymentRequest,
  EmploymentListQuery,
} from '@spv/zod-schemas';
import { employmentController as c } from './controller.js';

export const employmentStudentRouter: Router = Router({ mergeParams: true });
employmentStudentRouter.use(authenticate, tenantContext);
employmentStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateEmploymentRequest),
  c.create,
);
employmentStudentRouter.get('/', uuidParam('studentId'), requireStudentOwnership('studentId'), validate(EmploymentListQuery, 'query'), c.list);

export const employmentRouter: Router = Router();
employmentRouter.use(authenticate, tenantContext);
employmentRouter.get('/:id', uuidParam('id'), requireStudentOwnershipViaChild('employment', 'id'), c.get);
employmentRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('employment', 'id'),
  validate(UpdateEmploymentRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
employmentRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('employment', 'id'),
  c.remove,
);
