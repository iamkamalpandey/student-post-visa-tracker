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
  CreateVisaRequest,
  UpdateVisaRequest,
  VisaListQuery,
} from '@spv/zod-schemas';
import { visaController as c } from './controller.js';

export const visaStudentRouter: Router = Router({ mergeParams: true });
visaStudentRouter.use(authenticate, tenantContext);
visaStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateVisaRequest),
  c.create,
);
visaStudentRouter.get('/', uuidParam('studentId'), validate(VisaListQuery, 'query'), c.list);

export const visaRouter: Router = Router();
visaRouter.use(authenticate, tenantContext);
visaRouter.get('/:id', uuidParam('id'), c.get);
visaRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('visa', 'id'),
  validate(UpdateVisaRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
visaRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('visa', 'id'),
  c.remove,
);
