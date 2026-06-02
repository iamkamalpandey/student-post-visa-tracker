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
  CreateComplianceRequest,
  UpdateComplianceRequest,
  ComplianceListQuery,
} from '@spv/zod-schemas';
import { complianceController as c } from './controller.js';

export const complianceStudentRouter: Router = Router({ mergeParams: true });
complianceStudentRouter.use(authenticate, tenantContext);
complianceStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateComplianceRequest),
  c.create,
);
complianceStudentRouter.get('/', uuidParam('studentId'), requireStudentOwnership('studentId'), validate(ComplianceListQuery, 'query'), c.list);

export const complianceRouter: Router = Router();
complianceRouter.use(authenticate, tenantContext);
complianceRouter.get('/:id', uuidParam('id'), requireStudentOwnershipViaChild('compliance', 'id'), c.get);
complianceRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('compliance', 'id'),
  validate(UpdateComplianceRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
complianceRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('compliance', 'id'),
  c.remove,
);
