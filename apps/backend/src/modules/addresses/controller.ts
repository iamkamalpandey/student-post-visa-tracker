import type { Request, Response, NextFunction } from 'express';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { addressService, studentAddressService } from './service.js';

export const addressController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'addresses.create' }, () =>
        addressService.create(req, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try { res.json(await addressService.list(req, req.query as never)); } catch (e) { next(e); }
  },
  async get(req: Request, res: Response, next: NextFunction) {
    try { res.json(await addressService.get(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const expected = readIfMatch(req);
      res.json(await addressService.update(req, req.params['id']!, req.body, { expected }));
    } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await addressService.remove(req, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};

export const studentAddressController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'student-addresses.create' }, () =>
        studentAddressService.create(req, req.params['studentId']!, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try { res.json(await studentAddressService.list(req, req.params['studentId']!)); } catch (e) { next(e); }
  },
  async get(req: Request, res: Response, next: NextFunction) {
    try { res.json(await studentAddressService.get(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const expected = readIfMatch(req);
      res.json(await studentAddressService.update(req, req.params['id']!, req.body, { expected }));
    } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await studentAddressService.remove(req, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};
