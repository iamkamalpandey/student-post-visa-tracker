// Thin Express handlers for /auth. All real work lives in auth.service.ts. Each
// handler is async and rethrows via next(err) so the global errorHandler produces
// RFC 7807 responses.

import type { Request, Response, NextFunction } from 'express';

import { jwks as jwksKeySet } from '../../shared/jwt.js';
import { setRefreshCookie, clearRefreshCookie, readRefreshCookie } from '../../shared/cookies.js';

import { authService } from './auth.service.js';
import type { LoginRequest, ChangePasswordRequest, AuthContext } from './auth.types.js';
import { writeAudit } from '../../shared/audit.js';
import type { UpdateMyPreferencesRequest } from '@spv/zod-schemas';

/** Pull the standard request context (ip, ua, request id) out of an Express req. */
function ctxFrom(req: Request): AuthContext {
  return {
    ip: req.ip,
    ua: req.header('user-agent') ?? undefined,
    deviceId: req.header('x-device-id') ?? undefined,
    requestId: req.requestId,
  };
}

export const authController = {
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as LoginRequest;
      const result = await authService.login(body, ctxFrom(req));
      setRefreshCookie(res, result.refreshTokenRaw);
      res.status(200).json(result.tokens);
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // SVT-SEC-REFRESH-CSRF-2026-05 (P1-9) — refresh token comes ONLY from
      // the SameSite=Strict HttpOnly cookie. The previous body fallback
      // (`req.body.refresh_token`) is removed:
      //   - It defeated the purpose of HttpOnly storage by surfacing the
      //     token to any JS that managed to mint a fetch with credentials.
      //   - Combined with SameSite=Lax it widened the CSRF window — a
      //     forged cross-site POST could carry an attacker-controlled body
      //     while the browser auto-attached the victim's cookie, letting
      //     the attacker shape the refresh attempt.
      //   - It enabled XSS-to-account-takeover: any single XSS that could
      //     read storage could POST the captured refresh token here and
      //     pivot to a long-lived session.
      // Cross-origin clients that historically used the body fallback must
      // now configure their fetcher with `credentials: 'include'` and
      // share an origin with the API (same-site).
      const raw = readRefreshCookie(req) ?? '';
      const result = await authService.refresh(raw, ctxFrom(req));
      setRefreshCookie(res, result.refreshTokenRaw);
      res.status(200).json(result.tokens);
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cookieToken = readRefreshCookie(req);
      // The access JTI may or may not be present — logout works either way.
      const accessJti = req.user?.jti ?? null;
      // SVT-SEC-2026-05 — pass real actor context so the JTI denylist row
      // carries the actual user_id/tenant_id rather than sentinel zeros.
      await authService.logout(cookieToken, accessJti, {
        userId: req.user?.sub ?? null,
        tenantId: req.user?.tid ?? null,
      });
      clearRefreshCookie(res);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },

  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // authenticate middleware guarantees req.user; reload from DB so a recently
      // deactivated account or role change is reflected immediately.
      if (!req.user) {
        // Defensive — middleware should have already 401'd.
        res.status(401).end();
        return;
      }
      const user = await authService.getMe(req.user.sub, req.user.tid);
      res.status(200).json(user);
    } catch (err) {
      next(err);
    }
  },

  // SVT-WAVE9-PREFS-2026-05 — PATCH /auth/me for user-self-service prefs.
  // No admin gate; the route only mutates the authenticated user's own row.
  async updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).end();
        return;
      }
      const body = req.body as UpdateMyPreferencesRequest;
      const before = await authService.getMe(req.user.sub, req.user.tid);
      const after = await authService.updateMyPreferences(req.user.sub, body, req.user.tid);
      await writeAudit({
        tenantId: req.user.tid,
        actorId: req.user.sub,
        action: 'user.preferences.updated',
        entityType: 'user',
        entityId: req.user.sub,
        before,
        after,
      });
      res.status(200).json(after);
    } catch (err) {
      next(err);
    }
  },

  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).end();
        return;
      }
      const body = req.body as ChangePasswordRequest;
      await authService.changePassword(req.user.sub, body.current_password, body.new_password, req.user.tid);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },

  // SVT-SEC-2026-05 — self-service password reset.
  // Always returns 200 to defeat email enumeration.
  async requestPasswordReset(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as { email: string };
      const { requestPasswordReset } = await import('./password-reset.service.js');
      await requestPasswordReset(body.email, {
        ip: req.ip ?? null,
        ua: req.header('user-agent') ?? null,
      });
      res.status(200).json({
        message: 'If an account with that email exists, a reset link has been sent.',
      });
    } catch (err) {
      next(err);
    }
  },

  async confirmPasswordReset(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as { token: string; new_password: string };
      const { confirmPasswordReset } = await import('./password-reset.service.js');
      await confirmPasswordReset(body.token, body.new_password);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },

  // SVT-SEC-2026-05 — MFA enrolment.
  // SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — body MUST carry
  // current_password; the service rejects 401 if the password fails to
  // verify against the stored argon2 hash. Validated by the route-level
  // SetupMfaRequest zod schema before reaching here.
  async setupMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) { res.status(401).end(); return; }
      const body = req.body as { current_password: string };
      const { setupMfa } = await import('./mfa.service.js');
      const result = await setupMfa(req.user.sub, body.current_password);
      res.status(200).json(result);
    } catch (err) { next(err); }
  },

  async verifyMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) { res.status(401).end(); return; }
      const { verifyAndEnableMfa } = await import('./mfa.service.js');
      const body = req.body as { code: string };
      const result = await verifyAndEnableMfa(req.user.sub, body.code);
      res.status(200).json(result);
    } catch (err) { next(err); }
  },

  async disableMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) { res.status(401).end(); return; }
      const { disableMfa } = await import('./mfa.service.js');
      const body = req.body as { current_password: string };
      await disableMfa(req.user.sub, body.current_password);
      res.status(204).end();
    } catch (err) { next(err); }
  },

  async jwks(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const keys = await jwksKeySet();
      // Cache for an hour at the edge; clients should also cache.
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
      res.status(200).json(keys);
    } catch (err) {
      next(err);
    }
  },
};
