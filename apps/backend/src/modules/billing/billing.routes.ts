// SVT-WAVE-BILLING-2026-05 — REST routes for the billing surface.
//
// Every route is gated by:
//   1. authenticate          — valid bearer token
//   2. tenantContext         — sets app.tenant_id GUC for RLS
//   3. billingEnabled        — 404 when tenant.billing_enabled = false
//   4. requireRole (varies)  — admin for plan mutations, counsellor+ for reads
//
// Wave 3 covers the FeePlan lifecycle (create/get/list/pause/resume/cancel/
// regenerate) + outstanding aggregate. Wave 4 will add payment routes.

import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { requireMfa } from '../../middlewares/requireMfa.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import {
  CreateFeePlanRequest,
  PausePlanRequest,
  ResumePlanRequest,
  CancelPlanRequest,
  RegeneratePlanRequest,
  FeePlanListQuery,
  OutstandingQuery,
  RecordPaymentRequest,
  VoidPaymentRequest,
  CreateRefundRequest,
  CompleteRefundRequest,
  FailRefundRequest,
  ApplyAdjustmentRequest,
  PaymentListQuery,
  StudentCreditListQuery,
  ApplyCreditRequest,
  ReverseCreditRequest,
} from '@spv/zod-schemas';
import { requireIdempotencyKey } from '../../shared/idempotencyHandler.js';
import { billingEnabled } from './middleware.js';
import {
  planController as ctl,
  paymentController as payCtl,
  adjustmentController as adjCtl,
  creditController as creditCtl,
} from './billing.controller.js';
import { renderInvoiceText, renderInvoicePdf } from './invoice.service.js';

export const billingRouter: Router = Router();
billingRouter.use(authenticate, tenantContext, billingEnabled);

// Reads — counsellor + admin.
billingRouter.get(
  '/plans',
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(FeePlanListQuery, 'query'),
  ctl.list,
);
billingRouter.get(
  '/plans/:id',
  requireRole('ADMIN', 'COUNSELLOR'),
  uuidParam('id'),
  ctl.get,
);
billingRouter.get(
  '/outstanding',
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(OutstandingQuery, 'query'),
  ctl.outstanding,
);

// GET /api/v1/billing/plans/:id/invoice.txt — text/plain invoice stub.
// Ownership: reuses getFeePlan (tenant-scoped) inside renderInvoiceText.
// Inherits authenticate + tenantContext + billingEnabled from router.use().
// FOLLOW-UP (1 day): swap to pdf-lib + application/pdf — handler shape stays.
billingRouter.get(
  '/plans/:id/invoice.txt',
  requireRole('ADMIN', 'COUNSELLOR'),
  uuidParam('id'),
  async (req, res, next) => {
    try {
      const id = req.params['id']!;
      const inv = await renderInvoiceText(req as never, id);
      // Conditional GET — short-circuit when client already has this version.
      if (req.headers['if-none-match'] === inv.etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', inv.contentType);
      res.setHeader('ETag', inv.etag);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${inv.filename}"`,
      );
      res.status(200).send(inv.body);
    } catch (e) { next(e); }
  },
);

// GET /api/v1/billing/plans/:id/invoice.pdf — real PDF (pdf-lib).
// Same auth/ownership gates as the .txt variant — both routes are intended to
// coexist during the rollout. Once customers/integrations are migrated we can
// retire .txt in a later wave.
billingRouter.get(
  '/plans/:id/invoice.pdf',
  requireRole('ADMIN', 'COUNSELLOR'),
  uuidParam('id'),
  async (req, res, next) => {
    try {
      const id = req.params['id']!;
      const inv = await renderInvoicePdf(req as never, id);
      if (req.headers['if-none-match'] === inv.etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', inv.contentType);
      res.setHeader('ETag', inv.etag);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${inv.filename}"`,
      );
      res.status(200).send(inv.body);
    } catch (e) { next(e); }
  },
);

// Writes — counsellor (create) + admin (cancel/regenerate).
billingRouter.post(
  '/plans',
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(CreateFeePlanRequest),
  ctl.create,
);
billingRouter.post(
  '/plans/:id/pause',
  requireRole('ADMIN', 'COUNSELLOR'),
  uuidParam('id'),
  validate(PausePlanRequest),
  ctl.pause,
);
billingRouter.post(
  '/plans/:id/resume',
  requireRole('ADMIN', 'COUNSELLOR'),
  uuidParam('id'),
  validate(ResumePlanRequest),
  ctl.resume,
);
// SVT-SEC-MFA-STEPUP-2026-05 — cancel-plan is destructive: requires fresh TOTP
// step-up via X-MFA-Code header when the caller has MFA enabled. Routine
// pause/resume/regenerate-plan are not gated; only the irreversible ones.
// SVT-SEC-MFA-ENROLMENT-2026-05 (P1-6) — strict variant: an admin who has
// never enrolled MFA is rejected 403 mfa_enrollment_required rather than
// allowed through. Refund / void / cancel-plan have unbounded blast radius
// (real money movement) so MFA enrolment is mandatory before the request
// reaches the handler.
billingRouter.post(
  '/plans/:id/cancel',
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  uuidParam('id'),
  validate(CancelPlanRequest),
  ctl.cancel,
);
// SVT-WAVE-IDEM-MONEY-MOVERS-2026-05 — regenerate mints replacement
// installments + a fresh invoice; a double-fire would corrupt the
// outstanding aggregate. Idempotency-Key required so a retry replays the
// cached response instead of duplicating writes.
billingRouter.post(
  '/plans/:id/regenerate',
  requireRole('ADMIN'),
  requireIdempotencyKey,
  uuidParam('id'),
  validate(RegeneratePlanRequest),
  ctl.regenerate,
);

// -------------------------------------------------------------------------
// Payments (Wave 4)
// -------------------------------------------------------------------------
billingRouter.get(
  '/payments',
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(PaymentListQuery, 'query'),
  payCtl.list,
);
billingRouter.get(
  '/payments/:id',
  requireRole('ADMIN', 'COUNSELLOR'),
  uuidParam('id'),
  payCtl.get,
);
// SVT-WAVE-IDEM-MONEY-MOVERS-2026-05 — record-payment is the canonical
// money-mover: double-firing on a retry creates a duplicate receipt + a
// double-credit to the installment. Idempotency-Key REQUIRED.
billingRouter.post(
  '/payments',
  requireRole('ADMIN', 'COUNSELLOR'),
  requireIdempotencyKey,
  validate(RecordPaymentRequest),
  payCtl.record,
);
// SVT-SEC-MFA-STEPUP-2026-05 — void/refund/complete-refund are the most
// destructive money-mover routes; require fresh TOTP step-up via X-MFA-Code
// header.
// SVT-SEC-MFA-ENROLMENT-2026-05 (P1-6) — strict variant: an admin who has
// never enrolled MFA is rejected 403 mfa_enrollment_required. The previous
// pass-through was a privilege-escalation hole — a stolen ADMIN access token
// belonging to a non-enrolled admin could refund any payment.
// P1-WB7 (2026-05) — void is a money-mover. Although it doesn't cut a real
// disbursement, double-firing flips the payment status sums twice and could
// trip downstream reconciliation. Idempotency-Key REQUIRED so a retry
// replays the cached response rather than mutating again.
billingRouter.post(
  '/payments/:id/void',
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  requireIdempotencyKey,
  uuidParam('id'),
  validate(VoidPaymentRequest),
  payCtl.void,
);
// SVT-WAVE-IDEM-MONEY-MOVERS-2026-05 — refund creation cuts a real
// disbursement; Idempotency-Key REQUIRED so a retry doesn't double-refund.
billingRouter.post(
  '/payments/:id/refunds',
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  requireIdempotencyKey,
  uuidParam('id'),
  validate(CreateRefundRequest),
  payCtl.createRefund,
);
// SVT-WAVE-IDEM-MONEY-MOVERS-2026-05 — completing a refund flips the
// downstream payment-status sums; Idempotency-Key REQUIRED.
billingRouter.post(
  '/refunds/:id/complete',
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  requireIdempotencyKey,
  uuidParam('id'),
  validate(CompleteRefundRequest),
  payCtl.completeRefund,
);
// SVT-AUDIT-SEC-2026-06 (backlog rank 15) — failing a refund flips
// refund/payment status sums, the same reconciliation surface its siblings
// (/complete, /void, /refunds) protect. Match them: MFA step-up + Idempotency-Key.
billingRouter.post(
  '/refunds/:id/fail',
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  requireIdempotencyKey,
  uuidParam('id'),
  validate(FailRefundRequest),
  payCtl.failRefund,
);

// -------------------------------------------------------------------------
// Adjustments (Wave 4) — LATE_FEE / DISCOUNT / SCHOLARSHIP / WAIVER / WRITE_OFF
// -------------------------------------------------------------------------
billingRouter.post(
  '/installments/:id/adjustments',
  requireRole('ADMIN', 'COUNSELLOR'),
  uuidParam('id'),
  // SVT-QA-2026-08 — every applied adjustment writes a DISCOUNT / SCHOLARSHIP /
  // LATE_FEE ledger row that shifts the installment's outstanding balance.
  // A duplicate on retry double-counts money. Every neighbouring money-mover
  // already carries requireIdempotencyKey; this one was the missing case.
  requireIdempotencyKey,
  validate(ApplyAdjustmentRequest),
  adjCtl.apply,
);

// -------------------------------------------------------------------------
// Student credits (SVT-FIN-2026-08)
//
// These rows existed since the billing wave but had no routes at all, so an
// overpayment was money the business held with no way to see it, return it, or
// apply it. Reads are counsellor+admin like every other billing read.
// -------------------------------------------------------------------------
billingRouter.get(
  '/credits',
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(StudentCreditListQuery, 'query'),
  creditCtl.list,
);
billingRouter.get(
  '/credits/:id',
  requireRole('ADMIN', 'COUNSELLOR'),
  uuidParam('id'),
  creditCtl.get,
);
// Applying a credit settles real debt on an installment — a money-mover in
// every sense except that the cash already arrived. Idempotency-Key required
// so a retry replays instead of drawing the credit down twice.
billingRouter.post(
  '/credits/:id/apply',
  requireRole('ADMIN', 'COUNSELLOR'),
  requireIdempotencyKey,
  uuidParam('id'),
  validate(ApplyCreditRequest),
  creditCtl.apply,
);
// Reversing retires a liability the business owes. Same guard set as void and
// refund: admin, MFA step-up with enrolment required, idempotent.
billingRouter.post(
  '/credits/:id/reverse',
  requireRole('ADMIN'),
  requireMfa({ enrollmentRequired: true }),
  requireIdempotencyKey,
  uuidParam('id'),
  validate(ReverseCreditRequest),
  creditCtl.reverse,
);
