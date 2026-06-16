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

import { requireRole } from '../../middlewares/auth.js';
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
crmLeadsRouter.post('/sync', requireRole('ADMIN'), v2SyncLimiter, ctl.syncHandler);

crmLeadsRouter.get('/:id', requireUuidId, ctl.getByIdHandler);
crmLeadsRouter.patch('/:id', requireUuidId, requireRole('ADMIN', 'COUNSELLOR'), validate(UpdateCrmLeadRequest), ctl.updateHandler);

// Convert a lead → managed Student (ADMIN). Body = ConvertLeadToStudentRequest (admin
// confirms a payload pre-filled from the lead on the client).
crmLeadsRouter.post('/:id/convert', requireUuidId, requireRole('ADMIN'), validate(ConvertLeadToStudentRequest), ctl.convertHandler);

crmLeadsRouter.post('/:id/fees', requireUuidId, requireRole('ADMIN', 'COUNSELLOR'), validate(CreateCrmLeadFeeRequest), ctl.createFeeHandler);
crmLeadsRouter.patch('/:id/fees/:feeId', requireUuidId, requireUuidFeeId, requireRole('ADMIN', 'COUNSELLOR'), validate(UpdateCrmLeadFeeRequest), ctl.updateFeeHandler);
crmLeadsRouter.post('/:id/fees/:feeId/pay', requireUuidId, requireUuidFeeId, requireRole('ADMIN', 'COUNSELLOR'), validate(MarkCrmFeePaidRequest), ctl.markFeePaidHandler);
crmLeadsRouter.post('/:id/fees/:feeId/waive', requireUuidId, requireUuidFeeId, requireRole('ADMIN', 'COUNSELLOR'), ctl.waiveFeeHandler);
crmLeadsRouter.delete('/:id/fees/:feeId', requireUuidId, requireUuidFeeId, requireRole('ADMIN', 'COUNSELLOR'), ctl.deleteFeeHandler);
