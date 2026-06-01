import { z } from 'zod';
import { Email, RoleEnum } from './common.js';
import { Password } from './auth.js';

export const CreateUserRequest = z
  .object({
    email: Email,
    password: Password,
    given_name: z.string().min(1).max(120),
    family_name: z.string().min(1).max(120),
    display_name: z.string().min(1).max(160).optional(),
    role: RoleEnum.default('COUNSELLOR'),
    // SVT-WAVE25-DEFAULTS-2026-05 — optional. Service inherits tenant
    // default_locale / default_timezone when caller omits.
    locale: z.string().min(2).max(20).optional(),
    timezone: z.string().min(2).max(64).optional(),
  })
  .strict();
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const UpdateUserRequest = z
  .object({
    given_name: z.string().min(1).max(120).optional(),
    family_name: z.string().min(1).max(120).optional(),
    display_name: z.string().min(1).max(160).nullable().optional(),
    role: RoleEnum.optional(),
    is_active: z.boolean().optional(),
    locale: z.string().min(2).max(10).optional(),
    timezone: z.string().min(2).max(64).optional(),
  })
  .strict();
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export const ResetPasswordRequest = z
  .object({
    new_password: Password,
    force_change_on_next_login: z.boolean().default(true),
  })
  .strict();
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

// SVT-SEC-MFA-FORCE-DISABLE-2026-05 — admin-driven MFA unbrick.
//
// When a customer admin loses BOTH their TOTP authenticator AND every recovery
// code, the only previous unbrick path was direct psql access (bricks the
// tenant for the duration). This admin route lets another admin in the same
// tenant force-disable MFA on the locked-out user. A free-form `reason` is
// required and persisted in the audit row so the action is forensically
// reviewable. Self-disable via this endpoint is blocked (the caller must use
// `/auth/mfa/disable` with their current password instead — that's the
// step-up flow this endpoint exists to bypass for ANOTHER user).
export const AdminDisableMfaRequest = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type AdminDisableMfaRequest = z.infer<typeof AdminDisableMfaRequest>;
