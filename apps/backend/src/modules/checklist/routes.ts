// Three routers:
//   * stageChecklistItemsRouter (nested under /stages/:stageId/checklist-items)
//       GET / POST  — list + create item
//   * stageChecklistItemFlatRouter (mounted at /stages/checklist-items)
//       PATCH /:id  — update item   (admin+counsellor)
//       DELETE /:id — soft delete   (admin only)
//   * studentChecklistProgressRouter (nested under /students/:studentId/checklist-progress)
//       GET ?stage_id=… — list student progress for a stage
//       POST            — upsert by (student_id, checklist_item_id)
//
// authenticate + tenantContext are applied at each router so they work whether
// mounted standalone or composed. Validation runs before role checks so 400s
// are returned consistently. Path params are validated only where they're not
// already constrained by Express's pattern matching.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CreateChecklistItemRequest,
  UpdateChecklistItemRequest,
  UpsertChecklistProgressRequest,
  Uuid,
} from '@spv/zod-schemas';

import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './controller.js';

function param(name: string, schema: z.ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return next(BadRequest(`Invalid path parameter: ${name}`));
    req.params[name] = parsed.data as string;
    next();
  };
}

const requireStageId = param('stageId', Uuid);
const requireStudentId = param('studentId', Uuid);
const requireUuidId = param('id', Uuid);

// ----- /stages/:stageId/checklist-items ---------------------------------
export const stageChecklistItemsRouter: Router = Router({ mergeParams: true });
stageChecklistItemsRouter.use(authenticate, tenantContext);
stageChecklistItemsRouter.get('/', requireStageId, ctl.listItemsHandler);
stageChecklistItemsRouter.post(
  '/',
  requireStageId,
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(CreateChecklistItemRequest),
  ctl.createItemHandler,
);

// ----- /stages/checklist-items/:id --------------------------------------
export const stageChecklistItemFlatRouter: Router = Router();
stageChecklistItemFlatRouter.use(authenticate, tenantContext);
stageChecklistItemFlatRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(UpdateChecklistItemRequest),
  ctl.updateItemHandler,
);
stageChecklistItemFlatRouter.delete(
  '/:id',
  requireUuidId,
  requireRole('ADMIN'),
  ctl.deleteItemHandler,
);

// ----- /students/:studentId/checklist-progress --------------------------
export const studentChecklistProgressRouter: Router = Router({ mergeParams: true });
studentChecklistProgressRouter.use(authenticate, tenantContext);
studentChecklistProgressRouter.get('/', requireStudentId, ctl.listProgressHandler);
studentChecklistProgressRouter.post(
  '/',
  requireStudentId,
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(UpsertChecklistProgressRequest),
  ctl.upsertProgressHandler,
);
