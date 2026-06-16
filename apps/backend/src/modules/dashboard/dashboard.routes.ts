import { Router } from 'express';
import { findUpcomingExpiries } from '../../jobs/expiryAlerts.js';
import { Unauthorized, Forbidden } from '../../shared/errors.js';

export const dashboardRouter: Router = Router();

// SVT-WAVE60-ONBOARDING-2026-05 — first-run checklist per tenant.
// Short per-tenant cache (60s) so a freshly-onboarded admin clicking around
// the dashboard doesn't repeatedly hit 8 queries; the steps move slowly
// enough that 60s of staleness is fine. Cleared by export for tests.
const ONBOARDING_CACHE_TTL_MS = 60_000;
type OnboardingStep = {
  id: string;
  label: string;
  complete: boolean;
  action_url: string;
};
type OnboardingPayload = { steps: OnboardingStep[]; complete_count: number };
const onboardingCache = new Map<string, { payload: OnboardingPayload; cachedAt: number }>();

export function _clearOnboardingCache(): void {
  onboardingCache.clear();
}

dashboardRouter.get('/summary', async (req, res, next) => {
  try {
    const tenantId = req.user?.tid;
    if (!tenantId) throw Unauthorized();
    // req.db is the RLS-scoped client. We MUST NOT fall back to the singleton
    // because the per-request app.tenant_id GUC would be missing and RLS would
    // either deny or — worse — let some non-tenant-aware queries through.
    const db = req.db;
    if (!db) throw new Error('tenantContext middleware not applied');

    // v6: pre-fetch the IDs of stages flagged `show_on_dashboard=false` so we
    // can exclude them from the by-stage breakdown. Default for stages is true,
    // so the existing 15 seeded stages remain visible without backfill.
    // Two-step approach (cheap): list hidden stage_ids, then filter the groupBy.
    // Doing this server-side keeps the FE widget filter-free.
    const hiddenStages = await db.lifecycleStage.findMany({
      where: { tenant_id: tenantId, show_on_dashboard: false },
      select: { id: true },
    });
    const hiddenStageIds = hiddenStages.map((s) => s.id);

    const userId = req.user?.sub;
    const role = req.user?.role;
    // SVT-SEC-2026-05 — role-scope: a COUNSELLOR sees their own caseload
    // counts only. ADMIN sees tenant-wide. Previously a counsellor saw the
    // entire tenant's by-stage / by-status counts which leaks workload info.
    const studentScope =
      role === 'ADMIN'
        ? {}
        : { assigned_to_id: userId ?? '__no_user__' };
    const [stageCounts, statusCounts, recentEvents, expiries, unreadMessages] = await Promise.all([
      db.student.groupBy({
        by: ['current_stage_id'],
        where: {
          tenant_id: tenantId,
          deleted_at: null,
          ...studentScope,
          ...(hiddenStageIds.length
            ? { current_stage_id: { notIn: hiddenStageIds } }
            : {}),
        },
        _count: { _all: true },
      }),
      db.student.groupBy({
        by: ['status'],
        where: { tenant_id: tenantId, deleted_at: null, ...studentScope },
        _count: { _all: true },
      }),
      db.studentLifecycleEvent.findMany({
        where: {
          tenant_id: tenantId,
          ...(role !== 'ADMIN' && userId
            ? { student: { is: { assigned_to_id: userId } } }
            : {}),
        },
        orderBy: { occurred_at: 'desc' },
        take: 10,
        select: {
          id: true,
          student_id: true,
          to_stage_id: true,
          occurred_at: true,
          notes: true,
          actor_id: true,
        },
      }),
      findUpcomingExpiries({ tenantId, withinDays: 60, db }),
      // SVT-WAVE20-DASHBOARD-2026-05 — current user's unread IN_APP messages.
      // Tenant-scoped; recipient_user_id pinned to caller. Cheap count.
      userId
        ? db.commsMessage.count({
            where: {
              tenant_id: tenantId,
              recipient_user_id: userId,
              direction: 'OUTBOUND',
              read_at: null,
            },
          })
        : Promise.resolve(0),
    ]);

    res.json({
      data: {
        by_stage: stageCounts.map((g) => ({ stage_id: g.current_stage_id, count: g._count._all })),
        by_status: statusCounts.map((g) => ({ status: g.status, count: g._count._all })),
        recent_events: recentEvents,
        upcoming_expiries: expiries.slice(0, 25),
        upcoming_expiries_total: expiries.length,
        unread_messages_count: unreadMessages,
      },
    });
  } catch (err) {
    next(err);
  }
});

// SVT-WAVE-BILLING-DASHBOARD-2026-05 — finance KPIs.
// Role-scoped: ADMIN sees tenant-wide, COUNSELLOR sees own caseload only.
// Defence-in-depth: every query carries an explicit tenant_id filter on top
// of the RLS-scoped req.db so a misconfigured GUC can never widen results.
dashboardRouter.get('/finance-summary', async (req, res, next) => {
  try {
    const tenantId = req.user?.tid;
    if (!tenantId) throw Unauthorized();
    const db = req.db;
    if (!db) throw new Error('tenantContext middleware not applied');
    const userId = req.user?.sub;
    const role = req.user?.role;
    const scopeOwnCaseload = role !== 'ADMIN';

    // Outstanding = SUM(balance_minor) over OPEN installments.
    // Overdue count = number of installments in OVERDUE.
    // 30d collections = SUM(payment.gross_minor) where status=RECEIVED + received_on > now-30d.
    // 30d refund_rate = COMPLETED refunds / RECEIVED payments (4dp).
    // Active plans = count where status=ACTIVE.
    const installWhere: Record<string, unknown> = {
      tenant_id: tenantId,
      deleted_at: null,
      status: { in: ['INVOICED', 'DUE', 'OVERDUE', 'PARTIAL'] },
    };
    if (scopeOwnCaseload) {
      installWhere['fee_plan'] = {
        is: { enrollment: { is: { student: { is: { assigned_to_id: userId ?? '__no_user__' } } } } },
      };
    }
    const overdueWhere = { ...installWhere, status: 'OVERDUE' };
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const paymentWhere: Record<string, unknown> = {
      tenant_id: tenantId, deleted_at: null,
      status: 'RECEIVED', received_on: { gte: since30 },
    };
    if (scopeOwnCaseload) {
      paymentWhere['student'] = { is: { assigned_to_id: userId ?? '__no_user__' } };
    }
    const refundWhere: Record<string, unknown> = {
      tenant_id: tenantId, status: 'COMPLETED',
      refunded_on: { gte: since30 },
    };
    if (scopeOwnCaseload) {
      refundWhere['payment'] = {
        is: { student: { is: { assigned_to_id: userId ?? '__no_user__' } } },
      };
    }
    const planWhere: Record<string, unknown> = {
      tenant_id: tenantId, status: 'ACTIVE', deleted_at: null,
    };
    if (scopeOwnCaseload) {
      planWhere['enrollment'] = {
        is: { student: { is: { assigned_to_id: userId ?? '__no_user__' } } },
      };
    }

    const [outRows, overdueCount, payRows, refundRows, plansCount] = await Promise.all([
      db.feeInstallment.groupBy({ by: ['currency'], where: installWhere as never, _sum: { balance_minor: true } }),
      db.feeInstallment.count({ where: overdueWhere as never }),
      db.payment.groupBy({ by: ['currency'], where: paymentWhere as never, _sum: { gross_minor: true } }),
      // Refund has no own currency column — it inherits its payment's currency.
      db.refund.findMany({ where: refundWhere as never, select: { amount_minor: true, payment: { select: { currency: true } } } }),
      db.feePlan.count({ where: planWhere as never }),
    ]);

    // SVT-FIN-2026-06: NEVER net across currencies. Aggregate money per ISO
    // currency; counts (overdue, active plans) are currency-agnostic and stay
    // global. Returns a per-currency array the client renders one tile-set each.
    type Acc = { currency: string; outstanding: bigint; collections: bigint; refunds: bigint };
    const byCur = new Map<string, Acc>();
    const ensure = (c: string): Acc => {
      let r = byCur.get(c);
      if (!r) { r = { currency: c, outstanding: 0n, collections: 0n, refunds: 0n }; byCur.set(c, r); }
      return r;
    };
    for (const r of outRows as Array<{ currency: string; _sum: { balance_minor: bigint | null } }>) {
      ensure(r.currency).outstanding += r._sum.balance_minor ?? 0n;
    }
    for (const r of payRows as Array<{ currency: string; _sum: { gross_minor: bigint | null } }>) {
      ensure(r.currency).collections += r._sum.gross_minor ?? 0n;
    }
    for (const r of refundRows as Array<{ amount_minor: bigint; payment: { currency: string } | null }>) {
      ensure(r.payment?.currency ?? 'XXX').refunds += r.amount_minor;
    }

    const by_currency = [...byCur.values()]
      .sort((a, b) => a.currency.localeCompare(b.currency))
      .map((r) => {
        const denom = r.collections + r.refunds;
        const refund_rate_30d = denom > 0n
          ? Math.round((Number(r.refunds) / Number(denom)) * 10_000) / 10_000
          : 0;
        return {
          currency: r.currency,
          total_outstanding_minor: r.outstanding.toString(),
          collections_30d_minor: r.collections.toString(),
          refunds_30d_minor: r.refunds.toString(),
          refund_rate_30d,
        };
      });

    res.json({
      data: {
        by_currency,
        overdue_count: overdueCount,
        active_plans_count: plansCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get('/expiries', async (req, res, next) => {
  try {
    const tenantId = req.user?.tid;
    if (!tenantId) throw Unauthorized();
    const within = Math.min(365, Math.max(1, Number.parseInt(String(req.query['within_days'] ?? '60'), 10)));
    // RLS-scoped client only — no silent singleton fallback (see /summary handler comment).
    const db = req.db;
    if (!db) throw new Error('tenantContext middleware not applied');
    const rows = await findUpcomingExpiries({ tenantId, withinDays: within, db });
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// SVT-WAVE33-SLA-2026-05 — SLA breaches across active students.
//
// A student is "SLA-breached" when the elapsed time in its current stage
// exceeds `LifecycleStage.sla_hours`. Stages without `sla_hours` are exempt,
// as are stages flagged `show_on_dashboard=false` (mirrors /summary's stage
// filter — hidden stages aren't operational workload). Only ACTIVE students
// count: a paused/terminal student (ON_HOLD, ON_LEAVE, DEFERRED, WITHDRAWN,
// COMPLETED) has a stopped clock and must not show as a false SLA breach.
//
// Returns a row per breached student with `hours_over_sla` for sorting. Limit
// is hard-capped at 200; the FE widget surfaces the worst breaches first.
dashboardRouter.get('/sla-breaches', async (req, res, next) => {
  try {
    const tenantId = req.user?.tid;
    if (!tenantId) throw Unauthorized();
    const db = req.db;
    if (!db) throw new Error('tenantContext middleware not applied');
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query['limit'] ?? '50'), 10)));
    // SVT-WAVE49-SLA-SEVERITY-2026-05 — optional minimum-hours-over filter.
    // 0 (or unset) returns every breach; admin dashboards pass 24 to triage
    // "critical" rows. Clamped to [0, 365*24] to avoid arithmetic surprises.
    const minHoursOver = Math.min(
      365 * 24,
      Math.max(0, Number.parseFloat(String(req.query['min_hours_over'] ?? '0')) || 0),
    );

    // Stages that have an SLA *and* are dashboard-visible. Cheap (handful of rows).
    const stages = await db.lifecycleStage.findMany({
      where: {
        tenant_id: tenantId,
        sla_hours: { not: null },
        show_on_dashboard: true,
      },
      select: { id: true, key: true, label: true, sla_hours: true, color_hex: true },
    });
    if (stages.length === 0) {
      res.json({ data: [], page: { total: 0 } });
      return;
    }
    const stageMap = new Map(stages.map((s) => [s.id, s]));

    // Students ACTIVE in one of those stages. Only ACTIVE has a running SLA clock
    // — ON_HOLD/ON_LEAVE/DEFERRED are intentional pauses; WITHDRAWN/COMPLETED terminal.
    const students = await db.student.findMany({
      where: {
        tenant_id: tenantId,
        deleted_at: null,
        status: 'ACTIVE',
        current_stage_id: { in: stages.map((s) => s.id) },
      },
      orderBy: { stage_entered_at: 'asc' },
      take: 500,
      select: {
        id: true, student_code: true, given_name: true, family_name: true,
        current_stage_id: true, stage_entered_at: true, assigned_to_id: true,
      },
    });

    const now = Date.now();
    const HOUR_MS = 60 * 60 * 1000;
    const breached = students.flatMap((s) => {
      const stage = stageMap.get(s.current_stage_id);
      if (!stage || stage.sla_hours == null) return [];
      const elapsedHours = (now - s.stage_entered_at.getTime()) / HOUR_MS;
      const hoursOverSla = elapsedHours - stage.sla_hours;
      if (hoursOverSla <= 0) return [];
      // Severity gate: caller can ask for "critical only" by passing a
      // threshold (default 0 keeps every breach).
      if (hoursOverSla < minHoursOver) return [];
      return [{
        student_id: s.id,
        student_code: s.student_code,
        given_name: s.given_name,
        family_name: s.family_name,
        stage_id: stage.id,
        stage_key: stage.key,
        stage_label: stage.label,
        stage_color_hex: stage.color_hex,
        sla_hours: stage.sla_hours,
        stage_entered_at: s.stage_entered_at,
        hours_over_sla: Math.round(hoursOverSla * 10) / 10,
        assigned_to_id: s.assigned_to_id,
      }];
    });
    // Worst breach first.
    breached.sort((a, b) => b.hours_over_sla - a.hours_over_sla);
    res.json({
      data: breached.slice(0, limit),
      page: { total: breached.length },
    });
  } catch (err) {
    next(err);
  }
});

// SVT-WAVE60-ONBOARDING-2026-05 — first-run setup checklist.
//
// Returns the 8 setup steps every new tenant has to walk through. Each step
// has an `id`, a human label, a boolean `complete`, and an `action_url`
// pointing at the FE screen that resolves it. The FE renders a "Get started"
// card on the dashboard until all 8 are complete; the dismissal is purely
// client-side (localStorage). Restricted to ADMIN/COUNSELLOR — viewers don't
// own onboarding work and shouldn't see the prompts.
//
// Cached per tenant for 60s. The check itself is 6 cheap counts + 2 finds.
dashboardRouter.get('/onboarding', async (req, res, next) => {
  try {
    const tenantId = req.user?.tid;
    if (!tenantId) throw Unauthorized();
    const role = req.user?.role;
    if (role !== 'ADMIN' && role !== 'COUNSELLOR') throw Forbidden();
    const db = req.db;
    if (!db) throw new Error('tenantContext middleware not applied');

    const cached = onboardingCache.get(tenantId);
    if (cached && Date.now() - cached.cachedAt < ONBOARDING_CACHE_TTL_MS) {
      res.json({ data: cached.payload });
      return;
    }

    const [tenant, userCount, studentCount, institutionCount, programCount, stageCount, adminMfaCount] =
      await Promise.all([
        db.tenant.findUnique({
          where: { id: tenantId },
          select: { legal_name: true, name: true, billing_enabled: true },
        }),
        db.user.count({ where: { tenant_id: tenantId } }),
        db.student.count({ where: { tenant_id: tenantId, deleted_at: null } }),
        db.institution.count({ where: { tenant_id: tenantId } }),
        db.program.count({ where: { tenant_id: tenantId } }),
        db.lifecycleStage.count({ where: { tenant_id: tenantId } }),
        db.user.count({
          where: { tenant_id: tenantId, role: 'ADMIN', mfa_enabled: true },
        }),
      ]);

    // tenant_settings: legal_name set and not the seed default. Treat both a
    // blank legal_name and the literal "Default Tenant" as incomplete so a
    // tenant created by the bootstrap seed isn't marked done by accident.
    const legalName = (tenant?.legal_name ?? '').trim();
    const tenantSettingsComplete = legalName.length > 0 && legalName !== 'Default Tenant';

    // billing_decision: admin has explicitly opted in to billing. The spec
    // allows "OR has any Tenant.notes content" as a v1 acknowledgement proxy,
    // but the Tenant model has no notes column, so we read billing_enabled
    // alone. When the Tenant.onboarding_billing_acknowledged_at column lands
    // it can be OR'd in here without an FE change.
    const billingDecisionComplete = tenant?.billing_enabled === true;

    const steps: OnboardingStep[] = [
      {
        id: 'tenant_settings',
        label: 'Set your workspace name and locale',
        complete: tenantSettingsComplete,
        action_url: '/settings',
      },
      {
        id: 'first_user_invited',
        label: 'Invite your first teammate',
        complete: userCount >= 2,
        action_url: '/admin/users',
      },
      {
        id: 'first_student',
        label: 'Add your first student',
        complete: studentCount >= 1,
        action_url: '/students',
      },
      {
        id: 'first_institution',
        label: 'Add your first institution',
        complete: institutionCount >= 1,
        action_url: '/admin/institutions',
      },
      {
        id: 'first_program',
        label: 'Add your first program',
        complete: programCount >= 1,
        action_url: '/admin/programs',
      },
      {
        id: 'lifecycle_stages_seeded',
        label: 'Confirm your lifecycle stages',
        complete: stageCount >= 1,
        action_url: '/admin/stages',
      },
      {
        id: 'billing_decision',
        label: 'Decide on billing for your workspace',
        complete: billingDecisionComplete,
        action_url: '/settings',
      },
      {
        id: 'mfa_enabled_for_admin',
        label: 'Enable MFA on an admin account',
        complete: adminMfaCount >= 1,
        action_url: '/settings',
      },
    ];
    const complete_count = steps.reduce((acc, s) => acc + (s.complete ? 1 : 0), 0);
    const payload: OnboardingPayload = { steps, complete_count };
    onboardingCache.set(tenantId, { payload, cachedAt: Date.now() });
    res.json({ data: payload });
  } catch (err) {
    next(err);
  }
});
