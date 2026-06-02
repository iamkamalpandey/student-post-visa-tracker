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
  CreateQualificationRequest,
  UpdateQualificationRequest,
  QualificationListQuery,
} from '@spv/zod-schemas';
import { qualificationController as c } from './controller.js';

export const qualificationStudentRouter: Router = Router({ mergeParams: true });
qualificationStudentRouter.use(authenticate, tenantContext);
qualificationStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateQualificationRequest),
  c.create,
);
qualificationStudentRouter.get('/', uuidParam('studentId'), requireStudentOwnership('studentId'), validate(QualificationListQuery, 'query'), c.list);

export const qualificationRouter: Router = Router();
qualificationRouter.use(authenticate, tenantContext);
qualificationRouter.get('/:id', uuidParam('id'), requireStudentOwnershipViaChild('qualification', 'id'), c.get);
qualificationRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('qualification', 'id'),
  validate(UpdateQualificationRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
qualificationRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('qualification', 'id'),
  c.remove,
);
