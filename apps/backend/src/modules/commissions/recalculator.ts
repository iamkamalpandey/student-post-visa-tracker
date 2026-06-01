// Idempotent "upsert a commission claim for this enrollment" helper.
//
// Called from enrollments.service after the enrollment status flips to
// ACCEPTED or ENROLLED. Behaviour:
//   - If the enrollment has no super_agent_id: legacy path — use
//     calculateForEnrollment (Institution.commission_pct).
//   - If the enrollment HAS super_agent_id: try resolveCommissionRate (most-
//     specific SuperAgentCommissionRule wins). If no rule matches, fall back
//     to SuperAgent.default_commission_pct. If THAT is null, fall back to
//     Institution.commission_pct (with an audit warning so admins notice).
//   - If no commission can be determined at all, do nothing.
//   - Persist super_agent_id on the CommissionClaim row.
//
// Audit: every actual write emits a `commission_claim.upserted` event so the
// hash-chain reflects the recalculation. No-ops do NOT audit (would be noise).

import { Prisma } from '@prisma/client';

import { writeAudit } from '../../shared/audit.js';
import { logger } from '../../config/logger.js';
import { resolveCommissionRate } from '../super-agents/commission-resolver.js';

import { calculateForEnrollment, type Db } from './calculator.js';

/**
 * Minimum surface we need from the call-site request. Compatible with both an
 * Express `Request` and the lighter `{ db, user, ... }` shapes used by the
 * service-layer ctx objects in other modules.
 */
export type RecalcReq = {
  db?: Db;
  user?: { tid: string; sub?: string };
  ip?: string | null;
  requestId?: string;
  header?: (name: string) => string | undefined;
};

function dbFor(req: RecalcReq): Db {
  // INTENTIONAL singleton fallback: this helper is invoked from BOTH the
  // HTTP enrollments path (where req.db is the RLS-scoped client) AND the
  // background recalculation jobs / scripts that have no Express request and
  // therefore no req.db. Tenant_id filtering remains on every query.
  return (req.db as Db | undefined) ?? unscopedFallback();
}

let _prisma: Db | null = null;
function unscopedFallback(): Db {
  if (_prisma) return _prisma;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../config/db.js') as { prisma: Db };
  _prisma = mod.prisma;
  return _prisma;
}

type ResolvedCalc = {
  amount_minor: bigint;
  currency: string;
  commission_pct: Prisma.Decimal;
  basis_minor: bigint;
  /** Source of the rate, for audit/observability. */
  rate_source: 'sa_rule' | 'sa_default' | 'institution';
  /** SuperAgentCommissionRule.id when rate_source=sa_rule, else null. */
  rule_id: string | null;
};

/** Floor(basis_minor * pct/100) using BigInt math (no floating-point drift). */
function applyPct(basis: bigint, pctDecimal: Prisma.Decimal): bigint {
  const fixed = pctDecimal.toFixed(2);
  const [whole, frac = '00'] = fixed.split('.');
  const pctScaled = BigInt((whole ?? '0') + frac.padEnd(2, '0').slice(0, 2));
  return (basis * pctScaled) / 10000n;
}

/**
 * Compute the commission for an enrollment, super-agent-aware.
 * Returns null when no rate can be determined.
 */
async function resolvedCalcForEnrollment(
  db: Db,
  tenantId: string,
  enrollmentId: string,
): Promise<ResolvedCalc | null> {
  const enrollment = await db.enrollment.findFirst({
    where: { id: enrollmentId, tenant_id: tenantId, deleted_at: null },
    select: {
      id: true,
      tuition_total_minor: true,
      tuition_currency: true,
      super_agent_id: true,
      institution_id: true,
      institution: { select: { id: true, commission_pct: true } },
      program: { select: { level: true } },
    },
  });
  if (!enrollment) return null;
  const basis = enrollment.tuition_total_minor;
  const tuitionCurrency = enrollment.tuition_currency;
  if (basis == null) return null;
  if (!tuitionCurrency) return null;

  // Direct (no super-agent) — legacy path, unchanged.
  if (!enrollment.super_agent_id) {
    const pct = enrollment.institution?.commission_pct;
    if (pct == null) return null;
    return {
      amount_minor: applyPct(basis, pct),
      currency: tuitionCurrency,
      commission_pct: pct,
      basis_minor: basis,
      rate_source: 'institution',
      rule_id: null,
    };
  }

  // Super-agent path: try resolver → super-agent default → institution default.
  const resolved = await resolveCommissionRate(db, tenantId, {
    superAgentId: enrollment.super_agent_id,
    institutionId: enrollment.institution_id,
    programLevel: enrollment.program?.level ?? null,
    asOf: new Date(),
  });

  if (resolved) {
    const pct = new Prisma.Decimal(resolved.commissionPct.toFixed(2));
    return {
      amount_minor: applyPct(basis, pct),
      currency: resolved.currency,
      commission_pct: pct,
      basis_minor: basis,
      rate_source: 'sa_rule',
      rule_id: resolved.ruleId,
    };
  }

  // No matching rule — fall back to SuperAgent.default_commission_pct.
  const sa = await db.superAgent.findFirst({
    where: { id: enrollment.super_agent_id, tenant_id: tenantId, deleted_at: null },
    select: { default_commission_pct: true, default_currency: true },
  });
  if (sa?.default_commission_pct != null) {
    return {
      amount_minor: applyPct(basis, sa.default_commission_pct),
      currency: sa.default_currency ?? tuitionCurrency,
      commission_pct: sa.default_commission_pct,
      basis_minor: basis,
      rate_source: 'sa_default',
      rule_id: null,
    };
  }

  // Final fallback: institution default. Log a warning because this is the
  // "shouldn't happen" path — admins haven't configured the super-agent.
  const pct = enrollment.institution?.commission_pct;
  if (pct == null) {
    logger.warn(
      { enrollmentId, super_agent_id: enrollment.super_agent_id },
      'commission resolver: no rule, no SA default, no institution default — claim skipped',
    );
    return null;
  }
  logger.warn(
    { enrollmentId, super_agent_id: enrollment.super_agent_id },
    'commission resolver: no SA rule and no SA default — falling back to institution rate',
  );
  return {
    amount_minor: applyPct(basis, pct),
    currency: tuitionCurrency,
    commission_pct: pct,
    basis_minor: basis,
    rate_source: 'institution',
    rule_id: null,
  };
}

/**
 * Recompute and persist the commission claim for an enrollment.
 *
 * Safe to call repeatedly. Never throws — all failures are logged so a
 * recalculation hiccup cannot roll back the underlying enrollment write.
 */
export async function upsertClaimForEnrollment(req: RecalcReq, enrollmentId: string): Promise<void> {
  try {
    const db = dbFor(req);
    const tenantId = req.user?.tid;
    const actorId = req.user?.sub ?? null;
    if (!tenantId) {
      logger.warn({ enrollmentId }, 'commission upsert: no tenant on request, skipping');
      return;
    }

    const enrollment = await db.enrollment.findFirst({
      where: { id: enrollmentId, tenant_id: tenantId, deleted_at: null },
      select: { id: true, institution_id: true, student_id: true, super_agent_id: true },
    });
    if (!enrollment) return;

    const calc = await resolvedCalcForEnrollment(db, tenantId, enrollmentId);
    // Backwards compat: if the enrollment is direct AND the super-agent-aware
    // resolver returned null, double-check via the legacy calculator (which
    // may handle edge cases the new resolver doesn't).
    const fallback = calc ?? (await calculateForEnrollment(db, enrollmentId).then((c) =>
      c
        ? {
            amount_minor: c.amount_minor,
            currency: c.currency,
            commission_pct: c.commission_pct,
            basis_minor: c.basis_minor,
            rate_source: 'institution' as const,
            rule_id: null as string | null,
          }
        : null,
    ));
    if (!fallback) return; // nothing to claim yet

    const existing = await db.commissionClaim.findFirst({
      where: { enrollment_id: enrollmentId, tenant_id: tenantId, deleted_at: null },
      select: {
        id: true,
        status: true,
        amount_minor: true,
        currency: true,
        commission_pct: true,
        basis_minor: true,
        super_agent_id: true,
        version: true,
      },
    });

    // Immutable downstream states — never overwrite.
    if (existing && (
      existing.status === 'INVOICED' ||
      existing.status === 'PAID' ||
      existing.status === 'DISPUTED' ||
      existing.status === 'WAIVED'
    )) {
      return;
    }

    if (!existing) {
      // INSERT a fresh PENDING claim.
      if (!actorId) {
        logger.warn(
          { enrollmentId },
          'commission upsert: no actor on request, cannot create new claim (created_by_id required)',
        );
        return;
      }
      const created = await db.commissionClaim.create({
        data: {
          tenant_id: tenantId,
          enrollment_id: enrollmentId,
          institution_id: enrollment.institution_id,
          student_id: enrollment.student_id,
          super_agent_id: enrollment.super_agent_id,
          amount_minor: fallback.amount_minor,
          currency: fallback.currency,
          commission_pct: fallback.commission_pct,
          basis_minor: fallback.basis_minor,
          status: 'PENDING',
          created_by_id: actorId,
          updated_by_id: actorId,
        } as Prisma.CommissionClaimUncheckedCreateInput,
      });
      await writeAudit(req as never, {
        action: 'commission_claim.upserted',
        entityType: 'commission_claim',
        entityId: created.id,
        entityVersion: created.version,
        after: {
          status: created.status,
          amount_minor: created.amount_minor.toString(),
          currency: created.currency,
          commission_pct: created.commission_pct.toString(),
          basis_minor: created.basis_minor.toString(),
          super_agent_id: created.super_agent_id,
          rate_source: fallback.rate_source,
          rule_id: fallback.rule_id,
        },
      });
      return;
    }

    // existing is PENDING or CLAIMED — recompute monetary fields only.
    const sameAmount = existing.amount_minor === fallback.amount_minor;
    const sameCurrency = existing.currency === fallback.currency;
    const samePct = existing.commission_pct.toString() === fallback.commission_pct.toString();
    const sameBasis = existing.basis_minor === fallback.basis_minor;
    const sameSa = existing.super_agent_id === enrollment.super_agent_id;
    if (sameAmount && sameCurrency && samePct && sameBasis && sameSa) return;

    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    // SVT-SEC-2026-05: version-guarded update — two concurrent enrollment
    // updates could each load the same `existing` row, then both UPDATE,
    // last-write-wins on amount_minor. Adding `version: existing.version`
    // turns the second writer's count into 0; loop bounded so we don't
    // spin under contention.
    const MAX_ATTEMPTS = 3;
    let wr: { count: number } = { count: 0 };
    let current = existing;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      wr = await db.commissionClaim.updateMany({
        where: {
          id: current.id,
          tenant_id: tenantId,
          deleted_at: null,
          version: current.version,
        },
        data: {
          amount_minor: fallback.amount_minor,
          currency: fallback.currency,
          commission_pct: fallback.commission_pct,
          basis_minor: fallback.basis_minor,
          super_agent_id: enrollment.super_agent_id,
          updated_by_id: actorId ?? null,
          version: { increment: 1 },
        },
      });
      if (wr.count === 1) break;
      // Re-read to disambiguate: someone else won the race. Re-check the
      // immutable-status guard + same-value short-circuit before retrying.
      const fresh = await db.commissionClaim.findFirst({
        where: { id: existing.id, tenant_id: tenantId, deleted_at: null },
        select: {
          id: true, status: true, amount_minor: true, currency: true,
          commission_pct: true, basis_minor: true, super_agent_id: true, version: true,
        },
      });
      if (!fresh) return; // claim was deleted underneath us — give up cleanly
      if (
        fresh.status === 'INVOICED' || fresh.status === 'PAID' ||
        fresh.status === 'DISPUTED' || fresh.status === 'WAIVED'
      ) {
        return; // moved to immutable downstream — abandon recompute
      }
      const a = fresh.amount_minor === fallback.amount_minor;
      const c = fresh.currency === fallback.currency;
      const p = fresh.commission_pct.toString() === fallback.commission_pct.toString();
      const b = fresh.basis_minor === fallback.basis_minor;
      const sa = fresh.super_agent_id === enrollment.super_agent_id;
      if (a && c && p && b && sa) return; // already matches — nothing to do
      current = fresh;
    }
    if (wr.count !== 1) {
      logger.warn(
        { enrollmentId, attempts: MAX_ATTEMPTS },
        'commission upsert: lost version race after retries — leaving claim untouched',
      );
      return;
    }
    const updated = await db.commissionClaim.findFirstOrThrow({
      where: { id: existing.id, tenant_id: tenantId },
    });
    await writeAudit(req as never, {
      action: 'commission_claim.upserted',
      entityType: 'commission_claim',
      entityId: updated.id,
      entityVersion: updated.version,
      before: {
        amount_minor: existing.amount_minor.toString(),
        currency: existing.currency,
        commission_pct: existing.commission_pct.toString(),
        basis_minor: existing.basis_minor.toString(),
        super_agent_id: existing.super_agent_id,
      },
      after: {
        amount_minor: updated.amount_minor.toString(),
        currency: updated.currency,
        commission_pct: updated.commission_pct.toString(),
        basis_minor: updated.basis_minor.toString(),
        super_agent_id: updated.super_agent_id,
        rate_source: fallback.rate_source,
        rule_id: fallback.rule_id,
      },
    });
  } catch (err) {
    // NEVER throw to caller — a failed recalc must not roll back the enrollment.
    logger.error({ err, enrollmentId }, 'commission claim upsert failed');
  }
}
