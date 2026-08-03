// SVT-V2-DIAG-2026-08 — one-off diagnostic: histogram of raw V2 `state` values
// that live in crm_lead_courses. Used to build the LEGACY_STATE_TO_ENUM map
// after discovering the V2 free-text field has many variants beyond the exact
// strings the ingest currently maps.
//
//   GET /api/v1/admin/v2-diagnostics/state-histogram
//     → { data: [{ state, state_v2, count }, ...] }
//
// ADMIN only. Read-only.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { Unauthorized } from '../../shared/errors.js';

export const adminV2DiagnosticsRouter: Router = Router();
adminV2DiagnosticsRouter.use(authenticate, tenantContext, requireRole('ADMIN'));

adminV2DiagnosticsRouter.get(
  '/state-histogram',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw Unauthorized();
      if (!req.db) throw new Error('tenantContext middleware not applied');
      const tenantId = req.user.tid;

      const rows = await (req.db as unknown as {
        $queryRaw: <T>(q: Prisma.Sql) => Promise<T>;
      }).$queryRaw<Array<{ state: string | null; state_v2: string | null; count: bigint }>>(
        Prisma.sql`
          SELECT state, state_v2, COUNT(*)::bigint AS count
          FROM crm_lead_courses
          WHERE tenant_id = ${tenantId}::uuid
            AND deleted_at IS NULL
          GROUP BY state, state_v2
          ORDER BY count DESC
          LIMIT 200
        `,
      );

      res.json({
        data: rows.map((r) => ({
          state: r.state,
          state_v2: r.state_v2,
          count: Number(r.count),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// SVT-V2-DIAG-2026-08-02 — expose entity counts + join-match stats so we can
// tell why the /applications list is so small despite many visa-accepted lead
// courses. The list SQL matches crm_applications to crm_lead_courses on the
// (v2_lead_id, v2_course_id) pair, so if applications carry a different
// v2_course_id than the visa-accepted lead-course (e.g. the funnel state sits
// on a different course than the one the applicant applied for), the match
// drops silently and the queue looks empty.
adminV2DiagnosticsRouter.get(
  '/entity-counts',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw Unauthorized();
      if (!req.db) throw new Error('tenantContext middleware not applied');
      const tenantId = req.user.tid;

      const rows = await (req.db as unknown as {
        $queryRaw: <T>(q: Prisma.Sql) => Promise<T>;
      }).$queryRaw<Array<Record<string, bigint>>>(
        Prisma.sql`
          SELECT
            (SELECT COUNT(*) FROM crm_leads WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL) AS leads_total,
            (SELECT COUNT(*) FROM crm_applications WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL) AS applications_total,
            (SELECT COUNT(*) FROM crm_courses WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL) AS courses_total,
            (SELECT COUNT(*) FROM crm_lead_courses WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL) AS lead_courses_total,
            (SELECT COUNT(*) FROM crm_lead_courses WHERE tenant_id = ${tenantId}::uuid AND state_v2 = 'visa_accepted' AND deleted_at IS NULL) AS lead_courses_visa_accepted,
            (SELECT COUNT(*) FROM crm_applications a
               WHERE a.tenant_id = ${tenantId}::uuid AND a.deleted_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM crm_lead_courses lc
                    WHERE lc.tenant_id = ${tenantId}::uuid
                      AND lc.state_v2 = 'visa_accepted'
                      AND lc.deleted_at IS NULL
                      AND lc.v2_lead_id = a.v2_lead_id
                      AND lc.v2_course_id = a.v2_course_id
                 )) AS applications_matching_va,
            (SELECT COUNT(*) FROM crm_applications a
               WHERE a.tenant_id = ${tenantId}::uuid AND a.deleted_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM crm_lead_courses lc
                    WHERE lc.tenant_id = ${tenantId}::uuid
                      AND lc.state_v2 = 'visa_accepted'
                      AND lc.deleted_at IS NULL
                      AND lc.v2_lead_id = a.v2_lead_id
                 )) AS applications_matching_va_lead_only
        `,
      );
      const r = rows[0] ?? {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(r)) out[k] = Number(v);
      res.json({ data: out });
    } catch (err) {
      next(err);
    }
  },
);
