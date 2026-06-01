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
  CreateAccommodationRequest,
  UpdateAccommodationRequest,
  AccommodationListQuery,
} from '@spv/zod-schemas';
import { accommodationController as c } from './controller.js';

export const accommodationStudentRouter: Router = Router({ mergeParams: true });
accommodationStudentRouter.use(authenticate, tenantContext);
accommodationStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateAccommodationRequest),
  c.create,
);
accommodationStudentRouter.get('/', uuidParam('studentId'), validate(AccommodationListQuery, 'query'), c.list);

export const accommodationRouter: Router = Router();
accommodationRouter.use(authenticate, tenantContext);
accommodationRouter.get('/:id', uuidParam('id'), c.get);
accommodationRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('accommodation', 'id'),
  validate(UpdateAccommodationRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
accommodationRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('accommodation', 'id'),
  c.remove,
);
