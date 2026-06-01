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
import { CreateTravelRequest, UpdateTravelRequest, TravelListQuery } from '@spv/zod-schemas';
import { travelController } from './controller.js';

// Two routers: one nested under students, one top-level for id-addressed CRUD.
export const travelStudentRouter: Router = Router({ mergeParams: true });
travelStudentRouter.use(authenticate, tenantContext);
travelStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateTravelRequest),
  travelController.create,
);
travelStudentRouter.get('/', uuidParam('studentId'), validate(TravelListQuery, 'query'), travelController.list);

export const travelRouter: Router = Router();
travelRouter.use(authenticate, tenantContext);
travelRouter.get('/:id', uuidParam('id'), travelController.get);
travelRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('travel', 'id'),
  validate(UpdateTravelRequest),
  travelController.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
travelRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('travel', 'id'),
  travelController.remove,
);
