// Defence-in-depth: any tenant-scoped write made by a VIEWER is rejected at the
// middleware layer regardless of whether the individual route remembered to call
// requireRole(...). Read methods (GET/HEAD/OPTIONS) are allowed for every role.
import type { Request, Response, NextFunction } from 'express';
import { Forbidden } from '../shared/errors.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function blockViewerWrites(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next();
  if (READ_METHODS.has(req.method)) return next();
  if (req.user.role === 'VIEWER') return next(Forbidden('Viewer role is read-only'));
  next();
}
