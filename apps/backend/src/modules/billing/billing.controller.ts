// SVT-WAVE-BILLING-2026-05 — REST handlers for the billing surface.

import type { NextFunction, Request, Response } from 'express';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import * as planSvc from './plan.service.js';
import * as paySvc from './payment.service.js';
import * as creditSvc from './credit.service.js';

export const planController = {
  // POST /api/v1/billing/plans                 (admin / counsellor)
  // Idempotent via Idempotency-Key header (scope = 'billing.plan.create').
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'billing.plan.create' }, () =>
        planSvc.createFeePlan(req as never, req.body),
      );
    } catch (e) { next(e); }
  },

  // GET /api/v1/billing/plans
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as Record<string, string | undefined>;
      const rows = await planSvc.listFeePlans(req as never, {
        enrollment_id: q['enrollment_id'],
        student_id: q['student_id'],
        status: q['status'],
        limit: q['limit'] ? Number(q['limit']) : undefined,
      });
      res.json({ data: rows, page: { total: rows.length } });
    } catch (e) { next(e); }
  },

  // GET /api/v1/billing/plans/:id
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      const plan = await planSvc.getFeePlan(req as never, id);
      res.json({ data: plan });
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/plans/:id/pause
  async pause(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      const out = await planSvc.pausePlan(req as never, id, req.body);
      res.json({ data: out });
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/plans/:id/resume
  async resume(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      const out = await planSvc.resumePlan(req as never, id, req.body);
      res.json({ data: out });
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/plans/:id/cancel
  async cancel(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      const out = await planSvc.cancelPlan(req as never, id, req.body);
      res.json({ data: out });
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/plans/:id/regenerate
  async regenerate(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      await runIdempotent(req, res, { scope: 'billing.plan.regenerate' }, () =>
        planSvc.regeneratePlan(req as never, id, req.body),
      );
    } catch (e) { next(e); }
  },

  // GET /api/v1/billing/outstanding?student_id=... | ?enrollment_id=...
  async outstanding(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as Record<string, string | undefined>;
      const data = await planSvc.getOutstanding(req as never, {
        student_id: q['student_id'],
        enrollment_id: q['enrollment_id'],
      });
      res.json({ data });
    } catch (e) { next(e); }
  },
};

// ---------------------------------------------------------------------------
// Payment / Refund / Adjustment controllers (Wave 4)
// ---------------------------------------------------------------------------

export const paymentController = {
  // POST /api/v1/billing/payments
  // Idempotent via Idempotency-Key header (scope = 'billing.payment.create').
  async record(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'billing.payment.create' }, () =>
        paySvc.recordPayment(req as never, req.body),
      );
    } catch (e) { next(e); }
  },

  // GET /api/v1/billing/payments
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const q = req.query as Record<string, string | undefined>;
      const rows = await paySvc.listPayments(req as never, {
        student_id: q['student_id'],
        enrollment_id: q['enrollment_id'],
        status: q['status'] as never,
        from: q['from'],
        to: q['to'],
        limit: q['limit'] ? Number(q['limit']) : 25,
      } as never);
      res.json({ data: rows, page: { total: rows.length } });
    } catch (e) { next(e); }
  },

  // GET /api/v1/billing/payments/:id
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      const p = await paySvc.getPayment(req as never, id);
      res.json({ data: p });
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/payments/:id/void
  async void(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      // SVT-AUDIT-SEC-2026-06 (backlog rank 6) — honour the required
      // Idempotency-Key so a retry replays the cached response instead of
      // re-running (the in-tx status guard already prevents double-reversal,
      // but a retry should return the original 200, not a 409).
      await runIdempotent(req, res, { scope: 'billing.payment.void' }, () =>
        paySvc.voidPayment(req as never, id, req.body),
      );
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/payments/:id/refunds
  async createRefund(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      await runIdempotent(req, res, { scope: 'billing.refund.create' }, () =>
        paySvc.createRefund(req as never, id, req.body),
      );
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/refunds/:id/complete
  async completeRefund(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      // SVT-AUDIT-SEC-2026-06 (backlog rank 6) — wrap in runIdempotent so a
      // retry replays the cached response (the route requires the key but the
      // controller previously ignored it). In-tx status guard in the service
      // is the hard correctness backstop against double-reversal.
      await runIdempotent(req, res, { scope: 'billing.refund.complete' }, () =>
        paySvc.completeRefund(req as never, id, req.body),
      );
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/refunds/:id/fail
  async failRefund(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      // SVT-AUDIT-SEC-2026-06 (backlog rank 15) — idempotent like its money-mover
      // siblings; the route now also requires MFA step-up + Idempotency-Key.
      await runIdempotent(req, res, { scope: 'billing.refund.fail' }, () =>
        paySvc.markRefundFailed(req as never, id, req.body),
      );
    } catch (e) { next(e); }
  },
};

export const adjustmentController = {
  // POST /api/v1/billing/installments/:id/adjustments
  async apply(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      await runIdempotent(req, res, { scope: 'billing.adjustment.apply' }, () =>
        paySvc.applyAdjustment(req as never, id, req.body),
      );
    } catch (e) { next(e); }
  },
};

// ---------------------------------------------------------------------------
// Student credits (SVT-FIN-2026-08)
// ---------------------------------------------------------------------------
export const creditController = {
  // GET /api/v1/billing/credits
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const out = await creditSvc.listCredits(req as never, req.query as never);
      res.json({ data: out.credits, summary: out.summary, page: { total: out.credits.length } });
    } catch (e) { next(e); }
  },

  // GET /api/v1/billing/credits/:id
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const row = await creditSvc.getCredit(req as never, req.params['id']!);
      res.json({ data: row });
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/credits/:id/apply — money-mover, idempotent.
  async apply(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      await runIdempotent(req, res, { scope: 'billing.credit.apply' }, () =>
        creditSvc.applyCredit(req as never, id, req.body),
      );
    } catch (e) { next(e); }
  },

  // POST /api/v1/billing/credits/:id/reverse — retires an unspent credit.
  async reverse(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      await runIdempotent(req, res, { scope: 'billing.credit.reverse' }, () =>
        creditSvc.reverseCredit(req as never, id, req.body),
      );
    } catch (e) { next(e); }
  },
};
