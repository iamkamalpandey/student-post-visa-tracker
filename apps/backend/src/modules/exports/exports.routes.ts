// Export endpoints. Authenticated + tenant-scoped.

import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { exportDownloadLimiter } from '../../middlewares/rateLimit.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import {
  postExport,
  getExportJob,
  getDownload,
  postCancelExport,
} from './exports.controller.js';

export const exportsRouter: Router = Router();

exportsRouter.use(authenticate, tenantContext);

// SVT-RBAC-2026-05: bulk PII exfiltration surface. ADMIN-only. Counsellor-
// scoped per-student exports should land via /students/:id/export with an
// explicit student_id scope, not the tenant-wide /exports.
// SVT-WAVE-RATE-LIMIT-EXPORTS-2026-05 — per-user 10/min cap on create. An
// admin smashing "Export" 50 times queues 50 jobs that all hammer the same
// tables; this keeps the queue + storage budget bounded.
exportsRouter.post('/', exportDownloadLimiter, requireRole('ADMIN'), postExport);
// SVT-SEC-AUDIT-2026-05 — defence-in-depth role gate on the read/download/
// cancel surface. The service-layer ownership check (created_by_id ===
// userId OR ADMIN) is still the authoritative guard, but a VIEWER should
// never be able to even probe an export job — those endpoints leak PII
// (download) or metadata (resource, row_total) on success. Counsellors
// keep access because they own their own per-student export jobs.
exportsRouter.get('/:job_id', requireRole('ADMIN', 'COUNSELLOR'), uuidParam('job_id'), getExportJob);
// SVT-WAVE-RATE-LIMIT-EXPORTS-2026-05 — per-user 10/min cap on the download
// surface. Each download streams the full job artifact (CSV/JSONL, often
// many MB) so a polling loop is a real I/O hazard.
exportsRouter.get(
  '/:job_id/download',
  exportDownloadLimiter,
  requireRole('ADMIN', 'COUNSELLOR'),
  uuidParam('job_id'),
  getDownload,
);
exportsRouter.post('/:job_id/cancel', requireRole('ADMIN', 'COUNSELLOR'), uuidParam('job_id'), postCancelExport);
