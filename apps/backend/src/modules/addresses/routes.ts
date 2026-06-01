import { Router } from 'express';
import { authenticate, requireRole, requireStudentOwnership } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import {
  CreateAddressRequest,
  UpdateAddressRequest,
  AddressListQuery,
  CreateStudentAddressRequest,
  UpdateStudentAddressRequest,
} from '@spv/zod-schemas';
import { addressController, studentAddressController } from './controller.js';

// /api/v1/addresses
export const addressRouter: Router = Router();
addressRouter.use(authenticate, tenantContext);
addressRouter.post('/', requireRole('ADMIN', 'COUNSELLOR'), validate(CreateAddressRequest), addressController.create);
addressRouter.get('/', validate(AddressListQuery, 'query'), addressController.list);
addressRouter.get('/:id', uuidParam('id'), addressController.get);
addressRouter.patch('/:id', uuidParam('id'), requireRole('ADMIN', 'COUNSELLOR'), validate(UpdateAddressRequest), addressController.update);
addressRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN'), addressController.remove);

// /api/v1/students/:studentId/addresses (StudentAddress link table)
// SVT-AUDIT-SEC-2026-05 — per-student link rows must enforce ownership of
// the parent student. The shared `Address` table above stays open since
// addresses are tenant-wide reference data reused across students.
export const studentAddressRouter: Router = Router({ mergeParams: true });
studentAddressRouter.use(authenticate, tenantContext);
studentAddressRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnership('studentId'),
  validate(CreateStudentAddressRequest),
  studentAddressController.create,
);
studentAddressRouter.get(
  '/',
  uuidParam('studentId'),
  requireStudentOwnership('studentId'),
  studentAddressController.list,
);
studentAddressRouter.get(
  '/:id',
  uuidParam('studentId'),
  uuidParam('id'),
  requireStudentOwnership('studentId'),
  studentAddressController.get,
);
studentAddressRouter.patch(
  '/:id',
  uuidParam('studentId'),
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnership('studentId'),
  validate(UpdateStudentAddressRequest),
  studentAddressController.update,
);
studentAddressRouter.delete(
  '/:id',
  uuidParam('studentId'),
  uuidParam('id'),
  requireRole('ADMIN'),
  studentAddressController.remove,
);
