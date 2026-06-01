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
  CreateEngagementRequest,
  UpdateEngagementRequest,
  EngagementListQuery,
} from '@spv/zod-schemas';
import { engagementController as c } from './controller.js';

export const engagementStudentRouter: Router = Router({ mergeParams: true });
engagementStudentRouter.use(authenticate, tenantContext);
engagementStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateEngagementRequest),
  c.create,
);
engagementStudentRouter.get('/', uuidParam('studentId'), validate(EngagementListQuery, 'query'), c.list);

export const engagementRouter: Router = Router();
engagementRouter.use(authenticate, tenantContext);
engagementRouter.get('/:id', uuidParam('id'), c.get);
engagementRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('engagement', 'id'),
  validate(UpdateEngagementRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
engagementRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('engagement', 'id'),
  c.remove,
);
