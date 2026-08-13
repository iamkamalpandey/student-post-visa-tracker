import type { Request, Response, NextFunction } from 'express';
import { usersService } from './users.service.js';
import { Unauthorized } from '../../shared/errors.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { withTenantTx } from '../../shared/tenantTx.js';
import type {
  CreateUserRequest,
  UpdateUserRequest,
  ResetPasswordRequest,
  AdminDisableMfaRequest,
} from '@spv/zod-schemas';

const tenant = (req: Request) => {
  if (!req.user?.tid) throw Unauthorized();
  return req.user.tid;
};

export const usersController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 25)));
      const search = req.query['search'] ? String(req.query['search']) : undefined;
      const cursor = req.query['cursor'] ? String(req.query['cursor']) : undefined;
      // SVT-LOOKUP-FILTERS-2026-05: assignee picker passes ?active_only=true
      // so soft-deleted/disabled accounts don't show up in dropdowns.
      const activeOnlyRaw = req.query['active_only'];
      const activeOnly = activeOnlyRaw === 'true' || activeOnlyRaw === '1';
      const result = await usersService.list({
        tenantId: tenant(req),
        limit,
        // SVT-RLS-2026-05: route through the per-request RLS-scoped client.
        ...(req.db ? { db: req.db } : {}),
        ...(cursor ? { cursor } : {}),
        ...(search ? { search } : {}),
        ...(activeOnly ? { activeOnly: true } : {}),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user?.sub) throw Unauthorized();
      const created = await usersService.create(
        tenant(req),
        req.body as CreateUserRequest,
        req.user.sub,
        req.db,
      );
      res.status(201).json({ data: created });
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await usersService.getById(tenant(req), req.params['id']!, req.db);
      res.json({ data: user });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw new Error('unauthenticated');
      // SVT-IF-MATCH-2026-05 — User has no `version` column; accept If-Match
      // header for API parity but treat it as a no-op (parser still validates
      // syntax → 412 on malformed values per RFC 7232 §3.1).
      const expected = readIfMatch(req);
      // SVT-SEC-ROLE-MFA-2026-05 (P0-2) — surface the acting admin's MFA
      // state to the service so role mutations can require it. mfa_enabled
      // comes from a fresh user lookup (the JWT does not carry it, and a
      // user could have disabled MFA after the token was issued);
      // mfaVerifiedAt is set by middlewares/requireMfa.ts when the request
      // presented a valid X-MFA-Code header. The route is already gated by
      // `requireMfa` so an MFA-enabled admin always reaches here with
      // mfaVerifiedAt populated; the service check is defence-in-depth.
      // SVT-SEC-2026-08 (T0-7) — `users` is RLS-scoped, so this must use the
      // request-scoped client. On the singleton it returned null under the
      // production role, which silently made actorMfaEnabled false and turned
      // the defence-in-depth role-mutation gate into a hard block on every
      // role change.
      //
      // The fallback must NOT be `null`: that reads as "actor has no MFA" and
      // turns this defence-in-depth check into a hard block on every role
      // change — the same silently-wrong shape as the bug being fixed. Fall
      // back to our own tenant-scoped transaction instead.
      const actorTid = tenant(req);
      const actorSub = req.user.sub;
      const actorRow = req.db
        ? await req.db.user.findFirst({
            where: { id: actorSub, tenant_id: actorTid },
            select: { mfa_enabled: true },
          })
        : await withTenantTx(actorTid, (tx) => tx.user.findFirst({
            where: { id: actorSub, tenant_id: actorTid },
            select: { mfa_enabled: true },
          }));
      const user = await usersService.update(
        tenant(req),
        req.params['id']!,
        req.body as UpdateUserRequest,
        req.user.sub,
        {
          expected,
          actorMfaEnabled: actorRow?.mfa_enabled ?? false,
          actorMfaVerifiedAt: req.mfaVerifiedAt,
        },
        req.db,
      );
      res.json({ data: user });
    } catch (err) {
      next(err);
    }
  },

  async softDelete(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user?.sub) throw Unauthorized();
      await usersService.softDelete(tenant(req), req.params['id']!, req.user.sub, req.db);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },

  async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user?.sub) throw Unauthorized();
      const { new_password } = req.body as ResetPasswordRequest;
      await usersService.resetPassword(
        tenant(req),
        req.params['id']!,
        new_password,
        req.user.sub,
        req.db,
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },

  async revokeAllSessions(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user?.sub) throw Unauthorized();
      const result = await usersService.revokeAllSessions(
        tenant(req),
        req.params['id']!,
        req.user.sub,
        req.db,
      );
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  },

  // SVT-SEC-MFA-FORCE-DISABLE-2026-05 — admin-driven MFA unbrick. Route is
  // gated by `requireMfa` so a stolen ADMIN session alone cannot clear another
  // user's MFA. Self-targeting is blocked by the service (must use the
  // password-stepped /auth/mfa/disable flow on your own account).
  async adminDisableMfa(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user?.sub) throw Unauthorized();
      const { reason } = req.body as AdminDisableMfaRequest;
      await usersService.adminDisableMfa(
        tenant(req),
        req.params['id']!,
        req.user.sub,
        reason,
        req.db,
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
};
