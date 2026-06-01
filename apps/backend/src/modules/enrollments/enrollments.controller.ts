import type { NextFunction, Request, Response } from 'express';
import type {
  CreateEnrollmentRequest,
  EnrollmentListQuery,
  UpdateEnrollmentRequest,
} from '@spv/zod-schemas';

import { HttpError, PreconditionFailed, Unauthorized } from '../../shared/errors.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import * as service from './enrollments.service.js';
import { dbFor } from './enrollments.types.js';

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

/**
 * Parse the optional If-Match header into a numeric version. Returns
 * `undefined` when the header is missing — callers treat that as "skip the
 * optimistic-concurrency check" for backwards compatibility. A malformed
 * header is rejected with 412 (RFC 7232 §3.1: a syntactically invalid
 * If-Match is treated as a precondition failure).
 */
function readIfMatch(req: Request): number | undefined {
  const raw = req.header('If-Match');
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const n = Number.parseInt(stripped, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw PreconditionFailed('If-Match must be a numeric version (e.g. "3").');
  }
  return n;
}

// SVT-WAVE-OCC-REQUIRED-2026-05 — same parser as above but throws 428
// PreconditionRequired when the header is missing. Used by mutating
// handlers (enrollments PATCH) where lost-update is a real hazard.
// Mirrors the students-controller pattern. RFC 6585 §3 reserves 428 for
// exactly this case ("require the request to be conditional").
function requireIfMatch(req: Request): number {
  const v = readIfMatch(req);
  if (v === undefined) {
    throw new HttpError({
      status: 428,
      title: 'Precondition Required',
      detail: 'If-Match header is required for this endpoint to prevent lost updates.',
    });
  }
  return v;
}

// ---------------------------------------------------------------------------
// Per-student endpoints (mounted under /students/:studentId/enrollments)
// ---------------------------------------------------------------------------

export async function createForStudentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const studentId = req.params['studentId']!;
    const body = req.body as CreateEnrollmentRequest;
    await runIdempotent(req, res, { scope: 'enrollments.create' }, async () => {
      const created = await service.createForStudent(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        studentId,
        body,
      );
      const id = (created as { id: string }).id;
      res.setHeader('Location', `/api/v1/enrollments/${id}`);
      res.setHeader('ETag', `"${(created as { version: number }).version}"`);
      return created;
    });
  } catch (err) {
    next(err);
  }
}

export async function listForStudentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const studentId = req.params['studentId']!;
    const rows = await service.listForStudent(
      { db: dbFor(req), tenantId: user.tid },
      studentId,
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Cross-student admin endpoints (mounted under /enrollments)
// ---------------------------------------------------------------------------

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const q = req.query as unknown as EnrollmentListQuery;
    const result = await service.list({ db: dbFor(req), tenantId: user.tid }, q);
    res.json({ data: result.data, page: { total: result.total } });
  } catch (err) {
    next(err);
  }
}

export async function getByIdHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const row = await service.getById({ db: dbFor(req), tenantId: user.tid }, id);
    if (row && typeof (row as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(row as { version: number }).version}"`);
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
}

export async function updateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateEnrollmentRequest;
    // SVT-WAVE-OCC-REQUIRED-2026-05 — If-Match is mandatory here. Missing
    // header → 428; stale version (mismatch with enrollment.version) → 412
    // (thrown inside service.update).
    const expected = requireIfMatch(req);
    const updated = await service.update(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub, actorRole: user.role },
      id,
      body,
      expected,
    );
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
    await service.softDelete(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
