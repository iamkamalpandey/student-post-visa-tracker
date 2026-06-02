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
  CreateContactRequest,
  UpdateContactRequest,
  ContactListQuery,
} from '@spv/zod-schemas';
import { contactController as c } from './controller.js';

export const contactStudentRouter: Router = Router({ mergeParams: true });
contactStudentRouter.use(authenticate, tenantContext);
contactStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnership('studentId'),
  validate(CreateContactRequest),
  c.create,
);
contactStudentRouter.get('/', uuidParam('studentId'), requireStudentOwnership('studentId'), validate(ContactListQuery, 'query'), c.list);

export const contactRouter: Router = Router();
contactRouter.use(authenticate, tenantContext);
contactRouter.get('/:id', uuidParam('id'), requireStudentOwnershipViaChild('contact', 'id'), c.get);
contactRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('contact', 'id'),
  validate(UpdateContactRequest),
  c.update,
);
// SVT-RBAC-OWN-2026-05: allow COUNSELLOR (was ADMIN-only) for own-assigned;
// ADMIN still bypasses ownership. Removes the friction that was forcing
// admins to share credentials for routine cleanup.
contactRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('contact', 'id'),
  c.remove,
);
