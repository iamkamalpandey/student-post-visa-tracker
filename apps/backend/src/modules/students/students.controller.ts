import type { NextFunction, Request, Response } from 'express';
import type {
  AdvanceStageRequest,
  CreateStudentRequest,
  StudentListQuery,
  UpdateStudentRequest,
} from '@spv/zod-schemas';

import { PreconditionFailed, Unauthorized } from '../../shared/errors.js';
// writeAudit is provided by the audit module that another agent is implementing.
// We import it eagerly so this controller fails loudly if the path drifts.
import { writeAudit } from '../../shared/audit.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';

import * as service from './students.service.js';
import { dbFor } from './students.types.js';

// Small helper: every handler needs the authenticated user. We assert here so the
// rest of the file can rely on req.user being populated (authenticate middleware).
function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const q = req.query as unknown as StudentListQuery;
    const result = await service.list({ db: dbFor(req), tenantId: user.tid }, q);
    res.json({
      data: result.data,
      page: { nextCursor: result.nextCursor, hasMore: result.hasMore, total: result.total },
    });
  } catch (err) {
    next(err);
  }
}

export async function getByIdHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const row = await service.getById({ db: dbFor(req), tenantId: user.tid }, id);
    // ETag is the version field — clients pass it back via If-Match on writes.
    if (row && typeof (row as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(row as { version: number }).version}"`);
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
}

export async function createHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const body = req.body as CreateStudentRequest;
    await runIdempotent(req, res, { scope: 'students.create' }, async () => {
      const created = await service.create(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        body,
      );
      const id = (created as { id: string }).id;
      await writeAudit(req, {
        action: 'student.created',
        entity_type: 'Student',
        entity_id: id,
        after: created,
      });
      // Headers must be set BEFORE runIdempotent's res.json call. We set them
      // here (inside the thunk, before res.json fires) so first-attempt
      // responses get them. On replay, headers are not present (the cached
      // response is body-only); clients can still pull `id` from the body.
      res.setHeader('Location', `/api/v1/students/${id}`);
      res.setHeader('ETag', `"${(created as { version: number }).version}"`);
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
    const expected = readIfMatch(req);
    if (expected === undefined) throw PreconditionFailed('If-Match required for PATCH');
    const body = req.body as UpdateStudentRequest;
    const updated = await service.update(
      // SVT-FSM-2026-05: pass actorRole so the service can enforce the
      // student-status state-machine (admin-only re-activation out of terminal).
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub, actorRole: user.role },
      id,
      body,
      String(expected),
    );
    await writeAudit(req, {
      action: 'student.updated',
      entity_type: 'Student',
      entity_id: id,
      after: updated,
    });
    if (updated && typeof (updated as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(updated as { version: number }).version}"`);
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function softDeleteHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.softDelete({ db: dbFor(req), tenantId: user.tid, actorId: user.sub }, id);
    await writeAudit(req, {
      action: 'student.deleted',
      entity_type: 'Student',
      entity_id: id,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function timelineHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const events = await service.timeline({ db: dbFor(req), tenantId: user.tid }, id);
    res.json({ data: events });
  } catch (err) {
    next(err);
  }
}

export async function advanceStageHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    // SVT-WAVE-BILLING-SEC-P0-F2: surface `?force=true` query param as a
    // boolean on the body so admins can skip-advance over multiple stages
    // from the URL (typical UI pattern) without rewriting the request body.
    // Explicit body.force still wins when both are present.
    const rawBody = (req.body ?? {}) as AdvanceStageRequest;
    const forceQuery = String(req.query['force'] ?? '').toLowerCase();
    const forceFromQuery = forceQuery === 'true' || forceQuery === '1';
    const body: AdvanceStageRequest = {
      ...rawBody,
      force: rawBody.force ?? (forceFromQuery ? true : undefined),
    };
    const result = await service.advanceStage(
      {
        db: dbFor(req),
        tenantId: user.tid,
        actorId: user.sub,
        actorRole: user.role,
      },
      id,
      body,
    );
    await writeAudit(req, {
      action: 'student.advance_stage',
      entity_type: 'Student',
      entity_id: id,
      after: { to_stage_id: body.to_stage_id, reason_code: body.reason_code ?? null },
    });
    if (result && typeof (result as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(result as { version: number }).version}"`);
    }
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function completenessHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const result = await service.completeness({ db: dbFor(req), tenantId: user.tid }, id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
