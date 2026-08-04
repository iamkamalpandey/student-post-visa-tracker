import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  CreateCrmLeadFeeRequest,
  ConvertLeadToStudentRequest,
  CrmApplicationListQuery,
  CrmLeadListQuery,
  MarkCrmFeePaidRequest,
  UpdateCrmLeadFeeRequest,
  UpdateCrmLeadRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireLeadOwnership, requireRole } from '../../middlewares/auth.js';
import { requireIdempotencyKey } from '../../shared/idempotencyHandler.js';
import { validate } from '../../middlewares/validate.js';
import { v2SyncLimiter } from '../../middlewares/rateLimit.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './crm-leads.controller.js';

function param(name: string, schema: z.ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return next(
        BadRequest(`Invalid path parameter: ${name}`, parsed.error.issues.map((i) => ({ path: i.path.join('.') || name, message: i.message, code: i.code }))),
      );
    }
    req.params[name] = parsed.data as string;
    next();
  };
}

const requireUuidId = param('id', Uuid);
const requireUuidFeeId = param('feeId', Uuid);

export const crmLeadsRouter: Router = Router();

// NOTE: authenticate + tenantContext are applied in app.ts before this router.

crmLeadsRouter.get('/', validate(CrmLeadListQuery, 'query'), ctl.listHandler);

// Applications pipeline (one row per application). Literal route before '/:id'.
crmLeadsRouter.get('/applications', validate(CrmApplicationListQuery, 'query'), ctl.listApplicationsHandler);

// Finance summary (per-currency). Literal route before '/:id'.
crmLeadsRouter.get('/finance-summary', ctl.financeSummaryHandler);

// Institutions + courses reports (read-only CRM aggregates). Literal routes before '/:id'.
crmLeadsRouter.get('/institutions-report', ctl.institutionsReportHandler);
crmLeadsRouter.get('/courses-report', ctl.coursesReportHandler);

// On-demand V2 ingest — ADMIN only, rate-limited. Before '/:id' so the literal isn't shadowed.
// SVT-QA-2026-08 — accepts no body; explicit strict-empty validator so a
// rogue client can't smuggle unexpected fields the handler would silently drop.
crmLeadsRouter.post('/sync', requireRole('ADMIN'), v2SyncLimiter, validate(z.object({}).strict()), ctl.syncHandler);

crmLeadsRouter.get('/:id', requireUuidId, ctl.getByIdHandler);
// SVT-QA-2026-08 (LEAD-H2) — every lead mutation is now ownership-gated.
// Previously any COUNSELLOR could PATCH any lead in the tenant (including
// reassigning it to themselves) and then mutate its money rows. ADMIN
// bypasses; unassigned leads stay open so the shared intake queue works.
crmLeadsRouter.patch('/:id', requireUuidId, requireRole('ADMIN', 'COUNSELLOR'), requireLeadOwnership(), validate(UpdateCrmLeadRequest), ctl.updateHandler);

// Convert a lead → managed Student (ADMIN). Body = ConvertLeadToStudentRequest (admin
// confirms a payload pre-filled from the lead on the client).
// SVT-REL-2026-06 — convert mints a student + migrates fees (+ maybe an
// enrollment): an irreversible money-mover, so require an Idempotency-Key like
// every billing money-mover (a non-browser client double-firing the POST could
// otherwise create duplicate students before the dup guard's read sees either).
crmLeadsRouter.post('/:id/convert', requireUuidId, requireRole('ADMIN'), requireIdempotencyKey, validate(ConvertLeadToStudentRequest), ctl.convertHandler);

// SVT-QA-2026-08 — every fee mutation is money-touching: require Idempotency-Key
// so a retry replays the cached body instead of creating a duplicate row, and
// gate the waive handler with a strict-empty validator (was missing) so a
// rogue body can't slip through the "no schema" gap.
// SVT-QA-2026-08 (LEAD-H2) — fee mutations are the money surface of a lead;
// they get the same ownership gate as the lead itself.
crmLeadsRouter.post('/:id/fees', requireUuidId, requireRole('ADMIN', 'COUNSELLOR'), requireLeadOwnership(), requireIdempotencyKey, validate(CreateCrmLeadFeeRequest), ctl.createFeeHandler);
crmLeadsRouter.patch('/:id/fees/:feeId', requireUuidId, requireUuidFeeId, requireRole('ADMIN', 'COUNSELLOR'), requireLeadOwnership(), requireIdempotencyKey, validate(UpdateCrmLeadFeeRequest), ctl.updateFeeHandler);
crmLeadsRouter.post('/:id/fees/:feeId/pay', requireUuidId, requireUuidFeeId, requireRole('ADMIN', 'COUNSELLOR'), requireLeadOwnership(), requireIdempotencyKey, validate(MarkCrmFeePaidRequest), ctl.markFeePaidHandler);
crmLeadsRouter.post('/:id/fees/:feeId/waive', requireUuidId, requireUuidFeeId, requireRole('ADMIN', 'COUNSELLOR'), requireLeadOwnership(), requireIdempotencyKey, validate(z.object({}).strict()), ctl.waiveFeeHandler);
crmLeadsRouter.delete('/:id/fees/:feeId', requireUuidId, requireUuidFeeId, requireRole('ADMIN', 'COUNSELLOR'), requireLeadOwnership(), requireIdempotencyKey, ctl.deleteFeeHandler);
