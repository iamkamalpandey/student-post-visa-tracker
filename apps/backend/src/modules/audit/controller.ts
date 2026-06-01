// HTTP layer for /api/v1/audit-logs.
import type { NextFunction, Request, Response } from 'express';
import type { AuditLogListQuery } from '@spv/zod-schemas';

import { InternalError, Unauthorized } from '../../shared/errors.js';

import * as service from './service.js';

// We never fall back to the singleton prisma client. The audit log is the single
// most security-sensitive table in the system; bypassing the RLS-scoped tx would
// silently leak cross-tenant rows. Throw loudly if tenantContext didn't run.
function requireScopedDb(req: Request): service.Db {
  if (!req.db) throw InternalError('Tenant-scoped DB missing — tenantContext middleware not mounted');
  return req.db as unknown as service.Db;
}

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const q = req.query as unknown as AuditLogListQuery;
    const result = await service.list({ db: requireScopedDb(req), tenantId: user.tid }, q);
    // snake_case envelope as specified — matches how the FE will consume it. `total` is
    // always returned today; the field is optional in the schema so we can drop it later
    // for very large tenants without a breaking change.
    res.json({
      data: result.data,
      page: { next_cursor: result.nextCursor, total: result.total },
    });
  } catch (err) {
    next(err);
  }
}

// Note: the route is `/verify` and is registered BEFORE `/:id` so Express matches the
// literal path first and we don't try to UUID-parse "verify".
export async function verifyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const result = await service.verify({ db: requireScopedDb(req), tenantId: user.tid });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

// SVT-AUDIT-WORM-2026-05 — list persisted Merkle roots (admin only). Paged
// by anchored_at DESC cursor, capped at 500.
export async function anchorsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const db = requireScopedDb(req);
    const limitRaw = Number(req.query['limit'] ?? 100);
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100), 500);
    const cursorParam = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : null;
    const cursor = cursorParam ? new Date(cursorParam) : null;
    const tenantParam = typeof req.query['tenant_id'] === 'string' ? req.query['tenant_id'] : null;
    const where: Record<string, unknown> = {
      // Visibility: own tenant + tenant-less chain. Cross-tenant query allowed
      // only via explicit ?tenant_id and rejected if not own (defence in depth
      // on top of RLS).
      tenant_id: tenantParam && tenantParam !== user.tid
        ? '__deny__'
        : { in: [user.tid, null] },
    };
    if (cursor) (where as { anchored_at?: unknown }).anchored_at = { lt: cursor };
    const rows = await (db as unknown as { auditAnchor: { findMany: (a: unknown) => Promise<Array<{ anchored_at: Date }>> } })
      .auditAnchor.findMany({
        where,
        orderBy: { anchored_at: 'desc' },
        take: limit,
      });
    const last = rows[rows.length - 1];
    res.json({
      data: rows,
      next_cursor: rows.length === limit && last ? last.anchored_at.toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
}

export async function getByIdHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const row = await service.getById({ db: requireScopedDb(req), tenantId: user.tid }, id);
    res.json(row);
  } catch (err) {
    next(err);
  }
}
