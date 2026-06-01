// /api/v1/audit-logs router.
//
// Mounted in app.ts behind `authenticate` + `tenantContext`. Every route here is also
// gated by requireRole('ADMIN') — only admins should be able to read the audit trail.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { AuditLogListQuery, Uuid } from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { auditVerifyLimiter } from '../../middlewares/rateLimit.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';

import * as ctl from './controller.js';

// Tiny path-param validator — same pattern used by students.routes.ts.
function param(name: string, schema: z.ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return next(
        BadRequest(
          `Invalid path parameter: ${name}`,
          parsed.error.issues.map((i) => ({
            path: i.path.join('.') || name,
            message: i.message,
            code: i.code,
          })),
        ),
      );
    }
    req.params[name] = parsed.data as string;
    next();
  };
}

const requireUuidId = param('id', Uuid);

export const auditLogsRouter: Router = Router();

// ADMIN-only for every endpoint. The audit log is sensitive even for read access.
auditLogsRouter.use(requireRole('ADMIN'));

// Order matters: `/verify` must be registered BEFORE `/:id` so the literal path wins
// over the parameter route — otherwise Express would try to validate "verify" as a UUID.
// SVT-WAVE60-RATE-LIMIT-2026-05 — 5/min cap; full-table scan; admin-triggered.
auditLogsRouter.get('/verify', auditVerifyLimiter, ctl.verifyHandler);
// SVT-AUDIT-WORM-2026-05 — paged list of persisted Merkle roots (admin).
auditLogsRouter.get('/anchors', ctl.anchorsHandler);
auditLogsRouter.get('/', validate(AuditLogListQuery, 'query'), ctl.listHandler);
auditLogsRouter.get('/:id', requireUuidId, ctl.getByIdHandler);
