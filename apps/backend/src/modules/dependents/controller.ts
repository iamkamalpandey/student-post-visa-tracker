import type { Request, Response, NextFunction } from 'express';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { dependentService as svc } from './service.js';

export const dependentController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'dependents.create' }, () =>
        svc.create(req, req.params['studentId']!, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try { res.json(await svc.list(req, req.params['studentId']!, req.query as never)); } catch (e) { next(e); }
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
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await svc.remove(req, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};
