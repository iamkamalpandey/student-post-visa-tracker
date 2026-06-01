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
  CreateFinanceRequest,
  UpdateFinanceRequest,
  FinanceListQuery,
} from '@spv/zod-schemas';
import { financeController as c } from './controller.js';

export const financeStudentRouter: Router = Router({ mergeParams: true });
financeStudentRouter.use(authenticate, tenantContext);
financeStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateFinanceRequest),
  c.create,
);
financeStudentRouter.get('/', uuidParam('studentId'), validate(FinanceListQuery, 'query'), c.list);

export const financeRouter: Router = Router();
financeRouter.use(authenticate, tenantContext);
financeRouter.get('/:id', uuidParam('id'), c.get);
financeRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('finance', 'id'),
  validate(UpdateFinanceRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
financeRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('finance', 'id'),
  c.remove,
);
