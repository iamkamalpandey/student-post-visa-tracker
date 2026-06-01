// VisaType HTTP controller — thin handlers; the service contains the rules.
//
// `req.db` is the RLS-scoped Prisma client populated by tenantContext middleware.
// We intentionally do NOT fall back to the unscoped singleton: every endpoint
// here is mutational or admin-only and must run inside the tenant policy
// boundary. If `req.db` is missing it's a wiring bug and we fail loudly.

import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import type {
  CreateVisaTypeRequest,
  UpdateVisaTypeRequest,
  VisaTypeListQuery,
} from '@spv/zod-schemas';

import { Unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import * as service from './service.js';

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

function dbFor(req: Request): PrismaClient {
  const db = req.db as unknown as PrismaClient | undefined;
  if (!db) {
    // Missing RLS-scoped client — refuse rather than silently bypassing tenant policy.
    throw new Error('tenantContext middleware not applied to /visa-types route');
  }
  return db;
}

export async function listHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const data = await service.list(dbFor(req), user.tid, req.query as VisaTypeListQuery);
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function getHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const row = await service.getById(dbFor(req), user.tid, id);
    res.json(row);
  } catch (err) {
    next(err);
  }
}

export async function createHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const body = req.body as CreateVisaTypeRequest;
    await runIdempotent(req, res, { scope: 'visa-types.create' }, async () => {
      const created = await service.create(dbFor(req), user.tid, body);
      const id = (created as { id: string }).id;
      await writeAudit(req, {
        action: 'visa_type.created',
        entity_type: 'VisaType',
        entity_id: id,
        after: created,
      });
      res.setHeader('Location', `/api/v1/visa-types/${id}`);
      return created;
    });
  } catch (err) {
    next(err);
  }
}

export async function updateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateVisaTypeRequest;
    const updated = await service.update(dbFor(req), user.tid, id, body);
    await writeAudit(req, {
      action: 'visa_type.updated',
      entity_type: 'VisaType',
      entity_id: id,
      after: updated,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.softDelete(dbFor(req), user.tid, id);
    await writeAudit(req, {
      action: 'visa_type.deleted',
      entity_type: 'VisaType',
      entity_id: id,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
