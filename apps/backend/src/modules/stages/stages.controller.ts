import type { NextFunction, Request, Response } from 'express';
import type {
  CreateStageRequest,
  CreateTransitionRequest,
  PreviewImpactRequest,
  ReorderStagesRequest,
  UpdateStageRequest,
} from '@spv/zod-schemas';

import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { Unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import * as service from './stages.service.js';

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

// Use the RLS-scoped tx if present; otherwise the singleton (jobs/scripts).
function dbFor(req: Request): PrismaClient {
  return ((req.db as unknown as PrismaClient) ?? prisma);
}

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const includeInactive =
      user.role === 'ADMIN' && String(req.query['include_inactive'] ?? '').toLowerCase() === 'true';
    // v6: optional visa_type_id filter. Accept the literal "null" string to mean
    // "stages NOT pinned to any visa type" — query strings can't natively
    // distinguish absent from null. Bad uuids fall through to "no filter" rather
    // than 400, since the route already accepts arbitrary query keys.
    const rawVisa = req.query['visa_type_id'];
    let visaTypeId: string | null | undefined;
    if (typeof rawVisa === 'string') {
      if (rawVisa.toLowerCase() === 'null') visaTypeId = null;
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawVisa)) {
        visaTypeId = rawVisa;
      }
    }
    const data = await service.list(dbFor(req), user.tid, { includeInactive, visaTypeId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function createHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const body = req.body as CreateStageRequest;
    await runIdempotent(req, res, { scope: 'stages.create' }, async () => {
      const created = await service.create(dbFor(req), user.tid, body);
      const id = (created as { id: string }).id;
      await writeAudit(req, {
        action: 'stage.created',
        entity_type: 'LifecycleStage',
        entity_id: id,
        after: created,
      });
      res.setHeader('Location', `/api/v1/stages/${id}`);
      return created;
    });
  } catch (err) {
    next(err);
  }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateStageRequest;
    const updated = await service.update(dbFor(req), user.tid, id, body);
    await writeAudit(req, {
      action: 'stage.updated',
      entity_type: 'LifecycleStage',
      entity_id: id,
      after: updated,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.remove(dbFor(req), user.tid, id);
    await writeAudit(req, {
      action: 'stage.deleted',
      entity_type: 'LifecycleStage',
      entity_id: id,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function reorderHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const body = req.body as ReorderStagesRequest;
    const result = await service.reorder(dbFor(req), user.tid, body);
    await writeAudit(req, {
      action: 'stage.reorder',
      entity_type: 'LifecycleStage',
      after: { item_count: body.items.length },
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function listTransitionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    // SVT-LIFECYCLE-2026-05: optional `from_stage_id` filter so the FE
    // dropdown can ask "what targets are reachable from X" without pulling
    // the full matrix. Bad uuids fall through to "no filter" — the route
    // already accepts arbitrary query keys and we don't want to 400 on a
    // typo'd query param.
    const rawFrom = req.query['from_stage_id'];
    let fromStageId: string | undefined;
    if (typeof rawFrom === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawFrom)) {
      fromStageId = rawFrom;
    }
    const data = await service.listTransitions(dbFor(req), user.tid, { fromStageId });
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function createTransitionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const body = req.body as CreateTransitionRequest;
    await runIdempotent(req, res, { scope: 'stage-transitions.create' }, async () => {
      const created = await service.createTransition(dbFor(req), user.tid, body);
      await writeAudit(req, {
        action: 'stage_transition.created',
        entity_type: 'LifecycleStageTransition',
        entity_id: (created as { id: string }).id,
        after: created,
      });
      return created;
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteTransitionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteTransition(dbFor(req), user.tid, id);
    await writeAudit(req, {
      action: 'stage_transition.deleted',
      entity_type: 'LifecycleStageTransition',
      entity_id: id,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function previewImpactHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const body = req.body as PreviewImpactRequest;
    const data = await service.previewImpact(dbFor(req), user.tid, body);
    res.json(data);
  } catch (err) {
    next(err);
  }
}
