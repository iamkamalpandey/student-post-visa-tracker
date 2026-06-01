import type { Request, Response, NextFunction } from 'express';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { reminderService as svc } from './service.js';

// Thin HTTP adapter — all validation lives in the route layer (zod) and all
// business logic lives in the service. Controller only translates between
// req/res and service calls.
export const reminderController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'reminders.create' }, () =>
        svc.create(req, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      // Standardised list envelope: `{ data, page }`. `page.total` is cheap here
      // because the service already returns the materialised page.
      const rows = await svc.list(req, req.query as never);
      res.json({ data: rows, page: { total: Array.isArray(rows) ? rows.length : 0 } });
    } catch (e) { next(e); }
  },
  async get(req: Request, res: Response, next: NextFunction) {
    try { res.json(await svc.get(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const expected = readIfMatch(req);
      res.json(await svc.update(req, req.params['id']!, req.body, { expected }));
    } catch (e) { next(e); }
  },
  async acknowledge(req: Request, res: Response, next: NextFunction) {
    try { res.json(await svc.acknowledge(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async snooze(req: Request, res: Response, next: NextFunction) {
    try { res.json(await svc.snooze(req, req.params['id']!, req.body)); } catch (e) { next(e); }
  },
  async dismiss(req: Request, res: Response, next: NextFunction) {
    try { res.json(await svc.dismiss(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await svc.remove(req, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};
