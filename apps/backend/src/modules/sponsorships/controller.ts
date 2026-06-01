import type { Request, Response, NextFunction } from 'express';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { sponsorService, sponsorshipService } from './service.js';

export const sponsorController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'sponsors.create' }, () =>
        sponsorService.create(req, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try { res.json(await sponsorService.list(req, req.query as never)); } catch (e) { next(e); }
  },
  async get(req: Request, res: Response, next: NextFunction) {
    try { res.json(await sponsorService.get(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const expected = readIfMatch(req);
      res.json(await sponsorService.update(req, req.params['id']!, req.body, { expected }));
    } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await sponsorService.remove(req, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};

export const sponsorshipController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'sponsorships.create' }, () =>
        sponsorshipService.create(req, req.params['studentId']!, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try { res.json(await sponsorshipService.list(req, req.params['studentId']!, req.query as never)); } catch (e) { next(e); }
  },
  async get(req: Request, res: Response, next: NextFunction) {
    try { res.json(await sponsorshipService.get(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const expected = readIfMatch(req);
      res.json(await sponsorshipService.update(req, req.params['id']!, req.body, { expected }));
    } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await sponsorshipService.remove(req, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};
