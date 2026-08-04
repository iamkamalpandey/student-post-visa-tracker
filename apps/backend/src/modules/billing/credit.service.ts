// SVT-FIN-2026-08 — student credit ledger.
//
// WHAT A CREDIT IS
// ----------------
// Money the business is holding that belongs to the student. Two events mint
// one today:
//   * receivePayment  — cash received exceeded what it was allocated against
//                       (source='overpayment')
//   * completeRefund  — a refund exceeded the allocations it unwound and the
//                       operator chose to absorb the surplus as credit
//                       (source='refund_carryforward')
//
// WHY THIS FILE EXISTS
// --------------------
// Both of those paths shipped. Nothing on the other side did. `student_credits`
// rows were written and then became unreachable: no reader, no draw-down, no
// reversal, and `consumed_minor` was never incremented by any code path despite
// the schema promising it would be. The practical effect is that a student who
// overpaid had their money captured correctly in the database and then made
// invisible — staff could not see the liability on any screen or report, so it
// could never be refunded or applied. For a finance system that is not a
// missing feature, it is an unrecorded debt.
//
// INVARIANTS THIS FILE MAINTAINS
// ------------------------------
//   1. available == amount_minor - consumed_minor, never negative
//      (enforced again by CHECK consumed_minor <= amount_minor).
//   2. sum(applications.amount_minor) == credit.consumed_minor.
//   3. A credit is only ever applied to an installment of the SAME currency.
//      Netting across currencies is never permitted, not even "temporarily".
//   4. installment.paid_minor == sum(payment_allocations)
//                              + sum(student_credit_applications)
//   5. A reversed or expired credit has zero spending power.
//
// CONCURRENCY
// -----------
// Every mutation takes `SELECT … FOR UPDATE` on the credit row FIRST, then on
// the installments in a deterministic order. Two operators spending the same
// credit at the same time serialise behind the credit lock, so the second sees
// the first's consumed_minor and cannot overdraw it.

import type { Prisma, PrismaClient, FeeInstallmentStatus } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { writeAudit } from '../../shared/audit.js';
import { BadRequest, NotFound, Conflict, UnprocessableEntity } from '../../shared/errors.js';
import type {
  StudentCreditListQuery,
  ApplyCreditRequest,
  ReverseCreditRequest,
} from '@spv/zod-schemas';
import { recomputeInstallmentAmounts } from './pricing.js';
import { assertSettlement } from './fsm-def.js';

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

/** Installment statuses a credit may be applied to. Terminal rows excluded. */
const SETTLEABLE_STATUSES = ['SCHEDULED', 'INVOICED', 'DUE', 'OVERDUE', 'PARTIAL'] as const;

type CreditRow = {
  id: string;
  student_id: string;
  enrollment_id: string | null;
  amount_minor: bigint;
  consumed_minor: bigint;
  currency: string;
  source: string;
  source_ref_id: string | null;
  expires_on: Date | null;
  notes: string | null;
  reversed_at: Date | null;
  reversed_reason: string | null;
  created_at: Date;
};

const availableOf = (c: { amount_minor: bigint; consumed_minor: bigint; reversed_at: Date | null }): bigint =>
  c.reversed_at ? 0n : c.amount_minor - c.consumed_minor;

// ---------------------------------------------------------------------------
// listCredits — the reader that did not exist.
// ---------------------------------------------------------------------------

export async function listCredits(ctx: Ctx, q: StudentCreditListQuery) {
  const tenantId = tenantOf(ctx);
  const where: Prisma.StudentCreditWhereInput = { tenant_id: tenantId };
  if (q.student_id) where.student_id = q.student_id;
  if (q.enrollment_id) where.enrollment_id = q.enrollment_id;
  if (!q.include_closed) {
    // Open liability only: not reversed, and not fully drawn down.
    where.reversed_at = null;
  }

  const rows = (await db(ctx).studentCredit.findMany({
    where,
    orderBy: [{ created_at: 'desc' }],
    take: q.limit ?? 50,
  })) as unknown as CreditRow[];

  const visible = q.include_closed
    ? rows
    : rows.filter((r) => availableOf(r) > 0n);

  // Group by ISO currency. Deliberately an array: a single scalar total across
  // mixed currencies is not money in any currency, and this repo has already
  // shipped that exact bug once in the outstanding aggregate.
  const byCurrency = new Map<string, { available_minor: bigint; credit_count: number }>();
  for (const r of visible) {
    const avail = availableOf(r);
    if (avail <= 0n) continue;
    const slot = byCurrency.get(r.currency) ?? { available_minor: 0n, credit_count: 0 };
    slot.available_minor += avail;
    slot.credit_count += 1;
    byCurrency.set(r.currency, slot);
  }

  return {
    credits: visible.map((r) => ({
      id: r.id,
      student_id: r.student_id,
      enrollment_id: r.enrollment_id,
      amount_minor: r.amount_minor,
      consumed_minor: r.consumed_minor,
      available_minor: availableOf(r),
      currency: r.currency,
      source: r.source,
      source_ref_id: r.source_ref_id,
      expires_on: r.expires_on ? r.expires_on.toISOString().slice(0, 10) : null,
      notes: r.notes,
      reversed_at: r.reversed_at ? r.reversed_at.toISOString() : null,
      reversed_reason: r.reversed_reason,
      created_at: r.created_at.toISOString(),
    })),
    summary: {
      by_currency: [...byCurrency.entries()]
        .map(([currency, v]) => ({ currency, ...v }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    },
  };
}

export async function getCredit(ctx: Ctx, creditId: string) {
  const tenantId = tenantOf(ctx);
  const row = (await db(ctx).studentCredit.findFirst({
    where: { id: creditId, tenant_id: tenantId },
    include: {
      applications: {
        select: {
          id: true,
          fee_installment_id: true,
          amount_minor: true,
          created_at: true,
        },
        orderBy: { created_at: 'asc' },
      },
    },
  })) as unknown as (CreditRow & { applications: unknown[] }) | null;
  if (!row) throw NotFound('Credit not found');
  return { ...row, available_minor: availableOf(row) };
}

// ---------------------------------------------------------------------------
// applyCredit — draw a credit down against outstanding installments.
// ---------------------------------------------------------------------------

export async function applyCredit(ctx: Ctx, creditId: string, input: ApplyCreditRequest) {
  const tenantId = tenantOf(ctx);
  const actorId = actorOf(ctx);
  const role = roleOf(ctx);

  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    // Lock the credit FIRST. Everything downstream is bounded by its remaining
    // balance, so two concurrent applications must serialise here or they will
    // both read the same `available` and together overdraw it.
    const creditRows = await tx.$queryRaw<Array<{
      id: string; student_id: string; enrollment_id: string | null;
      amount_minor: bigint; consumed_minor: bigint; currency: string;
      expires_on: Date | null; reversed_at: Date | null;
    }>>`
      SELECT id, student_id, enrollment_id, amount_minor, consumed_minor,
             currency, expires_on, reversed_at
      FROM student_credits
      WHERE id = ${creditId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    const credit = creditRows[0];
    if (!credit) throw NotFound('Credit not found');
    if (credit.reversed_at) throw Conflict('Credit has been reversed and cannot be applied');

    const available = credit.amount_minor - credit.consumed_minor;
    if (available <= 0n) throw Conflict('Credit is fully consumed');

    if (credit.expires_on) {
      // Compare calendar days in UTC. A credit is spendable through the whole
      // of its expiry date, not up to midnight of the day before.
      const today = new Date().toISOString().slice(0, 10);
      const expiry = credit.expires_on.toISOString().slice(0, 10);
      if (expiry < today) {
        throw Conflict(`Credit expired on ${expiry}`);
      }
    }

    // Resolve + lock target installments. Ordered by due date so the lock
    // order is deterministic (deadlock avoidance) and FIFO is the default.
    let targets: Array<{
      id: string; balance_minor: bigint; net_minor: bigint; paid_minor: bigint;
      currency: string; status: FeeInstallmentStatus;
    }>;

    if (input.applications && input.applications.length > 0) {
      const ids = input.applications.map((a) => a.fee_installment_id);
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) {
          throw BadRequest(`Duplicate application for installment ${id}; combine them into one line`);
        }
        seen.add(id);
      }
      targets = await tx.$queryRaw`
        SELECT i.id, i.balance_minor, i.net_minor, i.paid_minor, i.currency, i.status
        FROM fee_installments i
        JOIN fee_plans p ON p.id = i.fee_plan_id
        JOIN enrollments e ON e.id = p.enrollment_id
        WHERE i.id = ANY(${ids}::uuid[])
          AND i.tenant_id = ${tenantId}::uuid
          AND i.deleted_at IS NULL
          AND e.student_id = ${credit.student_id}::uuid
          AND i.status IN ('SCHEDULED','INVOICED','DUE','OVERDUE','PARTIAL')
        ORDER BY i.due_on ASC, i.sequence_no ASC
        FOR UPDATE OF i
      `;
      if (targets.length !== ids.length) {
        throw BadRequest(
          'One or more installments not found, not owned by this student, or already in a terminal status',
        );
      }
    } else {
      // FIFO across the student's open installments. Scoped to the credit's
      // enrollment when it has one, so an enrollment-specific credit cannot
      // wander onto an unrelated programme's fees.
      targets = credit.enrollment_id
        ? await tx.$queryRaw`
            SELECT i.id, i.balance_minor, i.net_minor, i.paid_minor, i.currency, i.status
            FROM fee_installments i
            JOIN fee_plans p ON p.id = i.fee_plan_id
            WHERE i.tenant_id = ${tenantId}::uuid
              AND p.enrollment_id = ${credit.enrollment_id}::uuid
              AND i.deleted_at IS NULL
              AND i.currency = ${credit.currency}
              AND i.balance_minor > 0
              AND i.status IN ('SCHEDULED','INVOICED','DUE','OVERDUE','PARTIAL')
            ORDER BY i.due_on ASC, i.sequence_no ASC
            FOR UPDATE OF i
          `
        : await tx.$queryRaw`
            SELECT i.id, i.balance_minor, i.net_minor, i.paid_minor, i.currency, i.status
            FROM fee_installments i
            JOIN fee_plans p ON p.id = i.fee_plan_id
            JOIN enrollments e ON e.id = p.enrollment_id
            WHERE i.tenant_id = ${tenantId}::uuid
              AND e.student_id = ${credit.student_id}::uuid
              AND i.deleted_at IS NULL
              AND i.currency = ${credit.currency}
              AND i.balance_minor > 0
              AND i.status IN ('SCHEDULED','INVOICED','DUE','OVERDUE','PARTIAL')
            ORDER BY i.due_on ASC, i.sequence_no ASC
            FOR UPDATE OF i
          `;
      if (targets.length === 0) {
        throw UnprocessableEntity(
          `No open ${credit.currency} installments to apply this credit to`,
        );
      }
    }

    // Currency invariant — checked for BOTH modes. The FIFO query filters on
    // currency, but the explicit mode takes ids straight from the caller.
    for (const t of targets) {
      if (t.currency !== credit.currency) {
        throw UnprocessableEntity(
          `Currency mismatch: credit ${credit.currency} vs installment ${t.currency}. Credits are never converted.`,
        );
      }
    }

    // Decide the amounts.
    const planned: Array<{ target: (typeof targets)[number]; amount: bigint }> = [];
    let spent = 0n;

    if (input.applications && input.applications.length > 0) {
      const byId = new Map(targets.map((t) => [t.id, t]));
      for (const a of input.applications) {
        const target = byId.get(a.fee_installment_id)!;
        if (a.amount_minor > target.balance_minor) {
          throw UnprocessableEntity(
            `Application of ${a.amount_minor} exceeds installment balance ${target.balance_minor}`,
          );
        }
        spent += a.amount_minor;
        planned.push({ target, amount: a.amount_minor });
      }
      // Conservation: a credit cannot pay out more than it holds.
      if (spent > available) {
        throw UnprocessableEntity(
          `Applications total ${spent} but only ${available} remains on this credit`,
        );
      }
    } else {
      let budget = available;
      if (input.max_amount_minor && input.max_amount_minor < budget) {
        budget = input.max_amount_minor;
      }
      for (const target of targets) {
        if (budget <= 0n) break;
        if (target.balance_minor <= 0n) continue;
        const amount = budget < target.balance_minor ? budget : target.balance_minor;
        planned.push({ target, amount });
        budget -= amount;
        spent += amount;
      }
      if (spent <= 0n) {
        throw UnprocessableEntity('Nothing to apply: every candidate installment is already settled');
      }
    }

    // Write the ledger lines + settle the installments.
    const applications: Array<{ fee_installment_id: string; amount_minor: bigint }> = [];
    for (const { target, amount } of planned) {
      const newPaid = target.paid_minor + amount;
      const recomputed = recomputeInstallmentAmounts({
        gross_minor: target.net_minor, // already net; adjustments are folded in
        adjustments_sum_minor: 0n,
        paid_minor: newPaid,
      });
      if (recomputed.overpaid_minor !== 0n) {
        // Unreachable given the per-installment cap above. Asserted rather
        // than trusted so a future edit cannot silently clamp money away.
        throw Conflict(
          `Credit application would overpay installment ${target.id} by ${recomputed.overpaid_minor}`,
        );
      }
      const nextStatus = assertSettlement(
        target.status,
        recomputed.balance_minor === 0n ? 'PAID' : 'PARTIAL',
        role,
      );

      await tx.studentCreditApplication.create({
        data: {
          tenant_id: tenantId,
          student_credit_id: credit.id,
          fee_installment_id: target.id,
          amount_minor: amount,
          created_by_id: actorId,
        },
      });
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
      applications.push({ fee_installment_id: target.id, amount_minor: amount });
    }

    // Draw down the credit. Guarded on the consumed_minor we read under the
    // lock: if anything changed it underneath us the update matches 0 rows and
    // the whole transaction rolls back rather than overdrawing.
    const drawn = await tx.studentCredit.updateMany({
      where: { id: credit.id, tenant_id: tenantId, consumed_minor: credit.consumed_minor },
      data: { consumed_minor: credit.consumed_minor + spent },
    });
    if (drawn.count !== 1) {
      throw Conflict('Credit was modified concurrently');
    }

    return { creditId: credit.id, spent, applications, remaining: available - spent };
  });

  await writeAudit(ctx as never, {
    action: 'credit.applied',
    entityType: 'student_credit',
    entityId: out.creditId,
    after: {
      applied_minor: out.spent.toString(),
      remaining_minor: out.remaining.toString(),
      installment_count: out.applications.length,
      reason: input.reason_text,
    },
  });

  return out;
}

// ---------------------------------------------------------------------------
// reverseCredit — retire a credit that should never have existed.
// ---------------------------------------------------------------------------

export async function reverseCredit(ctx: Ctx, creditId: string, input: ReverseCreditRequest) {
  const tenantId = tenantOf(ctx);
  const actorId = actorOf(ctx);
  const role = roleOf(ctx);
  if (role !== 'ADMIN') throw Conflict('Only ADMIN can reverse a credit');

  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const rows = await tx.$queryRaw<Array<{
      id: string; amount_minor: bigint; consumed_minor: bigint; reversed_at: Date | null;
    }>>`
      SELECT id, amount_minor, consumed_minor, reversed_at
      FROM student_credits
      WHERE id = ${creditId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    const credit = rows[0];
    if (!credit) throw NotFound('Credit not found');
    if (credit.reversed_at) throw Conflict('Credit is already reversed');
    if (credit.consumed_minor > 0n) {
      // Reversing spent credit would leave installments settled by money that
      // no longer exists. The operator must unwind the applications first.
      throw Conflict(
        `Cannot reverse a credit with ${credit.consumed_minor} already applied. Reverse the settled installments first.`,
      );
    }

    const flip = await tx.studentCredit.updateMany({
      where: { id: creditId, tenant_id: tenantId, reversed_at: null },
      data: {
        reversed_at: new Date(),
        reversed_reason: input.reason_text,
        reversed_by_id: actorId,
      },
    });
    if (flip.count !== 1) throw Conflict('Credit was modified concurrently');
    return credit;
  });

  await writeAudit(ctx as never, {
    action: 'credit.reversed',
    entityType: 'student_credit',
    entityId: creditId,
    before: { amount_minor: out.amount_minor.toString(), reversed_at: null },
    after: { reversed_reason: input.reason_text },
  });
  return { id: creditId, reversed: true };
}

// ---------------------------------------------------------------------------
// reverseCreditsForSource — used by voidPayment.
//
// Voiding a payment means "this never happened". Any credit that payment
// minted must go with it, or the student keeps spending power the void was
// supposed to remove. Runs INSIDE the caller's transaction so the reversal and
// the void commit or fail together.
//
// Refuses (throws) when the credit has already been partly spent: at that
// point the void is not a clean undo and needs an operator decision, which is
// strictly better than either silently leaving the credit alive or silently
// clawing back money already applied to a settled installment.
// ---------------------------------------------------------------------------

export async function reverseCreditsForSource(
  tx: Prisma.TransactionClient,
  opts: { tenantId: string; sourceRefId: string; actorId: string | null; reason: string },
): Promise<Array<{ id: string; amount_minor: bigint }>> {
  const rows = await tx.$queryRaw<Array<{ id: string; amount_minor: bigint; consumed_minor: bigint }>>`
    SELECT id, amount_minor, consumed_minor
    FROM student_credits
    WHERE tenant_id = ${opts.tenantId}::uuid
      AND source_ref_id = ${opts.sourceRefId}::uuid
      AND reversed_at IS NULL
    FOR UPDATE
  `;
  if (rows.length === 0) return [];

  for (const r of rows) {
    if (r.consumed_minor > 0n) {
      throw Conflict(
        `This payment created a student credit of which ${r.consumed_minor} has already been applied to other installments. Reverse those applications before voiding.`,
      );
    }
  }

  await tx.studentCredit.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, tenant_id: opts.tenantId, reversed_at: null },
    data: {
      reversed_at: new Date(),
      reversed_reason: opts.reason,
      reversed_by_id: opts.actorId,
    },
  });

  return rows.map((r) => ({ id: r.id, amount_minor: r.amount_minor }));
}

export const __CREDIT_INTERNALS__ = { availableOf, SETTLEABLE_STATUSES };
