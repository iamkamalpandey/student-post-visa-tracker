import type { Request, Response, NextFunction } from 'express';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { savedViewService as svc } from './service.js';

export const savedViewController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'saved-views.create' }, () =>
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
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const expected = readIfMatch(req);
      res.json(await svc.update(req as never, req.params['id']!, req.body, { expected }));
    } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await svc.remove(req as never, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};
