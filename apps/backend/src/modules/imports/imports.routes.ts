// Bulk-import routes. All endpoints require an authenticated user + tenantContext (mounted
// in app.ts). Role enforcement is per-endpoint (VIEWER can read/list, COUNSELLOR/ADMIN can
// upload + apply + cancel).

import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { importsLimiter } from '../../middlewares/rateLimit.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import {
  getSchema,
  getTemplateCsv,
  postImport,
  getJob,
  getJobReport,
  getJobErrors,
  postApply,
  postCancel,
  getJobResult,
} from './imports.controller.js';

// In-memory multer storage so we can compute SHA-256 + sniff the buffer up-front. The 50MB
// cap matches the controller's defensive check (the limit here is the network-level guard).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

export const importsRouter: Router = Router();

importsRouter.use(authenticate, tenantContext);

// Resource-keyed (literal-trailing) routes — :resource is a string enum,
// matched first to avoid getting captured by /:job_id below.
importsRouter.get('/:resource/schema', getSchema);
importsRouter.get('/:resource/template.csv', getTemplateCsv);
// SVT-RBAC-2026-05: import upload restricted to ADMIN. Counsellors could
// previously stage 50MB CSVs for unsuspecting admin apply — bulk DoS surface
// + supply-chain risk for malicious rows. ADMIN-only matches plan invariants.
// SVT-WAVE-RATE-LIMIT-IMPORTS-2026-05 — per-user 10/min cap, mounted BEFORE
// multer so a flood of multipart uploads doesn't tie up the file-buffer
// pool. Keyed per user (req.user.sub) — set after authenticate above.
importsRouter.post('/:resource', importsLimiter, requireRole('ADMIN'), upload.single('file'), postImport);

// Job-keyed (UUID) routes — uuidParam('job_id') keeps non-UUID literals
// like `/imports/jobs` from bubbling into Prisma as a 500.
importsRouter.get('/:job_id', uuidParam('job_id'), getJob);
importsRouter.get('/:job_id/report', uuidParam('job_id'), getJobReport);
importsRouter.get('/:job_id/errors.jsonl', uuidParam('job_id'), getJobErrors);
importsRouter.post('/:job_id/apply', uuidParam('job_id'), requireRole('ADMIN'), postApply);
// SVT-RBAC-2026-05: cancel inherits the ADMIN-only gate now that POST is
// ADMIN-only — symmetry + closes RBAC P1 (counsellor cancelling sibling jobs).
importsRouter.post('/:job_id/cancel', uuidParam('job_id'), requireRole('ADMIN'), postCancel);
importsRouter.get('/:job_id/result.jsonl', uuidParam('job_id'), getJobResult);
