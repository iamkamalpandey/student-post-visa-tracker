// Thin handlers for stage checklist items + per-student progress.
//
// All handlers route through req.db (the RLS-scoped client). We deliberately
// throw if it's missing rather than fall back to the singleton — see
// dashboard.routes.ts for the same pattern. Every mutation funnels through
// writeAudit so the hash chain stays intact.
import type { NextFunction, Request, Response } from 'express';
import type {
  CreateChecklistItemRequest,
  UpdateChecklistItemRequest,
  UpsertChecklistProgressRequest,
} from '@spv/zod-schemas';
import type { PrismaClient } from '@prisma/client';

import { Unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import * as service from './service.js';

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

function dbFor(req: Request): PrismaClient {
  const db = req.db as PrismaClient | undefined;
  if (!db) throw new Error('tenantContext middleware not applied');
  return db;
}

// --- Items --------------------------------------------------------------

export async function listItemsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const stageId = req.params['stageId']!;
    const includeInactive =
      user.role === 'ADMIN' &&
      String(req.query['include_inactive'] ?? '').toLowerCase() === 'true';
    const data = await service.listItems(dbFor(req), user.tid, stageId, { includeInactive });
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function createItemHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const stageId = req.params['stageId']!;
    const body = req.body as CreateChecklistItemRequest;
    await runIdempotent(req, res, { scope: 'checklist-items.create' }, async () => {
      const created = await service.createItem(dbFor(req), user.tid, stageId, body);
      const id = (created as { id: string }).id;
      await writeAudit(req, {
        action: 'stage_checklist_item.created',
        entity_type: 'LifecycleStageChecklistItem',
        entity_id: id,
        after: created,
      });
      res.setHeader('Location', `/api/v1/stages/checklist-items/${id}`);
      return created;
    });
  } catch (err) {
    next(err);
  }
}

export async function updateItemHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateChecklistItemRequest;
    // SVT-IF-MATCH-2026-05 — LifecycleStageChecklistItem has no `version`
    // column; accept If-Match header for API parity but treat it as a no-op
    // (parser still validates syntax → 412 on malformed values per RFC 7232 §3.1).
    const expected = readIfMatch(req);
    const updated = await service.updateItem(dbFor(req), user.tid, id, body, { expected });
    await writeAudit(req, {
      action: 'stage_checklist_item.updated',
      entity_type: 'LifecycleStageChecklistItem',
      entity_id: id,
      after: updated,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteItemHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.removeItem(dbFor(req), user.tid, id);
    await writeAudit(req, {
      action: 'stage_checklist_item.deleted',
      entity_type: 'LifecycleStageChecklistItem',
      entity_id: id,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// --- Progress -----------------------------------------------------------

export async function listProgressHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const studentId = req.params['studentId']!;
    const stageId = (req.query['stage_id'] as string | undefined) ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(stageId)) {
      res.status(400).json({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'stage_id query param must be a UUID',
      });
      return;
    }
    const data = await service.listProgress(dbFor(req), user.tid, studentId, stageId);
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function upsertProgressHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const studentId = req.params['studentId']!;
    const body = req.body as UpsertChecklistProgressRequest;
    // SVT-IF-MATCH-2026-05 — StudentStageChecklistProgress has no `version`
    // column; accept If-Match header for API parity but treat it as a no-op
    // (parser still validates syntax → 412 on malformed values per RFC 7232 §3.1).
    const expected = readIfMatch(req);
    const saved = await service.upsertProgress(dbFor(req), user.tid, studentId, user.sub, body, { expected });
    const id = (saved as { id: string }).id;
    await writeAudit(req, {
      action: body.completed
        ? 'stage_checklist_progress.complete'
        : 'stage_checklist_progress.uncomplete',
      entity_type: 'StudentStageChecklistProgress',
      entity_id: id,
      after: saved,
    });
    res.status(200).json(saved);
  } catch (err) {
    next(err);
  }
}
