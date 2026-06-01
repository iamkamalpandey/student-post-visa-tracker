import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import { requireMfa } from '../../middlewares/requireMfa.js';
import {
  CreateUserRequest,
  UpdateUserRequest,
  ResetPasswordRequest,
  AdminDisableMfaRequest,
} from '@spv/zod-schemas';
import { usersController } from './users.controller.js';

export const usersRouter: Router = Router();

usersRouter.use(authenticate, tenantContext);

// All routes require ADMIN role.
// SVT-SEC-MFA-STEPUP-2026-05 (P1-5 + P1-6) — every admin USER MUTATION route
// is gated by requireMfa({enrollmentRequired:true}) so:
//   (a) the acting admin must have MFA enrolled before they can touch peer
//       accounts (rejects with 403 mfa_enrollment_required otherwise — a
//       legacy admin must enrol before reaching these routes), AND
//   (b) every request carries a fresh X-MFA-Code header (60s replay
//       window, defeats session-hijack pivots from a stolen access token).
// Read endpoints (GET /users) and the role-gated create flow keep the legacy
// shape — they don't mutate existing accounts. PATCH+DELETE+reset-password+
// revoke-sessions are the privileged-pivot surface and ALL get the gate.
usersRouter.get('/', requireRole('ADMIN'), usersController.list);
usersRouter.post('/', requireRole('ADMIN'), validate(CreateUserRequest), usersController.create);
usersRouter.get('/:id', uuidParam('id'), requireRole('ADMIN'), usersController.getById);
usersRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  validate(UpdateUserRequest),
  usersController.update,
);
usersRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  usersController.softDelete,
);
usersRouter.post(
  '/:id/reset-password',
  uuidParam('id'),
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  validate(ResetPasswordRequest),
  usersController.resetPassword,
);
usersRouter.post(
  '/:id/sessions/revoke',
  uuidParam('id'),
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  usersController.revokeAllSessions,
);

// SVT-SEC-MFA-FORCE-DISABLE-2026-05 — admin-driven MFA unbrick when a tenant
// admin loses BOTH their TOTP device AND every recovery code. Without this
// route the only recovery is direct psql access. requireMfa is mounted so a
// captured ADMIN session alone cannot clear another user's second factor.
usersRouter.post(
  '/:id/mfa/disable',
  requireRole('ADMIN'),
  requireMfa,
  uuidParam('id'),
  validate(AdminDisableMfaRequest),
  usersController.adminDisableMfa,
);
