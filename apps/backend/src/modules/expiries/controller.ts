// /expiries HTTP controller — thin handler. The service does all the work.
//
// `req.db` is the RLS-scoped Prisma client populated by tenantContext. We
// intentionally do NOT fall back to the unscoped singleton: leaking expiry
// rows across tenants would be a serious data-isolation incident.
import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { ExpiriesListQuery } from '@spv/zod-schemas';

import { Unauthorized } from '../../shared/errors.js';
import { listExpiries } from './service.js';

function dbFor(req: Request): PrismaClient {
  const db = req.db as unknown as PrismaClient | undefined;
  if (!db) {
    throw new Error('tenantContext middleware not applied to /expiries route');
  }
  return db;
}

export async function listHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw Unauthorized();
    const data = await listExpiries(
      dbFor(req),
      req.user.tid,
      req.query as unknown as ExpiriesListQuery,
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
}
