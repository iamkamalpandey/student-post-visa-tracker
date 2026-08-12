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
// Read endpoints (GET /users) keep the legacy shape.
//
// SVT-SEC-2026-08 — CREATE now carries the gate too. The original exemption
// reasoned that create "doesn't mutate existing accounts", which is true and
// beside the point: `role` is a client-supplied field on CreateUserRequest and
// RoleEnum includes ADMIN, so an attacker holding a stolen admin access token
// could not PATCH a user, reset a password, revoke sessions or disable anyone's
// MFA — every one of those demands a fresh X-MFA-Code — but could POST a brand
// new ADMIN with a password of their choosing and no MFA enrolled, then simply
// log in as it. That is persistence, and it is worth strictly more to an
// attacker than any of the mutations the gate was protecting.
//
// This is the same correction already applied to /:id/mfa/disable below, which
// was likewise exempt on plausible-sounding reasoning until someone traced what
// a stolen token could actually reach.
//
// No bootstrap deadlock: the first admin is created by prisma/seed.ts, not this
// route, and /auth/mfa/setup + /auth/mfa/verify require only `authenticate`, so
// an unenrolled admin can always self-enrol first. A legacy admin who has not
// enrolled now has to, which is already true for every other mutation here.
usersRouter.get('/', requireRole('ADMIN'), usersController.list);
usersRouter.post(
  '/',
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  validate(CreateUserRequest),
  usersController.create,
);
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
// route the only recovery is direct psql access.
// SVT-QA-2026-08 — was `requireMfa` (bare, pass-through when the acting
// admin is not enrolled). A stolen access token for a non-enrolled admin
// could therefore wipe any other user's MFA without a fresh TOTP. Upgraded
// to `{enrollmentRequired: true}` to match every other privileged mutation
// on this router. Legacy admins must enrol MFA before using this endpoint.
usersRouter.post(
  '/:id/mfa/disable',
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  uuidParam('id'),
  validate(AdminDisableMfaRequest),
  usersController.adminDisableMfa,
);
