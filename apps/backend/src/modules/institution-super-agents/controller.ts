// InstitutionSuperAgent HTTP controller — thin handlers that delegate to
// the service. Mounted under /api/v1/institutions/:id/super-agents (see
// routes.ts).

import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import type {
  CreateInstitutionSuperAgentRequest,
  UpdateInstitutionSuperAgentRequest,
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
    throw new Error(
      'tenantContext middleware not applied to /institutions/.../super-agents route',
    );
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
    const institutionId = req.params['id']!;
    const data = await service.listForInstitution(
      dbFor(req),
      user.tid,
      institutionId,
    );
    res.json({ data });
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
    const institutionId = req.params['id']!;
    const body = req.body as CreateInstitutionSuperAgentRequest;
    await runIdempotent(
      req,
      res,
      { scope: 'institution-super-agents.create' },
      async () => {
        const created = await service.createLink(
          dbFor(req),
          user.tid,
          user.sub,
          institutionId,
          body,
        );
        const id = (created as { id: string }).id;
        await writeAudit(req, {
          action: 'institution_super_agent.created',
          entity_type: 'InstitutionSuperAgent',
          entity_id: id,
          after: created,
        });
        res.setHeader(
          'Location',
          `/api/v1/institutions/${institutionId}/super-agents/${id}`,
        );
        return created;
      },
    );
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
    const institutionId = req.params['id']!;
    const linkId = req.params['linkId']!;
    const body = req.body as UpdateInstitutionSuperAgentRequest;
    const updated = await service.updateLink(
      dbFor(req),
      user.tid,
      institutionId,
      linkId,
      body,
    );
    await writeAudit(req, {
      action: 'institution_super_agent.updated',
      entity_type: 'InstitutionSuperAgent',
      entity_id: linkId,
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
    const institutionId = req.params['id']!;
    const linkId = req.params['linkId']!;
    await service.deleteLink(dbFor(req), user.tid, institutionId, linkId);
    await writeAudit(req, {
      action: 'institution_super_agent.deleted',
      entity_type: 'InstitutionSuperAgent',
      entity_id: linkId,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
