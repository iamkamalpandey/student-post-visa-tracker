import { Router } from 'express';
import { Prisma } from '@prisma/client';
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

// SVT-WAVE-ENGAGEMENT-2026-06 — attendance / engagement at-risk students.
//
// A sponsored student must keep "engaging" with their course (UKVI sponsor
// duties; analogous SEVIS / GTE obligations elsewhere). When attendance drops
// the agency has a window to intervene BEFORE it becomes a reportable
// sponsor-duty breach. This surfaces ACTIVE students whose attendance rate
// over a recent window has fallen below a threshold.
//
// at_risk := present/total < threshold over check_date >= now-within_days,
//            among students with >= min_checks recorded in the window.
// Defaults: within_days=30, threshold=0.80, min_checks=3.
//
// Scope: ACTIVE only (a paused / terminal student has no live engagement
// duty — same rationale as /sla-breaches). Role-scoped: COUNSELLOR sees own
// caseload, ADMIN tenant-wide. Defence-in-depth tenant_id predicate on top of
// the RLS-scoped req.db. Students with ZERO checks in the window are NOT
// returned here (no rate computable) — that "no engagement recorded" signal
// is a separate concern and intentionally out of scope for this rate metric.
dashboardRouter.get('/engagement-at-risk', async (req, res, next) => {
  try {
    const tenantId = req.user?.tid;
    if (!tenantId) throw Unauthorized();
    const db = req.db;
    if (!db) throw new Error('tenantContext middleware not applied');
    const userId = req.user?.sub;
    const role = req.user?.role;
    // A counsellor with no resolvable id has an empty caseload — never widen.
    if (role !== 'ADMIN' && !userId) {
      res.json({ data: [], page: { total: 0 } });
      return;
    }

    const withinDays = Math.min(
      365,
      Math.max(7, Number.parseInt(String(req.query['within_days'] ?? '30'), 10) || 30),
    );
    const threshold = Math.min(
      1,
      Math.max(0.1, Number.parseFloat(String(req.query['threshold'] ?? '0.8')) || 0.8),
    );
    const minChecks = Math.min(
      100,
      Math.max(1, Number.parseInt(String(req.query['min_checks'] ?? '3'), 10) || 3),
    );
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(String(req.query['limit'] ?? '50'), 10) || 50),
    );
    // Hard cap on the at-risk set we materialise; total reflects the capped
    // set (mirrors /sla-breaches). At-risk students are a small subset so this
    // is generous headroom, not a real truncation point in practice.
    const HARD_CAP = 1000;

    // Date-only cutoff so the comparison stays date-to-date (check_date is a DATE).
    const cutoff = new Date(Date.now() - withinDays * 86_400_000).toISOString().slice(0, 10);

    const scopeFrag =
      role === 'ADMIN' ? Prisma.empty : Prisma.sql`AND s.assigned_to_id = ${userId}::uuid`;

    const rows = await db.$queryRaw<
      Array<{
        student_id: string;
        student_code: string | null;
        given_name: string | null;
        family_name: string | null;
        assigned_to_id: string | null;
        total_count: number;
        present_count: number;
        last_check_date: Date | null;
      }>
    >(Prisma.sql`
      SELECT s.id AS student_id, s.student_code, s.given_name, s.family_name,
             s.assigned_to_id,
             COUNT(e.*)::int AS total_count,
             COUNT(e.*) FILTER (WHERE e.present)::int AS present_count,
             MAX(e.check_date) AS last_check_date
      FROM students s
      JOIN engagement_checks e
        ON e.student_id = s.id AND e.tenant_id = s.tenant_id
      WHERE s.tenant_id = ${tenantId}::uuid
        AND s.deleted_at IS NULL
        AND s.status = 'ACTIVE'
        AND e.check_date >= ${cutoff}::date
        ${scopeFrag}
      GROUP BY s.id
      HAVING COUNT(e.*) >= ${minChecks}
         AND (COUNT(e.*) FILTER (WHERE e.present))::numeric / COUNT(e.*) < ${threshold}
      ORDER BY (COUNT(e.*) FILTER (WHERE e.present))::numeric / COUNT(e.*) ASC,
               MAX(e.check_date) ASC
      LIMIT ${HARD_CAP}
    `);

    const data = rows.map((r) => {
      const total = Number(r.total_count);
      const present = Number(r.present_count);
      const rate = total > 0 ? Math.round((present / total) * 10_000) / 10_000 : 0;
      return {
        student_id: r.student_id,
        student_code: r.student_code,
        given_name: r.given_name,
        family_name: r.family_name,
        assigned_to_id: r.assigned_to_id,
        total_count: total,
        present_count: present,
        absent_count: total - present,
        attendance_rate: rate,
        last_check_date: r.last_check_date,
      };
    });

    res.json({ data: data.slice(0, limit), page: { total: data.length } });
  } catch (err) {
    next(err);
  }
});

// SVT-WAVE60-ONBOARDING-2026-05 — first-run setup checklist.
//
// Returns the setup steps every new tenant has to walk through. Each step
// has an `id`, a human label, a boolean `complete`, and an `action_url`
// pointing at the FE screen that resolves it. The FE renders a "Get started"
// card on the dashboard until all steps are complete; dismissal is purely
// client-side (localStorage). Restricted to ADMIN/COUNSELLOR — viewers don't
// own onboarding work and shouldn't see the prompts.
//
// Cached per tenant for 60s.
// SVT-QA-2026-08 — extended from 8 steps to 10 (visa types + Art. 30
// sub-processor register).
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

    // SVT-QA-2026-08 — two extra counts feed new "empty compliance register"
    // checklist items (visa types + Art 30 sub-processors). Both are cheap
    // COUNT(*) queries and are folded into the same 60s per-tenant cache.
    const [
      tenant,
      userCount,
      studentCount,
      institutionCount,
      programCount,
      stageCount,
      adminMfaCount,
      visaTypeCount,
      subProcessorCount,
    ] = await Promise.all([
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
      db.visaType.count({ where: { tenant_id: tenantId } }),
      db.subProcessor.count({ where: { tenant_id: tenantId, removed_at: null } }),
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
      // SVT-QA-2026-08 — surface empty compliance registers. A tenant tracking
      // students through a visa lifecycle without visa types configured has an
      // incomplete catalogue; the Art 30 register must have at least one row
      // if the tenant uses any processor (which every deployed tenant does).
      {
        id: 'first_visa_type',
        label: 'Add at least one visa type',
        complete: visaTypeCount >= 1,
        action_url: '/visa-types',
      },
      {
        id: 'first_sub_processor',
        label: 'Populate the Art. 30 sub-processor register',
        complete: subProcessorCount >= 1,
        action_url: '/sub-processors',
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
