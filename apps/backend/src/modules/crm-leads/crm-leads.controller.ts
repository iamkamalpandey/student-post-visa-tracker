import type { NextFunction, Request, Response } from 'express';
import type {
  CreateCrmLeadFeeRequest,
  ConvertLeadToStudentRequest,
  CrmApplicationListQuery,
  CrmLeadListQuery,
  MarkCrmFeePaidRequest,
  UpdateCrmLeadFeeRequest,
  UpdateCrmLeadRequest,
} from '@spv/zod-schemas';

import { PreconditionFailed, Unauthorized } from '../../shared/errors.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import * as service from './crm-leads.service.js';
import { dbFor } from './crm-leads.types.js';

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

export async function convertHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params.id as string;
    const body = req.body as ConvertLeadToStudentRequest;
    // SVT-SYNC-2026-06 — C3: idempotency guard prevents orphan duplicate students
    // on double-submit. FE auto-injects Idempotency-Key on POST (axios interceptor);
    // without this wrapper two rapid clicks could both call createStudent before
    // the first finishes linking, leaving an unlinked orphan. The parentKey scopes
    // by lead id so converting two different leads with the same key (unlikely but
    // legal) doesn't cross-cache.
    await runIdempotent(req, res, { scope: 'crm-leads.convert', parentKey: id }, () =>
      service.convertLeadToStudent(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const q = req.query as unknown as CrmLeadListQuery;
    const result = await service.list({ db: dbFor(req), tenantId: user.tid }, q);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: result.data, page: { nextCursor: result.nextCursor, hasMore: result.hasMore, total: result.total } });
  } catch (err) {
    next(err);
  }
}

export async function listApplicationsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const q = req.query as unknown as CrmApplicationListQuery;
    const result = await service.listApplications({ db: dbFor(req), tenantId: user.tid }, q);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ data: result.data, page: { nextCursor: result.nextCursor, hasMore: result.hasMore, total: result.total } });
  } catch (err) {
    next(err);
  }
}

export async function institutionsReportHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const result = await service.institutionsReport({ db: dbFor(req), tenantId: user.tid });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function coursesReportHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const result = await service.coursesReport({ db: dbFor(req), tenantId: user.tid });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function financeSummaryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const summary = await service.financeSummary({ db: dbFor(req), tenantId: user.tid });
    res.setHeader('Cache-Control', 'no-store');
    res.json(summary);
  } catch (err) {
    next(err);
  }
}

export async function getByIdHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const row = await service.getById({ db: dbFor(req), tenantId: user.tid }, id);
    // Embedded fees/children change without bumping lead.version → never cache.
    res.setHeader('Cache-Control', 'no-store');
    res.json(row);
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
    const body = req.body as UpdateCrmLeadRequest;
    const updated = await service.update({ db: dbFor(req), tenantId: user.tid, actorId: user.sub }, id, body, String(expected));
    if (updated && typeof (updated as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(updated as { version: number }).version}"`);
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function createFeeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateCrmLeadFeeRequest;
    await runIdempotent(req, res, { scope: 'crm-lead-fees.create' }, () =>
      service.createFee({ db: dbFor(req), tenantId: user.tid, actorId: user.sub }, id, body),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateFeeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const feeId = req.params['feeId']!;
    const expected = readIfMatch(req);
    if (expected === undefined) throw PreconditionFailed('If-Match required for PATCH');
    const body = req.body as UpdateCrmLeadFeeRequest;
    const updated = await service.updateFee({ db: dbFor(req), tenantId: user.tid, actorId: user.sub }, id, feeId, body, String(expected));
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function markFeePaidHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const feeId = req.params['feeId']!;
    const body = req.body as MarkCrmFeePaidRequest;
    const updated = await service.markFeePaid({ db: dbFor(req), tenantId: user.tid, actorId: user.sub }, id, feeId, body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function waiveFeeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const feeId = req.params['feeId']!;
    const updated = await service.waiveFee({ db: dbFor(req), tenantId: user.tid, actorId: user.sub }, id, feeId);
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteFeeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const feeId = req.params['feeId']!;
    await service.deleteFee({ db: dbFor(req), tenantId: user.tid, actorId: user.sub }, id, feeId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function syncHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const result = await service.triggerSync({ db: dbFor(req), tenantId: user.tid, actorId: user.sub });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
}
