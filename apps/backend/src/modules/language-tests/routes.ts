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
  CreateLanguageTestRequest,
  UpdateLanguageTestRequest,
  LanguageTestListQuery,
} from '@spv/zod-schemas';
import { languageTestController as c } from './controller.js';

export const languageTestStudentRouter: Router = Router({ mergeParams: true });
languageTestStudentRouter.use(authenticate, tenantContext);
languageTestStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateLanguageTestRequest),
  c.create,
);
languageTestStudentRouter.get('/', uuidParam('studentId'), requireStudentOwnership('studentId'), validate(LanguageTestListQuery, 'query'), c.list);

export const languageTestRouter: Router = Router();
languageTestRouter.use(authenticate, tenantContext);
languageTestRouter.get('/:id', uuidParam('id'), requireStudentOwnershipViaChild('languageTest', 'id'), c.get);
languageTestRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('languageTest', 'id'),
  validate(UpdateLanguageTestRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
languageTestRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('languageTest', 'id'),
  c.remove,
);
