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
  CreateRegulatorIdRequest,
  UpdateRegulatorIdRequest,
  RegulatorIdListQuery,
} from '@spv/zod-schemas';
import { regulatorIdController as c } from './controller.js';

export const regulatorIdStudentRouter: Router = Router({ mergeParams: true });
regulatorIdStudentRouter.use(authenticate, tenantContext);
regulatorIdStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateRegulatorIdRequest),
  c.create,
);
regulatorIdStudentRouter.get('/', uuidParam('studentId'), validate(RegulatorIdListQuery, 'query'), c.list);

export const regulatorIdRouter: Router = Router();
regulatorIdRouter.use(authenticate, tenantContext);
regulatorIdRouter.get('/:id', uuidParam('id'), c.get);
regulatorIdRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('regulatorId', 'id'),
  validate(UpdateRegulatorIdRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
regulatorIdRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('regulatorId', 'id'),
  c.remove,
);
