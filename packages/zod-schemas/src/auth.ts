import { z } from 'zod';
import { Email, RoleEnum } from './common.js';

// NIST 800-63B: minimum 12 chars, no composition rules required, no forced rotation.
// HIBP breached-password check happens server-side at registration / change.
export const Password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256, 'Password too long');

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1),
  mfa_code: z
    .string()
    .regex(/^\d{6}$/, 'MFA code must be 6 digits')
    .optional(),
  // SVT-SEC-MFA-RECOVERY-2026-05 — alternative to mfa_code when the user has
  // lost their authenticator device. Format: 10 alphanumeric chars (RFC 4648
  // base32 alphabet — no 0/1/8/9), optionally hyphenated XXXXX-XXXXX. Server
  // strips the hyphen before hashing so either form is accepted.
  recovery_code: z
    .string()
    .regex(/^[A-Z2-7]{5}-?[A-Z2-7]{5}$/i, 'Recovery code must be 10 base32 chars')
    .optional(),
  remember_device: z.boolean().optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ChangePasswordRequest = z.object({
  current_password: z.string().min(1),
  new_password: Password,
});

// SVT-SEC-2026-05 — self-service password reset. Always 200; defeat enum.
export const RequestPasswordResetRequest = z
  .object({ email: z.string().email() })
  .strict();
export type RequestPasswordResetRequest = z.infer<typeof RequestPasswordResetRequest>;

export const ConfirmPasswordResetRequest = z
  .object({
    token: z.string().min(32).max(200),
    new_password: Password,
  })
  .strict();
export type ConfirmPasswordResetRequest = z.infer<typeof ConfirmPasswordResetRequest>;

// SVT-SEC-2026-05 — MFA enrol / verify / disable.
// SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — setupMfa must re-verify the
// current password BEFORE rotating the TOTP secret. Otherwise a session
// hijacker who captures an access token can:
//   1. POST /auth/mfa/setup → server mints a fresh secret bound to the user.
//   2. POST /auth/mfa/verify with the attacker's authenticator output.
//   3. Permanently bind THEIR authenticator to the victim's account.
// Adding the current_password requirement closes the pivot: a hijacked
// session alone (no password) cannot complete enrolment.
export const SetupMfaRequest = z
  .object({ current_password: z.string().min(1) })
  .strict();
export type SetupMfaRequest = z.infer<typeof SetupMfaRequest>;

export const VerifyMfaRequest = z
  .object({ code: z.string().regex(/^\d{6}$/, 'MFA code must be 6 digits') })
  .strict();
export type VerifyMfaRequest = z.infer<typeof VerifyMfaRequest>;

export const DisableMfaRequest = z
  .object({ current_password: z.string().min(1) })
  .strict();
export type DisableMfaRequest = z.infer<typeof DisableMfaRequest>;

export const RefreshRequest = z.object({
  // refresh token is delivered via httpOnly cookie; keep body for cross-origin clients
  refresh_token: z.string().optional(),
});

export const NotificationDigestEnum = z.enum(['PER_EVENT', 'DAILY', 'OFF']);
export type NotificationDigest = z.infer<typeof NotificationDigestEnum>;

export const AuthUserResponse = z.object({
  id: z.string(),
  tenant_id: z.string(),
  email: Email,
  given_name: z.string(),
  family_name: z.string(),
  display_name: z.string().nullable(),
  role: RoleEnum,
  locale: z.string(),
  timezone: z.string(),
  mfa_enabled: z.boolean(),
  notifications_email_enabled: z.boolean(),
  notifications_digest: NotificationDigestEnum,
});
export type AuthUserResponse = z.infer<typeof AuthUserResponse>;

// SVT-WAVE9-PREFS-2026-05 — self-service preferences. Endpoint: PATCH /auth/me
// gates only the fields users can change about themselves (preferences,
// display name, locale). Role / is_active / email stay admin-only via
// PATCH /users/:id.
export const UpdateMyPreferencesRequest = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    locale: z.string().min(2).max(20).optional(),
    timezone: z.string().min(2).max(60).optional(),
    notifications_email_enabled: z.boolean().optional(),
    notifications_digest: NotificationDigestEnum.optional(),
  })
  .strict();
export type UpdateMyPreferencesRequest = z.infer<typeof UpdateMyPreferencesRequest>;

export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  user: AuthUserResponse,
});
export type TokenResponse = z.infer<typeof TokenResponse>;
