import type { Request, Response, NextFunction } from 'express';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { tagService, entityTagService } from './service.js';

export const tagController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'tags.create' }, () =>
        tagService.create(req, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try { res.json(await tagService.list(req, req.query as never)); } catch (e) { next(e); }
  },
  async get(req: Request, res: Response, next: NextFunction) {
    try { res.json(await tagService.get(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const expected = readIfMatch(req);
      res.json(await tagService.update(req, req.params['id']!, req.body, { expected }));
    } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await tagService.remove(req, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};

export const entityTagController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'entity-tags.create' }, () =>
        entityTagService.create(req as never, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try { res.json(await entityTagService.list(req, req.query as never)); } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await entityTagService.remove(req, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};
