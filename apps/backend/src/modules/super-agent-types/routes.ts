// SuperAgentType (admin-configurable category lookup) CRUD.
// Mounted at /api/v1/super-agent-types. Admin-only writes; reads open to all
// authenticated users.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';

import {
  CreateSuperAgentTypeRequest,
  UpdateSuperAgentTypeRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest, Conflict, NotFound, Unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';

function param(name: string, schema: z.ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return next(BadRequest(`Invalid path parameter: ${name}`));
    }
    req.params[name] = parsed.data as string;
    next();
  };
}

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

function dbFor(req: Request): PrismaClient {
  const db = req.db as unknown as PrismaClient | undefined;
  if (!db) {
    throw new Error('tenantContext middleware not applied to /super-agent-types route');
  }
  return db;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

const requireUuidId = param('id', Uuid);

export const superAgentTypesRouter: Router = Router();

superAgentTypesRouter.get('/', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const rows = await dbFor(req).superAgentType.findMany({
      where: { tenant_id: user.tid },
      orderBy: [{ label: 'asc' }],
    });
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

superAgentTypesRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(CreateSuperAgentTypeRequest),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const body = req.body as typeof CreateSuperAgentTypeRequest._type;
      try {
        const created = await dbFor(req).superAgentType.create({
          data: {
            tenant_id: user.tid,
            key: body.key,
            label: body.label,
            description: body.description ?? null,
            is_active: body.is_active,
          },
        });
        await writeAudit(req, {
          action: 'super_agent_type.created',
          entity_type: 'SuperAgentType',
          entity_id: created.id,
          after: created,
        });
        res.status(201).json(created);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw Conflict(`A super-agent type with key "${body.key}" already exists`);
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

superAgentTypesRouter.get('/:id', requireUuidId, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const row = await dbFor(req).superAgentType.findFirst({
      where: { id: req.params['id']!, tenant_id: user.tid },
    });
    if (!row) throw NotFound('Super-agent type not found');
    res.json(row);
  } catch (err) {
    next(err);
  }
});

superAgentTypesRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateSuperAgentTypeRequest),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const id = req.params['id']!;
      const body = req.body as typeof UpdateSuperAgentTypeRequest._type;
      const data: Record<string, unknown> = {};
      if (body.key !== undefined) data['key'] = body.key;
      if (body.label !== undefined) data['label'] = body.label;
      if (body.description !== undefined) data['description'] = body.description ?? null;
      if (body.is_active !== undefined) data['is_active'] = body.is_active;
      try {
        const wr = await dbFor(req).superAgentType.updateMany({
          where: { id, tenant_id: user.tid },
          data,
        });
        if (wr.count !== 1) throw NotFound('Super-agent type not found');
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw Conflict('A super-agent type with that key already exists');
        }
        throw err;
      }
      const updated = await dbFor(req).superAgentType.findFirstOrThrow({
        where: { id, tenant_id: user.tid },
      });
      await writeAudit(req, {
        action: 'super_agent_type.updated',
        entity_type: 'SuperAgentType',
        entity_id: id,
        after: updated,
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

superAgentTypesRouter.delete('/:id', requireUuidId, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    // Hard-delete only if no super_agents reference this type. Otherwise
    // the FK SetNull preserves data but we want to surface the warning.
    const inUse = await dbFor(req).superAgent.count({
      where: { tenant_id: user.tid, type_id: id, deleted_at: null },
    });
    if (inUse > 0) {
      throw Conflict(`Cannot delete: ${inUse} super-agent(s) still reference this type`);
    }
    const wr = await dbFor(req).superAgentType.deleteMany({
      where: { id, tenant_id: user.tid },
    });
    if (wr.count !== 1) throw NotFound('Super-agent type not found');
    await writeAudit(req, {
      action: 'super_agent_type.deleted',
      entity_type: 'SuperAgentType',
      entity_id: id,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
