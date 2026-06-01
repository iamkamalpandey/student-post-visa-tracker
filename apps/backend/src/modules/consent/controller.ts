import type { Request, Response, NextFunction } from 'express';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { consentService as svc } from './service.js';

export const consentController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'consents.create' }, () =>
        svc.create(req as never, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await svc.list(req as never, req.query as never);
      res.json({ data: rows, page: { total: Array.isArray(rows) ? rows.length : 0 } });
    } catch (e) { next(e); }
  },
  async get(req: Request, res: Response, next: NextFunction) {
    try { res.json(await svc.get(req as never, req.params['id']!)); } catch (e) { next(e); }
  },
  async revoke(req: Request, res: Response, next: NextFunction) {
    try {
      // Idempotency-key supported so a retried POST /revoke doesn't double-stamp
      // revoked_at (service is also idempotent — belt + braces).
      await runIdempotent(req, res, { scope: 'consents.revoke', parentKey: req.params['id'] }, () =>
        svc.revoke(req as never, req.params['id']!),
      );
    } catch (e) { next(e); }
  },
};
