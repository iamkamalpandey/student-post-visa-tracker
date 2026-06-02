// SVT-WAVE-BILLING-2026-05 (Wave 4) — Payment + Refund + Adjustment service.
//
// Public functions:
//   - recordPayment(ctx, input)         → Payment row + PaymentAllocation rows
//                                          (auto-FIFO or explicit) + StudentCredit
//                                          on overflow.
//   - voidPayment(ctx, paymentId, opts) → reverses allocations, restores installment
//                                          balances + statuses, Payment → VOIDED.
//   - createRefund(ctx, paymentId, opts) → Refund row in PENDING.
//   - completeRefund(ctx, refundId, opts)→ reverse allocations partially/fully,
//                                          Payment → PARTIALLY_REFUNDED | REFUNDED,
//                                          installments PAID/PARTIAL → REFUNDED,
//                                          StudentCredit on credit_carryforward.
//   - applyAdjustment(ctx, instId, opts) → FeeAdjustment row, recompute installment
//                                          net + balance + status.
//   - listPayments(ctx, q)
//   - getPayment(ctx, paymentId)
//
// Concurrency:
//   - Every write runs inside prisma.$transaction with SET LOCAL app.tenant_id
//     so RLS pins the row set.
//   - Installments are SELECTed with FOR UPDATE inside the same tx to block
//     concurrent FIFO/refund/adjustment paths from racing to over-allocate.
//   - Receipt numbers come from billing_next_receipt_no(tenant_id) — Postgres
//     sequence advances atomically.
//
// Invariants enforced (defence-in-depth on top of the DB trigger):
//   - SUM(allocation.amount) per payment ≤ payment.gross_minor
//   - Sum of explicit allocations ≤ gross_minor (caller-supplied)
//   - Allocation amount ≤ installment.balance_minor at time of write
//   - Currency match: payment.currency = installment.currency for every alloc
//   - FSM-gated status moves on every Payment + FeeInstallment transition.

import type { Prisma, PrismaClient, FeeInstallmentStatus, PaymentMethod } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { env } from '../../config/env.js';
import { writeAudit } from '../../shared/audit.js';
import { assertOrThrow } from '../../shared/fsm.js';
import { BadRequest, NotFound, Conflict, Forbidden, UnprocessableEntity } from '../../shared/errors.js';
import type {
  RecordPaymentRequest,
  VoidPaymentRequest,
  CreateRefundRequest,
  CompleteRefundRequest,
  ApplyAdjustmentRequest,
  PaymentListQuery,
} from '@spv/zod-schemas';
import {
  allocateFifo,
  recomputeInstallmentAmounts,
} from './pricing.js';
import { feeInstallmentFsm, paymentFsm, refundFsm } from './fsm-def.js';

type DB = PrismaClient | Prisma.TransactionClient;
type Role = 'ADMIN' | 'COUNSELLOR' | 'VIEWER';

type Ctx = {
  db?: DB;
  user?: { tid: string; sub?: string; role?: Role };
};

const db = (ctx: Ctx): DB => ctx.db ?? prisma;
const tenantOf = (ctx: Ctx): string => {
  if (!ctx.user?.tid) throw BadRequest('Missing tenant context');
  return ctx.user.tid;
};
const actorOf = (ctx: Ctx): string | null => ctx.user?.sub ?? null;
const roleOf = (ctx: Ctx): Role => (ctx.user?.role ?? 'COUNSELLOR') as Role;

// ---------------------------------------------------------------------------
// recordPayment
// ---------------------------------------------------------------------------
//
// FIFO mode (no allocations[]):
//   1. Load all SCHEDULED|INVOICED|DUE|OVERDUE|PARTIAL installments for the
//      enrollment in due_on ASC, FOR UPDATE.
//   2. allocateFifo() produces per-installment splits.
//   3. Overflow → StudentCredit (source='overpayment').
//
// Manual mode (allocations[] provided):
//   1. Validate sum ≤ gross.
//   2. Lock each cited installment FOR UPDATE.
//   3. Validate per-installment amount ≤ balance_minor + currency match.
//   4. Apply.
//
// On every successful allocation:
//   - installment.paid_minor += alloc.amount
//   - balance_minor recomputed
//   - status transition via feeInstallmentFsm:
//       * balance == 0          → PAID
//       * 0 < balance < net     → PARTIAL
// ---------------------------------------------------------------------------

export async function recordPayment(ctx: Ctx, input: RecordPaymentRequest) {
  const tenantId = tenantOf(ctx);
  const actorId = actorOf(ctx);
  const role = roleOf(ctx);

  // Validate enrollment belongs to tenant. Use loose loader; RLS will already
  // hide cross-tenant rows but explicit NotFound is cleaner.
  const enrollment = await db(ctx).enrollment.findFirst({
    where: { id: input.enrollment_id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, student_id: true, tuition_currency: true },
  });
  if (!enrollment) throw NotFound('Enrollment not found');

  if (input.allocations && input.allocations.length > 0) {
    const sum = input.allocations.reduce((s, a) => s + a.amount_minor, 0n);
    if (sum > input.gross_minor) {
      throw BadRequest('allocations sum exceeds gross_minor');
    }
  }

  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    // Mint receipt number atomically via Postgres sequence.
    const seqRows = await tx.$queryRaw<Array<{ next_no: string }>>`
      SELECT billing_next_receipt_no(${tenantId}::uuid) AS next_no
    `;
    const seqRow = seqRows[0];
    if (!seqRow) {
      throw new Error('billing_next_receipt_no returned no rows');
    }
    const { next_no } = seqRow;

    const payment = await tx.payment.create({
      data: {
        tenant_id: tenantId,
        student_id: enrollment.student_id,
        enrollment_id: enrollment.id,
        received_on: new Date(input.received_on),
        method: input.method,
        reference: input.reference ?? null,
        receipt_no: next_no,
        currency: input.currency,
        gross_minor: input.gross_minor,
        status: 'RECEIVED',
        notes: input.notes ?? null,
        created_by_id: actorId,
        updated_by_id: actorId,
      },
    });

    // Resolve target installments + lock them. We use SELECT … FOR UPDATE so a
    // concurrent payment can't double-allocate the same balance.
    let targets: Array<{ id: string; balance_minor: bigint; net_minor: bigint; currency: string; status: FeeInstallmentStatus }>;
    if (input.allocations && input.allocations.length > 0) {
      const ids = input.allocations.map((a) => a.fee_installment_id);
      // Postgres array binding via Prisma raw. Status filter excludes
      // terminal rows (WAIVED / CANCELLED / REFUNDED) — defence in depth on
      // top of balance/amount checks below; previously a CANCELLED row with
      // non-zero balance would silently accept money.
      targets = await tx.$queryRaw<typeof targets>`
        SELECT id, balance_minor, net_minor, currency, status
        FROM fee_installments
        WHERE id = ANY(${ids}::uuid[])
          AND tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
          AND status NOT IN ('WAIVED','CANCELLED','REFUNDED')
        FOR UPDATE
      `;
      if (targets.length !== ids.length) {
        throw BadRequest('One or more installments not found or in terminal status (WAIVED/CANCELLED/REFUNDED)');
      }
    } else {
      // FIFO mode: pull all open installments for this enrollment, oldest first.
      targets = await tx.$queryRaw<typeof targets>`
        SELECT i.id, i.balance_minor, i.net_minor, i.currency, i.status
        FROM fee_installments i
        JOIN fee_plans p ON p.id = i.fee_plan_id
        WHERE p.enrollment_id = ${enrollment.id}::uuid
          AND i.tenant_id = ${tenantId}::uuid
          AND i.deleted_at IS NULL
          AND i.status IN ('SCHEDULED','INVOICED','DUE','OVERDUE','PARTIAL')
        ORDER BY i.due_on ASC, i.sequence_no ASC
        FOR UPDATE
      `;
    }

    // Currency invariant — single-currency-per-payment for v1. Mixed-currency
    // payments would need FX which is out of scope.
    for (const t of targets) {
      if (t.currency !== input.currency) {
        throw BadRequest(
          `Currency mismatch: payment ${input.currency} vs installment ${t.currency}`,
        );
      }
    }

    // Build the allocation set.
    const allocs: Array<{ fee_installment_id: string; amount_minor: bigint }> = [];
    let overflow = 0n;

    if (input.allocations && input.allocations.length > 0) {
      const byId = new Map(targets.map((t) => [t.id, t]));
      for (const a of input.allocations) {
        const target = byId.get(a.fee_installment_id);
        if (!target) throw BadRequest(`Installment ${a.fee_installment_id} missing`);
        if (a.amount_minor > target.balance_minor) {
          throw Conflict(
            `Allocation ${a.amount_minor} exceeds installment balance ${target.balance_minor}`,
          );
        }
        allocs.push({ fee_installment_id: a.fee_installment_id, amount_minor: a.amount_minor });
      }
      // Any unallocated remainder → overflow credit.
      const sum = allocs.reduce((s, a) => s + a.amount_minor, 0n);
      overflow = input.gross_minor - sum;
    } else {
      const fifo = allocateFifo({
        gross_minor: input.gross_minor,
        installments: targets,
      });
      for (const a of fifo.allocations) allocs.push(a);
      overflow = fifo.overflow_minor;
    }

    // Write allocations + update installments + FSM transitions.
    for (const a of allocs) {
      await tx.paymentAllocation.create({
        data: {
          tenant_id: tenantId,
          payment_id: payment.id,
          fee_installment_id: a.fee_installment_id,
          amount_minor: a.amount_minor,
          created_by_id: actorId,
        },
      });
      const target = targets.find((t) => t.id === a.fee_installment_id)!;
      const newPaid = (target.net_minor - target.balance_minor) + a.amount_minor;
      const recomputed = recomputeInstallmentAmounts({
        gross_minor: target.net_minor, // gross treated as net here (we're cumulative)
        adjustments_sum_minor: 0n,
        paid_minor: newPaid,
      });
      const nextStatus: FeeInstallmentStatus =
        recomputed.balance_minor === 0n ? 'PAID' : 'PARTIAL';
      assertOrThrow(feeInstallmentFsm, target.status, nextStatus, role);
      await tx.feeInstallment.update({
        where: { id: target.id },
        data: {
          paid_minor: newPaid,
          balance_minor: recomputed.balance_minor,
          status: nextStatus,
          updated_by_id: actorId,
          version: { increment: 1 },
        },
      });
      // Mutate the local target snapshot so subsequent loop iterations see fresh balance.
      target.balance_minor = recomputed.balance_minor;
      target.status = nextStatus;
    }

    // Overflow → StudentCredit row.
    if (overflow > 0n) {
      await tx.studentCredit.create({
        data: {
          tenant_id: tenantId,
          student_id: enrollment.student_id,
          enrollment_id: enrollment.id,
          amount_minor: overflow,
          currency: input.currency,
          source: 'overpayment',
          source_ref_id: payment.id,
          consumed_minor: 0n,
          created_by_id: actorId,
        },
      });
    }

    return { payment, allocations: allocs, overflow };
  });

  await writeAudit(ctx as never, {
    action: 'payment.received',
    entityType: 'payment',
    entityId: out.payment.id,
    after: {
      receipt_no: out.payment.receipt_no,
      gross_minor: out.payment.gross_minor.toString(),
      currency: out.payment.currency,
      method: out.payment.method,
      allocation_count: out.allocations.length,
      overflow_minor: out.overflow.toString(),
    },
  });

  return out.payment;
}

// ---------------------------------------------------------------------------
// voidPayment — reverses every allocation, restores installment balances.
// ADMIN only (FSM-gated). VOIDED is terminal.
// ---------------------------------------------------------------------------

export async function voidPayment(ctx: Ctx, paymentId: string, input: VoidPaymentRequest) {
  const tenantId = tenantOf(ctx);
  const actorId = actorOf(ctx);
  const role = roleOf(ctx);

  const before = await db(ctx).payment.findFirst({
    where: { id: paymentId, tenant_id: tenantId, deleted_at: null },
    select: { id: true, status: true, gross_minor: true },
  });
  if (!before) throw NotFound('Payment not found');
  assertOrThrow(paymentFsm, before.status, 'VOIDED', role, input.reason);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    // Pull allocations, reverse each installment's paid_minor + balance + status.
    const allocs = await tx.paymentAllocation.findMany({
      where: { payment_id: paymentId, tenant_id: tenantId },
      select: { id: true, fee_installment_id: true, amount_minor: true },
    });

    for (const a of allocs) {
      const inst = await tx.$queryRaw<Array<{ id: string; paid_minor: bigint; net_minor: bigint; status: FeeInstallmentStatus }>>`
        SELECT id, paid_minor, net_minor, status FROM fee_installments
        WHERE id = ${a.fee_installment_id}::uuid
          AND tenant_id = ${tenantId}::uuid
        FOR UPDATE
      `;
      const i = inst[0]!;
      const newPaid = i.paid_minor - a.amount_minor;
      if (newPaid < 0n) {
        throw Conflict(`Void would push installment ${i.id} paid_minor below zero`);
      }
      const newBalance = i.net_minor - newPaid;
      // Status rollback:
      //   PAID    → PARTIAL (if newPaid > 0) | INVOICED (if 0)
      //   PARTIAL → PARTIAL (if still > 0)   | INVOICED (if 0)
      //   other   → preserved
      let nextStatus: FeeInstallmentStatus = i.status;
      if (i.status === 'PAID' || i.status === 'PARTIAL') {
        nextStatus = newPaid > 0n ? 'PARTIAL' : 'INVOICED';
      }
      // FSM gate (PAID→INVOICED + PAID→PARTIAL + PARTIAL→INVOICED edges live in fsm-def.ts).
      if (nextStatus !== i.status) {
        assertOrThrow(feeInstallmentFsm, i.status, nextStatus, role, input.reason);
      }
      await tx.feeInstallment.update({
        where: { id: i.id },
        data: {
          paid_minor: newPaid,
          balance_minor: newBalance,
          status: nextStatus,
          updated_by_id: actorId,
          version: { increment: 1 },
        },
      });
    }

    // Delete allocation rows (audit retains the original Payment row).
    await tx.paymentAllocation.deleteMany({ where: { payment_id: paymentId, tenant_id: tenantId } });

    // SVT-AUDIT-SEC-2026-06 (backlog rank 6) — in-tx status guard so two
    // concurrent voids can't both reverse the same allocations. before.status
    // was read outside this tx; gating the flip on it still holding means the
    // loser matches 0 rows, throws, and its reversal rolls back.
    const flip = await tx.payment.updateMany({
      where: { id: paymentId, status: before.status },
      data: {
        status: 'VOIDED',
        notes: input.reason,
        updated_by_id: actorId,
        version: { increment: 1 },
      },
    });
    if (flip.count !== 1) {
      throw Conflict('Payment was modified concurrently');
    }
    return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  });

  await writeAudit(ctx as never, {
    action: 'payment.voided',
    entityType: 'payment',
    entityId: paymentId,
    before: { status: before.status },
    after: { status: 'VOIDED', reason: input.reason },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// createRefund — Refund row in PENDING. Does NOT reverse allocations yet.
// ---------------------------------------------------------------------------

export async function createRefund(ctx: Ctx, paymentId: string, input: CreateRefundRequest) {
  const tenantId = tenantOf(ctx);
  const actorId = actorOf(ctx);

  // SVT-WAVE-BILLING-SEC-P1-F4 — race-free refund cap. Two concurrent refunds
  // of $50 against an $80 payment must NOT both succeed. We previously
  // aggregated then INSERTed outside of any transaction; the lock-free window
  // between the SELECT and the INSERT let both racers see the original $0 sum
  // and both succeed. Now the aggregate + create live inside a Serializable
  // transaction with an explicit `SELECT … FOR UPDATE` on the Payment row so
  // any concurrent createRefund/voidPayment/completeRefund against the same
  // payment serialises behind us.
  const refund = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const lockedRows = await tx.$queryRaw<Array<{
        id: string; status: string; gross_minor: bigint; currency: string;
      }>>`
        SELECT id, status, gross_minor, currency
        FROM payments
        WHERE id = ${paymentId}::uuid
          AND tenant_id = ${tenantId}::uuid
          AND deleted_at IS NULL
        FOR UPDATE
      `;
      const payment = lockedRows[0];
      if (!payment) throw NotFound('Payment not found');
      if (payment.status === 'VOIDED') {
        throw Conflict('Cannot refund a voided payment');
      }

      // Total already-refunded amount against this payment. Read inside the
      // transaction so it sees rows committed by any prior refund that just
      // released its FOR UPDATE lock.
      const existing = await tx.refund.aggregate({
        where: {
          payment_id: paymentId,
          tenant_id: tenantId,
          status: { in: ['PENDING', 'COMPLETED'] },
        },
        _sum: { amount_minor: true },
      });
      const alreadyRefunded = existing._sum.amount_minor ?? 0n;
      if (alreadyRefunded + input.amount_minor > payment.gross_minor) {
        throw UnprocessableEntity(
          `Refund total would exceed payment.gross_minor (${alreadyRefunded + input.amount_minor} > ${payment.gross_minor})`,
        );
      }

      return tx.refund.create({
        data: {
          tenant_id: tenantId,
          payment_id: paymentId,
          amount_minor: input.amount_minor,
          method: input.method,
          reference: input.reference ?? null,
          reason_code: input.reason_code,
          reason_text: input.reason_text,
          status: 'PENDING',
          notes: input.notes ?? null,
          created_by_id: actorId,
          updated_by_id: actorId,
        },
      });
    },
    { isolationLevel: 'Serializable' },
  );

  await writeAudit(ctx as never, {
    action: 'refund.created',
    entityType: 'refund',
    entityId: refund.id,
    after: {
      payment_id: paymentId,
      amount_minor: refund.amount_minor.toString(),
      method: refund.method,
      reason_code: refund.reason_code,
    },
  });
  return refund;
}

// ---------------------------------------------------------------------------
// completeRefund — moves Refund PENDING → COMPLETED. ADMIN-only.
//
// Process:
//   1. Lock Refund + Payment + relevant allocations.
//   2. Reverse PaymentAllocations proportionally from newest-first (LIFO) so
//      we unwind the most recent installment first.
//   3. Each affected installment: paid_minor -= refunded, balance += refunded,
//      status flips PAID→PARTIAL or PAID→REFUNDED depending on full vs partial.
//      (REFUNDED is terminal; we only mark REFUNDED when the entire installment
//      payment is unwound. Partial unwind → PARTIAL.)
//   4. If credit_carryforward=true and there's surplus not mapped to allocations
//      (e.g. refund > sum(allocs)), create a StudentCredit row.
//   5. Payment status: PARTIALLY_REFUNDED (some remains) | REFUNDED (sum = gross).
// ---------------------------------------------------------------------------

export async function completeRefund(ctx: Ctx, refundId: string, input: CompleteRefundRequest) {
  const tenantId = tenantOf(ctx);
  const actorId = actorOf(ctx);
  const role = roleOf(ctx);
  if (role !== 'ADMIN') throw Forbidden('Only ADMIN can complete refunds');

  const refund = await db(ctx).refund.findFirst({
    where: { id: refundId, tenant_id: tenantId },
    select: {
      id: true, payment_id: true, amount_minor: true, status: true,
    },
  });
  if (!refund) throw NotFound('Refund not found');
  if (refund.status !== 'PENDING') {
    throw Conflict(`Refund already in status ${refund.status}`);
  }

  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    const payment = await tx.payment.findFirst({
      where: { id: refund.payment_id, tenant_id: tenantId },
      select: {
        id: true, status: true, gross_minor: true, currency: true,
        student_id: true, enrollment_id: true,
      },
    });
    if (!payment) throw NotFound('Payment vanished');

    // LIFO reversal — newest allocations first so we unwind chronologically.
    const allocs = await tx.paymentAllocation.findMany({
      where: { payment_id: payment.id, tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
    });

    let toReverse = refund.amount_minor;
    let surplus = 0n;

    for (const a of allocs) {
      if (toReverse <= 0n) break;
      const reverseAmount = toReverse < a.amount_minor ? toReverse : a.amount_minor;
      const inst = await tx.$queryRaw<Array<{ id: string; paid_minor: bigint; net_minor: bigint; status: FeeInstallmentStatus }>>`
        SELECT id, paid_minor, net_minor, status FROM fee_installments
        WHERE id = ${a.fee_installment_id}::uuid
          AND tenant_id = ${tenantId}::uuid
        FOR UPDATE
      `;
      const i = inst[0]!;
      const newPaid = i.paid_minor - reverseAmount;
      if (newPaid < 0n) {
        throw Conflict(`Refund of ${reverseAmount} would push installment below zero`);
      }
      const newBalance = i.net_minor - newPaid;
      // BUG-FIX-SEC-2026-05: derive nextStatus from newPaid vs net_minor, not
      // from "did we fully unwind THIS allocation". An installment may carry
      // multiple PaymentAllocations from different Payments; unwinding one
      // does not mean the installment is unpaid.
      //   newPaid == 0                → REFUNDED (the only money left is now zero)
      //   0 < newPaid < net_minor     → PARTIAL
      //   newPaid >= net_minor        → preserve PAID (other allocations cover)
      let nextStatus: FeeInstallmentStatus = i.status;
      if (newPaid === 0n) {
        if (i.status === 'PAID' || i.status === 'PARTIAL') {
          nextStatus = 'REFUNDED';
        }
      } else if (newPaid < i.net_minor) {
        if (i.status === 'PAID') nextStatus = 'PARTIAL';
      }
      // fullUnwind = this single allocation row was reversed in its entirety
      // (consumed all of it). Used below to decide whether to DELETE the
      // allocation row or just decrement amount_minor. The CRITICAL bug
      // identified by audit was that this name was undefined after the
      // status-derivation refactor.
      const fullUnwind = reverseAmount >= a.amount_minor;
      if (nextStatus !== i.status) {
        assertOrThrow(feeInstallmentFsm, i.status, nextStatus, role, 'refund');
      }
      await tx.feeInstallment.update({
        where: { id: i.id },
        data: {
          paid_minor: newPaid,
          balance_minor: newBalance,
          status: nextStatus,
          updated_by_id: actorId,
          version: { increment: 1 },
        },
      });
      // Reduce allocation amount or delete entirely if fully unwound.
      if (fullUnwind) {
        await tx.paymentAllocation.delete({ where: { id: a.id } });
      } else {
        await tx.paymentAllocation.update({
          where: { id: a.id },
          data: { amount_minor: a.amount_minor - reverseAmount },
        });
      }
      toReverse -= reverseAmount;
    }

    // Any remaining toReverse means the refund exceeds allocated amount —
    // means caller had overpaid (StudentCredit territory) OR caller wants
    // explicit goodwill refund. Either way, optionally carryforward.
    if (toReverse > 0n) {
      surplus = toReverse;
      // BUG-FIX-SEC-2026-05: silent StudentCredit creation is unsafe — an
      // admin completing a refund without realising the amount exceeds
      // allocations would mint phantom money. Require explicit true.
      if (input.credit_carryforward === true) {
        await tx.studentCredit.create({
          data: {
            tenant_id: tenantId,
            student_id: payment.student_id,
            enrollment_id: payment.enrollment_id,
            amount_minor: surplus,
            currency: payment.currency,
            source: 'refund_carryforward',
            source_ref_id: refund.id,
            consumed_minor: 0n,
            created_by_id: actorId,
          },
        });
      } else {
        throw Conflict(
          `Refund amount exceeds allocations by ${surplus}. Pass credit_carryforward=true to absorb as student credit.`,
        );
      }
    }

    // Payment status — sum only COMPLETED refunds + this refund's amount.
    // BUG-FIX-SEC-2026-05: previously we summed `in:['PENDING','COMPLETED']`
    // which double-counted THIS refund (still PENDING at the time of the
    // aggregate) plus any other unrelated PENDING refunds, prematurely
    // flipping the payment to REFUNDED before other refunds completed.
    const totalRefunded = await tx.refund.aggregate({
      where: { payment_id: payment.id, status: 'COMPLETED' },
      _sum: { amount_minor: true },
    });
    const refundedSum = (totalRefunded._sum.amount_minor ?? 0n) + refund.amount_minor;
    const nextPaymentStatus = refundedSum >= payment.gross_minor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    assertOrThrow(paymentFsm, payment.status, nextPaymentStatus, role, 'refund completion');

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: nextPaymentStatus,
        updated_by_id: actorId,
        version: { increment: 1 },
      },
    });

    // SVT-AUDIT-SEC-2026-06 (backlog rank 6) — in-tx status guard. The PENDING
    // check above runs OUTSIDE this transaction, so two concurrent completions
    // both pass it; the FOR UPDATE on the installment serialises them, but the
    // loser would otherwise reverse the installment balances a SECOND time.
    // Gating the terminal flip on the row still being PENDING means the loser
    // matches 0 rows, throws, and its double-reversal rolls back with the tx.
    const flip = await tx.refund.updateMany({
      where: { id: refund.id, status: 'PENDING' },
      data: {
        status: 'COMPLETED',
        refunded_on: new Date(input.refunded_on),
        reference: input.reference ?? undefined,
        updated_by_id: actorId,
        version: { increment: 1 },
      },
    });
    if (flip.count !== 1) {
      throw Conflict('Refund was completed concurrently');
    }
    const completed = await tx.refund.findUniqueOrThrow({ where: { id: refund.id } });

    return { refund: completed, surplus, paymentStatus: nextPaymentStatus };
  });

  await writeAudit(ctx as never, {
    action: 'refund.completed',
    entityType: 'refund',
    entityId: refundId,
    before: { status: 'PENDING' },
    after: {
      status: 'COMPLETED',
      refunded_on: input.refunded_on,
      surplus_minor: out.surplus.toString(),
      payment_status: out.paymentStatus,
    },
  });
  return out.refund;
}

// ---------------------------------------------------------------------------
// markRefundFailed — gateway / bank-rail failure flow.
//
// Operators call this when a PENDING refund could not be transmitted (failed
// bank-rail call / cheque bounce). Flips PENDING → FAILED with a reason so
// the row stays auditable. Does NOT touch allocations or installments — the
// refund never actually moved money, so installment + payment stay as-is.
// ---------------------------------------------------------------------------

export async function markRefundFailed(
  ctx: Ctx,
  refundId: string,
  input: { reason: string; provider_error?: string },
) {
  const tenantId = tenantOf(ctx);
  const actorId = actorOf(ctx);
  const role = roleOf(ctx);
  if (role !== 'ADMIN') throw Forbidden('Only ADMIN can mark refunds failed');

  const refund = await db(ctx).refund.findFirst({
    where: { id: refundId, tenant_id: tenantId },
    select: { id: true, status: true },
  });
  if (!refund) throw NotFound('Refund not found');
  if (refund.status !== 'PENDING') {
    throw Conflict(`Refund is in status ${refund.status}; only PENDING refunds can be failed`);
  }
  assertOrThrow(refundFsm, 'PENDING', 'FAILED', role, input.reason);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    // SVT-AUDIT-SEC-2026-06 (backlog rank 6/15) — in-tx status guard; the
    // PENDING check above is outside this tx, so a concurrent fail/complete
    // could race. Gate the flip on the row still being PENDING.
    const flip = await tx.refund.updateMany({
      where: { id: refundId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        notes: `${input.reason}${input.provider_error ? ` :: ${input.provider_error}` : ''}`,
        updated_by_id: actorId,
        version: { increment: 1 },
      },
    });
    if (flip.count !== 1) {
      throw Conflict('Refund was modified concurrently');
    }
    return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  });

  await writeAudit(ctx as never, {
    action: 'refund.failed',
    entityType: 'refund',
    entityId: refundId,
    before: { status: 'PENDING' },
    after: {
      status: 'FAILED',
      reason: input.reason,
      provider_error: input.provider_error ?? null,
    },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// applyAdjustment — LATE_FEE / DISCOUNT / SCHOLARSHIP / WAIVER / WRITE_OFF.
// Recomputes net + balance + status. WAIVER is FSM-gated (admin + reason).
// ---------------------------------------------------------------------------

export async function applyAdjustment(
  ctx: Ctx,
  installmentId: string,
  input: ApplyAdjustmentRequest,
) {
  const tenantId = tenantOf(ctx);
  const actorId = actorOf(ctx);
  const role = roleOf(ctx);

  // SVT-WAVE-BILLING-SEC-P0-F3 (C2) — LATE_FEE with zero or negative amount is
  // semantically nonsense (a "fee" of zero cannot be charged, a negative fee
  // would discount the debt). Reject with 422 (semantically valid shape,
  // business rule violation) so the controller surfaces a UnprocessableEntity
  // rather than the more generic 400. Zero/negative on other kinds is caught
  // by the sign-convention block below.
  if (input.kind === 'LATE_FEE' && input.amount_minor <= 0n) {
    throw UnprocessableEntity(
      'LATE_FEE requires a strictly positive amount_minor (> 0).',
    );
  }

  // SVT-WAVE-BILLING-SEC-P0-F3 — zero is rejected at the schema layer too,
  // but defence-in-depth here covers callers that bypass validation (e.g.
  // internal service consumers).
  if (input.amount_minor === 0n) {
    throw UnprocessableEntity('amount_minor must be non-zero');
  }

  // Sign convention validator — per-kind hard requirement, not just a hint.
  //   LATE_FEE                                  → strictly positive
  //   DISCOUNT/SCHOLARSHIP/WAIVER/WRITE_OFF     → strictly negative
  // SVT-WAVE-BILLING-SEC-P0-F3: previously a zero amount slipped past this
  // check (actualSign === 0 returned without erroring) and a positive LATE_FEE
  // of 0 was accepted. Both are now refused.
  const expectedSign: 1 | -1 =
    input.kind === 'LATE_FEE' ? 1 : -1;
  const actualSign = input.amount_minor > 0n ? 1 : -1;
  if (actualSign !== expectedSign) {
    throw UnprocessableEntity(
      `Adjustment kind ${input.kind} requires ${expectedSign > 0 ? 'positive' : 'negative'} amount_minor`,
    );
  }

  // WAIVER + WRITE_OFF require ADMIN unconditionally (the kinds erase debt).
  if ((input.kind === 'WAIVER' || input.kind === 'WRITE_OFF') && role !== 'ADMIN') {
    throw Forbidden(`${input.kind} requires ADMIN`);
  }

  // SVT-WAVE-BILLING-SEC-P0-F1 — magnitude threshold above which any debt-
  // erasing kind (DISCOUNT / SCHOLARSHIP) is ADMIN-only too. Without this a
  // counsellor could mint unlimited DISCOUNT/SCHOLARSHIP rows to wipe out
  // any installment. WAIVER/WRITE_OFF already guarded above (always admin).
  const threshold = env.BILLING_ADJUSTMENT_ADMIN_THRESHOLD_MINOR;
  const abs = input.amount_minor < 0n ? -input.amount_minor : input.amount_minor;
  if (
    threshold > 0n &&
    abs > threshold &&
    (input.kind === 'DISCOUNT' || input.kind === 'SCHOLARSHIP') &&
    role !== 'ADMIN'
  ) {
    throw Forbidden(
      `${input.kind} above ${threshold} minor units requires ADMIN (got ${abs}).`,
    );
  }

  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    const inst = await tx.$queryRaw<Array<{
      id: string; tenant_id: string; gross_minor: bigint; paid_minor: bigint;
      net_minor: bigint; balance_minor: bigint; status: FeeInstallmentStatus;
    }>>`
      SELECT id, tenant_id, gross_minor, paid_minor, net_minor, balance_minor, status
      FROM fee_installments
      WHERE id = ${installmentId}::uuid
        AND tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
      FOR UPDATE
    `;
    const i = inst[0];
    if (!i) throw NotFound('Installment not found');

    // SVT-WAVE-BILLING-SEC-P0-F1 — debt-erasing kinds may not exceed the
    // installment's current balance. Otherwise a counsellor could mint a
    // DISCOUNT larger than the actual outstanding amount (creating a
    // negative net_minor — phantom credit). WAIVER zeros the balance via
    // the WAIVED status transition further down, so capping its magnitude
    // would be redundant; we still cap it for symmetry so net_minor never
    // goes negative.
    if (
      input.kind === 'DISCOUNT' ||
      input.kind === 'SCHOLARSHIP' ||
      input.kind === 'WAIVER' ||
      input.kind === 'WRITE_OFF'
    ) {
      if (abs > i.balance_minor) {
        throw UnprocessableEntity(
          `Adjustment would exceed installment balance (max=${i.balance_minor}).`,
        );
      }
    }

    // Insert FeeAdjustment row.
    const adj = await tx.feeAdjustment.create({
      data: {
        tenant_id: tenantId,
        fee_installment_id: i.id,
        kind: input.kind,
        amount_minor: input.amount_minor,
        reason_code: input.reason_code ?? null,
        reason_text: input.reason_text,
        applied_on: new Date(input.applied_on),
        created_by_id: actorId,
      },
    });

    // Recompute net + balance by summing ALL existing adjustments against gross.
    const sumRows = await tx.feeAdjustment.aggregate({
      where: { fee_installment_id: i.id, tenant_id: tenantId },
      _sum: { amount_minor: true },
    });
    const adjSum = sumRows._sum.amount_minor ?? 0n;

    const recomputed = recomputeInstallmentAmounts({
      gross_minor: i.gross_minor,
      adjustments_sum_minor: adjSum,
      paid_minor: i.paid_minor,
    });

    // Status implications:
    //   - WAIVER: status → WAIVED (FSM-gated, ADMIN + reason).
    //   - Other negative adjustments closing balance → PAID.
    //   - Otherwise preserve, unless reduction now leaves a 0 balance → PAID.
    let nextStatus: FeeInstallmentStatus = i.status;
    if (input.kind === 'WAIVER') {
      assertOrThrow(feeInstallmentFsm, i.status, 'WAIVED', role, input.reason_text);
      nextStatus = 'WAIVED';
    } else if (recomputed.balance_minor === 0n && i.status !== 'PAID' && i.status !== 'WAIVED' && i.status !== 'CANCELLED' && i.status !== 'REFUNDED') {
      assertOrThrow(feeInstallmentFsm, i.status, 'PAID', role);
      nextStatus = 'PAID';
    }

    await tx.feeInstallment.update({
      where: { id: i.id },
      data: {
        net_minor: recomputed.net_minor,
        balance_minor: recomputed.balance_minor,
        status: nextStatus,
        updated_by_id: actorId,
        version: { increment: 1 },
      },
    });
    return { adj, newStatus: nextStatus, balance: recomputed.balance_minor };
  });

  await writeAudit(ctx as never, {
    action: `installment.${input.kind.toLowerCase()}`,
    entityType: 'fee_installment',
    entityId: installmentId,
    after: {
      adjustment_id: out.adj.id,
      kind: input.kind,
      amount_minor: input.amount_minor.toString(),
      new_status: out.newStatus,
      new_balance_minor: out.balance.toString(),
    },
  });
  return out.adj;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export async function listPayments(ctx: Ctx, q: PaymentListQuery) {
  const tenantId = tenantOf(ctx);
  const where: Prisma.PaymentWhereInput = { tenant_id: tenantId, deleted_at: null };
  if (q.student_id) where.student_id = q.student_id;
  if (q.enrollment_id) where.enrollment_id = q.enrollment_id;
  if (q.status) where.status = q.status as never;
  if (q.from || q.to) {
    where.received_on = {};
    if (q.from) (where.received_on as { gte?: Date }).gte = new Date(q.from);
    if (q.to) (where.received_on as { lte?: Date }).lte = new Date(q.to);
  }
  return db(ctx).payment.findMany({
    where,
    orderBy: [{ received_on: 'desc' }, { created_at: 'desc' }],
    take: q.limit ?? 25,
    include: { allocations: { select: { fee_installment_id: true, amount_minor: true } } },
  });
}

export async function getPayment(ctx: Ctx, paymentId: string) {
  const tenantId = tenantOf(ctx);
  const p = await db(ctx).payment.findFirst({
    where: { id: paymentId, tenant_id: tenantId, deleted_at: null },
    include: {
      allocations: { select: { id: true, fee_installment_id: true, amount_minor: true, created_at: true } },
      refunds: true,
    },
  });
  if (!p) throw NotFound('Payment not found');
  return p;
}

