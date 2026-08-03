import './shared/bigint-serializer.js';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
// SVT-TYPES-2026-05 — pino-http's CJS module sets `module.exports = pinoLogger`
// plus `module.exports.default = pinoLogger` plus `module.exports.pinoHttp = ...`.
// Under NodeNext + esModuleInterop the default-import binding resolves to the
// namespace object whose type has no call signatures (TS2349). The named
// `pinoHttp` re-export typed as `PinoHttp` IS callable, so use that.
import { pinoHttp } from 'pino-http';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { register } from './config/metrics.js';
import { requestId } from './middlewares/requestId.js';
import { httpMetrics } from './middlewares/httpMetrics.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { sentryErrorHandler } from './config/sentry.js';
import { globalLimiter } from './middlewares/rateLimit.js';
import { authenticate } from './middlewares/auth.js';
import { tenantContext } from './middlewares/tenantContext.js';
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { studentsRouter } from './modules/students/students.routes.js';
import { stagesRouter } from './modules/stages/stages.routes.js';
import {
  stageChecklistItemsRouter,
  stageChecklistItemFlatRouter,
  studentChecklistProgressRouter,
} from './modules/checklist/routes.js';
import { lookupsRouter } from './modules/lookups/lookups.routes.js';
import { expiriesRouter } from './modules/expiries/routes.js';
import { visaTypesRouter } from './modules/visa-types/routes.js';
import {
  documentsRouter,
  studentDocumentsRouter,
} from './modules/documents/documents.routes.js';
import { importsRouter } from './modules/imports/imports.routes.js';
import { exportsRouter } from './modules/exports/exports.routes.js';
import { institutionsRouter } from './modules/institutions/institutions.routes.js';
import { superAgentsRouter } from './modules/super-agents/routes.js';
import { superAgentTypesRouter } from './modules/super-agent-types/routes.js';
import { institutionSuperAgentsRouter } from './modules/institution-super-agents/routes.js';
import { programsRouter } from './modules/programs/programs.routes.js';
import {
  enrollmentsRouter,
  studentEnrollmentsRouter,
} from './modules/enrollments/enrollments.routes.js';
import { commissionsRouter } from './modules/commissions/routes.js';
import { travelStudentRouter, travelRouter } from './modules/travel/routes.js';
import { accommodationStudentRouter, accommodationRouter } from './modules/accommodation/routes.js';
import { insuranceStudentRouter, insuranceRouter } from './modules/insurance/routes.js';
import { financeStudentRouter, financeRouter } from './modules/finance/routes.js';
import { complianceStudentRouter, complianceRouter } from './modules/compliance/routes.js';
import { engagementStudentRouter, engagementRouter } from './modules/engagement/routes.js';
import { employmentStudentRouter, employmentRouter } from './modules/employment/routes.js';
import { dependentStudentRouter, dependentRouter } from './modules/dependents/routes.js';
import { sponsorRouter, sponsorshipStudentRouter, sponsorshipRouter } from './modules/sponsorships/routes.js';
import { contactStudentRouter, contactRouter } from './modules/contacts/routes.js';
import { qualificationStudentRouter, qualificationRouter } from './modules/qualifications/routes.js';
import { languageTestStudentRouter, languageTestRouter } from './modules/language-tests/routes.js';
import { identificationStudentRouter, identificationRouter } from './modules/identifications/routes.js';
import { visaStudentRouter, visaRouter } from './modules/visas/routes.js';
import { regulatorIdStudentRouter, regulatorIdRouter } from './modules/regulator-ids/routes.js';
import { addressRouter, studentAddressRouter } from './modules/addresses/routes.js';
import { messageTemplateRouter, messageStudentRouter, inboxRouter, outboxAdminRouter, commsThreadsRouter } from './modules/comms/routes.js';
import { unsubscribeRouter } from './modules/comms/unsubscribe.routes.js';
import { webhooksRouter } from './modules/comms/webhooks.routes.js';
import { remindersRouter } from './modules/reminders/routes.js';
import { consentRouter } from './modules/consent/routes.js';
import { dsarRouter } from './modules/dsar/routes.js';
import { publicDsarRouter } from './modules/dsar-public/routes.js';
import { publicStatusRouter } from './modules/status-public/routes.js';
import { breachRouter } from './modules/breach/routes.js';
import { billingRouter } from './modules/billing/billing.routes.js';
import { crmLeadsRouter } from './modules/crm-leads/crm-leads.routes.js';
import {
  interviewQuestionsRouter,
  interviewAttemptsRouter,
  publicInterviewPrepRouter,
} from './modules/interview-prep/routes.js';
import { subProcessorRouter } from './modules/sub-processors/routes.js';
import { ropaRouter } from './modules/admin/ropa.routes.js';
// SVT-WAVE-BILLING-SEC-P1-F8 — operator sweeper for stuck idempotency rows.
import { adminIdempotencyRouter } from './modules/admin/idempotency.routes.js';
import { adminV2DiagnosticsRouter } from './modules/admin/v2-diagnostics.routes.js';
import { reportsRouter } from './modules/reports/routes.js';
import { tagRouter, entityTagRouter } from './modules/tags/routes.js';
import { noteRouter } from './modules/notes/routes.js';
import { attributeDefinitionRouter, entityAttributeRouter } from './modules/attributes/routes.js';
import { savedViewRouter } from './modules/saved-views/routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { wellKnownRouter } from './modules/wellknown/wellknown.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { tenantsRouter } from './modules/tenants/routes.js';
import { versionRouter } from './modules/version/version.routes.js';
import { openapiRouter } from './modules/openapi/openapi.routes.js';
import { auditLogsRouter } from './modules/audit/routes.js';
import { jobsRouter } from './modules/jobs/routes.js';
import { fsmRouter } from './modules/fsm/routes.js';
import { securityHeaders } from './middlewares/security.js';
import { cspReportRouter, errorReportRouter } from './modules/security/csp-report.routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestId);
  app.use(httpMetrics);
  app.use(
    pinoHttp({
      logger,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      customProps: (req) => ({ request_id: (req as { requestId?: string }).requestId }),
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: env.isProd
        ? {
            useDefaults: false,
            directives: {
              'default-src': ["'none'"],
              'script-src': ["'self'"],
              'connect-src': ["'self'"],
              'img-src': ["'self'", 'data:'],
              'style-src': ["'self'", "'unsafe-inline'"],
              'object-src': ["'none'"],
              'frame-ancestors': ["'none'"],
              'base-uri': ["'none'"],
            },
          }
        : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      // SVT-HSTS-2026-05: disable Helmet's HSTS so we can gate it on
      // req.secure || production inside securityHeaders. Browsers ignore HSTS
      // over plain HTTP, but a dev box ever proxied via TLS at a custom domain
      // would accidentally pin the host. Emit only when transport is secure.
      strictTransportSecurity: false,
    }),
  );

  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
      maxAge: 600,
    }),
  );

  // SVT-AUDIT-SEC-2026-06 (backlog rank 1) — capture the raw body bytes so
  // signed-webhook routes (Resend HMAC) can verify against exactly what the
  // sender signed. Without this, the global JSON parser consumes the body
  // (sets req._body) before the webhook router's own raw parser can run, so the
  // HMAC was computed over a re-stringified object and every signed webhook
  // 401'd in production. `verify` runs before JSON.parse and never blocks.
  app.use(
    express.json({
      limit: '256kb',
      strict: true,
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());
  app.use(securityHeaders);
  app.use(globalLimiter);

  // Discovery + health (public)
  app.use('/.well-known', wellKnownRouter);
  app.use('/api/v1/version', versionRouter);
  app.use('/api/v1/health', healthRouter);
  // SVT-WAVE-DSAR-PUBLIC-2026-05 — unauthenticated DSAR intake. Mounted BEFORE
  // any auth middleware (and crucially before the authenticated `/api/v1/dsar`
  // mount lower down) so no JWT is required and the router's own dedicated
  // rate limiter governs traffic. See modules/dsar-public/routes.ts.
  app.use('/api/v1/public', publicDsarRouter);
  // SVT-WAVE-STATUS-PUBLIC-2026-05 — unauthenticated operational status page
  // feed. Mounted under the same /api/v1/public mount as DSAR intake so both
  // run before the global authenticate middleware.
  app.use('/api/v1/public', publicStatusRouter);
  app.use('/api/v1/public', publicInterviewPrepRouter);
  // SVT-SEC-P2-FE3-2026-05 — public CSP violation report sink. Browsers never
  // send credentials with report-uri requests so this MUST run before any auth
  // middleware. Self-rate-limited (10/min/IP); see csp-report.routes.ts.
  app.use('/api/v1/csp', cspReportRouter);
  // SVT-SEC-P2-FE4-2026-05 — paired sink for frontend error-boundary reports
  // (sanitised: name + digest only — no message, no stack). Public + rate-limited.
  app.use('/api/v1/security', errorReportRouter);
  app.use('/api/v1/auth', authRouter);
  // authenticate + tenantContext are applied once at the mount point; the sub-routers
  // assume req.user / req.db are already populated.
  app.use('/api/v1/students', authenticate, tenantContext, studentsRouter);
  // Checklist items: nested + flat. Mounted BEFORE stagesRouter so the parameterised
  // /:id PATCH/DELETE in stagesRouter doesn't shadow `checklist-items`.
  app.use('/api/v1/stages/:stageId/checklist-items', stageChecklistItemsRouter);
  app.use('/api/v1/stages/checklist-items', stageChecklistItemFlatRouter);
  app.use('/api/v1/stages', authenticate, tenantContext, stagesRouter);
  // SVT-FSM-2026-05: read-only FSM-options surface. Lets the FE drop
  // hand-mirrored transition tables (e.g. enrollment-fsm.ts) and just fetch
  // from the live machine. Mounted after stagesRouter so the catch-all
  // doesn't shadow more specific routes.
  app.use('/api/v1/fsm', fsmRouter);
  // Per-student checklist progress.
  app.use(
    '/api/v1/students/:studentId/checklist-progress',
    studentChecklistProgressRouter,
  );
  app.use('/api/v1/lookups', authenticate, tenantContext, lookupsRouter);
  // v3: Triaged "expiries" inbox. Read-only union over visa / passport /
  // insurance / document / regulator-id sources. Mounted right after lookups
  // because it's a similarly cross-cutting reference surface, not tied to a
  // single owning module.
  app.use('/api/v1/expiries', authenticate, tenantContext, expiriesRouter);
  // v6: Per-(country × visa-type) admin catalogue. Mounted as its own root so the
  // parameterised /:id PATCH/DELETE doesn't collide with student modules.
  app.use('/api/v1/visa-types', authenticate, tenantContext, visaTypesRouter);
  app.use('/api/v1/interview-questions', authenticate, tenantContext, interviewQuestionsRouter);
  app.use('/api/v1/interview-attempts', authenticate, tenantContext, interviewAttemptsRouter);
  // Documents: mounted both as a student-nested resource (uploads + listing)
  // and as a flat id-keyed resource (download / verify / delete). The
  // student-nested mount runs *before* the flat /api/v1/documents mount so
  // express matches the more specific path first.
  app.use(
    '/api/v1/students/:studentId/documents',
    authenticate,
    tenantContext,
    studentDocumentsRouter,
  );
  app.use('/api/v1/documents', authenticate, tenantContext, documentsRouter);
  // Institutions / Programs / Enrollments. authenticate + tenantContext applied
  // at the mount point; sub-routers rely on req.user / req.db being populated.
  // Nested super-agents pivot mounts BEFORE the parent so the nested
  // /:id/super-agents path takes precedence over institutions' generic /:id
  // PATCH/DELETE handlers.
  app.use(
    '/api/v1/institutions/:id/super-agents',
    authenticate,
    tenantContext,
    institutionSuperAgentsRouter,
  );
  app.use('/api/v1/institutions', authenticate, tenantContext, institutionsRouter);
  // Super-agents catalogue (admin-only writes; reads open). Mounted as its own
  // root so the parameterised /:id PATCH/DELETE doesn't collide with student
  // modules.
  app.use('/api/v1/super-agents', authenticate, tenantContext, superAgentsRouter);
  // Admin-configurable super-agent category lookup. Counsellors can read, only
  // admins can mutate (enforced inside the router).
  app.use('/api/v1/super-agent-types', authenticate, tenantContext, superAgentTypesRouter);
  app.use('/api/v1/programs', authenticate, tenantContext, programsRouter);
  // Cross-student admin view + per-student nested route. The nested route mounts
  // *before* the flat /enrollments mount so the more specific path matches first.
  app.use(
    '/api/v1/students/:studentId/enrollments',
    authenticate,
    tenantContext,
    studentEnrollmentsRouter,
  );
  app.use('/api/v1/enrollments', authenticate, tenantContext, enrollmentsRouter);
  // Commissions (institution -> consultancy). authenticate + tenantContext applied
  // at the mount point so the sub-router can rely on req.user / req.db being set.
  app.use('/api/v1/commissions', authenticate, tenantContext, commissionsRouter);
  // Bulk import / export. Each router mounts its own authenticate + tenantContext but the
  // global mount keeps the layout consistent with the other modules.
  app.use('/api/v1/imports', importsRouter);
  app.use('/api/v1/exports', exportsRouter);

  // Domain sub-modules. Each router applies authenticate + tenantContext internally.
  // Student-nested routers are mounted before flat id-keyed routers so the more
  // specific path matches first.
  app.use('/api/v1/students/:studentId/travel', travelStudentRouter);
  app.use('/api/v1/travel', travelRouter);
  app.use('/api/v1/students/:studentId/accommodations', accommodationStudentRouter);
  app.use('/api/v1/accommodations', accommodationRouter);
  app.use('/api/v1/students/:studentId/insurances', insuranceStudentRouter);
  app.use('/api/v1/insurances', insuranceRouter);
  app.use('/api/v1/students/:studentId/finance', financeStudentRouter);
  app.use('/api/v1/finance', financeRouter);
  app.use('/api/v1/students/:studentId/compliance', complianceStudentRouter);
  app.use('/api/v1/compliance', complianceRouter);
  app.use('/api/v1/students/:studentId/engagements', engagementStudentRouter);
  app.use('/api/v1/engagements', engagementRouter);
  app.use('/api/v1/students/:studentId/employment', employmentStudentRouter);
  app.use('/api/v1/employment', employmentRouter);
  app.use('/api/v1/students/:studentId/dependents', dependentStudentRouter);
  app.use('/api/v1/dependents', dependentRouter);
  app.use('/api/v1/sponsors', sponsorRouter);
  app.use('/api/v1/students/:studentId/sponsorships', sponsorshipStudentRouter);
  app.use('/api/v1/sponsorships', sponsorshipRouter);
  app.use('/api/v1/students/:studentId/contacts', contactStudentRouter);
  app.use('/api/v1/contacts', contactRouter);
  app.use('/api/v1/students/:studentId/qualifications', qualificationStudentRouter);
  app.use('/api/v1/qualifications', qualificationRouter);
  app.use('/api/v1/students/:studentId/language-tests', languageTestStudentRouter);
  app.use('/api/v1/language-tests', languageTestRouter);
  app.use('/api/v1/students/:studentId/identifications', identificationStudentRouter);
  app.use('/api/v1/identifications', identificationRouter);
  app.use('/api/v1/students/:studentId/visas', visaStudentRouter);
  app.use('/api/v1/visas', visaRouter);
  app.use('/api/v1/students/:studentId/regulator-ids', regulatorIdStudentRouter);
  app.use('/api/v1/regulator-ids', regulatorIdRouter);
  app.use('/api/v1/students/:studentId/addresses', studentAddressRouter);
  app.use('/api/v1/addresses', addressRouter);
  app.use('/api/v1/message-templates', messageTemplateRouter);
  app.use('/api/v1/students/:studentId/messages', messageStudentRouter);
  app.use('/api/v1/inbox', inboxRouter);
  app.use('/api/v1/comms/threads', commsThreadsRouter);
  // SVT-COMPLIANCE-2026-05 — RFC 8058 one-click unsubscribe (no auth; HMAC token).
  app.use('/api/v1/comms/unsubscribe', unsubscribeRouter);
  // SVT-COMPLIANCE-2026-05 — Resend bounce/complaint webhook (svix HMAC).
  // Mounted with raw-body parser INSIDE the router; do not pre-parse JSON here.
  app.use('/api/v1/webhooks', webhooksRouter);
  app.use('/api/v1/admin/comms/outbox', outboxAdminRouter);
  app.use('/api/v1/reminders', remindersRouter);
  app.use('/api/v1/consents', consentRouter);
  app.use('/api/v1/dsar', dsarRouter);
  app.use('/api/v1/breach-incidents', breachRouter);
  // SVT-WAVE-BILLING-2026-05 — gated by Tenant.billing_enabled (404 when off).
  app.use('/api/v1/billing', billingRouter);
  // SVT-V2-CRM-MIRROR-2026-06 — CRM-lead mirror (V2 MIS ingest + session fees).
  app.use('/api/v1/leads', authenticate, tenantContext, crmLeadsRouter);
  app.use('/api/v1/sub-processors', subProcessorRouter);
  // SVT-GDPR-2026-05 — Art. 30 Records of Processing Activities (admin).
  app.use('/api/v1/admin', ropaRouter);
  // SVT-WAVE-BILLING-SEC-P1-F8 — sweeper for stuck PENDING idempotency rows.
  app.use('/api/v1/admin/idempotency', adminIdempotencyRouter);
  // SVT-V2-DIAG-2026-08 — histogram diagnostic for V2 free-text state values.
  app.use('/api/v1/admin/v2-diagnostics', adminV2DiagnosticsRouter);
  // SVT-WAVE-REPORTS-2026-05 — admin-only analytics endpoints.
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/tags', tagRouter);
  app.use('/api/v1/entity-tags', entityTagRouter);
  app.use('/api/v1/notes', noteRouter);
  app.use('/api/v1/attribute-definitions', attributeDefinitionRouter);
  app.use('/api/v1/entity-attributes', entityAttributeRouter);
  app.use('/api/v1/saved-views', savedViewRouter);
  app.use('/api/v1/dashboard', authenticate, tenantContext, dashboardRouter);
  app.use('/api/v1/audit-logs', authenticate, tenantContext, auditLogsRouter);
  // Background-job observability (admin-only). The job_runs table is global
  // (not tenant-scoped) but we still mount tenantContext so existing audit
  // helpers that read req.user.tid keep working.
  app.use('/api/v1/jobs', authenticate, tenantContext, jobsRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/tenants', tenantsRouter);

  // OpenAPI + Swagger UI: dev-only; hidden in prod by default. The router exposes
  // GET /api/v1/openapi.json and GET /api/v1/docs.
  if (env.isDev) {
    app.use('/api/v1', openapiRouter);
  }

  // Prometheus metrics — guarded by METRICS_TOKEN bearer or admin JWT.
  app.get('/metrics', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const metricsToken = process.env['METRICS_TOKEN'];
    if (metricsToken && token === metricsToken) {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
      return;
    }
    res.status(401).json({ status: 401, detail: 'METRICS_TOKEN required' });
  });

  // 404 + error handler last
  app.use(notFoundHandler);
  // SVT-QA-2026-08 — sentryErrorHandler mounted BEFORE the central
  // errorHandler so it can attach tenant / user / request_id tags before the
  // response is composed. The central errorHandler still calls
  // Sentry.captureException for defense in depth (no double-capture: sentry
  // dedupes by fingerprint within the same event).
  app.use(sentryErrorHandler());
  app.use(errorHandler);

  return app;
}
