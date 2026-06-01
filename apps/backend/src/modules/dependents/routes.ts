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
  CreateDependentRequest,
  UpdateDependentRequest,
  DependentListQuery,
} from '@spv/zod-schemas';
import { dependentController as c } from './controller.js';

export const dependentStudentRouter: Router = Router({ mergeParams: true });
dependentStudentRouter.use(authenticate, tenantContext);
dependentStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateDependentRequest),
  c.create,
);
dependentStudentRouter.get('/', uuidParam('studentId'), validate(DependentListQuery, 'query'), c.list);

export const dependentRouter: Router = Router();
dependentRouter.use(authenticate, tenantContext);
dependentRouter.get('/:id', uuidParam('id'), c.get);
dependentRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('dependent', 'id'),
  validate(UpdateDependentRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
dependentRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('dependent', 'id'),
  c.remove,
);
