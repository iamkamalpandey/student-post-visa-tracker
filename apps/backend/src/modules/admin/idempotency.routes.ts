// SVT-WAVE-BILLING-SEC-P1-F8 — operator sweeper for stuck idempotency rows.
//
// When `withIdempotency` finds a PENDING row it throws 409 rather than
// silently re-running the operation (the original behaviour replayed
// half-applied side effects). That is true at any age; rows past
// PENDING_STALE_MS (5 min) get a detail string telling the operator to
// investigate. Operators reconcile stuck rows via this endpoint:
//
//   POST /api/v1/admin/idempotency/:key/fail
//   { "scope": "billing.payment.create", "reason": "<why this was stuck>" }
//
// Effects:
//   - Locates the row by (tenant_id, scope, key) inside the caller's tenant
//     (RLS-scoped via tenantContext middleware). user_id is left out of the
//     lookup so the sweeper can resolve any user's stuck row.
//   - Flips status PENDING → FAILED with a synthetic 503 problem body so the
//     next retry of the same Idempotency-Key receives a deterministic error
//     replay (it will NEVER re-execute the original work).
//   - Writes an audit row (admin.idempotency.swept) so the admin's action is
//     forensically replayable.
//
// ADMIN-only. We deliberately do not expose a "reset to PENDING" / "delete"
// option — those would re-introduce the replay risk this endpoint exists to
// prevent. Operators who genuinely want a fresh execution should pick a new
// Idempotency-Key on the client side.
//
// PRECONDITION — SVT-FIN-2026-08 (T1-9). Sweeping to FAILED asserts that the
// operation did NOT complete, and every downstream consumer of that assertion
// acts on it: the client is replayed an error and a human re-enters the work.
// A PENDING row does not by itself establish that. Since T1-9 a row also stays
// PENDING when the operation SUCCEEDED but its outcome could not be written
// (`withIdempotency` logs that at error level with tenant/scope/key). On a
// money-mover, sweeping that row is how one payment becomes two — by hand,
// through the tool built to prevent it. Confirm against the ledger and the
// audit log FIRST; the `reason` field is where that evidence is recorded.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest, Conflict, NotFound, Unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';

export const adminIdempotencyRouter: Router = Router();
adminIdempotencyRouter.use(authenticate, tenantContext, requireRole('ADMIN'));

const SweepBody = z
  .object({
    scope: z.string().min(1).max(120),
    reason: z.string().min(3).max(500),
  })
  .strict();
type SweepBody = z.infer<typeof SweepBody>;

adminIdempotencyRouter.post(
  '/:key/fail',
  validate(SweepBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw Unauthorized();
      if (!req.db) throw new Error('tenantContext middleware not applied');
      const tenantId = req.user.tid;
      const actorId = req.user.sub;
      const key = req.params['key'];
      if (!key || key.length === 0 || key.length > 255) {
        throw BadRequest('Idempotency key must be 1-255 characters');
      }
      const body = req.body as SweepBody;

      // findFirst (not findUnique) because the UNIQUE is composite with
      // user_id which we deliberately omit — the sweeper resolves any
      // user's stuck row within this tenant + scope + key.
      const dao = (req.db as unknown as {
        idempotencyRecord: {
          findFirst(args: { where: Record<string, unknown> }): Promise<{
            id: string; status: 'PENDING' | 'SUCCESS' | 'FAILED'; user_id: string | null;
          } | null>;
          update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
        };
      }).idempotencyRecord;

      const row = await dao.findFirst({
        where: { tenant_id: tenantId, scope: body.scope, key },
      });
      if (!row) throw NotFound('Idempotency record not found');
      if (row.status !== 'PENDING') {
        throw Conflict(`Record is in status ${row.status}; sweeper only operates on PENDING.`);
      }

      const failedBody = {
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: `Operation marked FAILED by operator sweep: ${body.reason}`,
      };
      await dao.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          status_code: 503,
          response: failedBody,
          completed_at: new Date(),
        },
      });

      // Audit chain entry — captures who swept the row + the operator's reason.
      try {
        await writeAudit(req as never, {
          action: 'admin.idempotency.swept',
          entityType: 'idempotency_record',
          entityId: row.id,
          before: { status: 'PENDING' },
          after: {
            status: 'FAILED',
            scope: body.scope,
            key,
            reason: body.reason,
            target_user_id: row.user_id,
            actor_id: actorId,
          },
        });
      } catch {
        // Audit failure must not unwind the sweep; writeAudit logs internally.
      }

      res.status(200).json({ data: { id: row.id, status: 'FAILED' } });
    } catch (err) {
      next(err);
    }
  },
);
