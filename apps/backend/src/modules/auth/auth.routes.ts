// /api/v1/auth router. Wires middlewares (rate limit + zod validate + bearer auth)
// to the thin controller methods. Mounted in app.ts.

import { Router } from 'express';
import {
  LoginRequest,
  ChangePasswordRequest,
  UpdateMyPreferencesRequest,
  RequestPasswordResetRequest,
  ConfirmPasswordResetRequest,
  SetupMfaRequest,
  VerifyMfaRequest,
  DisableMfaRequest,
} from '@spv/zod-schemas';

import { authenticate } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { authLimiter, refreshLimiter } from '../../middlewares/rateLimit.js';
import { originGuard } from '../../middlewares/originGuard.js';
import { requireMfa } from '../../middlewares/requireMfa.js';

import { authController } from './auth.controller.js';

export const authRouter: Router = Router();

// CSRF defence: cookie-bearing endpoints get an Origin allow-list check on top
// of the existing `sameSite: 'lax'` cookie attribute (SVT-CSRF-2026-05).
// `/login` is included for symmetry — it sets the refresh cookie too, so an
// attacker forging cross-site logins could pin a victim to an attacker-owned
// session.
//
// Credentialed endpoints get the stricter per-IP limiter on top of the global one.
authRouter.post('/login', originGuard, authLimiter, validate(LoginRequest), authController.login);
// SVT-SEC-REFRESH-LIMITER-2026-06 — refresh uses the generous refreshLimiter,
// NOT the 5/min login brute-force limiter: the refresh token is unguessable
// (256-bit + single-use rotation + reuse detection) and the SPA refreshes on
// every full page load, so 5/min/IP caused spurious 429→logout for reload-heavy
// or shared-NAT (office) usage. See rateLimit.ts for the full rationale.
authRouter.post('/refresh', originGuard, refreshLimiter, authController.refresh);

// Logout is intentionally NOT rate-limited beyond the global limiter and does NOT
// require a valid bearer — a client whose access token already expired must still
// be able to invalidate the refresh cookie cleanly.
authRouter.post('/logout', originGuard, authController.logout);

authRouter.get('/me', authenticate, authController.me);
// SVT-WAVE9-PREFS-2026-05 — self-service preference update endpoint.
// SVT-SEC-AUDIT-2026-05 — PATCH /me mutates session-pivotable fields
// (notification email channel, locale, timezone) so we gate it behind the
// step-up TOTP check. requireMfa passes through when the caller has not
// enrolled MFA, so existing users without a second factor see no change.
authRouter.patch(
  '/me',
  authenticate,
  requireMfa,
  validate(UpdateMyPreferencesRequest),
  authController.updateMe,
);
// SVT-SEC-AUDIT-2026-05 — change-password is the canonical session-hijack
// pivot. When MFA is enrolled we require an X-MFA-Code header in addition
// to the current_password supplied in the body. Pre-MFA users keep the
// existing password-only flow (requireMfa pass-through).
// SVT-QA-2026-08 — attach authLimiter so a stolen access token can't be
// used to brute-force `current_password` via a rapid endpoint loop. Every
// other password/MFA endpoint carries this limiter; change-password was the
// missing case.
authRouter.post(
  '/change-password',
  authenticate,
  authLimiter,
  requireMfa,
  validate(ChangePasswordRequest),
  authController.changePassword,
);

// SVT-SEC-2026-05 — self-service password reset (P0 deploy blocker per audit).
// Both endpoints rate-limited via authLimiter (5/min/IP) to defeat brute-force
// + enumeration. Request endpoint ALWAYS returns 200 with the same body shape.
authRouter.post(
  '/password/reset-request',
  originGuard,
  authLimiter,
  validate(RequestPasswordResetRequest),
  authController.requestPasswordReset,
);
authRouter.post(
  '/password/reset-confirm',
  originGuard,
  authLimiter,
  validate(ConfirmPasswordResetRequest),
  authController.confirmPasswordReset,
);

// SVT-SEC-2026-05 — MFA enrol / verify / disable.
//   POST /auth/mfa/setup    → returns otpauth_url + raw secret
//                              (REQUIRES current_password — SVT-SEC-MFA-
//                              SETUP-PASSWORD-2026-05 P0-3)
//   POST /auth/mfa/verify   → enables MFA + returns recovery codes ONCE
//   POST /auth/mfa/disable  → step-up re-auth (current_password)
// SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — /mfa/setup now demands the
// current password in the body so a session-hijacker holding only an access
// token cannot complete enrolment with their own authenticator. The
// auth-flow limiter also caps brute force on this endpoint.
authRouter.post(
  '/mfa/setup',
  authLimiter,
  authenticate,
  validate(SetupMfaRequest),
  authController.setupMfa,
);
// SVT-SEC-MFA-BRUTE-2026-05 — /mfa/verify and /mfa/disable accept a 6-digit
// TOTP code, which is brute-forceable in ~10^6 attempts without throttling.
// authLimiter (5/min/IP) brings the wall-clock cost back into the realm of
// "human typo" rather than "automated guesser". /disable also takes the
// current password, so the auth-flow limiter is the natural fit.
authRouter.post(
  '/mfa/verify',
  authLimiter,
  authenticate,
  validate(VerifyMfaRequest),
  authController.verifyMfa,
);
authRouter.post(
  '/mfa/disable',
  authLimiter,
  authenticate,
  validate(DisableMfaRequest),
  authController.disableMfa,
);

// JWKS exposed under /auth/jwks for module-internal use; app.ts may also mount it
// at /.well-known/jwks.json for spec compliance.
authRouter.get('/jwks', authController.jwks);
authRouter.get('/.well-known/jwks.json', authController.jwks);
