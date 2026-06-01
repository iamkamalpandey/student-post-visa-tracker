import type { NextFunction, Request, Response } from 'express';
import type {
  CreateProgramFeeRequest,
  CreateProgramIntakeRequest,
  CreateProgramModuleRequest,
  CreateProgramRequest,
  CreateProgramRequirementRequest,
  ProgramListQuery,
  UpdateProgramFeeRequest,
  UpdateProgramIntakeRequest,
  UpdateProgramModuleRequest,
  UpdateProgramRequest,
  UpdateProgramRequirementRequest,
} from '@spv/zod-schemas';

import { PreconditionFailed, Unauthorized } from '../../shared/errors.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import * as service from './programs.service.js';
import { dbFor } from './programs.types.js';

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

export async function listHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const q = req.query as unknown as ProgramListQuery;
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
    const body = req.body as CreateProgramRequest;
    await runIdempotent(req, res, { scope: 'programs.create' }, async () => {
      const created = await service.create(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        body,
      );
      const id = (created as { id: string }).id;
      res.setHeader('Location', `/api/v1/programs/${id}`);
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
    const body = req.body as UpdateProgramRequest;
    const updated = await service.update(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
      body,
      String(expected),
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
    await service.softDelete({ db: dbFor(req), tenantId: user.tid, actorId: user.sub }, id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Intakes (nested under :id)
// ---------------------------------------------------------------------------

export async function listIntakesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const rows = await service.listIntakes({ db: dbFor(req), tenantId: user.tid }, id);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function createIntakeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateProgramIntakeRequest;
    await runIdempotent(req, res, { scope: 'program-intakes.create' }, () =>
      service.createIntake(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateIntakeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateProgramIntakeRequest;
    const updated = await service.updateIntake(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
      body,
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteIntakeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteIntake(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Fees (nested under intakes/:intakeId)
// ---------------------------------------------------------------------------

export async function listFeesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const intakeId = req.params['intakeId']!;
    const rows = await service.listFees({ db: dbFor(req), tenantId: user.tid }, intakeId);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function createFeeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const intakeId = req.params['intakeId']!;
    const body = req.body as CreateProgramFeeRequest;
    await runIdempotent(req, res, { scope: 'program-fees.create' }, () =>
      service.createFee(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        intakeId,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateFeeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateProgramFeeRequest;
    const updated = await service.updateFee(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
      body,
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteFeeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteFee(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

export async function listRequirementsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const rows = await service.listRequirements({ db: dbFor(req), tenantId: user.tid }, id);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function createRequirementHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateProgramRequirementRequest;
    await runIdempotent(req, res, { scope: 'program-requirements.create' }, () =>
      service.createRequirement(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateRequirementHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateProgramRequirementRequest;
    const updated = await service.updateRequirement(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
      body,
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteRequirementHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteRequirement(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export async function listModulesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const rows = await service.listModules({ db: dbFor(req), tenantId: user.tid }, id);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function createModuleHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as CreateProgramModuleRequest;
    await runIdempotent(req, res, { scope: 'program-modules.create' }, () =>
      service.createModule(
        { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
        id,
        body,
      ),
    );
  } catch (err) {
    next(err);
  }
}

export async function updateModuleHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateProgramModuleRequest;
    const updated = await service.updateModule(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
      body,
    );
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteModuleHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.deleteModule(
      { db: dbFor(req), tenantId: user.tid, actorId: user.sub },
      id,
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
