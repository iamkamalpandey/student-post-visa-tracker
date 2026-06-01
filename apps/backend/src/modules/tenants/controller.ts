import type { Request, Response, NextFunction } from 'express';
import { Unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { tenantSettingsService } from './service.js';
import type { UpdateTenantSettingsRequest } from '@spv/zod-schemas';

export const tenantsController = {
  async getMe(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const result = await tenantSettingsService.getMe(req.user.tid);
      res.json(result);
    } catch (e) { next(e); }
  },

  async updateMe(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      // SVT-IF-MATCH-2026-05 — Tenant has no `version` column; accept If-Match
      // header for API parity but treat it as a no-op (parser still validates
      // syntax → 412 on malformed values per RFC 7232 §3.1).
      const expected = readIfMatch(req);
      const body = req.body as UpdateTenantSettingsRequest;
      const before = await tenantSettingsService.getMe(req.user.tid);
      const after = await tenantSettingsService.updateMe(req.user.tid, body, { expected });
      await writeAudit({
        tenantId: req.user.tid,
        actorId: req.user.sub,
        action: 'tenant.settings.updated',
        entityType: 'tenant',
        entityId: req.user.tid,
        before,
        after,
      });
      res.json(after);
    } catch (e) { next(e); }
  },
};
