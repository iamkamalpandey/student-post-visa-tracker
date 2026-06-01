// SuperAgentContact CRUD nested under /super-agents/:id/contacts.
// Admin-only writes; reads open to any authenticated user.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';

import {
  CreateSuperAgentContactRequest,
  UpdateSuperAgentContactRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest, NotFound, Unauthorized } from '../../shared/errors.js';
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
    throw new Error('tenantContext middleware not applied to contacts route');
  }
  return db;
}

async function ensureSuperAgent(db: PrismaClient, tenantId: string, saId: string) {
  const sa = await db.superAgent.findFirst({
    where: { id: saId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!sa) throw NotFound('Super-agent not found');
}

export const contactsRouter: Router = Router({ mergeParams: true });

contactsRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const db = dbFor(req);
      const saId = req.params['id']!;
      await ensureSuperAgent(db, user.tid, saId);
      const rows = await db.superAgentContact.findMany({
        where: { tenant_id: user.tid, super_agent_id: saId, deleted_at: null },
        orderBy: [{ is_primary: 'desc' }, { name: 'asc' }],
      });
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  },
);

contactsRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(CreateSuperAgentContactRequest),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const db = dbFor(req);
      const saId = req.params['id']!;
      await ensureSuperAgent(db, user.tid, saId);
      const body = req.body as typeof CreateSuperAgentContactRequest._type;
      const created = await db.superAgentContact.create({
        data: {
          tenant_id: user.tid,
          super_agent_id: saId,
          name: body.name,
          role: body.role ?? null,
          email: body.email ?? null,
          phone_e164: body.phone_e164 ?? null,
          is_primary: body.is_primary,
          notes: body.notes ?? null,
        },
      });
      await writeAudit(req, {
        action: 'super_agent_contact.created',
        entity_type: 'SuperAgentContact',
        entity_id: created.id,
        after: created,
      });
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  },
);

contactsRouter.patch(
  '/:contactId',
  param('contactId', Uuid),
  requireRole('ADMIN'),
  validate(UpdateSuperAgentContactRequest),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const db = dbFor(req);
      const saId = req.params['id']!;
      const contactId = req.params['contactId']!;
      const body = req.body as typeof UpdateSuperAgentContactRequest._type;
      const data: Record<string, unknown> = {};
      if (body.name !== undefined) data['name'] = body.name;
      if (body.role !== undefined) data['role'] = body.role ?? null;
      if (body.email !== undefined) data['email'] = body.email ?? null;
      if (body.phone_e164 !== undefined) data['phone_e164'] = body.phone_e164 ?? null;
      if (body.is_primary !== undefined) data['is_primary'] = body.is_primary;
      if (body.notes !== undefined) data['notes'] = body.notes ?? null;
      const wr = await db.superAgentContact.updateMany({
        where: {
          id: contactId,
          tenant_id: user.tid,
          super_agent_id: saId,
          deleted_at: null,
        },
        data,
      });
      if (wr.count !== 1) throw NotFound('Contact not found');
      const updated = await db.superAgentContact.findFirstOrThrow({
        where: { id: contactId, tenant_id: user.tid },
      });
      await writeAudit(req, {
        action: 'super_agent_contact.updated',
        entity_type: 'SuperAgentContact',
        entity_id: contactId,
        after: updated,
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

contactsRouter.delete(
  '/:contactId',
  param('contactId', Uuid),
  requireRole('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const db = dbFor(req);
      const saId = req.params['id']!;
      const contactId = req.params['contactId']!;
      const wr = await db.superAgentContact.updateMany({
        where: {
          id: contactId,
          tenant_id: user.tid,
          super_agent_id: saId,
          deleted_at: null,
        },
        data: { deleted_at: new Date() },
      });
      if (wr.count !== 1) throw NotFound('Contact not found');
      await writeAudit(req, {
        action: 'super_agent_contact.deleted',
        entity_type: 'SuperAgentContact',
        entity_id: contactId,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);
