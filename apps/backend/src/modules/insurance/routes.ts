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
  CreateInsuranceRequest,
  UpdateInsuranceRequest,
  InsuranceListQuery,
} from '@spv/zod-schemas';
import { insuranceController as c } from './controller.js';

export const insuranceStudentRouter: Router = Router({ mergeParams: true });
insuranceStudentRouter.use(authenticate, tenantContext);
insuranceStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateInsuranceRequest),
  c.create,
);
insuranceStudentRouter.get('/', uuidParam('studentId'), validate(InsuranceListQuery, 'query'), c.list);

export const insuranceRouter: Router = Router();
insuranceRouter.use(authenticate, tenantContext);
insuranceRouter.get('/:id', uuidParam('id'), c.get);
insuranceRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('insurance', 'id'),
  validate(UpdateInsuranceRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
insuranceRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('insurance', 'id'),
  c.remove,
);
