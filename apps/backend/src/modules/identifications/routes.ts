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
  CreateIdentificationRequest,
  UpdateIdentificationRequest,
  IdentificationListQuery,
} from '@spv/zod-schemas';
import { identificationController as c } from './controller.js';

export const identificationStudentRouter: Router = Router({ mergeParams: true });
identificationStudentRouter.use(authenticate, tenantContext);
identificationStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateIdentificationRequest),
  c.create,
);
identificationStudentRouter.get('/', uuidParam('studentId'), validate(IdentificationListQuery, 'query'), c.list);

export const identificationRouter: Router = Router();
identificationRouter.use(authenticate, tenantContext);
identificationRouter.get('/:id', uuidParam('id'), c.get);
identificationRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('identification', 'id'),
  validate(UpdateIdentificationRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
identificationRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('identification', 'id'),
  c.remove,
);
