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
  CreateSponsorRequest,
  UpdateSponsorRequest,
  SponsorListQuery,
  CreateSponsorshipRequest,
  UpdateSponsorshipRequest,
  SponsorshipListQuery,
} from '@spv/zod-schemas';
import { sponsorController, sponsorshipController } from './controller.js';

// /api/v1/sponsors — tenant-global resource; no parent student, so ownership
// gating does not apply. Routes left untouched intentionally.
export const sponsorRouter: Router = Router();
sponsorRouter.use(authenticate, tenantContext);
sponsorRouter.post('/', requireRole('ADMIN', 'COUNSELLOR'), validate(CreateSponsorRequest), sponsorController.create);
sponsorRouter.get('/', validate(SponsorListQuery, 'query'), sponsorController.list);
sponsorRouter.get('/:id', uuidParam('id'), sponsorController.get);
sponsorRouter.patch('/:id', uuidParam('id'), requireRole('ADMIN', 'COUNSELLOR'), validate(UpdateSponsorRequest), sponsorController.update);
sponsorRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN'), sponsorController.remove);

// /api/v1/students/:studentId/sponsorships
export const sponsorshipStudentRouter: Router = Router({ mergeParams: true });
sponsorshipStudentRouter.use(authenticate, tenantContext);
sponsorshipStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  validate(CreateSponsorshipRequest),
  sponsorshipController.create,
);
// SVT-AUDIT-SEC-2026-05 — ownership gate added.
sponsorshipStudentRouter.get(
  '/',
  uuidParam('studentId'),
  requireStudentOwnership('studentId'),
  validate(SponsorshipListQuery, 'query'),
  sponsorshipController.list,
);


// /api/v1/sponsorships/:id
export const sponsorshipRouter: Router = Router();
sponsorshipRouter.use(authenticate, tenantContext);
sponsorshipRouter.get('/:id', uuidParam('id'), requireStudentOwnershipViaChild('sponsorship', 'id'), sponsorshipController.get);
sponsorshipRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnershipViaChild('sponsorship', 'id'),
  validate(UpdateSponsorshipRequest),
  sponsorshipController.update,
);
// SVT-RBAC-OWN-2026-05: loosen DELETE from ADMIN-only to ADMIN+COUNSELLOR with ownership
sponsorshipRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnershipViaChild('sponsorship', 'id'),
  sponsorshipController.remove,
);
